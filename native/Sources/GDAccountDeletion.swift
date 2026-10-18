import Combine
import Foundation
import Security

protocol GDDeletionTransport {
    func send(method: String, path: String, authorization: String, body: [String: String]?) async throws -> (status: Int, json: [String: Any])
}

protocol GDDeletionJobStore {
    func load() -> GDSavedDeletionJob?
    func save(_ job: GDSavedDeletionJob) throws
    func delete()
}

@MainActor protocol GDDeletionSession: AnyObject {
    var userID: String { get }
    var firebaseIDToken: String { get }
    var authTimeSeconds: TimeInterval? { get }
    func signedInWithin(seconds: TimeInterval) -> Bool
    func signOut()
    func requireFreshSignIn(message: String)
}

extension GDDeletionSession {
    var authTimeSeconds: TimeInterval? { nil }
}

struct GDSavedDeletionJob: Equatable {
    var jobId: String
    var statusToken: String
    var ownerUID: String
}

/// DELETE /v2/account. A 202 and a 410 `account_deleted` both carry `jobId` and `statusToken`.
/// The poll is GET /v2/account/deletions/:jobId with `Bearer statusToken`.
@MainActor final class GDAccountDeletionMonitor: ObservableObject {
    static let shared = GDAccountDeletionMonitor()
    @Published private(set) var statusText = "Type DELETE to permanently remove this GenDragoon account."
    @Published private(set) var isPolling = false
    @Published private(set) var offersPollRetry = false
    @Published private(set) var offersJobDismiss = false
    /// Shown beside Dismiss when a failed deletion is not retryable, including a 409.
    @Published private(set) var showsSupportContact = false
    /// The 409 `deletion_not_retryable` error, including its `jobId`. Nil for every other failure.
    @Published private(set) var notRetryable: GDDeletionNotRetryable?
    var transfersAreRunning: () -> Bool = { false }
    var onWorkspaceLock: ([String: Any]) -> Void = { _ in }
    /// Firebase `invalid_token` sends `.signedOut`. A status-token `invalid_token` sends `.reauthRequired`.
    var onAuthFailure: (GDDeletionAuthFailure) -> Void = { _ in }

    private let transport: GDDeletionTransport
    private let jobs: GDDeletionJobStore
    private let wipeLocalData: () throws -> Void
    private let sleep: (UInt64) async -> Void
    private var session: GDDeletionSession?
    private var expectedUID: String?
    private var retryDelete = false
    private var retryDeleteOnRetry = false
    private var suppressResend = false
    private var maxPolls = 120
    private static let statusPrefix = "/v2/account/deletions/"

    init(transport: GDDeletionTransport, jobs: GDDeletionJobStore, session: GDDeletionSession,
         wipeLocal: @escaping () throws -> Void, sleep: @escaping (UInt64) async -> Void) {
        self.transport = transport
        self.jobs = jobs
        self.session = session
        self.wipeLocalData = wipeLocal
        self.sleep = sleep
    }

    private convenience init() {
        let store = GDKeychainDeletionJobStore()
        self.init(transport: GDURLSessionDeletionTransport(), jobs: store, session: GDUnsetDeletionSession(),
                  wipeLocal: { try GDAccountDeletionMonitor.wipeLocal() },
                  sleep: { nanoseconds in try? await Task.sleep(nanoseconds: nanoseconds) })
    }

    func resumeOnLaunch(login: GDDeletionSession) {
        session = login
        guard expectedUID == nil, !isPolling, jobs.load() != nil else { return }
        Task { await self.resumeAndWait() }
    }

    func sessionBecameReady(_ login: GDDeletionSession) {
        session = login
        if let expected = expectedUID {
            switch GDAccountContract.reauthFollowUp(expectedUID: expected, signedInUID: login.userID,
                                                     authTime: login.authTimeSeconds, now: Date().timeIntervalSince1970,
                                                     freshSeconds: GDAccountContract.freshSeconds, retryDelete: retryDelete) {
            case .promptAgain(let message):
                statusText = message
                login.requireFreshSignIn(message: message)
                return
            case .retryDelete:
                expectedUID = nil
                retryDelete = false
                Task { await self.retrySavedDeletion() }
                return
            case .resume:
                expectedUID = nil
                retryDelete = false
            }
        }
        resumeOnLaunch(login: login)
    }

