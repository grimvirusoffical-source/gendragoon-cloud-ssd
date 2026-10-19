using System;
using System.Collections.Generic;
using System.Text;

namespace Gendragoon.Sdk
{
    /// <summary>KDF parameters: Alg "scrypt" (N, R, P) or "argon2id" (MemoryKiB, Iterations, Parallelism).</summary>
    public sealed class Kdf
    {
        public string Alg = "scrypt";
        public int N, R, P, MemoryKiB, Iterations, Parallelism;
        public static Kdf DefaultScrypt => new Kdf { Alg = "scrypt", N = 1 << 15, R = 8, P = 1 };
    }

    /// <summary>The wrapped master key exactly as the server stores it.</summary>
    public sealed class KeyEnvelope
    {
        public int Version;
        public Kdf Kdf = Kdf.DefaultScrypt;
        public string Salt = "", Iv = "", WrappedKey = "";

        public string ToJson()
        {
            var k = new Dictionary<string, object?> { ["alg"] = Kdf.Alg };
            if (Kdf.Alg == "scrypt") { k["N"] = Kdf.N; k["r"] = Kdf.R; k["p"] = Kdf.P; }
            else { k["memoryKiB"] = Kdf.MemoryKiB; k["iterations"] = Kdf.Iterations; k["parallelism"] = Kdf.Parallelism; }
            return Json.Write(new Dictionary<string, object?> { ["version"] = Version, ["kdf"] = k, ["salt"] = Salt, ["iv"] = Iv, ["wrappedKey"] = WrappedKey });
        }

        public static KeyEnvelope FromJson(string json)
        {
            var d = Json.Obj(json); var k = d.O("kdf");
            var e = new KeyEnvelope
            {
                Version = (int)d.L("version"), Salt = d.S("salt"), Iv = d.S("iv"), WrappedKey = d.S("wrappedKey"),
                Kdf = new Kdf { Alg = k.S("alg"), N = (int)k.L("N"), R = (int)k.L("r"), P = (int)k.L("p"), MemoryKiB = (int)k.L("memoryKiB"), Iterations = (int)k.L("iterations"), Parallelism = (int)k.L("parallelism") },
            };
            e.Validate();
            return e;
        }

        public void Validate()
        {
            var bad = new FormatException("gendragoon: key envelope is not valid");
            if (Version < 1) throw bad;
            if (Kdf.Alg == "scrypt") { if (Kdf.N < 1 << 14 || Kdf.N > 1 << 20 || (Kdf.N & (Kdf.N - 1)) != 0 || Kdf.R != 8 || Kdf.P < 1 || Kdf.P > 4) throw bad; }
            else if (Kdf.Alg == "argon2id") { if (Kdf.MemoryKiB < 19456 || Kdf.MemoryKiB > 1048576 || Kdf.Iterations < 1 || Kdf.Iterations > 10 || Kdf.Parallelism < 1 || Kdf.Parallelism > 4) throw bad; }
            else throw bad;
            try
            {
                int s = Bytes.FromB64u(Salt).Length, i = Bytes.FromB64u(Iv).Length, w = Bytes.FromB64u(WrappedKey).Length;
                if (s < 16 || s > 64 || i < 12 || i > 32 || w < 32) throw bad;
            }
            catch (FormatException) { throw bad; }
        }
    }

    /// <summary>Encryption formats (sdk/spec/FORMATS.md): AES-256-GCM with HKDF-SHA256 subkeys of a 32-byte master key.</summary>
    public static class Crypto
    {
        public const int KeyBytes = 32, NonceBytes = 12;
        const string Info = "gendragoon-sdk/v1/";
        static readonly byte[] ChunkMagic = Encoding.ASCII.GetBytes("GDC1"), ManifestMagic = Encoding.ASCII.GetBytes("GDM1"), PlainManifest = Encoding.ASCII.GetBytes("GDM0");

        /// <summary>Argon2id is not in .NET. Install an implementation (pass, salt, kdf, length) to open argon2id envelopes.</summary>
        public static Func<byte[], byte[], Kdf, int, byte[]>? Argon2id { get; set; }

        /// <summary>HKDF-SHA256(ikm, no salt, info = "gendragoon-sdk/v1/" + purpose).</summary>
        public static byte[] SubKey(byte[] ikm, string purpose) => Hkdf.Derive(ikm, null, Encoding.UTF8.GetBytes(Info + purpose));

        internal static byte[] Hkdf32(byte[] ikm, byte[] salt, string info) => Hkdf.Derive(ikm, salt, Encoding.UTF8.GetBytes(info));
        internal static byte[] Seal(byte[] key, byte[] nonce, byte[] pt, byte[]? aad = null) => Gcm.Seal(key, nonce, pt, aad);
        internal static byte[]? Open(byte[] key, byte[] nonce, byte[] ct, byte[]? aad = null) => Gcm.Open(key, nonce, ct, aad);

