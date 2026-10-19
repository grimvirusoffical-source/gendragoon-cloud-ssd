using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk
{
    public sealed class FileEntry
    {
        public long Size;
        /// <summary>Milliseconds since the Unix epoch.</summary>
        public long MTime;
        public string Sha256 = "";
        public List<string> Chunks = new List<string>();
        /// <summary>base64url file key; present in encrypted drives.</summary>
        public string? Key;

        internal Dictionary<string, object?> ToJson()
        {
            var d = new Dictionary<string, object?> { ["size"] = Size, ["mtime"] = MTime, ["sha256"] = Sha256, ["chunks"] = Chunks };
            if (!string.IsNullOrEmpty(Key)) d["key"] = Key;
            return d;
        }

        internal static FileEntry FromJson(Dictionary<string, object?> d) => new FileEntry
        {
            Size = d.L("size"), MTime = d.L("mtime"), Sha256 = d.S("sha256"), Chunks = d.A("chunks").OfType<string>().ToList(),
            Key = d.TryGetValue("key", out var k) ? k as string : null,
        };
    }

    /// <summary>The decrypted content of a drive manifest (spec/FORMATS.md).</summary>
    public sealed class DriveDocument
    {
        public bool Encrypted;
        public SortedDictionary<string, FileEntry> Files = new SortedDictionary<string, FileEntry>(StringComparer.Ordinal);
        public List<string> Folders = new List<string>();
        public long UpdatedAt;

        internal byte[] Encode()
        {
            Folders.Sort(StringComparer.Ordinal);
            var files = new Dictionary<string, object?>();
            foreach (var kv in Files) files[kv.Key] = kv.Value.ToJson();
            return Encoding.UTF8.GetBytes(Json.Write(new Dictionary<string, object?> {
                ["v"] = 1, ["encrypted"] = Encrypted, ["files"] = files, ["folders"] = Folders.Count > 0 ? Folders : null, ["updatedAt"] = UpdatedAt }));
        }

        internal static DriveDocument Decode(byte[] data)
        {
            Dictionary<string, object?> d;
            try { d = Json.Obj(Encoding.UTF8.GetString(data)); } catch (FormatException) { throw new CorruptException(); }
            if (d.L("v") != 1) throw new CorruptException();
            var doc = new DriveDocument { Encrypted = d.B("encrypted"), UpdatedAt = d.L("updatedAt"), Folders = d.A("folders").OfType<string>().ToList() };
            foreach (var kv in d.O("files")) if (kv.Value is Dictionary<string, object?> e) doc.Files[kv.Key] = FileEntry.FromJson(e);
            return doc;
        }

        internal HashSet<string> FolderSet()
        {
            var s = new HashSet<string>(Folders, StringComparer.Ordinal);
            foreach (var p in Files.Keys) for (var d = Drive.Dir(p); d != ""; d = Drive.Dir(d)) s.Add(d);
            return s;
        }
    }

    public sealed class Entry
    {
        public string Name = "", Path = "";
        public bool Folder;
        public long Size;
        public DateTimeOffset? MTime;
    }

    /// <summary>A named tree of files and folders stored in one manifest, committed with compare-and-swap so concurrent
    /// writers never lose each other's changes.</summary>
    public sealed class Drive
    {
        public const int DefaultChunkSize = 4 << 20;
        readonly Client c;
        readonly Keyring? keys;
        readonly int chunk;
        static readonly Random Jitter = new Random();

        public string Name { get; }
        public string ManifestKey { get; }
        public bool Encrypted => keys != null;

        /// <summary>Opens the drive called name. keys null with plain true stores files unencrypted.</summary>
        public Drive(Client client, string name, Keyring? keys, bool plain = false, int chunkSize = DefaultChunkSize)
        {
            if (string.IsNullOrEmpty(name) || Encoding.UTF8.GetByteCount(name) > 128) throw new ArgumentException("gendragoon: drive name must be 1 to 128 bytes");
            if (chunkSize <= 0 || chunkSize > (16 << 20) - 64) throw new ArgumentException("gendragoon: chunk size must be below 16 MiB");
            c = client; Name = name; chunk = chunkSize;
            if (plain) ManifestKey = Crypto.DriveManifestKey(null, name);
            else
            {
                this.keys = keys ?? throw new ArgumentException("gendragoon: an encrypted drive needs a keyring (or plain: true)");
                ManifestKey = Crypto.DriveManifestKey(keys.Master(), name);
            }
        }

        byte[]? Mk => keys?.Master();
        internal static string Dir(string p) { int i = p.LastIndexOf('/'); return i < 0 ? "" : p.Substring(0, i); }
        static string BaseName(string p) => p.Substring(p.LastIndexOf('/') + 1);
        static ApiException NotFound() => new ApiException(404, "not_found");

        /// <summary>Validates a drive path: slash-separated, no leading or trailing slash, no empty, "." or ".." segments,
        /// no backslash or control characters, at most 1024 bytes.</summary>
        public static string CleanPath(string p)
        {
            var bad = new ArgumentException($"gendragoon: invalid path \"{p}\"");
            if (string.IsNullOrEmpty(p) || Encoding.UTF8.GetByteCount(p) > 1024 || p.StartsWith("/") || p.EndsWith("/") || p.Contains("\\")) throw bad;
            foreach (var seg in p.Split('/'))
                if (seg == "" || seg == "." || seg == ".." || seg.Any(ch => ch < 0x20 || ch == 0x7f)) throw bad;
            return p;
        }

        internal async Task<(DriveDocument Doc, string Gen)> Load(CancellationToken ct)
        {
            Manifest m;
            try { m = await c.GetManifestAsync(ManifestKey, ct).ConfigureAwait(false); }
            catch (ApiException e) when (e.NotFound) { return (new DriveDocument { Encrypted = Encrypted }, ""); }
            return (DriveDocument.Decode(Crypto.OpenManifest(Mk, ManifestKey, m.Data)), m.Generation);
        }

        internal async Task Update(Action<DriveDocument> fn, CancellationToken ct)
        {
            for (int attempt = 0; ; attempt++)
            {
                var (doc, gen) = await Load(ct).ConfigureAwait(false);
                fn(doc);
                doc.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                try { await c.PutManifestAsync(ManifestKey, Crypto.SealManifest(Mk, ManifestKey, doc.Encode()), gen == "", gen, ct).ConfigureAwait(false); return; }
                catch (ApiException e) when (e.PreconditionFailed && attempt < 12) { }
                int wait; lock (Jitter) wait = 10 + Jitter.Next(40 << Math.Min(attempt, 4));
                await Task.Delay(wait, ct).ConfigureAwait(false);
            }
        }

        public async Task<DriveDocument> SnapshotAsync(CancellationToken ct = default) { c.Check("files.list"); return (await Load(ct).ConfigureAwait(false)).Doc; }

        /// <summary>Direct children of folder ("" is the root): folders first, then by name.</summary>
        public async Task<List<Entry>> ListAsync(string folder = "", CancellationToken ct = default)
        {
            c.Check("files.list");
            if (folder != "") CleanPath(folder);
            var (doc, _) = await Load(ct).ConfigureAwait(false);
            var o = doc.FolderSet().Where(f => Dir(f) == folder).Select(f => new Entry { Name = BaseName(f), Path = f, Folder = true }).ToList();
            o.AddRange(doc.Files.Where(kv => Dir(kv.Key) == folder).Select(kv => new Entry { Name = BaseName(kv.Key), Path = kv.Key, Size = kv.Value.Size, MTime = DateTimeOffset.FromUnixTimeMilliseconds(kv.Value.MTime) }));
            return o.OrderBy(e => e.Folder ? 0 : 1).ThenBy(e => e.Name, StringComparer.Ordinal).ToList();
        }

        public async Task<FileEntry> StatAsync(string p, CancellationToken ct = default)
        {
            c.Check("files.stat");
            return (await Load(ct).ConfigureAwait(false)).Doc.Files.TryGetValue(p, out var e) ? e : throw NotFound();
        }

        /// <summary>Creates or replaces a file. Unchanged chunks of an existing file are not uploaded again.</summary>
        public async Task<FileEntry> WriteFileAsync(string p, byte[] data, DateTimeOffset? mtime = null, CancellationToken ct = default)
        {
            c.Check("files.write");
            CleanPath(p);
            byte[]? fileKey = null;
            if (Encrypted)
            {
                try { var (doc, _) = await Load(ct).ConfigureAwait(false); if (doc.Files.TryGetValue(p, out var old) && !string.IsNullOrEmpty(old.Key)) fileKey = Bytes.FromB64u(old.Key!); }
                catch (ApiException) { } catch (CorruptException) { }
                if (fileKey == null || fileKey.Length != Crypto.KeyBytes) fileKey = Bytes.Random(Crypto.KeyBytes);
            }
            var entry = await Upload(fileKey, data, ct).ConfigureAwait(false);
            entry.MTime = (mtime ?? DateTimeOffset.UtcNow).ToUnixTimeMilliseconds();
            await Update(doc =>
            {
                if (doc.FolderSet().Contains(p)) throw new InvalidOperationException($"gendragoon: \"{p}\" is a folder");
                for (var d = Dir(p); d != ""; d = Dir(d)) if (doc.Files.ContainsKey(d)) throw new InvalidOperationException($"gendragoon: \"{d}\" is a file");
                doc.Files[p] = entry;
            }, ct).ConfigureAwait(false);
            return entry;
        }

        internal async Task<FileEntry> Upload(byte[]? fileKey, byte[] data, CancellationToken ct)
        {
            var entry = new FileEntry { Size = data.Length, Sha256 = Bytes.Hex(Bytes.Sha256(data)), Key = fileKey == null ? null : Bytes.B64u(fileKey) };
            var parts = new List<(string Id, byte[] Blob)>();
            for (int off = 0; off < data.Length; off += chunk)
            {
                var piece = Bytes.Slice(data, off, Math.Min(chunk, data.Length - off));
                parts.Add(fileKey != null ? Crypto.SealChunk(fileKey, piece) : (Bytes.Hex(Bytes.Sha256(piece)), piece));
            }
            var have = new HashSet<string>(await c.HasBlobsAsync(parts.Select(x => x.Id).ToList(), ct).ConfigureAwait(false));
            foreach (var (id, blob) in parts)
            {
                entry.Chunks.Add(id);
                if (!have.Add(id)) continue;
                if (fileKey != null) await c.PutSealedBlobAsync(id, blob, ct).ConfigureAwait(false);
                else await c.PutBlobAsync(blob, ct).ConfigureAwait(false);
            }
            return entry;
        }

        /// <summary>A file's content, verified against its SHA-256.</summary>
        public async Task<byte[]> ReadFileAsync(string p, CancellationToken ct = default)
        {
            c.Check("files.read");
            var (doc, _) = await Load(ct).ConfigureAwait(false);
            return doc.Files.TryGetValue(p, out var e) ? await ReadEntry(c, e, ct).ConfigureAwait(false) : throw NotFound();
        }

        internal static async Task<byte[]> ReadEntry(Client c, FileEntry e, CancellationToken ct)
        {
            byte[]? fileKey = null;
            if (!string.IsNullOrEmpty(e.Key)) { try { fileKey = Bytes.FromB64u(e.Key!); } catch (FormatException) { throw new CorruptException(); } }
            var buf = new System.IO.MemoryStream();
            foreach (var id in e.Chunks)
            {
                var blob = await c.GetBlobAsync(id, ct).ConfigureAwait(false);
                if (fileKey != null) blob = Crypto.OpenChunk(fileKey, id, blob);
                buf.Write(blob, 0, blob.Length);
            }
            var data = buf.ToArray();
            if (data.Length != e.Size || Bytes.Hex(Bytes.Sha256(data)) != e.Sha256) throw new CorruptException();
            return data;
        }

        /// <summary>Creates a folder and its parents. An existing folder is not an error.</summary>
        public Task MkdirAsync(string p, CancellationToken ct = default)
        {
            c.Check("files.mkdir");
            CleanPath(p);
            return Update(doc =>
            {
                var s = doc.FolderSet();
                for (var d = p; d != ""; d = Dir(d))
                {
                    if (doc.Files.ContainsKey(d)) throw new InvalidOperationException($"gendragoon: \"{d}\" is a file");
                    if (s.Add(d)) doc.Folders.Add(d);
                }
            }, ct);
        }

        /// <summary>Renames a file or a folder with everything in it. The destination must not exist.</summary>
        public Task MoveAsync(string from, string to, CancellationToken ct = default)
        {
            c.Check("files.move");
            CleanPath(from); CleanPath(to);
            if (to == from || to.StartsWith(from + "/")) throw new ArgumentException("gendragoon: cannot move a folder into itself");
            return Update(doc =>
            {
                var s = doc.FolderSet();
                if (doc.Files.ContainsKey(to) || s.Contains(to)) throw new InvalidOperationException($"gendragoon: \"{to}\" already exists");
                if (doc.Files.TryGetValue(from, out var e)) { doc.Files.Remove(from); doc.Files[to] = e; return; }
                if (!s.Contains(from)) throw NotFound();
                foreach (var q in doc.Files.Keys.Where(q => q.StartsWith(from + "/")).ToList()) { var f = doc.Files[q]; doc.Files.Remove(q); doc.Files[to + q.Substring(from.Length)] = f; }
                doc.Folders = doc.Folders.Select(f => f == from || f.StartsWith(from + "/") ? to + f.Substring(from.Length) : f).Append(to).Distinct().ToList();
            }, ct);
        }

        /// <summary>Removes one file or one empty folder. Level L2, risk destructive. Blobs stay until CollectGarbageAsync.</summary>
        public Task DeleteAsync(string p, CancellationToken ct = default)
        {
            c.Check("files.delete");
            return Update(doc =>
            {
                if (doc.Files.Remove(p)) return;
                var s = doc.FolderSet();
                if (!s.Contains(p)) throw NotFound();
                if (s.Concat(doc.Files.Keys).Any(q => q.StartsWith(p + "/"))) throw new InvalidOperationException($"gendragoon: folder \"{p}\" is not empty");
                doc.Folders.Remove(p);
            }, ct);
        }

        /// <summary>Removes a folder and everything in it; returns how many files were removed. Level L3, risk bulk-destructive.</summary>
        public async Task<int> DeleteFolderAsync(string p, CancellationToken ct = default)
        {
            c.Check("files.deleteFolder");
            int n = 0;
            await Update(doc =>
            {
                var gone = doc.Files.Keys.Where(q => q.StartsWith(p + "/")).ToList();
                n = gone.Count;
                foreach (var q in gone) doc.Files.Remove(q);
                doc.Folders = doc.Folders.Where(f => f != p && !f.StartsWith(p + "/")).ToList();
            }, ct).ConfigureAwait(false);
            return n;
        }

        /// <summary>Deletes blobs no drive references. Refuses if any manifest is not a readable drive, unless force.
        /// Level L3, risk bulk-destructive.</summary>
        public static async Task<int> CollectGarbageAsync(Client c, Keyring? keys, bool force = false, CancellationToken ct = default)
        {
            c.Check("files.collectGarbage");
            var mk = keys != null && keys.Unlocked ? keys.Master() : null;
            var used = new HashSet<string>();
            foreach (var m in await c.AllManifestsAsync(ct).ConfigureAwait(false))
            {
                Manifest got;
                try { got = await c.GetManifestAsync(m.Id, ct).ConfigureAwait(false); }
                catch (ApiException e) when (e.NotFound) { continue; }
                DriveDocument? doc = null;
                try { doc = DriveDocument.Decode(Crypto.OpenManifest(mk, m.Id, got.Data)); } catch (CorruptException) { } catch (LockedException) { }
                if (doc == null)
                {
                    if (force) continue;
                    throw new InvalidOperationException($"gendragoon: manifest {m.Id.Substring(0, 12)} is not a readable drive; refusing to collect garbage");
                }
                foreach (var e in doc.Files.Values) used.UnionWith(e.Chunks);
            }
            int deleted = 0;
            foreach (var b in await c.AllBlobsAsync(ct).ConfigureAwait(false))
                if (!used.Contains(b.Id)) { await c.Request("files.collectGarbage", "DELETE", "/blobs/" + b.Id, ct: ct).ConfigureAwait(false); deleted++; }
            return deleted;
        }
    }
}
