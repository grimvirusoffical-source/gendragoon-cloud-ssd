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
        if let metadataURL = resources?.appendingPathComponent("gendragoon_python_runtime.json"),
           FileManager.default.fileExists(atPath: metadataURL.path) {
            guard let data = try? Data(contentsOf: metadataURL),
                  let metadata = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  metadata["schema"] as? Int == 1, metadata["architecture"] as? String == "arm64",
                  let version = metadata["pythonMajorMinor"] as? String,
                  version.range(of: "^[0-9]+\\.[0-9]+$", options: .regularExpression) != nil else { return nil }
            // Packaged image-codec wheels have a specific Python ABI. Never
            // load those native extensions into a different interpreter.
            let exact = "/Library/Frameworks/Python.framework/Versions/" + version + "/bin/python3"
            return FileManager.default.isExecutableFile(atPath: exact) ? URL(fileURLWithPath: exact) : nil
        }
        let candidates = [
            resources?.appendingPathComponent("gendragoon_python").path,
            "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3",
            "/Library/Frameworks/Python.framework/Versions/3.12/bin/python3",
            "/opt/homebrew/bin/python3", "/usr/local/bin/python3"
        ].compactMap { $0 }
        return candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) })
            .map { URL(fileURLWithPath: $0) }
    }
}

