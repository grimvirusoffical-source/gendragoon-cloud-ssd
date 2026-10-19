import Foundation

/// The unlocked master key, held in memory only.
public final class Keyring: CustomStringConvertible, @unchecked Sendable {
    let client: Client
    private let lock = NSLock()
    private var mk: Data?

    public init(_ client: Client) { self.client = client }
    public var unlocked: Bool { lock.lock(); defer { lock.unlock() }; return mk != nil }
    public var description: String { "Keyring(unlocked=\(unlocked))" }

    /// Drops the master key from memory.
    public func lockKey() { set(nil) }
    func master() throws -> Data { lock.lock(); defer { lock.unlock() }; guard let k = mk else { throw GendragoonError.locked }; return k }
    var masterIfUnlocked: Data? { lock.lock(); defer { lock.unlock() }; return mk }
    private func set(_ k: Data?) {
        lock.lock()
        if mk != nil { mk!.resetBytes(in: 0..<mk!.count) }
        mk = k
        lock.unlock()
    }

    /// Reads the binding's key envelope and opens it. Level L2, risk key.
    public func unlock(_ passphrase: String) async throws {
        try client.check("crypto.unlock")
        let env = try await client.getKeyEnvelope()
        set(try GDCrypto.unwrapMasterKey(env, passphrase: passphrase))
    }

    /// Generates a master key and stores its envelope (create-only). Level L3, risk key.
    public func create(_ passphrase: String) async throws {
        try client.check("keyEnvelope.create")
        let k = Bytes.random(GDCrypto.keyBytes)
        let env = try GDCrypto.wrapMasterKey(k, passphrase: passphrase)
        do { try await client.putKeyEnvelope("keyEnvelope.create", env, ["If-None-Match": "*"]) } catch let e as APIError where e.code == "envelope_exists" {
            // The server answers 409 envelope_exists; every SDK reports it as a lost compare-and-swap.
            throw APIError(status: 412, code: "envelope_exists")
        }
        set(k)
    }

    /// Re-wraps the master key under a new passphrase (compare-and-swap on the version). Level L3, risk key.
    public func changePassphrase(_ newPassphrase: String) async throws {
        try client.check("keyEnvelope.replace")
        let k = try master()
        let cur = try await client.getKeyEnvelope()
        let env = try GDCrypto.wrapMasterKey(k, passphrase: newPassphrase, version: cur.version + 1)
        try await client.putKeyEnvelope("keyEnvelope.replace", env, ["If-Match": "\"\(cur.version)\""])
    }

    /// Loads a master key handed over by the host (for example the Rotten Apple launcher). Level L2, risk key.
    public func importMasterKey(_ key: Data) throws {
        try client.check("crypto.importMasterKey")
        guard key.count == GDCrypto.keyBytes else { throw GendragoonError.invalid("master key must be 32 bytes") }
        set(Data(key))
    }

    /// A copy of the raw master key. Level L4, risk key-export: the default gate refuses it.
    public func exportMasterKey() throws -> Data {
        try client.check("crypto.exportMasterKey")
        return Data(try master())
    }
}
