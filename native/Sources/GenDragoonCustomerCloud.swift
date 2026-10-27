import SwiftUI
import AppKit
import Foundation
import CryptoKit

struct GDWorkspaceChoice: Decodable, Identifiable {
    let id: String
    let name: String
    let kind: String
    let storageActive: Bool
    let provisioned: Bool
    let projectStatus: String?
    let projectFeeStatus: String?
    let hasContinuingBilling: Bool?
    var archived: Bool { projectStatus == "archived" }
    var pendingPayment: Bool { projectStatus == "pending_payment" }
    var pendingCapacity: Bool { projectStatus == "payment_confirmed_pending_capacity" }
}
struct GDProjectFolderEntry: Decodable, Identifiable {
    let path: String
    let kind: String
    let sizeBytes: Int64
    var id: String { path }
}
struct GDProjectFolderPreview: Decodable, Identifiable {
    let name: String
    let kind: String
    let entries: [GDProjectFolderEntry]
    let entryCount: Int
    let truncated: Bool
    var id: String { name }
}
private struct GDPreparedProjectFile: Decodable, Sendable {
    let key: String
    let path: String
    let name: String
    let kind: String
    let logicalBytes: Int64
    let sizeBytes: Int64
    let archiveFormat: String
    let manifestSHA256: String
    let entryCount: Int
    var metadata: GDCloudUploadMetadata {
        .init(kind: kind, originalName: name, archiveFormat: archiveFormat,
              manifestSHA256: manifestSHA256, logicalBytes: logicalBytes)
    }
}

private struct GDProjectUploadedFile: Sendable {
    let prepared: GDPreparedProjectFile
    let saved: GDCloudItem
    let downloaded: URL
}

@MainActor private final class GDProjectBatchProgress {
    private let total: Int64
    private let count: Int
    private let started = ProcessInfo.processInfo.systemUptime
    private var received: [String: Int64] = [:]
    private let report: @MainActor (GDTransferProgress) -> Void
    init(items: [GDPreparedProjectFile], report: @escaping @MainActor (GDTransferProgress) -> Void) {
        total = items.reduce(0) { $0 + $1.sizeBytes * 2 }
        count = items.count; self.report = report
    }
    func update(key: String, size: Int64, restoring: Bool, progress: GDTransferProgress) {
        let done = (restoring ? size : 0) + min(size, max(0, progress.completed))
        received[key] = max(received[key] ?? 0, done)
        let completed = received.values.reduce(0, +)
        let phase = count == 1 ? progress.phase : "Uploading and checking \(count) files"
        report(GDTransferProgress(completed: completed, total: total,
            bytesPerSecond: Double(completed) / max(0.001, ProcessInfo.processInfo.systemUptime - started), phase: phase))
    }
}

enum GDProjectContent: String { case files, applications }

