using System;
using System.Numerics;
using System.Security.Cryptography;

namespace Gendragoon.Sdk
{
    /// <summary>Byte helpers: hex and unpadded base64url.</summary>
    public static class Bytes
    {
        public static string Hex(byte[] b)
        {
            var c = new char[b.Length * 2];
            for (int i = 0; i < b.Length; i++) { c[2 * i] = "0123456789abcdef"[b[i] >> 4]; c[2 * i + 1] = "0123456789abcdef"[b[i] & 15]; }
            return new string(c);
        }
        public static byte[] FromHex(string s)
        {
            if (s.Length % 2 != 0) throw new FormatException("odd hex length");
            var b = new byte[s.Length / 2];
            for (int i = 0; i < b.Length; i++) b[i] = Convert.ToByte(s.Substring(2 * i, 2), 16);
            return b;
        }
        public static string B64u(byte[] b) => Convert.ToBase64String(b).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        public static byte[] FromB64u(string s)
        {
            if (s.IndexOfAny(new[] { '+', '/', '=' }) >= 0) throw new FormatException("not base64url");
            var t = s.Replace('-', '+').Replace('_', '/');
            return Convert.FromBase64String(t + new string('=', (4 - t.Length % 4) % 4));
        }
        public static byte[] Concat(params byte[][] parts)
        {
            int n = 0; foreach (var p in parts) n += p.Length;
            var o = new byte[n]; int off = 0;
            foreach (var p in parts) { Buffer.BlockCopy(p, 0, o, off, p.Length); off += p.Length; }
            return o;
        }
        public static byte[] Slice(byte[] b, int start, int len) { var o = new byte[len]; Buffer.BlockCopy(b, start, o, 0, len); return o; }
        public static bool Equal(byte[] a, byte[] b)
        {
            if (a.Length != b.Length) return false;
            int d = 0; for (int i = 0; i < a.Length; i++) d |= a[i] ^ b[i];
            return d == 0;
        }
        public static byte[] Random(int n) { var b = new byte[n]; using (var r = RandomNumberGenerator.Create()) r.GetBytes(b); return b; }
        public static void Wipe(byte[]? b) { if (b != null) Array.Clear(b, 0, b.Length); }
        public static byte[] Sha256(byte[] data) { using (var h = SHA256.Create()) return h.ComputeHash(data); }
        public static byte[] HmacSha256(byte[] key, byte[] data) { using (var h = new HMACSHA256(key)) return h.ComputeHash(data); }
    }

    /// <summary>HKDF-SHA256 (RFC 5869), 32-byte output.</summary>
    internal static class Hkdf
    {
        public static byte[] Derive(byte[] ikm, byte[]? salt, byte[] info)
        {
            var prk = Bytes.HmacSha256(salt == null || salt.Length == 0 ? new byte[32] : salt, ikm);
            var t = Bytes.HmacSha256(prk, Bytes.Concat(info, new byte[] { 1 }));
            Bytes.Wipe(prk);
            return t;
        }
    }

    /// <summary>AES-256-GCM, 12-byte nonce, 16-byte tag appended. The platform implementation on .NET Core 3+;
    /// a managed one (AES-ECB counter mode plus GHASH) on .NET Standard 2.1, which is what Unity loads.</summary>
    internal static class Gcm
    {
        public static byte[] Seal(byte[] key, byte[] nonce, byte[] plaintext, byte[]? aad)
        {
#if NETCOREAPP3_0_OR_GREATER
            if (nonce.Length == 12)
            {
                var ct = new byte[plaintext.Length]; var tag = new byte[16];
                using (var g = new AesGcm(key, 16)) g.Encrypt(nonce, plaintext, ct, tag, aad);
                return Bytes.Concat(ct, tag);
            }
#endif
            return ManagedGcm.Seal(key, nonce, plaintext, aad ?? Array.Empty<byte>());
        }

