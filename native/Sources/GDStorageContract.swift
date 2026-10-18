import Foundation

enum GDStorageContractError: Error, Equatable {
    case message(String)
    var text: String {
        switch self {
        case .message(let text): return text
        }
    }
}

struct GDWorkspaceLockBody: Equatable {
    var error: String
    var reason: String
    var overBy: Int
    var unpaidWorkspaceIds: [String]
}

enum GDLockRoute: Equatable {
    case reviewWorkspaces(GDWorkspaceLockBody)
    case passthrough
}

struct GDSignedObject: Equatable {
    var object: String
    var url: URL
    var method: String
    var expiresAt: Date
}

struct GDStorageSession: Equatable {
    var mode: String
    var urls: [GDSignedObject]
}

/// PR #7 storage-urls and PR #5 workspace lock / merge / archive routes.
enum GDStorageContract {
    static let byoExternalMessage = "This workspace keeps its own keys on this Mac. Hosted storage links are not used for a bucket you connect yourself."
    static let byoUnverifiableMessage = "GenDragoon could not verify the challenge object from your bucket. Check the endpoint and keys, then run the challenge again."
    static let byoUnsupportedMessage = "This provider is not supported. Choose Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, or Google Cloud with an S3/HMAC key."
    static let plaintextKeys: Set<String> = [
        "name", "filename", "fileName", "originalName", "plaintext", "key", "encryptionKey",
        "dek", "kek", "password", "secret", "secretAccessKey", "accessKey", "accessKeyId", "privateKey",
        "content", "data",
    ]
    private static let secretKeys: Set<String> = [
        "access_token", "accessToken", "refresh_token", "refreshToken", "id_token", "idToken",
        "private_key", "privateKey", "client_secret", "clientSecret", "googleCredentials",
        "authorization", "secretAccessKey", "sessionToken",
    ]

    static func uploadBody(objectIDs: [String], ifGeneration: String? = nil) -> [String: Any] {
        var body: [String: Any] = ["op": "upload", "objects": objectIDs]
        if let ifGeneration { body["ifGeneration"] = ifGeneration }
        return body
    }

    static func downloadBody(objectIDs: [String]) -> [String: Any] {
        ["op": "download", "objects": objectIDs]
    }

    static func rejectsPlaintext(_ body: [String: Any]) -> Bool {
        body.keys.contains { plaintextKeys.contains($0) }
    }

    static func archivePath(id: String) -> String { "v2/projects/\(id)/archive" }

    static func archiveBody(confirmName: String) -> [String: Any] {
        ["confirmName": confirmName, "acknowledgeBillingContinues": true]
    }

    static func mergePath(sourceId: String) -> String { "v2/workspaces/\(sourceId)/merge" }

    static func mergePreviewPath(sourceId: String) -> String { "v2/workspaces/\(sourceId)/merge/preview" }

    static func mergeBody(targetId: String, confirmName: String) -> [String: String] {
        ["targetId": targetId, "confirmName": confirmName]
    }

    static func routeLock(status: Int, json: [String: Any]) -> GDLockRoute {
        guard status == 423, let body = parseLock(json) else { return .passthrough }
        return .reviewWorkspaces(body)
    }

    static func parseLock(_ json: [String: Any]) -> GDWorkspaceLockBody? {
        guard GDServerCode.read(json) == "workspace_lock" else { return nil }
        let reason = String(((json["reason"] as? String) ?? "workspace_lock").prefix(80))
        let overBy = max(0, integer(json["overBy"]))
        let unpaid = ((json["unpaidWorkspaceIds"] as? [Any]) ?? []).compactMap { $0 as? String }.filter { !$0.isEmpty }.prefix(50)
        return GDWorkspaceLockBody(error: "workspace_lock", reason: reason, overBy: overBy, unpaidWorkspaceIds: Array(unpaid))
    }

    static func lockMessage(reason: String) -> String {
        switch reason {
        case "merge_in_progress":
            return "A workspace merge is still in progress. Wait for it to finish before uploading. Downloads stay available."
        case "scope_unavailable":
            return "This workspace is outside the current allowance. Review it before uploading. Downloads stay available."
        default:
            return "This account is over its workspace limit. Delete or merge the extra workspaces. Downloads stay available."
        }
    }

    static func downloadStaysAvailable(method: String) -> Bool {
        let verb = method.uppercased()
        return verb == "GET" || verb == "HEAD"
    }

    static func byoMessage(code: String, status: Int) -> String? {
        switch code {
        case "byo_provider_unsupported": return byoUnsupportedMessage
        case "byo_unverifiable": return byoUnverifiableMessage
        case "byo_external": return byoExternalMessage
        case "BYO_CHALLENGE_EXPIRED": return "The challenge expired. Start it again."
        case "BYO_ENDPOINT_HOST_MISMATCH": return "The presigned URL host does not match the registered endpoint."
        case "BYO_CHALLENGE_MISMATCH": return "The challenge object path does not match the nonce."
        case "BYO_CHALLENGE_PROOF_REQUIRED": return "GenDragoon has to read the challenge object from your bucket. Send the presigned URL, not a copy of the nonce."
        case "BYO_CHALLENGE_USED": return "That challenge was already used. Start a new one."
        case "presigned_url_required": return "Enter the presigned URL for the challenge object."
        default:
            if status == 422 { return byoUnsupportedMessage }
            return nil
        }
    }

    static func normalizedBYOProvider(_ provider: String) -> String {
        switch provider.lowercased() {
        case "s3", "aws", "r2", "b2", "wasabi", "minio", "gcs": return "s3"
        default: return provider.lowercased()
        }
    }

