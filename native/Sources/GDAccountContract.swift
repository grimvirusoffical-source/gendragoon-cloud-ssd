import Foundation

/// Server failures put the code in `error` and sometimes also in `code`.
/// Readers take `error` first.
enum GDServerCode {
    /// `error` wins whenever it is a non-empty string. The value is not pattern-matched:
    /// uppercase codes such as `PROJECT_NOT_FOUND` are valid. An empty `error` falls through to `code`.
    static func read(_ json: [String: Any]) -> String {
        if let error = text(json["error"]) { return error }
        if let code = text(json["code"]) { return code }
        return ""
    }

    private static func text(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

/// Pure account-deletion decisions. Riley's PR #6 bodies are the wire format.
/// A 202 and a 410 `account_deleted` both carry `jobId` and `statusToken`.
/// Status polls return `{jobId,status,retryable}` and are read from `status`.
enum GDAccountDecision: Equatable {
    case reauthenticate(code: String)
    case poll(jobId: String, statusToken: String)
    case polling(status: String, retryable: Bool)
    case wipe
    /// `retryable` is the server flag. A retryable failure keeps the job and offers Retry.
    case failed(String, retryable: Bool)
    case hold(String)
    /// A 202 or 410 arrived without a usable token. Retry may be offered. DELETE must not be sent again.
    case retryWithoutDelete(String)
    /// A 404 while polling. The saved job stays until `done` or the user dismisses it.
    case notFound(String)
}

struct GDPollRecovery: Equatable {
    var wipe: Bool
    var keepSavedJob: Bool
    var showRetry: Bool
    var allowDismiss: Bool
    var sendDelete: Bool
}

enum GDSignInAdoption: Equatable {
    case adopt(uid: String)
    case reject(String)
}

enum GDReauthFollowUp: Equatable {
    case promptAgain(String)
    case retryDelete
    case resume
}

struct GDDeletionJobRef: Equatable {
    var jobId: String
    var statusToken: String
}

enum GDDeletionIntent: Equatable {
    case pollSaved(GDDeletionJobRef)
    case sendDelete
}

enum GDDeletionCredential: Equatable {
    /// DELETE /v2/account, authorized with the owner's Firebase token.
    case firebase
    /// GET /v2/account/deletions/:jobId, authorized with the saved statusToken.
    case statusToken
}

/// Both auth failures share this callback.
/// `signed_out` is a Firebase-token `invalid_token`. `reauth_required` is a status-token `invalid_token`.
enum GDDeletionAuthFailure: Equatable {
    case signedOut
    case reauthRequired

    var signal: String {
        switch self {
        case .signedOut: return "signed_out"
        case .reauthRequired: return "reauth_required"
        }
    }
}

struct GDUnauthorizedDeletion: Equatable {
    var wipe: Bool
    var showSignIn: Bool
    var keepSavedJob: Bool
    var retryDelete: Bool
    /// Clear only the session. The saved job and its status token stay.
    var signOut: Bool
    /// Keep polling with the saved status token so `done` can wipe without a relaunch.
    var keepPolling: Bool
    /// Set only for the two `invalid_token` cases. Other 401s leave this nil.
    var signal: GDDeletionAuthFailure?
}

/// Raised from a 409 `deletion_not_retryable`. The job id is the one in that body.
struct GDDeletionNotRetryable: Error, Equatable {
    var jobId: String
}

enum GDAccountContract {
    static let statusPrefix = "/v2/account/deletions/"
    static let freshSeconds: TimeInterval = 5 * 60
    static let confirmBody: [String: String] = ["confirm": "DELETE"]

    static func interpretStart(status: Int, json: [String: Any]) -> GDAccountDecision {
        if status == 401 {
            return .reauthenticate(code: errorCode(json))
        }
        if status == 404 {
            return .notFound("This deletion could not be found. Local keys and caches were kept.")
        }
        if status == 413 {
            return .hold("Account deletion was rejected because the request was too large. Local keys and caches were kept.")
        }
        if status == 410 {
            guard GDServerCode.read(json) == "account_deleted" else {
                return .hold("Account deletion did not return a job. Local keys and caches were kept.")
            }
            guard let saved = savedJob(json) else {
                return .retryWithoutDelete("Account deletion did not return a usable status token. Retry the status check. Local keys and caches were kept.")
            }
            return .poll(jobId: saved.jobId, statusToken: saved.statusToken)
        }
        guard status == 202 else {
            return .hold("Account deletion did not start. Local keys and caches were kept.")
        }
        if let suggested = json["statusPath"] as? String, !suggested.hasPrefix(statusPrefix) || suggested.contains("..") {
            return .hold("Account deletion status path is invalid. Local keys and caches were kept.")
        }
        guard let saved = savedJob(json) else {
            return .retryWithoutDelete("Account deletion did not return a usable status token. Retry the status check. Local keys and caches were kept.")
        }
        return .poll(jobId: saved.jobId, statusToken: saved.statusToken)
    }

    static func interpretPoll(status: Int, json: [String: Any]) -> GDAccountDecision {
        if status == 401 {
            return .reauthenticate(code: errorCode(json))
        }
        if status == 404 {
            return .notFound("This deletion could not be found. Sign in again to retry it. Local keys and caches were kept.")
        }
        guard status == 200 else {
            return .hold("Account deletion status could not be read. Local keys and caches were kept.")
        }
        // The contract field is `status`. A legacy `state` value is not a result.
        guard let reported = json["status"] as? String, !reported.isEmpty else {
            return .failed("Account deletion returned an unknown status. Local keys and caches were kept.", retryable: false)
        }
        let retryable = (json["retryable"] as? Bool) ?? (json["retryable"] as? NSNumber)?.boolValue ?? false
        switch reported {
        case "done":
            return .wipe
        case "failed":
            let message = (json["failure"] as? String) ?? (json["message"] as? String) ?? "Account deletion did not finish."
            return .failed(String(message.prefix(200)), retryable: retryable)
        case "queued", "running":
            return .polling(status: reported, retryable: retryable)
        case "completed":
            return .failed("Account deletion returned an unknown status. Local keys and caches were kept.", retryable: false)
        default:
            return .failed("Account deletion returned an unknown status. Local keys and caches were kept.", retryable: false)
        }
    }

    static func pollRequest(jobId: String, statusToken: String) -> (method: String, path: String, authorization: String) {
        ("GET", statusPrefix + jobId, "Bearer " + statusToken)
    }

    static func authTime(jwt: String) -> TimeInterval? {
        let parts = jwt.split(separator: ".")
        guard parts.count >= 2 else { return nil }
        var payload = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let remainder = payload.count % 4
        if remainder != 0 { payload += String(repeating: "=", count: 4 - remainder) }
        guard let data = Data(base64Encoded: payload),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        if let number = object["auth_time"] as? TimeInterval { return number }
        if let number = object["auth_time"] as? Int { return TimeInterval(number) }
        if let number = object["auth_time"] as? NSNumber { return number.doubleValue }
        return nil
    }

    /// A saved job is only polled. A new DELETE cancels the token that was saved.
    static func deletionIntent(savedJobId: String?, savedStatusToken: String?) -> GDDeletionIntent {
        if let savedJobId, let savedStatusToken, isJobID(savedJobId), isStatusToken(savedStatusToken) {
            return .pollSaved(GDDeletionJobRef(jobId: savedJobId, statusToken: savedStatusToken))
        }
        return .sendDelete
    }

    static let deletionNotRetryableMessage = "This deletion can't be retried. Contact GenDragoon support. Dismiss it when you no longer want to watch the job. Local keys and caches were kept."

    /// 401 never wipes.
    /// Only a Firebase `invalid_token` sends `signed_out`. The session is cleared, the job stays,
    /// and polling continues with the saved status token until `done` wipes.
    /// A status GET `invalid_token`, `unauthorized`, or a 401 with no code sends `reauth_required`.
    /// That stops the poll, keeps the job, and asks for sign-in.
    /// After that sign-in, DELETE is sent again so the 410 can supply a fresh status token.
    static func unauthorizedDeletion(json: [String: Any], savedJobExists: Bool, credential: GDDeletionCredential = .firebase) -> GDUnauthorizedDeletion {
        let code = errorCode(json)
        if credential == .statusToken {
            let reauth = code == "invalid_token" || code == "unauthorized" || GDServerCode.read(json).isEmpty
            return GDUnauthorizedDeletion(wipe: false, showSignIn: true, keepSavedJob: savedJobExists,
                                          retryDelete: savedJobExists, signOut: false, keepPolling: false,
                                          signal: reauth ? .reauthRequired : nil)
        }
        switch code {
        case "invalid_token":
            return GDUnauthorizedDeletion(wipe: false, showSignIn: false, keepSavedJob: savedJobExists,
                                          retryDelete: false, signOut: true, keepPolling: savedJobExists,
                                          signal: .signedOut)
        case "reauth_required":
            return GDUnauthorizedDeletion(wipe: false, showSignIn: true, keepSavedJob: savedJobExists,
                                          retryDelete: !savedJobExists, signOut: false, keepPolling: savedJobExists,
                                          signal: nil)
        default:
            return GDUnauthorizedDeletion(wipe: false, showSignIn: true, keepSavedJob: savedJobExists,
                                          retryDelete: false, signOut: false, keepPolling: savedJobExists,
                                          signal: nil)
        }
    }

    /// A 409 `deletion_not_retryable` raises `GDDeletionNotRetryable` with the body's `jobId`.
    /// Any other status returns without throwing.
    static func deletionNotRetryable(status: Int, json: [String: Any]) throws {
        guard status == 409, GDServerCode.read(json) == "deletion_not_retryable" else { return }
        let jobId = (json["jobId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        throw GDDeletionNotRetryable(jobId: jobId)
    }

    static func reauthFollowUp(expectedUID: String, signedInUID: String, authTime: TimeInterval?, now: TimeInterval, freshSeconds: TimeInterval, retryDelete: Bool) -> GDReauthFollowUp {
        if expectedUID.isEmpty || signedInUID != expectedUID {
            return .promptAgain("Sign in again with the same account. Local keys and caches were kept.")
        }
        guard let authTime, now - authTime >= 0, now - authTime < freshSeconds else {
            return .promptAgain("Sign in again. Account deletion needs a sign-in from the last 5 minutes.")
        }
        return retryDelete ? .retryDelete : .resume
    }

    /// A 401 with no `error` still returns to sign-in. Nothing is wiped, and a saved job stays.
    static func unauthorizedMessage(json: [String: Any]) -> String {
        if GDServerCode.read(json) == "reauth_required" {
            return "Sign in again. Account deletion needs a sign-in from the last 5 minutes."
        }
        return "Sign in again. Local keys and caches were kept."
    }

    static func pollRecovery(for decision: GDAccountDecision) -> GDPollRecovery {
        switch decision {
        case .notFound:
            return GDPollRecovery(wipe: false, keepSavedJob: true, showRetry: true, allowDismiss: false, sendDelete: true)
        case .wipe:
            return GDPollRecovery(wipe: true, keepSavedJob: false, showRetry: false, allowDismiss: false, sendDelete: false)
        case .failed(_, true):
            return GDPollRecovery(wipe: false, keepSavedJob: true, showRetry: true, allowDismiss: false, sendDelete: true)
        case .failed:
            return GDPollRecovery(wipe: false, keepSavedJob: true, showRetry: false, allowDismiss: true, sendDelete: false)
        case .retryWithoutDelete:
            return GDPollRecovery(wipe: false, keepSavedJob: false, showRetry: true, allowDismiss: true, sendDelete: false)
        case .reauthenticate, .poll, .polling, .hold:
            return GDPollRecovery(wipe: false, keepSavedJob: true, showRetry: false, allowDismiss: false, sendDelete: false)
        }
    }

    /// Dismiss clears the saved job. It does not wipe the Mac and it does not send DELETE.
    static func dismissRecovery() -> GDPollRecovery {
        GDPollRecovery(wipe: false, keepSavedJob: false, showRetry: false, allowDismiss: false, sendDelete: false)
    }

    /// Switch the session only for the account that is already signed in, and for the account that started a saved job.
    /// `currentUID` is captured before logout, so the check runs even when no deletion has been saved yet.
    static func adoptSignIn(incomingUID: String, savedOwnerUID: String?, currentUID: String? = nil) -> GDSignInAdoption {
        let incoming = incomingUID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !incoming.isEmpty else {
            return .reject("Sign in again with the same account. Local keys and caches were kept.")
        }
        let current = currentUID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !current.isEmpty && current != incoming {
            return .reject("Sign in again with the same account. Local keys and caches were kept.")
        }
        let saved = savedOwnerUID?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !saved.isEmpty && saved != incoming {
            return .reject("Sign in again with the account that started this deletion. Local keys and caches were kept.")
        }
        return .adopt(uid: incoming)
    }

    /// A resumed deletion keeps the account that started it, even if a later sign-in differs.
    static func retainedDeletionOwner(savedOwnerUID: String, incomingUID: String) -> String {
        let saved = savedOwnerUID.trimmingCharacters(in: .whitespacesAndNewlines)
        if !saved.isEmpty { return saved }
        return incomingUID.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func errorCode(_ json: [String: Any]) -> String {
        let code = GDServerCode.read(json)
        return code.isEmpty ? "unauthorized" : code
    }

    private static func savedJob(_ json: [String: Any]) -> (jobId: String, statusToken: String)? {
        guard let jobId = json["jobId"] as? String, isJobID(jobId),
              let statusToken = json["statusToken"] as? String, isStatusToken(statusToken) else { return nil }
        return (jobId, statusToken)
    }

    /// `jobId` and `statusToken` are opaque. The only check is that the value is non-empty.
    static func isJobID(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    static func isStatusToken(_ value: String) -> Bool {
        !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