        public static byte[]? Open(byte[] key, byte[] nonce, byte[] sealedData, byte[]? aad)
        {
            if (sealedData.Length < 16) return null;
#if NETCOREAPP3_0_OR_GREATER
            if (nonce.Length == 12)
            {
                var ct = Bytes.Slice(sealedData, 0, sealedData.Length - 16);
                var tag = Bytes.Slice(sealedData, sealedData.Length - 16, 16);
                var pt = new byte[ct.Length];
                try { using (var g = new AesGcm(key, 16)) g.Decrypt(nonce, ct, tag, pt, aad); return pt; }
                catch (CryptographicException) { return null; }
            }
#endif
            return ManagedGcm.Open(key, nonce, sealedData, aad ?? Array.Empty<byte>());
        }
    }

    internal static class ManagedGcm
    {
        static ICryptoTransform Ecb(byte[] key)
        {
            var aes = Aes.Create();
            aes.Mode = CipherMode.ECB; aes.Padding = PaddingMode.None; aes.Key = key;
            return aes.CreateEncryptor();
        }

        static void Mul(ref ulong zh, ref ulong zl, ulong hh, ulong hl)
        {
            ulong rh = 0, rl = 0, vh = hh, vl = hl, xh = zh, xl = zl;
            for (int i = 0; i < 128; i++)
            {
                ulong bit = i < 64 ? (xh >> (63 - i)) & 1 : (xl >> (127 - i)) & 1;
                ulong m = 0UL - bit;
                rh ^= vh & m; rl ^= vl & m;
                ulong lsb = vl & 1;
                vl = (vl >> 1) | (vh << 63);
                vh = (vh >> 1) ^ (0xE100000000000000UL & (0UL - lsb));
            }
            zh = rh; zl = rl;
        }

        static ulong Be64(byte[] b, int o) { ulong v = 0; for (int i = 0; i < 8; i++) v = (v << 8) | b[o + i]; return v; }
        static void PutBe64(byte[] b, int o, ulong v) { for (int i = 7; i >= 0; i--) { b[o + i] = (byte)v; v >>= 8; } }

        static byte[] Ghash(byte[] h, byte[] aad, byte[] ct)
        {
            ulong hh = Be64(h, 0), hl = Be64(h, 8), zh = 0, zl = 0;
            void Absorb(byte[] data)
            {
                var blk = new byte[16];
                for (int off = 0; off < data.Length; off += 16)
                {
                    int n = Math.Min(16, data.Length - off);
                    Array.Clear(blk, 0, 16); Buffer.BlockCopy(data, off, blk, 0, n);
                    zh ^= Be64(blk, 0); zl ^= Be64(blk, 8);
                    Mul(ref zh, ref zl, hh, hl);
                }
            }
            Absorb(aad); Absorb(ct);
            zh ^= (ulong)aad.Length * 8; zl ^= (ulong)ct.Length * 8;
            Mul(ref zh, ref zl, hh, hl);
            var o = new byte[16]; PutBe64(o, 0, zh); PutBe64(o, 8, zl);
            return o;
        }

        static (byte[] h, byte[] ekj0, byte[] keystream) Setup(byte[] key, byte[] nonce, int length)
        {
            using (var e = Ecb(key))
            {
                var h = new byte[16]; e.TransformBlock(new byte[16], 0, 16, h, 0);
                byte[] j0;
                if (nonce.Length == 12) j0 = Bytes.Concat(nonce, new byte[] { 0, 0, 0, 1 });
                else
                {
                    // SP 800-38D: J0 = GHASH(IV || 0-pad || [0]64 || [len(IV)]64), which is GHASH with no AAD.
                    j0 = Ghash(h, Array.Empty<byte>(), nonce);
                }
                var ekj0 = new byte[16]; e.TransformBlock(j0, 0, 16, ekj0, 0);
                int blocks = (length + 15) / 16;
                var ctr = new byte[blocks * 16];
                uint c = (uint)(j0[12] << 24 | j0[13] << 16 | j0[14] << 8 | j0[15]);
                for (int i = 0; i < blocks; i++)
                {
                    Buffer.BlockCopy(j0, 0, ctr, i * 16, 12);
                    uint v = unchecked(c + 1 + (uint)i);
                    ctr[i * 16 + 12] = (byte)(v >> 24); ctr[i * 16 + 13] = (byte)(v >> 16); ctr[i * 16 + 14] = (byte)(v >> 8); ctr[i * 16 + 15] = (byte)v;
                }
                var ks = new byte[ctr.Length];
                if (ctr.Length > 0) e.TransformBlock(ctr, 0, ctr.Length, ks, 0);
                return (h, ekj0, ks);
            }
        }

