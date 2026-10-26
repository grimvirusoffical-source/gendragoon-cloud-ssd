import SwiftUI
import Foundation

@MainActor final class GDAccountDeletionModel: ObservableObject {
    static let shared = GDAccountDeletionModel()
    @Published private(set) var pending: GDAccountDeletionPending?
    @Published private(set) var busy = false
    @Published private(set) var message = ""
    @Published private(set) var savedRequestNeedsReview = false
    private var localLease: GDAccountDeletionLocalLease?
    private let auth = GDRedXAIAuthSession.shared

    func reloadSaved() {
        guard !busy else { return }
        do { pending = try auth.accountDeletionPending(); savedRequestNeedsReview = false }
        catch { savedRequestNeedsReview = true; message = "The saved deletion request needs review. Existing keys and data were retained." }
    }
    private func inspectLocalActivity() async throws {
        let apps = try await GDNativeHelper.invoke("gendragoon_app_launch", arguments: ["status"], timeout: 30)
        let mounts = try await GDNativeHelper.invoke("gendragoon_workspace_mount", arguments: ["status"], timeout: 20)
        let uploads = try await GDNativeHelper.invoke("gendragoon_upload_workspace", arguments: ["state"], timeout: 20)
        try GDAccountDeletionActivityProbe.validate(apps: JSONSerialization.data(withJSONObject: apps),
            mounts: JSONSerialization.data(withJSONObject: mounts), uploads: JSONSerialization.data(withJSONObject: uploads))
    }
    func request(retry: Bool, confirmation: String = "") {
        guard !busy, !savedRequestNeedsReview else { return }
        if pending == nil && (!retry || confirmation != "DELETE GENDRAGOON") { message = "Type DELETE GENDRAGOON exactly before requesting deletion."; return }
        guard auth.linked, !auth.busy, !auth.portableVaultBusy, !GDWorkspaceMounts.shared.hasMounts,
              GDUpdateActivity.shared.beginMaintenance(owner: self) else {
            message = "Finish transfers and key operations, close managed applications, unmount all drives and refresh their status before deleting this account. Nothing was stopped or bypassed."
            return
        }
        busy = true
        GDUpdateActivity.shared.set(self, key: "accountDeletionRequest", active: true)
        message = "Checking the durable deletion request…"
        Task {
            defer {
                localLease = nil
                GDUpdateActivity.shared.set(self, key: "accountDeletionRequest", active: false)
                GDUpdateActivity.shared.endMaintenance(owner: self)
                busy = false
            }
            do {
                localLease = try GDAccountDeletionLocalLease()
                try await inspectLocalActivity()
                let saved: GDAccountDeletionPending
                if let pending { saved = pending } else { saved = try auth.beginAccountDeletion(); pending = saved }
                guard saved.matches(subject: auth.subject, receiver: auth.receiverID) else { throw GDAccountDeletionFailure(message: "Approve the same Red-XAI account before recovering this request.") }
                let (bound, receipt) = try await auth.requestAccountDeletion(saved, retry: retry)
                pending = bound
                guard let receipt else { message = "No accepted server request yet. Retry this same saved request when connected. Local keys and files were retained."; return }
                if receipt.authorizesCleanup(pending: bound, subject: auth.subject, receiver: auth.receiverID) {
                    try await inspectLocalActivity()
                    try auth.finishAccountDeletion(bound, receipt: receipt)
                    pending = nil
                    message = "GenDragoon cloud deletion was verified. This account’s exact local keymap, storage/auth Keychain entries and profile were removed. Original files, other accounts’ vaults, BYO/external data and unattributed managed caches or saved jobs were retained. Use Cleanup Drive’s preview to review remaining local copies."
                } else if bound.receiptID == nil {
                    message = "The server has a receipt. Retry the same saved request to verify its idempotency binding before any local key cleanup."
                } else if receipt.status == "failed" {
                    message = receipt.error == "billing_review_required" ? "Deletion paused for billing review. Contact support and keep this saved request. Local keys were retained." : "Deletion paused. Retry this same saved request. Local keys and files were retained."
                } else {
                    message = "Deletion \(receipt.status) · \(receipt.phase). Check this receipt again. Local keys remain until verified completion; you may quit and resume later."
                }
            } catch {
                message = GDNativeMessage.safe(error.localizedDescription)
                do { pending = try auth.accountDeletionPending() } catch { savedRequestNeedsReview = true }
            }
        }
    }
}