enum GDNativeMessage {
    static func safe(_ value: String) -> String {
        var result = String(value.prefix(1500))
        for pattern in [#"(?i)bearer\s+\S+"#, #"(?:gdsk_|sk_live_|sk_test_|rk_live_|rk_test_|gdpk_|gdpg_|gdpc_|gdt1_|rx_live_|rxca_|rxcr_)[A-Za-z0-9_.-]+"#, #"eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"#] {
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
        let authChannel = try await GDWorkerAuthChannel.make(standardInput)
        return try await Task.detached(priority: .userInitiated) {
            defer { authChannel?.close() }
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
            let input = standardInput == nil || authChannel != nil ? nil : Pipe()
            if let authChannel { authChannel.attach(to: process) }
            else if let input { process.standardInput = input }
            else { process.standardInput = FileHandle.nullDevice }
            process.standardOutput = output
            process.standardError = errors
            try process.run()
            if let authChannel { try authChannel.start() }
            else if let input, let standardInput {
                try input.fileHandleForWriting.write(contentsOf: standardInput)
                try input.fileHandleForWriting.close()
            }
            let writing = resource == "gendragoon_library" && ["upload", "organize"].contains(arguments.first ?? "")
                || resource == "gendragoon_redx_pack" && ["upload-source", "put", "mkdir", "delete"].contains(arguments.first ?? "")
                || resource == "gendragoon_byo_vault" && arguments.first == "install-keymap"
            let deadline = writing ? Date.distantFuture : Date().addingTimeInterval(timeout)
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
    private let redX = GDRedXAIAuthSession.shared
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
        redX.$uploadProjects.sink { [weak self] projects in
            guard let self else { return }
            self.upload.replaceProjects(projects)
        }.store(in: &subscriptions)
        redX.$readableProjects.sink { [weak self] projects in
            guard let self else { return }
            self.upload.replaceReadableProjects(projects)
            if let destination = self.upload.snapshot?.destination, self.upload.isReadable(destination) {
                self.library.adopt(destination)
            } else { self.library.clearDestination() }
        }.store(in: &subscriptions)
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
    var destinationLabel: String { upload.displayLabel(for: selectedDestination) }

    func start() async {
        guard !started else { return }
        started = true
        await upload.refresh()
        upload.startPolling()
        await library.establishSessionStatus()
        library.startSessionMonitoring()
        await redX.restore()
        await refreshCloudChoices()
        if let destination = upload.snapshot?.destination, upload.isReadable(destination) { library.adopt(destination) }
        bootstrapping = false
        library.loadApps()
    }
    func refreshCloudChoices() async {
        guard !cloud.cloudBusy, GDUpdateActivity.shared.canStart(excluding: cloud) else {
            refreshRequested = true; return
        }
        await redX.refreshWorkspaces()
        upload.replaceProjects(redX.uploadProjects)
        upload.replaceReadableProjects(redX.readableProjects)
        if let destination = upload.snapshot?.destination, upload.isReadable(destination) {
            library.adopt(destination)
        } else { library.clearDestination() }
    }
    private func accept(_ snapshot: UploadWorkspaceSnapshot) {
        guard snapshot.revision >= acceptedRevision else { return }
        let changed = snapshot.destination != acceptedDestination
        acceptedRevision = snapshot.revision
        acceptedDestination = snapshot.destination
        guard let destination = snapshot.destination, upload.isReadable(destination) else {
            library.clearDestination(); return
        }
        library.adopt(destination)
        if changed && !bootstrapping { library.loadApps() }
    }
    func verify(project: String, bucket: String, remote: String, prefix: String) {
        let destination = UploadDestination(project: project.trimmingCharacters(in: .whitespacesAndNewlines),
            bucket: bucket.trimmingCharacters(in: .whitespacesAndNewlines),
            remote: remote.trimmingCharacters(in: .whitespacesAndNewlines),
            prefix: prefix.trimmingCharacters(in: .whitespacesAndNewlines))
        guard upload.isReadable(destination) else { return }
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
    @ObservedObject private var redX = GDRedXAIAuthSession.shared
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
                    Text("MACHINENOTES · RED-XAI SERVER").font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(2).foregroundStyle(.purple)
                    Label(content == .applications ? "Applications by platform" : "MachineNote files & folders", systemImage: content == .applications ? "app.badge.fill" : "folder.fill")
                        .font(.system(size: 24, weight: .bold, design: .rounded))
                    Text(native.destinationLabel).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
                }
                Spacer()
                Button { showUpload = true; native.upload.chooseSources(startingAt: nil, externalBusy: native.externalUploadBusy, content: nil) } label: { Label("Select Apps, Files or Folders…", systemImage: "plus") }
                    .buttonStyle(.borderedProminent).tint(.purple).disabled(locked)
                Button { showUpload.toggle() } label: {
                    Label(showUpload ? "Hide Upload Options" : "Upload & Encryption Options", systemImage: "slider.horizontal.3")
                }
                .help("Open the upload queue and choose encrypted or fast unencrypted transfers, even when another protected operation is active.")
                Button { showCleanup.toggle() } label: { Label("Cleanup Drive", systemImage: "folder.badge.gearshape") }
                    .disabled(native.maintenanceBusy)
            }
            Text("Your MachineNotes live on the Red-XAI server. Uploads use Red-SecretsXAI encryption by default; Upload & Encryption Options also offers faster unencrypted PNG storage with a clear warning. Cloud app Play runs on this Mac through verified streaming or cache, not on a remote Mac.")
                .font(.system(size: 11)).foregroundStyle(.secondary)
            if locked {
                HStack(alignment: .firstTextBaseline) {
                    Label(native.upload.workerPending || native.upload.hasRunningJob
                          ? "An upload is still running or being verified. Open Upload & Encryption Options to see its progress."
                          : "Another protected operation is preventing new uploads. Review the operation status and retry.",
                          systemImage: "info.circle")
                        .font(.caption).foregroundStyle(.orange)
                    Spacer()
                    Button("Check Upload State") {
                        Task { await native.upload.refresh(); await native.refreshCloudChoices() }
                    }
                }
            }
            DisclosureGroup("MachineNotes connection", isExpanded: $showConnection) {
                HStack {
                    Label(redX.linked ? "Red-XAI connected" : "Connect your Red-XAI account", systemImage: "lock.shield.fill")
                        .foregroundStyle(redX.linked ? Color.green : Color.secondary)
                    Text(redX.usageSummary).font(.caption.monospaced()).foregroundStyle(.secondary)
                    Spacer()
                    Button("Refresh MachineNotes") { Task { await native.refreshCloudChoices() } }.disabled(locked)
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
            if showUpload || native.upload.hasRunningJob || native.upload.hasQueuedJobs {
                ProjectUploadSection(workspace: native.upload, externalBusy: native.externalUploadBusy, content: content,
                                     onRefreshCloudChoices: { await native.refreshCloudChoices() })
            }
            GDNativeLibrarySection(library: library, destinationLabel: native.destinationLabel, content: content, upload: native.upload, externalBusy: native.externalUploadBusy, showUpload: { showUpload = true })
            if showCleanup {
                GroupBox {
                    if let python = GDRuntime.pythonURL {
                        DriveCleanupSection(isBusy: native.maintenanceBusy, pythonExecutable: python,
                                            acquireExclusiveOperation: { native.acquireCleanup() }, releaseExclusiveOperation: { native.releaseCleanup() })
                    } else { Text("Run the GenDragoon installer to configure the Python runtime.") }
                }
            }
            DisclosureGroup("Managed local cache") {
                VStack(alignment: .leading, spacing: 12) {
                    Label("Account-scoped MachineNotes on your Red-XAI server", systemImage: "externaldrive.fill")
                    Text("Files and applications are decrypted into a verified local cache when you download or launch them. Keeping 10 GB free is recommended; GenDragoon checks the actual space needed and retains caches that changed or are still in use.")
                        .font(.caption).foregroundStyle(.secondary)
                    if cloud.mounted {
                        HStack {
                            Text("A previous Finder drive is still mounted.").font(.caption)
                            Button("Unmount previous drive") { cloud.unmountDrive() }
                                .disabled(cloud.busy || !GDUpdateActivity.shared.canStart(excluding: cloud))
                        }
                    }
                }.frame(maxWidth: .infinity, alignment: .leading).padding(8)
            }
        }
        .padding(24).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 21))
        .overlay(RoundedRectangle(cornerRadius: 21).stroke(dropTarget ? Color.purple : .white.opacity(0.08), lineWidth: dropTarget ? 2 : 1))
        .dropDestination(for: URL.self) { urls, _ in
            guard !locked else { return false }
            native.upload.addDroppedURLs(urls, content: nil, externalBusy: native.externalUploadBusy, parentKey: native.upload.uploadTargetParentKey)
            showUpload = true
            return true
        } isTargeted: { dropTarget = $0 }
        .task { await native.start() }
    }
}