        public static byte[] Seal(byte[] key, byte[] nonce, byte[] pt, byte[] aad)
        {
            var (h, ekj0, ks) = Setup(key, nonce, pt.Length);
            var ct = new byte[pt.Length];
            for (int i = 0; i < pt.Length; i++) ct[i] = (byte)(pt[i] ^ ks[i]);
            var tag = Ghash(h, aad, ct);
            for (int i = 0; i < 16; i++) tag[i] ^= ekj0[i];
            return Bytes.Concat(ct, tag);
        }

        public static byte[]? Open(byte[] key, byte[] nonce, byte[] sealedData, byte[] aad)
        {
            var ct = Bytes.Slice(sealedData, 0, sealedData.Length - 16);
            var (h, ekj0, ks) = Setup(key, nonce, ct.Length);
            var tag = Ghash(h, aad, ct);
            for (int i = 0; i < 16; i++) tag[i] ^= ekj0[i];
            if (!Bytes.Equal(tag, Bytes.Slice(sealedData, ct.Length, 16))) return null;
            var pt = new byte[ct.Length];
            for (int i = 0; i < ct.Length; i++) pt[i] = (byte)(ct[i] ^ ks[i]);
            return pt;
        }
    }

    /// <summary>scrypt (RFC 7914) on PBKDF2-HMAC-SHA256.</summary>
    internal static class Scrypt
    {
        static byte[] Pbkdf2(byte[] pass, byte[] salt, int len)
        {
            using (var k = new Rfc2898DeriveBytes(pass, salt, 1, HashAlgorithmName.SHA256)) return k.GetBytes(len);
        }

        static uint R(uint a, int n) => (a << n) | (a >> (32 - n));

        static void Salsa8(uint[] b, int off, uint[] x)
        {
            Array.Copy(b, off, x, 0, 16);
            for (int i = 0; i < 8; i += 2)
            {
                x[4] ^= R(x[0] + x[12], 7); x[8] ^= R(x[4] + x[0], 9); x[12] ^= R(x[8] + x[4], 13); x[0] ^= R(x[12] + x[8], 18);
                x[9] ^= R(x[5] + x[1], 7); x[13] ^= R(x[9] + x[5], 9); x[1] ^= R(x[13] + x[9], 13); x[5] ^= R(x[1] + x[13], 18);
                x[14] ^= R(x[10] + x[6], 7); x[2] ^= R(x[14] + x[10], 9); x[6] ^= R(x[2] + x[14], 13); x[10] ^= R(x[6] + x[2], 18);
                x[3] ^= R(x[15] + x[11], 7); x[7] ^= R(x[3] + x[15], 9); x[11] ^= R(x[7] + x[3], 13); x[15] ^= R(x[11] + x[7], 18);
                x[1] ^= R(x[0] + x[3], 7); x[2] ^= R(x[1] + x[0], 9); x[3] ^= R(x[2] + x[1], 13); x[0] ^= R(x[3] + x[2], 18);
                x[6] ^= R(x[5] + x[4], 7); x[7] ^= R(x[6] + x[5], 9); x[4] ^= R(x[7] + x[6], 13); x[5] ^= R(x[4] + x[7], 18);
                x[11] ^= R(x[10] + x[9], 7); x[8] ^= R(x[11] + x[10], 9); x[9] ^= R(x[8] + x[11], 13); x[10] ^= R(x[9] + x[8], 18);
                x[12] ^= R(x[15] + x[14], 7); x[13] ^= R(x[12] + x[15], 9); x[14] ^= R(x[13] + x[12], 13); x[15] ^= R(x[14] + x[13], 18);
            }
            for (int i = 0; i < 16; i++) b[off + i] += x[i];
        }

        static void BlockMix(uint[] B, uint[] Y, int r, uint[] X, uint[] tmp)
        {
            Array.Copy(B, (2 * r - 1) * 16, X, 0, 16);
            for (int i = 0; i < 2 * r; i++)
            {
                for (int j = 0; j < 16; j++) X[j] ^= B[i * 16 + j];
                Salsa8(X, 0, tmp);
                Array.Copy(X, 0, Y, ((i >> 1) + (i & 1) * r) * 16, 16);
            }
        }

