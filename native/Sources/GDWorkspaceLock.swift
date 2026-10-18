import AppKit
import SwiftUI

/// HTTP 423 `workspace_lock` opens this screen. Uploads stay off; downloads stay available.
@MainActor final class GDWorkspaceLock: ObservableObject {
    static let shared = GDWorkspaceLock()
    @Published var presented = false
    @Published private(set) var reason = ""
    @Published private(set) var overBy = 0
    @Published private(set) var unpaidWorkspaceIds: [String] = []
    @Published var deletionPollActive = false
    @Published var actionStatus = ""
    var message: String { GDStorageContract.lockMessage(reason: reason) }
    func present(json: [String: Any]) {
        guard let body = GDStorageContract.parseLock(json) else { return }
        reason = body.reason
        overBy = body.overBy
        unpaidWorkspaceIds = body.unpaidWorkspaceIds
        presented = true
    }
}

struct GDWorkspaceLockScreen: View {
    @ObservedObject var customer: GDFreeCustomerModel
    @EnvironmentObject private var login: GDLoginSession
    @ObservedObject private var lock = GDWorkspaceLock.shared
    @State private var workspaces: [GDWorkspaceChoice] = []
    @State private var sourceID = ""
    @State private var targetID = ""
    @State private var busy = false

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
            if workspaces.isEmpty {
                Text(lock.unpaidWorkspaceIds.isEmpty ? "Review workspaces to load names and actions." : "Unpaid workspace ids are listed until the workspace list loads.")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                ForEach(lock.unpaidWorkspaceIds, id: \.self) { id in
                    Text(id).font(.system(size: 12, design: .monospaced))
                }
            } else {
                ForEach(workspaces) { workspace in
                    let unpaid = lock.unpaidWorkspaceIds.contains(workspace.id)
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(workspace.name).font(.system(size: 13, weight: unpaid ? .bold : .regular))
                            Text(workspace.id).font(.system(size: 11, design: .monospaced)).foregroundStyle(.secondary)
                        }
                        Spacer()
                        if unpaid { Text("Unpaid").font(.system(size: 11, weight: .bold)).foregroundStyle(.orange) }
                    }
                    .padding(8)
                    .background(unpaid ? Color.orange.opacity(0.16) : Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(sourceID == workspace.id ? Color.purple : Color.clear, lineWidth: 1))
                    .onTapGesture { sourceID = workspace.id }
                }
            }
            Text("A merge keeps both copies. An incoming duplicate is renamed name (from <workspace>), and the source is removed only after that copy is checked. Uploads stay off until this account is within its allowance.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
            if !lock.actionStatus.isEmpty {
                Text(lock.actionStatus).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            HStack {
                Button("Close") { lock.presented = false }
                Spacer()
                Button("Download") { downloadSelected() }
                    .disabled(busy || selected == nil)
                Button("Merge") { mergeSelected() }
                    .disabled(busy || selected == nil || targetID.isEmpty || targetID == sourceID || !GDStorageContract.canMergeOrDelete(reason: lock.reason))
                Button("Delete") { deleteSelected() }
                    .disabled(busy || selected == nil || !GDStorageContract.canMergeOrDelete(reason: lock.reason))
                Button("Review workspaces") { Task { await reload() } }
                    .buttonStyle(.borderedProminent)
                    .tint(.purple)
                    .disabled(busy)
            }
            if workspaces.count > 1 {
                Picker("Merge into", selection: $targetID) {
                    Text("Choose a target").tag("")
                    ForEach(workspaces.filter { $0.id != sourceID }) { workspace in
                        Text(workspace.name).tag(workspace.id)
                    }
                }
            }
        }
        .padding(24)
        .frame(minWidth: 520)
        .onAppear { customer.connect(login); Task { await reload() } }
    }

    private var selected: GDWorkspaceChoice? { workspaces.first { $0.id == sourceID } }

    private func reload() async {
        busy = true
        defer { busy = false }
        do {
            workspaces = try await customer.activeWorkspaces()
            if sourceID.isEmpty || !workspaces.contains(where: { $0.id == sourceID }) {
                sourceID = workspaces.first { lock.unpaidWorkspaceIds.contains($0.id) }?.id ?? workspaces.first?.id ?? ""
            }
            if targetID == sourceID { targetID = workspaces.first { $0.id != sourceID }?.id ?? "" }
            lock.actionStatus = workspaces.isEmpty ? "No active workspaces were returned." : ""
        } catch {
            lock.actionStatus = error.localizedDescription
        }
    }

    private func deleteSelected() {
        guard let selected else { return }
        let alert = NSAlert()
        alert.messageText = "Delete \(selected.name)?"
        alert.informativeText = "This archives the workspace. Type its name to confirm. Files stay until the server finishes the archive."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 330, height: 24))
        field.placeholderString = selected.name
        alert.accessoryView = field
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn, field.stringValue == selected.name else {
            lock.actionStatus = "Workspace name did not match. Nothing was changed."
            return
        }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await customer.archiveWorkspace(selected)
                lock.actionStatus = "Deleted \(selected.name)."
                await reload()
            } catch { lock.actionStatus = error.localizedDescription }
        }
    }

    private func mergeSelected() {
        guard let selected, !targetID.isEmpty, targetID != selected.id else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                try await customer.mergeWorkspace(source: selected, targetId: targetID)
                lock.actionStatus = "Merged \(selected.name). The source is removed only after the copy is checked."
                await reload()
            } catch { lock.actionStatus = error.localizedDescription }
        }
    }

    private func downloadSelected() {
        guard let selected else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = "Download"
        panel.message = "Downloads stay available while this account is over its workspace limit."
        guard panel.runModal() == .OK, let folder = panel.url else { return }
        busy = true
        Task {
            defer { busy = false }
            do {
                let count = try await customer.downloadWorkspace(selected, to: folder)
                lock.actionStatus = "Downloaded \(count) item\(count == 1 ? "" : "s") from \(selected.name)."
            } catch { lock.actionStatus = error.localizedDescription }
        }
    }
}
