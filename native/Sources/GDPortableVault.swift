import Foundation
import AppKit
import SwiftUI
import UniformTypeIdentifiers

@MainActor private final class GDPortableVaultModel: ObservableObject {
    @Published var password = ""
    @Published var confirmation = ""
    @Published private(set) var busy = false
    @Published private(set) var message = ""
    func exportVault() {
        guard !busy else { return }
        guard password == confirmation else { message = "The passphrases do not match."; return }
        let passphrase = password
        password = ""; confirmation = ""; busy = true; message = "Encrypting your portable vault…"
        Task {
            defer { busy = false }
            do {
                // Encrypt in memory before a user-selected file is ever opened.
                let encrypted = try await GDRedXAIAuthSession.shared.exportPortableVault(password: passphrase)
                let panel = NSSavePanel()
                panel.title = "Export encrypted GenDragoon vault"
                panel.nameFieldStringValue = "GenDragoon-Storage.gdvault"
                panel.allowedContentTypes = [UTType(filenameExtension: "gdvault") ?? .data]
                panel.canCreateDirectories = true
                guard panel.runModal() == .OK, let url = panel.url else { message = "Export cancelled."; return }
                try encrypted.write(to: url, options: [.atomic])
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
                message = "Encrypted vault exported. Keep its passphrase separately; both are required on another device."
            } catch { message = error.localizedDescription }
        }
    }
    func importVault() {
        guard !busy else { return }
        let panel = NSOpenPanel()
        panel.title = "Import an encrypted GenDragoon vault"
        panel.allowedContentTypes = [UTType(filenameExtension: "gdvault") ?? .data, .json]
        panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let passphrase = password
        password = ""; confirmation = ""; busy = true; message = "Verifying the portable vault…"
        Task {
            defer { busy = false }
            do {
                let granted = url.startAccessingSecurityScopedResource()
                defer { if granted { url.stopAccessingSecurityScopedResource() } }
                let handle = try FileHandle(forReadingFrom: url)
                defer { try? handle.close() }
                let encrypted = try handle.read(upToCount: GDPortableVaultCodec.envelopeLimit + 1) ?? Data()
                guard encrypted.count <= GDPortableVaultCodec.envelopeLimit else { throw GDPortableVaultFailure(message: "The selected vault exceeds the supported size.") }
                try await GDRedXAIAuthSession.shared.importPortableVault(encrypted, password: passphrase)
                message = "Vault imported and its encrypted keymap verified. This device can restore files encrypted with these keys."
            } catch { message = error.localizedDescription }
        }
    }
}

/// Explicit local file pickers; no keys are sent to account or integration APIs.
struct GDPortableVaultPanel: View {
    @ObservedObject private var auth = GDRedXAIAuthSession.shared
    @StateObject private var model = GDPortableVaultModel()
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Portable storage vault", systemImage: "key.horizontal")
                .font(.headline)
            Text("Move your existing encrypted storage keys between your own Mac, Android, Windows, and Linux devices. Your account sign-in stays on this device. Connect the same Red-XAI account before importing.")
                .font(.caption).foregroundColor(.secondary)
            SecureField("Vault passphrase · at least 12 characters", text: $model.password)
                .textFieldStyle(.roundedBorder)
            SecureField("Repeat passphrase for export", text: $model.confirmation)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Export encrypted vault…") { model.exportVault() }
                Button("Import encrypted vault…") { model.importVault() }
                if model.busy { ProgressView().controlSize(.small) }
            }
            .disabled(!auth.linked || model.busy || auth.portableVaultBusy)
            Text("Keep the exported file and its passphrase safe. A lost vault cannot be recovered from sign-in or an API key. Import never replaces a different local storage key or keymap.")
                .font(.caption).foregroundColor(.secondary)
            if !model.message.isEmpty { Text(model.message).font(.caption).textSelection(.enabled) }
        }
        .padding(12)
        .background(Color.secondary.opacity(0.07))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}
