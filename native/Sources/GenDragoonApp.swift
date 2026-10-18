import Foundation
import SwiftUI
import AppKit
import Darwin

// Read-only filesystem inventory. The reentrant API owns its buffer, so a
// concurrent system query cannot invalidate a shared getmntinfo snapshot.
private enum GDDarwinMountInventory {
    struct Volume {
        let source: String
        let target: String
        let filesystem: String
    }
    enum InspectionError: Error { case unavailable }

    static func name<T>(_ field: inout T) throws -> String {
        try withUnsafeBytes(of: &field) { bytes in
            guard let end = bytes.firstIndex(of: 0), end > 0,
                  let value = String(bytes: bytes.prefix(end), encoding: .utf8) else {
                throw InspectionError.unavailable
            }
            return value
        }
    }

    static func snapshot() throws -> [Volume] {
        var buffer: UnsafeMutablePointer<statfs>?
        // MNT_NOWAIT reads retained kernel information without refreshing an
        // unreachable network volume. This does not mount or unmount anything.
        let count = getmntinfo_r_np(&buffer, MNT_NOWAIT)
        guard let buffer else { throw InspectionError.unavailable }
        defer { free(UnsafeMutableRawPointer(buffer)) }
        guard count > 0, count <= 10_000 else { throw InspectionError.unavailable }
        var result: [Volume] = []
        result.reserveCapacity(Int(count))
        for index in 0..<Int(count) {
            var entry = buffer[index]
            let target = try name(&entry.f_mntonname)
            guard target.hasPrefix("/") else { throw InspectionError.unavailable }
            result.append(Volume(source: try name(&entry.f_mntfromname), target: target,
                                 filesystem: try name(&entry.f_fstypename)))
        }
        guard result.contains(where: { $0.target == "/" }) else { throw InspectionError.unavailable }
        return result
    }

    static func contains(_ target: String, in volumes: [Volume]) -> Bool {
        // Lexical normalization only. NSString.standardizingPath can consult
        // the filesystem, which is unsafe when an NFS server is unreachable.
        func lexical(_ value: String) -> String {
            var parts: [Substring] = []
            for part in value.split(separator: "/") {
                if part == "." { continue }
                if part == ".." {
                    if !parts.isEmpty { parts.removeLast() }
                } else { parts.append(part) }
            }
            return "/" + parts.joined(separator: "/")
        }
        let expected = lexical(target)
        return volumes.contains {
            lexical($0.target).compare(expected, options: .caseInsensitive) == .orderedSame
        }
    }
}

private enum GD {
    static let support = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/GenDragoon Cloud SSD", isDirectory: true)
    static let cache = support.appendingPathComponent("Cache", isDirectory: true)
    static let mount = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("GenDragoon Cloud SSD", isDirectory: true)
    static let log = support.appendingPathComponent("gendragoon.log")
    static let rcloneConfig = support.appendingPathComponent("gendragoon-rclone.conf")
    static var binary: URL {
        Bundle.main.resourceURL!.appendingPathComponent("rclone")
    }
}

func runTool(_ executable: String, _ args: [String], completion: @escaping (Int32, String) -> Void) {
    DispatchQueue.global(qos: .userInitiated).async {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            process.waitUntilExit()
            let output = String(data: data, encoding: .utf8) ?? ""
            DispatchQueue.main.async { completion(process.terminationStatus, output) }
        } catch {
            DispatchQueue.main.async { completion(-1, error.localizedDescription) }
        }
    }
}

struct CloudChoice: Identifiable, Hashable {
    let id: String
    let name: String
}

enum GDProjects {
    static let displayName = "GenDragoonSSD"
    static let firebaseProjectID = "gendragoonssd"
    // Confirmed from the bucket's owning project via Cloud Resource Manager.
    // This pre-fills the existing connection; helper verification still gates use.
    static let storageProjectID = "gendragood-ssd"
    static let storageProjectDisplayName = "GenDragoonSSD"
    static let personalBucket = "gen-dragoon-ssd"
}

@MainActor final class CloudModel: ObservableObject {
    @Published var remote: String {
        didSet { UserDefaults.standard.set(remote, forKey: "remote") }
    }
    @Published var bucket: String {
        didSet { UserDefaults.standard.set(bucket, forKey: "bucket") }
    }
    @Published var projectID: String {
        didSet { UserDefaults.standard.set(projectID, forKey: "projectID") }
    }
    @Published private(set) var projects: [CloudChoice] = []
    @Published private(set) var buckets: [String] = []
    @Published private(set) var uploadProjects: [UploadCloudProject] = []
    private var discoveryEpoch: UInt64 = 0
    private var selectedPrefix = "GenDragoon-App-Library"
    @Published var accountStatus = "Sign in with Opera to choose a Cloud project."
    @Published var cloudBusy = false { didSet { GDUpdateActivity.shared.set(self, key: "cloudBusy", active: cloudBusy) } }
    @Published var cacheGB: Int {
        didSet { UserDefaults.standard.set(cacheGB, forKey: "cacheGB") }
    }
    @Published var status = "Configure Google Cloud Storage, then test your connection."
    @Published var tested = false
    @Published var mounted = false { didSet { GDUpdateActivity.shared.set(self, key: "mounted", active: mounted) } }
    @Published private(set) var mountStatusKnown = false {
        didSet { GDUpdateActivity.shared.set(self, key: "mountInspection", active: !mountStatusKnown) }
    }
    @Published var busy = false { didSet { GDUpdateActivity.shared.set(self, key: "busy", active: busy) } }
    @Published var lastError = ""
    private var mountProcess: Process?
    private var poller: Timer?

