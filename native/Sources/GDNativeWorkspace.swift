import AppKit
import Combine
import Foundation
import SwiftUI

/// The installer verifies this runtime. Helper arguments never pass through a shell.
enum GDRuntime {
    /// Python helpers live inside a sealed app bundle. Descendants must preserve it too.
    static func configurePython(_ process: Process, arguments: [String]) {
        process.arguments = ["-B"] + arguments
        var environment = ProcessInfo.processInfo.environment
        environment["PYTHONDONTWRITEBYTECODE"] = "1"
        process.environment = environment
    }

    static var pythonURL: URL? {
        let resources = Bundle.main.resourceURL
        let candidates = [
            resources?.appendingPathComponent("gendragoon_python").path,
            "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
            "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
            "/Library/Frameworks/Python.framework/Versions/3.11/bin/python3",
            "/Library/Frameworks/Python.framework/Versions/3.10/bin/python3",
            "/opt/homebrew/bin/python3", "/usr/local/bin/python3"
        ].compactMap { $0 }
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
            .map { URL(fileURLWithPath: $0) }
    }
}

enum GDNativeMessage {
    static func safe(_ value: String) -> String {
        var result = String(value.prefix(1500))
        for pattern in [#"(?i)bearer\s+\S+"#, #"(?:gdsk_|sk_live_|sk_test_|rk_live_|rk_test_)[A-Za-z0-9_-]+"#, #"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#] {
            result = result.replacingOccurrences(of: pattern, with: "[redacted]", options: .regularExpression)
        }
        return result
    }
}
struct GDNativeFailure: LocalizedError {
    let message: String
    var errorDescription: String? { GDNativeMessage.safe(message) }
}

enum GDNativeHelper {
    static func invoke(_ resource: String, arguments: [String], timeout: TimeInterval = 7200, standardInput: Data? = nil) async throws -> [String: Any] {
        guard (standardInput?.count ?? 0) <= 32 * 1024 else {
            throw GDNativeFailure(message: "Private helper input exceeded its safety limit.")
        }
        guard let python = GDRuntime.pythonURL,
              let script = Bundle.main.url(forResource: resource, withExtension: "py") else {
            throw GDNativeFailure(message: "The installed app is missing its helper or supported Python runtime. Run the installer to repair it.")
        }
        return try await Task.detached(priority: .userInitiated) {
            let fm = FileManager.default
            let directory = fm.temporaryDirectory.appendingPathComponent("gendragoon-native-" + UUID().uuidString, isDirectory: true)
            try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? fm.removeItem(at: directory) }
            let outputURL = directory.appendingPathComponent("result.json")
            let errorURL = directory.appendingPathComponent("stderr.txt")
            guard fm.createFile(atPath: outputURL.path, contents: nil, attributes: [.posixPermissions: 0o600]),
                  fm.createFile(atPath: errorURL.path, contents: nil, attributes: [.posixPermissions: 0o600]) else {
                throw GDNativeFailure(message: "Could not prepare private helper output.")
            }
            let output = try FileHandle(forWritingTo: outputURL)
            let errors = try FileHandle(forWritingTo: errorURL)
            defer { try? output.close(); try? errors.close() }
            let process = Process()
            process.executableURL = python
            GDRuntime.configurePython(process, arguments: [script.path] + arguments)
            let input = standardInput == nil ? nil : Pipe()
            if let input { process.standardInput = input } else { process.standardInput = FileHandle.nullDevice }
            process.standardOutput = output
            process.standardError = errors
            try process.run()
            if let input, let standardInput {
                try input.fileHandleForWriting.write(contentsOf: standardInput)
                try input.fileHandleForWriting.close()
            }
            let deadline = Date().addingTimeInterval(timeout)
            while process.isRunning {
                if Date() >= deadline {
                    process.terminate()
                    throw GDNativeFailure(message: "The helper timed out. Refresh operation status before retrying; your cloud data was not deleted by this request.")
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            // isRunning is already false: the child has terminated and its
            // terminationStatus is available. A second, synchronous wait can
            // strand a Swift cooperative thread in Foundation's run loop and
            // bypass the deadline above, leaving the UI permanently busy.
            let reader = try FileHandle(forReadingFrom: outputURL)
            defer { try? reader.close() }
            let data = try reader.read(upToCount: 8 * 1024 * 1024 + 1) ?? Data()
            guard data.count <= 8 * 1024 * 1024,
                  let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw GDNativeFailure(message: "The helper returned an invalid response. Check the operation status before retrying.")
            }
            guard process.terminationStatus == 0, result["ok"] as? Bool == true else {
                let serverCode = GDServerCode.read(result)
                throw GDNativeFailure(message: (result["message"] as? String) ?? (serverCode.isEmpty ? nil : serverCode) ?? "The operation could not finish.")
            }
            return result
        }.value
    }
}