    static func byoRegisterPath(workspaceId: String) -> String { "v2/workspaces/\(workspaceId)/byo/register" }

    static func byoRegisterBody(provider: String, endpoint: String, bucketFingerprint: String) -> [String: String]? {
        guard normalizedBYOProvider(provider) == "s3" else { return nil }
        guard let url = URL(string: endpoint), url.scheme == "https", url.host != nil, url.user == nil else { return nil }
        guard bucketFingerprint.range(of: #"^[a-f0-9]{8,128}$"#, options: .regularExpression) != nil else { return nil }
        return ["provider": "s3", "endpoint": endpoint, "bucketFingerprint": bucketFingerprint]
    }

    static func byoChallengePath(workspaceId: String) -> String { "v2/workspaces/\(workspaceId)/byo/challenge" }

    static func challengeObject(nonce: String) -> String { ".gendragoon-challenge/\(nonce)" }

    static func byoVerifyPath(workspaceId: String) -> String { "v2/workspaces/\(workspaceId)/byo/verify" }

    static func byoVerifyBody(presignedUrl: String) -> [String: String] { ["presignedUrl": presignedUrl] }

    static func presignedHostMatches(presignedUrl: String, endpoint: String) -> Bool {
        guard let url = URL(string: presignedUrl), let registered = URL(string: endpoint),
              let host = url.host?.lowercased(), let expected = registered.host?.lowercased(), !host.isEmpty else { return false }
        return host == expected
    }

    static func explainProjectWrite(status: Int, json: [String: Any]) -> String? {
        switch (status, GDServerCode.read(json)) {
        case (409, "PROJECT_LIMIT_REACHED"):
            return "This account is at its workspace limit. Archive a workspace or review the ones that are over the allowance."
        case (404, "PROJECT_NOT_FOUND"):
            return "That workspace is not on this account."
        case (400, "CONFIRM_NAME_REQUIRED"):
            return "Enter the exact source workspace name."
        default:
            return nil
        }
    }

    static func mergeCompleted(_ json: [String: Any]) -> Bool {
        (json["merged"] as? Bool) == true && (json["sourceDeleted"] as? Bool) == true
    }

    static func parseSession(workspace: String, json: [String: Any], now: Date = Date()) throws -> GDStorageSession {
        try rejectSecrets(json)
        guard let mode = json["mode"] as? String, mode == "write" || mode == "read" else {
            throw GDStorageContractError.message("Storage session did not say whether this is a read or a write.")
        }
        if let prefix = json["prefix"] as? String {
            guard pathContainsWorkspace(prefix, workspace: workspace), !prefix.hasPrefix("/"), !prefix.contains("..") else {
                throw GDStorageContractError.message("Storage session is not scoped to this workspace.")
            }
        }
        guard let rows = json["urls"] as? [[String: Any]], (1...32).contains(rows.count) else {
            throw GDStorageContractError.message("Storage session did not include a signed URL.")
        }
        let urls: [GDSignedObject] = try rows.map { row in
            guard let object = row["object"] as? String, isOpaqueID(object),
                  let method = (row["method"] as? String)?.uppercased(),
                  let text = row["url"] as? String, let url = URL(string: text),
                  url.scheme == "https", url.host != nil, url.user == nil, url.password == nil,
                  pathContainsWorkspace(url.path, workspace: workspace) else {
                throw GDStorageContractError.message("A signed URL is outside this workspace.")
            }
            let expires = try expiry(row["expiresAt"], now: now)
            let allowed = mode == "write" ? ["PUT", "POST"] : ["GET", "HEAD"]
            guard allowed.contains(method) else {
                throw GDStorageContractError.message("A signed URL has an unexpected method.")
            }
            return GDSignedObject(object: object, url: url, method: method, expiresAt: expires)
        }
        return GDStorageSession(mode: mode, urls: urls)
    }

    static func pathContainsWorkspace(_ path: String, workspace: String) -> Bool {
        path.split(separator: "/").map(String.init).contains(workspace)
    }

    static func isOpaqueID(_ value: String) -> Bool {
        if value == "manifest" { return true }
        if value == "library" { return false }
        if value.range(of: #"^[a-f0-9]{32}$"#, options: .regularExpression) != nil { return true }
        if value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil { return true }
        return UUID(uuidString: value) != nil
    }

    private static func expiry(_ value: Any?, now: Date) throws -> Date {
        let moment: Date?
        if let text = value as? String {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            moment = formatter.date(from: text) ?? {
                formatter.formatOptions = [.withInternetDateTime]
                return formatter.date(from: text)
            }()
        } else if let number = value as? NSNumber {
            let raw = number.doubleValue
            moment = Date(timeIntervalSince1970: raw > 10_000_000_000 ? raw / 1000 : raw)
        } else {
            moment = nil
        }
        guard let moment else { throw GDStorageContractError.message("Signed URL expiry is not a time.") }
        let remaining = moment.timeIntervalSince(now)
        guard remaining > 0, remaining <= 15 * 60 else {
            throw GDStorageContractError.message("Signed URLs must expire within 15 minutes.")
        }
        return moment
    }

    private static func rejectSecrets(_ value: Any) throws {
        if let dict = value as? [String: Any] {
            for (key, item) in dict {
                if secretKeys.contains(key) {
                    throw GDStorageContractError.message("Hosted storage must not hand this Mac a Google credential.")
                }
                try rejectSecrets(item)
            }
        } else if let list = value as? [Any] {
            for item in list { try rejectSecrets(item) }
        }
    }

    private static func integer(_ value: Any?) -> Int {
        if let number = value as? Int { return number }
        if let number = value as? NSNumber { return number.intValue }
        return 0
    }
}