    init() {
        remote = UserDefaults.standard.string(forKey: "remote") ?? "gendragoon"
        bucket = UserDefaults.standard.string(forKey: "bucket") ?? GDProjects.personalBucket
        projectID = UserDefaults.standard.string(forKey: "projectID") ?? GDProjects.storageProjectID
        let saved = UserDefaults.standard.integer(forKey: "cacheGB")
        cacheGB = saved == 0 ? 30 : saved
        try? FileManager.default.createDirectory(at: GD.support, withIntermediateDirectories: true)
        try? FileManager.default.createDirectory(at: GD.cache, withIntermediateDirectories: true)
        poller = Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refreshMountStatus() }
        }
        GDUpdateActivity.shared.set(self, key: "mountInspection", active: true)
        refreshMountStatus()
    }

    deinit { poller?.invalidate() }

    var path: String { "\(remote.trimmingCharacters(in: .whitespaces)):\(bucket.trimmingCharacters(in: .whitespaces))" }
    var binaryInstalled: Bool { FileManager.default.isExecutableFile(atPath: GD.binary.path) }
    var mountPath: String { GD.mount.path }
    var cachePath: String { GD.cache.path }

    private func validInput() -> Bool {
        let n = remote.trimmingCharacters(in: .whitespacesAndNewlines)
        let b = bucket.trimmingCharacters(in: .whitespacesAndNewlines)
        let remoteOK = n.range(of: "^[A-Za-z][A-Za-z0-9_-]{0,49}$", options: .regularExpression) != nil
        let bucketOK = b.range(of: "^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$", options: .regularExpression) != nil
        if !remoteOK || !bucketOK {
            lastError = "Enter your rclone remote name and valid, globally unique Cloud Storage bucket name."
            status = "Please check the remote and bucket fields."
        }
        return remoteOK && bucketOK
    }

    func adopt(_ destination: UploadDestination) {
        let changed = projectID != destination.project || bucket != destination.bucket || remote != destination.remote
        projectID = destination.project
        bucket = destination.bucket
        remote = destination.remote
        selectedPrefix = destination.prefix
        if changed { tested = true; status = "Using verified destination \(destination.project) / \(destination.bucket)." }
    }

    func connectGoogle() { connectGoogle(then: nil) }
    func connectGoogle(then completion: (() -> Void)?) {
        guard !cloudBusy, GDUpdateActivity.shared.canStart(excluding: self) else { return }
        cloudBusy = true
        accountStatus = "Opening Google Cloud authorization in your browser…"
        Task {
            do {
                let result = try await GDNativeHelper.invoke("gendragoon_connect", arguments: ["google-login"], timeout: 900)
                accountStatus = result["message"] as? String ?? "Google Cloud authorization completed."
                cloudBusy = false
                if let completion { completion() } else { await reloadAuthorizedChoices() }
            } catch { cloudBusy = false; accountStatus = GDNativeMessage.safe(error.localizedDescription) }
        }
    }
    func loadProjects() { Task { await reloadAuthorizedChoices() } }
    func loadBuckets() { Task { await reloadAuthorizedChoices() } }
    func reloadAuthorizedChoices() async {
        guard !cloudBusy, GDUpdateActivity.shared.canStart(excluding: self) else { return }
        cloudBusy = true; discoveryEpoch &+= 1
        let generation = discoveryEpoch
        defer { if discoveryEpoch == generation { cloudBusy = false } }
        accountStatus = "Loading authorized projects and buckets…"
        var options: [CloudChoice] = []
        var errors: [String] = []
        do {
            let response = try await GDNativeHelper.invoke("gendragoon_connect", arguments: ["projects"], timeout: 180)
            options = (response["projects"] as? [[String: String]] ?? []).compactMap { value in
                guard let identifier = value["id"], !identifier.isEmpty else { return nil }
                return CloudChoice(id: identifier, name: value["name"] ?? identifier)
            }
        } catch { errors.append(GDNativeMessage.safe(error.localizedDescription)) }
        // Direct bucket permissions may exist even when listing projects is denied.
        // Preserve that exact saved ID; never substitute another project.
        if !projectID.isEmpty, !options.contains(where: { $0.id == projectID }) {
            options.append(CloudChoice(id: projectID, name: projectID))
        }
        var discovered: [UploadCloudProject] = []
        for option in options {
            do {
                let result = try await GDNativeHelper.invoke("gendragoon_connect", arguments: ["buckets", "--project", option.id], timeout: 180)
                guard generation == discoveryEpoch else { return }
                let names = result["buckets"] as? [String] ?? []
                discovered.append(UploadCloudProject(id: option.id, displayName: option.name,
                    buckets: names.map { UploadCloudBucket(id: $0, displayName: $0, remote: remote, prefix: selectedPrefix) }))
            } catch {
                errors.append("\(option.id): \(GDNativeMessage.safe(error.localizedDescription))")
                discovered.append(UploadCloudProject(id: option.id, displayName: option.name, buckets: []))
            }
        }
        guard generation == discoveryEpoch else { return }
        projects = options
        uploadProjects = discovered
        buckets = discovered.first(where: { $0.id == projectID })?.buckets.map(\.id) ?? []
        accountStatus = errors.isEmpty ? "Authorized projects refreshed. Your selected destination was retained." :
            "Some cloud choices could not be refreshed. The saved destination is unchanged. " + errors.joined(separator: " ")
    }
    func useSelectedBucket() {
        // Existing callers route to the same authoritative native workspace.
        GDNativeWorkspace.shared.verify(project: projectID, bucket: bucket, remote: remote, prefix: selectedPrefix)
    }

    func testConnection() {
        guard !busy, !cloudBusy, GDUpdateActivity.shared.canStart(excluding: self) else { return }
        guard binaryInstalled else {
            status = "rclone is missing. Re-run Install.command."
            lastError = "Bundled rclone executable not found."
            return
        }
        guard validInput() else { return }
        busy = true
        tested = false
        lastError = ""
        status = "Checking Google Cloud Storage access…"
        runTool(GD.binary.path, ["--config", GD.rcloneConfig.path, "lsf", path, "--max-depth=1"]) { [weak self] code, result in
            guard let self = self else { return }
            self.busy = false
            self.tested = code == 0
            if code == 0 {
                self.status = "Connection verified. Bucket is accessible."
            } else {
                self.status = "Connection test failed. See the setup guide."
                self.lastError = String(result.prefix(2500))
            }
        }
    }

    func mountDrive() {
        refreshMountStatus()
        guard mountStatusKnown, !mounted, !busy, binaryInstalled, validInput(), GDUpdateActivity.shared.canStart(excluding: self) else { return }
        do {
            try FileManager.default.createDirectory(at: GD.mount, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: GD.cache, withIntermediateDirectories: true)
            let existing = try FileManager.default.contentsOfDirectory(atPath: GD.mount.path)
            guard existing.isEmpty else {
                lastError = "The mount folder contains existing files. Move them somewhere safe before mounting."
                status = "Mount folder is not empty."
                return
            }
        } catch {
            lastError = error.localizedDescription
            return
        }
        let args = [
            "--config", GD.rcloneConfig.path,
            "nfsmount", path, GD.mount.path,
            "--vfs-cache-mode=full",
            "--vfs-cache-max-size=\(cacheGB)G",
            "--vfs-cache-max-age=168h",
            "--vfs-cache-min-free-space=10G",
            "--vfs-write-back=10s",
            "--buffer-size=1M",
            "--vfs-read-ahead=2M",
            "--vfs-read-chunk-size=1M",
            "--vfs-read-chunk-size-limit=16M",
            "--vfs-read-chunk-streams=2",
            "--dir-cache-time=2m",
            "--poll-interval=0",
            "--cache-dir=\(GD.cache.path)",
            "--log-file=\(GD.log.path)",
            "--log-level=INFO",
            "--volname=GenDragoon Cloud SSD",
            "--vfs-links",
            "--file-perms=0755",
            "--dir-perms=0755",
            "--gcs-directory-markers"
        ]
        let task = Process()
        task.executableURL = GD.binary
        task.arguments = args
        // Output is handled by rclone's own rotating log file, not a shell command.
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        busy = true
        status = "Mounting cloud storage…"
        lastError = ""
        task.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.busy = false
                self.mountProcess = nil
                self.refreshMountStatus()
                if !self.mounted && process.terminationStatus != 0 {
                    self.lastError = "rclone ended with code \(process.terminationStatus). Open the mount log for details."
                    self.status = "Mount failed. Read the log for details."
                }
            }
        }
        do {
            try task.run()
            mountProcess = task
            // The NFS mount initializes asynchronously; refresh from macOS's mount table.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
                self?.busy = false
                self?.refreshMountStatus()
                if self?.mounted == false && task.isRunning {
                    self?.status = "Still mounting. If this persists, inspect the log."
                }
            }
        } catch {
            busy = false
            lastError = error.localizedDescription
            status = "Couldn't start rclone."
        }
    }

    func unmountDrive() {
        refreshMountStatus()
        guard mountStatusKnown, mounted, !busy, GDUpdateActivity.shared.canStart(excluding: self) else { return }
        busy = true
        status = "Unmounting… Close any files currently in use."
        runTool("/sbin/umount", [GD.mount.path]) { [weak self] code, result in
            guard let self = self else { return }
            self.busy = false
            if code == 0 {
                if let task = self.mountProcess, task.isRunning { task.terminate() }
                self.mountProcess = nil
                self.mounted = false
                self.status = "Cloud SSD unmounted safely."
                self.lastError = ""
            } else {
                self.lastError = result
                self.status = "Unmount failed. Close open files and try again."
            }
        }
    }

    func refreshMountStatus() {
        let inspectionError = "Could not read macOS volume status. Drive changes and app maintenance are paused until status is available."
        do {
            let volumes = try GDDarwinMountInventory.snapshot()
            let wasMounted = mounted
            mounted = GDDarwinMountInventory.contains(GD.mount.path, in: volumes)
            mountStatusKnown = true
            if lastError == inspectionError {
                lastError = ""
                status = mounted ? "GenDragoon Cloud SSD is mounted in Finder." : "Cloud SSD is disconnected."
            } else if mounted && !wasMounted {
                status = "GenDragoon Cloud SSD is mounted in Finder."
            }
        } catch {
            // Never turn an inspection failure into evidence that a mount is
            // absent. Retain the last observation and block maintenance.
            mountStatusKnown = false
            lastError = inspectionError
            status = "Cloud drive status is unavailable."
        }
    }

    func openMount() {
        if mounted { NSWorkspace.shared.open(GD.mount) }
    }
    func openLog() {
        guard FileManager.default.fileExists(atPath: GD.log.path) else {
            lastError = "No mount log has been created yet."
            return
        }
        NSWorkspace.shared.open(GD.log)
    }
    func openCache() { NSWorkspace.shared.open(GD.cache) }
    func openCloudConsole() {
        runTool("/usr/bin/open", ["-a", "Opera", "https://console.cloud.google.com/storage/browser"]) { [weak self] code, output in
            if code != 0 { self?.lastError = "Could not open Opera: " + String(output.prefix(250)) }
        }
    }
    func openGuide() {
        if let url = Bundle.main.resourceURL?.appendingPathComponent("SETUP.html"),
           FileManager.default.fileExists(atPath: url.path) {
            NSWorkspace.shared.open(url)
        }
    }
    func copyConfigCommand() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString("\"\(GD.binary.path)\" config", forType: .string)
        status = "Configuration command copied. Paste it into Terminal."
    }
}

