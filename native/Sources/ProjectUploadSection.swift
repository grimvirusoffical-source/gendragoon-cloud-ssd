import AppKit
import Combine
import Dispatch
import Foundation
import SwiftUI

/// Populate these values only from the authenticated Red-XAI MachineNotes response.
public struct UploadCloudProject: Identifiable, Hashable, Sendable {
    public let id: String
    public let displayName: String
    public let buckets: [UploadCloudBucket]
    public init(id: String, displayName: String, buckets: [UploadCloudBucket]) {
        self.id = id
        self.displayName = displayName
        self.buckets = buckets
    }
}

public struct UploadCloudBucket: Identifiable, Hashable, Sendable {
    public let id: String
    public let displayName: String
    public let remote: String
    public let prefix: String
    public let workers: Int
    /// remote is the configured rclone section name, without a colon or path.
    public init(id: String, displayName: String, remote: String, prefix: String, workers: Int = 1) {
        self.id = id
        self.displayName = displayName
        self.remote = remote
        self.prefix = prefix
        self.workers = max(1, min(24, workers))
    }
}

/// The host retains this model across sidebar navigation. Every destination
/// badge, application tree and queue observes the same persisted workspace.
@MainActor
struct ProjectUploadSection: View {
    private let externalBusy: Bool
    private let onRefreshCloudChoices: @MainActor () async -> Void
    private let content: GDProjectContent?
    @ObservedObject private var workspace: UploadWorkspaceModel
    @State private var showLocalBrowser = false
    @State private var dropTarget = false

