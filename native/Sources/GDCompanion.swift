import AppKit
import Darwin
import Foundation
import SwiftUI

/// Same-user IPC carries bounded requests, never account credentials. Browser
/// labels are checked against installed IDs and require native owner approval.
@MainActor final class GDCompanion: ObservableObject {
    static let shared = GDCompanion()
    @Published private(set) var status = "Extensions connect through the running GenDragoon app."
    private var descriptor: Int32 = -1
    private var pending = Set<String>()
    private var completed: [String: (Date, [String: Any])] = [:]
    private let base: URL
    private let socketDirectory: URL
    init(baseURL: URL? = nil, socketDirectoryURL: URL? = nil) {
        base = baseURL ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/GenDragoon")
        socketDirectory = socketDirectoryURL ?? URL(fileURLWithPath: "/private/tmp/gendragoon-companion-\(getuid())", isDirectory: true)
    }

    func start() {
        guard descriptor < 0 else { return }
        do {
            let fm = FileManager.default
            let endpoint = base.appendingPathComponent("Companion")
            for directory in [base, endpoint, socketDirectory] {
                if !fm.fileExists(atPath: directory.path) { try fm.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700]) }
                try Self.privatePath(directory, kind: .typeDirectory)
            }
            let path = socketDirectory.appendingPathComponent("rpc.sock").path
            let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard fd >= 0 else { throw GDNativeFailure(message: "Could not create the local companion connection.") }
            var keep = false
            defer { if !keep { Darwin.close(fd) } }
            var address = sockaddr_un(); address.sun_family = sa_family_t(AF_UNIX)
            let bytes = Array(path.utf8) + [0]
            guard bytes.count <= MemoryLayout.size(ofValue: address.sun_path) else { throw GDNativeFailure(message: "The companion socket path is too long.") }
            withUnsafeMutableBytes(of: &address.sun_path) { $0.copyBytes(from: bytes) }
            address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
            if fm.fileExists(atPath: path) {
                try Self.privatePath(URL(fileURLWithPath: path), kind: .typeSocket)
                let probe = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
                let connected = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
                let failure = errno; Darwin.close(probe)
                guard connected != 0, failure == ECONNREFUSED else { throw GDNativeFailure(message: "Another GenDragoon companion is already listening. Use that app instance.") }
                guard unlink(path) == 0 else { throw GDNativeFailure(message: "Could not replace an inactive owned companion socket.") }
            }
            let bound = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) } }
            guard bound == 0, chmod(path, 0o600) == 0, Darwin.listen(fd, 8) == 0 else { throw GDNativeFailure(message: "Could not start the private companion listener.") }
            let info: [String: Any] = ["schema": 1, "socketPath": path, "protocol": "gendragoon-companion-v1"]
            let locator = endpoint.appendingPathComponent("endpoint.json")
            try JSONSerialization.data(withJSONObject: info).write(to: locator, options: .atomic)
            try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: locator.path)
            descriptor = fd; keep = true; status = "Native companion ready. Each extension needs your approval for this account."
            Self.listen(fd, owner: self)
        } catch { status = GDNativeMessage.safe(error.localizedDescription) }
    }

    nonisolated private static func privatePath(_ url: URL, kind: FileAttributeType) throws {
        let fm = FileManager.default
        var path = url
        while path.path != "/" {
            let attributes = try fm.attributesOfItem(atPath: path.path)
            guard attributes[.type] as? FileAttributeType != .typeSymbolicLink else { throw GDNativeFailure(message: "Companion paths cannot contain symbolic links.") }
            path.deleteLastPathComponent()
        }
        let attributes = try fm.attributesOfItem(atPath: url.path)
        guard attributes[.type] as? FileAttributeType == kind,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0o777) & 0o077 == 0 else {
            throw GDNativeFailure(message: "Companion files must be private and owned by your local account.")
        }
    }
    nonisolated private static func readExact(_ fd: Int32, count: Int) throws -> Data {
        var data = Data(count: count), offset = 0
        while offset < count {
            let n = data.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress!.advanced(by: offset), count - offset) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw GDNativeFailure(message: "The companion request was interrupted.") }
            offset += n
        }
        return data
    }
    nonisolated private static func write(_ fd: Int32, response: [String: Any]) throws {
        var payload = try JSONSerialization.data(withJSONObject: response)
        if payload.count > 256 * 1024 {
            payload = try JSONSerialization.data(withJSONObject: ["id": response["id"] ?? "", "ok": false,
                "error": ["code": "response_too_large", "message": "Open the native Files view for this large library."]])
        }
        var length = UInt32(payload.count).littleEndian
        var frame = withUnsafeBytes(of: &length) { Data($0) }; frame.append(payload)
        var offset = 0
        while offset < frame.count {
            let n = frame.withUnsafeBytes { Darwin.write(fd, $0.baseAddress!.advanced(by: offset), frame.count - offset) }
            if n < 0 && errno == EINTR { continue }
            guard n > 0 else { throw GDNativeFailure(message: "The companion response was interrupted.") }
            offset += n
        }
    }
    nonisolated private static func listen(_ descriptor: Int32, owner: GDCompanion) {
        DispatchQueue.global(qos: .utility).async {
            let slots = DispatchSemaphore(value: 8)
            while true {
                let fd = accept(descriptor, nil, nil)
                if fd < 0 { if errno == EINTR { continue }; return }
                guard slots.wait(timeout: .now()) == .success else { Darwin.close(fd); continue }
                DispatchQueue.global(qos: .utility).async {
                    var uid: uid_t = 0, gid: gid_t = 0, noSignal: Int32 = 1
                    guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else { Darwin.close(fd); slots.signal(); return }
                    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSignal, socklen_t(MemoryLayout<Int32>.size))
                    var timeout = timeval(tv_sec: 35, tv_usec: 0)
                    _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
                    _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
                    do {
                        let header = try readExact(fd, count: 4)
                        let size = header.enumerated().reduce(UInt32(0)) { $0 | UInt32($1.element) << (8 * $1.offset) }
                        guard size > 0 && size <= 256 * 1024 else { throw GDNativeFailure(message: "Invalid companion frame.") }
                        let data = try readExact(fd, count: Int(size))
                        guard let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw GDNativeFailure(message: "Invalid companion request.") }
                        Task { @MainActor in
                            let response = await owner.handle(value)
                            DispatchQueue.global(qos: .utility).async {
                                try? write(fd, response: response); Darwin.close(fd); slots.signal()
                            }
                        }
                    } catch { Darwin.close(fd); slots.signal() }
                }
            }
        }
    }

    private func permittedClient(_ client: [String: Any]) -> String? {
        guard Set(client.keys) == ["kind", "id"], let kind = client["kind"] as? String, let id = client["id"] as? String else { return nil }
        let configURL = base.appendingPathComponent("NativeMessaging/config.json")
        do {
            try Self.privatePath(configURL.deletingLastPathComponent(), kind: .typeDirectory)
            try Self.privatePath(configURL, kind: .typeRegular)
            let data = try Data(contentsOf: configURL); guard data.count <= 16384,
                  let config = try JSONSerialization.jsonObject(with: data) as? [String: Any], config["schema"] as? Int == 1 else { return nil }
            if kind == "browser", (config["allowedOrigins"] as? [String])?.contains(id) == true,
               id == "gendragoon@redxai.local" || id.range(of: "^chrome-extension://[a-p]{32}/$", options: .regularExpression) != nil { return kind + ":" + id }
            if kind == "vscode", id == "redxai.gendragoon", config["vscodeExtensionId"] as? String == id { return kind + ":" + id }
        } catch { return nil }
        return nil
    }
    private func approval(_ client: String, account: String) -> Bool {
        let key = "GDCompanionApproval." + account + "." + client
        if UserDefaults.standard.bool(forKey: key) { return true }
        let alert = NSAlert(); alert.messageText = "Allow this GenDragoon extension?"
        alert.informativeText = client + " requests access to this account's file listings and development Teams. Uploads require a local selection and retain originals. It cannot read file contents, use billing, or issue API keys."
        alert.addButton(withTitle: "Allow for this account"); alert.addButton(withTitle: "Deny")
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        UserDefaults.standard.set(true, forKey: key); return true
    }
    func revokeApprovals() {
        for key in UserDefaults.standard.dictionaryRepresentation().keys where key.hasPrefix("GDCompanionApproval.") { UserDefaults.standard.removeObject(forKey: key) }
        completed.removeAll(); status = "Extension approvals cleared. Future requests need your approval."
    }
    static func allowedRoute(_ path: String, method: String) -> Bool {
        guard path.utf8.count <= 4096, !path.contains("\\"), !path.contains("#"), !path.contains("\r"), !path.contains("\n"),
              let parsed = URLComponents(string: path), parsed.scheme == nil, parsed.host == nil,
              !parsed.percentEncodedPath.contains("%"), !parsed.path.contains(".."),
              ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method) else { return false }
        let p = parsed.path
        let metadata = method == "GET" && (p == "/v1/receivers/me" || p.range(of: "^/v1/receivers/me/workspaces/[a-f0-9]{32}/library$", options: .regularExpression) != nil)
        let teams = p.range(of: #"^/v1/receivers/(?:me/dev-(?:profile|teams|community)|me/dev-reports(?:/[a-f0-9]{32})?|me/workspaces/[a-f0-9]{32}/team|teams/(?:join|[a-f0-9]{32}(?:/(?:members|invites|messages|presence|signals|membership|blocks|reports)(?:/[a-f0-9]{32})?)?))$"#, options: .regularExpression) != nil
        let queries = parsed.queryItems ?? []
        return (metadata || teams) && (teams || queries.isEmpty) && queries.allSatisfy { ["limit", "cursor"].contains($0.name) } && Set(queries.map(\.name)).count == queries.count
    }
    private func handle(_ envelope: [String: Any]) async -> [String: Any] {
        let request = envelope["request"] as? [String: Any] ?? [:]
        let id = request["id"] as? String ?? String(repeating: "0", count: 32)
        func failure(_ code: String, _ message: String) -> [String: Any] { ["id": id, "ok": false, "error": ["code": code, "message": message]] }
        guard Set(envelope.keys) == ["schema", "client", "request"], envelope["schema"] as? Int == 1,
              let client = envelope["client"] as? [String: Any], let label = permittedClient(client),
              Set(request.keys).isSubset(of: ["id", "method", "params"]), id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let method = request["method"] as? String, let params = request["params"] as? [String: Any] else { return failure("request_denied", "Reinstall and enable the explicit extension ID before connecting.") }
        let auth = GDRedXAIAuthSession.shared, account = auth.receiverID
        if method == "status", params.isEmpty { return ["id": id, "ok": true, "result": ["connected": auth.linked, "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "development"]] }
        guard auth.linked, approval(label, account: account) else { return failure("approval_required", "Connect your account and approve this extension in GenDragoon.") }
        let key = account + label + id
        completed = completed.filter { Date().timeIntervalSince($0.value.0) < 600 }
        if let prior = completed[key] { return prior.1 }
        guard pending.count < 8, !pending.contains(key) else { return failure("request_pending", "This request is already pending. Check the native app.") }
        pending.insert(key); defer { pending.remove(key) }
        do {
            var result: [String: Any]
            switch method {
            case "request":
                guard Set(params.keys).isSubset(of: ["path", "method", "body"]), let path = params["path"] as? String,
                      let verb = params["method"] as? String, Self.allowedRoute(path, method: verb),
                      params["body"] == nil || verb != "GET" && params["body"] is [String: Any] else { return failure("route_denied", "This route is outside the extension metadata and Teams interface.") }
                result = try await auth.serviceRequest(path: path, method: verb, json: params["body"] as? [String: Any])
                if path == "/v1/receivers/me" {
                    result = result.filter { ["schema", "machineNotes", "workspaces", "ready", "quotaBytes", "usedBytes", "workerLimit"].contains($0.key) }
                }
            case "selectUpload", "uploadSelection":
                guard Set(params.keys).isSubset(of: ["workspaceId", "kind", "selectedPaths"]), let workspaceID = params["workspaceId"] as? String,
                      workspaceID.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                      GDUpdateActivity.shared.canStart() else { return failure("upload_busy", "Wait for the active operation before selecting an upload.") }
                await GDNativeWorkspace.shared.start(); await GDNativeWorkspace.shared.refreshCloudChoices()
                guard let note = auth.uploadProjects.flatMap({ $0.buckets }).first(where: { $0.id == workspaceID }) else { return failure("workspace_denied", "Choose an available MachineNote owned by this account.") }
                var urls: [URL]
                if method == "selectUpload" {
                    guard params["selectedPaths"] == nil, let kind = params["kind"] as? String, ["file", "folder"].contains(kind) else { return failure("request_invalid", "Choose the native file or folder picker.") }
                    let panel = NSOpenPanel(); panel.title = "Upload to " + note.displayName; panel.message = "Choose your own files, applications or folders. Originals will be retained."
                    panel.canChooseFiles = kind == "file"; panel.canChooseDirectories = true; panel.allowsMultipleSelection = true; panel.treatsFilePackagesAsDirectories = false
                    let answer = await withCheckedContinuation { continuation in panel.begin { continuation.resume(returning: $0) } }
                    guard answer == .OK else { return ["id": id, "ok": true, "result": ["queued": false, "cancelled": true]] }
                    urls = panel.urls
                } else {
                    guard client["kind"] as? String == "vscode", params["kind"] == nil,
                          let paths = params["selectedPaths"] as? [String], !paths.isEmpty, paths.count <= 64,
                          paths.allSatisfy({ $0.hasPrefix("/") && !$0.contains("\0") && $0.utf8.count <= 4096 }) else { return failure("request_invalid", "Select local paths explicitly in VS Code.") }
                    urls = paths.map { URL(fileURLWithPath: $0) }
                    let alert = NSAlert(); alert.messageText = "Upload \(urls.count) selected item(s)?"
                    alert.informativeText = "MachineNote: " + note.displayName + "\n" + urls.prefix(6).map(\.lastPathComponent).joined(separator: "\n") + "\nOriginals remain on this Mac."
                    alert.addButton(withTitle: "Upload"); alert.addButton(withTitle: "Cancel")
                    guard alert.runModal() == .alertFirstButtonReturn else { return ["id": id, "ok": true, "result": ["queued": false, "cancelled": true]] }
                }
                guard auth.receiverID == account, auth.linked else { return failure("account_changed", "Your account changed; no upload was queued.") }
                let destination = UploadDestination(project: "redxai", bucket: note.id, remote: note.remote, prefix: note.prefix)
                let jobID = try await GDNativeWorkspace.shared.upload.enqueueCompanion(urls, destination: destination)
                result = ["queued": true, "jobId": jobID, "message": "Upload queued in GenDragoon. Originals retained; view progress in Files."]
            default: return failure("method_denied", "This companion method is unsupported.")
            }
            guard auth.receiverID == account, auth.linked else { return failure("account_changed", "Your account changed. Reconnect the extension.") }
            let response: [String: Any] = ["id": id, "ok": true, "result": result]
            if completed.count >= 100 { completed.removeAll() }
            completed[key] = (Date(), response); return response
        } catch { return failure("operation_failed", GDNativeMessage.safe(error.localizedDescription)) }
    }
}

struct GDCompanionPanel: View {
    @ObservedObject private var companion = GDCompanion.shared
    var body: some View {
        GroupBox("Browser and VS Code extensions") {
            VStack(alignment: .leading, spacing: 10) {
                Text(companion.status).font(.caption)
                Text("Install the native host for your exact extension IDs. Approve each client in GenDragoon. Browser and editor clients can list your storage, use Teams and select your own uploads; development peers cannot transfer stored files.").font(.caption).foregroundStyle(.secondary)
                Button("Clear extension approvals") { companion.revokeApprovals() }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }.task { companion.start() }
    }
}
