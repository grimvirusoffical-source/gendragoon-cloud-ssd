import Foundation

/// A non-2xx answer from the server.
public struct APIError: Error, CustomStringConvertible {
    public let status: Int
    public let code: String
    public let retryAfter: Int
    public init(status: Int, code: String, retryAfter: Int = 0) { self.status = status; self.code = code; self.retryAfter = retryAfter }
    public var description: String { "gendragoon: \(status) \(code)" }
    public var notFound: Bool { status == 404 }
    public var preconditionFailed: Bool { status == 412 || code == "precondition_failed" || code == "version_mismatch" }
    public var quotaExceeded: Bool { status == 507 || code == "quota_exceeded" }
    public var unauthorized: Bool { status == 401 }
    public var rateLimited: Bool { status == 429 }
}

public enum GendragoonError: Error, Equatable, CustomStringConvertible {
    /// A downloaded blob did not match its checksum.
    case checksum
    /// Data is corrupt or was encrypted with another key.
    case corrupt
    /// The recovery passphrase did not unlock the key envelope.
    case wrongPassphrase
    /// The master key is not unlocked.
    case locked
    /// The operation is not supported in this build (for example argon2id without a plug-in).
    case unsupported(String)
    /// The arguments or the state do not allow the call.
    case invalid(String)

    public var description: String {
        switch self {
        case .checksum: return "gendragoon: checksum mismatch"
        case .corrupt: return "gendragoon: data is corrupt or was encrypted with another key"
        case .wrongPassphrase: return "gendragoon: the recovery passphrase did not unlock this key"
        case .locked: return "gendragoon: master key not unlocked"
        case .unsupported(let m), .invalid(let m): return "gendragoon: " + m
        }
    }
}