    func begin(login: GDDeletionSession, confirmation: String) async {
        session = login
        await begin(confirmation: confirmation)
    }

    func begin(confirmation: String) async {
        if let saved = jobs.load() {
            await resumeAndWait()
            _ = saved
            return
        }
        if suppressResend {
            statusText = "Account deletion did not return a usable status token. Retry the status check. Local keys and caches were kept."
            offersPollRetry = true
            offersJobDismiss = true
            return
        }
        guard confirmation == "DELETE" else {
            statusText = "Type DELETE to confirm account deletion."
            return
        }
        if transfersAreRunning() {
            statusText = "Wait until transfers finish before deleting this account."
            return
        }
        guard let session else {
            statusText = "Sign in again. Local keys and caches were kept."
            return
        }
        guard session.signedInWithin(seconds: GDAccountContract.freshSeconds) else {
            expectedUID = session.userID
            retryDelete = true
            let message = "Sign in again. Account deletion needs a sign-in from the last 5 minutes."
            statusText = message
            session.requireFreshSignIn(message: message)
            return
        }
        guard GDAccountContract.statusPrefix == "/v2/account/deletions/" else { return }
        do {
            let started = try await transport.send(method: "DELETE", path: "/v2/account",
                                                    authorization: "Bearer " + session.firebaseIDToken,
                                                    body: ["confirm": "DELETE"])
            if started.status == 401 {
                let keepPolling = applyUnauthorized(started.json, credential: .firebase)
                if keepPolling, jobs.load() != nil { await poll(maxPolls: maxPolls) }
                return
            }
            switch GDAccountContract.interpretStart(status: started.status, json: started.json) {
            case .poll(let jobId, let statusToken):
                guard started.json["jobId"] as? String == jobId else {
                    statusText = "Account deletion did not return a job. Local keys and caches were kept."
                    return
                }
                let owner = GDAccountContract.retainedDeletionOwner(savedOwnerUID: "", incomingUID: session.userID)
                let saved = GDSavedDeletionJob(jobId: jobId, statusToken: statusToken, ownerUID: owner)
                try jobs.save(saved)
                await poll(maxPolls: maxPolls)
            case .reauthenticate:
                _ = applyUnauthorized(started.json, credential: .firebase)
            case .retryWithoutDelete(let message):
                suppressResend = true
                statusText = message
                offersPollRetry = true
                offersJobDismiss = true
            case .failed(let message, _), .hold(let message):
                statusText = message
            case .notFound(let message):
                statusText = message
                offersPollRetry = false
                offersJobDismiss = false
            case .wipe, .polling:
                statusText = "Account deletion did not start. Local keys and caches were kept."
            }
        } catch {
            statusText = error.localizedDescription
            offersPollRetry = true
        }
    }

    func retryStatus(login: GDDeletionSession) {
        session = login
        Task { await self.retryStatus() }
    }

    func retryStatus() async {
        offersPollRetry = false
        offersJobDismiss = false
        guard let saved = jobs.load() else {
            offersPollRetry = suppressResend
            offersJobDismiss = suppressResend
            statusText = suppressResend
                ? "Account deletion did not return a usable status token. Retry the status check. Local keys and caches were kept."
                : "There is no saved deletion to check."
            return
        }
        if retryDeleteOnRetry {
            guard let session, session.signedInWithin(seconds: GDAccountContract.freshSeconds) else {
                expectedUID = saved.ownerUID.isEmpty ? session?.userID : saved.ownerUID
                retryDelete = true
                let message = "Sign in again, then GenDragoon will retry this deletion. Local keys and caches were kept."
                statusText = message
                offersPollRetry = true
                session?.requireFreshSignIn(message: message)
                return
            }
            await resendDelete(resuming: saved)
            return
        }
        await poll(maxPolls: maxPolls)
    }

    /// Retry is its own path. It re-sends DELETE even when a job is already saved.
    func retrySavedDeletion() async {
        if let saved = jobs.load() {
            retryDeleteOnRetry = true
            await retryStatus()
            return
        }
        await begin(confirmation: "DELETE")
    }