    init(workspace: UploadWorkspaceModel, externalBusy: Bool, content: GDProjectContent? = nil,
         onRefreshCloudChoices: @escaping @MainActor () async -> Void) {
        self.workspace = workspace
        self.externalBusy = externalBusy
        self.content = content
        self.onRefreshCloudChoices = onRefreshCloudChoices
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            destinationPicker
            sourcePicker
            DisclosureGroup("Browse local folders", isExpanded: $showLocalBrowser) { sourceTree }
            uploadQueue
        }
        .task {
            await workspace.refresh()
            await workspace.browse(path: nil)
        }
        .alert(item: $workspace.failure) { failure in
            Alert(title: Text("Upload needs attention"), message: Text(failure.message),
                  dismissButton: .default(Text("OK")))
        }
    }

    private var destinationPicker: some View {
        GroupBox("MachineNote on your Red-XAI server") {
            VStack(alignment: .leading, spacing: 8) {
                Picker("MachineNote", selection: Binding(
                    get: { workspace.snapshot?.destination },
                    set: { destination in
                        if let destination { workspace.select(destination, externalBusy: externalBusy) }
                    }
                )) {
                    Text("Choose a MachineNote").tag(Optional<UploadDestination>.none).disabled(true)
                    if let saved = workspace.snapshot?.destination, !workspace.destinationIsListed {
                        Text("Choose an available MachineNote")
                            .tag(Optional(saved)).disabled(true)
                    }
                    ForEach(workspace.readableProjects) { project in
                        ForEach(project.buckets) { bucket in
                            Text(bucket.displayName + (workspace.isAuthorized(UploadDestination(project: project.id, bucket: bucket.id, remote: bucket.remote, prefix: bucket.prefix)) ? "" : " · Read only"))
                                .tag(Optional(UploadDestination(project: project.id, bucket: bucket.id,
                                                               remote: bucket.remote, prefix: bucket.prefix)))
                        }
                    }
                }
                .disabled(workspace.controlsLocked(externalBusy: externalBusy))
                destinationBadge
                if workspace.snapshot?.destination != nil && !workspace.destinationAvailable {
                    Text(workspace.snapshot?.destination.map(workspace.isReadable) == true ? "This MachineNote is read only. You can download existing files; activate its storage plan to upload." : "Choose an available MachineNote before uploading. Previous provider destinations cannot be used here.")
                        .font(.caption).foregroundStyle(.red)
                } else if workspace.projects.isEmpty && !workspace.destinationAvailable {
                    Text("No active MachineNotes are available. Create one in MachineNotes, then refresh this list.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button("Refresh MachineNotes and upload state") {
                    Task { await workspace.refreshChoices(using: onRefreshCloudChoices) }
                }
                .disabled(workspace.isMutationPending || workspace.isRefreshingChoices)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sourcePicker: some View {
        GroupBox("Select items, then Upload") {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button("Select Apps, Files or Folders…", systemImage: "folder.badge.plus") {
                        workspace.chooseSources(startingAt: content == .applications ? URL(fileURLWithPath: "/Applications", isDirectory: true) : nil,
                                                externalBusy: externalBusy)
                    }.buttonStyle(.borderedProminent)
                    Button("Paste", systemImage: "doc.on.clipboard") { workspace.pasteSources(externalBusy: externalBusy) }
                    if workspace.snapshot?.sources.isEmpty == false {
                        Button("Clear selection") { workspace.clearSelection(externalBusy: externalBusy) }
                    }
                }.disabled(workspace.controlsLocked(externalBusy: externalBusy))
                Text("Select multiple items together, drop them here, or paste files copied in Finder. Applications stay complete; folders include all nested contents and Mac metadata.")
                    .font(.caption).foregroundStyle(.secondary)
                Label("New selections: " + workspace.uploadTargetName, systemImage: "folder")
                    .font(.caption).foregroundStyle(.secondary)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 8) {
                        ForEach(workspace.snapshot?.sources ?? []) { source in
                            HStack {
                                Image(systemName: uploadIcon(source.kind))
                                VStack(alignment: .leading) {
                                    Text(source.name)
                                    Text(source.path).font(.caption).foregroundStyle(.secondary)
                                        .lineLimit(1).truncationMode(.middle)
                                    if source.parentKey != nil {
                                        Text(workspace.parentLabel(for: source)).font(.caption2).foregroundStyle(.secondary)
                                    }
                                }
                                Spacer()
                                Button("Remove") { workspace.remove(sourceID: source.id, externalBusy: externalBusy) }
                                    .disabled(workspace.controlsLocked(externalBusy: externalBusy))
                            }
                        }
                    }
                }.frame(maxHeight: 220)
                if workspace.snapshot?.sources.isEmpty != false {
                    Text("No upload sources selected.").foregroundStyle(.secondary)
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(dropTarget ? Color.accentColor : .clear, lineWidth: 2))
        .dropDestination(for: URL.self) { urls, _ in
            guard !workspace.controlsLocked(externalBusy: externalBusy) else { return false }
            workspace.addDroppedURLs(urls, content: nil, externalBusy: externalBusy, parentKey: workspace.uploadTargetParentKey)
            return true
        } isTargeted: { dropTarget = $0 }
    }

    private var sourceTree: some View {
        GroupBox("Local files") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Button("Selected items") { Task { await workspace.browse(path: nil) } }
                    ForEach(workspace.quickEntries) { entry in
                        Button(entry.path == "/Applications" ? "Applications" : "My Applications") {
                            Task { await workspace.browse(path: entry.path) }
                        }
                    }
                    if let path = workspace.tree?.path {
                        Button("Parent folder", systemImage: "arrow.up") {
                            Task { await workspace.browse(path: URL(fileURLWithPath: path).deletingLastPathComponent().path) }
                        }
                    }
                }.disabled(workspace.isTreeLoading || workspace.isMutationPending)
                if let tree = workspace.tree {
                    Text(tree.path ?? "Selected upload items").font(.caption).foregroundStyle(.secondary)
                        .lineLimit(1).truncationMode(.middle)
                    if tree.atomic { Label("Application bundle — uploaded as one item", systemImage: "app") }
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(tree.children) { node in
                                HStack {
                                    Toggle(isOn: Binding(get: { workspace.includes(path: node.path) },
                                                         set: { _ in workspace.toggleTreeNode(node, externalBusy: externalBusy) })) {
                                        Label(node.name, systemImage: uploadIcon(node.kind))
                                    }.toggleStyle(.checkbox)
                                        .disabled(!node.selectable || node.symlink || workspace.controlsLocked(externalBusy: externalBusy)
                                                  || (workspace.includes(path: node.path) && workspace.selectedSource(path: node.path) == nil))
                                    if node.kind == "app" { Text("Application").font(.caption).foregroundStyle(.secondary) }
                                    if node.symlink { Text("Link").font(.caption).foregroundStyle(.secondary) }
                                    Spacer()
                                    if node.kind == "folder" && node.hasChildren && !node.symlink {
                                        Button("Browse") { Task { await workspace.browse(path: node.path) } }
                                            .disabled(workspace.isTreeLoading)
                                    }
                                }
                            }
                        }
                    }.frame(maxHeight: 280)
                    if tree.truncated {
                        Text("This folder contains more items than the preview limit. Select the complete folder in the picker to include everything.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                } else if workspace.isTreeLoading { ProgressView("Loading folder…") }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var uploadQueue: some View {
        GroupBox("Upload") {
            VStack(alignment: .leading, spacing: 10) {
                destinationBadge
                DisclosureGroup("Selected items: \(workspace.snapshot?.sources.count ?? 0)") {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 5) {
                            ForEach(workspace.snapshot?.sources ?? []) { source in
                                Label(source.name, systemImage: uploadIcon(source.kind)).help(source.path)
                            }
                        }
                    }.frame(maxHeight: 180)
                }
                Toggle("Use Red-SecretsXAI encryption", isOn: $workspace.encryptionEnabled)
                    .toggleStyle(.checkbox)
                    .disabled(workspace.controlsLocked(externalBusy: externalBusy))
                Text(workspace.encryptionEnabled ? "Red-SecretsXAI encryption and red-X barcode protection are enabled. This option stays intact." : "Fast unencrypted upload: files, folder archives and apps can be read by anyone with server storage access. Never use this mode for sensitive data. Existing encrypted backups are unchanged.")
                    .font(.caption).foregroundStyle(workspace.encryptionEnabled ? Color.secondary : Color.orange)
                Toggle("Move originals to Trash after a verified cloud backup and restore check", isOn: $workspace.offload)
                    .disabled(workspace.controlsLocked(externalBusy: externalBusy))
                Text("Leave unchecked to keep originals on this computer. Verification failures keep originals in place.")
                    .font(.caption).foregroundStyle(.secondary)
                Toggle("Close running selected Mac apps before upload (force quit if needed)", isOn: $workspace.closeRunningApps)
                    .toggleStyle(.checkbox)
                    .disabled(workspace.controlsLocked(externalBusy: externalBusy))
                Text("Only apps you selected are affected. A normal terminate is attempted first; force quit can discard unsaved work. This choice is frozen for each upload job and is off by default.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Upload", systemImage: "icloud.and.arrow.up") {
                        workspace.progressVisible = true
                        workspace.enqueueAndStart(externalBusy: externalBusy)
                    }.buttonStyle(.borderedProminent).disabled(workspace.controlsLocked(externalBusy: externalBusy)
                               || workspace.snapshot?.sources.isEmpty != false || !workspace.destinationAvailable)
                    if workspace.hasQueuedJobs {
                        Button("Start queued uploads") { workspace.startQueuedUploads(externalBusy: externalBusy) }
                            .disabled(workspace.controlsLocked(externalBusy: externalBusy))
                    }
                    if workspace.workerPending || workspace.hasRunningJob {
                        ProgressView().controlSize(.small)
                        Button(workspace.progressVisible ? "Upload in background" : "Show progress") { workspace.progressVisible.toggle() }
                        if workspace.progressVisible { Button("Hide progress") { workspace.progressVisible = false } }
                    }
                }
                if !workspace.progressVisible && (workspace.workerPending || workspace.hasRunningJob) {
                    Text("Uploading in the background. You can browse other views; keep GenDragoon open until verification finishes.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                ForEach(workspace.snapshot?.jobs ?? []) { job in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(job.state.capitalized).fontWeight(.semibold)
                            Spacer()
                            Text("\(job.completedItems) / \(job.totalItems) items").font(.caption)
                        }
                        HStack {
                            Text(workspace.displayLabel(for: job.destination)).font(.caption).foregroundStyle(.secondary)
                            if job.state == "queued" {
                                Button("Cancel queued upload") { workspace.cancelQueued(jobID: job.id, externalBusy: externalBusy) }
                                    .disabled(workspace.controlsLocked(externalBusy: externalBusy))
                            }
                        }
                        if workspace.progressVisible || job.state != "running", job.totalItems > 0 {
                            uploadProgress(job)
                        }
                        DisclosureGroup("\(job.sources.count) source items") {
                            let items = Dictionary(job.items.map { ($0.sourceID, $0) }, uniquingKeysWith: { _, newer in newer })
                            ForEach(job.sources) { source in
                                let item = items[source.id]
                                HStack {
                                    Image(systemName: uploadIcon(source.kind))
                                    Text(source.name)
                                    Spacer()
                                    Text(item?.state.capitalized ?? "Pending").font(.caption)
                                }
                                if let message = item?.message, !message.isEmpty {
                                    Text(UploadMessage.safe(message)).font(.caption).foregroundStyle(.secondary)
                                }
                                if item?.offloaded == true {
                                    Label("Original moved to Trash after verification", systemImage: "trash").font(.caption)
                                }
                            }
                        }
                        if let error = job.error, !error.isEmpty {
                            Text(UploadMessage.safe(error)).font(.caption).foregroundStyle(.red)
                        }
                        Label((job.encrypted ?? true) ? "Encrypted red-X barcode transfer" : "Fast unencrypted PNG transfer", systemImage: (job.encrypted ?? true) ? "lock.shield.fill" : "lock.open.fill")
                            .font(.caption).foregroundStyle(.secondary)
                        Text(job.offload ? "Originals policy: Trash only after verification" : "Originals policy: kept on this computer")
                            .font(.caption).foregroundStyle(.secondary)
                        if job.closeRunningApps == true {
                            Text("Running selected apps: close automatically (force quit if necessary)")
                                .font(.caption).foregroundStyle(.orange)
                        }
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 6)
                }
                Text("Progress updates while uploads run. Hiding progress keeps the worker running. Queued uploads can be cancelled before they start.")
                    .font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private func uploadProgress(_ job: UploadJob) -> some View {
        let rawFraction = job.state == "succeeded" ? 1 : job.progress?.fraction ?? Double(job.completedItems) / Double(max(1, job.totalItems))
        let fraction = rawFraction.isFinite ? min(1, max(0, rawFraction)) : 0
        let percent = Int((fraction * 100).rounded(.down))
        GeometryReader { geometry in
            ZStack {
                Capsule().fill(Color.secondary.opacity(0.2))
                HStack(spacing: 0) {
                    Capsule().fill(Color.purple).frame(width: geometry.size.width * fraction)
                    Spacer(minLength: 0)
                }
                Text("\(percent) / 100").font(.caption.monospacedDigit().bold()).foregroundStyle(.primary)
            }
            .animation(.linear(duration: 0.5), value: fraction)
        }.frame(height: 26)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Upload progress")
            .accessibilityValue("\(percent) percent")
        HStack {
            Text("\(percent)% · \(percent) / 100")
            Spacer()
            if job.state == "running" {
                if let eta = job.progress?.overallETASeconds, eta.isFinite, eta >= 0 {
                    Text("Est. total remaining: \(duration(eta))")
                } else if let eta = job.progress?.etaSeconds, eta.isFinite, eta >= 0 {
                    Text("About \(duration(eta)) left in this phase")
                } else { Text("Estimating ETA…") }
            }
        }.font(.caption).foregroundStyle(.secondary)
        Text(job.state == "succeeded" ? "Complete" : job.progress?.phaseLabel ?? (job.state == "queued" ? "Waiting" : "Preparing"))
            .font(.caption).foregroundStyle(.secondary)
        if let progress = job.progress {
            if let total = progress.totalBytes, total.isFinite, total > 0 {
                Text("\(byteCount(progress.completedBytes ?? 0)) / \(byteCount(total)) in this phase")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let objects = progress.objectsDone, let total = progress.objectsTotal {
                Text("\(objects) / \(total) barcode objects transferred").font(.caption).foregroundStyle(.secondary)
            }
            if let sent = progress.uploadedBytes, sent.isFinite, sent > 0 {
                Text("Sent \(byteCount(sent))" + ((progress.downloadedBytes ?? 0) > 0 ? " · Received \(byteCount(progress.downloadedBytes ?? 0))" : ""))
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let saved = progress.savedNetworkSeconds, saved.isFinite, saved >= 1, (progress.workers ?? 1) > 1 {
                Text("Estimated network time saved with \(progress.workers ?? 1) workers: \(duration(saved)). Encoding and verification time are excluded.")
                    .font(.caption).foregroundStyle(.secondary)
            }
        }
    }

    private func duration(_ seconds: Double) -> String {
        guard seconds.isFinite else { return "Estimating…" }
        if seconds > 31_536_000 { return "over a year" }
        let value = max(0, Int(min(31_536_000, seconds).rounded(.up)))
        return value < 60 ? "\(value)s" : value < 3600 ? "\((value + 59) / 60) min" : "\(value / 3600)h \((value % 3600) / 60)m"
    }
    private func byteCount(_ value: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(value.isFinite ? min(9_000_000_000_000_000_000, max(0, value)) : 0), countStyle: .file)
    }

    @ViewBuilder private var destinationBadge: some View {
        if workspace.snapshot?.destination != nil {
            Label(workspace.displayLabel(for: workspace.snapshot?.destination), systemImage: "lock.shield").font(.caption).textSelection(.enabled)
        } else {
            Text("No upload destination selected.").font(.caption).foregroundStyle(.secondary)
        }
    }
}

private func uploadIcon(_ kind: String) -> String {
    switch kind {
    case "app": return "app"
    case "folder": return "folder"
    default: return "doc"
    }
}

struct UploadDestination: Codable, Hashable, Sendable {
    let project: String
    let bucket: String
    let remote: String
    let prefix: String
    var label: String { "\(project) / \(bucket)" + (prefix.isEmpty ? "" : " / \(prefix)") }
}

struct UploadSource: Decodable, Identifiable, Sendable {
    let id: String
    let path: String
    let name: String
    let kind: String
    let parentKey: String?
    enum CodingKeys: String, CodingKey { case id, path, name, kind; case parentKey = "parent_key" }
}
struct UploadProgress: Decodable, Sendable {
    let fraction: Double
    let phase: String
    let completedBytes: Double?
    let totalBytes: Double?
    let etaSeconds: Double?
    let overallETASeconds: Double?
    let workers: Int?
    let savedNetworkSeconds: Double?
    let objectsDone: Int?
    let objectsTotal: Int?
    let uploadedBytes: Double?
    let downloadedBytes: Double?
    var phaseLabel: String {
        switch phase {
        case "preparing": return "Preparing"
        case "snapshot", "snapshotting": return "Checking files"
        case "archiving": return "Creating archive"
        case "encoding": return "Encoding barcodes"
        case "uploading": return "Uploading"
        case "publishing": return "Saving archive index"
        case "readback", "downloading": return "Downloading verification copy"
        case "decoding": return "Decoding verification copy"
        case "restoring": return "Restoring verification copy"
        case "verifying": return "Verifying"
        case "offloading": return "Moving verified originals to Trash"
        case "complete": return "Complete"
        default: return "Preparing"
        }
    }
    enum CodingKeys: String, CodingKey {
        case fraction, phase, workers
        case completedBytes = "completed_bytes", totalBytes = "total_bytes", etaSeconds = "eta_seconds"
        case overallETASeconds = "overall_eta_seconds"
        case savedNetworkSeconds = "saved_network_seconds", objectsDone = "objects_done", objectsTotal = "objects_total"
        case uploadedBytes = "uploaded_bytes", downloadedBytes = "downloaded_bytes"
    }
}
struct UploadJobItem: Decodable, Sendable {
    let sourceID: String
    let state: String
    let message: String?
    let offloaded: Bool?
    enum CodingKeys: String, CodingKey { case sourceID = "source_id"; case state, message, offloaded }
}
struct UploadJob: Decodable, Identifiable, Sendable {
    let id: String
    let state: String
    let destination: UploadDestination
    let sources: [UploadSource]
    let offload: Bool
    let encrypted: Bool?
    let closeRunningApps: Bool?
    let items: [UploadJobItem]
    let completedItems: Int
    let totalItems: Int
    let error: String?
    let progress: UploadProgress?
    enum CodingKeys: String, CodingKey {
        case id, state, destination, sources, offload, encrypted, items, error, progress
        case closeRunningApps = "close_running_apps"
        case completedItems = "completed_items"
        case totalItems = "total_items"
    }
}
struct UploadWorkspaceSnapshot: Decodable, Sendable {
    let revision: Int
    let destination: UploadDestination?
    let sources: [UploadSource]
    let jobs: [UploadJob]
    let activeJobID: String?
    enum CodingKeys: String, CodingKey {
        case revision, destination, sources, jobs
        case activeJobID = "active_job_id"
    }
}
struct UploadTreeNode: Decodable, Identifiable, Sendable {
    let id: String
    let path: String
    let name: String
    let kind: String
    let hasChildren: Bool
    let selectable: Bool
    let symlink: Bool
    enum CodingKeys: String, CodingKey {
        case id, path, name, kind, selectable, symlink
        case hasChildren = "has_children"
    }
}
struct UploadTree: Decodable, Sendable {
    let path: String?
    let name: String
    let kind: String
    let atomic: Bool
    let children: [UploadTreeNode]
    let truncated: Bool
}
struct UploadEnvelope: Decodable, Sendable {
    let ok: Bool
    let state: UploadWorkspaceSnapshot?
    let message: String?
    let error: String?
    let tree: UploadTree?
    let quickEntries: [UploadTreeNode]?
    enum CodingKeys: String, CodingKey {
        case ok, state, message, error, tree
        case quickEntries = "quick_entries"
    }
}

@MainActor
final class UploadWorkspaceModel: ObservableObject {
    @Published private(set) var projects: [UploadCloudProject]
    @Published private(set) var readableProjects: [UploadCloudProject] = []
    @Published private(set) var snapshot: UploadWorkspaceSnapshot?
    @Published private(set) var tree: UploadTree?
    @Published private(set) var quickEntries: [UploadTreeNode] = []
    @Published private(set) var isTreeLoading = false
    @Published private(set) var isMutationPending = false
    @Published private(set) var workerPending = false
    @Published private(set) var isRefreshingChoices = false
    @Published private(set) var pickerPending = false
    @Published private(set) var verifiedDestination: UploadDestination?
    @Published var offload = false
    /// Explicit per-upload choice; never silently persist force-quit consent.
    @Published var closeRunningApps = false
    @Published var encryptionEnabled: Bool {
        didSet { UserDefaults.standard.set(encryptionEnabled, forKey: "gd.upload.encryptionEnabled") }
    }
    @Published var progressVisible = true
    @Published private(set) var uploadTargetParentKey: String?
    @Published private(set) var uploadTargetName = "MachineNote root"
    @Published var failure: UploadFailure?
    private var treeEpoch: UInt64 = 0
    private var refreshEpoch: UInt64 = 0
    private var pollingTask: Task<Void, Never>?
    private var reportedBusy = false
    private let onBusyStateChange: @MainActor (Bool) -> Void
    private let sourceAccess: UploadSourceAccess
    private var targetNames: [String: String] = [:]

    init(projects: [UploadCloudProject], requiresSecurityScopedAccess: Bool,
         onBusyStateChange: @escaping @MainActor (Bool) -> Void) {
        self.projects = projects
        encryptionEnabled = UserDefaults.standard.object(forKey: "gd.upload.encryptionEnabled") as? Bool ?? true
        self.onBusyStateChange = onBusyStateChange
        sourceAccess = UploadSourceAccess(required: requiresSecurityScopedAccess)
    }
    var hasRunningJob: Bool {
        snapshot?.activeJobID != nil || snapshot?.jobs.contains { $0.state == "running" } == true
    }
    var hasQueuedJobs: Bool { snapshot?.jobs.contains { $0.state == "queued" } == true }
    var destinationIsListed: Bool {
        guard let saved = snapshot?.destination else { return false }
        return readableProjects.contains { project in
            project.id == saved.project && project.buckets.contains { bucket in
                bucket.id == saved.bucket && bucket.remote == saved.remote && bucket.prefix == saved.prefix
            }
        }
    }
    func isAuthorized(_ destination: UploadDestination) -> Bool {
        guard destination.remote == "redxai", destination.project == "redxai" else { return false }
        return projects.contains { project in
            project.id == destination.project && project.buckets.contains { bucket in
                bucket.id == destination.bucket && bucket.remote == destination.remote && bucket.prefix == destination.prefix
            }
        }
    }
    func isReadable(_ destination: UploadDestination) -> Bool {
        guard destination.remote == "redxai", destination.project == "redxai" else { return false }
        return readableProjects.contains { project in
            project.id == destination.project && project.buckets.contains { bucket in
                bucket.id == destination.bucket && bucket.remote == destination.remote && bucket.prefix == destination.prefix
            }
        }
    }
    func replaceReadableProjects(_ projects: [UploadCloudProject]) {
        readableProjects = projects.filter { $0.id == "redxai" }
    }
    func displayLabel(for destination: UploadDestination?) -> String {
        guard let destination, destination.remote == "redxai" else { return "Choose a MachineNote" }
        let note = readableProjects.first(where: { $0.id == destination.project })?.buckets.first(where: { $0.id == destination.bucket })
        return note.map { "MachineNotes / " + $0.displayName } ?? "MachineNote unavailable"
    }
    var destinationAvailable: Bool {
        guard let destination = snapshot?.destination else { return false }
        return isAuthorized(destination)
    }
    func controlsLocked(externalBusy: Bool) -> Bool {
        snapshot == nil || externalBusy || !GDUpdateActivity.shared.canStart(excluding: self) || isMutationPending || workerPending || hasRunningJob || pickerPending
    }
    func replaceProjects(_ projects: [UploadCloudProject]) {
        self.projects = projects.filter { $0.id == "redxai" }
        if let verifiedDestination, !isAuthorized(verifiedDestination) { self.verifiedDestination = nil }
        // The persisted destination is deliberately never changed here.
    }
    func refreshChoices(using refreshCloud: @MainActor () async -> Void) async {
        guard !isRefreshingChoices else { return }
        isRefreshingChoices = true
        defer { isRefreshingChoices = false }
        await refreshCloud()
        await refresh()
    }
    func startPolling() {
        stopPolling()
        pollingTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(1)) } catch { return }
                guard let self else { return }
                await self.refresh(showError: false)
            }
        }
    }
    func stopPolling() { pollingTask?.cancel(); pollingTask = nil }
    deinit { pollingTask?.cancel() }
    func refresh(showError: Bool = true) async {
        guard let inspection = GDUpdateActivity.shared.beginBackgroundInspection() else { return }
        defer { GDUpdateActivity.shared.endBackgroundInspection(inspection) }
        refreshEpoch &+= 1
        let epoch = refreshEpoch
        do {
            let response = try await call(["state"])
            apply(response.state)
            if !response.ok && showError && epoch == refreshEpoch {
                failure = UploadFailure(response.message ?? response.error ?? "Could not read upload state.")
            }
        } catch {
            if showError && epoch == refreshEpoch { failure = UploadFailure(error.localizedDescription) }
        }
    }
    func browse(path: String?) async {
        treeEpoch &+= 1
        let epoch = treeEpoch
        isTreeLoading = true
        defer { if epoch == treeEpoch { isTreeLoading = false } }
        do {
            var arguments = ["tree"]
            if let path { arguments += ["--path", path] }
            let response = try await call(arguments)
            apply(response.state)
            guard epoch == treeEpoch else { return }
            guard response.ok else {
                throw UploadFailure(response.message ?? response.error ?? "Could not browse this folder.")
            }
            tree = response.tree
            quickEntries = response.quickEntries ?? []
        } catch {
            if epoch == treeEpoch { failure = UploadFailure(error.localizedDescription) }
        }
    }
    func select(_ destination: UploadDestination, externalBusy: Bool) {
        guard isReadable(destination) else { failure = UploadFailure("Choose an available MachineNote."); return }
        mutate(["select-destination", "--project", destination.project, "--bucket", destination.bucket,
                "--remote", destination.remote, "--prefix", destination.prefix], externalBusy: externalBusy)
    }
    func cancelQueued(jobID: String, externalBusy: Bool) {
        mutate(["cancel-job", "--id", jobID], externalBusy: externalBusy)
    }
    func remove(sourceID: String, externalBusy: Bool) {
        mutate(["remove-source", "--id", sourceID], externalBusy: externalBusy)
    }
    func clearSelection(externalBusy: Bool) { mutate(["clear-sources"], externalBusy: externalBusy) }
    func setUploadTarget(parentKey: String?, displayName: String? = nil) {
        guard parentKey == nil || parentKey?.range(of: #"^[a-f0-9]{18}$"#, options: .regularExpression) != nil else { return }
        uploadTargetParentKey = parentKey
        uploadTargetName = parentKey == nil ? "MachineNote root" : displayName ?? "Selected cloud folder"
        if let parentKey { targetNames[parentKey] = uploadTargetName }
    }
    func parentLabel(for source: UploadSource) -> String {
        guard let parentKey = source.parentKey else { return "MachineNote root" }
        return targetNames[parentKey] ?? "Folder saved with this selection"
    }
    func selectedSource(path: String) -> UploadSource? {
        let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
        return snapshot?.sources.first { $0.path == canonical }
    }
    func includes(path: String) -> Bool {
        let canonical = URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path
        return snapshot?.sources.contains { source in
            source.path == canonical || (source.kind == "folder" && canonical.hasPrefix(source.path + "/"))
        } == true
    }
    func toggleTreeNode(_ node: UploadTreeNode, externalBusy: Bool) {
        if let source = selectedSource(path: node.path) { remove(sourceID: source.id, externalBusy: externalBusy) }
        else { addTreeNode(node, externalBusy: externalBusy) }
    }
    func pasteSources(externalBusy: Bool) {
        let urls = NSPasteboard.general.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL] ?? []
        guard !urls.isEmpty else { failure = UploadFailure("Copy applications, files or folders in Finder, then choose Paste."); return }
        addURLs(urls, externalBusy: externalBusy, parentKey: uploadTargetParentKey)
    }
    func chooseSources(startingAt directory: URL?, externalBusy: Bool, content: GDProjectContent? = nil) {
        guard !controlsLocked(externalBusy: externalBusy) else { return }
        let panel = NSOpenPanel()
        panel.title = "Select apps, files or folders"
        panel.message = "Select whole applications, any file type, or complete folders."
        panel.prompt = "Select"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.treatsFilePackagesAsDirectories = false
        panel.showsHiddenFiles = true
        panel.canCreateDirectories = false
        panel.directoryURL = directory
        let selectedParentKey = uploadTargetParentKey
        // No extension/content-type restriction excludes application bundles.
        pickerPending = true
        updateBusyGate()
        panel.begin { [weak self] response in
            Task { @MainActor in
                guard let self else { return }
                self.pickerPending = false
                if response == .OK {
                    self.addURLs(panel.urls, externalBusy: false, parentKey: selectedParentKey)
                }
                self.updateBusyGate()
            }
        }
    }
    func addTreeNode(_ node: UploadTreeNode, externalBusy: Bool) {
        guard node.selectable else { return }
        addURLs([URL(fileURLWithPath: node.path)], externalBusy: externalBusy, parentKey: uploadTargetParentKey)
    }
    func addDroppedURLs(_ urls: [URL], content: GDProjectContent?, externalBusy: Bool, parentKey: String? = nil) {
        guard !urls.isEmpty, urls.allSatisfy({ $0.isFileURL }) else { return }
        addURLs(urls, externalBusy: externalBusy, parentKey: parentKey)
    }
    private func addURLs(_ urls: [URL], externalBusy: Bool, parentKey: String?) {
        guard !controlsLocked(externalBusy: externalBusy) else { return }
        do {
            try sourceAccess.remember(urls)
            let json = String(decoding: try JSONEncoder().encode(urls.map { $0.standardizedFileURL.path }), as: UTF8.self)
            var arguments = ["add-sources", "--paths-json", json]
            if let parentKey { arguments += ["--parent-key", parentKey] }
            mutate(arguments, externalBusy: externalBusy)
        } catch { failure = UploadFailure(error.localizedDescription) }
    }
    func enqueueAndStart(externalBusy: Bool) {
        guard destinationAvailable else {
            failure = UploadFailure("Choose an available MachineNote before uploading.")
            return
        }
        mutate(["enqueue", "--offload", offload ? "true" : "false",
                "--encryption", encryptionEnabled ? "true" : "false",
                "--close-running-apps", closeRunningApps ? "true" : "false"],
               externalBusy: externalBusy, startAfterSuccess: true)
    }
    /// A companion selection is its own immutable job. Retained selections,
    /// folder targets and the native offload checkbox are never repurposed.
    func enqueueCompanion(_ urls: [URL], destination: UploadDestination) async throws -> String {
        guard !controlsLocked(externalBusy: false), isAuthorized(destination),
              let revision = snapshot?.revision, !urls.isEmpty, urls.count <= 64,
              urls.allSatisfy({ $0.isFileURL && $0.path.hasPrefix("/") }) else {
            throw UploadFailure("Wait for current work, then choose an available MachineNote and local sources.")
        }
        isMutationPending = true; updateBusyGate()
        defer { isMutationPending = false; updateBusyGate() }
        try sourceAccess.remember(urls)
        let paths = String(decoding: try JSONEncoder().encode(urls.map(\.path)), as: UTF8.self)
        let target = String(decoding: try JSONEncoder().encode(destination), as: UTF8.self)
        let known = Set(snapshot?.jobs.map(\.id) ?? [])
        let response = try await call(["enqueue-selection", "--paths-json", paths, "--destination-json", target,
                                       "--expected-revision", String(revision)])
        apply(response.state)
        guard response.ok, let job = response.state?.jobs.first(where: { !known.contains($0.id) && $0.state == "queued" }) else {
            throw UploadFailure(response.message ?? "The companion upload was not queued. Existing selections were retained.")
        }
        // Start after the mutation lease has ended, using the normal durable worker.
        Task { @MainActor [weak self] in
            await Task.yield()
            self?.startQueuedUploads(externalBusy: false)
        }
        return job.id
    }
    private func mutate(_ arguments: [String], externalBusy: Bool, startAfterSuccess: Bool = false) {
        guard !controlsLocked(externalBusy: externalBusy), let revision = snapshot?.revision else { return }
        isMutationPending = true
        updateBusyGate()
        Task { [self] in
            var succeeded = false
            do {
                var revisionToUse = revision
                for attempt in 0..<2 {
                    let response = try await call(arguments + ["--expected-revision", String(revisionToUse)])
                    apply(response.state)
                    if response.ok {
                        succeeded = true
                        if arguments.first == "select-destination" { verifiedDestination = response.state?.destination }
                        break
                    }
                    // Background state polling can legitimately advance a
                    // revision between clicking Upload and worker admission.
                    // The server rejects stale CAS without applying it. Retry
                    // at most once against a fresh authoritative snapshot.
                    if response.error == "revision_conflict" && attempt == 0 {
                        await refresh(showError: false)
                        guard !hasRunningJob, let latest = snapshot?.revision else {
                            throw UploadFailure("An upload started while you were editing the selection. Review the queue before retrying.")
                        }
                        revisionToUse = latest
                        continue
                    }
                    throw UploadFailure(response.message ?? response.error ?? "Upload settings were not changed.")
                }
                if succeeded { await browse(path: tree?.path) }
            } catch { failure = UploadFailure(error.localizedDescription) }
            isMutationPending = false
            if succeeded && startAfterSuccess { startQueuedUploads(externalBusy: false) }
            updateBusyGate()
        }
    }
    func startQueuedUploads(externalBusy: Bool) {
        guard !controlsLocked(externalBusy: externalBusy), hasQueuedJobs else { return }
        do {
            let queuedPaths = snapshot?.jobs.filter { $0.state == "queued" }.flatMap { $0.sources.map(\.path) } ?? []
            try sourceAccess.restoreAccess(paths: queuedPaths)
        } catch {
            failure = UploadFailure(error.localizedDescription)
            return
        }
        workerPending = true
        updateBusyGate()
        Task { [self] in
            do {
                while hasQueuedJobs {
                    let queuedIDs = snapshot?.jobs.filter { $0.state == "queued" }.map(\.id) ?? []
                    let response = try await call(["run-next"], worker: true)
                    apply(response.state)
                    guard response.ok else {
                        throw UploadFailure(response.message ?? response.error ?? "An upload failed. Originals were retained unless an item reports verified offload.")
                    }
                    guard snapshot?.jobs.filter({ $0.state == "queued" }).map(\.id) != queuedIDs else {
                        throw UploadFailure("The upload worker did not advance the queued job. Refresh upload state before starting it again.")
                    }
                }
            } catch { failure = UploadFailure(error.localizedDescription) }
            workerPending = false
            await refresh(showError: true)
            updateBusyGate()
        }
    }
    private func apply(_ candidate: UploadWorkspaceSnapshot?) {
        guard let candidate, candidate.revision >= (snapshot?.revision ?? -1) else { return }
        snapshot = candidate
        updateBusyGate()
    }
    private func updateBusyGate() {
        let busy = isMutationPending || pickerPending || workerPending || hasRunningJob
        guard busy != reportedBusy else { return }
        reportedBusy = busy
        GDUpdateActivity.shared.set(self, key: "upload", active: busy)
        onBusyStateChange(busy)
    }
    private func call(_ arguments: [String], worker: Bool = false) async throws -> UploadEnvelope {
        guard let helper = Bundle.main.url(forResource: "gendragoon_upload_workspace", withExtension: "py"),
              FileManager.default.isReadableFile(atPath: helper.path) else {
            throw UploadFailure("The upload workspace helper is missing from this app build.")
        }
        let isMutation = ["select-destination", "add-sources", "remove-source", "clear-sources", "enqueue", "cancel-job"]
            .contains(arguments.first ?? "")
        let privateInput: Data?
        if arguments.first == "run-next" {
            guard let destination = snapshot?.jobs.first(where: { $0.state == "queued" })?.destination,
                  isAuthorized(destination) else {
                throw UploadFailure("A queued upload targets a previous provider or unavailable MachineNote. Cancel that queued upload, then select an available MachineNote.")
            }
            privateInput = try await GDRedXAIAuthSession.shared.privateWorkerInput(
                workspaceID: destination.bucket, constrained: false, requireWrite: true)
        } else {
            privateInput = nil
        }
        let helperArguments = arguments + (privateInput == nil ? [] : ["--performance-stdin"])
        let authChannel = try GDWorkerAuthChannel.make(privateInput)
        let response = try await Task.detached(priority: worker ? .utility : .userInitiated) {
            // Await mutation completion: killing its parent can leave a bounded
            // Configure Cloud child running and committing the chosen context.
            try UploadHelperProcess.run(
                arguments: ["python3", helper.path] + helperArguments,
                timeout: (worker || isMutation) ? nil : 120,
                standardInput: privateInput, authChannel: authChannel
            )
        }.value
        guard !response.ok || response.state != nil else {
            throw UploadFailure("The upload helper omitted authoritative workspace state. Refresh before trying again.")
        }
        return response
    }
}

