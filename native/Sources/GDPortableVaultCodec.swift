import Foundation
import CryptoKit
import CommonCrypto
import Security
import Darwin

struct GDPortableVaultFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// Cross-platform, account-bound envelope. It contains storage keys, never app credentials.
enum GDPortableVaultCodec {
    static let schema = "gendragoon.portable-vault/v1"
    static let payloadSchema = "gendragoon.vault-keys/v1"
    static let envelopeLimit = 16 * 1024 * 1024
    static let payloadLimit = 12 * 1024 * 1024
    static let keymapLimit = 8 * 1024 * 1024
    struct Keys: Sendable {
        let receiverId: String
        let storageSecret: String
        let keymap: Data
    }
    private static func fail(_ message: String = "The portable vault failed validation.") -> GDPortableVaultFailure {
        GDPortableVaultFailure(message: message)
    }
    static func base64(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func decode(_ raw: Any?, limit: Int) throws -> Data {
        guard let value = raw as? String, !value.isEmpty, value.utf8.count <= (limit * 4 + 2) / 3,
              value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { throw fail() }
        let padded = value.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            + String(repeating: "=", count: (4 - value.count % 4) % 4)
        guard let bytes = Data(base64Encoded: padded), bytes.count <= limit, base64(bytes) == value else { throw fail() }
        return bytes
    }
    static func validReceiver(_ value: String) -> Bool {
        value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
    static func validateKeymap(_ bytes: Data) throws {
        guard bytes.count >= 11, bytes.count <= keymapLimit, bytes.prefix(4) == Data("KXAI".utf8) else { throw fail() }
        let versions = [UInt8(1): 75, 2: 87, 3: 95]
        guard let count = versions[bytes[4]], bytes.count == count else {
            throw fail("This keymap is unsupported or bound to one device. Export a portable recovery keymap first.")
        }
        let memory = bytes[7..<11].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
        guard (1...10).contains(Int(bytes[5])), (1...16).contains(Int(bytes[6])),
              memory >= UInt32(8 * Int(bytes[6])), memory <= 256 * 1024 else { throw fail() }
    }
    private static func validate(_ value: Keys) throws {
        guard validReceiver(value.receiverId), value.storageSecret.range(of: "^[A-Za-z0-9_-]{32,128}$", options: .regularExpression) != nil else { throw fail() }
        try validateKeymap(value.keymap)
    }
    private static func key(password: String, salt: Data) throws -> SymmetricKey {
        guard password.unicodeScalars.count >= 12, password.utf8.count <= 1024 else {
            throw fail("Use a passphrase with at least 12 characters and at most 1024 UTF-8 bytes.")
        }
        var pass = Array(password.utf8), derived = [UInt8](repeating: 0, count: 32)
        defer { pass.withUnsafeMutableBytes { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) }; derived.withUnsafeMutableBytes { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) } }
        let result = pass.withUnsafeBytes { pb in salt.withUnsafeBytes { sb in derived.withUnsafeMutableBytes { kb in
            CCKeyDerivationPBKDF(CCPBKDFAlgorithm(kCCPBKDF2), pb.baseAddress!.assumingMemoryBound(to: CChar.self), pass.count,
                sb.baseAddress!.assumingMemoryBound(to: UInt8.self), salt.count, CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                600_000, kb.baseAddress!.assumingMemoryBound(to: UInt8.self), 32)
        } } }
        guard result == kCCSuccess else { throw fail("Portable vault key derivation failed.") }
        return SymmetricKey(data: derived)
    }
    private static func random(_ count: Int) throws -> Data {
        var data = Data(count: count)
        guard data.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }) == errSecSuccess else { throw fail("Secure random generation failed.") }
        return data
    }
    private static func aad(_ receiver: String) -> Data { Data((schema + "\u{0}" + receiver).utf8) }
    /// Explicit salt/nonce are internal only, for a published dummy interoperability vector.
    static func seal(_ value: Keys, password: String, salt: Data? = nil, nonce: Data? = nil) throws -> Data {
        try validate(value)
        let salt = try salt ?? random(16), nonce = try nonce ?? random(12)
        guard salt.count == 16, nonce.count == 12 else { throw fail() }
        var payload = try JSONSerialization.data(withJSONObject: ["schema": payloadSchema, "receiverId": value.receiverId,
            "storageSecret": value.storageSecret, "keymap": base64(value.keymap)], options: [.sortedKeys, .withoutEscapingSlashes])
        defer { payload.resetBytes(in: 0..<payload.count) }
        guard payload.count <= payloadLimit else { throw fail() }
        let box = try AES.GCM.seal(payload, using: key(password: password, salt: salt), nonce: AES.GCM.Nonce(data: nonce), authenticating: aad(value.receiverId))
        return try JSONSerialization.data(withJSONObject: ["schema": schema, "receiverId": value.receiverId,
            "kdf": ["name": "PBKDF2-HMAC-SHA256", "iterations": 600_000, "salt": base64(salt)],
            "cipher": ["name": "AES-256-GCM", "nonce": base64(nonce)],
            "ciphertext": base64(box.ciphertext + box.tag)], options: [.sortedKeys, .withoutEscapingSlashes])
    }
    static func open(_ envelope: Data, password: String, expectedReceiver: String) throws -> Keys {
        guard validReceiver(expectedReceiver), envelope.count <= envelopeLimit,
              let value = try JSONSerialization.jsonObject(with: envelope) as? [String: Any],
              Set(value.keys) == Set(["schema", "receiverId", "kdf", "cipher", "ciphertext"]),
              value["schema"] as? String == schema, value["receiverId"] as? String == expectedReceiver,
              let kdf = value["kdf"] as? [String: Any], Set(kdf.keys) == Set(["name", "iterations", "salt"]),
              kdf["name"] as? String == "PBKDF2-HMAC-SHA256", let iterations = kdf["iterations"] as? NSNumber,
              CFGetTypeID(iterations) != CFBooleanGetTypeID(), iterations.doubleValue == 600_000,
              let cipher = value["cipher"] as? [String: Any], Set(cipher.keys) == Set(["name", "nonce"]),
              cipher["name"] as? String == "AES-256-GCM" else { throw fail("The portable vault belongs to another account or uses an unsupported format.") }
        let salt = try decode(kdf["salt"], limit: 16), nonce = try decode(cipher["nonce"], limit: 12)
        let encrypted = try decode(value["ciphertext"], limit: payloadLimit + 16)
        guard salt.count == 16, nonce.count == 12, encrypted.count > 16 else { throw fail() }
        let box = try AES.GCM.SealedBox(nonce: AES.GCM.Nonce(data: nonce), ciphertext: encrypted.dropLast(16), tag: encrypted.suffix(16))
        var payload: Data
        do { payload = try AES.GCM.open(box, using: key(password: password, salt: salt), authenticating: aad(expectedReceiver)) }
        catch { throw fail("The passphrase is incorrect or the portable vault was changed.") }
        defer { payload.resetBytes(in: 0..<payload.count) }
        guard payload.count <= payloadLimit, let keys = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
              Set(keys.keys) == Set(["schema", "receiverId", "storageSecret", "keymap"]),
              keys["schema"] as? String == payloadSchema, keys["receiverId"] as? String == expectedReceiver,
              let secret = keys["storageSecret"] as? String else { throw fail() }
        let result = Keys(receiverId: expectedReceiver, storageSecret: secret, keymap: try decode(keys["keymap"], limit: keymapLimit))
        try validate(result)
        return result
    }
}