@MainActor private final class GDNativeUploadSignal: ObservableObject {
    @Published var busy = false
}

/// Lives above sidebar pages, so navigation never creates a second destination,
/// loses a queued upload, or destroys a running cache/launch coordinator.
@MainActor final class GDNativeWorkspace: ObservableObject {
    static let shared = GDNativeWorkspace()
    let cloud: CloudModel
    let library: LibraryModel
    let manualLibrary: LibraryModel
    let upload: UploadWorkspaceModel
    let cleanupOwner = NSObject()
    let resetOwner = NSObject()
    @Published private(set) var started = false
    private let signal: GDNativeUploadSignal
    private var subscriptions = Set<AnyCancellable>()
    private var acceptedDestination: UploadDestination?
    private var acceptedRevision = -1
    private var bootstrapping = true
    private var refreshRequested = false

    private init() {
        let signal = GDNativeUploadSignal()
        self.signal = signal
        cloud = CloudModel()
        library = LibraryModel()
        manualLibrary = LibraryModel()
        upload = UploadWorkspaceModel(projects: [], requiresSecurityScopedAccess: Self.isSandboxed) { signal.busy = $0 }
        cloud.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
        library.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
        upload.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }.store(in: &subscriptions)
        upload.$snapshot.compactMap { $0 }.sink { [weak self] snapshot in self?.accept(snapshot) }.store(in: &subscriptions)
        cloud.$uploadProjects.sink { [weak self] choices in self?.upload.replaceProjects(choices) }.store(in: &subscriptions)
        GDUpdateActivity.shared.$revision.sink { [weak self] _ in
            guard let self, self.refreshRequested, !self.cloud.cloudBusy,
                  GDUpdateActivity.shared.canStart(excluding: self.cloud) else { return }
            self.refreshRequested = false
            Task { @MainActor in await self.refreshCloudChoices() }
        }.store(in: &subscriptions)
        signal.$busy.dropFirst().sink { [weak self] busy in
            guard let self, !busy else { return }
            self.library.loadApps()
        }.store(in: &subscriptions)
    }
    private static var isSandboxed: Bool {
        ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil
    }
    var externalUploadBusy: Bool { !GDUpdateActivity.shared.canStart(excluding: upload) }
    var maintenanceBusy: Bool { GDUpdateActivity.shared.isBusy }
    var selectedDestination: UploadDestination? { upload.snapshot?.destination }
    var destinationLabel: String { selectedDestination?.label ?? "Verify a project and bucket to choose your destination." }

    func start() async {
        guard !started else { return }
        started = true
        await upload.refresh()
        upload.startPolling()
        await library.establishSessionStatus()
        library.startSessionMonitoring()
        await refreshCloudChoices()
        if let destination = upload.snapshot?.destination { cloud.adopt(destination); library.adopt(destination) }
        bootstrapping = false
        library.loadApps()
    }
    func refreshCloudChoices() async {
        guard !cloud.cloudBusy, GDUpdateActivity.shared.canStart(excluding: cloud) else {
            refreshRequested = true; return
        }
        await cloud.reloadAuthorizedChoices()
        if upload.snapshot?.destination == nil, !cloud.projectID.isEmpty, !cloud.bucket.isEmpty,
           !externalUploadBusy {
            verify(project: cloud.projectID, bucket: cloud.bucket, remote: cloud.remote, prefix: "GenDragoon-App-Library")
        }
    }
    private func accept(_ snapshot: UploadWorkspaceSnapshot) {
        guard snapshot.revision >= acceptedRevision else { return }
        let changed = snapshot.destination != acceptedDestination
        acceptedRevision = snapshot.revision
        acceptedDestination = snapshot.destination
        guard let destination = snapshot.destination else { return }
        cloud.adopt(destination)
        library.adopt(destination)
        if changed && !bootstrapping { library.loadApps() }
    }
    func connectGoogle() {
        cloud.connectGoogle { [weak self] in
            Task { @MainActor in await self?.refreshCloudChoices() }
        }
    }
    func verify(project: String, bucket: String, remote: String, prefix: String) {
        let destination = UploadDestination(project: project.trimmingCharacters(in: .whitespacesAndNewlines),
            bucket: bucket.trimmingCharacters(in: .whitespacesAndNewlines),
            remote: remote.trimmingCharacters(in: .whitespacesAndNewlines),
            prefix: prefix.trimmingCharacters(in: .whitespacesAndNewlines))
        upload.select(destination, externalBusy: externalUploadBusy)
    }
    func acquireCleanup() -> Bool { GDUpdateActivity.shared.beginMaintenance(owner: cleanupOwner) }
    func releaseCleanup() { GDUpdateActivity.shared.endMaintenance(owner: cleanupOwner) }
    func acquireReset() -> Bool { GDUpdateActivity.shared.beginMaintenance(owner: resetOwner) }
    func releaseReset() { GDUpdateActivity.shared.endMaintenance(owner: resetOwner) }
}

