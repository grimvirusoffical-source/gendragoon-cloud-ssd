using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk
{
    public sealed class SyncOptions
    {
        /// <summary>Drive folder that corresponds to the local folder ("" is the drive root).</summary>
        public string Prefix = "";
        /// <summary>Report what would change without changing anything.</summary>
        public bool DryRun;
        /// <summary>True for local relative paths (slash-separated) that must not be synced.</summary>
        public Func<string, bool>? Skip;
    }

    public sealed class SyncReport
    {
        public List<string> Uploaded = new List<string>(), Downloaded = new List<string>(), Deleted = new List<string>();
        public int Unchanged;
    }

    public enum SyncDirection { ToDrive, ToLocal }

    /// <summary>Folder sync between the local disk and a drive.</summary>
    public static class Sync
    {
        static Dictionary<string, FileInfo> Scan(string root, Func<string, bool>? skip)
        {
            var o = new Dictionary<string, FileInfo>(StringComparer.Ordinal);
            if (!Directory.Exists(root)) return o;
            void Walk(DirectoryInfo dir, string rel)
            {
                foreach (var fs in dir.EnumerateFileSystemInfos())
                {
                    var r = rel == "" ? fs.Name : rel + "/" + fs.Name;
                    if (skip != null && skip(r)) continue;
                    if ((fs.Attributes & FileAttributes.ReparsePoint) != 0) continue; // symlinks are never followed or uploaded
                    if (fs is DirectoryInfo d) Walk(d, r);
                    else if (fs is FileInfo f) o[r] = f;
                }
            }
            Walk(new DirectoryInfo(root), "");
            return o;
        }

        static string Dp(string prefix, string rel) => prefix == "" ? rel : prefix + "/" + rel;
        static bool Under(string p, string prefix) => prefix == "" || p.StartsWith(prefix + "/");
        static string Rel(string p, string prefix) => prefix == "" ? p : p.Substring(prefix.Length + 1);

        static async Task<SyncReport> Push(Drive d, string localDir, SyncOptions o, bool mirror, CancellationToken ct)
        {
            if (o.Prefix != "") Drive.CleanPath(o.Prefix);
            var local = Scan(localDir, o.Skip);
            var (doc, _) = await d.Load(ct).ConfigureAwait(false);
            var rep = new SyncReport();
            var changed = new Dictionary<string, FileEntry>();
            foreach (var rel in local.Keys.OrderBy(k => k, StringComparer.Ordinal))
            {
                var p = Drive.CleanPath(Dp(o.Prefix, rel));
                var f = local[rel];
                var data = File.ReadAllBytes(f.FullName);
                doc.Files.TryGetValue(p, out var old);
                if (old != null && old.Size == data.Length && old.Sha256 == Bytes.Hex(Bytes.Sha256(data))) { rep.Unchanged++; continue; }
                rep.Uploaded.Add(p);
                if (o.DryRun) continue;
                byte[]? key = null;
                if (d.Encrypted)
                {
                    if (!string.IsNullOrEmpty(old?.Key)) key = Bytes.FromB64u(old!.Key!);
                    if (key == null || key.Length != Crypto.KeyBytes) key = Bytes.Random(Crypto.KeyBytes);
                }
                var entry = await d.Upload(key, data, ct).ConfigureAwait(false);
                entry.MTime = new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds();
                changed[p] = entry;
            }
            var gone = mirror ? doc.Files.Keys.Where(p => Under(p, o.Prefix) && !local.ContainsKey(Rel(p, o.Prefix))).OrderBy(p => p, StringComparer.Ordinal).ToList() : new List<string>();
            rep.Deleted = gone;
            if (o.DryRun || (changed.Count == 0 && gone.Count == 0)) return rep;
            await d.Update(latest => { foreach (var kv in changed) latest.Files[kv.Key] = kv.Value; foreach (var p in gone) latest.Files.Remove(p); }, ct).ConfigureAwait(false);
            return rep;
        }

        static void WriteAtomic(string target, byte[] data, long mtimeMs)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            var tmp = Path.Combine(Path.GetDirectoryName(target)!, ".gd-" + Bytes.Hex(Bytes.Random(6)));
            try
            {
                File.WriteAllBytes(tmp, data);
                if (File.Exists(target)) File.Replace(tmp, target, null); else File.Move(tmp, target);
            }
            finally { if (File.Exists(tmp)) File.Delete(tmp); }
            File.SetLastWriteTimeUtc(target, DateTimeOffset.FromUnixTimeMilliseconds(mtimeMs).UtcDateTime);
        }

        static async Task<SyncReport> Pull(Client c, Drive d, string localDir, SyncOptions o, bool mirror, CancellationToken ct)
        {
            var (doc, _) = await d.Load(ct).ConfigureAwait(false);
            var local = Scan(localDir, o.Skip);
            var root = Path.GetFullPath(localDir).TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar;
            var rep = new SyncReport();
            var remote = new HashSet<string>(StringComparer.Ordinal);
            foreach (var kv in doc.Files)
            {
                if (!Under(kv.Key, o.Prefix)) continue;
                var rel = Rel(kv.Key, o.Prefix);
                if (o.Skip != null && o.Skip(rel)) continue;
                remote.Add(rel);
                if (local.TryGetValue(rel, out var f) && f.Length == kv.Value.Size && Bytes.Hex(Bytes.Sha256(File.ReadAllBytes(f.FullName))) == kv.Value.Sha256) { rep.Unchanged++; continue; }
                rep.Downloaded.Add(kv.Key);
                if (o.DryRun) continue;
                var target = Path.GetFullPath(Path.Combine(root, rel.Replace('/', Path.DirectorySeparatorChar)));
                if (!target.StartsWith(root)) throw new InvalidOperationException("gendragoon: drive path escapes the local folder");
                WriteAtomic(target, await Drive.ReadEntry(c, kv.Value, ct).ConfigureAwait(false), kv.Value.MTime);
            }
            if (mirror)
                foreach (var rel in local.Keys.OrderBy(k => k, StringComparer.Ordinal).Where(r => !remote.Contains(r)).ToList())
                {
                    rep.Deleted.Add(Dp(o.Prefix, rel));
                    if (!o.DryRun) File.Delete(local[rel].FullName);
                }
            return rep;
        }

        /// <summary>Uploads local files that are new or differ (by SHA-256). Remote-only files are kept. Level L2, risk write.</summary>
        public static Task<SyncReport> PushAsync(Client c, Drive d, string localDir, SyncOptions? o = null, CancellationToken ct = default)
        { c.Check("sync.push"); return Push(d, localDir, o ?? new SyncOptions(), false, ct); }

        /// <summary>Downloads drive files that are new or differ, written atomically. Local-only files are kept. Level L2, risk write.</summary>
        public static Task<SyncReport> PullAsync(Client c, Drive d, string localDir, SyncOptions? o = null, CancellationToken ct = default)
        { c.Check("sync.pull"); return Pull(c, d, localDir, o ?? new SyncOptions(), false, ct); }

        /// <summary>Makes one side identical to the other, deleting files only on the target side. Level L3, risk bulk-destructive.</summary>
        public static Task<SyncReport> MirrorAsync(Client c, Drive d, string localDir, SyncDirection dir, SyncOptions? o = null, CancellationToken ct = default)
        {
            c.Check("sync.mirror");
            return dir == SyncDirection.ToDrive ? Push(d, localDir, o ?? new SyncOptions(), true, ct) : Pull(c, d, localDir, o ?? new SyncOptions(), true, ct);
        }
    }
}
