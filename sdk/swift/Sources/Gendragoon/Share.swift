import Crypto
import Foundation

/// A recipient key pair (P-256).
public struct Identity: CustomStringConvertible, @unchecked Sendable {
    static let prefix = "gdid1_"
    let key: P256.KeyAgreement.PrivateKey
    var pub: Data { key.publicKey.x963Representation }

    init(key: P256.KeyAgreement.PrivateKey) { self.key = key }

    /// Level L2, risk key (local).
    public static func create(_ t: Transport) throws -> Identity {
        try t.check("share.createIdentity")
        return Identity(key: P256.KeyAgreement.PrivateKey())
    }

    /// From privateBytes(): the 32-byte scalar followed by the 65-byte uncompressed public point.
    public init(privateBytes b: Data) throws {
        guard b.count == 97 else { throw GendragoonError.invalid("identity must be 97 bytes") }
        let d = Data(b)
        guard let k = try? P256.KeyAgreement.PrivateKey(rawRepresentation: d.subdata(in: 0..<32)) else { throw GendragoonError.invalid("identity is not a P-256 key") }
        guard k.publicKey.x963Representation == d.subdata(in: 32..<97) else { throw GendragoonError.invalid("identity public key does not match") }
        key = k
    }

    /// Keep it secret.
    public func privateBytes() -> Data { key.rawRepresentation + pub }
    /// The shareable recipient id.
    public var publicId: String { Identity.prefix + Bytes.b64u(pub) }
    public var description: String { "Identity(\(publicId))" }

    func shared(_ peer: Data) throws -> Data {
        guard let pk = try? P256.KeyAgreement.PublicKey(x963Representation: peer) else { throw GendragoonError.corrupt }
        return try key.sharedSecretFromKeyAgreement(with: pk).withUnsafeBytes { Data($0) }
    }

    static func parse(_ id: String) throws -> Data {
        guard id.hasPrefix(prefix), let raw = try? Bytes.fromB64u(String(id.dropFirst(prefix.count))), raw.count == 65, raw.first == 4 else {
            throw GendragoonError.invalid("not a recipient id")
        }
        return raw
    }
}

/// The encrypted envelope a sender gives a recipient (JSON).
public struct Share: Sendable, Equatable {
    public var v = 1
    public var alg: String, recipient: String, epk: String, nonce: String, ct: String
    public func toJSON() -> String {
        JV.obj([("v", .int(Int64(v))), ("alg", .str(alg)), ("recipient", .str(recipient)), ("epk", .str(epk)), ("nonce", .str(nonce)), ("ct", .str(ct))]).text
    }
    public static func fromJSON(_ s: String) throws -> Share {
        let d = try parseObject(Data(s.utf8))
        return Share(v: Int(d.l("v")), alg: d.s("alg"), recipient: d.s("recipient"), epk: d.s("epk"), nonce: d.s("nonce"), ct: d.s("ct"))
    }
}

public struct SharedFile: Sendable { public var path: String; public var entry: FileEntry }

public struct ReadKey: Sendable { public var keyId: String, label: String, expiresAt: String; public var apiKey: String?; public var revoked: Bool }

/// Sharing one file with a recipient (ECDH P-256 + HKDF-SHA256 + AES-256-GCM, sdk/spec/FORMATS.md) and the
/// read-only keys a recipient uses to fetch its chunks.
public enum Sharing {
    static let alg = "ECDH-P256+HKDF-SHA256+A256GCM"
    static let aad = Data("gd-share-v1".utf8)
    static func tag(_ rpk: Data) -> String { Bytes.b64u(Bytes.sha256(rpk).prefix(8)) }

    static func seal(_ rpk: Data, _ payload: Data, ephemeral: Identity? = nil, nonce: Data? = nil) throws -> Share {
        let eph = ephemeral ?? Identity(key: P256.KeyAgreement.PrivateKey())
        let nonce = nonce ?? Bytes.random(GDCrypto.nonceBytes)
        let key = GDCrypto.hkdf(try eph.shared(rpk), eph.pub + rpk, "gendragoon-sdk/v1/share")
        return Share(alg: alg, recipient: tag(rpk), epk: Bytes.b64u(eph.pub), nonce: Bytes.b64u(nonce), ct: Bytes.b64u(try GDCrypto.seal(key, nonce, payload, aad)))
    }