private struct Panel<Content: View>: View {
    let title: String
    let content: Content
    init(title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .bold, design: .rounded))
                .tracking(2).foregroundStyle(.purple.opacity(0.95))
            content
        }
        .padding(20)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.055), in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).stroke(Color.white.opacity(0.10)))
    }
}

private struct ActionButton: View {
    let title: String
    let systemName: String
    let action: () -> Void
    var isPrimary: Bool = false
    var isDisabled: Bool = false
    var body: some View {
        Button(action: action) {
            Label(title, systemImage: systemName)
                .font(.system(size: 13, weight: .semibold))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 9)
        }
        .buttonStyle(.plain)
        .foregroundStyle(Color.white.opacity(isDisabled ? 0.4 : 1))
        .background(isPrimary ? Color(red: 0.43, green: 0.25, blue: 0.88) : Color.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.white.opacity(0.11)))
        .disabled(isDisabled)
    }
}


struct StoredApp: Decodable, Identifiable {
    let key: String
    let name: String
    let remote: String
    let folder: String
    let kind: String?
    let format: String?
    var id: String { key }
}
struct GDManagedAppSession: Identifiable {
    let key: String
    let name: String
    let state: String
    let pid: Int
    let cleanupPending: Bool
    let mode: String
    let active: Bool
    var id: String { key }
    var message: String {
        if cleanupPending { return mode == "streamed" ? "Streaming from a verified cloud mount · cache cleanup follows exit." : "Running locally · managed cache cleanup follows application exit." }
        switch state {
        case "cleaned", "evicted", "exited-cleaned": return "Local application cache removed. Cloud copy is available."
        case "retained", "exited-retained", "interrupted-retained": return "Local cache retained for review because it changed or remains in use."
        case "failed", "failed-retained": return "The launch or cache cleanup needs attention."
        default: return active ? (mode == "streamed" ? "Application is streaming from its verified cloud mount." : "Application is running from its managed local cache.") : "Application session: " + state
        }
    }
}
@MainActor final class LibraryModel: ObservableObject {
    @Published var remote: String = "" { didSet { if projectID == nil && oldValue != remote { apps = [] } } }
    @Published var folder: String = "" { didSet { if projectID == nil && oldValue != folder { apps = [] } } }
    @Published var remotes: [String] = []
    @Published var apps: [StoredApp] = []
    @Published var message = "Choose a verified cloud destination to load its library."
    @Published var busy = false { didSet { GDUpdateActivity.shared.set(self, key: "library", active: busy) } }
    @Published var offloadOriginal = false
    @Published var cleanupAfterExit: Bool {
        didSet { UserDefaults.standard.set(cleanupAfterExit, forKey: "gd.library.cleanupAfterExit") }
    }
    @Published private(set) var sessions: [GDManagedAppSession] = []
    private var projectID: String?
    private var bucket: String?
    private var monitor: Task<Void, Never>?
    private var sessionStatusKnown = false
    private var manualRunningApps: [URL] = []
    init() {
        cleanupAfterExit = UserDefaults.standard.object(forKey: "gd.library.cleanupAfterExit") as? Bool ?? true
    }
    deinit { monitor?.cancel() }
    var hasDestination: Bool { projectID != nil && bucket != nil && !remote.isEmpty }
    private var context: [String] {
        var values = ["--remote", remote]
        if let projectID, let bucket { values += ["--project", projectID, "--bucket", bucket] }
        return values
    }
    func adopt(_ destination: UploadDestination) {
        guard !busy else { return }
        let changed = projectID != destination.project || bucket != destination.bucket || remote != destination.remote
        projectID = destination.project; bucket = destination.bucket; remote = destination.remote
        folder = destination.bucket + (destination.prefix.isEmpty ? "" : "/" + destination.prefix)
        if changed { apps = [] }
    }
    func session(for key: String) -> GDManagedAppSession? {
        sessions.first { $0.key == key && $0.active } ?? sessions.last { $0.key == key }
    }
    private func invoke(_ args: [String], helper: String = "gendragoon_library", then: @escaping (Bool, [String: Any]) -> Void = { _, _ in }) {
        guard !busy, GDUpdateActivity.shared.canStart(excluding: self) else { return }
        busy = true
        Task {
            do {
                let usesPerformance = ["upload", "restore", "launch"].contains(args.first ?? "")
                let input = usesPerformance ? await GDNativePerformance.shared.helperInput() : nil
                let result = try await GDNativeHelper.invoke(helper,
                    arguments: args + (input == nil ? [] : ["--performance-stdin"]), standardInput: input)
                if let detail = result["message"] as? String { message = GDNativeMessage.safe(detail) }
                else if helper == "gendragoon_app_launch", args.first == "launch" {
                    message = result["mode"] as? String == "streamed" ? "Application launched with optimized cloud preloading." : "Application launched from its verified managed local cache."
                } else if args.first == "evict" { message = "Managed local cache removed; the cloud copy remains available." }
                else { message = "Operation completed." }
                busy = false
                then(true, result)
            } catch { busy = false; message = GDNativeMessage.safe(error.localizedDescription); then(false, [:]) }
        }
    }
    func refresh() {
        invoke(["remotes"]) { [weak self] ok, value in
            guard let self, ok else { return }
            self.remotes = value["remotes"] as? [String] ?? []
            // Discovery never selects a different provider for the user.
            if !self.remote.isEmpty { self.loadApps() }
        }
    }
    func loadApps() {
        guard !remote.isEmpty else { return }
        let expected = context
        invoke(["list"] + expected) { [weak self] ok, value in
            guard let self, ok, self.context == expected, let raw = value["items"],
                  let data = try? JSONSerialization.data(withJSONObject: raw),
                  let items = try? JSONDecoder().decode([StoredApp].self, from: data) else { return }
            self.apps = items
        }
    }
    func chooseApp() {
        guard !busy, !remote.isEmpty, !folder.isEmpty, GDUpdateActivity.shared.canStart(excluding: self) else { return }
        busy = true
        let picker = NSOpenPanel()
        picker.title = "Choose applications, files, or folders"
        picker.canChooseFiles = true; picker.canChooseDirectories = true
        picker.allowsMultipleSelection = true; picker.treatsFilePackagesAsDirectories = false
        picker.showsHiddenFiles = true; picker.directoryURL = URL(fileURLWithPath: "/Applications")
        picker.begin { [weak self] response in
            Task { @MainActor in
                guard let self else { return }
                guard response == .OK else { self.busy = false; return }
                let sources = picker.urls, context = self.context, destination = self.folder, offload = self.offloadOriginal
                let scoped = sources.filter { $0.startAccessingSecurityScopedResource() }
                defer { scoped.forEach { $0.stopAccessingSecurityScopedResource() } }
                do {
                    for source in sources {
                        self.message = "Uploading and verifying \(source.lastPathComponent)…"
                        var args = ["upload", "--source", source.path, "--folder", destination] + context
                        if offload { args.append("--offload") }
                        let input = await GDNativePerformance.shared.helperInput()
                        let result = try await GDNativeHelper.invoke("gendragoon_library",
                            arguments: args + (input == nil ? [] : ["--performance-stdin"]), standardInput: input)
                        self.message = result["message"] as? String ?? "Cloud copy and restore verified."
                    }
                    self.busy = false; self.loadApps()
                } catch { self.busy = false; self.message = GDNativeMessage.safe(error.localizedDescription) }
            }
        }
    }
    func scanCloud() {
        guard !remote.isEmpty, !folder.isEmpty else { return }
        let root = bucket ?? folder.components(separatedBy: "/").first ?? ""
        invoke(["scan", "--root", root] + context) { [weak self] ok, _ in if ok { self?.loadApps() } }
    }
    func launch(_ app: StoredApp) {
        if hasDestination && app.kind == "app" { smartLaunch(app); return }
        invoke(["launch", "--key", app.key] + context) { [weak self] ok, result in
            if ok, app.kind == "app", let path = result["localPath"] as? String {
                self?.manualRunningApps.append(URL(fileURLWithPath: path))
                self?.startSessionMonitoring()
            }
        }
    }
    func smartLaunch(_ app: StoredApp) {
        guard hasDestination else { launch(app); return }
        var args = ["launch", "--key", app.key] + context
        if !cleanupAfterExit { args.append("--keep-cache") }
        invoke(args, helper: "gendragoon_app_launch") { [weak self] ok, _ in
            guard let self else { return }
            GDUpdateActivity.shared.set(self, key: "launchMaintenance", active: true)
            if ok { GDUpdateActivity.shared.set(self, key: "runningApps", active: true) }
            self.startSessionMonitoring()
            Task { @MainActor in await self.refreshSessions() }
        }
    }
    func preload(_ app: StoredApp) { smartLaunch(app) }
    func restore(_ app: StoredApp) { invoke(["restore", "--key", app.key] + context) }
    func evict(_ app: StoredApp) {
        let helper = hasDestination && app.kind == "app" ? "gendragoon_app_launch" : "gendragoon_library"
        invoke(["evict", "--key", app.key] + context, helper: helper)
    }
    func establishSessionStatus() async {
        GDUpdateActivity.shared.set(self, key: "launchMaintenance", active: true)
        await refreshSessions()
    }
    func startSessionMonitoring() {
        guard monitor == nil else { return }
        if !sessionStatusKnown { GDUpdateActivity.shared.set(self, key: "launchMaintenance", active: true) }
        monitor = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshSessions()
                do { try await Task.sleep(for: .seconds(3)) } catch { return }
            }
        }
    }
    private func refreshSessions() async {
        guard let inspection = GDUpdateActivity.shared.beginBackgroundInspection() else { return }
        defer { GDUpdateActivity.shared.endBackgroundInspection(inspection) }
        let running = NSWorkspace.shared.runningApplications.compactMap(\.bundleURL)
        manualRunningApps = manualRunningApps.filter { running.contains($0) }
        do {
            let result = try await GDNativeHelper.invoke("gendragoon_app_launch", arguments: ["status"], timeout: 30)
            sessions = (result["sessions"] as? [[String: Any]] ?? []).compactMap { item in
                guard let key = item["key"] as? String, let state = item["state"] as? String else { return nil }
                return GDManagedAppSession(key: key, name: item["name"] as? String ?? key, state: state,
                    pid: (item["pid"] as? NSNumber)?.intValue ?? 0, cleanupPending: item["cleanupPending"] as? Bool ?? false,
                    mode: item["mode"] as? String ?? "managed-local", active: item["active"] as? Bool ?? false)
            }
            let active = result["active"] as? Bool ?? sessions.contains(where: \.active)
            sessionStatusKnown = true
            GDUpdateActivity.shared.set(self, key: "runningApps", active: active || !manualRunningApps.isEmpty)
            GDUpdateActivity.shared.set(self, key: "launchMaintenance", active: (result["busy"] as? Bool == true) && !active)
        } catch {
            // A failed first read is also unknown activity. Hold maintenance
            // until a successful session snapshot establishes it is safe.
            sessionStatusKnown = false
            GDUpdateActivity.shared.set(self, key: "launchMaintenance", active: true)
            message = "Application session status needs attention: " + GDNativeMessage.safe(error.localizedDescription)
            if !manualRunningApps.isEmpty { GDUpdateActivity.shared.set(self, key: "runningApps", active: true) }
        }
    }
    func openProviderSetup() {
        guard GDUpdateActivity.shared.canStart(excluding: self) else { return }
        func quote(_ value: String) -> String { "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let command = quote(GD.binary.path) + " --config " + quote(GD.rcloneConfig.path) + " config"
        let escaped = command.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        let source = "tell application \"Terminal\" to activate\ntell application \"Terminal\" to do script \"" + escaped + "\""
        var error: NSDictionary?
        NSAppleScript(source: source)?.executeAndReturnError(&error)
        message = error == nil ? "Configure the provider in Terminal, then refresh providers. Credentials stay on this Mac." : "Could not open Terminal provider setup."
    }
}
@MainActor private struct MultiCloudPanel: View {
    @ObservedObject var library: LibraryModel
    var body: some View {
        Panel(title: "S3-compatible storage") {
            Text("Connect Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, MinIO, or Google Cloud with S3/HMAC keys. The workspace fee is $5/month. SFTP, Azure, and WebDAV are coming soon and have no connect flow. Keys stay in the macOS Keychain. The challenge sends a presigned GET, not the nonce.").font(.system(size: 12)).foregroundStyle(.gray)
            HStack {
                ActionButton(title: "Open Manual Terminal Configuration", systemName: "terminal", action: library.openProviderSetup, isPrimary: true)
                ActionButton(title: "Refresh Providers", systemName: "arrow.clockwise", action: library.refresh, isDisabled: library.busy)
            }
            if !library.remotes.isEmpty {
                Picker("Storage Provider",selection:$library.remote) {
                    ForEach(library.remotes,id:\.self) { name in Text(name).tag(name) }
                }
            }
            Text("Providers use the dedicated GenDragoon rclone configuration. A bring-your-own connection does not replace a hosted workspace, and it does not require a Google Cloud Owner role unless the destination itself is Google Cloud.").font(.system(size: 11)).foregroundStyle(.gray)
            Text(library.message).font(.system(size: 11)).foregroundStyle(.gray).textSelection(.enabled)
        }
    }
}
@MainActor private struct CloudAppLibraryPanel: View {
    @ObservedObject var library: LibraryModel
    var body: some View {
        Panel(title: "Cloud Library · Files, Folders & Apps") {
            Text("Archive a copy of a Mac .app bundle to a chosen provider. To run it later, GenDragoon restores a checksum-verified local copy. Apps with separate installers, helpers or license requirements may need more setup.").font(.system(size: 12)).foregroundStyle(.gray)
            TextField("Cloud storage folder",text:$library.folder).textFieldStyle(.roundedBorder)
            Toggle("Offload original after verifying cloud backup (moves original to Trash)", isOn: $library.offloadOriginal)
                .font(.system(size: 12))
            Text("Offload is recoverable until Trash is emptied. Running apps, system apps, and protected locations are blocked.")
                .font(.system(size: 11)).foregroundStyle(.gray)
            HStack {
                ActionButton(title: "Add File / Folder / App", systemName: "plus.app", action: library.chooseApp, isPrimary: true, isDisabled:library.busy || library.remotes.isEmpty)
                ActionButton(title: "Scan Cloud Drive", systemName: "arrow.clockwise", action: library.scanCloud, isDisabled:library.busy)
            }
            ForEach(library.apps) { app in
                HStack {
                    VStack(alignment:.leading) {
                        Text(app.name).font(.system(size: 13,weight:.semibold))
                        Text(app.remote).font(.system(size: 10)).foregroundStyle(.gray)
                    }
                    Spacer()
                    if app.kind == "app" {
                        Button("Preload") { library.preload(app) }.disabled(library.busy || app.format != "raw")
                        Button("Smart Launch") { library.smartLaunch(app) }.disabled(library.busy || app.format != "raw")
                        Button("Run Local Copy") { library.launch(app) }.disabled(library.busy)
                    } else {
                        Button("Open") { library.launch(app) }.disabled(library.busy)
                    }
                    Button("Restore") { library.restore(app) }.disabled(library.busy)
                    Button("Clear Cache") { library.evict(app) }.disabled(library.busy)
                }
                .padding(8).background(Color.white.opacity(0.05),in:RoundedRectangle(cornerRadius:8))
            }
        }
    }
}

