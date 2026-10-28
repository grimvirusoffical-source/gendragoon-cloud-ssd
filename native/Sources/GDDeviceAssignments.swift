import AppKit
import Foundation
import Security
import SwiftUI

private struct GDRegisteredDevice: Identifiable {
    let id: String
    let name: String
    let platform: String
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
        guard ensureCurrent() else { return nil }
        return GDDeviceKeychain.stored(receiver, workspace)
    }
    func refresh(_ id: String) async {
        guard ensureCurrent(), !busy.contains(id) else { return }
        let owner = receiver
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let payload = try await GDRedXAIAuthSession.shared.serviceRequest(path: path(id))
            guard receiver == owner, payload["workspace"] as? String == id,
                  let entries = payload["devices"] as? [[String: Any]],
                  entries.count <= 20 else { throw GDTransferError(message: "Invalid device list. No registrations were changed.", status: 0) }
            devices[id] = try entries.map { item in
                guard let identifier = item["id"] as? String,
                      identifier.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                      let name = item["name"] as? String, !name.isEmpty, name.count <= 80,
                      let platform = item["platform"] as? String else {
                    throw GDTransferError(message: "Malformed server device listing.", status: 0)
                }
                return GDRegisteredDevice(id: identifier, name: name, platform: platform)
            }
            message = "Device assignments refreshed."
        } catch {
            message = GDNativeMessage.safe(error.localizedDescription)
        }
    }
    func register(_ id: String) async {
        guard ensureCurrent(), !busy.contains(id) else { return }
        if GDDeviceKeychain.stored(receiver, id) != nil {
            message = "This Mac is already assigned to that workspace."
            return
        }
        let owner = receiver
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            let name = String((Host.current().localizedName ?? "This Mac").prefix(80))
            let result = try await GDRedXAIAuthSession.shared.serviceRequest(
                path: path(id), method: "POST", json: ["name": name, "platform": "macos"])
            guard owner == GDRedXAIAuthSession.shared.receiverID,
                  result["workspace"] as? String == id,
                  let entry = result["device"] as? [String: Any],
                  let deviceID = entry["id"] as? String,
                  let secret = result["credential"] as? String else {
                throw GDTransferError(message: "The account changed during registration.", status: 401)
            }
            try GDDeviceKeychain.save(owner,id,id:deviceID,credential:secret)
            message = "Assigned this Mac to the workspace; its credential is stored only in Keychain."
            devices[id] = []
        } catch {
            message = GDNativeMessage.safe(error.localizedDescription)
        }
        busy.remove(id)
        await refresh(id)
    }
    func revoke(_ id: String, device: String) async {
        guard ensureCurrent(), !busy.contains(id) else { return }
        busy.insert(id)
        defer { busy.remove(id) }
        do {
            _ = try await GDRedXAIAuthSession.shared.serviceRequest(path: path(id) + "/" + device, method: "DELETE")
            if GDDeviceKeychain.stored(receiver,id) == device { GDDeviceKeychain.clear(receiver,id) }
            devices[id]?.removeAll(where: { $0.id == device })
            message = "Device access revoked. Any running transfers should be completed or stopped before changing devices."
        } catch {
            message = GDNativeMessage.safe(error.localizedDescription)
        }
    }
}
@MainActor struct GDDeviceAssignmentsPanel: View {
    @ObservedObject private var model = GDDeviceAssignments.shared
    @ObservedObject private var auth = GDRedXAIAuthSession.shared
    var body: some View {
        GroupBox("Assigned devices") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Assign this Mac to one or several MachineNotes. The server verifies ownership and keeps only a hash of this Mac's device credential; the credential stays in macOS Keychain.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(auth.readableProjects.flatMap({ $0.buckets }), id: \.id) { workspace in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Image(systemName: "desktopcomputer")
                            Text(workspace.displayName).font(.callout.bold())
                            Spacer()
                            if model.local(workspace.id) != nil {
                                Label("This Mac assigned", systemImage: "checkmark.seal.fill")
                                    .font(.caption).foregroundStyle(.green)
                            } else {
                                Button("Assign this Mac") { Task { await model.register(workspace.id) } }
                                    .disabled(model.busy.contains(workspace.id))
                            }
                            Button("Refresh") { Task { await model.refresh(workspace.id) } }
                                .disabled(model.busy.contains(workspace.id))
                        }
                        ForEach(model.devices[workspace.id] ?? []) { device in
                            HStack {
                                Text(device.name + " · " + device.platform).font(.caption)
                                Spacer()
                                Button("Revoke") {
                                    let alert = NSAlert()
                                    alert.alertStyle = .warning
                                    alert.messageText = "Revoke " + device.name + "?"
                                    alert.informativeText = "This immediately invalidates this device's workspace credential, and may interrupt its transfers."
                                    alert.addButton(withTitle: "Revoke Device")
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
                Text("If device registration is not yet supported by the deployed service, mounting and existing access remain available during the gradual rollout. Device enforcement will be enabled only after every client has been upgraded.")
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .task {
            for workspace in auth.readableProjects.flatMap({ $0.buckets }) {
                await model.refresh(workspace.id)
            }
        }
    }
}