    /// POST .../support-request for the saved deletion job.
    func requestSupport() async {
        await requestSupport(jobId: jobs.load()?.jobId ?? "")
    }

    /// POST .../support-request. A 401 `unauthorized` (missing Authorization) matches a 404:
    /// show the support email and never open sign-in. A missing or blank status token, a blank
    /// job id, or a job id that is not the saved job sends nothing. A 409 `support_not_needed`
    /// gets one status refresh; every other 409 is the fallback. This never signs in, signs out,
    /// throws, or clears the saved job.
    @discardableResult
    func requestSupport(jobId: String) async -> GDSupportRequestResult {
        let result = await supportRequestResult(jobId: jobId)
        statusText = GDAccountContract.supportRequestMessage(result)
        return result
    }

    private func supportRequestResult(jobId: String) async -> GDSupportRequestResult {
        guard let saved = jobs.load(),
              GDAccountContract.supportRequestAllowed(requestedJobId: jobId, savedJobId: saved.jobId,
                                                      statusToken: saved.statusToken) else {
            return .emailFallback
        }
        let response: (status: Int, json: [String: Any])
        do {
            response = try await transport.send(method: "POST", path: GDAccountContract.supportRequestPath(jobId: saved.jobId),
                                                authorization: "Bearer " + saved.statusToken, body: nil)
        } catch {
            return .emailFallback
        }
        guard GDAccountContract.supportRequestNeedsRefresh(status: response.status, json: response.json) else {
            return GDAccountContract.interpretSupportRequest(status: response.status, json: response.json)
        }
        let refresh = GDAccountContract.pollRequest(jobId: saved.jobId, statusToken: saved.statusToken)
        do {
            let refreshed = try await transport.send(method: refresh.method, path: refresh.path,
                                                     authorization: refresh.authorization, body: nil)
            return GDAccountContract.interpretSupportRefresh(status: refreshed.status, json: refreshed.json, jobId: saved.jobId)
        } catch {
            return .emailFallback
        }
    }

    func dismissSavedJob() {
        let recovery = GDAccountContract.dismissRecovery()
        if !recovery.keepSavedJob { jobs.delete() }
        suppressResend = false
        retryDeleteOnRetry = false
        offersPollRetry = false
        offersJobDismiss = false
        showsSupportContact = false
        notRetryable = nil
        isPolling = false
        statusText = "Stopped watching that deletion. Local keys and caches were kept."
    }

    func resumeAndWait() async { await poll(maxPolls: maxPolls) }

    func resumeAndWait(maxPolls: Int) async {
        self.maxPolls = maxPolls
        await poll(maxPolls: maxPolls)
    }

    /// Returns whether the poll loop should continue with the saved status token.
    private func applyUnauthorized(_ json: [String: Any], credential: GDDeletionCredential) -> Bool {
        let saved = jobs.load()
        let decision = GDAccountContract.unauthorizedDeletion(json: json, savedJobExists: saved != nil, credential: credential)
        let savedOwner = saved?.ownerUID ?? ""
        if let signal = decision.signal {
            onAuthFailure(signal)
        }
        if decision.signOut {
            session?.signOut()
        } else if decision.showSignIn {
            expectedUID = savedOwner.isEmpty ? session?.userID : savedOwner
            retryDelete = decision.retryDelete
            retryDeleteOnRetry = decision.retryDelete && saved != nil
            let message = GDAccountContract.unauthorizedMessage(json: json)
            statusText = message
            session?.requireFreshSignIn(message: message)
        }
        return decision.keepPolling && saved != nil
    }

    private func presentNotRetryable(_ error: GDDeletionNotRetryable) {
        notRetryable = error
        showsSupportContact = true
        statusText = GDAccountContract.deletionNotRetryableMessage
        offersPollRetry = false
        offersJobDismiss = true
        retryDeleteOnRetry = false
    }