        static byte[] DeriveKek(string passphrase, Kdf k, byte[] salt)
        {
            var pw = Encoding.UTF8.GetBytes(passphrase);
            if (pw.Length < 8) throw new ArgumentException("gendragoon: recovery passphrase must be at least 8 characters");
            if (k.Alg == "scrypt") return Scrypt.Derive(pw, salt, k.N, k.R, k.P, KeyBytes);
            if (Argon2id == null) throw new NotSupportedException("gendragoon: this envelope uses argon2id; set Crypto.Argon2id to an implementation");
            return Argon2id(pw, salt, k, KeyBytes);
        }

        public static KeyEnvelope WrapMasterKey(byte[] mk, string passphrase, Kdf? kdf = null, int version = 1, Func<int, byte[]>? rnd = null)
        {
            if (mk.Length != KeyBytes) throw new ArgumentException("gendragoon: master key must be 32 bytes");
            rnd ??= Bytes.Random;
            kdf ??= Kdf.DefaultScrypt;
            byte[] salt = rnd(16), iv = rnd(NonceBytes);
            var kek = DeriveKek(passphrase, kdf, salt);
            try
            {
                var env = new KeyEnvelope { Version = version, Kdf = kdf, Salt = Bytes.B64u(salt), Iv = Bytes.B64u(iv), WrappedKey = Bytes.B64u(Gcm.Seal(kek, iv, mk, null)) };
                env.Validate();
                return env;
            }
            finally { Bytes.Wipe(kek); }
        }

        public static byte[] UnwrapMasterKey(KeyEnvelope env, string passphrase)
        {
            env.Validate();
            var kek = DeriveKek(passphrase, env.Kdf, Bytes.FromB64u(env.Salt));
            try
            {
                var mk = Gcm.Open(kek, Bytes.FromB64u(env.Iv), Bytes.FromB64u(env.WrappedKey), null);
                if (mk == null || mk.Length != KeyBytes) throw new WrongPassphraseException();
                return mk;
            }
            finally { Bytes.Wipe(kek); }
        }

        /// <summary>Encrypts one chunk; returns (blob id, stored bytes). The id is an HMAC of the plaintext under the file's id key.</summary>
        public static (string Id, byte[] Blob) SealChunk(byte[] fileKey, byte[] plaintext, byte[]? nonce = null)
        {
            nonce ??= Bytes.Random(NonceBytes);
            var rawId = Bytes.HmacSha256(SubKey(fileKey, "chunk-id"), plaintext);
            var ct = Gcm.Seal(SubKey(fileKey, "chunk-enc"), nonce, plaintext, Bytes.Concat(ChunkMagic, rawId));
            return (Bytes.Hex(rawId), Bytes.Concat(ChunkMagic, nonce, ct));
        }

        public static byte[] OpenChunk(byte[] fileKey, string id, byte[] blob)
        {
            byte[] rawId;
            try { rawId = Bytes.FromHex(id); } catch (FormatException) { throw new CorruptException(); }
            if (rawId.Length != 32 || blob.Length < 4 + NonceBytes + 16 || !Bytes.Equal(Bytes.Slice(blob, 0, 4), ChunkMagic)) throw new CorruptException();
            var pt = Gcm.Open(SubKey(fileKey, "chunk-enc"), Bytes.Slice(blob, 4, NonceBytes), Bytes.Slice(blob, 16, blob.Length - 16), Bytes.Concat(ChunkMagic, rawId));
            if (pt == null || !Bytes.Equal(Bytes.HmacSha256(SubKey(fileKey, "chunk-id"), pt), rawId)) throw new CorruptException();
            return pt;
        }

        public static string DriveManifestKey(byte[]? mk, string name) => mk == null
            ? Bytes.Hex(Bytes.Sha256(Encoding.UTF8.GetBytes(Info + "drive:" + name)))
            : Bytes.Hex(Bytes.HmacSha256(SubKey(mk, "manifest-name"), Encoding.UTF8.GetBytes("drive:" + name)));

        public static byte[] SealManifest(byte[]? mk, string key, byte[] plaintext, byte[]? nonce = null)
        {
            if (mk == null) return Bytes.Concat(PlainManifest, plaintext);
            nonce ??= Bytes.Random(NonceBytes);
            return Bytes.Concat(ManifestMagic, nonce, Gcm.Seal(SubKey(mk, "manifest-enc"), nonce, plaintext, Bytes.Concat(ManifestMagic, Bytes.FromHex(key))));
        }

        public static byte[] OpenManifest(byte[]? mk, string key, byte[] data)
        {
            if (data.Length >= 4 && Bytes.Equal(Bytes.Slice(data, 0, 4), PlainManifest)) return Bytes.Slice(data, 4, data.Length - 4);
            if (data.Length < 4 + NonceBytes + 16 || !Bytes.Equal(Bytes.Slice(data, 0, 4), ManifestMagic)) throw new CorruptException();
            if (mk == null) throw new LockedException();
            var pt = Gcm.Open(SubKey(mk, "manifest-enc"), Bytes.Slice(data, 4, NonceBytes), Bytes.Slice(data, 16, data.Length - 16), Bytes.Concat(ManifestMagic, Bytes.FromHex(key)));
            return pt ?? throw new CorruptException();
        }
    }
}