/// Private encrypted keymap IO. Import never replaces an existing file or follows a symlink.
enum GDPortableVaultFiles {
    static func read(_ url: URL, limit: Int = GDPortableVaultCodec.keymapLimit) throws -> Data {
        let fd = Darwin.open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard fd >= 0 else { throw GDPortableVaultFailure(message: "The selected key file is unavailable or unsafe.") }
        defer { Darwin.close(fd) }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & 0o077 == 0, info.st_size > 0, info.st_size <= limit else {
            throw GDPortableVaultFailure(message: "The key file must be a private regular file owned by this user.")
        }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        let bytes = try handle.read(upToCount: limit + 1) ?? Data()
        guard bytes.count == info.st_size, bytes.count <= limit else { throw GDPortableVaultFailure(message: "The key file changed while it was being read.") }
        return bytes
    }
    static func create(_ bytes: Data, at url: URL) throws {
        let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw GDPortableVaultFailure(message: "A keymap already exists. Existing keys will not be replaced.") }
        var successful = false
        defer { Darwin.close(fd); if !successful { Darwin.unlink(url.path) } }
        let handle = FileHandle(fileDescriptor: fd, closeOnDealloc: false)
        try handle.write(contentsOf: bytes)
        guard fsync(fd) == 0 else { throw GDPortableVaultFailure(message: "The keymap could not be saved durably.") }
        successful = true
    }
    static func removeIfIdentical(_ bytes: Data, at url: URL) {
        guard let existing = try? read(url), existing == bytes else { return }
        _ = Darwin.unlink(url.path)
    }
}