@MainActor final class GDFreeCustomerModel: ObservableObject {
    @Published private(set) var choices: [GDWorkspaceChoice] = []
    @Published var selectedWorkspace = "free" {
        didSet {
            guard selectedWorkspace != oldValue, !connectedID.isEmpty else { return }
            GDProjectPreferences.select(selectedWorkspace, accountID: connectedID)
            loadPreferences()
            configurePerformance()
        }
    }
    @Published private(set) var workspaceName: String?
    @Published private(set) var usedBytes: Int64 = 0
    @Published private(set) var reservedBytes: Int64 = 0
    @Published private(set) var quotaBytes: Int64 = 2_000_000_000
    @Published private(set) var workerCount = 1
    @Published private(set) var files: [GDCloudItem] = []
    @Published private(set) var projectLimit: Int?
    @Published private(set) var projectCount: Int?
    /// True when the next new workspace takes the free slot (2 GB + free performance plan).
    @Published private(set) var nextProjectFree: Bool?
    @Published var status = "Checking your projects…"
    @Published var busy = false { didSet { GDUpdateActivity.shared.set(self, key: "busy", active: busy) } }
    @Published var uploadProgress = 0.0
    @Published var transferDetail = ""
    @Published var activityTitle = "Loading project"
    @Published var canPause = false
    @Published var dataSaver = false { didSet { savePreference(dataSaver, "dataSaver"); configurePerformance() } }
    @Published var offloadOriginal = false { didSet { savePreference(offloadOriginal, "offloadOriginal") } }
    @Published var grid = false { didSet { savePreference(grid, "grid") } }
    @Published var order = "name" { didSet { savePreference(order, "order") } }
    @Published var category = "all" { didSet { savePreference(category, "category") } }
    @Published var preview: GDProjectFolderPreview?
    private var client: GDTransferClient?
    private var connectedID = ""
    private weak var login: GDLoginSession?
    private var restoringPreferences = false
    private var operation: Task<Void, Never>?
    private var pendingSelection: String?
    var selectedProject: GDWorkspaceChoice? { choices.first { $0.id == selectedWorkspace } }
    var available: Bool { workspaceName != nil && selectedProject?.archived != true && selectedProject?.pendingPayment != true }
    var activeProjects: [GDWorkspaceChoice] { choices.filter { !$0.archived } }
    var archivedProjects: [GDWorkspaceChoice] { choices.filter { $0.archived } }
    var accountID: String { connectedID }
    private var transferScope: String { GDTransferClient.digest(Data((connectedID + "\n" + selectedWorkspace).utf8)) }
    private func preference(_ setting: String) -> String {
        GDProjectPreferences.key(accountID: connectedID, workspaceID: selectedWorkspace, setting: setting)
    }
    private func savePreference(_ value: Any, _ setting: String) {
        guard !restoringPreferences, !connectedID.isEmpty else { return }
        UserDefaults.standard.set(value, forKey: preference(setting))
    }
    private func loadPreferences() {
        restoringPreferences = true
        defer { restoringPreferences = false }
        dataSaver = UserDefaults.standard.bool(forKey: preference("dataSaver"))
        offloadOriginal = UserDefaults.standard.bool(forKey: preference("offloadOriginal"))
        grid = UserDefaults.standard.bool(forKey: preference("grid"))
        order = UserDefaults.standard.string(forKey: preference("order")) ?? "name"
        category = UserDefaults.standard.string(forKey: preference("category")) ?? "all"
    }
    private func configurePerformance() {
        guard let login, !connectedID.isEmpty, login.userID == connectedID else { return }
        GDNativePerformance.shared.configure(login: login, workspaceID: selectedWorkspace, constrained: dataSaver)
    }
    func selectionChanged(_ notification: Notification) {
        guard notification.userInfo?["accountID"] as? String == connectedID,
              let id = notification.userInfo?["workspaceID"] as? String, id != selectedWorkspace else { return }
        if busy { pendingSelection = id; return }
        selectedWorkspace = id
        refresh()
    }
    private func finishOperation() {
        busy = false; canPause = false
        if let pendingSelection {
            self.pendingSelection = nil
            selectedWorkspace = pendingSelection
            refresh()
        }
    }
    func connect(_ login: GDLoginSession) {
        guard !busy, !GDUpdateActivity.shared.isMaintenancePending else { return }
        self.login = login
        if connectedID != login.userID {
            files = []; workspaceName = nil; choices = []; connectedID = ""; selectedWorkspace = "free"; client = nil
            GDNativePerformance.shared.clear()
        }
        guard !login.userID.isEmpty else { status = "Sign in with Google to load your projects."; return }
        do {
            if client == nil {
                guard let file = Bundle.main.url(forResource: "gendragoon_free_api", withExtension: "json"),
                      let config = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any],
                      let text = config["endpoint"] as? String, let endpoint = URL(string: text),
                      endpoint.host?.hasSuffix(".run.app") == true else {
                    throw GDTransferError(message: "Cloud service configuration is missing from this installation.", status: 0)
                }
                let expected = login.userID
                client = try GDTransferClient(endpoint: endpoint, accountID: expected) { [weak login] force in
                    guard let login, await login.userID == expected else {
                        throw GDTransferError(message: "Your account changed. Sign in again.", status: 401)
                    }
                    return try await login.tokenForTransfer(forceRefresh: force)
                }
                connectedID = expected
                selectedWorkspace = GDProjectPreferences.selected(accountID: expected)
                loadPreferences()
            }
            configurePerformance()
            refresh()
        } catch { status = GDNativeMessage.safe(error.localizedDescription) }
    }
    private func load() async throws {
        guard let client else { throw GDTransferError(message: "Sign in first.", status: 401) }
        let data = try await client.jsonData("v2/projects", query: [URLQueryItem(name: "includeArchived", value: "true")])
        struct Response: Decodable { let projects: [GDWorkspaceChoice] }
        choices = try JSONDecoder().decode(Response.self, from: data).projects
        if let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let policy = root["policy"] as? [String: Any] {
            projectLimit = policy["projectLimit"] as? Int
            projectCount = policy["usedProjectSlots"] as? Int
            let free = policy["freeProjectAvailable"] as? Bool == true || policy["ownerFeeWaived"] as? Bool == true
            nextProjectFree = free
        }
        files = []; workspaceName = nil
        if let selected = selectedProject {
            if selected.archived { status = "This project is archived. Its cloud files are retained; restore the project to access them."; return }
            if selected.pendingPayment { status = "This workspace is waiting for its plan payment. Complete checkout before uploading."; return }
            if selected.pendingCapacity { status = "Payment is confirmed. Free a project slot, then activate this project; no new project fee is required."; return }
            if !selected.provisioned { status = "This project is being prepared. Refresh to check its storage activation."; return }
        } else if selectedWorkspace != "free" {
            status = "Your saved project is unavailable. Choose an existing project or create a new one."
            return
        }
        do {
            let config = try await client.configuration(workspace: selectedWorkspace)
            workspaceName = config.name; usedBytes = config.usedBytes; reservedBytes = config.reservedBytes
            quotaBytes = config.quotaBytes; workerCount = config.transfer.workers
            files = try await client.list(workspace: selectedWorkspace)
            status = "Project ready · \(files.count) item\(files.count == 1 ? "" : "s") · \(workerCount) transfer worker\(workerCount == 1 ? "" : "s")."
        } catch let error as GDTransferError where error.status == 404 && selectedWorkspace == "free" {
            status = "Create your first project to get started."
        }
    }
    func refresh() {
        guard !busy, !GDUpdateActivity.shared.isMaintenancePending, client != nil else { return }
        busy = true; activityTitle = "Refreshing project"; transferDetail = "Loading the current cloud file index."; canPause = false
        operation = Task { defer { finishOperation() }; do { try await load() } catch { status = GDNativeMessage.safe(error.localizedDescription) } }
    }
    func select(_ id: String) { guard !busy else { return }; selectedWorkspace = id; refresh() }
    /// Storage + performance plan tiers sold for new workspaces (server-validated; prices come from Stripe Checkout and /v2/pricing).
    static let storageTiers = ["100GB", "200GB", "300GB", "500GB", "1TB", "2TB", "3TB", "4TB", "5TB", "6TB"]
    static let performanceTiers = ["lite", "boost", "turbo", "ultra", "max"]
    func create(name: String, customStorage: Bool = false, storageTier: String = "100GB", performanceTier: String = "boost", yearly: Bool = false) {
        let name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !busy, GDUpdateActivity.shared.canStart(excluding: self), let client else { return }
        let key = GDProjectPreferences.key(accountID: connectedID, setting: "createIntent")
        let savedName = UserDefaults.standard.string(forKey: key + ".name")
        let intent = savedName == name ? (UserDefaults.standard.string(forKey: key) ?? UUID().uuidString.lowercased()) : UUID().uuidString.lowercased()
        UserDefaults.standard.set(intent, forKey: key); UserDefaults.standard.set(name, forKey: key + ".name")
        busy = true; activityTitle = "Creating project"; canPause = false
        operation = Task { defer { finishOperation() }; do {
            var body: [String: Any] = ["name": name, "intentId": intent]
            if customStorage || nextProjectFree != true {
                var plans: [String: Any] = ["performanceTier": performanceTier, "interval": yearly ? "year" : "month"]
                if !customStorage { plans["storageTier"] = storageTier }
                body["plans"] = plans
                if customStorage { body["storage"] = "custom" }
            }
            let data = try await client.jsonData("v2/projects", method: "POST", payload: try JSONSerialization.data(withJSONObject: body))
            let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            if let id = result?["workspaceId"] as? String { selectedWorkspace = id }
            try await load()
            if let text = result?["url"] as? String, let url = URL(string: text), url.scheme == "https", url.host == "checkout.stripe.com" {
                NSWorkspace.shared.open(url)
                status = customStorage ? "Workspace selected. Pay for its performance plan in Stripe, then finish Custom storage setup in Workspace plans." : "Workspace selected. Pay for its storage and performance plans in Stripe, then refresh."
            } else {
                UserDefaults.standard.removeObject(forKey: key); UserDefaults.standard.removeObject(forKey: key + ".name")
            }
        } catch { status = GDNativeMessage.safe(error.localizedDescription) } }
    }
    /// Resumes (or reopens) the single plans Checkout of a workspace awaiting payment.
    func resumeCheckout(_ project: GDWorkspaceChoice) {
        guard !busy, GDUpdateActivity.shared.canStart(excluding: self), let client else { return }
        busy = true; activityTitle = "Opening checkout"; canPause = false
        operation = Task { defer { finishOperation() }; do {
            let data = try await client.jsonData("v2/projects/" + project.id + "/checkout", method: "POST", payload: try JSONSerialization.data(withJSONObject: [String: Any]()))
            let result = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            if let text = result?["url"] as? String, let url = URL(string: text), url.scheme == "https", url.host == "checkout.stripe.com" { NSWorkspace.shared.open(url) }
            try await load()
        } catch { status = GDNativeMessage.safe(error.localizedDescription) } }
    }
    func archiveSelected() {
        guard !busy, GDUpdateActivity.shared.canStart(excluding: self), let client, let project = selectedProject, !project.archived else { return }
        let alert = NSAlert(); alert.messageText = "Archive \(project.name)?"
        alert.informativeText = "The project will leave your active projects. Its files and Google Cloud resources are retained. " + (project.hasContinuingBilling == true ? "Its paid subscriptions continue until cancelled through billing. " : "") + "Type the project name to confirm."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 330, height: 24)); field.placeholderString = project.name; alert.accessoryView = field
        alert.addButton(withTitle: "Archive Project"); alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        guard field.stringValue == project.name else { status = "Project name did not match. Nothing was changed."; return }
        busy = true; activityTitle = "Archiving project"; canPause = false
        operation = Task { defer { finishOperation() }; do {
            let payload = try JSONSerialization.data(withJSONObject: ["confirmName": project.name, "acknowledgeBillingContinues": true])
            _ = try await client.jsonData("v2/projects/" + project.id + "/archive", method: "POST", payload: payload)
            try await load()
        } catch { status = GDNativeMessage.safe(error.localizedDescription) } }
    }
    func restoreProject(_ project: GDWorkspaceChoice) {
        guard !busy, GDUpdateActivity.shared.canStart(excluding: self), let client else { return }
        busy = true; activityTitle = "Restoring project"; canPause = false
        operation = Task { defer { finishOperation() }; do {
            _ = try await client.json("v2/projects/" + project.id + "/restore", method: "POST", payload: [:])
            selectedWorkspace = project.id; try await load()
        } catch { status = GDNativeMessage.safe(error.localizedDescription) } }
    }
    private func update(_ progress: GDTransferProgress) {
        uploadProgress = progress.fraction
        let rate = progress.bytesPerSecond > 0 ? String(format: " · %.1f MB/s", progress.bytesPerSecond / 1_000_000) : ""
        let eta = progress.secondsRemaining.map { String(format: " · about %.0fs remaining", $0) } ?? ""
        transferDetail = progress.phase + rate + eta
    }
    func chooseUpload(content: GDProjectContent, replacing: GDCloudItem? = nil) {
        guard !busy, available, GDUpdateActivity.shared.canStart(excluding: self) else { return }
        let panel = NSOpenPanel(); panel.canChooseFiles = true; panel.canChooseDirectories = true
        panel.allowsMultipleSelection = replacing == nil; panel.treatsFilePackagesAsDirectories = false
        panel.title = content == .applications ? "Choose complete applications" : "Choose files or complete folders"
        panel.message = replacing.map { "Choose the updated \($0.displayName). Its old cloud copy stays until the new upload and restore are verified." }
            ?? "Complete folders are scanned and packaged automatically, including empty files, nested folders and Mac metadata."
        guard panel.runModal() == .OK else { return }
        uploadFiles(panel.urls, content: content, replacing: replacing)
    }
    private func quitSelectedApplications(_ sources: [URL]) async throws {
        let bundles = Set(sources.filter { $0.pathExtension.lowercased() == "app" }
            .map { $0.standardizedFileURL.path })
        guard !bundles.isEmpty else { return }
        // Resolve the actual installed bundle, never just its display name.
        let running = NSWorkspace.shared.runningApplications.filter { process in
            guard !process.isTerminated, let url = process.bundleURL else { return false }
            return bundles.contains(url.standardizedFileURL.path)
        }
        guard !running.isEmpty else { return }
        let warning = NSAlert()
        warning.alertStyle = .warning
        warning.messageText = "Quit selected applications before uploading?"
        warning.informativeText = "\(running.count) selected application(s) are running. Save any work first. GenDragoon must verify an unchanged application before cloud offload."
        warning.addButton(withTitle: "Quit and Continue")
        warning.addButton(withTitle: "Cancel")
        guard warning.runModal() == .alertFirstButtonReturn else {
            throw GDTransferError(message: "Upload cancelled; originals were untouched.", status: 0)
        }
        for process in running { _ = process.terminate() }
        for _ in 0..<25 {
            if running.allSatisfy({ $0.isTerminated }) { break }
            try? await Task.sleep(for: .milliseconds(200))
        }
        let stubborn = running.filter { !$0.isTerminated }
        if !stubborn.isEmpty {
            let confirm = NSAlert()
            confirm.alertStyle = .critical
            confirm.messageText = "Force quit \(stubborn.count) application(s)?"
            confirm.informativeText = "These apps did not quit normally. Force quitting can discard unsaved changes. Cancel keeps all originals in place."
            confirm.addButton(withTitle: "Force Quit and Continue")
            confirm.addButton(withTitle: "Cancel")
            guard confirm.runModal() == .alertFirstButtonReturn else {
                throw GDTransferError(message: "Upload cancelled because a selected application is still running.", status: 0)
            }
            for process in stubborn { _ = process.forceTerminate() }
            for _ in 0..<25 {
                if running.allSatisfy({ $0.isTerminated }) { break }
                try? await Task.sleep(for: .milliseconds(200))
            }
        }
        guard running.allSatisfy({ $0.isTerminated }) else {
            throw GDTransferError(message: "A selected app is still running. No upload or offload was started.", status: 0)
        }
    }
    func uploadFiles(_ urls: [URL], content: GDProjectContent, replacing: GDCloudItem? = nil) {
        guard !busy, available, GDUpdateActivity.shared.canStart(excluding: self), let client, !urls.isEmpty else { return }
        guard urls.allSatisfy({ $0.isFileURL }) else { status = "Drop files or folders from this Mac."; return }
        var seen = Set<String>()
        let unique = urls.filter { seen.insert($0.standardizedFileURL.path).inserted }
        let selected = unique.filter { candidate in !unique.contains { parent in parent != candidate && candidate.standardizedFileURL.path.hasPrefix(parent.standardizedFileURL.path + "/") } }
        if content == .applications && !selected.allSatisfy({ $0.pathExtension.lowercased() == "app" }) {
            status = "Choose complete .app bundles for Applications. Other files and folders belong in Files."; return
        }
        if let replacing, selected.count != 1 || selected.first?.lastPathComponent != replacing.displayName {
            status = "Choose one updated item named \(replacing.displayName). The existing cloud copy is unchanged."; return
        }
        let workspace = selectedWorkspace, scope = transferScope, constrained = dataSaver, offload = offloadOriginal
        let account = connectedID
        busy = true; uploadProgress = 0; canPause = true
        operation = Task { defer { finishOperation() }; do {
            activityTitle = "Preparing selected applications"
            try await quitSelectedApplications(selected)
            try Task.checkCancellation()
            let fresh = try await client.configuration(workspace: workspace)
            workerCount = fresh.transfer.workers
            let verifiedWorkers = constrained ? 1 : fresh.transfer.workers
            let maximumBatch = max(1, min(8, verifiedWorkers))
            var completed = 0, next = 0
            // Directory/app preparation stays sequential. Small regular files
            // share a bounded batch, and every network operation reserves part
            // of the client's single authenticated worker allowance.
            func isSmallFile(_ url: URL) -> Bool {
                guard let values = try? FileManager.default.attributesOfItem(atPath: url.path),
                      values[.type] as? FileAttributeType == .typeRegular,
                      let size = values[.size] as? NSNumber else { return false }
                return size.int64Value >= 0 && size.int64Value <= 8 * 1024 * 1024
            }
            while next < selected.count {
                try Task.checkCancellation()
                var batch = [selected[next]]; next += 1
                if isSmallFile(batch[0]) {
                    while next < selected.count && batch.count < maximumBatch && isSmallFile(selected[next]) {
                        batch.append(selected[next]); next += 1
                    }
                }
                let accessed = batch.filter { $0.startAccessingSecurityScopedResource() }
                defer { for url in accessed { url.stopAccessingSecurityScopedResource() } }
                var prepared: [GDPreparedProjectFile] = []
                // The private archive helper holds an account/project lock;
                // do not overlap prepare or final verification subprocesses.
                for url in batch {
                    try Task.checkCancellation()
                    activityTitle = "Scanning \(url.lastPathComponent)"
                    transferDetail = "Reading every file and preserving folder structure and macOS metadata."
                    status = "Preparing item \(completed + prepared.count + 1) of \(selected.count)…"
                    let result = try await GDNativeHelper.invoke("gendragoon_project_files", arguments: ["prepare", "--source", url.path, "--scope", scope])
                    prepared.append(try JSONDecoder().decode(GDPreparedProjectFile.self, from: JSONSerialization.data(withJSONObject: result)))
                }
                let ready = prepared, perFileWorkers = max(1, verifiedWorkers / batch.count)
                let monitor = GDProjectBatchProgress(items: ready) { [weak self] progress in self?.update(progress) }
                activityTitle = ready.count == 1 ? "Uploading \(ready[0].name)" : "Uploading \(ready.count) files together"
                var copies: [GDProjectUploadedFile] = []
                defer { for copy in copies { try? FileManager.default.removeItem(at: copy.downloaded) } }
                try await withThrowingTaskGroup(of: GDProjectUploadedFile.self) { group in
                    for item in ready {
                        group.addTask {
                            try Task.checkCancellation()
                            let saved = try await client.upload(source: URL(fileURLWithPath: item.path), workspace: workspace,
                                constrained: constrained, metadata: item.metadata, maximumWorkers: perFileWorkers) { progress in
                                    await monitor.update(key: item.key, size: item.sizeBytes, restoring: false, progress: progress)
                                }
                            try Task.checkCancellation()
                            let downloaded = try await client.download(file: saved, workspace: workspace,
                                constrained: constrained, maximumWorkers: perFileWorkers) { progress in
                                    await monitor.update(key: item.key, size: item.sizeBytes, restoring: true, progress: progress)
                                }
                            return GDProjectUploadedFile(prepared: item, saved: saved, downloaded: downloaded)
                        }
                    }
                    while let copy = try await group.next() { copies.append(copy) }
                }
                try Task.checkCancellation()
                canPause = false
                for copy in copies {
                    try Task.checkCancellation()
                    guard login?.userID == account else {
                        throw GDTransferError(message: "Your account changed. Original files are retained until you sign in again and resume verification.", status: 401)
                    }
                    activityTitle = "Verifying complete restore · \(copy.prepared.name)"
                    transferDetail = "Checking restored bytes, complete folder structure and metadata."
                    var arguments = ["verify-remote", "--package", copy.downloaded.path, "--scope", scope, "--key", copy.prepared.key]
                    if offload { arguments.append("--offload") }
                    let verified = try await GDNativeHelper.invoke("gendragoon_project_files", arguments: arguments)
                    await client.acknowledgeUpload(fileID: copy.saved.id)
                    if let replacing, replacing.id != copy.saved.id {
                        // The explicit Update action replaces only after roundtrip verification.
                        try await client.delete(fileID: replacing.id, workspace: workspace)
                    }
                    completed += 1
                    status = verified["message"] as? String ?? "Cloud upload and complete restore verified."
                }
                canPause = true
            }
            let summary = status
            try await load()
            status = "\(completed) item\(completed == 1 ? "" : "s") saved. " + summary
        } catch is CancellationError {
            status = "Paused. Select the same unchanged source to resume the prepared upload or restore check."
        } catch { status = "Upload stopped: " + GDNativeMessage.safe(error.localizedDescription) } }
    }
    func download(file: GDCloudItem) {
        guard !busy, available, GDUpdateActivity.shared.canStart(excluding: self), let client else { return }
        let panel = NSSavePanel(); panel.nameFieldStringValue = file.displayName
        panel.canCreateDirectories = true; panel.message = file.isPackage ? "Restore the original item, including its complete folders and Mac metadata. Choose a new name if it already exists." : "Download a verified local copy. The cloud copy stays available."
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        if file.isPackage && FileManager.default.fileExists(atPath: destination.path) {
            status = "That destination already exists. Choose a new name to retain both copies."; return
        }
        let workspace = selectedWorkspace, constrained = dataSaver
        busy = true; uploadProgress = 0; canPause = true; activityTitle = "Downloading \(file.displayName)"
        operation = Task { defer { finishOperation() }; do {
            let access = destination.startAccessingSecurityScopedResource(); defer { if access { destination.stopAccessingSecurityScopedResource() } }
            let downloaded = try await client.download(file: file, workspace: workspace, constrained: constrained) { [weak self] progress in await self?.update(progress) }
            defer { try? FileManager.default.removeItem(at: downloaded) }
            try Task.checkCancellation()
            if file.isPackage {
                guard let digest = file.manifestSHA256 else { throw GDTransferError(message: "Folder checksum is missing. Refresh this project.", status: 0) }
                transferDetail = "Restoring and checking original folder metadata."
                canPause = false
                _ = try await GDNativeHelper.invoke("gendragoon_project_files", arguments: ["restore", "--package", downloaded.path, "--destination", destination.path, "--manifest-sha256", digest])
            } else {
                let staged = destination.deletingLastPathComponent().appendingPathComponent(".gendragoon-" + UUID().uuidString)
                defer { try? FileManager.default.removeItem(at: staged) }
                try FileManager.default.copyItem(at: downloaded, to: staged)
                if FileManager.default.fileExists(atPath: destination.path) { _ = try FileManager.default.replaceItemAt(destination, withItemAt: staged) }
                else { try FileManager.default.moveItem(at: staged, to: destination) }
            }
            status = "Restored \(file.displayName) to your chosen location."
            NSWorkspace.shared.activateFileViewerSelecting([destination])
        } catch is CancellationError { status = "Download paused. Choose Download again to resume its verified ranges." }
        catch { status = GDNativeMessage.safe(error.localizedDescription) } }
    }
    func inspect(file: GDCloudItem) {
        guard file.isPackage, let digest = file.manifestSHA256, !busy, available,
              GDUpdateActivity.shared.canStart(excluding: self), let client else { return }
        let workspace = selectedWorkspace, constrained = dataSaver
        busy = true; activityTitle = "Reading \(file.displayName)"; uploadProgress = 0; canPause = true
        operation = Task { defer { finishOperation() }; do {
            let downloaded = try await client.download(file: file, workspace: workspace, constrained: constrained) { [weak self] progress in await self?.update(progress) }
            defer { try? FileManager.default.removeItem(at: downloaded) }
            let result = try await GDNativeHelper.invoke("gendragoon_project_files", arguments: ["inspect", "--package", downloaded.path, "--manifest-sha256", digest])
            preview = try JSONDecoder().decode(GDProjectFolderPreview.self, from: JSONSerialization.data(withJSONObject: result))
            status = "Folder contents loaded from its checksum-verified cloud package."
        } catch is CancellationError { status = "Folder preview paused." }
        catch { status = GDNativeMessage.safe(error.localizedDescription) } }
    }
    func delete(file: GDCloudItem) {
        guard !busy, GDUpdateActivity.shared.canStart(excluding: self), let client else { return }
        let alert = NSAlert(); alert.messageText = "Delete \(file.displayName) from this project?"
        alert.informativeText = "This permanently removes this cloud copy. Your local copies and other project items are unaffected."
        alert.addButton(withTitle: "Delete Cloud Copy"); alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let workspace = selectedWorkspace; busy = true; activityTitle = "Deleting cloud copy"; canPause = false
        operation = Task { defer { finishOperation() }; do { try await client.delete(fileID: file.id, workspace: workspace); try await load() } catch { status = GDNativeMessage.safe(error.localizedDescription) } }
    }
    func pause() { operation?.cancel() }
}