@MainActor struct GDNativeWorkspaceView: View {
    @ObservedObject var native: GDNativeWorkspace
    var content: GDProjectContent = .applications
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var showCleanup = false
    @State private var showConnection = false
    @State private var showUpload = false
    @State private var dropTarget = false
    private var cloud: CloudModel { native.cloud }
    private var library: LibraryModel { native.library }
    private var locked: Bool { native.externalUploadBusy || native.upload.isMutationPending || native.upload.workerPending }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("CLOUD LIBRARY").font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(2).foregroundStyle(.purple)
                    Label(content == .applications ? "Managed Mac applications" : "Connected files & folders", systemImage: content == .applications ? "app.badge.fill" : "folder.fill")
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                    Text(native.destinationLabel).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer()
                Button { showUpload.toggle() } label: { Label(content == .applications ? "Add Applications" : "Upload Files or Folders", systemImage: "plus") }
                    .buttonStyle(.borderedProminent).tint(.purple).disabled(locked)
                Button { showCleanup.toggle() } label: { Label("Cleanup Drive", systemImage: "folder.badge.gearshape") }
                    .disabled(native.maintenanceBusy)
            }
            Text("Hosted workspaces use the shared customer bucket and your signed-in account. Bring-your-own storage is an S3-compatible bucket at $5/month per workspace. SFTP, Azure, and WebDAV are coming soon.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            DisclosureGroup("Connect S3-compatible storage", isExpanded: $showConnection) {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Bring-your-own Google Cloud uses S3/HMAC keys. SFTP, Azure, and WebDAV are coming soon and have no connect flow. Performance features cost extra unless you stay on the free performance tier.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text("Hosted files use the signed-in account. A bucket you connect uses S3-compatible keys kept in the macOS Keychain. This screen does not ask for a Google Cloud project, a Cloud Console link, or a destination to verify.")
                        .font(.caption).foregroundStyle(.secondary)
                    Text(cloud.accountStatus).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            if showUpload || native.upload.hasRunningJob || native.upload.hasQueuedJobs {
                ProjectUploadSection(workspace: native.upload, externalBusy: native.externalUploadBusy, content: content,
                                     onRefreshCloudChoices: { await native.refreshCloudChoices() })
            }
            GDNativeLibrarySection(library: library, destinationLabel: native.destinationLabel, content: content)
            if showCleanup {
                GroupBox {
                    if let python = GDRuntime.pythonURL {
                        DriveCleanupSection(isBusy: native.maintenanceBusy, pythonExecutable: python,
                                            acquireExclusiveOperation: { native.acquireCleanup() }, releaseExclusiveOperation: { native.releaseCleanup() })
                    } else { Text("Run the GenDragoon installer to configure the Python runtime.") }
                }
            }
            DisclosureGroup("Finder drive and local cache settings") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Label(cloud.mounted ? "Mounted in Finder" : "Drive disconnected", systemImage: "externaldrive.fill")
                        Spacer()
                        Button("Mount SSD") { cloud.mountDrive() }
                            .disabled(cloud.mounted || cloud.busy || native.selectedDestination == nil || !GDUpdateActivity.shared.canStart(excluding: cloud))
                        Button("Open Finder") { cloud.openMount() }.disabled(!cloud.mounted)
                        Button("Unmount") { cloud.unmountDrive() }.disabled(!cloud.mounted || cloud.busy || !GDUpdateActivity.shared.canStart(excluding: cloud))
                    }
                    HStack {
                        Text("Local drive cache")
                        Picker("Cache allowance", selection: Binding(get: { cloud.cacheGB }, set: { cloud.cacheGB = $0 })) {
                            ForEach([10, 30, 60, 100], id: \.self) { Text("\($0) GB").tag($0) }
                        }.frame(width: 240).disabled(cloud.mounted || native.maintenanceBusy)
                        Button("Open Cache") { cloud.openCache() }
                        Button("View Mount Log") { cloud.openLog() }
                    }
                    Text(cloud.status).font(.caption).foregroundStyle(.secondary)
                    if !cloud.lastError.isEmpty { Text(GDNativeMessage.safe(cloud.lastError)).font(.caption).foregroundStyle(.orange) }
                    Text("Cache limits take effect on the next mount. Active files and pending writes are retained. Application launch below uses a verified managed local copy when streaming is unavailable.")
                        .font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            GDManualProviderSection(library: native.manualLibrary)
        }
        .padding(24).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 21))
        .overlay(RoundedRectangle(cornerRadius: 21).stroke(dropTarget ? Color.purple : .white.opacity(0.08), lineWidth: dropTarget ? 2 : 1))
        .dropDestination(for: URL.self) { urls, _ in
            guard !locked else { return false }
            native.upload.addDroppedURLs(urls, content: content, externalBusy: native.externalUploadBusy)
            showUpload = true
            return true
        } isTargeted: { dropTarget = $0 }
        .task { await native.start() }
    }
}