@MainActor private struct GoogleConnectionPanel: View {
    @ObservedObject var cloud: CloudModel
    var body: some View {
        Panel(title: "Google Cloud · Browser Login") {
                        Text("GenDragoonSSD · Personal Cloud Storage. Hosted workspaces use your signed-in account on the shared customer bucket. A bucket you connect is S3-compatible and is $5/month. Google Cloud uses S3/HMAC keys. SFTP, Azure, and WebDAV are coming soon. Customer Google sign-in uses the separate Firebase project (gendragoonssd).")
                            .font(.system(size: 12)).foregroundStyle(.gray)
                        HStack(spacing: 10) {
                            ActionButton(title: "Connect Google Cloud · Opera", systemName: "person.crop.circle.badge.checkmark", action: cloud.connectGoogle, isPrimary: true, isDisabled: cloud.cloudBusy)
                            ActionButton(title: "Refresh Projects", systemName: "arrow.clockwise", action: cloud.loadProjects, isDisabled: cloud.cloudBusy)
                        }
                        Text(cloud.accountStatus).font(.system(size: 12)).foregroundStyle(.gray).textSelection(.enabled)
                        if !cloud.projects.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("GOOGLE CLOUD PROJECT").font(.system(size: 10, weight: .medium)).foregroundStyle(.gray)
                                Picker("", selection: $cloud.projectID) {
                                    Text("Choose a project").tag("")
                                    if !cloud.projectID.isEmpty && !cloud.projects.contains(where: { $0.id == cloud.projectID }) {
                                        Text("Manual: \(cloud.projectID)").tag(cloud.projectID)
                                    }
                                    ForEach(cloud.projects) { option in
                                        Text("\(option.name) (\(option.id))").tag(option.id)
                                    }
                                }.labelsHidden().frame(maxWidth: .infinity)
                                    .onChange(of: cloud.projectID) { _ in cloud.loadBuckets() }
                            }
                        }
                        HStack(spacing: 10) {
                            VStack(alignment: .leading, spacing: 5) {
                                Text("STORAGE PROJECT ID · \(GDProjects.displayName)").font(.system(size: 10, weight: .medium)).foregroundStyle(.gray)
                                TextField(GDProjects.storageProjectID, text: $cloud.projectID)
                                    .textFieldStyle(.roundedBorder)
                            }
                            ActionButton(title: "Load Buckets", systemName: "tray.full", action: cloud.loadBuckets, isDisabled: cloud.cloudBusy || cloud.projectID.isEmpty)
                                .frame(width: 145)
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("STORAGE BUCKET").font(.system(size: 10, weight: .medium)).foregroundStyle(.gray)
                            if !cloud.buckets.isEmpty {
                                Picker("", selection: $cloud.bucket) {
                                    ForEach(cloud.buckets, id: \.self) { name in Text(name).tag(name) }
                                }.labelsHidden().frame(maxWidth: .infinity)
                            }
                            TextField("gen-dragoon-ssd", text: $cloud.bucket)
                                .textFieldStyle(.roundedBorder)
                            Text("Keep the existing storage ID: \(GDProjects.storageProjectID). Firebase customer authentication uses \(GDProjects.firebaseProjectID); these project IDs are intentionally different.")
                                .font(.system(size: 10)).foregroundStyle(.gray)
                        }
                        HStack(spacing: 10) {
                            ActionButton(title: "Verify & Connect Bucket", systemName: "externaldrive.badge.checkmark", action: cloud.useSelectedBucket, isPrimary: true, isDisabled: cloud.cloudBusy || cloud.busy || cloud.projectID.isEmpty || cloud.bucket.isEmpty)
                            ActionButton(title: "Refresh Buckets", systemName: "arrow.clockwise", action: cloud.loadBuckets, isDisabled: cloud.cloudBusy)
                        }
                        HStack(spacing: 10) {
                            ActionButton(title: "Test Connection", systemName: "checkmark.shield", action: cloud.testConnection, isDisabled: cloud.busy || cloud.cloudBusy)
                            ActionButton(title: "Cloud Console", systemName: "arrow.up.right", action: cloud.openCloudConsole)
                        }
                        Text("Selected: \(cloud.projectID) / \(cloud.bucket)")
                            .font(.system(size: 11, design: .monospaced)).foregroundStyle(.gray)
                    }
    }
}