struct UploadFailure: Error, LocalizedError, Identifiable {
    let id = UUID()
    let message: String
    init(_ message: String) { self.message = UploadMessage.safe(message) }
    var errorDescription: String? { message }
}
private enum UploadHelperProcess {
    /// File-backed capture cannot deadlock on full pipes. All waits occur off-main.
    static func run(arguments: [String], timeout: Double?, standardInput: Data? = nil,
                    authChannel: GDWorkerAuthChannel? = nil) throws -> UploadEnvelope {
        defer { authChannel?.close() }
        guard (standardInput?.count ?? 0) <= 32 * 1024 else { throw UploadFailure("Private helper input exceeded its safety limit.") }
        let manager = FileManager.default
        let directory = manager.temporaryDirectory.appendingPathComponent("gendragoon-upload-\(UUID().uuidString)", isDirectory: true)
        try manager.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
        defer { try? manager.removeItem(at: directory) }
        let outputURL = directory.appendingPathComponent("stdout")
        let errorURL = directory.appendingPathComponent("stderr")
        guard manager.createFile(atPath: outputURL.path, contents: nil, attributes: [.posixPermissions: 0o600]),
              manager.createFile(atPath: errorURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
            throw UploadFailure("Could not create private upload helper output files.")
        }
        let output = try FileHandle(forWritingTo: outputURL)
        let errors = try FileHandle(forWritingTo: errorURL)
        defer { try? output.close(); try? errors.close() }
        let process = Process()
        guard let python = GDRuntime.pythonURL else { throw UploadFailure("A supported Python 3 runtime is unavailable. Run the GenDragoon installer.") }
        process.executableURL = python
        GDRuntime.configurePython(process, arguments: arguments.first == "python3" ? Array(arguments.dropFirst()) : arguments)
        let input = standardInput == nil || authChannel != nil ? nil : Pipe()
        if let authChannel { authChannel.attach(to: process) }
        else if let input { process.standardInput = input }
        else { process.standardInput = FileHandle.nullDevice }
        process.standardOutput = output
        process.standardError = errors
        let completed = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completed.signal() }
        try process.run()
        if let authChannel { try authChannel.start() }
        else if let input, let standardInput {
            try input.fileHandleForWriting.write(contentsOf: standardInput)
            try input.fileHandleForWriting.close()
        }
        let waitResult = timeout.map { completed.wait(timeout: .now() + $0) } ?? completed.wait(timeout: .distantFuture)
        guard waitResult == .success else {
            if process.isRunning { process.terminate() }
            throw UploadFailure("The upload helper timed out. Refresh upload state before trying again.")
        }
        let bytes = try read(outputURL, limit: 5 * 1024 * 1024)
        let response = try? JSONDecoder().decode(UploadEnvelope.self, from: bytes)
        if let response {
            guard process.terminationReason == .exit else { throw UploadFailure("The upload helper stopped unexpectedly. Refresh upload state.") }
            // Failure envelopes carry authoritative CAS/job state; preserve them.
            guard process.terminationStatus == 0 || !response.ok else {
                throw UploadFailure("The upload helper exited unsuccessfully despite a success response.")
            }
            return response
        }
        let errorBytes = (try? read(errorURL, limit: 16_384)) ?? Data()
        let detail = String(decoding: errorBytes, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        throw UploadFailure(detail.isEmpty ? "The upload helper returned an invalid response (exit \(process.terminationStatus))." : detail)
    }
    private static func read(_ url: URL, limit: Int) throws -> Data {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        let data = try handle.read(upToCount: limit + 1) ?? Data()
        guard data.count <= limit else { throw UploadFailure("The upload helper response exceeded its safety limit.") }
        return data
    }
}

