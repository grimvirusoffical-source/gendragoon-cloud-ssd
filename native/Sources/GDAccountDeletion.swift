import Foundation
import Security
import SwiftUI

/// Account deletion matches DELETE /v2/account: a 5-minute sign-in, the word DELETE,
/// a 202 job, then a local wipe. A later 401 means the account is already gone.
@MainActor struct GDAccountDeletionSection: View {
    @EnvironmentObject private var login: GDLoginSession
    @State private var confirmation = ""
    @State private var status = "Type DELETE to permanently remove this GenDragoon account."
    @State private var busy = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Delete account", systemImage: "person.crop.circle.badge.minus")
                .font(.system(size: 16, weight: .bold))
            Text("This deletes the GenDragoon account after you type DELETE. A sign-in older than 5 minutes has to be repeated first. Caches and the Keychain are wiped only after the server finishes, or when a repeat request says the account is already gone.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            TextField("Type DELETE", text: $confirmation)
                .textFieldStyle(.roundedBorder)
            Button("Delete account") { Task { await delete() } }
                .disabled(busy || confirmation != "DELETE")
                .buttonStyle(.bordered)
                .tint(.red)
            Text(status)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
    }

    private func delete() async {
        guard confirmation == "DELETE" else { status = "Type DELETE to confirm account deletion."; return }
        guard login.signedInWithin(seconds: 5 * 60) else {
            status = "Sign in again. Account deletion needs a sign-in from the last 5 minutes."
            login.requireFreshSignIn(message: status)
            return
        }
        guard let base = Self.endpoint() else { status = "Cloud service configuration is missing from this installation."; return }
        busy = true
        defer { busy = false }
        do {
            let started = try await Self.request(url: base.appendingPathComponent("v2/account"), method: "DELETE", token: login.firebaseIDToken)
            if started.status == 401 {
                try Self.wipeLocal()
                login.logout()
                return
            }
            guard started.status == 202, let job = started.json["job"] as? [String: Any], let id = job["id"] as? String else {
                status = "Account deletion did not start."
                return
            }
            var path = job["statusPath"] as? String ?? "/v2/account/deletions/\(id)"
            guard path.hasPrefix("/v2/account/deletions/"), !path.contains("..") else {
                status = "Account deletion status path is invalid."
                return
            }
            for _ in 0..<40 {
                try await Task.sleep(nanoseconds: 1_000_000_000)
                let poll = try await Self.request(url: base.appendingPathComponent(String(path.dropFirst())), method: "GET", token: login.firebaseIDToken)
                if poll.status == 401 {
                    try Self.wipeLocal()
                    login.logout()
                    return
                }
                guard poll.status == 200 else { status = "Account deletion status could not be read."; return }
                let state = poll.json["status"] as? String ?? ""
                let phase = poll.json["phase"] as? String ?? state
                status = "Deleting account · \(phase)"
                if state == "completed" {
                    try Self.wipeLocal()
                    login.logout()
                    return
                }
                if state == "failed" || state == "cancelled" {
                    status = (poll.json["message"] as? String) ?? "Account deletion did not finish."
                    return
                }
            }
            status = "Account deletion is still running. It will keep going on the server. Sign in again later to finish signing out on this Mac."
        } catch {
            status = error.localizedDescription
        }
    }

    private static func endpoint() -> URL? {
        guard let file = Bundle.main.url(forResource: "gendragoon_free_api", withExtension: "json"),
              let config = try? JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
              let text = config["endpoint"] as? String, let url = URL(string: text), url.scheme == "https" else { return nil }
        return url
    }

    private struct Reply {
        let status: Int
        let json: [String: Any]
    }

    private static func request(url: URL, method: String, token: String) async throws -> Reply {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        let (data, response) = try await URLSession.shared.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let json = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        if status == 423, json["error"] as? String == "workspace_lock" {
            await MainActor.run { GDWorkspaceLock.shared.present(json: json) }
            throw GDTransferError(message: "This account is over its workspace limit. Delete or merge the extra workspaces. Downloads stay available.", status: 423)
        }
        return Reply(status: status, json: json)
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
            kSecAttrService as String: "app.gendragoon.cloudssd",
        ]
        SecItemDelete(query as CFDictionary)
    }
}