struct GenDragoonPlan: Identifiable {
    let id: String
    let gb: Int
    let month: Int
    let transfer: Int
    var yearly: Int { month * 10 }
    var capacity: String { gb >= 1000 ? "\(gb / 1000) TB" : "\(gb) GB" }
}
private let planCatalog: [GenDragoonPlan] = [
    .init(id: "100GB", gb: 100, month: 5, transfer: 10),
    .init(id: "200GB", gb: 200, month: 10, transfer: 20),
    .init(id: "300GB", gb: 300, month: 15, transfer: 30),
    .init(id: "500GB", gb: 500, month: 25, transfer: 50),
    .init(id: "1TB", gb: 1000, month: 49, transfer: 100),
    .init(id: "2TB", gb: 2000, month: 95, transfer: 200),
    .init(id: "3TB", gb: 3000, month: 139, transfer: 300),
    .init(id: "4TB", gb: 4000, month: 179, transfer: 400),
    .init(id: "5TB", gb: 5000, month: 219, transfer: 500),
    .init(id: "6TB", gb: 6000, month: 259, transfer: 600)
]
private struct PlansPanel: View {
    @State private var annual = false
    @State private var selected = "100GB"
    var body: some View {
        Panel(title: "Choose Your Cloud · Plans & Upgrades") {
            HStack {
                VStack(alignment: .leading, spacing: 5) {
                    Text("YOUR SPACE. YOUR GAME LIBRARY.").font(.system(size: 19,weight:.heavy,design:.rounded))
                    Text("Private storage per account · 10 GiB free local cache reserve · restore apps anytime")
                        .font(.system(size: 11)).foregroundStyle(.gray)
                }
                Spacer()
                Picker("Billing", selection: $annual) {
                    Text("Monthly").tag(false)
                    Text("Yearly · 2 months free").tag(true)
                }.pickerStyle(.segmented).frame(width: 270)
            }
            LazyVGrid(columns:[GridItem(.adaptive(minimum:145),spacing:12)],spacing:12) {
                ForEach(planCatalog) { plan in
                    Button { selected = plan.id } label: {
                        VStack(alignment:.leading,spacing:7) {
                            HStack {
                                Text(plan.capacity).font(.system(size:17,weight:.bold,design:.rounded))
                                Spacer()
                                if selected == plan.id { Image(systemName:"checkmark.circle.fill").foregroundStyle(.green) }
                            }
                            Text(annual ? "$\(plan.yearly)/yr" : "$\(plan.month)/mo")
                                .font(.system(size:18,weight:.heavy))
                            Text("\(plan.transfer) GB monthly download allowance")
                                .font(.system(size:10)).foregroundStyle(.gray)
                            Text("Quota-enforced · Extra transfers require upgrade")
                                .font(.system(size:10)).foregroundStyle(.gray)
                        }
                        .frame(maxWidth:.infinity,minHeight:95,alignment:.leading)
                        .padding(12)
                        .background(selected == plan.id ? Color.purple.opacity(0.23) : Color.white.opacity(0.06),in:RoundedRectangle(cornerRadius:12))
                        .overlay(RoundedRectangle(cornerRadius:12).stroke(selected == plan.id ? Color.purple : Color.white.opacity(0.12)))
                    }.buttonStyle(.plain)
                }
            }
            HStack {
                VStack(alignment:.leading,spacing:3) {
                    Text("Your S3-compatible bucket · $5/month").font(.system(size:12,weight:.semibold))
                    Text("Same workspace fee as a hosted workspace. Amazon S3, R2, B2, Wasabi, MinIO, or Google Cloud with S3/HMAC keys. SFTP, Azure, and WebDAV are coming soon. Provider charges stay with that provider.")
                        .font(.system(size:11)).foregroundStyle(.gray)
                }
                Spacer()
            }.padding(12).background(Color.white.opacity(0.05),in:RoundedRectangle(cornerRadius:12))
            Label("Manage storage and performance plans in the checkout panel. Access activates after verified payment.",systemImage:"lock.shield")
                .font(.system(size:12)).foregroundStyle(.orange)
        }
    }
}
private struct WelcomePanel: View {
    var body: some View {
        Panel(title: "Welcome · Set Up Your Cloud SSD") {
            HStack(spacing:14) {
                Image(systemName:"person.crop.circle.badge.checkmark")
                    .font(.system(size:30)).foregroundStyle(.purple)
                VStack(alignment:.leading,spacing:4) {
                    Text("One account. Your private cloud library.").font(.system(size:16,weight:.bold))
                    Text("Customer login through Google in Chrome is coming with the secure GenDragoon service. You can keep using your own configured cloud during development.")
                        .font(.system(size:12)).foregroundStyle(.gray)
                }
            }
            Label("Google quick signup is not enabled until OAuth and the identity-verification backend are deployed.",systemImage:"info.circle")
                .font(.system(size:11)).foregroundStyle(.orange)
        }
    }
}