/// Bookmarks grant local access only; destination/queue state stays in Python.
private final class UploadSourceAccess {
    private let required: Bool
    private var bookmarks: [String: Data] = [:]
    private var activeURLs: [String: URL] = [:]
    private var loaded = false
    init(required: Bool) { self.required = required }
    deinit { for url in activeURLs.values { url.stopAccessingSecurityScopedResource() } }
    func remember(_ urls: [URL]) throws {
        guard required else { return }
        try load()
        for url in urls {
            let started = url.startAccessingSecurityScopedResource()
            // Python resolves allowed symlink ancestry before persisting paths.
            // Keep the original scoped URL, but use that canonical lookup key.
            let path = canonicalPath(url)
            guard started || activeURLs[path] != nil else {
                throw UploadFailure("Use Select Apps, Files or Folders to grant access to \(url.lastPathComponent).")
            }
            if started {
                if activeURLs[path] == nil { activeURLs[path] = url }
                else { url.stopAccessingSecurityScopedResource() }
            }
            bookmarks[path] = try url.bookmarkData(options: .withSecurityScope, includingResourceValuesForKeys: nil, relativeTo: nil)
        }
        let target = try storeURL()
        try PropertyListEncoder().encode(bookmarks).write(to: target, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: target.path)
    }
    func restoreAccess(paths: [String]) throws {
        guard required else { return }
        try load()
        for path in Set(paths) where activeURLs[path] == nil {
            guard let data = bookmarks[path] else {
                throw UploadFailure("Local access expired. Add \(URL(fileURLWithPath: path).lastPathComponent) again before starting its queued upload.")
            }
            var stale = false
            let url = try URL(resolvingBookmarkData: data, options: [.withSecurityScope, .withoutUI], relativeTo: nil, bookmarkDataIsStale: &stale)
            guard !stale, url.startAccessingSecurityScopedResource() else {
                throw UploadFailure("Local access changed. Add \(URL(fileURLWithPath: path).lastPathComponent) again.")
            }
            guard canonicalPath(url) == path else {
                url.stopAccessingSecurityScopedResource()
                throw UploadFailure("The selected source moved. Add \(url.lastPathComponent) again.")
            }
            activeURLs[path] = url
        }
    }
    private func canonicalPath(_ url: URL) -> String {
        url.resolvingSymlinksInPath().standardizedFileURL.path
    }
    private func load() throws {
        guard !loaded else { return }
        let url = try storeURL()
        if FileManager.default.fileExists(atPath: url.path) {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let data = try handle.read(upToCount: 2 * 1024 * 1024 + 1) ?? Data()
            guard data.count <= 2 * 1024 * 1024 else { throw UploadFailure("The local permission bookmark file is too large.") }
            bookmarks = try PropertyListDecoder().decode([String: Data].self, from: data)
        }
        loaded = true
    }
    private func storeURL() throws -> URL {
        let manager = FileManager.default
        let base = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
        let directory = base.appendingPathComponent("GenDragoon Cloud SSD/UploadUI", isDirectory: true)
        var ancestor = directory
        while ancestor.path != "/" {
            if (try? ancestor.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
                throw UploadFailure("The local permission bookmark folder contains a symbolic link.")
            }
            ancestor.deleteLastPathComponent()
        }
        try manager.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let target = directory.appendingPathComponent("source-bookmarks.plist")
        if (try? target.resourceValues(forKeys: [.isSymbolicLinkKey]).isSymbolicLink) == true {
            throw UploadFailure("The local permission bookmark file is linked and cannot be used.")
        }
        return target
    }
}

private enum UploadMessage {
    static func safe(_ message: String) -> String {
        var result = String(message.prefix(4_096))
        for (pattern, replacement) in [
            (#"(?i)(https?://)[^/\s@]+@"#, "$1[REDACTED]@"),
            (#"([?&][^=\s&]+)=([^&\s]+)"#, "$1=[REDACTED]"),
            (#"(?i)\b((?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|token)\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+"#, "$1[REDACTED]"),
            (#"\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+\b"#, "[REDACTED]"),
            (#"\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b"#, "[REDACTED]")
        ] {
            if let regex = try? NSRegularExpression(pattern: pattern) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: replacement)
            }
        }
        return String(result.components(separatedBy: .controlCharacters).joined(separator: " ").prefix(1_600))
    }
}
