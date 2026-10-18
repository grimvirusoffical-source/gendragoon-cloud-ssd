import Foundation

enum GDKeyEnvelopeError: Error, Equatable {
    case message(String)
}

struct GDKeyEnvelopeKDF: Codable, Equatable {
    var alg: String
    var memoryKiB: Int
    var iterations: Int
    var parallelism: Int
}

/// The only wire shape for a workspace key envelope.
/// `{version, kdf:{alg, memoryKiB, iterations, parallelism}, salt, iv, wrappedKey}`
struct GDKeyEnvelopeWire: Codable, Equatable {
    var version: Int
    var kdf: GDKeyEnvelopeKDF
    var salt: String
    var iv: String
    var wrappedKey: String
}

enum GDKeyEnvelopeFollowUp: Equatable {
    /// 201, or a 409 whose fetched envelope has been unwrapped. The workspace key may be cached.
    case saveUnwrappedKey
    /// 409 envelope_exists. GET the envelope and unwrap it. Do not mint a new key and do not PUT over it.
    case fetchAndUnwrapExisting
    /// 412 version_mismatch. GET again and re-apply the change to the same workspace key.
    case refetchAndRewrapSameKey
    case showError(String)
}

enum GDKeyEnvelopeContract {
    static let maxMemoryKiB = 1_048_576
    static let maxIterations = 10

    static func createHeaders() -> [String: String] { ["If-None-Match": "*"] }

    static func updateHeaders(version: Int) -> [String: String] { ["If-Match": "\"\(version)\""] }

    static func encode(_ wire: GDKeyEnvelopeWire) throws -> Data {
        try validate(wire)
        let object: [String: Any] = [
            "version": wire.version,
            "kdf": [
                "alg": wire.kdf.alg,
                "memoryKiB": wire.kdf.memoryKiB,
                "iterations": wire.kdf.iterations,
                "parallelism": wire.kdf.parallelism,
            ],
            "salt": wire.salt,
            "iv": wire.iv,
            "wrappedKey": wire.wrappedKey,
        ]
        return try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
    }

    static func decode(_ data: Data) throws -> GDKeyEnvelopeWire {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
        return try decode(object)
    }

    static func decode(_ object: [String: Any]) throws -> GDKeyEnvelopeWire {
        if object["opsLimit"] != nil || object["memLimit"] != nil || object["kdfParams"] != nil {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
        guard let version = object["version"] as? Int ?? (object["version"] as? NSNumber)?.intValue,
              let kdf = object["kdf"] as? [String: Any],
              let alg = kdf["alg"] as? String,
              let memory = kdf["memoryKiB"] as? Int ?? (kdf["memoryKiB"] as? NSNumber)?.intValue,
              let iterations = kdf["iterations"] as? Int ?? (kdf["iterations"] as? NSNumber)?.intValue,
              let parallelism = kdf["parallelism"] as? Int ?? (kdf["parallelism"] as? NSNumber)?.intValue,
              let salt = object["salt"] as? String,
              let iv = object["iv"] as? String,
              let wrappedKey = object["wrappedKey"] as? String else {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
        let wire = GDKeyEnvelopeWire(version: version, kdf: GDKeyEnvelopeKDF(alg: alg, memoryKiB: memory, iterations: iterations, parallelism: parallelism), salt: salt, iv: iv, wrappedKey: wrappedKey)
        try validate(wire)
        return wire
    }

    static func validate(_ wire: GDKeyEnvelopeWire) throws {
        guard wire.version >= 1, wire.kdf.alg == "argon2id" else {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
        guard wire.kdf.parallelism >= 1 else {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
        guard wire.kdf.memoryKiB >= 1, wire.kdf.memoryKiB <= maxMemoryKiB else {
            throw GDKeyEnvelopeError.message("Those passphrase settings are too expensive for this Mac.")
        }
        guard wire.kdf.iterations >= 1, wire.kdf.iterations <= maxIterations else {
            throw GDKeyEnvelopeError.message("Those passphrase settings are too expensive for this Mac.")
        }
        guard let salt = GDBase64URL.decode(wire.salt), (16...64).contains(salt.count),
              let iv = GDBase64URL.decode(wire.iv), (12...32).contains(iv.count),
              GDBase64URL.decode(wire.wrappedKey) != nil else {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
    }

    static func followUp(status: Int, json: [String: Any]) -> GDKeyEnvelopeFollowUp {
        let code = GDServerCode.read(json)
        switch (status, code) {
        case (201, _), (200, _):
            return .saveUnwrappedKey
        case (409, "envelope_exists"):
            return .fetchAndUnwrapExisting
        case (412, "version_mismatch"):
            return .refetchAndRewrapSameKey
        case (413, "payload_too_large"):
            return .showError("The workspace key envelope is too large.")
        case (422, "kdf_params_invalid"):
            return .showError("Those passphrase settings are too expensive for this Mac.")
        case (422, "envelope_invalid"):
            return .showError("The workspace key envelope is not valid.")
        default:
            return .showError("The workspace key envelope could not be saved.")
        }
    }

    /// A local cache is written only after 201, or after a 409 envelope has been unwrapped.
    static func mayCacheLocally(after followUp: GDKeyEnvelopeFollowUp, unwrappedExisting: Bool) -> Bool {
        switch followUp {
        case .saveUnwrappedKey: return true
        case .fetchAndUnwrapExisting: return unwrappedExisting
        case .refetchAndRewrapSameKey, .showError: return false
        }
    }
}

enum GDBase64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ text: String) -> Data? {
        var encoded = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = encoded.count % 4
        if remainder != 0 { encoded += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: encoded)
    }
}
