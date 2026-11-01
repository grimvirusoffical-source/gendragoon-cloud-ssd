import AppKit
import Foundation
import SwiftUI

struct GDWorkspaceMountRecord: Identifiable {
    let receiverID: String
    let workspaceID: String
    let name: String
    let mountPath: String
    let state: String
    var id: String { receiverID + ":" + workspaceID }
    var mounted: Bool { state == "mounted" || state == "orphaned" || state == "preparing" }
}

@MainActor final class GDWorkspaceMounts: ObservableObject {
    static let shared = GDWorkspaceMounts()
    @Published private(set) var mounts: [GDWorkspaceMountRecord] = []
    @Published private(set) var preparing: Set<String> = []
    @Published private(set) var unknownMounts = true
    @Published private(set) var message = ""
    var hasMounts: Bool { unknownMounts || mounts.contains(where: { $0.mounted }) || !running.isEmpty || !preparing.isEmpty }
    private final class Running {
        let process: Process
        let channel: GDWorkerAuthChannel
        let directory: URL
        let output: FileHandle
        let errors: FileHandle
        init(process: Process, channel: GDWorkerAuthChannel, directory: URL, output: FileHandle, errors: FileHandle) {
            self.process = process; self.channel = channel; self.directory = directory; self.output = output; self.errors = errors
        }
        func close() {
            channel.close(); try? output.close(); try? errors.close()
            try? FileManager.default.removeItem(at: directory)
        }
    }
    private var running: [String: Running] = [:]
    func confirmed(receiver: String, workspace: String) -> Bool {
        !unknownMounts && !preparing.contains(receiver + ":" + workspace)
            && mounts.contains { $0.receiverID == receiver && $0.workspaceID == workspace && $0.state == "mounted" }
    }
    private init() {
        Task {
            await refresh()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                if hasMounts { await refresh() }
            }
        }
    }
    private func protection() {
        GDUpdateActivity.shared.set(self, key: "workspaceMounts", active: hasMounts)
        GDUpdateActivity.shared.set(self, key: "mountPreparing", active: !preparing.isEmpty)
    }

    func refresh() async {
        guard let inspection = GDUpdateActivity.shared.beginBackgroundInspection() else { return }
        defer { GDUpdateActivity.shared.endBackgroundInspection(inspection) }
        do {
            let result = try await GDNativeHelper.invoke("gendragoon_workspace_mount", arguments: ["status"], timeout: 20)
            guard let values = result["mounts"] as? [[String: Any]], values.count <= 200,
                  let unknown = result["unknownMounts"] as? Bool else { throw GDNativeFailure(message: "Workspace drive status needs review.") }
            var parsed: [GDWorkspaceMountRecord] = []
            for value in values {
                guard let receiver = value["receiverId"] as? String, receiver.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                      let workspace = value["workspaceId"] as? String, workspace.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                      let name = value["name"] as? String, name.count <= 255,
                      let path = value["mountPath"] as? String, path == expectedPath(receiver: receiver, workspace: workspace).path,
                      let state = value["state"] as? String, ["mounted", "orphaned", "preparing", "unmounted"].contains(state) else {
                    throw GDNativeFailure(message: "Workspace drive registry needs review; existing mounts were retained.")
                }
                parsed.append(.init(receiverID: receiver, workspaceID: workspace, name: name, mountPath: path, state: state))
            }
            mounts = parsed; unknownMounts = unknown
            for key in running.filter({ !$0.value.process.isRunning }).map(\.key) {
                running.removeValue(forKey: key)?.close()
            }
        } catch { unknownMounts = true; message = GDNativeMessage.safe(error.localizedDescription) }
        protection()
    }

    private func expectedPath(receiver: String, workspace: String) -> URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("GenDragoon Cloud SSD/WorkspaceMounts", isDirectory: true)
            .appendingPathComponent(receiver, isDirectory: true).appendingPathComponent(workspace, isDirectory: true)
            .appendingPathComponent("mount", isDirectory: true)
    }

    func mount(workspaceID: String, name: String) async {
        guard GDUpdateActivity.shared.canStart(excluding: self) else { message = "Wait for the current transfer or maintenance operation before mounting a drive."; return }
        let auth = GDRedXAIAuthSession.shared
        let receiver = auth.receiverID, key = receiver + ":" + workspaceID
        guard running[key] == nil, !preparing.contains(key), !mounts.contains(where: { $0.id == key && $0.mounted }) else { return }
        preparing.insert(key); protection()
        defer { preparing.remove(key); protection() }
        do {
            let input = try await auth.privateWorkerInput(workspaceID: workspaceID, constrained: true)
            guard let channel = try GDWorkerAuthChannel.make(input), let python = GDRuntime.pythonURL,
                  let helper = Bundle.main.url(forResource: "gendragoon_workspace_mount", withExtension: "py") else {
                throw GDNativeFailure(message: "The workspace drive helper is unavailable in this app build.")
            }
            let fm = FileManager.default, directory = FileManager.default.temporaryDirectory.appendingPathComponent("gendragoon-mount-" + UUID().uuidString)
            try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            let outputURL = directory.appendingPathComponent("startup.json"), errorURL = directory.appendingPathComponent("stderr")
            guard fm.createFile(atPath: outputURL.path, contents: nil, attributes: [.posixPermissions: 0o600]),
                  fm.createFile(atPath: errorURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                channel.close(); throw GDNativeFailure(message: "Could not prepare private drive startup output.")
            }
            let output = try FileHandle(forWritingTo: outputURL), errors = try FileHandle(forWritingTo: errorURL)
            let process = Process(); process.executableURL = python
            GDRuntime.configurePython(process, arguments: [helper.path, "serve", "--receiver", receiver, "--workspace", workspaceID,
                                                          "--name", name, "--performance-stdin"])
            process.standardOutput = output; process.standardError = errors; channel.attach(to: process)
            let owned = Running(process: process, channel: channel, directory: directory, output: output, errors: errors)
            running[key] = owned
            do { try process.run(); try channel.start() } catch { owned.close(); running.removeValue(forKey: key); throw error }
            let deadline = Date().addingTimeInterval(45)
            while Date() < deadline {
                let info = try fm.attributesOfItem(atPath: outputURL.path)
                guard (info[.size] as? NSNumber)?.intValue ?? 0 <= 32 * 1024 else { throw GDNativeFailure(message: "Drive startup response exceeded its limit.") }
                let data = try Data(contentsOf: outputURL)
                if let result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    guard result["ok"] as? Bool == true, result["receiverId"] as? String == receiver,
                          result["workspaceId"] as? String == workspaceID,
                          result["mountPath"] as? String == expectedPath(receiver: receiver, workspace: workspaceID).path else {
                        throw GDNativeFailure(message: "The Finder drive could not be mounted. Existing files and caches were retained.")
                    }
                    await refresh(); message = "Read-only Finder drive mounted. File changes remain in GenDragoon."
                    return
                }
                if !process.isRunning { throw GDNativeFailure(message: "The read-only Finder drive could not start. Check drive status before retrying.") }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
            throw GDNativeFailure(message: "The Finder drive is still preparing. Refresh its status; its worker was retained.")
        } catch { message = GDNativeMessage.safe(error.localizedDescription); await refresh() }
    }

    func unmount(_ record: GDWorkspaceMountRecord) async {
        guard GDUpdateActivity.shared.canStart(excluding: self) else { message = "Wait for the current operation before unmounting this drive."; return }
        guard !preparing.contains(record.id) else { return }
        preparing.insert(record.id); defer { preparing.remove(record.id); protection() }
        do {
            _ = try await GDNativeHelper.invoke("gendragoon_workspace_mount", arguments: ["unmount", "--receiver", record.receiverID,
                                                                                       "--workspace", record.workspaceID], timeout: 45)
            message = "Workspace drive unmounted. Your Kamatera files are unchanged."
        } catch { message = GDNativeMessage.safe(error.localizedDescription) }
        await refresh()
    }
    func open(_ record: GDWorkspaceMountRecord) {
        guard record.state == "mounted" else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: record.mountPath, isDirectory: true))
    }
}