    static func payload(_ path: String, _ e: FileEntry) -> Data { JV.obj([("v", .int(1)), ("path", .str(path)), ("entry", e.json)]).data }

    /// Encrypts one file of an encrypted drive to a recipient. Level L3, risk sharing.
    public static func export(_ c: Client, drive d: Drive, path: String, to recipient: String) async throws -> Share {
        try c.check("share.export")
        guard d.encrypted else { throw GendragoonError.invalid("plain drives have nothing to share; give the reader access to the binding instead") }
        let rpk = try Identity.parse(recipient)
        guard let e = try await d.load().0.files[path] else { throw Drive.notFound }
        return try seal(rpk, payload(path, e))
    }

    /// Decrypts a share with the recipient's identity (no network).
    public static func openEnvelope(_ id: Identity, _ s: Share) throws -> SharedFile {
        guard s.v == 1, s.alg == alg else { throw GendragoonError.invalid("unsupported share") }
        guard s.recipient == tag(id.pub) else { throw GendragoonError.invalid("this share is addressed to someone else") }
        guard let epk = try? Bytes.fromB64u(s.epk), let n = try? Bytes.fromB64u(s.nonce), let ct = try? Bytes.fromB64u(s.ct) else { throw GendragoonError.corrupt }
        let key = GDCrypto.hkdf(try id.shared(epk), epk + id.pub, "gendragoon-sdk/v1/share")
        guard let pt = GDCrypto.open(key, n, ct, aad) else { throw GendragoonError.corrupt }
        let f = try parseObject(pt)
        guard f.l("v") == 1 else { throw GendragoonError.corrupt }
        return SharedFile(path: f.s("path"), entry: FileEntry(json: f.o("entry")))
    }

    /// Decrypts a share and downloads the file (read access to the sender's binding). Level L2, risk read.
    public static func open(_ c: Client, identity: Identity, _ s: Share) async throws -> (file: SharedFile, data: Data) {
        try c.check("share.open")
        let f = try openEnvelope(identity, s)
        return (f, try await Drive.readEntry(c, f.entry))
    }

    /// Mints a read-only key for this binding (1 to 90 days). It cannot write, mint keys or read the key envelope.
    /// Level L3, risk sharing.
    public static func createReadKey(_ c: Client, label: String, ttlDays: Int = 30) async throws -> ReadKey {
        let body = JV.obj([("label", .str(label)), ("ttlDays", .int(Int64(ttlDays)))]).data
        let d = try await c.request("share.createReadKey", "POST", "/keys", body: body, headers: ["Content-Type": "application/json"]).obj()
        guard Client.isApiKey(d.s("apiKey")) else { throw GendragoonError.invalid("unexpected key response") }
        return ReadKey(keyId: d.s("keyId"), label: d.s("label"), expiresAt: d.s("expiresAt"), apiKey: d.s("apiKey"), revoked: false)
    }

    /// This binding's read-only keys (never their secrets). Level L2, risk read.
    public static func listReadKeys(_ c: Client) async throws -> [ReadKey] {
        try await c.request("share.listReadKeys", "GET", "/keys").obj().a("keys").compactMap { $0 as? JObj }.map {
            ReadKey(keyId: $0.s("keyId"), label: $0.s("label"), expiresAt: $0.s("expiresAt"), apiKey: $0.os("apiKey"), revoked: $0.b("revoked"))
        }
    }

    /// Revokes a read-only key at once. Level L3, risk sharing.
    public static func revokeReadKey(_ c: Client, keyId: String) async throws {
        guard keyId.range(of: "^[0-9a-f]{16}$", options: .regularExpression) != nil else { throw GendragoonError.invalid("malformed key id") }
        _ = try await c.request("share.revokeReadKey", "DELETE", "/keys/" + keyId)
    }
}
