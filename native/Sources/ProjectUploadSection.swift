import AppKit
import Combine
import Dispatch
import Foundation
import SwiftUI

/// Populate these values from the authenticated CloudModel, never a default project.
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
    /// remote is the configured rclone section name, without a colon or path.
    public init(id: String, displayName: String, remote: String, prefix: String) {
        self.id = id
        self.displayName = displayName
        self.remote = remote
        self.prefix = prefix
    }
}

/// The host retains this model across sidebar navigation. Every destination
/// badge, application tree and queue observes the same persisted workspace.
@MainActor
enum GDLibraryBrowserMode { case upload, backup }

struct ProjectUploadSection: View {
    private let externalBusy: Bool
    private let onRefreshCloudChoices: @MainActor () async -> Void
    private let content: GDProjectContent?
    private let mode: GDLibraryBrowserMode
    @ObservedObject private var workspace: UploadWorkspaceModel
    @State private var selectedNodeID: String?

    init(workspace: UploadWorkspaceModel, externalBusy: Bool, content: GDProjectContent? = nil,
         mode: GDLibraryBrowserMode = .upload,
         onRefreshCloudChoices: @escaping @MainActor () async -> Void) {
        self.workspace = workspace
        self.externalBusy = externalBusy
        self.content = content
        self.mode = mode
        self.onRefreshCloudChoices = onRefreshCloudChoices
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            destinationPicker
            sourcePicker
            sourceTree
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
        GroupBox("Cloud destination") {
            VStack(alignment: .leading, spacing: 8) {
                Picker("Project / bucket", selection: Binding(
                    get: { workspace.snapshot?.destination },
                    set: { destination in
                        if let destination { workspace.select(destination, externalBusy: externalBusy) }
                    }
                )) {
                    Text("Choose a project and bucket").tag(Optional<UploadDestination>.none).disabled(true)
                    if let saved = workspace.snapshot?.destination, !workspace.destinationIsListed {
                        Text(workspace.destinationAvailable ? saved.label : "Unavailable: \(saved.label)")
                            .tag(Optional(saved)).disabled(true)
                    }
                    ForEach(workspace.projects) { project in
                        ForEach(project.buckets) { bucket in
                            Text("\(project.displayName) / \(bucket.displayName)")
                                .tag(Optional(UploadDestination(project: project.id, bucket: bucket.id,
                                                               remote: bucket.remote, prefix: bucket.prefix)))
                        }
                    }
                }
                .disabled(workspace.controlsLocked(externalBusy: externalBusy))
                destinationBadge
                if workspace.snapshot?.destination != nil && !workspace.destinationAvailable {
                    Text("The saved destination is unavailable in the current authorized cloud choices. It stays selected; refresh access or choose another destination before uploading.")
                        .font(.caption).foregroundStyle(.red)
                } else if workspace.projects.isEmpty && !workspace.destinationAvailable {
                    Text("No destination is selected. Hosted files use your signed-in workspace. A bucket you connect is S3-compatible, including Google Cloud with S3/HMAC keys. SFTP, Azure, and WebDAV are coming soon.")
                        .font(.caption).foregroundStyle(.secondary)
                }
                Button("Refresh cloud projects and upload state") {
                    Task { await workspace.refreshChoices(using: onRefreshCloudChoices) }
                }
                .disabled(workspace.isMutationPending || workspace.isRefreshingChoices)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var sourcePicker: some View {
        GroupBox(mode == .backup ? "Choose an item to back up" : content == .applications ? "Select applications" : content == .files ? "Select files and complete folders" : "Applications, files, and folders") {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    if mode == .backup {
                        Text("Refresh the directory and select an item. A secure backup is offered only when that item does not already have one.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    if mode != .backup && content != .files { Button("Add Applications…", systemImage: "app.badge") {
                        workspace.chooseSources(startingAt: URL(fileURLWithPath: "/Applications", isDirectory: true),
                                                externalBusy: externalBusy, content: .applications)
                    }.buttonStyle(.borderedProminent)
                    Button("My Applications…") {
                        workspace.chooseSources(startingAt: FileManager.default.homeDirectoryForCurrentUser
                            .appendingPathComponent("Applications", isDirectory: true), externalBusy: externalBusy, content: .applications)
                    } }
                    if mode != .backup && content != .applications { Button("Add Files or Folders…", systemImage: "plus") {
                        workspace.chooseSources(startingAt: nil, externalBusy: externalBusy, content: .files)
                    }.buttonStyle(.borderedProminent) }
                }.disabled(workspace.controlsLocked(externalBusy: externalBusy))
                Text(content == .applications ? "Applications are selected as complete bundles. The managed library verifies the archive before launch or offload." : "Select any file type or a complete folder. Nested files, empty folders and Mac metadata are preserved.")
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
    }

    private var sourceTree: some View {
        GroupBox("Upload tree") {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Button("Selected items") { Task { await workspace.browse(path: nil) } }
                    if content != .files { ForEach(workspace.quickEntries) { entry in
                        Button(entry.path == "/Applications" ? "Applications" : "My Applications") {
                            Task { await workspace.browse(path: entry.path) }
                        }
                    } }
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
                            ForEach(tree.children.filter { content == .files ? $0.kind != "app" : content == .applications ? $0.kind != "file" : true }) { node in
                                HStack {
                                    Image(systemName: uploadIcon(node.kind))
                                    Text(node.name)
                                        .onTapGesture { selectedNodeID = node.id }
                                    if node.kind == "app" { Text("Application").font(.caption).foregroundStyle(.secondary) }
                                    if node.symlink { Text("Link").font(.caption).foregroundStyle(.secondary) }
                                    Spacer()
                                    if node.kind == "folder" && node.hasChildren && !node.symlink {
                                        Button("Browse") { Task { await workspace.browse(path: node.path) } }
                                            .disabled(workspace.isTreeLoading)
                                    }
                                    if mode == .backup {
                                        if node.backedUp == true {
                                            Text("Backed up").font(.caption).foregroundStyle(.secondary)
                                        } else if selectedNodeID == node.id {
                                            Button("Make secure backup") {
                                                workspace.addTreeNode(node, externalBusy: externalBusy)
                                                workspace.enqueueAndStart(externalBusy: externalBusy)
                                            }
                                            .buttonStyle(.borderedProminent).tint(.purple)
                                            .disabled(!node.selectable || workspace.controlsLocked(externalBusy: externalBusy))
                                            .accessibilityLabel("Make secure backup of \(node.name)")
                                        }
                                    } else {
                                        Button("Add") { workspace.addTreeNode(node, externalBusy: externalBusy) }
                                        .disabled(!node.selectable || workspace.controlsLocked(externalBusy: externalBusy))
                                        .disabled(content == .applications && node.kind != "app")
                                    }
                                }
                            }
                        }
                    }.frame(maxHeight: 280)
                    if tree.truncated {
                        Text("This folder contains more items than the preview limit. Add the folder to include its complete contents.")
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
                Text("Originals stay on this computer. Verification failures keep originals in place.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    if mode != .backup {
                    Button("Upload selected items", systemImage: "icloud.and.arrow.up") {
                        workspace.enqueueAndStart(externalBusy: externalBusy)
                    }.disabled(workspace.controlsLocked(externalBusy: externalBusy)
                               || workspace.snapshot?.sources.isEmpty != false || !workspace.destinationAvailable)
                    }
                    if workspace.hasQueuedJobs {
                        Button("Start queued uploads") { workspace.startQueuedUploads(externalBusy: externalBusy) }
                            .disabled(workspace.controlsLocked(externalBusy: externalBusy))
                    }
                    if workspace.workerPending || workspace.hasRunningJob {
                        ProgressView().controlSize(.small)
                        Text("Preparing or uploading…").font(.caption)
                    }
                }
                ForEach(workspace.snapshot?.jobs ?? []) { job in
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            Text(job.state.capitalized).fontWeight(.semibold)
                            Spacer()
                            Text("\(job.completedItems) / \(job.totalItems) items").font(.caption)
                        }
                        Text(job.destination.label).font(.caption).foregroundStyle(.secondary)
                        if job.totalItems > 0 {
                            ProgressView(value: Double(job.completedItems), total: Double(job.totalItems))
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
                        Text(job.offload ? "Originals policy: Trash only after verification" : "Originals policy: kept on this computer")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding(.vertical, 6)
                }
                Text("Progress updates when each item finishes. Uploads cannot be cancelled from this screen.")
                    .font(.caption).foregroundStyle(.secondary)
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    @ViewBuilder private var destinationBadge: some View {
        if let destination = workspace.snapshot?.destination {
            Label(destination.label, systemImage: "externaldrive.badge.icloud").font(.caption).textSelection(.enabled)
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
    let items: [UploadJobItem]
    let completedItems: Int
    let totalItems: Int
    let error: String?
    enum CodingKeys: String, CodingKey {
        case id, state, destination, sources, offload, items, error
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
    let backedUp: Bool?
    enum CodingKeys: String, CodingKey {
        case id, path, name, kind, selectable, symlink
        case hasChildren = "has_children"
        case backedUp = "backed_up"
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
    @Published var failure: UploadFailure?
    private var treeEpoch: UInt64 = 0
    private var refreshEpoch: UInt64 = 0
    private var pollingTask: Task<Void, Never>?
    private var reportedBusy = false
    private let onBusyStateChange: @MainActor (Bool) -> Void
    private let sourceAccess: UploadSourceAccess

    init(projects: [UploadCloudProject], requiresSecurityScopedAccess: Bool,
         onBusyStateChange: @escaping @MainActor (Bool) -> Void) {
        self.projects = projects
        self.onBusyStateChange = onBusyStateChange
        sourceAccess = UploadSourceAccess(required: requiresSecurityScopedAccess)
    }
    var hasRunningJob: Bool {
        snapshot?.activeJobID != nil || snapshot?.jobs.contains { $0.state == "running" } == true
    }
    var hasQueuedJobs: Bool { snapshot?.jobs.contains { $0.state == "queued" } == true }
    var destinationIsListed: Bool {
        guard let saved = snapshot?.destination else { return false }
        return projects.contains { project in
            project.id == saved.project && project.buckets.contains { bucket in
                bucket.id == saved.bucket && bucket.remote == saved.remote && bucket.prefix == saved.prefix
            }
        }
    }
    var destinationAvailable: Bool {
        guard let destination = snapshot?.destination else { return false }
        if verifiedDestination == destination { return true }
        return projects.contains { project in
            project.id == destination.project && project.buckets.contains { bucket in
                bucket.id == destination.bucket && bucket.remote == destination.remote && bucket.prefix == destination.prefix
            }
        }
    }
    func controlsLocked(externalBusy: Bool) -> Bool {
        snapshot == nil || externalBusy || !GDUpdateActivity.shared.canStart(excluding: self) || isMutationPending || workerPending || hasRunningJob || pickerPending
    }
    func replaceProjects(_ projects: [UploadCloudProject]) {
        self.projects = projects
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
        mutate(["select-destination", "--project", destination.project, "--bucket", destination.bucket,
                "--remote", destination.remote, "--prefix", destination.prefix], externalBusy: externalBusy)
    }
    func remove(sourceID: String, externalBusy: Bool) {
        mutate(["remove-source", "--id", sourceID], externalBusy: externalBusy)
    }
    func chooseSources(startingAt directory: URL?, externalBusy: Bool, content: GDProjectContent? = nil) {
        guard !controlsLocked(externalBusy: externalBusy) else { return }
        let panel = NSOpenPanel()
        panel.title = "Add applications, files, or folders"
        panel.message = "Select whole applications, any file type, or complete folders."
        panel.prompt = "Add"
        panel.canChooseFiles = true
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = true
        panel.treatsFilePackagesAsDirectories = false
        panel.showsHiddenFiles = true
        panel.canCreateDirectories = false
        panel.directoryURL = directory
        // No extension/content-type restriction excludes application bundles.
        pickerPending = true
        updateBusyGate()
        panel.begin { [weak self] response in
            Task { @MainActor in
                guard let self else { return }
                self.pickerPending = false
                if response == .OK {
                    if content == .applications && !panel.urls.allSatisfy({ $0.pathExtension.lowercased() == "app" }) {
                        self.failure = UploadFailure("Choose complete .app bundles here. Use Files for other files or folders.")
                    } else { self.addURLs(panel.urls, externalBusy: false) }
                }
                self.updateBusyGate()
            }
        }
    }
    func addTreeNode(_ node: UploadTreeNode, externalBusy: Bool) {
        guard node.selectable else { return }
        addURLs([URL(fileURLWithPath: node.path)], externalBusy: externalBusy)
    }
    func addDroppedURLs(_ urls: [URL], content: GDProjectContent?, externalBusy: Bool) {
        guard !urls.isEmpty, urls.allSatisfy({ $0.isFileURL }) else { return }
        if content == .applications && !urls.allSatisfy({ $0.pathExtension.lowercased() == "app" }) {
            failure = UploadFailure("Drop complete .app bundles in Applications. Use Files for other content.")
            return
        }
        addURLs(urls, externalBusy: externalBusy)
    }
    private func addURLs(_ urls: [URL], externalBusy: Bool) {
        guard !controlsLocked(externalBusy: externalBusy) else { return }
        do {
            try sourceAccess.remember(urls)
            let json = String(decoding: try JSONEncoder().encode(urls.map { $0.standardizedFileURL.path }), as: UTF8.self)
            mutate(["add-sources", "--paths-json", json], externalBusy: externalBusy)
        } catch { failure = UploadFailure(error.localizedDescription) }
    }
    func enqueueAndStart(externalBusy: Bool) {
        guard destinationAvailable else {
            failure = UploadFailure("Choose an available authorized project and bucket before uploading.")
            return
        }
        mutate(["enqueue", "--offload", offload ? "true" : "false"],
               externalBusy: externalBusy, startAfterSuccess: true)
    }
    private func mutate(_ arguments: [String], externalBusy: Bool, startAfterSuccess: Bool = false) {
        guard !controlsLocked(externalBusy: externalBusy), let revision = snapshot?.revision else { return }
        isMutationPending = true
        updateBusyGate()
        Task { [self] in
            var succeeded = false
            do {
                let response = try await call(arguments + ["--expected-revision", String(revision)])
                apply(response.state)
                guard response.ok else {
                    throw UploadFailure(response.message ?? response.error ?? "Upload settings were not changed.")
                }
                succeeded = true
                if arguments.first == "select-destination" { verifiedDestination = response.state?.destination }
                await browse(path: tree?.path)
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
        let isMutation = ["select-destination", "add-sources", "remove-source", "clear-sources", "enqueue"]
            .contains(arguments.first ?? "")
        let privateInput = arguments.first == "run-next" ? await GDNativePerformance.shared.helperInput() : nil
        let helperArguments = arguments + (privateInput == nil ? [] : ["--performance-stdin"])
        let response = try await Task.detached(priority: worker ? .utility : .userInitiated) {
            // Await mutation completion: killing its parent can leave a bounded
            // Configure Cloud child running and committing the chosen context.
            try UploadHelperProcess.run(
                arguments: ["python3", helper.path] + helperArguments,
                timeout: (worker || isMutation) ? nil : 120,
                standardInput: privateInput
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
    static func run(arguments: [String], timeout: Double?, standardInput: Data? = nil) throws -> UploadEnvelope {
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
        let input = standardInput == nil ? nil : Pipe()
        if let input { process.standardInput = input } else { process.standardInput = FileHandle.nullDevice }
        process.standardOutput = output
        process.standardError = errors
        let completed = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in completed.signal() }
        try process.run()
        if let input, let standardInput {
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
                throw UploadFailure("Use Add Applications or Add Files or Folders to grant access to \(url.lastPathComponent).")
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
