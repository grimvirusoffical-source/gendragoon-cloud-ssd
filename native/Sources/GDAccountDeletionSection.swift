import SwiftUI

extension GDLoginSession: GDDeletionSession {
    func signOut() { logout(preserveStatus: true) }
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
            Button("Delete account") {
                monitor.transfersAreRunning = { GDUpdateActivity.shared.hasActiveOperations }
                monitor.onWorkspaceLock = { GDWorkspaceLock.shared.present(json: $0) }
                Task { await monitor.begin(login: login, confirmation: confirmation) }
            }
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
                        if monitor.showsSupportContact {
                            Button("Request support") { Task { await monitor.requestSupport() } }
                                .buttonStyle(.bordered)
                            Text(GDSupportContact.current.value)
                                .font(.system(size: 12))
                                .textSelection(.enabled)
                        }
                    }
                }
            }
            Text(monitor.statusText)
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        .onAppear {
            monitor.transfersAreRunning = { GDUpdateActivity.shared.hasActiveOperations }
            monitor.onWorkspaceLock = { GDWorkspaceLock.shared.present(json: $0) }
            monitor.resumeOnLaunch(login: login)
        }
    }
}

@MainActor struct GDPassphraseSection: View {
    @State private var passphrase = ""
    @State private var confirmation = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Workspace passphrase", systemImage: "key.fill")
                .font(.system(size: 16, weight: .bold))
            Text("Losing this passphrase means losing the files. GenDragoon cannot recover a workspace key without it, and the passphrase is not saved on this Mac.")
                .font(.system(size: 12, weight: .semibold))
            SecureField("Passphrase", text: $passphrase)
            SecureField("Repeat passphrase", text: $confirmation)
            Text(passphrase.isEmpty || passphrase != confirmation
                 ? "Enter the passphrase twice before it can wrap the workspace key."
                 : "The workspace key is saved only after the server accepts the envelope.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
        }
    }
}