@MainActor private struct GDNativeLibrarySection: View {
    @ObservedObject var library: LibraryModel
    let destinationLabel: String
    let content: GDProjectContent
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var search = ""
    @State private var category = "all"
    @State private var grid = true
    private let accent = Color(red: 0.72, green: 0.55, blue: 0.96)
    private var busy: Bool { library.busy || !GDUpdateActivity.shared.canStart(excluding: library) }
    private func kind(_ item: StoredApp) -> String { item.kind ?? "app" }
    private func category(_ item: StoredApp) -> String {
        if kind(item) == "folder" { return "folders" }
        switch GDExtensionMap.kind(item.name) {
        case "videos": return "videos"
        case "audio": return "audio"
        case "pictures": return "pictures"
        default: return "files"
        }
    }
    private var items: [StoredApp] {
        library.apps.filter { item in
            (content == .applications ? kind(item) == "app" : kind(item) != "app") &&
            (search.isEmpty || item.name.localizedCaseInsensitiveContains(search)) &&
            (content == .applications || category == "all" || category(item) == category)
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
    private func symbol(_ item: StoredApp) -> String {
        if kind(item) == "app" { return "app.badge.fill" }
        switch category(item) {
        case "folders": return "folder.fill"
        case "videos": return "play.rectangle.fill"
        case "audio": return "waveform"
        case "pictures": return "photo.fill"
        default: return "doc.fill"
        }
    }
    private func controls(_ item: StoredApp) -> some View {
        HStack(spacing: 9) {
            if kind(item) == "app" {
                Button { library.smartLaunch(item) } label: { Label("Launch", systemImage: "play.fill") }
                    .buttonStyle(.borderedProminent).tint(accent)
            }
            Button { library.restore(item) } label: { Label("Download", systemImage: "arrow.down.to.line") }
                .buttonStyle(.bordered).tint(accent)
            Menu {
                if kind(item) != "app" { Button("Open a managed local copy") { library.launch(item) } }
                Button("Clear managed cache") { library.evict(item) }
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 20)
        }.font(.system(size: 11, weight: .medium)).disabled(busy)
    }
    private func tile(_ item: StoredApp) -> some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack {
                Image(systemName: symbol(item)).font(.system(size: 28, weight: .medium)).foregroundStyle(accent)
                    .frame(width: 58, height: 62).background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 15))
                Spacer()
                if let session = library.session(for: item.key), session.active {
                    Label("Running", systemImage: "circle.fill").font(.system(size: 10, weight: .semibold)).foregroundStyle(.green)
                }
            }
            Text(item.name).font(.system(size: 15, weight: .semibold)).lineLimit(2).frame(height: 38, alignment: .topLeading)
            Text(kind(item) == "app" ? "macOS application bundle" : kind(item) == "folder" ? "Complete folder" : "Cloud file")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            if let session = library.session(for: item.key) {
                Text(session.message).font(.system(size: 10)).foregroundStyle(session.active ? Color.green : Color.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            controls(item)
        }.padding(19).frame(maxWidth: .infinity, alignment: .leading)
            .background(accent.opacity(0.055), in: RoundedRectangle(cornerRadius: 17))
            .overlay(RoundedRectangle(cornerRadius: 17).stroke(accent.opacity(0.17)))
    }
    private func row(_ item: StoredApp) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 14) {
                Image(systemName: symbol(item)).font(.system(size: 22)).foregroundStyle(accent).frame(width: 36)
                Text(item.name).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                Spacer(); controls(item)
            }
            if let session = library.session(for: item.key) { Text(session.message).font(.caption).foregroundStyle(session.active ? Color.green : Color.secondary) }
        }.padding(14).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 11))
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 17) {
            HStack(spacing: 12) {
                HStack { Image(systemName: "magnifyingglass").foregroundStyle(.secondary); TextField(content == .applications ? "Find a cloud application…" : "Find connected files…", text: $search).textFieldStyle(.plain) }
                    .padding(11).background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
                Button { grid.toggle() } label: { Image(systemName: grid ? "list.bullet" : "square.grid.2x2") }
                Button("Refresh Library") { library.loadApps() }.disabled(busy)
                Button("Scan Selected Bucket") { library.scanCloud() }.disabled(busy || !library.hasDestination)
            }
            if content == .applications {
                Toggle("Remove managed application cache after the app exits", isOn: $library.cleanupAfterExit).font(.system(size: 12))
                Text("Large eligible applications use verified preloading. Other applications use a verified local install. The cloud copy stays available; changed or in-use local caches are retained.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            } else {
                Picker("Category", selection: $category) { Text("All").tag("all"); Text("Files").tag("files"); Text("Folders").tag("folders"); Text("Videos").tag("videos"); Text("Audio").tag("audio"); Text("Pictures").tag("pictures") }.pickerStyle(.segmented)
            }
            HStack { Text("\(items.count) " + (content == .applications ? "applications" : "items")).font(.caption).foregroundStyle(.secondary); Spacer() }
            if items.isEmpty {
                VStack(spacing: 11) {
                    Image(systemName: content == .applications ? "app.dashed" : "folder.badge.plus").font(.system(size: 35, weight: .light)).foregroundStyle(accent)
                    Text(search.isEmpty ? (content == .applications ? "Add your first cloud application." : "Your connected files and folders appear here.") : "No matching items.").font(.system(size: 15, weight: .semibold))
                    Text("Scan reads the selected bucket's managed library. It does not import objects into a product project's file index.")
                        .font(.system(size: 11)).foregroundStyle(.secondary).multilineTextAlignment(.center)
                }.frame(maxWidth: .infinity).padding(.vertical, 27)
            } else if grid {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 260), spacing: 14)], spacing: 14) { ForEach(items) { tile($0) } }
            } else { LazyVStack(spacing: 9) { ForEach(items) { row($0) } } }
            if library.busy { ProgressView().controlSize(.small) }
            Label(library.message, systemImage: "info.circle").font(.system(size: 11)).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }
}