        public static byte[] Derive(byte[] pass, byte[] salt, int N, int r, int p, int dkLen)
        {
            int words = 32 * r;
            var raw = Pbkdf2(pass, salt, p * 128 * r);
            var B = new uint[p * words];
            for (int i = 0; i < B.Length; i++) B[i] = BitConverter.ToUInt32(raw, i * 4);
            if (!BitConverter.IsLittleEndian) throw new PlatformNotSupportedException("big-endian platforms are not supported");
            var V = new uint[(long)N * words];
            uint[] X = new uint[words], Y = new uint[words], T = new uint[16], S = new uint[16];
            for (int k = 0; k < p; k++)
            {
                Array.Copy(B, k * words, X, 0, words);
                for (int i = 0; i < N; i++) { Array.Copy(X, 0, V, (long)i * words, words); BlockMix(X, Y, r, T, S); Array.Copy(Y, X, words); }
                for (int i = 0; i < N; i++)
                {
                    long j = X[(2 * r - 1) * 16] & (uint)(N - 1);
                    for (int w = 0; w < words; w++) X[w] ^= V[j * words + w];
                    BlockMix(X, Y, r, T, S); Array.Copy(Y, X, words);
                }
                Array.Copy(X, 0, B, k * words, words);
            }
            var outb = new byte[B.Length * 4];
            Buffer.BlockCopy(B, 0, outb, 0, outb.Length);
            Array.Clear(V, 0, V.Length);
            return Pbkdf2(pass, outb, dkLen);
        }
    }

    /// <summary>P-256 ECDH. The platform implementation on .NET 8; a managed one (BigInteger, not constant-time)
    /// on .NET Standard 2.1 for Unity, where the platform offers no raw ECDH.</summary>
    internal static class P256
    {
        static readonly BigInteger P = BigInteger.Parse("0ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", System.Globalization.NumberStyles.HexNumber);
        static readonly BigInteger N = BigInteger.Parse("0ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", System.Globalization.NumberStyles.HexNumber);
        static readonly BigInteger B = BigInteger.Parse("05ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", System.Globalization.NumberStyles.HexNumber);
        static readonly BigInteger Gx = BigInteger.Parse("06b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296", System.Globalization.NumberStyles.HexNumber);
        static readonly BigInteger Gy = BigInteger.Parse("04fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5", System.Globalization.NumberStyles.HexNumber);

        static BigInteger Mod(BigInteger a) { var r = a % P; return r.Sign < 0 ? r + P : r; }
        static BigInteger Inv(BigInteger a) => BigInteger.ModPow(Mod(a), P - 2, P);
        static BigInteger Num(byte[] be, int off, int len) { var le = new byte[len + 1]; for (int i = 0; i < len; i++) le[i] = be[off + len - 1 - i]; return new BigInteger(le); }
        static byte[] Be32(BigInteger v) { var le = v.ToByteArray(); var o = new byte[32]; for (int i = 0; i < 32 && i < le.Length; i++) o[31 - i] = le[i]; return o; }

        // Jacobian coordinates; Z = 0 is the point at infinity.
        static (BigInteger, BigInteger, BigInteger) Dbl((BigInteger X, BigInteger Y, BigInteger Z) p)
        {
            if (p.Z.IsZero || p.Y.IsZero) return (0, 1, 0);
            var ysq = Mod(p.Y * p.Y);
            var s = Mod(4 * p.X * ysq);
            var zsq = Mod(p.Z * p.Z);
            var m = Mod(3 * (p.X - zsq) * (p.X + zsq));
            var x = Mod(m * m - 2 * s);
            var y = Mod(m * (s - x) - 8 * ysq * ysq);
            var z = Mod(2 * p.Y * p.Z);
            return (x, y, z);
        }