@MainActor struct LegacyWorkspace: View {
    @StateObject private var native = GDNativeWorkspace.shared
    var body: some View { GDNativeWorkspaceView(native: native) }
}

@MainActor final class GDAppLifetime: NSObject, NSApplicationDelegate {
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        // Only an acknowledged update worker has already quiesced and checked
        // the primary mount. Ordinary Quit retains the full activity gate.
        let blocked = GDUpdateCoordinator.shared.requestsTermination
            ? GDUpdateActivity.shared.isBusyForUpdate(excluding: GDUpdateCoordinator.shared)
            : GDUpdateActivity.shared.hasActiveOperations
        guard blocked else { return .terminateNow }
        let alert = NSAlert()
        alert.messageText = "Finish cloud activity before quitting"
        alert.informativeText = "Wait for transfers and cache operations, close managed applications, and unmount the cloud drive. GenDragoon keeps your pending work open."
        alert.addButton(withTitle: "Keep GenDragoon Open")
        alert.runModal()
        return .terminateCancel
    }
    func applicationWillTerminate(_ notification: Notification) {
        GDUpdateCoordinator.shared.prepareForTermination()
    }
}

@main
struct GenDragoonCloudSSDApp: App {
    @NSApplicationDelegateAdaptor(GDAppLifetime.self) private var appLifetime
    var body: some Scene {
        WindowGroup { GenDragoonStartupRoot() }
            .windowStyle(.titleBar)
    }
}
