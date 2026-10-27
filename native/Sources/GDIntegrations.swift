import AppKit
import Combine
import CryptoKit
import Foundation
import Security
import SwiftUI

struct GDIntegrationService: Identifiable {
    let id: String
    let name: String
    let status: String
    let limits: [String]
    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, let name = value["name"] as? String,
              let status = value["status"] as? String else { return nil }
        self.id = id; self.name = name; self.status = status
        limits = value["limits"] as? [String] ?? []
    }
}

struct GDIntegrationKeySummary: Identifiable {
    let id: String
    let name: String
    let service: String
    let workspaceID: String
    let scopes: [String]
    let expires: String
    let active: Bool
    var detail: String {
        let expiry = active ? "Expires " + String(expires.prefix(10)) : "Inactive"
        return [service, scopes.joined(separator: ", "), expiry].joined(separator: " · ")
    }
    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, id.range(of: "^[a-f0-9]{16}$", options: .regularExpression) != nil,
              let name = value["name"] as? String, let service = value["service"] as? String,
              let workspace = value["workspaceId"] as? String,
              let scopes = value["scopes"] as? [String], let expires = value["expiresAt"] as? String,
              let active = value["active"] as? Bool else { return nil }
        self.id = id; self.name = name; self.service = service; workspaceID = workspace
        self.scopes = scopes; self.expires = expires; self.active = active
    }
}

struct GDBYOConnection: Identifiable, Hashable {
    let id: String
    let name: String
    let origin: String
    let database: String
    let pack: String
    init?(_ value: [String: Any]) {
        guard let id = value["id"] as? String, id.range(of: "^byo_[a-f0-9]{32}$", options: .regularExpression) != nil,
              value["kind"] as? String == "redx-db-byo", value["hostingFeeCents"] as? Int == 0,
              let name = value["name"] as? String, let origin = value["origin"] as? String,
              let database = value["database"] as? String, let pack = value["pack"] as? String else { return nil }
        self.id = id; self.name = name; self.origin = origin; self.database = database; self.pack = pack
    }
    var config: [String: Any] {
        var value: [String: Any] = ["origin": origin, "database": database, "pack": pack]
        if let url = URL(string: origin), url.scheme == "http", ["127.0.0.1", "localhost", "[::1]", "::1"].contains(url.host ?? "") { value["development"] = true }
        return value
    }
}

struct GDBYOArchive: Identifiable {
    var id: String { path }
    let path: String
    let name: String
    let kind: String
    let parent: String
    let bytes: Int64
    var applicationPlatform: String? { GDApplicationPlatform.hint(name: name, kind: kind, declared: nil) }
    init?(_ value: [String: Any]) {
        guard let path = value["path"] as? String, let name = value["name"] as? String,
              let kind = value["kind"] as? String, ["file", "folder", "app"].contains(kind),
              value["encrypted"] as? Bool == true, let bytes = value["archiveBytes"] as? NSNumber,
              bytes.int64Value > 0 else { return nil }
        self.path = path; self.name = name; self.kind = kind; self.bytes = bytes.int64Value
        parent = value["logicalParent"] as? String ?? ""
    }
}

struct GDBYORawEntry: Identifiable {
    var id: String { path }
    let path: String
    let name: String
    let directory: Bool
    let bytes: Int64
    init?(_ value: [String: Any]) {
        guard let path = value["path"] as? String, let name = value["name"] as? String,
              let directory = value["is_dir"] as? Bool, let bytes = value["size"] as? NSNumber,
              bytes.int64Value >= 0 else { return nil }
        self.path = path; self.name = name; self.directory = directory; self.bytes = bytes.int64Value
    }
}

struct GDIncomingIntegrationConnect: Identifiable {
    let id = UUID()
    let state: String
    let challenge: String
    let callback: URL
    let expires: Date
}

