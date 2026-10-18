import SwiftUI

/// HTTP 423 `workspace_lock` opens this screen. Uploads stay off; downloads stay available.
@MainActor final class GDWorkspaceLock: ObservableObject {
    static let shared = GDWorkspaceLock()
    @Published var presented = false
    @Published private(set) var reason = ""
    @Published private(set) var overBy = 0
    @Published private(set) var unpaidWorkspaceIds: [String] = []
    var message: String {
        "This account is over its workspace limit. Delete or merge the extra workspaces. Downloads stay available."
    }
    func present(json: [String: Any]) {
        guard json["error"] as? String == "workspace_lock" else { return }
        reason = String((json["reason"] as? String ?? "workspace_lock").prefix(80))
        overBy = max(0, json["overBy"] as? Int ?? 0)
        unpaidWorkspaceIds = ((json["unpaidWorkspaceIds"] as? [String]) ?? []).filter { !$0.isEmpty }.prefix(50).map { $0 }
        presented = true
    }
}

struct GDWorkspaceLockScreen: View {
    @ObservedObject private var lock = GDWorkspaceLock.shared
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Label("Choose workspaces to delete or merge", systemImage: "lock.fill")
                .font(.system(size: 20, weight: .bold))
            Text(lock.message)
                .font(.system(size: 13))
            if lock.overBy > 0 {
                Text("Remove \(lock.overBy) workspace\(lock.overBy == 1 ? "" : "s") above the current allowance.")
                    .font(.system(size: 13, weight: .semibold))
            }
            if !lock.unpaidWorkspaceIds.isEmpty {
                Text("Unpaid workspaces")
                    .font(.system(size: 11, weight: .bold, design: .monospaced))
                ForEach(lock.unpaidWorkspaceIds, id: \.self) { id in
                    Text(id).font(.system(size: 12, design: .monospaced))
                }
            }
            Text("A merge keeps both copies. An incoming duplicate is renamed name (from <workspace>), and the source is removed only after that copy is checked. Uploads stay off until this account is within its allowance.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            HStack {
                Button("Close") { lock.presented = false }
                Spacer()
                Button("Review workspaces") { lock.presented = false }
                    .buttonStyle(.borderedProminent)
                    .tint(.purple)
            }
        }
        .padding(24)
        .frame(minWidth: 460)
    }
}
