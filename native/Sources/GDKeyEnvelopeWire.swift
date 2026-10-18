import Foundation

enum GDKeyEnvelopeError: Error, Equatable {
    case message(String)
}

struct GDKeyEnvelopeKDF: Codable, Equatable {
    var alg: String
    var memoryKiB: Int
    var iterations: Int
    var parallelism: Int
    /// scrypt CPU/memory cost. Absent for argon2id.
    var n: Int?
    var r: Int?
    var p: Int?

    enum CodingKeys: String, CodingKey {
        case alg, memoryKiB, iterations, parallelism, r, p
        case n = "N"
    }

    init(alg: String, memoryKiB: Int = 0, iterations: Int = 0, parallelism: Int = 0, n: Int? = nil, r: Int? = nil, p: Int? = nil) {
        self.alg = alg
        self.memoryKiB = memoryKiB
        self.iterations = iterations
        self.parallelism = parallelism
        self.n = n
        self.r = r
        self.p = p
    }
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
        let salt = try canonical(wire.salt)
        let iv = try canonical(wire.iv)
        let wrappedKey = try canonical(wire.wrappedKey)
        var writing = wire
        writing.salt = salt
        writing.iv = iv
        writing.wrappedKey = wrappedKey
        try validate(writing)
        let kdf: [String: Any]
        if writing.kdf.alg == "scrypt" {
            var scrypt: [String: Any] = ["alg": "scrypt", "N": writing.kdf.n ?? 0]
            if let r = writing.kdf.r { scrypt["r"] = r }
            if let p = writing.kdf.p { scrypt["p"] = p }
            kdf = scrypt
        } else {
            kdf = [
                "alg": writing.kdf.alg,
                "memoryKiB": writing.kdf.memoryKiB,
                "iterations": writing.kdf.iterations,
                "parallelism": writing.kdf.parallelism,
            ]
        }
        let object: [String: Any] = [
            "version": writing.version,
            "kdf": kdf,
            "salt": salt,
            "iv": iv,
            "wrappedKey": wrappedKey,
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
        guard let version = Self.intValue(object["version"]),
              let kdf = object["kdf"] as? [String: Any],
              let alg = kdf["alg"] as? String,
              let salt = object["salt"] as? String,
              let iv = object["iv"] as? String,
              let wrappedKey = object["wrappedKey"] as? String else {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
        let params: GDKeyEnvelopeKDF
        if alg == "scrypt" {
            guard let n = intValue(kdf["N"]) else {
                throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
            }
            params = GDKeyEnvelopeKDF(alg: alg, n: n, r: intValue(kdf["r"]), p: intValue(kdf["p"]))
        } else {
            guard let memory = intValue(kdf["memoryKiB"]),
                  let iterations = intValue(kdf["iterations"]),
                  let parallelism = intValue(kdf["parallelism"]) else {
                throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
            }
            params = GDKeyEnvelopeKDF(alg: alg, memoryKiB: memory, iterations: iterations, parallelism: parallelism)
        }
        let wire = GDKeyEnvelopeWire(version: version, kdf: params, salt: salt, iv: iv, wrappedKey: wrappedKey)
        try validate(wire)
        return wire
    }

    static func validate(_ wire: GDKeyEnvelopeWire) throws {
        guard wire.version >= 1 else {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
        if wire.kdf.alg == "scrypt" {
            guard let n = wire.kdf.n, (1 << 14)...(1 << 20) ~= n, (n & (n - 1)) == 0 else {
                throw GDKeyEnvelopeError.message("Those passphrase settings are too expensive for this Mac.")
            }
        } else {
            guard wire.kdf.alg == "argon2id" else {
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
        }
        guard let salt = GDBase64URL.decode(wire.salt), (16...64).contains(salt.count),
              let iv = GDBase64URL.decode(wire.iv), (12...32).contains(iv.count),
              GDBase64URL.decode(wire.wrappedKey) != nil else {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
    }

    /// Salt, iv, and wrappedKey are stored as unpadded base64url whichever input alphabet arrived.
    static func canonical(_ text: String) throws -> String {
        guard let data = GDBase64URL.decode(text) else {
            throw GDKeyEnvelopeError.message("The workspace key envelope is not valid.")
        }
        return GDBase64URL.encode(data)
    }

    private static func intValue(_ value: Any?) -> Int? {
        if let number = value as? Int { return number }
        if let number = value as? NSNumber { return number.intValue }
        return nil
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

    /// Accepts standard base64 or unpadded base64url. Rejects a string that does not round-trip.
    static func decode(_ text: String) -> Data? {
        if text.isEmpty || text.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) }) {
            return nil
        }
        let url = text.replacingOccurrences(of: "=", with: "")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
        let alphabet = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
        guard url.unicodeScalars.allSatisfy({ alphabet.contains($0) }) else { return nil }
        let remainder = url.count % 4
        if remainder == 1 { return nil }
        var padded = url
        if remainder != 0 { padded += String(repeating: "=", count: 4 - remainder) }
        let standard = padded.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        guard let data = Data(base64Encoded: standard), encode(data) == url else { return nil }
        return data
    }
}