@MainActor private struct GDManualProviderSection: View {
    @ObservedObject var library: LibraryModel
    @ObservedObject private var activity = GDUpdateActivity.shared
    var body: some View {
        DisclosureGroup("Bring your own S3-compatible bucket") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Connect Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, or Google Cloud with S3/HMAC keys. This is $5/month per workspace. SFTP, Azure, and WebDAV are shown as coming soon and have no connect flow. Performance features cost extra unless you stay on the free performance tier.")
                    .font(.caption).foregroundStyle(.secondary)
                HStack {
                    Button("Open Provider Configuration") { library.openProviderSetup() }
                    Button("Refresh Providers") { library.refresh() }
                }
                Picker("Provider", selection: $library.remote) {
                    Text("Choose provider").tag("")
                    ForEach(library.remotes, id: \.self) { Text($0).tag($0) }
                }
                TextField("Provider bucket / folder", text: $library.folder).textFieldStyle(.roundedBorder)
                Toggle("Move original to Trash after verified upload and restore", isOn: $library.offloadOriginal).font(.caption)
                HStack {
                    Button("Add Applications / Files / Folders") { library.chooseApp() }.disabled(library.remote.isEmpty || library.folder.isEmpty)
                    Button("Scan Provider") { library.scanCloud() }.disabled(library.remote.isEmpty || library.folder.isEmpty)
                }
                ForEach(library.apps) { item in
                    HStack {
                        Text(item.name); Spacer()
                        Button("Open") { library.launch(item) }
                        Button("Restore") { library.restore(item) }
                        Button("Clear Cache") { library.evict(item) }
                    }.font(.caption)
                }
                Text(library.message).font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 10).disabled(library.busy || !GDUpdateActivity.shared.canStart(excluding: library))
        }
    }
}