        static (BigInteger, BigInteger, BigInteger) Add((BigInteger X, BigInteger Y, BigInteger Z) p, (BigInteger X, BigInteger Y, BigInteger Z) q)
        {
            if (p.Z.IsZero) return q;
            if (q.Z.IsZero) return p;
            var z1z1 = Mod(p.Z * p.Z); var z2z2 = Mod(q.Z * q.Z);
            var u1 = Mod(p.X * z2z2); var u2 = Mod(q.X * z1z1);
            var s1 = Mod(p.Y * q.Z * z2z2); var s2 = Mod(q.Y * p.Z * z1z1);
            if (u1 == u2) return s1 == s2 ? Dbl(p) : (0, 1, 0);
            var h = Mod(u2 - u1); var r = Mod(s2 - s1);
            var h2 = Mod(h * h); var h3 = Mod(h * h2);
            var x = Mod(r * r - h3 - 2 * u1 * h2);
            var y = Mod(r * (u1 * h2 - x) - s1 * h3);
            var z = Mod(h * p.Z * q.Z);
            return (x, y, z);
        }

        static (BigInteger x, BigInteger y) Mul(BigInteger k, BigInteger px, BigInteger py)
        {
            (BigInteger, BigInteger, BigInteger) r = (0, 1, 0), a = (px, py, 1);
            for (int i = 255; i >= 0; i--)
            {
                r = Dbl(r);
                if (!(k >> i & 1).IsZero) r = Add(r, a);
            }
            if (r.Item3.IsZero) throw new CryptographicException("point at infinity");
            var zi = Inv(r.Item3); var zi2 = Mod(zi * zi);
            return (Mod(r.Item1 * zi2), Mod(r.Item2 * zi2 * zi));
        }

        static (BigInteger x, BigInteger y) Point(byte[] pub)
        {
            if (pub.Length != 65 || pub[0] != 4) throw new CryptographicException("not an uncompressed P-256 point");
            var x = Num(pub, 1, 32); var y = Num(pub, 33, 32);
            if (x >= P || y >= P || Mod(y * y) != Mod(x * x * x - 3 * x + B)) throw new CryptographicException("point is not on P-256");
            return (x, y);
        }

        static BigInteger Scalar(byte[] d)
        {
            var k = Num(d, 0, 32);
            if (k.IsZero || k >= N) throw new CryptographicException("invalid P-256 private key");
            return k;
        }

        internal static byte[] ManagedPublic(byte[] d)
        {
            var (x, y) = Mul(Scalar(d), Gx, Gy);
            return Bytes.Concat(new byte[] { 4 }, Be32(x), Be32(y));
        }

        internal static byte[] ManagedShared(byte[] d, byte[] pub)
        {
            var (px, py) = Point(pub);
            return Be32(Mul(Scalar(d), px, py).x);
        }

        /// <summary>A new key pair: (32-byte scalar, 65-byte uncompressed point).</summary>
        public static (byte[] d, byte[] pub) Generate()
        {
#if NET5_0_OR_GREATER
            using (var e = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256))
            {
                var p = e.ExportParameters(true);
                return (p.D!, Bytes.Concat(new byte[] { 4 }, p.Q.X!, p.Q.Y!));
            }
#else
            while (true)
            {
                var d = Bytes.Random(32);
                var k = Num(d, 0, 32);
                if (!k.IsZero && k < N) return (d, ManagedPublic(d));
            }
#endif
        }

        public static byte[] PublicOf(byte[] d)
        {
#if NET5_0_OR_GREATER
            using (var e = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, D = d }))
            {
                var p = e.ExportParameters(false);
                return Bytes.Concat(new byte[] { 4 }, p.Q.X!, p.Q.Y!);
            }
#else
            return ManagedPublic(d);
#endif
        }

        /// <summary>The x-coordinate of d·Q (32 bytes), as WebCrypto, Go and CryptoKit return it.</summary>
        public static byte[] Shared(byte[] d, byte[] myPub, byte[] peerPub)
        {
#if NET8_0_OR_GREATER
            Point(peerPub);
            using (var me = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, D = d, Q = new ECPoint { X = Bytes.Slice(myPub, 1, 32), Y = Bytes.Slice(myPub, 33, 32) } }))
            using (var peer = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = Bytes.Slice(peerPub, 1, 32), Y = Bytes.Slice(peerPub, 33, 32) } }))
                return me.DeriveRawSecretAgreement(peer.PublicKey);
#else
            return ManagedShared(d, peerPub);
#endif
        }
    }
}