    private func resendDelete(resuming saved: GDSavedDeletionJob) async {
        guard let session else { return }
        retryDeleteOnRetry = false
        do {
            let started = try await transport.send(method: "DELETE", path: "/v2/account",
                                                    authorization: "Bearer " + session.firebaseIDToken,
                                                    body: ["confirm": "DELETE"])
            if started.status == 401 {
                let keepPolling = applyUnauthorized(started.json, credential: .firebase)
                if keepPolling, jobs.load() != nil { await poll(maxPolls: maxPolls) }
                return
            }
            do {
                try GDAccountContract.deletionNotRetryable(status: started.status, json: started.json)
            } catch let error as GDDeletionNotRetryable {
                presentNotRetryable(error)
                return
            }
            guard case .poll(let jobId, let statusToken) = GDAccountContract.interpretStart(status: started.status, json: started.json),
                  jobId == saved.jobId else {
                statusText = "Account deletion did not return a fresh status token. The saved job was kept."
                offersPollRetry = true
                retryDeleteOnRetry = true
                return
            }
            try jobs.save(GDSavedDeletionJob(jobId: jobId, statusToken: statusToken, ownerUID: saved.ownerUID))
            await poll(maxPolls: maxPolls)
        } catch {
            statusText = error.localizedDescription
            offersPollRetry = true
            retryDeleteOnRetry = true
        }
    }

    private func poll(maxPolls: Int) async {
        guard let saved = jobs.load() else { return }
        offersPollRetry = false
        offersJobDismiss = false
        showsSupportContact = false
        isPolling = true
        defer { self.isPolling = false }
        let jobId = saved.jobId
        let statusToken = saved.statusToken
        let target = GDAccountContract.pollRequest(jobId: jobId, statusToken: statusToken)
        guard target.authorization == "Bearer " + statusToken, target.path.hasPrefix(Self.statusPrefix) else { return }
        for attempt in 0..<maxPolls {
            if Task.isCancelled { return }
            do {
                let poll = try await transport.send(method: target.method, path: target.path,
                                                     authorization: target.authorization, body: nil)
                if Task.isCancelled { return }
                if poll.status == 401 {
                    _ = applyUnauthorized(poll.json, credential: .statusToken)
                    return
                }
                if poll.status == 423 {
                    onWorkspaceLock(poll.json)
                    if attempt + 1 < maxPolls { await sleep(1_000_000_000) }
                    continue
                }
                switch GDAccountContract.interpretPoll(status: poll.status, json: poll.json) {
                case .polling(let phase, _):
                    self.statusText = "Deleting account · \(phase)"
                case .wipe:
                    guard (poll.json["status"] as? String) == "done" else {
                        self.statusText = "Account deletion returned an unknown status. Local keys and caches were kept."
                        return
                    }
                    try wipeLocalData()
                    jobs.delete()
                    self.offersPollRetry = false
                    self.offersJobDismiss = false
                    self.retryDeleteOnRetry = false
                    self.statusText = "This account was deleted from this Mac."
                    return
                case .notFound(let message):
                    let recovery = GDAccountContract.pollRecovery(for: .notFound(message))
                    self.statusText = message
                    self.offersPollRetry = recovery.showRetry
                    self.offersJobDismiss = recovery.allowDismiss
                    self.retryDeleteOnRetry = recovery.sendDelete
                    return
                case .failed(let message, let retryable):
                    let recovery = GDAccountContract.pollRecovery(for: .failed(message, retryable: retryable))
                    self.notRetryable = nil
                    self.showsSupportContact = !retryable
                    self.statusText = retryable ? message : GDAccountContract.deletionNotRetryableMessage
                    self.offersPollRetry = recovery.showRetry
                    self.offersJobDismiss = recovery.allowDismiss
                    self.retryDeleteOnRetry = recovery.sendDelete
                    return
                case .retryWithoutDelete(let message):
                    self.suppressResend = true
                    self.statusText = message
                    self.offersPollRetry = true
                    self.offersJobDismiss = true
                    return
                case .hold(let message):
                    self.statusText = message
                    return
                case .reauthenticate:
                    _ = applyUnauthorized(poll.json, credential: .statusToken)
                    return
                case .poll:
                    return
                }
            } catch is CancellationError {
                return
            } catch {
                self.statusText = error.localizedDescription
                self.offersPollRetry = true
                self.offersJobDismiss = jobs.load() != nil
                return
            }
            if attempt + 1 < maxPolls { await sleep(1_000_000_000) }
        }
        self.statusText = "Account deletion is still running. This Mac will check it again when you reopen GenDragoon."
    }