struct GenDragoonFreeCloudPanel: View {
    @EnvironmentObject var login: GDLoginSession
    @ObservedObject var customer: GDFreeCustomerModel
    var content: GDProjectContent = .files
    var showProjectControls = true
    var onStorage: () -> Void
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var search = ""
    @State private var dropTarget = false
    @State private var showCreate = false
    @State private var projectName = ""
    @State private var customStorage = false
    @State private var storageTier = "100GB"
    @State private var performanceTier = "boost"
    @State private var yearly = false
    private let accent = Color(red: 0.72, green: 0.55, blue: 0.96)
    private func size(_ count: Int64) -> String { ByteCountFormatter.string(fromByteCount: count, countStyle: .file) }
    private func category(_ file: GDCloudItem) -> String {
        if file.itemKind == "app" { return "applications" }
        if file.itemKind == "folder" { return "folders" }
        let ext = (file.displayName as NSString).pathExtension.lowercased()
        if ["mov", "mp4", "m4v", "mkv", "avi", "webm", "mpeg", "mpg", "3gp"].contains(ext) { return "videos" }
        if ["wav", "mp3", "aiff", "aac", "m4a", "flac", "ogg", "aif"].contains(ext) { return "audio" }
        if ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "tif", "tiff", "svg", "raw"].contains(ext) { return "pictures" }
        return "files"
    }
    private func icon(_ file: GDCloudItem) -> String {
        switch category(file) {
        case "applications": return "app.badge.fill"
        case "folders": return "folder.fill"
        case "videos": return "play.rectangle.fill"
        case "audio": return "waveform"
        case "pictures": return "photo.fill"
        default: return "doc.fill"
        }
    }
    private var sourceFiles: [GDCloudItem] { customer.files.filter { content == .applications ? $0.itemKind == "app" : $0.itemKind != "app" } }
    private var visible: [GDCloudItem] {
        sourceFiles.filter { (search.isEmpty || $0.displayName.localizedCaseInsensitiveContains(search)) && (content == .applications || customer.category == "all" || category($0) == customer.category) }.sorted {
            if customer.order == "largest" { return $0.displaySize > $1.displaySize }
            if customer.order == "smallest" { return $0.displaySize < $1.displaySize }
            return $0.displayName.localizedStandardCompare($1.displayName) == .orderedAscending
        }
    }
    private var locked: Bool { customer.busy || !GDUpdateActivity.shared.canStart(excluding: customer) }
    private func metric(_ title: String, _ value: String, _ symbol: String) -> some View {
        VStack(alignment: .leading, spacing: 11) {
            Label(title, systemImage: symbol).font(.system(size: 11, weight: .medium)).foregroundStyle(.white.opacity(0.60))
            Text(value).font(.system(size: 24, weight: .bold, design: .rounded)).lineLimit(1).minimumScaleFactor(0.6)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(accent.opacity(0.075), in: RoundedRectangle(cornerRadius: 15))
            .overlay(RoundedRectangle(cornerRadius: 15).stroke(accent.opacity(0.18)))
    }
    private var projectHeader: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text(content == .applications ? "PROJECT APPLICATION BACKUPS" : "PROJECT FILES").font(.system(size: 9, weight: .bold, design: .monospaced)).tracking(2).foregroundStyle(accent)
                    Text(customer.workspaceName ?? customer.selectedProject?.name ?? "Your projects").font(.system(size: 23, weight: .bold, design: .rounded))
                }
                Spacer()
                Button { customer.refresh(); login.checkAdEntitlement() } label: { Label("Refresh", systemImage: "arrow.clockwise") }.disabled(customer.busy)
                if showProjectControls { Button { showCreate = true } label: { Label("New Project", systemImage: "plus") }.disabled(locked) }
            }
            HStack {
                Picker("Project", selection: Binding(get: { customer.selectedWorkspace }, set: { customer.select($0) })) {
                    if !customer.choices.contains(where: { $0.id == customer.selectedWorkspace }) { Text(customer.selectedWorkspace == "free" ? "First project" : "Saved project unavailable").tag(customer.selectedWorkspace) }
                    ForEach(customer.choices) { project in Text(project.name + (project.archived ? " · Archived" : project.pendingPayment ? " · Awaiting payment" : "")).tag(project.id) }
                }.controlSize(.large).disabled(customer.busy)
                Spacer()
                if showProjectControls, customer.selectedProject != nil, customer.selectedProject?.archived != true {
                    Menu { Button("Storage & plans", action: onStorage); Button("Archive project…", role: .destructive) { customer.archiveSelected() } } label: { Image(systemName: "ellipsis.circle") }.disabled(locked)
                }
            }
            Text("Project ID: " + customer.selectedWorkspace).font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
        }
    }
    private var uploadControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Button { customer.chooseUpload(content: content) } label: { Label(content == .applications ? "Upload Applications" : "Upload Files or Folders", systemImage: "plus") }
                    .buttonStyle(.borderedProminent).tint(accent).controlSize(.large).disabled(locked)
                Text(content == .applications ? "or drop complete .app bundles" : "or drop any files and complete folders").font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                Toggle("Data saver", isOn: $customer.dataSaver).toggleStyle(.switch).font(.system(size: 11)).disabled(customer.busy)
            }
            Toggle("Move originals to Trash after cloud upload and a verified restore", isOn: $customer.offloadOriginal)
                .toggleStyle(.checkbox).font(.system(size: 11)).disabled(customer.busy)
            Text(content == .applications ? "Project application backups restore complete app bundles. Launch, preloading and automatic managed-cache cleanup are available in the connected Mac application library." : "Folders keep their nested files, empty folders, relative links and macOS metadata. Originals move only when the checkbox is selected and the restored copy matches.")
                .font(.system(size: 11)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
    }
    private var transferProgress: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack { Label(customer.activityTitle, systemImage: "arrow.up.arrow.down").font(.system(size: 12, weight: .semibold)); Spacer(); if customer.canPause { Button("Pause") { customer.pause() } } }
            if customer.canPause { ProgressView(value: customer.uploadProgress).tint(accent) } else { ProgressView().controlSize(.small) }
            Text(customer.transferDetail).font(.system(size: 11)).foregroundStyle(.secondary)
        }.padding(16).background(accent.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
    }
    private var filters: some View {
        VStack(spacing: 12) {
            HStack(spacing: 11) {
                HStack { Image(systemName: "magnifyingglass").foregroundStyle(.secondary); TextField(content == .applications ? "Find an application…" : "Find a file or folder…", text: $search).textFieldStyle(.plain) }
                    .padding(11).background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 10))
                Picker("Sort", selection: $customer.order) { Text("Name A–Z").tag("name"); Text("Largest first").tag("largest"); Text("Smallest first").tag("smallest") }.labelsHidden().frame(width: 135)
                Button { customer.grid.toggle() } label: { Image(systemName: customer.grid ? "list.bullet" : "square.grid.2x2") }.help(customer.grid ? "List view" : "Grid view")
            }
            if content == .files {
                Picker("Content", selection: $customer.category) {
                    Text("All").tag("all"); Text("Files").tag("files"); Text("Folders").tag("folders"); Text("Videos").tag("videos"); Text("Audio").tag("audio"); Text("Pictures").tag("pictures")
                }.pickerStyle(.segmented).labelsHidden()
            }
        }
    }
    private func actions(_ file: GDCloudItem) -> some View {
        HStack(spacing: 9) {
            Button { customer.download(file: file) } label: { Label("Download", systemImage: "arrow.down.to.line") }.buttonStyle(.bordered).tint(accent)
            Menu {
                if file.itemKind == "folder" || file.itemKind == "app" { Button("View contents") { customer.inspect(file: file) } }
                Button("Upload an update…") { customer.chooseUpload(content: content, replacing: file) }
                Button("Delete cloud copy…", role: .destructive) { customer.delete(file: file) }
            } label: { Image(systemName: "ellipsis") }.menuStyle(.borderlessButton).frame(width: 22)
        }.font(.system(size: 11, weight: .medium)).disabled(locked)
    }
    private func fileIcon(_ file: GDCloudItem) -> some View {
        Image(systemName: icon(file)).font(.system(size: 22, weight: .medium)).foregroundStyle(accent)
            .frame(width: 48, height: 52).background(accent.opacity(0.11), in: RoundedRectangle(cornerRadius: 12))
    }
    private func row(_ file: GDCloudItem) -> some View {
        HStack(spacing: 14) {
            fileIcon(file)
            VStack(alignment: .leading, spacing: 6) {
                Text(file.displayName).font(.system(size: 13, weight: .semibold)).lineLimit(2)
                Text(size(file.displaySize) + (file.itemKind == "folder" ? " · Complete folder" : file.itemKind == "app" ? " · Application bundle" : ""))
                    .font(.system(size: 11)).foregroundStyle(.secondary)
            }
            Spacer(minLength: 12); actions(file)
        }.padding(.vertical, 13).padding(.horizontal, 8)
    }
    private func tile(_ file: GDCloudItem) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack { fileIcon(file); Spacer(); Text(size(file.displaySize)).font(.system(size: 10)).foregroundStyle(.secondary) }
            Text(file.displayName).font(.system(size: 13, weight: .semibold)).lineLimit(2).frame(height: 36, alignment: .topLeading)
            HStack { Spacer(); actions(file) }
        }.padding(17).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 16)).overlay(RoundedRectangle(cornerRadius: 16).stroke(.white.opacity(0.09)))
    }
    private var emptyState: some View {
        VStack(spacing: 12) {
            Image(systemName: sourceFiles.isEmpty ? (content == .applications ? "app.badge.fill" : "folder.badge.plus") : "magnifyingglass").font(.system(size: 34, weight: .light)).foregroundStyle(accent)
            Text(sourceFiles.isEmpty ? (content == .applications ? "Your application backups belong here." : "A place for every file and folder.") : "No matching items.").font(.system(size: 16, weight: .semibold))
            Text(sourceFiles.isEmpty ? "Upload to the selected project to keep a verified cloud copy." : "Try another search or category.").font(.system(size: 12)).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity).padding(.vertical, 34)
    }
    private var unavailable: some View {
        VStack(spacing: 14) {
            Image(systemName: "cloud.badge.plus").font(.system(size: 38, weight: .light)).foregroundStyle(accent)
            if let project = customer.selectedProject, project.archived {
                Text("Your project and files are retained.").font(.system(size: 18, weight: .semibold))
                Button("Restore Project") { customer.restoreProject(project) }.buttonStyle(.borderedProminent).tint(accent).disabled(locked)
            } else if let project = customer.selectedProject, project.pendingCapacity {
                Text("Payment received. A project slot is needed.").font(.system(size: 17, weight: .semibold))
                Button("Activate Project") { customer.restoreProject(project) }.buttonStyle(.borderedProminent).tint(accent).disabled(locked)
            } else if customer.selectedProject?.pendingPayment == true {
                Text("Complete this workspace's plan payment to activate it.").font(.system(size: 17, weight: .semibold))
                if let project = customer.selectedProject { Button("Continue to checkout") { customer.resumeCheckout(project) }.buttonStyle(.borderedProminent).tint(accent).disabled(customer.busy) }
            } else if customer.selectedProject != nil {
                Text("Your selected project is being prepared.").font(.system(size: 17, weight: .semibold))
                Button("Refresh activation") { customer.refresh() }.disabled(customer.busy)
            } else {
                Text("Create your first project.").font(.system(size: 21, weight: .bold, design: .rounded))
                Text("Each project keeps its files, storage choice and performance settings together.").font(.system(size: 12)).foregroundStyle(.secondary)
                Button("Create Project") { showCreate = true }.buttonStyle(.borderedProminent).tint(accent).disabled(locked)
            }
        }.frame(maxWidth: .infinity).padding(.vertical, 28)
    }
    private var createSheet: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("New project").font(.system(size: 24, weight: .bold, design: .rounded))
            TextField("Project name", text: $projectName).textFieldStyle(.roundedBorder)
            if customer.nextProjectFree == true {
                Text("Your first workspace is free: 2 GB storage and the free performance plan.").font(.system(size: 12)).foregroundStyle(.secondary)
            } else {
                Picker("Storage", selection: $customStorage) { Text("GenDragoon storage").tag(false); Text("Custom storage").tag(true) }.pickerStyle(.segmented)
                if !customStorage {
                    Picker("Storage plan", selection: $storageTier) { ForEach(GDFreeCustomerModel.storageTiers, id: \.self) { Text($0).tag($0) } }
                }
                Picker("Performance plan", selection: $performanceTier) { ForEach(GDFreeCustomerModel.performanceTiers, id: \.self) { Text($0.capitalized).tag($0) } }
                Picker("Billing", selection: $yearly) { Text("Monthly").tag(false); Text("Yearly").tag(true) }.pickerStyle(.segmented)
                Text(customStorage ? "Your own S3, VPS or cloud provider. You pay only for the performance plan; setup continues after payment." : "Both plans are billed together in one Stripe Checkout. The workspace fee is included.").font(.system(size: 12)).foregroundStyle(.secondary)
            }
            if let limit = customer.projectLimit { Text("\(customer.projectCount ?? customer.activeProjects.count) of \(limit) project slots used.").font(.caption).foregroundStyle(.secondary) }
            HStack { Button("Cancel") { showCreate = false }; Spacer(); Button(customer.nextProjectFree == true ? "Create Project" : "Continue to checkout") { customer.create(name: projectName, customStorage: customStorage, storageTier: storageTier, performanceTier: performanceTier, yearly: yearly); showCreate = false; projectName = "" }.buttonStyle(.borderedProminent).disabled(projectName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) }
        }.padding(28).frame(width: 440)
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            projectHeader
            if customer.available {
                HStack(spacing: 12) { metric("Storage used", size(customer.usedBytes), "externaldrive"); metric("Available", size(max(0, customer.quotaBytes - customer.usedBytes - customer.reservedBytes)), "cloud"); metric("Parallel transfers", String(customer.workerCount), "bolt") }
                ProgressView(value: min(1, Double(customer.usedBytes + customer.reservedBytes) / Double(max(1, customer.quotaBytes)))).tint(accent)
                uploadControls
                if customer.busy { transferProgress }
                filters
                HStack { Text("\(visible.count) item\(visible.count == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary); Spacer(); if content == .files { Button("Storage & performance", action: onStorage).font(.caption) } }
                if visible.isEmpty { emptyState }
                else if customer.grid { LazyVGrid(columns: [GridItem(.adaptive(minimum: 245), spacing: 13)], spacing: 13) { ForEach(visible) { tile($0) } } }
                else { LazyVStack(spacing: 0) { ForEach(visible) { file in row(file); Divider().opacity(0.22) } } }
            } else { if customer.busy { transferProgress }; unavailable }
            Label(customer.status, systemImage: "info.circle").font(.system(size: 11)).foregroundStyle(.white.opacity(0.66)).textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading).padding(13).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
            if showProjectControls, !customer.archivedProjects.isEmpty {
                DisclosureGroup("Archived projects · files retained") {
                    ForEach(customer.archivedProjects) { project in HStack { Text(project.name); Spacer(); Button("Restore") { customer.restoreProject(project) }.disabled(locked) }.padding(.vertical, 5) }
                }.font(.caption)
            }
            DisclosureGroup("Transfer details") {
                Text("Complete folders are scanned locally, then uploaded with byte checksums, a folder manifest and a full restore check. Interrupted transfers resume from their prepared copy. Data saver limits transfers to one worker. Keeping 10 GB free is recommended; each transfer checks its actual preparation and verification space.")
                    .font(.system(size: 11)).foregroundStyle(.secondary).padding(.top, 7)
            }.font(.system(size: 11)).tint(accent)
        }.padding(24).background(.white.opacity(0.035), in: RoundedRectangle(cornerRadius: 21))
            .overlay(RoundedRectangle(cornerRadius: 21).stroke(dropTarget ? accent : .white.opacity(0.08), lineWidth: dropTarget ? 2 : 1))
            .dropDestination(for: URL.self) { urls, _ in
                guard !locked, customer.available else { return false }
                customer.uploadFiles(urls, content: content); return true
            } isTargeted: { dropTarget = $0 }
            .sheet(isPresented: $showCreate) { createSheet }
            .sheet(item: $customer.preview) { preview in GDProjectFolderBrowser(preview: preview) }
    }
}

