import Foundation
import Security
import SwiftUI

/// DELETE /v2/account. Riley's PR #6 (84f6fff) returns `statusToken` on 202 and on
/// 410 `account_deleted`. The poll is GET /v2/account/deletions/:jobId with that token.
@MainActor final class GDAccountDeletionMonitor: ObservableObject {
    static let shared = GDAccountDeletionMonitor()
    @Published private(set) var statusText = "Type DELETE to permanently remove this GenDragoon account."
    @Published private(set) var isPolling = false
    @Published private(set) var offersPollRetry = false
    @Published private(set) var offersJobDismiss = false
    private var pollTask: Task<Void, Never>?
    private var expectedUID: String?
    private var retryDelete = false
    private static let statusPrefix = "/v2/account/deletions/"

    func resumeOnLaunch(login: GDLoginSession) {
        guard expectedUID == nil, !isPolling, let saved = Self.loadJob() else { return }
        poll(saved, login: login)
    }

    func sessionBecameReady(_ login: GDLoginSession) {
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
                Task { await self.begin(login: login, confirmation: "DELETE") }
                return
            case .resume:
                expectedUID = nil
                retryDelete = false
            }
        }
        resumeOnLaunch(login: login)
    }

    func begin(login: GDLoginSession, confirmation: String) async {
        if let saved = Self.loadJob() {
            poll(saved, login: login)
            return
        }
        guard confirmation == "DELETE" else {
            statusText = "Type DELETE to confirm account deletion."
            return
        }
        if GDUpdateActivity.shared.hasActiveOperations {
            statusText = "Wait until transfers finish before deleting this account."
            return
        }
        guard login.signedInWithin(seconds: GDAccountContract.freshSeconds) else {
            expectedUID = login.userID
            retryDelete = true
            let message = "Sign in again. Account deletion needs a sign-in from the last 5 minutes."
            statusText = message
            login.requireFreshSignIn(message: message)
            return
        }
        guard let base = Self.endpoint() else {
            statusText = "Cloud service configuration is missing from this installation."
            return
        }
        guard GDAccountContract.statusPrefix == "/v2/account/deletions/" else { return }
        do {
            let started = try await Self.request(url: base.appendingPathComponent("v2/account"), method: "DELETE",
                                                  token: login.firebaseIDToken, body: ["confirm": "DELETE"])
            if started.status == 401 {
                acceptUnauthorized(started.json, login: login)
                return
            }
            switch GDAccountContract.interpretStart(status: started.status, json: started.json) {
            case .poll(let jobId, let statusToken):
                guard started.json["jobId"] as? String == jobId else {
                    statusText = "Account deletion did not return a job. Local keys and caches were kept."
                    return
                }
                let owner = GDAccountContract.retainedDeletionOwner(savedOwnerUID: "", incomingUID: login.userID)
                try Self.saveJob(jobId: jobId, statusToken: statusToken, ownerUID: owner)
                poll(GDSavedDeletionJob(jobId: jobId, statusToken: statusToken, ownerUID: owner), login: login)
            case .reauthenticate:
                acceptUnauthorized(started.json, login: login)
            case .failed(let message), .hold(let message):
                statusText = message
            case .notFound(let message):
                statusText = message
                offersPollRetry = true
                offersJobDismiss = true
            case .wipe, .polling:
                statusText = "Account deletion did not start. Local keys and caches were kept."
            }
        } catch {
            statusText = error.localizedDescription
        }
    }

    func retryStatus(login: GDLoginSession) {
        guard let saved = Self.loadJob() else {
            offersPollRetry = false
            offersJobDismiss = false
            statusText = "There is no saved deletion to check."
            return
        }
        poll(saved, login: login)
    }

    func dismissSavedJob() {
        let recovery = GDAccountContract.dismissRecovery()
        pollTask?.cancel()
        if !recovery.keepSavedJob { Self.deleteSavedJob() }
        offersPollRetry = false
        offersJobDismiss = false
        isPolling = false
        statusText = "Stopped watching that deletion. Local keys and caches were kept."
    }

    private func poll(_ saved: GDSavedDeletionJob, login: GDLoginSession) {
        pollTask?.cancel()
        offersPollRetry = false
        offersJobDismiss = false
        isPolling = true
        GDWorkspaceLock.shared.deletionPollActive = true
        let jobId = saved.jobId
        let statusToken = saved.statusToken
        pollTask = Task { [weak login] in
            defer {
                self.isPolling = false
                GDWorkspaceLock.shared.deletionPollActive = false
            }
            guard let base = Self.endpoint() else {
                self.statusText = "Cloud service configuration is missing from this installation."
                return
            }
            let target = GDAccountContract.pollRequest(jobId: jobId, statusToken: statusToken)
            guard target.authorization == "Bearer " + statusToken, target.path.hasPrefix(Self.statusPrefix) else { return }
            for attempt in 0..<120 {
                if Task.isCancelled { return }
                do {
                    let poll = try await Self.request(url: base.appendingPathComponent(String(target.path.dropFirst())),
                                                       method: target.method, token: statusToken, body: nil)
                    if Task.isCancelled { return }
                    if poll.status == 401 {
                        if let login { self.acceptUnauthorized(poll.json, login: login) }
                        else { self.statusText = "Sign in again. Local keys and caches were kept." }
                        return
                    }
                    if poll.status == 423 {
                        GDWorkspaceLock.shared.present(json: poll.json)
                        if attempt < 119 { try? await Task.sleep(nanoseconds: 1_000_000_000) }
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
                        try Self.wipeLocal()
                        Self.deleteSavedJob()
                        self.offersPollRetry = false
                        self.offersJobDismiss = false
                        self.statusText = "This account was deleted from this Mac."
                        login?.logout()
                        return
                    case .notFound(let message):
                        let recovery = GDAccountContract.pollRecovery(for: .notFound(message))
                        self.statusText = message
                        self.offersPollRetry = recovery.showRetry
                        self.offersJobDismiss = recovery.allowDismiss
                        return
                    case .failed(let message), .hold(let message):
                        self.statusText = message
                        return
                    case .reauthenticate:
                        if let login { self.acceptUnauthorized(poll.json, login: login) }
                        return
                    case .poll:
                        return
                    }
                } catch is CancellationError {
                    return
                } catch {
                    self.statusText = error.localizedDescription
                    return
                }
                if attempt < 119 { try? await Task.sleep(nanoseconds: 1_000_000_000) }
            }
            self.statusText = "Account deletion is still running. This Mac will check it again when you reopen GenDragoon."
        }
    }

    private func acceptUnauthorized(_ json: [String: Any], login: GDLoginSession) {
        let saved = Self.loadJob()
        let decision = GDAccountContract.unauthorizedDeletion(json: json, savedJobExists: saved != nil)
        let savedOwner = saved?.ownerUID ?? ""
        expectedUID = savedOwner.isEmpty ? login.userID : savedOwner
        retryDelete = decision.retryDelete
        let message = GDAccountContract.unauthorizedMessage(json: json)
        statusText = message
        if decision.showSignIn { login.requireFreshSignIn(message: message) }
    }

    private struct Reply {
        let status: Int
        let json: [String: Any]
    }

    private static func endpoint() -> URL? {
        guard let file = Bundle.main.url(forResource: "gendragoon_free_api", withExtension: "json"),
              let config = try? JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
              let text = config["endpoint"] as? String, let url = URL(string: text), url.scheme == "https" else { return nil }
        return url
    }

    private static func request(url: URL, method: String, token: String, body: [String: String]?) async throws -> Reply {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        if status == 423, GDServerCode.read(json) == "workspace_lock" {
            await MainActor.run { GDWorkspaceLock.shared.present(json: json) }
        }
        return Reply(status: status, json: json)
    }

    private static let service = "app.gendragoon.cloudssd"
    private static let jobAccount = "account-deletion-job"

    static func saveJob(jobId: String, statusToken: String, ownerUID: String) throws {
        let owner = GDAccountContract.retainedDeletionOwner(savedOwnerUID: loadJob()?.ownerUID ?? "", incomingUID: ownerUID)
        let payload = try JSONSerialization.data(withJSONObject: ["jobId": jobId, "statusToken": statusToken, "ownerUID": owner])
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: jobAccount,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = payload
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(add as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw GDTransferError(message: "The deletion job could not be saved in the Keychain.", status: Int(status))
        }
    }

    nonisolated static func loadJob() -> GDSavedDeletionJob? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: jobAccount,
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

    static func deleteSavedJob() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: jobAccount,
        ]
        SecItemDelete(query as CFDictionary)
    }

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
                throw GDTransferError(message: "Refusing to wipe a linked cache path.", status: 0)
            }
            try FileManager.default.removeItem(at: url)
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