struct GDWorkspaceMountsPanel: View {
    @ObservedObject private var signing = GDDeviceAssignments.shared
    @ObservedObject private var model = GDWorkspaceMounts.shared
    @ObservedObject private var auth = GDRedXAIAuthSession.shared
    var body: some View {
        GroupBox("Step 1 · Mount your SSD") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Mount several MachineNotes as separate read-only Finder drives. Changes stay in GenDragoon. File reads stream authenticated chunks from Kamatera into bounded memory; they do not restore complete archives onto this Mac.")
                    .font(.caption).foregroundStyle(.secondary)
                ForEach(auth.readableProjects.flatMap({ $0.buckets }), id: \.id) { note in
                    HStack {
                        Text(note.displayName).lineLimit(1)
                        Spacer()
                        if let mounted = model.mounts.first(where: { $0.receiverID == auth.receiverID && $0.workspaceID == note.id && $0.mounted }) {
                            Text(mounted.state.capitalized).font(.caption).foregroundStyle(.secondary)
                            Button("Open") { model.open(mounted) }.disabled(!signing.isConfirmed(note.id))
                                .help("Mount and sign this workspace first")
                            Button("Unmount") { Task { await model.unmount(mounted) } }
                        } else {
                            Button("Mount read-only") { Task { await model.mount(workspaceID: note.id, name: note.displayName) } }
                        }
                    }.disabled(model.preparing.contains(auth.receiverID + ":" + note.id))
                }
                ForEach(model.mounts.filter { $0.mounted && $0.receiverID != auth.receiverID }) { mounted in
                    HStack {
                        Text("Retained drive from a previous account").font(.caption)
                        Spacer(); Button("Unmount") { Task { await model.unmount(mounted) } }
                    }
                }
                HStack {
                    Button("Refresh drive status") { Task { await model.refresh() } }
                    if model.unknownMounts { Text("Mount status needs review; account switching is blocked.").font(.caption).foregroundStyle(.orange) }
                }
                if !model.message.isEmpty { Text(model.message).font(.caption).textSelection(.enabled) }
                Text("These drives use local read-only NFS. Unmount all drives before disconnecting or changing accounts because macOS may retain filesystem data in its kernel cache. Use Play in GenDragoon for compatible applications.")
                    .font(.caption2).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.task { await model.refresh() }
    }
}