private enum GDBYOKeychain {
    static let service = "com.redxai.gendragoon.byo.v1"
    static func query(_ account: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
    }
    static func read(_ account: String) throws -> [String: String]? {
        var q = query(account); q[kSecReturnData] = true; q[kSecMatchLimit] = kSecMatchLimitOne
        var item: CFTypeRef?
        let result = SecItemCopyMatching(q as CFDictionary, &item)
        if result == errSecItemNotFound { return nil }
        guard result == errSecSuccess, let data = item as? Data, data.count <= 4096,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: String] else {
            throw GDNativeFailure(message: "The BYO connection's private Keychain credentials are unavailable.")
        }
        return try GDBYOVaultPolicy.record(value)
    }
    static func write(_ account: String, value: [String: String]) throws {
        _ = try GDBYOVaultPolicy.record(value)
        let data = try JSONSerialization.data(withJSONObject: value)
        guard data.count <= 4096 else { throw GDNativeFailure(message: "Invalid BYO credential size.") }
        let q = query(account)
        let result = SecItemUpdate(q as CFDictionary, [kSecValueData: data] as CFDictionary)
        if result == errSecSuccess { return }
        guard result == errSecItemNotFound else { throw GDNativeFailure(message: "macOS Keychain could not update this BYO connection.") }
        var item = q; item[kSecValueData] = data; item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else { throw GDNativeFailure(message: "macOS Keychain could not save this BYO connection.") }
    }
    static func installRecovery(_ account: String, secret: String) throws {
        let existing = try read(account)
        let retained = try GDBYOVaultPolicy.recovery(existing: existing, secret: secret)
        if existing != nil { return }
        var item = query(account)
        item[kSecValueData] = try JSONSerialization.data(withJSONObject: retained)
        item[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let result = SecItemAdd(item as CFDictionary, nil)
        if result == errSecDuplicateItem {
            guard let concurrent = try read(account) else { throw GDPortableVaultFailure(message: "Keychain changed during recovery. Existing keys were preserved.") }
            _ = try GDBYOVaultPolicy.recovery(existing: concurrent, secret: secret)
        } else if result != errSecSuccess {
            throw GDPortableVaultFailure(message: "Keychain could not save the recovered BYO secret. Existing keys were preserved.")
        }
    }
    static func randomSecret() throws -> String {
        var bytes = Data(count: 32)
        guard bytes.withUnsafeMutableBytes({ SecRandomCopyBytes(kSecRandomDefault, 32, $0.baseAddress!) }) == errSecSuccess else {
            throw GDNativeFailure(message: "Secure random generation failed.")
        }
        return bytes.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

/// Retained independently of the selected sidebar page. Keys never enter a JSON
/// metadata request, UserDefaults, a URL, a process argument or the activity text.
@MainActor final class GDIntegrationsModel: ObservableObject {
    static let shared = GDIntegrationsModel()
    @Published private(set) var services: [GDIntegrationService] = []
    @Published private(set) var keys: [GDIntegrationKeySummary] = []
    @Published private(set) var connections: [GDBYOConnection] = []
    @Published private(set) var archives: [GDBYOArchive] = []
    @Published private(set) var rawEntries: [GDBYORawEntry] = []
    @Published private(set) var busy = false { didSet { GDUpdateActivity.shared.set(self, key: "integrations", active: busy) } }
    @Published private(set) var message = ""
    @Published var oneTimeKey: String?
    @Published private(set) var oneTimeTitle = "API key"
    @Published var selectedConnectionID = ""
    @Published private(set) var rawPath = ""
    @Published private(set) var hasPendingRedXCode = false
    @Published private(set) var receivedRedXCode = ""
    @Published private(set) var incomingConnect: GDIncomingIntegrationConnect?
    private var owner = ""
    private var pendingRedXCode: [String: Any]?
    private var pendingRedXExpiry = Date.distantPast
    private let auth = GDRedXAIAuthSession.shared
    var selectedConnection: GDBYOConnection? { connections.first { $0.id == selectedConnectionID } }
    var availableServices: [GDIntegrationService] { services.filter { $0.status == "available" } }
    var canStart: Bool { auth.linked && !busy && GDUpdateActivity.shared.canStart(excluding: self) }

    func accountChanged() {
        guard owner != auth.receiverID else { return }
        owner = auth.receiverID; services = []; keys = []; connections = []; archives = []; rawEntries = []
        selectedConnectionID = ""; rawPath = ""; oneTimeKey = nil; message = ""
        clearConnectCode()
        incomingConnect = nil
    }
    private func verify(_ expected: String) throws {
        guard auth.linked, auth.receiverID == expected, owner == expected else {
            throw GDNativeFailure(message: "The Red-XAI account changed. Refresh Integrations.")
        }
    }
    private func operation(_ body: @escaping (String) async throws -> Void) {
        accountChanged()
        guard canStart else { message = "Finish the current activity before starting another integration operation."; return }
        let expected = owner; busy = true; message = ""
        Task {
            defer { busy = false }
            do { try await body(expected) }
            catch { if auth.receiverID == expected { message = GDNativeMessage.safe(error.localizedDescription) } }
        }
    }
    private func helper(_ action: String, _ config: [String: Any], expected: String) async throws -> [String: Any] {
        try verify(expected)
        let input = try JSONSerialization.data(withJSONObject: config)
        let result = try await GDNativeHelper.invoke("gendragoon_redx_pack", arguments: [action], standardInput: input)
        try verify(expected)
        return result
    }
    private func readMetadata(_ expected: String) async throws {
        let service = try await auth.serviceRequest(path: "/v1/integrations/services")
        try verify(expected)
        let keyState = try await auth.serviceRequest(path: "/v1/integrations/keys")
        try verify(expected)
        let byo = try await auth.serviceRequest(path: "/v1/integrations/byo")
        try verify(expected)
        services = (service["services"] as? [[String: Any]] ?? []).compactMap(GDIntegrationService.init)
        keys = (keyState["keys"] as? [[String: Any]] ?? []).compactMap(GDIntegrationKeySummary.init)
        connections = (byo["workspaces"] as? [[String: Any]] ?? []).compactMap(GDBYOConnection.init)
        if !connections.contains(where: { $0.id == selectedConnectionID }) {
            selectedConnectionID = connections.first?.id ?? ""; archives = []; rawEntries = []; rawPath = ""
        }
    }
    func refresh() { operation { expected in try await self.readMetadata(expected) } }
    func issue(name: String, service: String, workspace: String, write: Bool) {
        operation { expected in
            let result = try await self.auth.serviceRequest(path: "/v1/integrations/keys", method: "POST", json: ["name": name, "service": service, "workspaceId": workspace, "scopes": write ? ["files:read", "files:write"] : ["files:read"]])
            try self.verify(expected)
            guard let key = result["apiKey"] as? String, key.range(of: "^gdpk_[a-f0-9]{16}_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw GDNativeFailure(message: "The service returned no valid one-time integration key.") }
            self.oneTimeKey = key
            self.oneTimeTitle = "API key"
            try await self.readMetadata(expected)
            self.message = "Key created. Copy it now; the service stores its hash and cannot show it again."
        }
    }
    func issueGrant(name: String, service: String, workspace: String, write: Bool) {
        operation { expected in
            let result = try await self.auth.serviceRequest(path: "/provider/v1/connect/grants", method: "POST", json: ["name": name, "service": service, "workspaceId": workspace, "scopes": write ? ["files:read", "files:write"] : ["files:read"]])
            try self.verify(expected)
            guard let grant = result["grant"] as? String, grant.range(of: "^gdpg_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil else { throw GDNativeFailure(message: "The service returned no valid connection grant.") }
            self.oneTimeTitle = "Connection grant"; self.oneTimeKey = grant
            self.message = "Paste this single-use grant into the requesting app within five minutes. Its exchanged storage key uses the same scope and MachineNote."
        }
    }
    /// Called by the app's URL dispatcher. The link is untrusted input and only
    /// opens a consent request; it cannot select a note, mint a key or autoapprove.
    func receiveConnectURL(_ url: URL) {
        accountChanged()
        guard auth.linked else { message = "Connect your Red-XAI account, then reopen the external app's connection request."; return }
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == "gendragoon", parts.host == "connect",
              parts.path.isEmpty || parts.path == "/", parts.fragment == nil, parts.user == nil, parts.password == nil,
              let items = parts.queryItems, Set(items.map(\.name)).count == items.count else { message = "The integration connection link is invalid."; return }
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard query["v"] == "1", query["provider"] == "rottenapple", query["app"] == nil,
              query["pkce_method"] == nil || query["pkce_method"] == "S256",
              let state = query["state"], state.range(of: "^[A-Za-z0-9_-]{22,128}$", options: .regularExpression) != nil,
              let challenge = query["pkce_challenge"], challenge.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
              query["callback"] == "rottenapple://gendragoon-callback", let callback = URL(string: "rottenapple://gendragoon-callback"),
              query["host"] == nil || query["host"] == "" || query["host"] == "https://api.red-xai.com" || query["host"] == "https://api.red-xai.com/",
              query["pin"] == nil || query["pin"] == "" else { message = "This integration request does not match the supported RottenApple S256 callback and GenDragoon host contract."; return }
        incomingConnect = GDIncomingIntegrationConnect(state: state, challenge: challenge, callback: callback, expires: Date().addingTimeInterval(30 * 60))
        message = "An app requested a RottenApple storage connection. Select one MachineNote and review the storage permission before approving."
    }
    func declineIncoming() { incomingConnect = nil; message = "Connection request declined. No grant or key was created." }
    func approveIncoming(workspace: String, write: Bool) {
        guard let incoming = incomingConnect else { return }
        operation { expected in
            guard Date() < incoming.expires else { self.incomingConnect = nil; throw GDNativeFailure(message: "This connection request expired. Start it again in RottenApple.") }
            let result = try await self.auth.serviceRequest(path: "/provider/v1/connect/authorize", method: "POST", json: ["service": "rottenapple-store", "workspaceId": workspace, "name": "RottenApple", "scopes": write ? ["files:read", "files:write"] : ["files:read"], "codeChallengeMethod": "S256", "codeChallenge": incoming.challenge, "state": incoming.state])
            try self.verify(expected)
            guard let code = result["code"] as? String, code.range(of: "^gdpc_[A-Za-z0-9_-]{43}$", options: .regularExpression) != nil,
                  var callback = URLComponents(url: incoming.callback, resolvingAgainstBaseURL: false) else { throw GDNativeFailure(message: "The service did not create a valid S256 connection code.") }
            callback.queryItems = [URLQueryItem(name: "code", value: code), URLQueryItem(name: "state", value: incoming.state), URLQueryItem(name: "host", value: "https://api.red-xai.com")]
            guard let url = callback.url else { throw GDNativeFailure(message: "The supported callback could not be prepared.") }
            if self.incomingConnect?.id == incoming.id { self.incomingConnect = nil }
            NSWorkspace.shared.open(url)
            self.message = "A one-use code was sent to RottenApple. Only its matching private S256 verifier can exchange it for this MachineNote's storage key. File binding inside the current external launcher remains unavailable."
        }
    }
    func clearConnectCode() { pendingRedXCode = nil; hasPendingRedXCode = false; pendingRedXExpiry = .distantPast; receivedRedXCode = "" }
    func receiveRedXCallback(_ url: URL) {
        guard let pending = pendingRedXCode, Date() < pendingRedXExpiry,
              let parts = URLComponents(url: url, resolvingAgainstBaseURL: false), parts.scheme == "gendragoon", parts.host == "redx-callback",
              parts.path.isEmpty, parts.fragment == nil, parts.user == nil, parts.password == nil,
              let items = parts.queryItems, Set(items.map(\.name)).count == items.count else { return }
        let query = Dictionary(uniqueKeysWithValues: items.map { ($0.name, $0.value ?? "") })
        guard query["state"] == pending["state"] as? String, query["host"] == pending["origin"] as? String,
              let code = query["code"], code.range(of: "^RX-[A-Z0-9-]{5,64}$", options: .regularExpression) != nil else { return }
        receivedRedXCode = code
        message = "The matching RedX approval code arrived. Click Exchange Code to finish."
    }
    private func localConfig(_ config: [String: Any]) -> [String: Any] {
        var value = config
        if let origin = config["origin"] as? String, let url = URL(string: origin), url.scheme == "http", ["127.0.0.1", "localhost", "[::1]", "::1"].contains(url.host ?? "") { value["development"] = true }
        return value
    }
    func beginRedX(origin: String, database: String, pack: String) {
        operation { expected in
            let value = self.localConfig(["origin": origin, "database": database, "pack": pack])
            let result = try await self.helper("connect-begin", value, expected: expected)
            guard let link = result["url"] as? String, let url = URL(string: link), let state = result["state"] as? String,
                  let verifier = result["pkceVerifier"] as? String, let base = result["origin"] as? String else { throw GDNativeFailure(message: "RedX connection preparation failed.") }
            self.pendingRedXCode = self.localConfig(["origin": base, "database": database, "pack": pack, "state": state, "pkceVerifier": verifier])
            self.pendingRedXExpiry = Date().addingTimeInterval(30 * 60); self.hasPendingRedXCode = true
            NSWorkspace.shared.open(url)
            self.message = "Approve GenDragoon in your RedX console, then paste the one-time RX code here. No host administrator key enters GenDragoon."
        }
    }
    func exchangeRedX(_ code: String, completion: @escaping (String) -> Void) {
        operation { expected in
            guard var value = self.pendingRedXCode, Date() < self.pendingRedXExpiry else { self.clearConnectCode(); throw GDNativeFailure(message: "Start a new RedX connection request; this one expired.") }
            let code = code.trimmingCharacters(in: .whitespacesAndNewlines)
            guard code.range(of: "^RX-[A-Z0-9-]{5,64}$", options: .regularExpression) != nil,
                  let base = value["origin"] as? String, let url = URL(string: base + "/v1/connect/exchange"),
                  let verifier = value["pkceVerifier"] as? String, let state = value["state"] as? String else { throw GDNativeFailure(message: "Invalid RedX one-time code.") }
            // The creation-only external key response remains in memory. The
            // ordinary helper output collector uses a private temporary file.
            var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 60
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: ["code": code, "state": state, "pkce_verifier": verifier, "device_label": "GenDragoon Cloud SSD"])
            let session = URLSession(configuration: .ephemeral, delegate: GDMachineNotesRedirectDelegate(), delegateQueue: nil)
            defer { session.invalidateAndCancel() }
            let (data, response) = try await session.data(for: request)
            try self.verify(expected)
            guard let http = response as? HTTPURLResponse, http.url == url, http.statusCode == 200, data.count <= 32 * 1024,
                  let result = try JSONSerialization.jsonObject(with: data) as? [String: Any], result["api"] as? String == "v1",
                  let workspace = result["workspace"] as? [String: Any], workspace["db"] as? String == value["database"] as? String,
                  let scope = result["scope"] as? String, ["read", "write"].contains(scope),
                  let key = result["key"] as? String, key.range(of: "^rx_live_[A-Za-z0-9]+$", options: .regularExpression) != nil else { throw GDNativeFailure(message: "RedX did not exchange this code for the requested scoped workspace key. Start a new connection request.") }
            value.removeAll()
            self.clearConnectCode(); completion(key)
            self.message = "RedX issued a scoped app key. Verify and Connect to save it in Keychain."
        }
    }
    func revoke(_ key: GDIntegrationKeySummary) {
        operation { expected in
            _ = try await self.auth.serviceRequest(path: "/v1/integrations/keys/" + key.id, method: "DELETE")
            try self.verify(expected); try await self.readMetadata(expected)
            self.message = "Integration key revoked. The next request will be refused."
        }
    }
    private func context(_ config: [String: Any], expected: String) async throws -> [String: Any] {
        var value = localConfig(config); value["accountId"] = expected
        let result = try await helper("context", value, expected: expected)
        guard let receiver = result["receiverId"] as? String, receiver.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              let workspace = result["workspaceId"] as? String, workspace.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              let keymap = result["keymapPath"] as? String else { throw GDNativeFailure(message: "Invalid BYO encryption context.") }
        value["receiverId"] = receiver; value["workspaceId"] = workspace; value["keymapPath"] = keymap
        return value
    }
    private func credentials(_ connection: GDBYOConnection, expected: String) async throws -> [String: Any] {
        var value = try await context(connection.config, expected: expected)
        guard let receiver = value["receiverId"] as? String,
              let credentials = try GDBYOKeychain.read(GDBYOVaultPolicy.account(owner: expected, receiver: receiver)), credentials["key"] != nil else {
            throw GDNativeFailure(message: "Reconnect this BYO workspace on this Mac. Its key and encryption secret are stored only in macOS Keychain.")
        }
        for (key, secret) in credentials { value[key] = secret }
        return value
    }
    func connect(name: String, origin: String, database: String, pack: String, key: String, completion: @escaping () -> Void) {
        operation { expected in
            let metadata = ["name": name, "origin": origin, "database": database, "pack": pack]
            var value = try await self.context(metadata, expected: expected)
            value["key"] = key
            let probe = try await self.helper("probe", value, expected: expected)
            guard probe["authorized"] as? Bool == true, let receiver = value["receiverId"] as? String,
                  let keymap = value["keymapPath"] as? String else { throw GDNativeFailure(message: "The host did not verify this database-scoped key.") }
            let account = try GDBYOVaultPolicy.account(owner: expected, receiver: receiver)
            let old = try GDBYOKeychain.read(account)
            if old == nil, FileManager.default.fileExists(atPath: keymap) {
                throw GDNativeFailure(message: "This encrypted workspace has a keymap but its Keychain secret is missing. Recover that secret before reconnecting; creating a replacement could strand existing backups.")
            }
            if old == nil {
                let existing = try await self.helper("archives", value, expected: expected)
                if (existing["entries"] as? [[String: Any]])?.isEmpty == false {
                    throw GDNativeFailure(message: "Encrypted backups already exist for this account. Recover their Keychain storage secret and keymap on this Mac before connecting; the external API key alone cannot decrypt them.")
                }
            }
            let storageSecret = try old?["storageSecret"] ?? GDBYOKeychain.randomSecret()
            try GDBYOKeychain.write(account, value: ["key": key, "storageSecret": storageSecret])
            try self.verify(expected)
            let added = try await self.auth.serviceRequest(path: "/v1/integrations/byo", method: "POST", json: metadata)
            try self.verify(expected)
            try await self.readMetadata(expected)
            if let record = added["workspace"] as? [String: Any], let id = record["id"] as? String { self.selectedConnectionID = id }
            completion()
            self.message = "Connected your own RedX database. GenDragoon hosting costs $0; your host's own limits still apply."
            try await self.readBrowser(expected, connection: self.selectedConnection, path: "")
        }
    }
    func disconnect(_ connection: GDBYOConnection) {
        operation { expected in
            _ = try await self.auth.serviceRequest(path: "/v1/integrations/byo/" + connection.id, method: "DELETE")
            try self.verify(expected); try await self.readMetadata(expected)
            self.message = "Connection metadata removed. External files, encryption keymap and recovery credentials were retained; revoke the external key in RedX when appropriate."
        }
    }
    private func vaultOperation(_ body: @escaping (String) async throws -> Void) {
        accountChanged()
        do {
            guard canStart, !auth.busy, !auth.portableVaultBusy, try auth.accountDeletionPending() == nil,
                  !GDWorkspaceMounts.shared.hasMounts, GDUpdateActivity.shared.beginMaintenance(owner: self) else {
                throw GDPortableVaultFailure(message: "Finish transfers, close managed apps, unmount drives, and resolve pending account deletion before BYO recovery.")
            }
        } catch { message = GDNativeMessage.safe(error.localizedDescription); return }
        let expected = owner
        busy = true; message = ""
        Task {
            defer { busy = false; GDUpdateActivity.shared.endMaintenance(owner: self) }
            do { try await body(expected) }
            catch { if auth.receiverID == expected { message = GDNativeMessage.safe(error.localizedDescription) } }
        }
    }
    private func vaultHelper(_ action: String, context: [String: Any], expected: String,
                             extra: [String: String] = [:]) async throws -> [String: Any] {
        try verify(expected)
        var input = context.filter { ["origin", "database", "pack", "development", "accountId", "receiverId", "workspaceId", "keymapPath"].contains($0.key) }
        for (key, value) in extra { input[key] = value }
        let result = try await GDNativeHelper.invoke("gendragoon_byo_vault", arguments: [action], timeout: 120,
            standardInput: JSONSerialization.data(withJSONObject: input))
        try verify(expected)
        guard result["receiverId"] as? String == context["receiverId"] as? String,
              result["workspaceId"] as? String == context["workspaceId"] as? String,
              action == "preflight" || result["validated"] as? Bool == true else {
            throw GDPortableVaultFailure(message: "The BYO keymap did not verify for this account and connection.")
        }
        return result
    }
    func exportBYOVault(_ connection: GDBYOConnection, password: String) {
        vaultOperation { expected in
            let context = try await self.context(connection.config, expected: expected)
            _ = try await self.vaultHelper("preflight", context: context, expected: expected)
            guard let receiver = context["receiverId"] as? String, let path = context["keymapPath"] as? String,
                  let credentials = try GDBYOKeychain.read(GDBYOVaultPolicy.account(owner: expected, receiver: receiver)),
                  let secret = credentials["storageSecret"] else { throw GDPortableVaultFailure(message: "This BYO workspace has no encryption keys to export on this Mac.") }
            let bytes = try GDPortableVaultFiles.read(URL(fileURLWithPath: path), limit: 95)
            try GDPortableVaultCodec.validateKeymap(bytes)
            let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
            _ = try await self.vaultHelper("check-keymap", context: context, expected: expected,
                extra: ["storageSecret": secret, "keymapSha256": hash])
            let keys = GDPortableVaultCodec.Keys(receiverId: receiver, storageSecret: secret, keymap: bytes)
            let envelope = try await Task.detached(priority: .userInitiated) { try GDPortableVaultCodec.seal(keys, password: password) }.value
            _ = try await self.vaultHelper("preflight", context: context, expected: expected)
            let panel = NSSavePanel(); panel.title = "Export Encrypted BYO Recovery Vault"
            panel.nameFieldStringValue = "GenDragoon-BYO-" + String(receiver.prefix(12)) + ".gdbyovault"
            panel.message = "For this Red-XAI account and exact host, database and pack. Keep the passphrase separately. The database API key is excluded."
            guard panel.runModal() == .OK, let url = panel.url else { return }
            try self.verify(expected)
            let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            try GDPortableVaultFiles.create(envelope, at: url)
            self.message = "Encrypted BYO recovery vault exported. Keep its passphrase separately. On another Mac, connect the same account, enter this exact host/database/pack, import the vault, then obtain a new scoped database API key."
        }
    }
    func importBYOVault(config: [String: Any], password: String) {
        vaultOperation { expected in
            let context = try await self.context(config, expected: expected)
            _ = try await self.vaultHelper("preflight", context: context, expected: expected)
            guard let receiver = context["receiverId"] as? String, let path = context["keymapPath"] as? String else {
                throw GDPortableVaultFailure(message: "Invalid BYO recovery context.")
            }
            let panel = NSOpenPanel(); panel.title = "Import Encrypted BYO Recovery Vault"; panel.prompt = "Import"
            panel.canChooseDirectories = false; panel.allowsMultipleSelection = false
            panel.message = "Choose the vault for this account and exact host/database/pack. Existing different keys will be preserved."
            guard panel.runModal() == .OK, let url = panel.url else { return }
            let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let envelope = try GDPortableVaultFiles.read(url, limit: GDPortableVaultCodec.envelopeLimit)
            let keys = try await Task.detached(priority: .userInitiated) {
                try GDPortableVaultCodec.open(envelope, password: password, expectedReceiver: receiver)
            }.value
            try self.verify(expected)
            let account = try GDBYOVaultPolicy.account(owner: expected, receiver: receiver)
            _ = try GDBYOVaultPolicy.recovery(existing: GDBYOKeychain.read(account), secret: keys.storageSecret)
            let result = try await self.vaultHelper("install-keymap", context: context, expected: expected,
                extra: ["storageSecret": keys.storageSecret, "keymap": GDPortableVaultCodec.base64(keys.keymap)])
            let keymap = URL(fileURLWithPath: path)
            var installed = false
            defer { if !installed && result["created"] as? Bool == true { GDPortableVaultFiles.removeIfIdentical(keys.keymap, at: keymap) } }
            guard try GDPortableVaultFiles.read(keymap, limit: 95) == keys.keymap else { throw GDPortableVaultFailure(message: "The BYO keymap changed. Existing keys were preserved.") }
            try self.verify(expected)
            try GDBYOKeychain.installRecovery(account, secret: keys.storageSecret)
            installed = true
            self.message = "BYO encryption keys recovered for this account and exact host/database/pack. The database API key was not imported. Use Verify and Connect with a newly authorized scoped key when reconnecting."
        }
    }
    private func readBrowser(_ expected: String, connection: GDBYOConnection?, path: String) async throws {
        guard let connection else { archives = []; rawEntries = []; return }
        var value = try await credentials(connection, expected: expected)
        value["path"] = path
        let listing = try await helper(path.isEmpty ? "probe" : "list", value, expected: expected)
        let archiveListing = try await helper("archives", value, expected: expected)
        guard selectedConnectionID == connection.id else { return }
        rawPath = path
        rawEntries = (listing["entries"] as? [[String: Any]] ?? []).compactMap(GDBYORawEntry.init)
        archives = (archiveListing["entries"] as? [[String: Any]] ?? []).compactMap(GDBYOArchive.init)
    }
    func browse(_ path: String = "") {
        let connection = selectedConnection
        operation { expected in try await self.readBrowser(expected, connection: connection, path: path) }
    }
    func uploadSources() {
        guard canStart, let connection = selectedConnection else { return }
        let panel = NSOpenPanel(); panel.title = "Select Apps, Files or Folders"; panel.prompt = "Upload"
        panel.canChooseFiles = true; panel.canChooseDirectories = true; panel.allowsMultipleSelection = true
        panel.treatsFilePackagesAsDirectories = false
        guard panel.runModal() == .OK, !panel.urls.isEmpty else { return }
        let urls = panel.urls, logicalParent = rawPath
        operation { expected in
            var value = try await self.credentials(connection, expected: expected)
            value["path"] = logicalParent; value["offload"] = false
            for url in urls {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                value["source"] = url.path
                let result = try await self.helper("upload-source", value, expected: expected)
                guard result["verified"] as? Bool == true, result["encrypted"] as? Bool == true, result["offloaded"] as? Bool == false else { throw GDNativeFailure(message: "The encrypted backup did not return a verified result. The original was retained.") }
            }
            self.message = "Encrypted backups verified by complete remote readback and metadata restore. Original items remain on this Mac."
            try await self.readBrowser(expected, connection: connection, path: logicalParent)
        }
    }
    func restore(_ archive: GDBYOArchive) {
        guard canStart, let connection = selectedConnection else { return }
        guard GDApplicationPlatform.mayRestoreOnMac(archive.applicationPlatform) else {
            message = "This application or installer backup requires " + GDApplicationPlatform.label(archive.applicationPlatform ?? "unknown") + " for restoration. It cannot run as a Mac application."; return
        }
        let panel = NSOpenPanel(); panel.title = "Choose a Folder for the Verified Restore"; panel.prompt = "Restore"
        panel.canChooseFiles = false; panel.canChooseDirectories = true; panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        operation { expected in
            let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            var value = try await self.credentials(connection, expected: expected)
            value["path"] = archive.path; value["destination"] = url.path
            let result = try await self.helper("restore-source", value, expected: expected)
            guard result["verified"] as? Bool == true else { throw GDNativeFailure(message: "The restored item did not verify.") }
            self.message = "Restored and verified " + archive.name + ". Existing items were preserved."
        }
    }
    func downloadRaw(_ entry: GDBYORawEntry) {
        guard canStart, !entry.directory, let connection = selectedConnection else { return }
        let panel = NSSavePanel(); panel.title = "Download Raw Pack File"; panel.nameFieldStringValue = entry.name
        guard panel.runModal() == .OK, let url = panel.url else { return }
        operation { expected in
            let scoped = url.startAccessingSecurityScopedResource(); defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            var value = try await self.credentials(connection, expected: expected); value["path"] = entry.path; value["destination"] = url.path
            _ = try await self.helper("get", value, expected: expected)
            self.message = "Raw pack file downloaded with SHA-256 verification. Its format and encryption belong to the program that wrote it."
        }
    }
}

@MainActor struct GDIntegrationsView: View {
    @ObservedObject private var model = GDIntegrationsModel.shared
    @ObservedObject private var auth = GDRedXAIAuthSession.shared
    @ObservedObject private var activity = GDUpdateActivity.shared
    @State private var keyName = ""
    @State private var service = "redxai-db"
    @State private var workspace = ""
    @State private var allowWrite = false
    @State private var connectionName = ""
    @State private var origin = ""
    @State private var database = "gendragoon"
    @State private var pack = "gendragoon"
    @State private var externalKey = ""
    @State private var vaultPassword = ""
    @State private var vaultConfirmation = ""
    @State private var recoverEnteredConnection = false
    @State private var byoPlatform = "all"
    @State private var redXCode = ""
    @State private var pendingRevoke: GDIntegrationKeySummary?
    @State private var pendingDisconnect: GDBYOConnection?
    private var buckets: [UploadCloudBucket] { auth.readableProjects.flatMap(\.buckets) }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                HStack { VStack(alignment: .leading) { Text("Integrations").font(.largeTitle.bold()); Text("Scoped app keys and your own Red-XAI-DB storage.").foregroundStyle(.secondary) }; Spacer(); Button("Refresh") { model.refresh() }.disabled(!model.canStart) }
                if !auth.linked { Text("Connect your Red-XAI account to manage integrations.").foregroundStyle(.secondary) }
                GDDiskSpaceNotice()
                catalog
                if model.incomingConnect != nil { incomingSection }
                keysSection
                byoSection
                if model.busy { HStack { ProgressView().controlSize(.small); Text("Working… Keep GenDragoon open while transfers finish.") }.font(.caption) }
                if !model.message.isEmpty { Text(model.message).font(.callout).textSelection(.enabled) }
            }.padding(24).frame(maxWidth: 1050, alignment: .leading)
        }
        .task { model.accountChanged(); if model.services.isEmpty { model.refresh() } }
        .onChange(of: auth.receiverID) { _, _ in externalKey = ""; clearVaultPassword(); model.accountChanged(); if auth.linked { model.refresh() } }
        .onChange(of: origin) { _, _ in model.clearConnectCode(); externalKey = ""; redXCode = ""; clearVaultPassword() }
        .onChange(of: database) { _, _ in model.clearConnectCode(); externalKey = ""; redXCode = ""; clearVaultPassword() }
        .onChange(of: pack) { _, _ in model.clearConnectCode(); externalKey = ""; redXCode = ""; clearVaultPassword() }
        .onChange(of: model.receivedRedXCode) { _, code in if !code.isEmpty { redXCode = code } }
        .onChange(of: model.selectedConnectionID) { _, _ in clearVaultPassword(); if model.canStart { model.browse() } }
        .onChange(of: recoverEnteredConnection) { _, _ in clearVaultPassword() }
        .onDisappear { model.oneTimeKey = nil; model.clearConnectCode(); externalKey = ""; redXCode = ""; clearVaultPassword() }
        .sheet(isPresented: Binding(get: { model.oneTimeKey != nil }, set: { if !$0 { model.oneTimeKey = nil } })) { secretSheet }
        .alert("Revoke this integration key?", isPresented: Binding(get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } })) {
            Button("Cancel", role: .cancel) { pendingRevoke = nil }
            Button("Revoke", role: .destructive) { if let key = pendingRevoke { model.revoke(key) }; pendingRevoke = nil }
        } message: { Text(pendingRevoke?.name ?? "") }
        .alert("Disconnect this BYO workspace?", isPresented: Binding(get: { pendingDisconnect != nil }, set: { if !$0 { pendingDisconnect = nil } })) {
            Button("Cancel", role: .cancel) { pendingDisconnect = nil }
            Button("Disconnect") { if let connection = pendingDisconnect { model.disconnect(connection) }; pendingDisconnect = nil }
        } message: { Text("External data and recovery credentials are retained. This removes the saved connection metadata.") }
    }
    private var catalog: some View {
        GroupBox("Available service contracts") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(model.services) { item in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack { Text(item.name).font(.headline); Spacer(); Text(item.status == "available" ? "GenDragoon API available" : item.status.replacingOccurrences(of: "-", with: " ")).font(.caption).foregroundStyle(item.status == "available" ? Color.green : Color.secondary) }
                        ForEach(item.limits, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) }
                    }
                }
                Text("Other programs remain unchanged. A documented connect contract does not imply that an external app has implemented cloud storage.").font(.caption).foregroundStyle(.secondary)
            }.padding(8)
        }
    }
    private var keysSection: some View {
        GroupBox("Integration API keys for one MachineNote") {
            VStack(alignment: .leading, spacing: 12) {
                Text("These storage-only grants expire after 90 days, can be revoked immediately, and follow the MachineNote's current allowance. They grant no billing, team, key-management or administrator access.").font(.caption).foregroundStyle(.secondary)
                TextField("Key name", text: $keyName)
                HStack {
                    Picker("Service", selection: $service) { ForEach(model.availableServices) { Text($0.name).tag($0.id) } }
                    Picker("MachineNote", selection: $workspace) { Text("Choose a MachineNote").tag(""); ForEach(buckets) { Text($0.displayName).tag($0.id) } }
                }
                Toggle("Allow uploads and file changes", isOn: $allowWrite)
                HStack {
                    Button("Create API Key") { model.issue(name: keyName, service: service, workspace: workspace, write: allowWrite) }
                    Button("Create Connection Grant") { model.issueGrant(name: keyName, service: service, workspace: workspace, write: allowWrite) }
                }.disabled(!model.canStart || workspace.isEmpty || keyName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                ForEach(model.keys) { key in
                    HStack {
                        VStack(alignment: .leading) {
                            Text(key.name).font(.headline)
                            Text(key.detail).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer(); if key.active { Button("Revoke") { pendingRevoke = key }.disabled(!model.canStart) }
                    }
                }
            }.padding(8).disabled(!auth.linked || model.busy)
        }
    }
    private var incomingSection: some View {
        GroupBox("RottenApple connection request") {
            VStack(alignment: .leading, spacing: 12) {
                Text("Review this request before approving. The link claims the RottenApple provider; it does not prove the identity of the program that opened it. Approval delegates only the selected MachineNote and permission. The callback carries a one-use S256 code, never your session or API key.").font(.caption).foregroundStyle(.secondary)
                Picker("MachineNote", selection: $workspace) { Text("Choose a MachineNote").tag(""); ForEach(buckets) { Text($0.displayName).tag($0.id) } }
                Toggle("Allow uploads and file changes", isOn: $allowWrite)
                Text("The current RottenApple launcher can pair with this contract, but its storageBind file feature is not implemented in that program.").font(.caption).foregroundStyle(.secondary)
                HStack { Button("Decline") { model.declineIncoming() }; Button("Approve Selected Storage") { model.approveIncoming(workspace: workspace, write: allowWrite) }.buttonStyle(.borderedProminent).disabled(workspace.isEmpty) }.disabled(!model.canStart)
            }.padding(8)
        }
    }
    private var byoSection: some View {
        GroupBox("Your own Red-XAI-DB workspace") {
            VStack(alignment: .leading, spacing: 12) {
                Text("GenDragoon hosting fee: $0. Storage stays in your host's actual .red-xai-pack files. Your host's own plan and quotas still apply. This connection is separate from paid Red-XAI MachineNotes.").font(.callout)
                DisclosureGroup("Connect a scoped RedX database key") {
                    VStack(alignment: .leading) {
                        TextField("Connection name", text: $connectionName)
                        TextField("HTTPS host origin", text: $origin)
                        HStack { TextField("Database", text: $database); TextField("Pack", text: $pack) }
                        Button("Start RedX S256 Connection…") { model.beginRedX(origin: origin, database: database, pack: pack) }.disabled(!model.canStart || origin.isEmpty || database.isEmpty)
                        if model.hasPendingRedXCode {
                            HStack { TextField("One-time RX code from your RedX console", text: $redXCode); Button("Exchange Code") { model.exchangeRedX(redXCode) { externalKey = $0; redXCode = "" } }.disabled(!model.canStart || redXCode.isEmpty) }
                        }
                        SecureField("Database-scoped RedX read or write key", text: $externalKey)
                        Text("Use the RedX console's GenDragoon S256 connection flow to obtain a scoped key, or supply an existing database-scoped key. Host administrator keys are refused. The external key and a separate encryption secret stay in this Mac's Keychain.").font(.caption).foregroundStyle(.secondary)
                        Button("Verify and Connect") { model.connect(name: connectionName, origin: origin, database: database, pack: pack, key: externalKey) { externalKey = "" } }.disabled(!model.canStart || externalKey.isEmpty || connectionName.isEmpty || origin.isEmpty)
                    }.padding(.top, 8)
                }
                Picker("BYO workspace", selection: $model.selectedConnectionID) { Text("Choose a connection").tag(""); ForEach(model.connections) { Text($0.name + " · " + $0.database).tag($0.id) } }.disabled(!model.canStart)
                byoRecovery
                if let selected = model.selectedConnection {
                    HStack { Text(selected.origin + " / " + selected.database + " / " + selected.pack).font(.caption).foregroundStyle(.secondary); Spacer(); Button("Disconnect…") { pendingDisconnect = selected }.disabled(!model.canStart) }
                    HStack { Button("Upload Apps, Files or Folders…") { model.uploadSources() }.buttonStyle(.borderedProminent); Button("Refresh Files") { model.browse(model.rawPath) } }.disabled(!model.canStart)
                    Text("GenDragoon backups use encrypted visual PNG chunks and preserve complete apps, folders and Mac metadata. Uploads retain original files. Export an encrypted BYO recovery vault before moving to another Mac; the external API key alone cannot decrypt these backups.").font(.caption).foregroundStyle(.secondary)
                    Text("Encrypted GenDragoon backups").font(.headline)
                    Picker("Application platform", selection: $byoPlatform) {
                        Text("All backups").tag("all")
                        ForEach(GDApplicationPlatform.codes, id: \.self) { Text(GDApplicationPlatform.label($0)).tag($0) }
                    }
                    if model.archives.isEmpty { Text("No published verified backups in this connection.").font(.caption).foregroundStyle(.secondary) }
                    ForEach(model.archives.filter { byoPlatform == "all" || ($0.applicationPlatform ?? "unknown") == byoPlatform }) { archive in
                        HStack { Image(systemName: archive.kind == "app" ? "app" : archive.kind == "folder" ? "folder" : "doc"); VStack(alignment: .leading) { Text(archive.name); Text((archive.applicationPlatform.map { GDApplicationPlatform.label($0) + " app backup · " } ?? "") + (archive.parent.isEmpty ? "Root" : archive.parent) + " · " + ByteCountFormatter.string(fromByteCount: archive.bytes, countStyle: .file)).font(.caption).foregroundStyle(.secondary) }; Spacer(); Button("Restore…") { model.restore(archive) }.disabled(!model.canStart || !GDApplicationPlatform.mayRestoreOnMac(archive.applicationPlatform)) }
                    }
                    Text("Application platform is a backup filename/type hint, not a compatibility certificate. These BYO records do not identify the uploading device. Restore apps on their original platform; ordinary documents remain portable.").font(.caption).foregroundStyle(.secondary)
                    Divider()
                    HStack { Text("Raw database pack files").font(.headline); Spacer(); Button("Root") { model.browse() }.disabled(!model.canStart || model.rawPath.isEmpty); Button("Up") { model.browse(model.rawPath.split(separator: "/").dropLast().joined(separator: "/")) }.disabled(!model.canStart || model.rawPath.isEmpty) }
                    Text(model.rawPath.isEmpty ? "/" : model.rawPath).font(.caption.monospaced()).textSelection(.enabled)
                    Text("Raw browsing shows existing host files without changing their format. Download encrypted GenDragoon backups with Restore above; raw PNG carriers are not the original app or file.").font(.caption).foregroundStyle(.secondary)
                    ForEach(model.rawEntries) { entry in HStack { Image(systemName: entry.directory ? "folder" : "doc"); Text(entry.name); Spacer(); if entry.directory { Button("Open") { model.browse(entry.path) } } else { Text(ByteCountFormatter.string(fromByteCount: entry.bytes, countStyle: .file)).font(.caption).foregroundStyle(.secondary); Button("Download…") { model.downloadRaw(entry) } } }.disabled(!model.canStart) }
                }
            }.padding(8).disabled(!auth.linked || model.busy)
        }
    }
    private func clearVaultPassword() { vaultPassword = ""; vaultConfirmation = "" }
    private var byoRecovery: some View {
        let selected = model.selectedConnection
        let entered = recoverEnteredConnection || selected == nil
        let config: [String: Any] = entered ? ["origin": origin, "database": database, "pack": pack] : selected!.config
        let target = entered ? origin + " / " + database + " / " + pack : selected!.origin + " / " + selected!.database + " / " + selected!.pack
        return DisclosureGroup("Encrypted BYO recovery vault") {
            VStack(alignment: .leading, spacing: 8) {
                if selected != nil { Toggle("Use the host, database and pack entered in the connection form", isOn: $recoverEnteredConnection) }
                Text("Recovery target: " + target).font(.caption).textSelection(.enabled)
                Text("Bound to your currently connected Red-XAI account and this exact host/database/pack. The encrypted vault contains only the storage secret and encrypted keymap. It excludes database API keys and your paid MachineNote vault. On a new Mac, enter this connection, import first, then authorize a new scoped database key and choose Verify and Connect.").font(.caption).foregroundStyle(.secondary)
                SecureField("Recovery vault passphrase (at least 12 characters)", text: $vaultPassword)
                SecureField("Confirm passphrase for export", text: $vaultConfirmation)
                HStack {
                    Button("Export BYO Vault…") {
                        guard let selected, !entered else { return }
                        let password = vaultPassword; clearVaultPassword()
                        model.exportBYOVault(selected, password: password)
                    }.disabled(!model.canStart || entered || vaultPassword.isEmpty || vaultPassword != vaultConfirmation)
                    Button("Import BYO Vault…") {
                        let password = vaultPassword; clearVaultPassword()
                        model.importBYOVault(config: config, password: password)
                    }.disabled(!model.canStart || vaultPassword.isEmpty || (entered && (origin.isEmpty || database.isEmpty || pack.isEmpty)))
                }
                Text("Keep the vault and passphrase separately. Finish transfers and unmount drives first. Import preserves existing matching keys and refuses different keys.").font(.caption).foregroundStyle(.secondary)
            }.padding(.top, 8)
        }
    }
    private var secretSheet: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Copy your " + model.oneTimeTitle.lowercased() + " now").font(.title2.bold())
            Text(model.oneTimeTitle == "Connection grant" ? "Paste this grant into the requesting app within five minutes. It can be exchanged only once." : "The service keeps a hash. This secret is displayed only in this window and cannot be retrieved later.")
            Text(model.oneTimeKey ?? "").font(.system(.body, design: .monospaced)).textSelection(.enabled).padding().background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
            HStack { Button("Copy Key") { if let key = model.oneTimeKey { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(key, forType: .string) } }; Spacer(); Button("Done") { model.oneTimeKey = nil }.keyboardShortcut(.defaultAction) }
        }.padding(24).frame(width: 650)
    }
}