struct GDSavedDeletionJob: Equatable {
    var jobId: String
    var statusToken: String
    var ownerUID: String
}

@MainActor struct GDAccountDeletionSection: View {
    @EnvironmentObject private var login: GDLoginSession
    @ObservedObject private var monitor = GDAccountDeletionMonitor.shared
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var confirmation = ""

    var body: some View {
        let _ = activity.revision
        let transfersRunning = activity.hasActiveOperations
        VStack(alignment: .leading, spacing: 10) {
            Label("Delete account", systemImage: "person.crop.circle.badge.minus")
                .font(.system(size: 16, weight: .bold))
            Text("This deletes the GenDragoon account after you type DELETE. A sign-in older than 5 minutes has to be repeated first. Caches and the Keychain are wiped only after the deletion status is done.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            TextField("Type DELETE", text: $confirmation)
                .textFieldStyle(.roundedBorder)
            Button("Delete account") { Task { await monitor.begin(login: login, confirmation: confirmation) } }
                .disabled(confirmation != "DELETE" || transfersRunning || monitor.isPolling)
                .buttonStyle(.bordered)
                .tint(.red)
            if monitor.offersPollRetry || monitor.offersJobDismiss {
                HStack {
                    if monitor.offersPollRetry {
                        Button("Retry") { monitor.retryStatus(login: login) }
                            .buttonStyle(.bordered)
                    }
                    if monitor.offersJobDismiss {
                        Button("Dismiss") { monitor.dismissSavedJob() }
                            .buttonStyle(.bordered)
                    }
                }
            }
            Text(monitor.statusText)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .onAppear { monitor.resumeOnLaunch(login: login) }
    }
}
