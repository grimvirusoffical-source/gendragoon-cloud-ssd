import AppKit
import Foundation
import Security
import SwiftUI

private struct GDRegisteredDevice: Identifiable {
    let id: String
    let name: String
    let platform: String
    let signed: Bool
}

private enum GDDeviceKeychain {
    private static let service = "app.gendragoon.cloudssd.device-assignment.v1"
    private struct Saved: Codable { let id: String; let credential: String }
    private static func account(_ receiver: String, _ workspace: String) -> String {
        receiver + ":" + workspace
    }
    private static func query(_ receiver: String, _ workspace: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account(receiver, workspace)]
    }
    static func stored(_ receiver: String, _ workspace: String) -> String? {
        var q = query(receiver,workspace)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var output: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &output) == errSecSuccess,
              let data = output as? Data,
              let saved = try? JSONDecoder().decode(Saved.self, from: data) else { return nil }
        return saved.id
    }
    static func save(_ receiver: String, _ workspace: String, id: String, credential: String) throws {
        guard id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              credential.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else {
            throw GDTransferError(message: "The server returned an invalid device registration.", status: 0)
        }
        let data = try JSONEncoder().encode(Saved(id: id, credential: credential))
        let q = query(receiver,workspace)
        let update: [String: Any] = [kSecValueData as String: data]
        let status = SecItemUpdate(q as CFDictionary, update as CFDictionary)
        if status == errSecItemNotFound {
            var insert = q
            insert[kSecValueData as String] = data
            insert[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(insert as CFDictionary, nil) == errSecSuccess else {
                throw GDTransferError(message: "Device registration could not be saved in macOS Keychain. Revoke it in GenDragoon before trying again.", status: 0)
            }
        } else if status != errSecSuccess {
            throw GDTransferError(message: "macOS Keychain refused the device registration.", status: 0)
        }
    }
    static func clear(_ receiver: String, _ workspace: String) {
        SecItemDelete(query(receiver,workspace) as CFDictionary)
    }
}
@MainActor private final class GDDeviceAssignments: ObservableObject {
    static let shared = GDDeviceAssignments()
    @Published var devices: [String: [GDRegisteredDevice]] = [:]
    @Published var busy: Set<String> = []
    @Published var message = ""
    @Published var receiptImage: NSImage?
    @Published var receiptTitle = ""
    @Published var showingReceipt = false
    private var receiver = ""

