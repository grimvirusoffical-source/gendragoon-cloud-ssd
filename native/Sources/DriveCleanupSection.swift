import AppKit
import Combine
import Foundation
import SwiftUI

/// Integrate with the SAME exclusive operation coordinator used by uploads,
/// mounts, app launches/installs, updates, and resets. Never pass no-op closures.
@MainActor
public struct DriveCleanupSection: View {
    private let isBusy: Bool
    private let pythonExecutable: URL
    private let acquireExclusiveOperation: @MainActor () -> Bool
    private let releaseExclusiveOperation: @MainActor () -> Void
    @StateObject private var controller = DriveCleanupController()
    @State private var confirmOrganize = false

    public init(
        isBusy: Bool,
        pythonExecutable: URL,
        acquireExclusiveOperation: @escaping @MainActor () -> Bool,
        releaseExclusiveOperation: @escaping @MainActor () -> Void
    ) {
        self.isBusy = isBusy
        self.pythonExecutable = pythonExecutable
        self.acquireExclusiveOperation = acquireExclusiveOperation
        self.releaseExclusiveOperation = releaseExclusiveOperation
    }

    public var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button("Choose Folder…") { controller.chooseFolder() }
                    Text(controller.rootURL?.path ?? "Choose the local folder to organize.")
                        .font(.caption)
                        .textSelection(.enabled)
                }
                Text("Organize into Applications, Media (Videos, Audio, Pictures), Files, and Folders. Preview every move first. Cloud storage is unchanged.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    Button("Preview") { perform(.preview) }
                        .disabled(controller.rootURL == nil)
                    Button("Organize \(controller.preview?.plannedCount ?? 0) Items…") {
                        confirmOrganize = true
                    }
                    .disabled(controller.preview == nil || controller.preview?.plannedCount == 0)
                    Button("Undo Last Cleanup") { perform(.undo) }
                        .disabled(controller.receiptID == nil)
                }
                if let preview = controller.preview {
                    Text("\(preview.plannedCount ?? 0) moves; \(preview.skipped?.count ?? 0) entries stay in place.")
                        .font(.caption)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 5) {
                            ForEach(Array((preview.moves ?? []).enumerated()), id: \.offset) { _, move in
                                Text("\(move.source) → \(move.destination)")
                                    .textSelection(.enabled)
                            }
                            ForEach(Array((preview.skipped ?? []).enumerated()), id: \.offset) { _, skip in
                                Text("Keep \(skip.name): \(skip.reason)")
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .font(.caption)
                    }
                    .frame(maxHeight: 180)
                }
                if controller.isPending {
                    HStack { ProgressView().controlSize(.small); Text(controller.status).font(.caption) }
                } else if !controller.status.isEmpty {
                    Text(controller.status).font(.caption).textSelection(.enabled)
                }
                if isBusy && !controller.isPending {
                    Text("Wait for transfers, mounts, app installs, updates, and resets to finish.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .disabled(isBusy || controller.isPending)
        } header: {
            Text("Cleanup Drive")
        }
        .confirmationDialog(
            "Organize \(controller.preview?.plannedCount ?? 0) items in the chosen folder?",
            isPresented: $confirmOrganize,
            titleVisibility: .visible
        ) {
            Button("Organize Reviewed Items") { perform(.apply) }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Only the exact preview will be applied. Changed files or destinations cancel cleanup. Keep the receipt to undo unchanged moves.")
        }
        .alert(item: $controller.failure) { failure in
            Alert(title: Text("Cleanup couldn’t finish"), message: Text(failure.message), dismissButton: .default(Text("OK")))
        }
    }

    private func perform(_ action: CleanupAction) {
        controller.perform(
            action, isBusy: isBusy, pythonExecutable: pythonExecutable,
            acquire: acquireExclusiveOperation, release: releaseExclusiveOperation
        )
    }
}

private enum CleanupAction { case preview, apply, undo }

