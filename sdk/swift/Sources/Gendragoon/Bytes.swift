import Crypto
import Foundation

enum Bytes {
    static func hex(_ d: Data) -> String { d.map { String(format: "%02x", $0) }.joined() }
    static func fromHex(_ s: String) throws -> Data {
        let u = Array(s.utf8)
        guard u.count % 2 == 0 else { throw GendragoonError.corrupt }
        var o = Data(capacity: u.count / 2)
        func nib(_ c: UInt8) throws -> UInt8 {
            switch c {
            case 48...57: return c - 48
            case 97...102: return c - 87
            case 65...70: return c - 55
            default: throw GendragoonError.corrupt
            }
        }
        var i = 0
        while i < u.count { o.append(try nib(u[i]) << 4 | nib(u[i + 1])); i += 2 }
        return o
    }
    static func b64u(_ d: Data) -> String {
        d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    static func fromB64u(_ s: String) throws -> Data {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        if t.contains("=") { throw GendragoonError.corrupt }
        while t.count % 4 != 0 { t += "=" }
        guard let d = Data(base64Encoded: t) else { throw GendragoonError.corrupt }
        return d
    }
    static func random(_ n: Int) -> Data {
        var g = SystemRandomNumberGenerator()
        return Data((0..<n).map { _ in UInt8.random(in: 0...255, using: &g) })
    }
    static func sha256(_ d: Data) -> Data { Data(SHA256.hash(data: d)) }
    static func hmac(_ key: Data, _ d: Data) -> Data { Data(HMAC<SHA256>.authenticationCode(for: d, using: SymmetricKey(data: key))) }
    static func equal(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var x: UInt8 = 0
        for (p, q) in zip(a, b) { x |= p ^ q }
        return x == 0
    }
}

/// scrypt (RFC 7914). swift-crypto has no scrypt on every platform, so it is implemented here.
enum Scrypt {
    static func pbkdf2(_ pass: Data, _ salt: Data, _ len: Int) -> Data {
        let key = SymmetricKey(data: pass)
        var out = Data()
        var i: UInt32 = 1
        while out.count < len {
            var s = salt
            s.append(contentsOf: [UInt8(i >> 24), UInt8(i >> 16 & 0xff), UInt8(i >> 8 & 0xff), UInt8(i & 0xff)])
            // Iteration count 1: U1 is the block.
            out.append(Data(HMAC<SHA256>.authenticationCode(for: s, using: key)))
            i += 1
        }
        return out.prefix(len)
    }

    @inline(__always) static func r(_ a: UInt32, _ n: UInt32) -> UInt32 { (a << n) | (a >> (32 - n)) }

    static func salsa8(_ b: inout [UInt32], _ off: Int) {
        var x = Array(b[off..<off + 16])
        for _ in 0..<4 {
            x[4] ^= r(x[0] &+ x[12], 7); x[8] ^= r(x[4] &+ x[0], 9); x[12] ^= r(x[8] &+ x[4], 13); x[0] ^= r(x[12] &+ x[8], 18)
            x[9] ^= r(x[5] &+ x[1], 7); x[13] ^= r(x[9] &+ x[5], 9); x[1] ^= r(x[13] &+ x[9], 13); x[5] ^= r(x[1] &+ x[13], 18)
            x[14] ^= r(x[10] &+ x[6], 7); x[2] ^= r(x[14] &+ x[10], 9); x[6] ^= r(x[2] &+ x[14], 13); x[10] ^= r(x[6] &+ x[2], 18)
            x[3] ^= r(x[15] &+ x[11], 7); x[7] ^= r(x[3] &+ x[15], 9); x[11] ^= r(x[7] &+ x[3], 13); x[15] ^= r(x[11] &+ x[7], 18)
            x[1] ^= r(x[0] &+ x[3], 7); x[2] ^= r(x[1] &+ x[0], 9); x[3] ^= r(x[2] &+ x[1], 13); x[0] ^= r(x[3] &+ x[2], 18)
            x[6] ^= r(x[5] &+ x[4], 7); x[7] ^= r(x[6] &+ x[5], 9); x[4] ^= r(x[7] &+ x[6], 13); x[5] ^= r(x[4] &+ x[7], 18)
            x[11] ^= r(x[10] &+ x[9], 7); x[8] ^= r(x[11] &+ x[10], 9); x[9] ^= r(x[8] &+ x[11], 13); x[10] ^= r(x[9] &+ x[8], 18)
            x[12] ^= r(x[15] &+ x[14], 7); x[13] ^= r(x[12] &+ x[15], 9); x[14] ^= r(x[13] &+ x[12], 13); x[15] ^= r(x[14] &+ x[13], 18)
        }
        for i in 0..<16 { b[off + i] = b[off + i] &+ x[i] }
    }

    static func blockMix(_ b: inout [UInt32], _ y: inout [UInt32], _ rr: Int) {
        let n = 32 * rr
        var x = Array(b[(n - 16)..<n])
        for i in 0..<(2 * rr) {
            for j in 0..<16 { x[j] ^= b[i * 16 + j] }
            salsa8(&x, 0)
            let dst = (i % 2 == 0 ? i / 2 : rr + i / 2) * 16
            for j in 0..<16 { y[dst + j] = x[j] }
        }
        swap(&b, &y)
    }

    static func derive(_ pass: Data, _ salt: Data, n: Int, r rr: Int, p: Int, len: Int) -> Data {
        let blen = 128 * rr
        var bb = [UInt8](pbkdf2(pass, salt, p * blen))
        let words = 32 * rr
        var v = [UInt32](repeating: 0, count: n * words)
        var y = [UInt32](repeating: 0, count: words)
        for k in 0..<p {
            var x = [UInt32](repeating: 0, count: words)
            for i in 0..<words {
                let o = k * blen + i * 4
                x[i] = UInt32(bb[o]) | UInt32(bb[o + 1]) << 8 | UInt32(bb[o + 2]) << 16 | UInt32(bb[o + 3]) << 24
            }
            for i in 0..<n { v.replaceSubrange((i * words)..<((i + 1) * words), with: x); blockMix(&x, &y, rr) }
            for _ in 0..<n {
                let j = Int(x[words - 16] & UInt32(n - 1))
                for i in 0..<words { x[i] ^= v[j * words + i] }
                blockMix(&x, &y, rr)
            }
            for i in 0..<words {
                let o = k * blen + i * 4
                bb[o] = UInt8(x[i] & 0xff); bb[o + 1] = UInt8(x[i] >> 8 & 0xff); bb[o + 2] = UInt8(x[i] >> 16 & 0xff); bb[o + 3] = UInt8(x[i] >> 24)
            }
        }
        return pbkdf2(pass, Data(bb), len)
    }
}