    private func path(_ id: String) -> String {
        "/v1/receivers/me/workspaces/" + id + "/devices"
    }
    private func ensureCurrent() -> Bool {
        let current = GDRedXAIAuthSession.shared.receiverID
        guard GDRedXAIAuthSession.shared.linked, current.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            devices = [:]
            receiver = ""
            message = "Sign in before registering devices."
            return false
        }
        if receiver != current {
            devices = [:]
            receiver = current
        }
        return true
    }
    func local(_ workspace: String) -> String? {
        let current = GDRedXAIAuthSession.shared.receiverID
        guard GDRedXAIAuthSession.shared.linked, current == receiver,
              let id = GDDeviceKeychain.stored(current, workspace),
              devices[workspace]?.contains(where: { $0.id == id && $0.signed }) == true else { return nil }
        return id
    }
    private func errorMessage(_ error: Error) -> String {
        if let failure = error as? GDTransferError, failure.status == 404 {
            return "The server does not have the device-signing service yet. No signing was completed."
        }
        return GDNativeMessage.safe(error.localizedDescription)
    }
    func refresh(_ id: String) async {
        guard ensureCurrent(), !busy.contains(id) else { return }
        let owner = receiver
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let payload = try await GDRedXAIAuthSession.shared.serviceRequest(path: path(id))
            guard receiver == owner, owner == GDRedXAIAuthSession.shared.receiverID, payload["workspace"] as? String == id,
                  let entries = payload["devices"] as? [[String: Any]],
                  entries.count <= 20 else { throw GDTransferError(message: "Invalid device list. No registrations were changed.", status: 0) }
            devices[id] = try entries.map { item in
                guard let identifier = item["id"] as? String,
                      identifier.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                      let name = item["name"] as? String, !name.isEmpty, name.count <= 80,
                      let platform = item["platform"] as? String else {
                    throw GDTransferError(message: "Malformed server device listing.", status: 0)
                }
                return GDRegisteredDevice(id: identifier, name: name, platform: platform, signed: item["signed"] as? Bool == true)
            }
            if let saved = GDDeviceKeychain.stored(owner,id), devices[id]?.contains(where: { $0.id == saved }) != true {
                GDDeviceKeychain.clear(owner,id)
            }
            message = "Device assignments verified with the server."
        } catch {
            message = errorMessage(error)
        }
    }
    func register(_ id: String) async {
        guard ensureCurrent(), !busy.contains(id) else { return }
        await refresh(id)
        guard ensureCurrent(), !busy.contains(id) else { return }
        if local(id) != nil {
            message = "This Mac is already signed for that workspace."
            return
        }
        let owner = receiver
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let name = String((Host.current().localizedName ?? "This Mac").prefix(80))
            message = "Creating your encrypted Red-X device receipt…"
            let input = try await GDRedXAIAuthSession.shared.privateWorkerInput(workspaceID: id, constrained: true)
            let prepared = try await GDNativeHelper.invoke("gendragoon_signed_device", arguments: ["prepare"], timeout: 60, standardInput: input)
            guard owner == GDRedXAIAuthSession.shared.receiverID,
                  prepared["platform"] as? String == "macos",
                  let fingerprint = prepared["deviceFingerprint"] as? String,
                  fingerprint.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  let qr = prepared["qr"] as? [String: Any] else {
                throw GDTransferError(message: "Device identity could not be verified.", status: 0)
            }
            let result = try await GDRedXAIAuthSession.shared.serviceRequest(
                path: path(id), method: "POST", json: ["name": name, "platform": "macos", "deviceFingerprint": fingerprint, "qr": qr])
            guard owner == GDRedXAIAuthSession.shared.receiverID,
                  result["workspace"] as? String == id,
                  let entry = result["device"] as? [String: Any],
                  let deviceID = entry["id"] as? String,
                  let secret = result["credential"] as? String else {
                throw GDTransferError(message: "The account changed during registration.", status: 401)
            }
            do { try GDDeviceKeychain.save(owner,id,id:deviceID,credential:secret) }
            catch {
                // A failed local save must not leave an apparently usable signing.
                _ = try? await GDRedXAIAuthSession.shared.serviceRequest(path: path(id) + "/" + deviceID, method: "DELETE")
                throw error
            }
            devices[id] = []
            busy.remove(id)
            await refresh(id)
            guard owner == GDRedXAIAuthSession.shared.receiverID, local(id) == deviceID else {
                if owner == GDRedXAIAuthSession.shared.receiverID { message = "The registration response was received, but the server could not confirm signing. Refresh before retrying." }
                return
            }
            message = "This Mac is signed. Its encrypted Red-X receipt is available in Settings."
        } catch {
            message = errorMessage(error)
        }
    }
    func revoke(_ id: String, device: String) async {
        guard ensureCurrent(), !busy.contains(id) else { return }
        let owner = receiver
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            _ = try await GDRedXAIAuthSession.shared.serviceRequest(path: path(id) + "/" + device, method: "DELETE")
            guard owner == GDRedXAIAuthSession.shared.receiverID else { return }
            if GDDeviceKeychain.stored(owner,id) == device { GDDeviceKeychain.clear(owner,id) }
            receiptImage = nil; showingReceipt = false
            devices[id]?.removeAll(where: { $0.id == device })
            message = "Device unsigned. The registration, encrypted QR, and associated device data were removed from the live databases. Workspace files are unchanged."
        } catch {
            message = GDNativeMessage.safe(error.localizedDescription)
        }
    }
    func showReceipt(_ workspace: String, device: String) async {
        guard ensureCurrent(), !busy.contains(workspace) else { return }
        let owner = receiver
        busy.insert(workspace); defer { busy.remove(workspace) }
        do {
            let result = try await GDRedXAIAuthSession.shared.serviceRequest(path: path(workspace) + "/" + device + "/qr")
            guard owner == GDRedXAIAuthSession.shared.receiverID,
                  result["workspace"] as? String == workspace, result["id"] as? String == device,
                  result["format"] as? String == "redsecretsxai-visual-v3",
                  let encoded = result["png"] as? String, encoded.count <= 175_000,
                  let data = Data(base64Encoded: encoded), data.count <= 131_072,
                  let image = NSImage(data: data), image.size.width <= 2000, image.size.height <= 2000 else {
                throw GDTransferError(message: "The encrypted receipt is invalid or belongs to a different account.", status: 0)
            }
            receiptTitle = "Your encrypted Red-X device code"
            receiptImage = image; showingReceipt = true
        } catch { message = errorMessage(error) }
    }
}
@MainActor struct GDDeviceAssignmentsPanel: View {
    @ObservedObject private var model = GDDeviceAssignments.shared
    @ObservedObject private var auth = GDRedXAIAuthSession.shared
    var body: some View {
        GroupBox("Signed devices · GDGSigned") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Sign this Mac for your MachineNotes using an account-scoped device ID and your existing Red-SecretsXAI vault. The raw hardware ID is not uploaded. Device IDs can change after hardware or system changes; server account authorization remains required.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(auth.readableProjects.flatMap({ $0.buckets }), id: \.id) { workspace in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Image(systemName: "desktopcomputer")
                            Text(workspace.displayName).font(.callout.bold())
                            Spacer()
                            if model.local(workspace.id) != nil {
                                Label("This Mac signed", systemImage: "checkmark.seal.fill")
                                    .font(.caption).foregroundStyle(.green)
                            } else {
                                Button("Sign this Mac") { Task { await model.register(workspace.id) } }
                                    .disabled(model.busy.contains(workspace.id))
                            }
                            Button("Refresh") { Task { await model.refresh(workspace.id) } }
                                .disabled(model.busy.contains(workspace.id))
                        }
                        ForEach(model.devices[workspace.id] ?? []) { device in
                            HStack {
                                Text(device.name + " · " + device.platform).font(.caption)
                                Spacer()
                                if device.signed {
                                    Button("Show Red-X code") { Task { await model.showReceipt(workspace.id, device: device.id) } }
                                        .disabled(model.busy.contains(workspace.id))
                                }
                                Button("Unsign") {
                                    let alert = NSAlert()
                                    alert.alertStyle = .warning
                                    alert.messageText = "Unsign " + device.name + "?"
                                    alert.informativeText = "This revokes the device credential and deletes its encrypted Red-X code and registration data from the database. It does not delete your workspace files. Active transfers may be interrupted."
                                    alert.addButton(withTitle: "Unsign Device")
                                    alert.addButton(withTitle: "Cancel")
                                    if alert.runModal() == .alertFirstButtonReturn {
                                        Task { await model.revoke(workspace.id, device: device.id) }
                                    }
                                }
                                .disabled(model.busy.contains(workspace.id))
                            }
                        }
                    }
                    .padding(9)
                    .background(Color.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
                }
                if !model.message.isEmpty {
                    Text(model.message).font(.caption).foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                Text("The code is an encrypted registration receipt, not a login password or API key. Only your account can retrieve it. Unsign removes the live registration and code; retained backups follow the server backup policy.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .sheet(isPresented: $model.showingReceipt) {
            VStack(spacing: 16) {
                Text(model.receiptTitle).font(.title2.bold())
                if let image = model.receiptImage { Image(nsImage: image).resizable().interpolation(.none).scaledToFit().frame(width: 320, height: 320) }
                Text("Encrypted with your Red-SecretsXAI vault. This is not a login token.")
                    .font(.caption).foregroundStyle(.secondary)
                Button("Close") { model.showingReceipt = false; model.receiptImage = nil }
            }.padding(24)
        }
        .onChange(of: auth.subject) { _, _ in model.showingReceipt = false; model.receiptImage = nil }
        .task {
            for workspace in auth.readableProjects.flatMap({ $0.buckets }) {
                await model.refresh(workspace.id)
            }
        }
    }
}
