import Crypto
import Foundation

/// KDF parameters: "scrypt" (n, r, p) or "argon2id" (memoryKiB, iterations, parallelism).
public struct Kdf: Equatable, Sendable {
    public var alg: String
    public var n = 0, r = 0, p = 0, memoryKiB = 0, iterations = 0, parallelism = 0
    public static let defaultScrypt = Kdf(alg: "scrypt", n: 1 << 15, r: 8, p: 1)
    public init(alg: String, n: Int = 0, r: Int = 0, p: Int = 0, memoryKiB: Int = 0, iterations: Int = 0, parallelism: Int = 0) {
        self.alg = alg; self.n = n; self.r = r; self.p = p; self.memoryKiB = memoryKiB; self.iterations = iterations; self.parallelism = parallelism
    }
}

/// The wrapped master key exactly as the server stores it.
public struct KeyEnvelope: Equatable, Sendable {
    public var version: Int
    public var kdf: Kdf
    public var salt: String, iv: String, wrappedKey: String

    var json: JV {
        let k: JV = kdf.alg == "scrypt"
            ? .obj([("alg", .str("scrypt")), ("N", .int(Int64(kdf.n))), ("r", .int(Int64(kdf.r))), ("p", .int(Int64(kdf.p)))])
            : .obj([("alg", .str(kdf.alg)), ("memoryKiB", .int(Int64(kdf.memoryKiB))), ("iterations", .int(Int64(kdf.iterations))), ("parallelism", .int(Int64(kdf.parallelism)))])
        return .obj([("version", .int(Int64(version))), ("kdf", k), ("salt", .str(salt)), ("iv", .str(iv)), ("wrappedKey", .str(wrappedKey))])
    }
    public func toJSON() -> String { json.text }

    public static func fromJSON(_ data: Data) throws -> KeyEnvelope {
        let d = try parseObject(data), k = d.o("kdf")
        let e = KeyEnvelope(version: Int(d.l("version")),
                            kdf: Kdf(alg: k.s("alg"), n: Int(k.l("N")), r: Int(k.l("r")), p: Int(k.l("p")), memoryKiB: Int(k.l("memoryKiB")), iterations: Int(k.l("iterations")), parallelism: Int(k.l("parallelism"))),
                            salt: d.s("salt"), iv: d.s("iv"), wrappedKey: d.s("wrappedKey"))
        try e.validate()
        return e
    }

    public func validate() throws {
        let bad = GendragoonError.invalid("key envelope is not valid")
        guard version >= 1 else { throw bad }
        switch kdf.alg {
        case "scrypt": guard kdf.n >= 1 << 14, kdf.n <= 1 << 20, kdf.n & (kdf.n - 1) == 0, kdf.r == 8, (1...4).contains(kdf.p) else { throw bad }
        case "argon2id": guard (19456...1_048_576).contains(kdf.memoryKiB), (1...10).contains(kdf.iterations), (1...4).contains(kdf.parallelism) else { throw bad }
        default: throw bad
        }
        guard let s = try? Bytes.fromB64u(salt), let i = try? Bytes.fromB64u(iv), let w = try? Bytes.fromB64u(wrappedKey),
              (16...64).contains(s.count), (12...32).contains(i.count), w.count >= 32 else { throw bad }
    }
}

/// Encryption formats (sdk/spec/FORMATS.md): AES-256-GCM with HKDF-SHA256 subkeys of a 32-byte master key.
public enum GDCrypto {
    public static let keyBytes = 32, nonceBytes = 12
    static let info = "gendragoon-sdk/v1/"
    static let chunkMagic = Data("GDC1".utf8), manifestMagic = Data("GDM1".utf8), plainManifest = Data("GDM0".utf8)

    /// Argon2id is not in swift-crypto. Install an implementation (password, salt, kdf, length) to open argon2id envelopes.
    nonisolated(unsafe) public static var argon2id: ((Data, Data, Kdf, Int) throws -> Data)?

    /// HKDF-SHA256(ikm, no salt, info = "gendragoon-sdk/v1/" + purpose).
    public static func subKey(_ ikm: Data, _ purpose: String) -> Data { hkdf(ikm, Data(), info + purpose) }

