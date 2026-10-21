using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Gendragoon.Sdk
{
    /// <summary>A recipient key pair (P-256).</summary>
    public sealed class Identity
    {
        const string Prefix = "gdid1_";
        readonly byte[] d;
        internal readonly byte[] Pub;
        Identity(byte[] d, byte[] pub) { this.d = d; Pub = pub; }

        /// <summary>Level L2, risk key (local).</summary>
        public static Identity Create(Transport c)
        {
            c.Check("share.createIdentity");
            var (d, pub) = P256.Generate();
            return new Identity(d, pub);
        }

        /// <summary>From PrivateBytes(): the 32-byte scalar followed by the 65-byte uncompressed public point.</summary>
        public static Identity FromPrivate(byte[] b)
        {
            if (b.Length != 97) throw new ArgumentException("gendragoon: identity must be 97 bytes");
            var d = Bytes.Slice(b, 0, 32); var pub = Bytes.Slice(b, 32, 65);
            if (!Bytes.Equal(P256.PublicOf(d), pub)) throw new ArgumentException("gendragoon: identity public key does not match");
            return new Identity(d, pub);
        }

        /// <summary>Keep it secret.</summary>
        public byte[] PrivateBytes() => Bytes.Concat(d, Pub);
        /// <summary>The shareable recipient id.</summary>
        public string Public => Prefix + Bytes.B64u(Pub);
        public override string ToString() => $"Identity({Public})";
        internal byte[] Shared(byte[] peer) => P256.Shared(d, Pub, peer);

        internal static byte[] Parse(string id)
        {
            if (!id.StartsWith(Prefix)) throw new ArgumentException("gendragoon: not a recipient id");
            var raw = Bytes.FromB64u(id.Substring(Prefix.Length));
            if (raw.Length != 65 || raw[0] != 4) throw new ArgumentException("gendragoon: not a recipient id");
            return raw;
        }
    }

    /// <summary>The encrypted envelope a sender gives a recipient (JSON).</summary>
    public sealed class Share
    {
        public int V = 1;
        public string Alg = "", Recipient = "", Epk = "", Nonce = "", Ct = "";
        public string ToJson() => Json.Write(new Dictionary<string, object?> { ["v"] = V, ["alg"] = Alg, ["recipient"] = Recipient, ["epk"] = Epk, ["nonce"] = Nonce, ["ct"] = Ct });
        public static Share FromJson(string json)
        {
            var d = Json.Obj(json);
            return new Share { V = (int)d.L("v"), Alg = d.S("alg"), Recipient = d.S("recipient"), Epk = d.S("epk"), Nonce = d.S("nonce"), Ct = d.S("ct") };
        }
    }

    public sealed class SharedFile { public string Path = ""; public FileEntry Entry = new FileEntry(); }

    public sealed class ReadKey { public string KeyId = "", Label = "", ExpiresAt = ""; public string? ApiKey; public bool Revoked; }

    /// <summary>Sharing one file with a recipient (ECDH P-256 + HKDF-SHA256 + AES-256-GCM, sdk/spec/FORMATS.md) and the
    /// read-only keys a recipient uses to fetch its chunks.</summary>
    public static class Sharing
    {
        const string Alg = "ECDH-P256+HKDF-SHA256+A256GCM";
        static readonly byte[] Aad = Encoding.ASCII.GetBytes("gd-share-v1");
        static string Tag(byte[] rpk) => Bytes.B64u(Bytes.Slice(Bytes.Sha256(rpk), 0, 8));

        internal static Share Seal(byte[] rpk, byte[] payload, Identity? eph = null, byte[]? nonce = null)
        {
            if (eph == null) { var (d, pub) = P256.Generate(); eph = Identity.FromPrivate(Bytes.Concat(d, pub)); }
            nonce ??= Bytes.Random(Crypto.NonceBytes);
            var key = Crypto.Hkdf32(eph.Shared(rpk), Bytes.Concat(eph.Pub, rpk), "gendragoon-sdk/v1/share");
            return new Share { Alg = Alg, Recipient = Tag(rpk), Epk = Bytes.B64u(eph.Pub), Nonce = Bytes.B64u(nonce), Ct = Bytes.B64u(Crypto.Seal(key, nonce, payload, Aad)) };
        }

        /// <summary>Encrypts one file of an encrypted drive to a recipient. Level L3, risk sharing.</summary>
        public static async Task<Share> ExportAsync(Client c, Drive d, string path, string recipient, CancellationToken ct = default)
        {
            c.Check("share.export");
            if (!d.Encrypted) throw new InvalidOperationException("gendragoon: plain drives have nothing to share; give the reader access to the binding instead");
            var rpk = Identity.Parse(recipient);
            var (doc, _) = await d.Load(ct).ConfigureAwait(false);
            if (!doc.Files.TryGetValue(path, out var e)) throw new ApiException(404, "not_found");
            var payload = Json.Write(new Dictionary<string, object?> { ["v"] = 1, ["path"] = path, ["entry"] = e.ToJson() });
            return Seal(rpk, Encoding.UTF8.GetBytes(payload));
        }

        /// <summary>Decrypts a share with the recipient's identity (no network).</summary>
        public static SharedFile OpenEnvelope(Identity id, Share s)
        {
            if (s.V != 1 || s.Alg != Alg) throw new ArgumentException("gendragoon: unsupported share");
            if (s.Recipient != Tag(id.Pub)) throw new ArgumentException("gendragoon: this share is addressed to someone else");
            byte[]? pt;
            try
            {
                var epk = Bytes.FromB64u(s.Epk);
                var key = Crypto.Hkdf32(id.Shared(epk), Bytes.Concat(epk, id.Pub), "gendragoon-sdk/v1/share");
                pt = Crypto.Open(key, Bytes.FromB64u(s.Nonce), Bytes.FromB64u(s.Ct), Aad);
            }
            catch (Exception e) when (e is FormatException || e is System.Security.Cryptography.CryptographicException) { throw new CorruptException(); }
            if (pt == null) throw new CorruptException();
            Dictionary<string, object?> f;
            try { f = Json.Obj(Encoding.UTF8.GetString(pt)); } catch (FormatException) { throw new CorruptException(); }
            if (f.L("v") != 1) throw new CorruptException();
            return new SharedFile { Path = f.S("path"), Entry = FileEntry.FromJson(f.O("entry")) };
        }

        /// <summary>Decrypts a share and downloads the file (read access to the sender's binding). Level L2, risk read.</summary>
        public static async Task<(SharedFile File, byte[] Data)> OpenAsync(Client c, Identity id, Share s, CancellationToken ct = default)
        {
            c.Check("share.open");
            var f = OpenEnvelope(id, s);
            return (f, await Drive.ReadEntry(c, f.Entry, ct).ConfigureAwait(false));
        }

        /// <summary>Mints a read-only key for this binding (1 to 90 days). It cannot write, mint keys or read the key
        /// envelope. Level L3, risk sharing.</summary>
        public static async Task<ReadKey> CreateReadKeyAsync(Client c, string label, int ttlDays = 30, CancellationToken ct = default)
        {
            var body = Encoding.UTF8.GetBytes(Json.Write(new Dictionary<string, object?> { ["label"] = label, ["ttlDays"] = ttlDays }));
            var d = (await c.Request("share.createReadKey", "POST", "/keys", body, new Dictionary<string, string> { ["Content-Type"] = "application/json" }, ct: ct).ConfigureAwait(false)).Obj;
            if (!Client.ApiKeyRe.IsMatch(d.S("apiKey"))) throw new InvalidOperationException("gendragoon: unexpected key response");
            return new ReadKey { KeyId = d.S("keyId"), ApiKey = d.S("apiKey"), Label = d.S("label"), ExpiresAt = d.S("expiresAt") };
        }

        /// <summary>This binding's read-only keys (never their secrets). Level L2, risk read.</summary>
        public static async Task<List<ReadKey>> ListReadKeysAsync(Client c, CancellationToken ct = default)
        {
            var d = (await c.Request("share.listReadKeys", "GET", "/keys", ct: ct).ConfigureAwait(false)).Obj;
            return d.A("keys").OfType<Dictionary<string, object?>>().Select(k => new ReadKey { KeyId = k.S("keyId"), Label = k.S("label"), ExpiresAt = k.S("expiresAt"), Revoked = k.B("revoked"), ApiKey = k.TryGetValue("apiKey", out var a) ? a as string : null }).ToList();
        }

        /// <summary>Revokes a read-only key at once. Level L3, risk sharing.</summary>
        public static Task RevokeReadKeyAsync(Client c, string keyId, CancellationToken ct = default)
        {
            if (!Regex.IsMatch(keyId, "^[0-9a-f]{16}$")) throw new ArgumentException("gendragoon: malformed key id");
            return c.Request("share.revokeReadKey", "DELETE", "/keys/" + keyId, ct: ct);
        }
    }
}
