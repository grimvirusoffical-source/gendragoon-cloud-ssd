import AppKit
import Combine
import Foundation
import SwiftUI

/// The installer verifies this runtime. Helper arguments never pass through a shell.
enum GDRuntime {
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
    static func invoke(_ resource: String, arguments: [String], timeout: TimeInterval = 7200) async throws -> [String: Any] {
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
            process.arguments = [script.path] + arguments
            process.standardInput = FileHandle.nullDevice
            process.standardOutput = output
            process.standardError = errors
            try process.run()
            let deadline = Date().addingTimeInterval(timeout)
            while process.isRunning {
                if Date() >= deadline {
                    process.terminate()
                    throw GDNativeFailure(message: "The helper timed out. Refresh operation status before retrying; your cloud data was not deleted by this request.")
                }
                try await Task.sleep(nanoseconds: 50_000_000)
            }
            process.waitUntilExit()
            let reader = try FileHandle(forReadingFrom: outputURL)
            defer { try? reader.close() }
            let data = try reader.read(upToCount: 8 * 1024 * 1024 + 1) ?? Data()
            guard data.count <= 8 * 1024 * 1024,
                  let result = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw GDNativeFailure(message: "The helper returned an invalid response. Check the operation status before retrying.")
            }
            guard process.terminationStatus == 0, result["ok"] as? Bool == true else {
                throw GDNativeFailure(message: (result["message"] as? String) ?? (result["error"] as? String) ?? "The operation could not finish.")
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
    var externalUploadBusy: Bool { GDUpdateActivity.shared.isBusy(excluding: upload) }
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
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var candidateProject = ""
    @State private var candidateBucket = ""
    @State private var candidateRemote = "gendragoon"
    @State private var candidatePrefix = "GenDragoon-App-Library"
    @State private var showCleanup = false
    private var cloud: CloudModel { native.cloud }
    private var library: LibraryModel { native.library }
    private var locked: Bool { native.externalUploadBusy || native.upload.isMutationPending || native.upload.workerPending }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Applications, files & folders", systemImage: "app.badge.fill")
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                    Text(native.destinationLabel).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer()
                Button { showCleanup.toggle() } label: { Label("Cleanup Drive", systemImage: "folder.badge.gearshape") }
                    .disabled(native.maintenanceBusy)
            }
            GroupBox("Google Cloud connection") {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Button("Connect Google Cloud") { native.connectGoogle() }
                            .buttonStyle(.borderedProminent).tint(.purple).disabled(locked)
                        Button("Refresh Projects & Buckets") { Task { await native.refreshCloudChoices() } }.disabled(locked)
                        Button("Cloud Console") { cloud.openCloudConsole() }
                    }
                    Text(cloud.accountStatus).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
                    DisclosureGroup("Connect a specific project and bucket") {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Enter the Google Cloud project ID that owns the bucket. The current destination changes only after access is verified.")
                                .font(.caption).foregroundStyle(.secondary)
                            HStack {
                                TextField("Google Cloud project ID", text: $candidateProject)
                                TextField("Bucket name", text: $candidateBucket)
                            }.textFieldStyle(.roundedBorder)
                            HStack {
                                TextField("Remote name", text: $candidateRemote)
                                TextField("Upload folder", text: $candidatePrefix)
                            }.textFieldStyle(.roundedBorder)
                            Button("Verify & Use This Destination") {
                                native.verify(project: candidateProject, bucket: candidateBucket, remote: candidateRemote, prefix: candidatePrefix)
                            }.disabled(locked || candidateProject.isEmpty || candidateBucket.isEmpty)
                        }.padding(.top, 8)
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            ProjectUploadSection(workspace: native.upload, externalBusy: native.externalUploadBusy,
                                 onRefreshCloudChoices: { await native.refreshCloudChoices() })
            GDNativeLibrarySection(library: library, destinationLabel: native.destinationLabel)
            if showCleanup {
                GroupBox {
                    if let python = GDRuntime.pythonURL {
                        DriveCleanupSection(isBusy: native.maintenanceBusy, pythonExecutable: python,
                                            acquireExclusiveOperation: { native.acquireCleanup() }, releaseExclusiveOperation: { native.releaseCleanup() })
                    } else { Text("Run the GenDragoon installer to configure the Python runtime.") }
                }
            }
            GroupBox("Cloud drive & cache") {
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
        .task {
            candidateProject = cloud.projectID
            candidateBucket = cloud.bucket
            candidateRemote = cloud.remote
            await native.start()
            if let selected = native.selectedDestination {
                candidateProject = selected.project; candidateBucket = selected.bucket
                candidateRemote = selected.remote; candidatePrefix = selected.prefix
            }
        }
    }
}

@MainActor private struct GDNativeLibrarySection: View {
    @ObservedObject var library: LibraryModel
    let destinationLabel: String
    @ObservedObject private var activity = GDUpdateActivity.shared
    private var busy: Bool { library.busy || !GDUpdateActivity.shared.canStart(excluding: library) }
    var body: some View {
        GroupBox("Your cloud application library") {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(destinationLabel).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    Button("Refresh") { library.loadApps() }.disabled(busy)
                    Button("Scan Cloud Drive") { library.scanCloud() }.disabled(busy || !library.hasDestination)
                }
                Toggle("Remove managed application cache after the app exits", isOn: $library.cleanupAfterExit)
                    .font(.caption)
                Text("Your cloud copy stays available. Modified, in-use, or unverified local caches are retained for review.")
                    .font(.caption).foregroundStyle(.secondary)
                if library.apps.isEmpty { Text("Upload an application, file, or folder to see it here.").foregroundStyle(.secondary).padding(.vertical, 12) }
                ForEach(library.apps) { item in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Label(item.name, systemImage: item.kind == "app" ? "app.fill" : item.kind == "folder" ? "folder.fill" : "doc.fill")
                                .font(.headline)
                            Spacer()
                            if item.kind == "app" {
                                Button("Launch") { library.smartLaunch(item) }.buttonStyle(.borderedProminent).tint(.purple).disabled(busy)
                            } else { Button("Open") { library.launch(item) }.disabled(busy) }
                            Button("Restore") { library.restore(item) }.disabled(busy)
                            Button("Clear Cache") { library.evict(item) }.disabled(busy)
                        }
                        if let session = library.session(for: item.key) {
                            Label(session.message, systemImage: session.active ? "play.circle.fill" : "checkmark.circle")
                                .font(.caption).foregroundStyle(session.active ? Color.green : Color.secondary)
                        }
                    }.padding(12).background(.white.opacity(0.045), in: RoundedRectangle(cornerRadius: 10))
                }
                if library.busy { ProgressView().controlSize(.small) }
                Text(library.message).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
        }
    }
}

@MainActor private struct GDManualProviderSection: View {
    @ObservedObject var library: LibraryModel
    @ObservedObject private var activity = GDUpdateActivity.shared
    var body: some View {
        DisclosureGroup("Other cloud providers · manual configuration") {
            VStack(alignment: .leading, spacing: 10) {
                Text("Configure SFTP, S3-compatible storage, Google Drive, WebDAV or another rclone provider on this Mac. This separate provider library does not change your Google Cloud destination.")
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