    static func loadJob() -> GDSavedDeletionJob? { GDKeychainDeletionJobStore().load() }

    static func saveJob(jobId: String, statusToken: String, ownerUID: String) throws {
        let existing = loadJob()?.ownerUID ?? ""
        let owner = GDAccountContract.retainedDeletionOwner(savedOwnerUID: existing, incomingUID: ownerUID)
        try GDKeychainDeletionJobStore().save(GDSavedDeletionJob(jobId: jobId, statusToken: statusToken, ownerUID: owner))
    }

    static func deleteSavedJob() { GDKeychainDeletionJobStore().delete() }

    static func wipeLocal() throws {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let support = home.appendingPathComponent("Library/Application Support/GenDragoon Cloud SSD")
        let targets = [
            home.appendingPathComponent("Library/Caches/GenDragoon Cloud SSD"),
            support.appendingPathComponent("Cache"),
            support.appendingPathComponent("LaunchSessions"),
            support.appendingPathComponent("AutoUpdates"),
        ]
        for url in targets {
            var isDirectory: ObjCBool = false
            guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) else { continue }
            let values = try FileManager.default.attributesOfItem(atPath: url.path)
            if values[.type] as? FileAttributeType == .typeSymbolicLink {
                throw GDDeletionMonitorError(message: "Refusing to wipe a linked cache path.")
            }
            try FileManager.default.removeItem(at: url)
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: GDKeychainDeletionJobStore.service,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

private struct GDDeletionMonitorError: Error, LocalizedError {
    var message: String
    var errorDescription: String? { message }
}

@MainActor private final class GDUnsetDeletionSession: GDDeletionSession {
    var userID = ""
    var firebaseIDToken = ""
    var authTimeSeconds: TimeInterval?
    func signedInWithin(seconds: TimeInterval) -> Bool { false }
    func signOut() {}
    func requireFreshSignIn(message: String) {}
}

final class GDURLSessionDeletionTransport: GDDeletionTransport {
    func send(method: String, path: String, authorization: String, body: [String: String]?) async throws -> (status: Int, json: [String: Any]) {
        guard let base = Self.endpoint() else {
            throw GDDeletionMonitorError(message: "Cloud service configuration is missing from this installation.")
        }
        let trimmed = path.hasPrefix("/") ? String(path.dropFirst()) : path
        var request = URLRequest(url: base.appendingPathComponent(trimmed))
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(authorization, forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        return (status, json)
    }

    private static func endpoint() -> URL? {
        guard let file = Bundle.main.url(forResource: "gendragoon_free_api", withExtension: "json"),
              let config = try? JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
              let text = config["endpoint"] as? String, let url = URL(string: text), url.scheme == "https" else { return nil }
        return url
    }
}

final class GDKeychainDeletionJobStore: GDDeletionJobStore {
    static let service = "app.gendragoon.cloudssd"
    private static let jobAccount = "account-deletion-job"

    func load() -> GDSavedDeletionJob? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.jobAccount,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let jobId = json["jobId"] as? String, GDAccountContract.isJobID(jobId),
              let statusToken = json["statusToken"] as? String, GDAccountContract.isStatusToken(statusToken) else { return nil }
        let ownerUID = (json["ownerUID"] as? String) ?? ""
        return GDSavedDeletionJob(jobId: jobId, statusToken: statusToken, ownerUID: ownerUID)
    }

    func save(_ job: GDSavedDeletionJob) throws {
        guard GDAccountContract.isJobID(job.jobId), GDAccountContract.isStatusToken(job.statusToken) else {
            throw GDDeletionMonitorError(message: "The deletion job could not be saved.")
        }
        let payload = try JSONSerialization.data(withJSONObject: ["jobId": job.jobId, "statusToken": job.statusToken, "ownerUID": job.ownerUID])
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.jobAccount,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = payload
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw GDDeletionMonitorError(message: "The deletion job could not be saved in the Keychain.")
        }
    }

    func delete() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.jobAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }
}