private struct GDProjectFolderBrowser: View {
    let preview: GDProjectFolderPreview
    @Environment(\.dismiss) private var dismiss
    @State private var path = ""
    @State private var query = ""
    private var children: [GDProjectFolderEntry] {
        preview.entries.filter { entry in
            let parent = (entry.path as NSString).deletingLastPathComponent
            return parent == path && (query.isEmpty || (entry.path as NSString).lastPathComponent.localizedCaseInsensitiveContains(query))
        }.sorted { left, right in
            if (left.kind == "directory") != (right.kind == "directory") { return left.kind == "directory" }
            return left.path.localizedStandardCompare(right.path) == .orderedAscending
        }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack { Label(preview.name, systemImage: preview.kind == "app" ? "app.fill" : "folder.fill").font(.title2.bold()); Spacer(); Button("Done") { dismiss() } }
            HStack { Button { path = (path as NSString).deletingLastPathComponent; query = "" } label: { Image(systemName: "chevron.left") }.disabled(path.isEmpty); Text(path.isEmpty ? preview.name : path).font(.caption.monospaced()).textSelection(.enabled); Spacer(); TextField("Find in folder", text: $query).frame(width: 190) }
            List(children) { entry in
                HStack {
                    Image(systemName: entry.kind == "directory" ? "folder.fill" : entry.kind == "symlink" ? "link" : "doc.fill").foregroundStyle(.purple)
                    Text((entry.path as NSString).lastPathComponent); Spacer()
                    if entry.kind == "directory" { Button("Open") { path = entry.path; query = "" } }
                    else { Text(ByteCountFormatter.string(fromByteCount: entry.sizeBytes, countStyle: .file)).foregroundStyle(.secondary).font(.caption) }
                }.padding(.vertical, 4)
            }
            Text(preview.truncated ? "Showing the first 20,000 manifest entries. Download restores the full folder." : "\(preview.entryCount) entries in the verified cloud package. Download the parent item to restore its complete structure.").font(.caption).foregroundStyle(.secondary)
        }.padding(24).frame(width: 650, height: 510)
    }
}