    static func hkdf(_ ikm: Data, _ salt: Data, _ info: String) -> Data {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: Data(info.utf8), outputByteCount: 32).withUnsafeBytes { Data($0) }
    }

    static func seal(_ key: Data, _ nonce: Data, _ pt: Data, _ aad: Data = Data()) throws -> Data {
        let box = try AES.GCM.seal(pt, using: SymmetricKey(data: key), nonce: AES.GCM.Nonce(data: nonce), authenticating: aad)
        return box.ciphertext + box.tag
    }

    static func open(_ key: Data, _ nonce: Data, _ ct: Data, _ aad: Data = Data()) -> Data? {
        guard ct.count >= 16, let n = try? AES.GCM.Nonce(data: nonce),
              let box = try? AES.GCM.SealedBox(nonce: n, ciphertext: ct.prefix(ct.count - 16), tag: ct.suffix(16)) else { return nil }
        return try? AES.GCM.open(box, using: SymmetricKey(data: key), authenticating: aad)
    }

    static func deriveKek(_ passphrase: String, _ k: Kdf, _ salt: Data) throws -> Data {
        let pw = Data(passphrase.utf8)
        guard pw.count >= 8 else { throw GendragoonError.invalid("recovery passphrase must be at least 8 characters") }
        if k.alg == "scrypt" { return Scrypt.derive(pw, salt, n: k.n, r: k.r, p: k.p, len: keyBytes) }
        guard let f = argon2id else { throw GendragoonError.unsupported("this envelope uses argon2id; set GDCrypto.argon2id to an implementation") }
        return try f(pw, salt, k, keyBytes)
    }

    public static func wrapMasterKey(_ mk: Data, passphrase: String, kdf: Kdf = .defaultScrypt, version: Int = 1, random: ((Int) -> Data)? = nil) throws -> KeyEnvelope {
        let random = random ?? Bytes.random
        guard mk.count == keyBytes else { throw GendragoonError.invalid("master key must be 32 bytes") }
        let salt = random(16), iv = random(nonceBytes)
        let kek = try deriveKek(passphrase, kdf, salt)
        let env = KeyEnvelope(version: version, kdf: kdf, salt: Bytes.b64u(salt), iv: Bytes.b64u(iv), wrappedKey: Bytes.b64u(try seal(kek, iv, mk)))
        try env.validate()
        return env
    }

    public static func unwrapMasterKey(_ env: KeyEnvelope, passphrase: String) throws -> Data {
        try env.validate()
        let kek = try deriveKek(passphrase, env.kdf, try Bytes.fromB64u(env.salt))
        guard let mk = open(kek, try Bytes.fromB64u(env.iv), try Bytes.fromB64u(env.wrappedKey)), mk.count == keyBytes else { throw GendragoonError.wrongPassphrase }
        return mk
    }

    /// Encrypts one chunk; returns (blob id, stored bytes). The id is an HMAC of the plaintext under the file's id key.
    public static func sealChunk(_ fileKey: Data, _ plaintext: Data, nonce: Data? = nil) throws -> (id: String, blob: Data) {
        let nonce = nonce ?? Bytes.random(nonceBytes)
        let rawId = Bytes.hmac(subKey(fileKey, "chunk-id"), plaintext)
        let ct = try seal(subKey(fileKey, "chunk-enc"), nonce, plaintext, chunkMagic + rawId)
        return (Bytes.hex(rawId), chunkMagic + nonce + ct)
    }

    public static func openChunk(_ fileKey: Data, id: String, blob: Data) throws -> Data {
        guard let rawId = try? Bytes.fromHex(id), rawId.count == 32, blob.count >= 4 + nonceBytes + 16, blob.prefix(4) == chunkMagic else { throw GendragoonError.corrupt }
        let b = Data(blob)
        guard let pt = open(subKey(fileKey, "chunk-enc"), b.subdata(in: 4..<16), b.subdata(in: 16..<b.count), chunkMagic + rawId),
              Bytes.equal(Bytes.hmac(subKey(fileKey, "chunk-id"), pt), rawId) else { throw GendragoonError.corrupt }
        return pt
    }

    public static func driveManifestKey(_ mk: Data?, _ name: String) -> String {
        guard let mk = mk else { return Bytes.hex(Bytes.sha256(Data((info + "drive:" + name).utf8))) }
        return Bytes.hex(Bytes.hmac(subKey(mk, "manifest-name"), Data(("drive:" + name).utf8)))
    }

    public static func sealManifest(_ mk: Data?, key: String, _ plaintext: Data, nonce: Data? = nil) throws -> Data {
        guard let mk = mk else { return plainManifest + plaintext }
        let nonce = nonce ?? Bytes.random(nonceBytes)
        return manifestMagic + nonce + (try seal(subKey(mk, "manifest-enc"), nonce, plaintext, manifestMagic + Bytes.fromHex(key)))
    }

    public static func openManifest(_ mk: Data?, key: String, _ data: Data) throws -> Data {
        let d = Data(data)
        if d.count >= 4 && d.prefix(4) == plainManifest { return d.subdata(in: 4..<d.count) }
        guard d.count >= 4 + nonceBytes + 16, d.prefix(4) == manifestMagic else { throw GendragoonError.corrupt }
        guard let mk = mk else { throw GendragoonError.locked }
        guard let pt = open(subKey(mk, "manifest-enc"), d.subdata(in: 4..<16), d.subdata(in: 16..<d.count), manifestMagic + (try Bytes.fromHex(key))) else { throw GendragoonError.corrupt }
        return pt
    }

    public static func pkceChallenge(_ verifier: String) -> String { Bytes.b64u(Bytes.sha256(Data(verifier.utf8))) }
}
