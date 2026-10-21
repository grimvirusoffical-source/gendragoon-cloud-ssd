using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace Gendragoon.Sdk.Tests
{
    /// <summary>Cross-language vectors (sdk/spec/vectors/v1.json), the operation table and the gate. No network.</summary>
    static class Unit
    {
        static string Spec([System.Runtime.CompilerServices.CallerFilePath] string here = "") =>
            Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "..", "spec"));
        static readonly Dictionary<string, object?> V = Json.Obj(File.ReadAllText(Path.Combine(Spec(), "vectors", "v1.json")));
        static byte[] H(string s) => Bytes.FromHex(s);
        static Client Dummy() => new Client("http://127.0.0.1:9", "gdpk_0123456789abcdef_" + new string('A', 43));

        [Test]
        static void Hkdf()
        {
            foreach (var o in V.A("hkdf").Cast<Dictionary<string, object?>>())
                Assert.Equal(o.S("out"), Bytes.Hex(Crypto.SubKey(H(o.S("ikm")), o.S("purpose"))), "hkdf " + o.S("purpose"));
        }

        [Test]
        static void EnvelopeScrypt()
        {
            var e = V.O("envelopeScrypt");
            var env = KeyEnvelope.FromJson(Json.Write(e["envelope"]));
            Assert.Equal(e.S("masterKey"), Bytes.Hex(Crypto.UnwrapMasterKey(env, e.S("passphrase"))));
            Assert.Throws<WrongPassphraseException>(() => Crypto.UnwrapMasterKey(env, "not the passphrase"));
            var again = Crypto.WrapMasterKey(H(e.S("masterKey")), e.S("passphrase"), env.Kdf, 1, n => Bytes.FromB64u(n == 16 ? env.Salt : env.Iv));
            Assert.Equal(env.ToJson(), again.ToJson(), "rewrapped envelope");
            Assert.Equal(Json.Write(e["envelope"]), env.ToJson(), "envelope JSON");
        }

        [Test]
        static void EnvelopeArgon2idNeedsPlugin()
        {
            var e = V.O("envelopeArgon2id");
            var env = KeyEnvelope.FromJson(Json.Write(e["envelope"]));
            Assert.Throws<NotSupportedException>(() => Crypto.UnwrapMasterKey(env, e.S("passphrase")));
        }

        [Test]
        static void Chunk()
        {
            var c = V.O("chunk");
            var (id, blob) = Crypto.SealChunk(H(c.S("fileKey")), H(c.S("plaintext")), H(c.S("nonce")));
            Assert.Equal(c.S("id"), id); Assert.Equal(c.S("blob"), Bytes.Hex(blob));
            Assert.Equal(c.S("plaintext"), Bytes.Hex(Crypto.OpenChunk(H(c.S("fileKey")), id, blob)));
            blob[blob.Length - 1] ^= 1;
            Assert.Throws<CorruptException>(() => Crypto.OpenChunk(H(c.S("fileKey")), id, blob));
        }

        [Test]
        static void ManifestAndDocument()
        {
            var m = V.O("manifest");
            var mk = H(m.S("masterKey"));
            Assert.Equal(m.S("manifestKey"), Crypto.DriveManifestKey(mk, m.S("driveName")));
            Assert.Equal(m.S("plainManifestKey"), Crypto.DriveManifestKey(null, m.S("driveName")));
            var pt = Encoding.UTF8.GetBytes(m.S("plaintext"));
            Assert.Equal(m.S("sealed"), Bytes.Hex(Crypto.SealManifest(mk, m.S("manifestKey"), pt, H(m.S("nonce")))));
            Assert.Equal(m.S("plaintext"), Encoding.UTF8.GetString(Crypto.OpenManifest(mk, m.S("manifestKey"), H(m.S("sealed")))));
            Assert.Throws<LockedException>(() => Crypto.OpenManifest(null, m.S("manifestKey"), H(m.S("sealed"))));
            // The drive document re-encodes byte for byte as the Go SDK wrote it.
            Assert.Equal(m.S("plaintext"), Encoding.UTF8.GetString(DriveDocument.Decode(pt).Encode()), "drive document");
        }

        [Test]
        static void Share()
        {
            var s = V.O("share");
            var id = Identity.FromPrivate(H(s.S("recipientPrivate")));
            Assert.Equal(s.S("recipientPublic"), id.Public);
            Assert.Equal(s.S("recipientPrivate"), Bytes.Hex(id.PrivateBytes()));
            var share = Gendragoon.Sdk.Share.FromJson(Json.Write(s["share"]));
            var f = Sharing.OpenEnvelope(id, share);
            var payload = Json.Write(new Dictionary<string, object?> { ["v"] = 1, ["path"] = f.Path, ["entry"] = f.Entry.ToJson() });
            Assert.Equal(s.S("payload"), payload, "share payload");
            var eph = Identity.FromPrivate(Bytes.Concat(H(s.S("ephemeralPrivate")), Bytes.FromB64u(share.Epk)));
            var again = Sharing.Seal(Bytes.FromB64u(s.S("recipientPublic").Substring(6)), Encoding.UTF8.GetBytes(s.S("payload")), eph, H(s.S("nonce")));
            Assert.Equal(share.ToJson(), again.ToJson(), "sealed share");
            var other = Identity.Create(Dummy());
            Assert.True(Assert.Throws<ArgumentException>(() => Sharing.OpenEnvelope(other, share)).Message.Contains("someone else"));
        }

        [Test]
        static void ManagedPrimitivesMatchPlatform()
        {
            // Unity and other netstandard2.1 hosts use the managed AES-GCM and P-256 code; check it against the platform.
            var rnd = new Random(7);
            foreach (var len in new[] { 0, 1, 15, 16, 17, 100, 4096 })
            {
                var key = Bytes.Random(32); var nonce = Bytes.Random(12); var pt = Bytes.Random(len); var aad = Bytes.Random(rnd.Next(0, 40));
                var a = Gcm.Seal(key, nonce, pt, aad);
                var b = ManagedGcm.Seal(key, nonce, pt, aad);
                Assert.Equal(Bytes.Hex(a), Bytes.Hex(b), "gcm length " + len);
                Assert.Equal(Bytes.Hex(pt), Bytes.Hex(ManagedGcm.Open(key, nonce, a, aad)!));
                a[0] ^= 1;
                Assert.True(ManagedGcm.Open(key, nonce, a, aad) == null, "managed gcm rejects tampering");
            }
            for (int i = 0; i < 4; i++)
            {
                var (d1, p1) = P256.Generate(); var (d2, p2) = P256.Generate();
                Assert.Equal(Bytes.Hex(p1), Bytes.Hex(P256.ManagedPublic(d1)), "p256 public");
                Assert.Equal(Bytes.Hex(P256.Shared(d1, p1, p2)), Bytes.Hex(P256.ManagedShared(d1, p2)), "p256 shared");
                Assert.Equal(Bytes.Hex(P256.ManagedShared(d2, p1)), Bytes.Hex(P256.ManagedShared(d1, p2)), "p256 symmetric");
            }
            var bad = (byte[])P256.Generate().pub.Clone(); bad[40] ^= 1;
            Assert.Throws<Exception>(() => P256.ManagedShared(P256.Generate().d, bad));
        }

        [Test]
        static void Pkce() => Assert.Equal(V.O("pkce").S("challenge"), Gendragoon.Sdk.Pkce.ChallengeOf(V.O("pkce").S("verifier")));

        [Test]
        static void OperationTableMatchesSpec()
        {
            var spec = Json.Obj(File.ReadAllText(Path.Combine(Spec(), "operations.json")));
            var ops = spec.A("operations").Cast<Dictionary<string, object?>>().ToList();
            var services = spec.O("levelSource").O("services");
            Assert.Equal(ops.Count, Operations.All.Count(), "operation count");
            for (int i = 0; i < ops.Count; i++)
            {
                var o = Operations.All.ElementAt(i); var s = ops[i];
                Assert.Equal(s.S("id"), o.Id); Assert.Equal(s.S("level"), o.Level.ToString(), o.Id);
                Assert.Equal(s.S("service"), o.Service, o.Id); Assert.Equal(s.S("context"), o.Context, o.Id);
                Assert.True(o.Level >= Operations.ParseLevel(services.O(o.Service).S("level")), o.Id + " at or above its service level");
            }
        }

        [Test]
        static void GateAndEnvironmentCap()
        {
            var prev = Environment.GetEnvironmentVariable(Operations.MaxLevelEnv);
            try
            {
                Environment.SetEnvironmentVariable(Operations.MaxLevelEnv, null);
                var g = Operations.LevelGate();
                g(Operations.Get("files.deleteFolder"));
                Assert.Throws<LevelException>(() => g(Operations.Get("storage.wipe")));
                Assert.Throws<LevelException>(() => g(Operations.Get("crypto.exportMasterKey")));
                Environment.SetEnvironmentVariable(Operations.MaxLevelEnv, "L2");
                Assert.Throws<LevelException>(() => Operations.LevelGate(Level.L4)(Operations.Get("files.deleteFolder")));
                Environment.SetEnvironmentVariable(Operations.MaxLevelEnv, "L4");
                Assert.Throws<LevelException>(() => Operations.LevelGate(Level.L3)(Operations.Get("storage.wipe")));
                Environment.SetEnvironmentVariable(Operations.MaxLevelEnv, "banana");
                Assert.Throws<LevelException>(() => Operations.LevelGate(Level.L4)(Operations.Get("usage")));
            }
            finally { Environment.SetEnvironmentVariable(Operations.MaxLevelEnv, prev); }
        }

        [Test]
        static void PathsAndLinks()
        {
            foreach (var bad in new[] { "", "/a", "a/", "a//b", "a/../b", ".", "a\\b", "a/\u0001", new string('x', 1025) })
                Assert.Throws<ArgumentException>(() => Drive.CleanPath(bad));
            Drive.CleanPath("saves/slot 1.sav");
            var p = Gendragoon.Sdk.Pkce.Create();
            var link = Connector.ConnectLink(new ClientInfo("My Game"), p, "http://127.0.0.1:5000/cb");
            var req = AccountClient.ParseConnectLink(link);
            Assert.Equal(p.Challenge, req.Challenge); Assert.Equal("My Game", req.Client.Name); Assert.Equal(p.State, req.State);
            Assert.Throws<ArgumentException>(() => Connector.ConnectLink(new ClientInfo("x"), p, "https://evil.example/cb"));
            Assert.Throws<ArgumentException>(() => Connector.ConnectLink(new ClientInfo("x"), p, "http://127.0.0.1/cb"));
            Assert.Throws<ArgumentException>(() => AccountClient.ParseConnectLink(link.Replace("127.0.0.1", "evil.example")));
        }

        [Test]
        static void SecretsNotInToString()
        {
            var c = Dummy();
            Assert.True(!c.ToString().Contains("gdpk_") && !new Keyring(c).ToString().Contains("AAAA"));
        }

        [Test]
        static async System.Threading.Tasks.Task LoopbackChecksState()
        {
            var p = Gendragoon.Sdk.Pkce.Create();
            using var lb = Loopback.Listen(p);
            var wait = lb.WaitAsync(TimeSpan.FromSeconds(10));
            using var http = new System.Net.Http.HttpClient();
            var code = "gdpc_" + new string('C', 43);
            var bad = await http.GetAsync(lb.RedirectUri + "?code=" + code + "&state=wrong");
            Assert.Equal(400, (int)bad.StatusCode);
            var ok = await http.GetAsync(lb.RedirectUri + "?code=" + code + "&state=" + Uri.EscapeDataString(p.State));
            Assert.Equal(200, (int)ok.StatusCode);
            Assert.Equal(code, await wait);
        }
    }
}
