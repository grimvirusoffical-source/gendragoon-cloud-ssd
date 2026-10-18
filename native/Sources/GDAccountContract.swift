import Foundation

/// Server failures put the code in `error` and sometimes also in `code`.
/// Readers take `error` first.
enum GDServerCode {
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
    case failed(String)
    case hold(String)
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

struct GDUnauthorizedDeletion: Equatable {
    var wipe: Bool
    var showSignIn: Bool
    var keepSavedJob: Bool
    var retryDelete: Bool
}

enum GDAccountContract {
    static let statusPrefix = "/v2/account/deletions/"
    static let freshSeconds: TimeInterval = 5 * 60
    static let confirmBody: [String: String] = ["confirm": "DELETE"]

    static func interpretStart(status: Int, json: [String: Any]) -> GDAccountDecision {
        if status == 401 {
            return .reauthenticate(code: errorCode(json))
        }
        if status == 410 {
            guard GDServerCode.read(json) == "account_deleted",
                  let saved = savedJob(json) else {
                return .hold("Account deletion did not return a job. Local keys and caches were kept.")
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
            return .hold("Account deletion did not return a job. Local keys and caches were kept.")
        }
        return .poll(jobId: saved.jobId, statusToken: saved.statusToken)
    }

    static func interpretPoll(status: Int, json: [String: Any]) -> GDAccountDecision {
        if status == 401 {
            return .reauthenticate(code: errorCode(json))
        }
        guard status == 200 else {
            return .hold("Account deletion status could not be read. Local keys and caches were kept.")
        }
        // The contract field is `status`. A legacy `state` value is not a result.
        guard let reported = json["status"] as? String, !reported.isEmpty else {
            return .failed("Account deletion returned an unknown status. Local keys and caches were kept.")
        }
        let retryable = (json["retryable"] as? Bool) ?? (json["retryable"] as? NSNumber)?.boolValue ?? false
        switch reported {
        case "done":
            return .wipe
        case "failed":
            let message = (json["failure"] as? String) ?? (json["message"] as? String) ?? "Account deletion did not finish."
            return .failed(String(message.prefix(200)))
        case "queued", "running":
            return .polling(status: reported, retryable: retryable)
        case "completed":
            return .failed("Account deletion returned an unknown status. Local keys and caches were kept.")
        default:
            return .failed("Account deletion returned an unknown status. Local keys and caches were kept.")
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

    /// 401 never wipes. `invalid_token` and `reauth_required` both return to sign-in.
    /// A saved job stays in the Keychain. DELETE is retried only when nothing is saved.
    static func unauthorizedDeletion(json: [String: Any], savedJobExists: Bool) -> GDUnauthorizedDeletion {
        let code = errorCode(json)
        return GDUnauthorizedDeletion(wipe: false, showSignIn: true, keepSavedJob: savedJobExists,
                                      retryDelete: code == "reauth_required" && !savedJobExists)
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

    private static func errorCode(_ json: [String: Any]) -> String {
        let code = GDServerCode.read(json)
        return code.isEmpty ? "unauthorized" : code
    }

    private static func savedJob(_ json: [String: Any]) -> (jobId: String, statusToken: String)? {
        guard let jobId = json["jobId"] as? String, isJobID(jobId),
              let statusToken = json["statusToken"] as? String, isStatusToken(statusToken) else { return nil }
        return (jobId, statusToken)
    }

    static func isJobID(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{8,80}$"#, options: .regularExpression) != nil
    }

    static func isStatusToken(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{43}$"#, options: .regularExpression) != nil
    }
}