@MainActor
private final class DriveCleanupController: ObservableObject {
    @Published private(set) var rootURL: URL?
    @Published private(set) var preview: CleanupReply?
    @Published private(set) var receiptID: String?
    @Published private(set) var isPending = false
    @Published private(set) var status = ""
    @Published var failure: CleanupFailure?
    // Hold grants for the selected root AND the most recent receipt root.
    // Persistent bookmarks and loading historical receipts belong to the host.
    private var securityScopedURLs: [URL] = []

    deinit {
        for url in securityScopedURLs { url.stopAccessingSecurityScopedResource() }
    }

    func chooseFolder() {
        guard !isPending else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose a local folder to organize"
        panel.prompt = "Choose Folder"
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.treatsFilePackagesAsDirectories = false
        guard panel.runModal() == .OK, let url = panel.url else { return }
        if url.startAccessingSecurityScopedResource() { securityScopedURLs.append(url) }
        rootURL = url
        preview = nil
        status = "Preview this folder before organizing."
        failure = nil
    }

    func perform(
        _ action: CleanupAction,
        isBusy: Bool,
        pythonExecutable: URL,
        acquire: @escaping @MainActor () -> Bool,
        release: @escaping @MainActor () -> Void
    ) {
        guard !isBusy, !isPending else { return }
        guard pythonExecutable.isFileURL, pythonExecutable.path.hasPrefix("/"),
              FileManager.default.isExecutableFile(atPath: pythonExecutable.path),
              let helper = Bundle.main.url(forResource: "gendragoon_drive_cleanup", withExtension: "py") else {
            failure = CleanupFailure("This build is missing the cleanup helper or its configured Python runtime.")
            return
        }
        let arguments: [String]
        let expectedState: String
        switch action {
        case .preview:
            guard let rootURL else { return }
            arguments = ["preview", "--root", rootURL.path]
            expectedState = "preview"
        case .apply:
            guard let planID = preview?.planID, Self.validID(planID) else { return }
            arguments = ["apply", "--plan", planID]
            expectedState = "applied"
        case .undo:
            guard let receiptID, Self.validID(receiptID) else { return }
            arguments = ["undo", "--receipt", receiptID]
            expectedState = "undone"
        }
        // This must atomically inspect actual app-wide busy state and reserve
        // exclusive work BEFORE starting the helper. A disabled button alone
        // cannot prevent a transfer starting between state checks.
        guard acquire() else {
            failure = CleanupFailure("Another operation started. Wait for it to finish, then try again.")
            return
        }
        isPending = true
        failure = nil
        status = action == .preview ? "Inspecting files and preparing a preview…" : "Finishing verified local moves…"

        Task { [self] in
            defer { isPending = false; release() }
            do {
                let reply = try await Task.detached(priority: .userInitiated) {
                    try CleanupProcess.run(
                        executable: pythonExecutable,
                        arguments: [helper.path] + arguments + ["--ui-busy", "false"]
                    )
                }.value
                guard reply.state == expectedState else {
                    throw CleanupFailure("The helper returned an unexpected result. Check the receipt before retrying.")
                }
                switch action {
                case .preview:
                    guard let planID = reply.planID, Self.validID(planID),
                          let moves = reply.moves, let count = reply.plannedCount,
                          count >= 0, count == moves.count,
                          reply.root == rootURL?.path else {
                        throw CleanupFailure("The helper did not return a matching preview.")
                    }
                    preview = reply
                    status = "Review the moves, then choose Organize."
                case .apply:
                    guard let identifier = reply.receiptID, Self.validID(identifier),
                          reply.planID == preview?.planID else {
                        throw CleanupFailure("The cleanup receipt could not be confirmed. Check the local receipt before retrying.")
                    }
                    receiptID = identifier
                    preview = nil
                    status = "Organized \(reply.plannedCount ?? 0) items. Receipt: \(identifier). Undo is available while destinations stay unchanged."
                case .undo:
                    guard reply.receiptID == receiptID else {
                        throw CleanupFailure("The Undo receipt could not be confirmed.")
                    }
                    receiptID = nil
                    preview = nil
                    status = "The cleanup moves were undone."
                }
            } catch let error as CleanupFailure {
                if let identifier = error.receiptID, Self.validID(identifier) {
                    receiptID = identifier
                }
                if action != .undo { preview = nil }
                status = "No success was confirmed. Review the error and any saved receipt."
                failure = error
            } catch {
                if action != .undo { preview = nil }
                status = "No success was confirmed. Check local cleanup receipts before retrying."
                failure = CleanupFailure("The cleanup helper could not complete or return a readable result.")
            }
        }
    }