@MainActor struct GDAccountDeletionSection: View {
    @StateObject private var model = GDAccountDeletionModel.shared
    @ObservedObject private var auth = GDRedXAIAuthSession.shared
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var confirmation = ""
    @State private var showConfirmation = false
    var body: some View {
        GDPanel {
            Label("Delete GenDragoon account", systemImage: "person.crop.circle.badge.minus")
                .font(.system(size: 16, weight: .bold)).foregroundStyle(.red)
            Text("Permanently delete this account’s GenDragoon MachineNotes, encrypted server payloads and service metadata, and cancel associated subscriptions. The external Red-XAI identity, BYO host data, originals, other devices and external backups are outside this deletion. A minimal tombstone remains to prevent old credentials recreating the account.")
                .font(.caption).foregroundStyle(.secondary)
            Text("This Mac keeps its keys until a matching completed server receipt. Shared managed caches and saved upload selections/jobs lack a reliable receiver binding and are retained for your review; deletion never guesses ownership or removes original files.")
                .font(.caption).foregroundStyle(.secondary)
            HStack {
                Link("Privacy notice", destination: URL(string: "https://api.red-xai.com/gendragoon/privacy")!)
                Link("Deletion instructions", destination: URL(string: "https://api.red-xai.com/gendragoon/account-deletion")!)
            }.font(.caption)
            if model.pending != nil {
                Text("A saved deletion request is pending. It survives closing or disconnecting the app. Approve the same account to resume; recovery does not create a Receiver.").font(.caption)
                if auth.linked {
                    HStack {
                        Button("Check deletion receipt") { model.request(retry: false) }
                        Button("Retry same deletion request") { model.request(retry: true) }
                    }.disabled(model.busy || auth.busy || activity.hasActiveOperations || activity.isMaintenancePending)
                } else {
                    Button("Approve same Red-XAI account") { auth.connect() }.disabled(model.busy || auth.busy || activity.hasActiveOperations || activity.isMaintenancePending)
                }
            } else if auth.linked {
                Button("Delete GenDragoon account…") { confirmation = ""; showConfirmation = true }
                    .tint(.red).disabled(model.busy || model.savedRequestNeedsReview || auth.busy || auth.portableVaultBusy || activity.isBusy)
            }
            if model.busy { ProgressView().controlSize(.small) }
            if !model.message.isEmpty { Text(model.message).font(.caption).textSelection(.enabled) }
        }
        .onAppear { model.reloadSaved() }
        .sheet(isPresented: $showConfirmation) {
            VStack(alignment: .leading, spacing: 16) {
                Text("Permanently delete GenDragoon account").font(.title2.bold())
                Text("Export anything you need first. This cancels subscriptions and deletes GenDragoon cloud data. It preserves local originals, external identity/BYO data and unowned local caches/jobs. Once accepted, closing the app does not cancel server deletion. Local keys are removed only after a matching completed receipt.")
                TextField("Type DELETE GENDRAGOON", text: $confirmation)
                HStack {
                    Button("Keep account") { showConfirmation = false }
                    Spacer()
                    Button("Request deletion") {
                        let typed = confirmation; confirmation = ""; showConfirmation = false
                        model.request(retry: true, confirmation: typed)
                    }.tint(.red).disabled(confirmation != "DELETE GENDRAGOON" || model.busy)
                }
            }.padding(24).frame(width: 580)
        }
    }
}