    private static func validID(_ value: String) -> Bool {
        value.range(of: #"^[0-9a-f]{32}$"#, options: .regularExpression) != nil
    }
}

private struct CleanupFailure: Error, LocalizedError, Identifiable, Sendable {
    let id = UUID()
    let message: String
    let receiptID: String?
    init(_ message: String, receiptID: String? = nil) {
        self.message = String(message.prefix(1_600))
        self.receiptID = receiptID
    }
    var errorDescription: String? { message }
}

private struct CleanupMove: Decodable, Sendable { let source: String; let destination: String }
private struct CleanupSkip: Decodable, Sendable { let name: String; let reason: String }
private struct CleanupReply: Decodable, Sendable {
    let state: String
    let planID: String?
    let receiptID: String?
    let root: String?
    let plannedCount: Int?
    let moves: [CleanupMove]?
    let skipped: [CleanupSkip]?
    let message: String?
    let error: String?
    enum CodingKeys: String, CodingKey {
        case state, root, moves, skipped, message, error
        case planID = "plan_id", receiptID = "receipt_id", plannedCount = "planned_count"
    }
}

private enum CleanupProcess {
    /// Do not kill an organizer halfway through a transaction on a UI timeout.
    /// Keep the coordinator reservation until the child exits. Large previews
    /// hash files and can take time; stdout/stderr use files to avoid deadlocks.
    static func run(executable: URL, arguments: [String]) throws -> CleanupReply {
        let manager = FileManager.default
        let directory = manager.temporaryDirectory.appendingPathComponent("gendragoon-cleanup-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: directory) }
        let outputURL = directory.appendingPathComponent("stdout")
        let errorURL = directory.appendingPathComponent("stderr")
        guard manager.createFile(atPath: outputURL.path, contents: nil, attributes: [.posixPermissions: 0o600]),
              manager.createFile(atPath: errorURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw CleanupFailure("Could not prepare private helper output.")
        }
        let output = try FileHandle(forWritingTo: outputURL)
        defer { try? output.close() }
        let errors = try FileHandle(forWritingTo: errorURL)
        defer { try? errors.close() }
        let process = Process()
        process.executableURL = executable
        GDRuntime.configurePython(process, arguments: arguments)
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = output
        process.standardError = errors
        try process.run()
        process.waitUntilExit()
        let reader = try FileHandle(forReadingFrom: outputURL)
        defer { try? reader.close() }
        let maximum = 16 * 1024 * 1024
        let data = try reader.read(upToCount: maximum + 1) ?? Data()
        guard data.count <= maximum, let reply = try? JSONDecoder().decode(CleanupReply.self, from: data) else {
            throw CleanupFailure("The helper did not return a valid result. Review local cleanup receipts before retrying.")
        }
        guard process.terminationReason == .exit, process.terminationStatus == 0, reply.state != "failed" else {
            let receiptMessage = reply.receiptID.map { " Receipt: \($0)." } ?? ""
            throw CleanupFailure(
                (reply.message ?? "Cleanup did not finish. Review the local receipt.") + receiptMessage,
                receiptID: reply.error == "recovery_needed" ? reply.receiptID : nil
            )
        }
        return reply
    }
}
