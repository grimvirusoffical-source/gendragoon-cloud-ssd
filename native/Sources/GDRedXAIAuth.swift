import Foundation
import AppKit
import CryptoKit
import Security

private struct GDRXProfile: Codable {
    let schema: Int
    let issuer: String
    let clientId: String
    let authProvider: String
    let subject: String
    let cloudApi: String
    let receiverId: String
    let storageFormat: String
    let development: Bool
    let requiresAppSignIn: Bool
    let sessionStorage: String?
}

private struct GDRXTokenSet {
    let access: String
    let refresh: String
    let subject: String
    let email: String?
    let expiresAt: Date
}

@MainActor private final class GDWorkerRenewalLease {
    var token: String
    init(_ token: String) { self.token = token }
}

@MainActor final class GDRedXAIAuthSession: ObservableObject {
    static let shared = GDRedXAIAuthSession()
    enum State { case disconnected, connecting, linked, error }

    @Published private(set) var state: State = .disconnected
    @Published private(set) var status = "Connect your Red-XAI account or use REDXAI Auth-CLI."
    @Published private(set) var subject = ""
    @Published private(set) var email = ""
    @Published private(set) var receiverID = ""
    @Published private(set) var approvalCode = ""
    @Published private(set) var linked = false
    @Published private(set) var busy = false
    @Published private(set) var portableVaultBusy = false
    @Published private(set) var uploadProjects: [UploadCloudProject] = []
    @Published private(set) var readableProjects: [UploadCloudProject] = []
    @Published private(set) var quotaBytes: Int64 = 0
    @Published private(set) var usedBytes: Int64 = 0

    private let issuer = URL(string: "https://red-xai.com")!
    private let cloudAPI = URL(string: "https://api.red-xai.com")!
    private let clientID = "gendragoon"
    private let authService = "com.redxai.gendragoon.auth"
    private let storageService = "com.redxai.gendragoon.storage"
    private let session = URLSession(configuration: .ephemeral, delegate: GDMachineNotesRedirectDelegate(), delegateQueue: nil)
    private var tokens: GDRXTokenSet?
    private var refreshTask: Task<String, Error>?
    private var loaded = false

    private var profileURL: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Red-XAI/GenDragoon/cloud.json")
    }
    private var storageRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Red-XAI/GenDragoon/storage", isDirectory: true)
    }
    var keymapURL: URL? {
        guard !subject.isEmpty else { return nil }
        return storageRoot.appendingPathComponent(Self.storageAccount(issuer: issuer.absoluteString, subject: subject) + ".keymap")
    }

    private static func hex<S: Sequence>(_ data: S) -> String where S.Element == UInt8 {
        data.map { String(format: "%02x", $0) }.joined()
    }
    private static func digest(_ value: String) -> String {
        hex(SHA256.hash(data: Data(value.utf8)))
    }
    private static func authAccount(issuer: String, subject: String) -> String {
        digest(issuer + "\u{0}" + "gendragoon" + "\u{0}" + subject)
    }
    private static func storageAccount(issuer: String, subject: String) -> String {
        digest(issuer + "\u{0}" + "gendragoon-storage" + "\u{0}" + subject)
    }
    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
    private static func random(_ count: Int) throws -> Data {
        var data = Data(count: count)
        let result = data.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, count, $0.baseAddress!) }
        guard result == errSecSuccess else { throw GDTransferError(message: "Secure random generation failed.", status: 0) }
        return data
    }

    private static func keychainQuery(service: String, account: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: account]
    }
    private static func keychainRead(service: String, account: String) throws -> String? {
        var query = keychainQuery(service: service, account: account)
        query[kSecReturnData] = true
        query[kSecMatchLimit] = kSecMatchLimitOne
        var output: CFTypeRef?
        let result = SecItemCopyMatching(query as CFDictionary, &output)
        if result == errSecItemNotFound { return nil }
        guard result == errSecSuccess, let data = output as? Data,
              let value = String(data: data, encoding: .utf8), !value.isEmpty, value.utf8.count <= 4096 else {
            throw GDTransferError(message: "macOS Keychain could not read the Red-XAI app session.", status: 0)
        }
        return value
    }
    private static func keychainWrite(service: String, account: String, value: String) throws {
        let data = Data(value.utf8)
        guard !data.isEmpty, data.count <= 4096 else { throw GDTransferError(message: "Refusing an invalid Keychain credential.", status: 0) }
        let query = keychainQuery(service: service, account: account)
        let change: [CFString: Any] = [kSecValueData: data]
        let updated = SecItemUpdate(query as CFDictionary, change as CFDictionary)
        if updated == errSecSuccess { return }
        guard updated == errSecItemNotFound else { throw GDTransferError(message: "macOS Keychain could not update the Red-XAI app session.", status: 0) }
        var add = query
        add[kSecValueData] = data
        add[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else {
            throw GDTransferError(message: "macOS Keychain could not save the Red-XAI app session.", status: 0)
        }
    }
    private static func keychainDelete(service: String, account: String) {
        _ = SecItemDelete(keychainQuery(service: service, account: account) as CFDictionary)
    }

    private func request(_ base: URL, path: String, method: String = "GET", json: [String: Any]? = nil,
                         bearer: String? = nil, headers: [String: String] = [:], timeout: Double = 30) async throws -> (Data, HTTPURLResponse) {
        let url = base.appendingPathComponent(path)
        guard url.scheme == "https", url.host == base.host else { throw GDTransferError(message: "Unsafe Red-XAI endpoint.", status: 0) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        if let bearer { request.setValue("Bearer " + bearer, forHTTPHeaderField: "Authorization") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.url == url else { throw GDTransferError(message: "Red-XAI returned no valid HTTP response.", status: 0) }
        return (data, http)
    }

    private func jsonObject(_ data: Data) throws -> [String: Any] {
        guard data.count <= 128 * 1024,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw GDTransferError(message: "Red-XAI returned an invalid response.", status: 0)
        }
        return value
    }

    private func parseTokens(_ data: Data, expectedSubject: String? = nil) throws -> GDRXTokenSet {
        let object = try jsonObject(data)
        guard object["protocol"] as? String == "redx-site-session-v1",
              object["issuer"] as? String == issuer.absoluteString,
              object["client_id"] as? String == clientID,
              object["scope"] as? String == "gendragoon.receiver",
              (object["token_type"] as? String)?.lowercased() == "bearer",
              let access = object["access_token"] as? String, access.hasPrefix("rxca_"), access.count == 48,
              let refresh = object["refresh_token"] as? String, refresh.hasPrefix("rxcr_"), refresh.count == 48,
              let expires = object["expires_in"] as? NSNumber, expires.doubleValue > 0, expires.doubleValue <= 3600,
              let user = object["user"] as? [String: Any],
              let sub = user["sub"] as? String, !sub.isEmpty,
              user["email_verified"] as? Bool == true else {
            throw GDTransferError(message: "Red-XAI returned an invalid app token.", status: 401)
        }
        if let expectedSubject, expectedSubject != sub {
            throw GDTransferError(message: "The Red-XAI account changed. Approve the intended account again.", status: 401)
        }
        return GDRXTokenSet(access: access, refresh: refresh, subject: sub,
            email: user["email"] as? String, expiresAt: Date().addingTimeInterval(expires.doubleValue))
    }

    private func receiverID(for subject: String) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["red-xai-receiver/v1", issuer.absoluteString, subject], options: [.withoutEscapingSlashes])
        return Self.hex(SHA256.hash(data: data))
    }

    private func profileFromDisk() throws -> GDRXProfile? {
        let url = profileURL
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let attrs = try FileManager.default.attributesOfItem(atPath: url.path)
        guard attrs[.type] as? FileAttributeType == .typeRegular,
              ((attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0 else {
            throw GDTransferError(message: "The saved Red-XAI profile has unsafe permissions.", status: 0)
        }
        let p = try JSONDecoder().decode(GDRXProfile.self, from: Data(contentsOf: url))
        guard p.schema == 1, p.issuer == issuer.absoluteString, p.clientId == clientID,
              p.authProvider == "redx-site-session", p.cloudApi == cloudAPI.absoluteString,
              p.storageFormat == "redsecretsxai-png-v1", p.receiverId == (try receiverID(for: p.subject)) else {
            throw GDTransferError(message: "The saved Red-XAI profile failed validation.", status: 0)
        }
        return p
    }

    private func saveProfile(_ p: GDRXProfile) throws {
        let dir = profileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(p)
        let temp = dir.appendingPathComponent(".cloud-" + UUID().uuidString)
        guard FileManager.default.createFile(atPath: temp.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw GDTransferError(message: "Could not save the Red-XAI profile.", status: 0)
        }
        defer { try? FileManager.default.removeItem(at: temp) }
        _ = try FileManager.default.replaceItemAt(profileURL, withItemAt: temp, backupItemName: nil,
            options: .usingNewMetadataOnly)
    }

    private func saveProfileCreating(_ p: GDRXProfile) throws {
        if FileManager.default.fileExists(atPath: profileURL.path) { try saveProfile(p); return }
        let dir = profileURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        let data = try JSONEncoder().encode(p)
        guard FileManager.default.createFile(atPath: profileURL.path, contents: data, attributes: [.posixPermissions: 0o600]) else {
            throw GDTransferError(message: "Could not save the Red-XAI profile.", status: 0)
        }
    }

    private func storeRefresh(_ token: String, subject: String) throws {
        guard token.hasPrefix("rxcr_"), token.count == 48 else { throw GDTransferError(message: "Invalid Red-XAI refresh credential.", status: 401) }
        try Self.keychainWrite(service: authService, account: Self.authAccount(issuer: issuer.absoluteString, subject: subject), value: token)
    }

    private func loadRefresh(subject: String) throws -> String? {
        try Self.keychainRead(service: authService, account: Self.authAccount(issuer: issuer.absoluteString, subject: subject))
    }

    func storageCredential() throws -> String {
        guard try accountDeletionPending() == nil else { throw GDAccountDeletionFailure(message: "Account deletion is pending. Storage keys were retained until its verified completion.") }
        guard !subject.isEmpty else { throw GDTransferError(message: "Connect Red-XAI before cloud storage.", status: 401) }
        guard !portableVaultBusy else { throw GDTransferError(message: "Finish the portable vault operation before starting cloud work.", status: 0) }
        let account = Self.storageAccount(issuer: issuer.absoluteString, subject: subject)
        if let existing = try Self.keychainRead(service: storageService, account: account) { return existing }
        let secret = Self.base64URL(try Self.random(32))
        try Self.keychainWrite(service: storageService, account: account, value: secret)
        try FileManager.default.createDirectory(at: storageRoot, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700])
        return secret
    }

    private func beginPortableVault() throws -> (subject: String, receiver: String, keymap: URL) {
        guard try accountDeletionPending() == nil else { throw GDAccountDeletionFailure(message: "Resolve this account’s pending deletion before changing or exporting its private vault.") }
        guard linked, !subject.isEmpty, GDPortableVaultCodec.validReceiver(receiverID), let keymapURL,
              !busy, !portableVaultBusy else {
            throw GDPortableVaultFailure(message: "Connect the intended Red-XAI account before using a portable vault.")
        }
        guard !GDWorkspaceMounts.shared.hasMounts, GDUpdateActivity.shared.beginMaintenance(owner: self) else {
            throw GDPortableVaultFailure(message: "Finish transfers, close managed apps, and unmount cloud drives before using a portable vault.")
        }
        portableVaultBusy = true
        GDUpdateActivity.shared.set(self, key: "portableVault", active: true)
        return (subject, receiverID, keymapURL)
    }
    private func endPortableVault() {
        portableVaultBusy = false
        GDUpdateActivity.shared.set(self, key: "portableVault", active: false)
        GDUpdateActivity.shared.endMaintenance(owner: self)
    }
    private func validatePortableKeymap(secret: String, keymap: URL, bytes: Data) async throws {
        let hash = Self.hex(SHA256.hash(data: bytes))
        let input = try JSONSerialization.data(withJSONObject: ["storageSecret": secret, "keymapPath": keymap.path, "keymapSha256": hash])
        let result = try await GDNativeHelper.invoke("gendragoon_vault", arguments: ["check-keymap"], timeout: 120, standardInput: input)
        guard result["validated"] as? Bool == true else { throw GDPortableVaultFailure(message: "The encrypted keymap failed read-only validation.") }
    }
    func exportPortableVault(password: String) async throws -> Data {
        let context = try beginPortableVault()
        defer { endPortableVault() }
        let account = Self.storageAccount(issuer: issuer.absoluteString, subject: context.subject)
        guard let secret = try Self.keychainRead(service: storageService, account: account) else {
            throw GDPortableVaultFailure(message: "This device has no storage keys to export. Import your original vault before restoring another device's files.")
        }
        let bytes = try GDPortableVaultFiles.read(context.keymap)
        try GDPortableVaultCodec.validateKeymap(bytes)
        try await validatePortableKeymap(secret: secret, keymap: context.keymap, bytes: bytes)
        guard linked, subject == context.subject, receiverID == context.receiver else { throw GDPortableVaultFailure(message: "The connected account changed. Export was cancelled.") }
        let keys = GDPortableVaultCodec.Keys(receiverId: context.receiver, storageSecret: secret, keymap: bytes)
        return try await Task.detached(priority: .userInitiated) { try GDPortableVaultCodec.seal(keys, password: password) }.value
    }
    func importPortableVault(_ envelope: Data, password: String) async throws {
        let context = try beginPortableVault()
        defer { endPortableVault() }
        let keys = try await Task.detached(priority: .userInitiated) {
            try GDPortableVaultCodec.open(envelope, password: password, expectedReceiver: context.receiver)
        }.value
        guard linked, subject == context.subject, receiverID == context.receiver else { throw GDPortableVaultFailure(message: "The connected account changed. Import was cancelled.") }
        let account = Self.storageAccount(issuer: issuer.absoluteString, subject: context.subject)
        let existingSecret = try Self.keychainRead(service: storageService, account: account)
        guard existingSecret == nil || existingSecret == keys.storageSecret else {
            throw GDPortableVaultFailure(message: "This account already has different storage keys on this device. Import will not replace them.")
        }
        let root = context.keymap.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let attributes = try FileManager.default.attributesOfItem(atPath: root.path)
        guard root.resolvingSymlinksInPath().standardizedFileURL == root.standardizedFileURL,
              attributes[.type] as? FileAttributeType == .typeDirectory,
              (attributes[.ownerAccountID] as? NSNumber)?.uint32Value == getuid(),
              ((attributes[.posixPermissions] as? NSNumber)?.intValue ?? 0) & 0o077 == 0 else {
            throw GDPortableVaultFailure(message: "The private storage directory has unsafe permissions.")
        }
        var created = false, installed = false
        defer { if created && !installed { GDPortableVaultFiles.removeIfIdentical(keys.keymap, at: context.keymap) } }
        if FileManager.default.fileExists(atPath: context.keymap.path) {
            guard try GDPortableVaultFiles.read(context.keymap) == keys.keymap else {
                throw GDPortableVaultFailure(message: "A different keymap already exists. Import will not replace it.")
            }
        } else {
            try GDPortableVaultFiles.create(keys.keymap, at: context.keymap)
            created = true
        }
        try await validatePortableKeymap(secret: keys.storageSecret, keymap: context.keymap, bytes: keys.keymap)
        guard linked, subject == context.subject, receiverID == context.receiver,
              try GDPortableVaultFiles.read(context.keymap) == keys.keymap else {
            throw GDPortableVaultFailure(message: "The account or keymap changed. Import was cancelled.")
        }
        // Add only: even another process creating a credential cannot be overwritten.
        if existingSecret == nil {
            var query = Self.keychainQuery(service: storageService, account: account)
            query[kSecValueData] = Data(keys.storageSecret.utf8)
            query[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(query as CFDictionary, nil) == errSecSuccess else {
                throw GDPortableVaultFailure(message: "The storage credential already exists or Keychain could not save it. Existing keys were preserved.")
            }
        }
        installed = true
    }

    private func apply(_ set: GDRXTokenSet, receiver: String) throws {
        try storeRefresh(set.refresh, subject: set.subject)
        tokens = set
        subject = set.subject
        email = set.email ?? "Red-XAI account"
        receiverID = receiver
        linked = true
        state = .linked
        status = "Red-XAI connected · Receiver ready"
    }

    func restore() async {
        guard !loaded else { return }
        loaded = true
        do {
            guard let p = try profileFromDisk(), let refresh = try loadRefresh(subject: p.subject) else {
                state = .disconnected; linked = false; return
            }
            state = .connecting; status = "Restoring your Red-XAI app session…"
            let set = try await resume(refresh: refresh, expected: p.subject)
            let pending = try accountDeletionPending()
            if let pending, !pending.matches(subject: p.subject, receiver: p.receiverId) { throw GDAccountDeletionFailure(message: "Reconnect the account associated with the saved deletion request.") }
            let receiver: String
            if pending == nil { receiver = try await provision(access: set.access, expected: p.receiverId) }
            else { receiver = try await receiverForDeletion(set.subject, expected: p.receiverId) }
            try apply(set, receiver: receiver)
            if pending == nil { await refreshWorkspaces() } else { status = "Same account restored · resume its saved deletion receipt in Account." }
        } catch {
            tokens = nil; linked = false; state = .disconnected
            status = "Red-XAI app approval expired or was revoked. Connect again when you need cloud storage."
        }
    }

    private func resume(refresh: String, expected: String) async throws -> GDRXTokenSet {
        let (data, response) = try await request(issuer, path: "redxai-connect/refresh", method: "POST",
            json: ["client_id": clientID, "refresh_token": refresh])
        guard response.statusCode == 200 else {
            if response.statusCode == 401 { Self.keychainDelete(service: authService, account: Self.authAccount(issuer: issuer.absoluteString, subject: expected)) }
            throw GDTransferError(message: "Red-XAI session could not be resumed.", status: response.statusCode)
        }
        return try parseTokens(data, expectedSubject: expected)
    }

    private func provision(access: String, expected: String?) async throws -> String {
        let (data, response) = try await request(cloudAPI, path: "v1/receivers/me", method: "PUT", bearer: access)
        guard response.statusCode == 200 else { throw GDTransferError(message: "Red-XAI Receiver could not be linked.", status: response.statusCode) }
        let object = try jsonObject(data)
        guard object["state"] as? String == "ready", object["storageFormat"] as? String == "redsecretsxai-png-v1",
              let id = object["id"] as? String, id.count == 64,
              expected == nil || id == expected else {
            throw GDTransferError(message: "Red-XAI Receiver identity check failed.", status: 0)
        }
        return id
    }

    func connect() {
        guard !busy, !portableVaultBusy else { return }
        let pending: GDAccountDeletionPending?
        do { pending = try accountDeletionPending() } catch { status = "The saved deletion request needs review. Existing keys were retained."; return }
        guard !GDWorkspaceMounts.shared.hasMounts else { status = "Unmount all workspace drives before changing Red-XAI accounts. Refresh drive status if needed."; return }
        busy = true; state = .connecting; status = "Starting Red-XAI approval…"; approvalCode = ""
        Task {
            defer { busy = false }
            do {
                let verifier = Self.base64URL(try Self.random(32))
                let challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
                let (startData, startResponse) = try await request(issuer, path: "redxai-connect/start", method: "POST",
                    json: ["client_id": clientID, "code_challenge": challenge, "code_challenge_method": "S256"])
                guard startResponse.statusCode == 200 else { throw GDTransferError(message: "Could not start Red-XAI approval.", status: startResponse.statusCode) }
                let job = try jsonObject(startData)
                guard let device = job["device_code"] as? String, device.count == 43,
                      let code = job["user_code"] as? String, code.count == 8,
                      let rawURL = job["verification_uri"] as? String, let url = URL(string: rawURL),
                      url.scheme == "https", url.host == issuer.host,
                      ["/redxai-connect", "/redxai-connect/","/redxai-connectx"].contains(url.path) else {
                    throw GDTransferError(message: "Red-XAI returned an invalid approval request.", status: 0)
                }
                approvalCode = code
                status = "Approve GenDragoon in your browser · code " + code
                NSWorkspace.shared.open(url)
                let deadline = Date().addingTimeInterval(min(300, (job["expires_in"] as? NSNumber)?.doubleValue ?? 300))
                var delay = max(2.0, (job["interval"] as? NSNumber)?.doubleValue ?? 3)
                var tokenSet: GDRXTokenSet?
                while Date() < deadline {
                    try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
                    let (data, response) = try await request(issuer, path: "redxai-connect/token", method: "POST",
                        json: ["client_id": clientID, "device_code": device, "code_verifier": verifier])
                    if response.statusCode == 428 { continue }
                    if response.statusCode == 429 { delay = min(10, delay + 1); continue }
                    guard response.statusCode == 200 else { throw GDTransferError(message: "Red-XAI approval was denied or expired.", status: response.statusCode) }
                    tokenSet = try parseTokens(data, expectedSubject: pending?.subject); break
                }
                guard let set = tokenSet else { throw GDTransferError(message: "Red-XAI approval timed out.", status: 408) }
                let expectedReceiver = try receiverID(for: set.subject)
                let receiver: String
                if pending == nil { receiver = try await provision(access: set.access, expected: expectedReceiver) }
                else { receiver = try await receiverForDeletion(set.subject, expected: pending!.receiverID) }
                let p = GDRXProfile(schema: 1, issuer: issuer.absoluteString, clientId: clientID,
                    authProvider: "redx-site-session", subject: set.subject, cloudApi: cloudAPI.absoluteString,
                    receiverId: receiver, storageFormat: "redsecretsxai-png-v1", development: false,
                    requiresAppSignIn: false, sessionStorage: "os-credential-store")
                try saveProfileCreating(p)
                try apply(set, receiver: receiver)
                approvalCode = ""
                if pending == nil { await refreshWorkspaces() } else { status = "Same account approved · resume its saved deletion receipt in Account." }
            } catch {
                tokens = nil; linked = false; state = .error
                status = error.localizedDescription
            }
        }
    }

    func accessToken(forceRefresh: Bool = false, forAccountDeletion: Bool = false) async throws -> String {
        let pending = try accountDeletionPending()
        if let pending {
            guard forAccountDeletion, pending.matches(subject: subject, receiver: receiverID) else { throw GDAccountDeletionFailure(message: "Account deletion is pending. Resume the same account’s receipt in Account; new file, mount and plan operations are paused.") }
        } else if forAccountDeletion { throw GDAccountDeletionFailure(message: "No saved account deletion request is available.") }
        guard linked, !subject.isEmpty else { throw GDTransferError(message: "Connect Red-XAI first.", status: 401) }
        if !forceRefresh, let tokens, tokens.expiresAt.timeIntervalSinceNow > 30 { return tokens.access }
        if let refreshTask { return try await refreshTask.value }
        guard let refresh = try loadRefresh(subject: subject) else { throw GDTransferError(message: "Red-XAI app approval is missing.", status: 401) }
        let expected = subject
        let task = Task<String, Error> {
            let set = try await self.resume(refresh: refresh, expected: expected)
            guard self.subject == expected else { throw GDTransferError(message: "Red-XAI account changed.", status: 401) }
            let receiver: String
            if pending == nil { receiver = try await self.provision(access: set.access, expected: self.receiverID) }
            else { receiver = try await self.receiverForDeletion(set.subject, expected: self.receiverID) }
            try self.apply(set, receiver: receiver)
            return set.access
        }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    private let deletionAccount = "current-account-deletion-v1"
    func accountDeletionPending() throws -> GDAccountDeletionPending? {
        guard let raw = try Self.keychainRead(service: authService, account: deletionAccount) else { return nil }
        let value = try JSONDecoder().decode(GDAccountDeletionPending.self, from: Data(raw.utf8))
        try value.validate(); return value
    }
    private func saveAccountDeletion(_ pending: GDAccountDeletionPending) throws {
        try pending.validate()
        let data = try JSONEncoder().encode(pending)
        guard let raw = String(data: data, encoding: .utf8) else { throw GDAccountDeletionFailure(message: "Could not save the deletion recovery request.") }
        try Self.keychainWrite(service: authService, account: deletionAccount, value: raw)
    }
    private func receiverForDeletion(_ subject: String, expected: String) async throws -> String {
        guard let pending = try accountDeletionPending(), pending.matches(subject: subject, receiver: expected),
              expected == (try receiverID(for: subject)) else { throw GDAccountDeletionFailure(message: "Approve the same Red-XAI account to recover this deletion request.") }
        return expected // Authenticated token/user subject checked; never PUT-provision a deleted Receiver.
    }
    func beginAccountDeletion() throws -> GDAccountDeletionPending {
        guard linked, !busy, !portableVaultBusy, refreshTask == nil else { throw GDAccountDeletionFailure(message: "Finish current authentication and key operations before requesting deletion.") }
        if let saved = try accountDeletionPending() {
            guard saved.matches(subject: subject, receiver: receiverID) else { throw GDAccountDeletionFailure(message: "Reconnect the account associated with the saved deletion request.") }
            return saved
        }
        let pending = try GDAccountDeletionPending(subject: subject, receiverID: receiverID, idempotencyKey: Self.hex(try Self.random(16)))
        try saveAccountDeletion(pending)
        uploadProjects = []; readableProjects = []; status = "Account deletion pending · resume the saved receipt in Account."
        return pending
    }
    func requestAccountDeletion(_ pending: GDAccountDeletionPending, retry: Bool) async throws -> (GDAccountDeletionPending, GDAccountDeletionResponse.Receipt?) {
        guard pending == (try accountDeletionPending()), pending.matches(subject: subject, receiver: receiverID) else { throw GDAccountDeletionFailure(message: "Reconnect the same Red-XAI account before resuming this request.") }
        let token = try await accessToken(forceRefresh: true, forAccountDeletion: true)
        let body: [String: Any]? = retry ? ["confirmation": "DELETE GENDRAGOON", "idempotencyKey": pending.idempotencyKey] : nil
        let (data, response) = try await request(cloudAPI, path: "gendragoon/v2/account/deletion", method: retry ? "POST" : "GET", json: body, bearer: token)
        guard (retry ? [200, 202] : [200]).contains(response.statusCode) else {
            let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            let code = object?["error"] as? String ?? ""
            let message: String
            switch code {
            case "account_deletion_busy": message = "The server still sees an active operation. Wait, then retry the same request. Local keys were retained."
            case "idempotency_conflict": message = "Another deletion request already exists for this account. Keep this saved request and contact support; local keys were retained."
            case "billing_review_required": message = "Deletion needs billing review. Contact support and retain this request."
            default: message = "The deletion service did not confirm this request (HTTP \(response.statusCode)). Retry the same saved request when connected. Local keys were retained."
            }
            throw GDAccountDeletionFailure(message: message)
        }
        guard pending.matches(subject: subject, receiver: receiverID) else { throw GDAccountDeletionFailure(message: "The connected account changed. Local keys were retained.") }
        let result = try GDAccountDeletionResponse.decode(data, pending: pending)
        var bound = pending
        if retry, let receipt = result.deletion { bound = try pending.binding(receipt.id); try saveAccountDeletion(bound) }
        return (bound, result.deletion)
    }
    func finishAccountDeletion(_ pending: GDAccountDeletionPending, receipt: GDAccountDeletionResponse.Receipt) throws {
        guard pending == (try accountDeletionPending()), receipt.authorizesCleanup(pending: pending, subject: subject, receiver: receiverID),
              !busy, !portableVaultBusy, !GDWorkspaceMounts.shared.hasMounts else { throw GDAccountDeletionFailure(message: "Matching completed deletion and an idle account are required before local cleanup.") }
        // Verify the shared profile belongs to this exact account before unlinking any file.
        if let profile = try profileFromDisk(), !pending.matches(subject: profile.subject, receiver: profile.receiverId) { throw GDAccountDeletionFailure(message: "A different local account profile was retained. Cleanup needs review.") }
        let oldRefresh = try loadRefresh(subject: pending.subject)
        let account = Self.storageAccount(issuer: issuer.absoluteString, subject: pending.subject)
        let map = storageRoot.appendingPathComponent(account + ".keymap")
        let candidates = [map, map.appendingPathExtension("gen"), profileURL]
        let files = try candidates.compactMap { try GDAccountDeletionOwnedFiles.inspect($0) }
        try GDAccountDeletionOwnedFiles.remove(files)
        for (service, name) in [(storageService, account), (authService, Self.authAccount(issuer: issuer.absoluteString, subject: pending.subject))] {
            let result = SecItemDelete(Self.keychainQuery(service: service, account: name) as CFDictionary)
            guard result == errSecSuccess || result == errSecItemNotFound else { throw GDAccountDeletionFailure(message: "Cloud deletion completed, but macOS Keychain cleanup needs attention. The saved receipt was retained.") }
        }
        tokens = nil; linked = false; subject = ""; email = ""; receiverID = ""; state = .disconnected
        uploadProjects = []; readableProjects = []; quotaBytes = 0; usedBytes = 0
        let result = SecItemDelete(Self.keychainQuery(service: authService, account: deletionAccount) as CFDictionary)
        guard result == errSecSuccess || result == errSecItemNotFound else { throw GDAccountDeletionFailure(message: "Cloud deletion and local key cleanup completed; the saved receipt still needs Keychain cleanup.") }
        status = "GenDragoon account deletion verified. This account’s keys and app session were removed; originals and unattributed local caches/jobs were retained."
        if let oldRefresh { Task { _ = try? await request(issuer, path: "redxai-connect/revoke", method: "POST", json: ["token": oldRefresh]) } }
    }

    func logout() {
        guard !portableVaultBusy else { status = "Finish the portable vault operation before disconnecting."; return }
        guard !busy else { return }
        guard !GDWorkspaceMounts.shared.hasMounts else { status = "Unmount all workspace drives before disconnecting. Open files and macOS filesystem caches remain bound to this account."; return }
        let oldSubject = subject
        let oldRefresh = try? loadRefresh(subject: oldSubject)
        Self.keychainDelete(service: authService, account: Self.authAccount(issuer: issuer.absoluteString, subject: oldSubject))
        tokens = nil; linked = false; subject = ""; email = ""; receiverID = ""; state = .disconnected
        uploadProjects = []; readableProjects = []; quotaBytes = 0; usedBytes = 0
        status = "GenDragoon Red-XAI app session cleared. Your website session remains signed in."
        if let oldRefresh {
            Task { _ = try? await request(issuer, path: "redxai-connect/revoke", method: "POST", json: ["token": oldRefresh]) }
        }
    }

    private func applyReceiverState(_ data: Data) throws {
        let object = try jsonObject(data)
        guard object["id"] as? String == receiverID,
              object["storageFormat"] as? String == "redsecretsxai-png-v1",
              let quota = object["quotaBytes"] as? NSNumber,
              let used = object["usedBytes"] as? NSNumber,
              let workspaces = (object["machineNotes"] ?? object["workspaces"]) as? [[String: Any]] else {
            throw GDTransferError(message: "Red-XAI MachineNotes response failed validation.", status: 0)
        }
        var buckets: [UploadCloudBucket] = []
        var readableBuckets: [UploadCloudBucket] = []
        for workspace in workspaces {
            guard let id = workspace["id"] as? String,
                  id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                  let rawName = workspace["name"] as? String,
                  let active = workspace["active"] as? Bool,
                  let readOnly = workspace["readOnly"] as? Bool else { continue }
            let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
            guard let workerCount = workspace["workers"] as? NSNumber else { continue }
            let workers = workerCount.intValue
            guard !name.isEmpty, name.count <= 80, (0...24).contains(workers), workerCount.doubleValue == Double(workers) else { continue }
            let writable = active && !readOnly && workers > 0
            readableBuckets.append(UploadCloudBucket(id: id, displayName: name, remote: "redxai", prefix: "Library", workers: writable ? workers : 1))
            if writable { buckets.append(UploadCloudBucket(id: id, displayName: name, remote: "redxai", prefix: "Library", workers: workers)) }
        }
        buckets.sort { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
        readableBuckets.sort { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
        uploadProjects = buckets.isEmpty ? [] : [
            UploadCloudProject(id: "redxai", displayName: "MachineNotes", buckets: buckets)
        ]
        readableProjects = readableBuckets.isEmpty ? [] : [
            UploadCloudProject(id: "redxai", displayName: "MachineNotes", buckets: readableBuckets)
        ]
        quotaBytes = quota.int64Value
        usedBytes = used.int64Value
    }

    func refreshWorkspaces() async {
        guard linked else { uploadProjects = []; readableProjects = []; quotaBytes = 0; usedBytes = 0; return }
        do {
            let token = try await accessToken()
            let (data, response) = try await request(cloudAPI, path: "v1/receivers/me", bearer: token)
            guard response.statusCode == 200 else {
                throw GDTransferError(message: "Could not load Red-XAI MachineNotes.", status: response.statusCode)
            }
            try applyReceiverState(data)
        } catch {
            status = "Red-XAI MachineNotes refresh needs attention: " + error.localizedDescription
        }
    }

    func createWorkspace(name rawName: String) async throws {
        guard linked else { throw GDTransferError(message: "Connect Red-XAI first.", status: 401) }
        let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 80,
              name.rangeOfCharacter(from: .controlCharacters) == nil else {
            throw GDTransferError(message: "MachineNote name must contain 1–80 printable characters.", status: 400)
        }
        let identifier = Self.hex(try Self.random(16))
        let token = try await accessToken()
        let (data, response) = try await request(cloudAPI, path: "v1/receivers/me/workspaces",
            method: "POST", json: ["name": name], bearer: token, headers: ["Idempotency-Key": identifier])
        guard response.statusCode == 201 || response.statusCode == 200 else {
            throw GDTransferError(message: "Red-XAI MachineNote creation failed.", status: response.statusCode)
        }
        let object = try jsonObject(data)
        guard object["id"] as? String == identifier else {
            throw GDTransferError(message: "Red-XAI MachineNote identity check failed.", status: 0)
        }
        await refreshWorkspaces()
    }

    var usageSummary: String {
        guard quotaBytes > 0 else { return linked ? "Choose and activate a MachineNote storage plan to begin." : "Storage quota is loading…" }
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: usedBytes) + " used of " + formatter.string(fromByteCount: quotaBytes)
    }

    func privateWorkerInput(workspaceID: String, constrained: Bool, requireWrite: Bool = false) async throws -> Data {
        guard workspaceID.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              receiverID.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw GDTransferError(message: "Choose a valid Red-XAI MachineNote.", status: 400)
        }
        let authorized = requireWrite ? uploadProjects : readableProjects
        guard let destination = authorized.flatMap({ $0.buckets }).first(where: { $0.id == workspaceID }),
              (1...24).contains(destination.workers) else {
            throw GDTransferError(message: requireWrite ? "Choose an active MachineNote with a storage plan before uploading." : "Choose a MachineNote owned by this account before restoring files.", status: requireWrite ? 402 : 403)
        }
        let expectedSubject = subject, expectedReceiver = receiverID
        let account = Self.storageAccount(issuer: issuer.absoluteString, subject: expectedSubject)
        let existingSecret = try Self.keychainRead(service: storageService, account: account)
        let hasKeymap = keymapURL.map { FileManager.default.fileExists(atPath: $0.path) } ?? false
        if existingSecret == nil || !hasKeymap {
            // A fresh device must import the original keys before touching an
            // existing encrypted account. New keys are safe only for an empty account.
            let state = try await serviceRequest(path: "/v1/receivers/me")
            guard state["id"] as? String == expectedReceiver,
                  let used = state["usedBytes"] as? NSNumber, CFGetTypeID(used) != CFBooleanGetTypeID(), used.doubleValue == 0,
                  let items = state["libraryItems"] as? NSNumber, CFGetTypeID(items) != CFBooleanGetTypeID(), items.doubleValue == 0 else {
                throw GDTransferError(message: "Import the portable vault from the device that uploaded these files before using this account's encrypted storage.", status: 0)
            }
        }
        let token = try await accessToken()
        guard linked, !portableVaultBusy, subject == expectedSubject, receiverID == expectedReceiver else {
            throw GDTransferError(message: "The Red-XAI account changed. Refresh before retrying.", status: 401)
        }
        let secret = try storageCredential()
        guard let keymapURL else { throw GDTransferError(message: "Red-XAI keymap path is unavailable.", status: 0) }
        let workers = destination.workers
        let payload: [String: Any] = [
            "provider": "redxai",
            "workspaceId": workspaceID,
            "workers": workers,
            "bearerToken": token,
            "authSubject": subject,
            "authRequireWrite": requireWrite,
            "receiverId": receiverID,
            "storageSecret": secret,
            "keymapPath": keymapURL.path,
            "cloudApi": cloudAPI.absoluteString,
            "constrained": constrained
        ]
        return try JSONSerialization.data(withJSONObject: payload)
    }

    func workerRenewalAuthorization(_ value: [String: Any]) throws ->
        (receiver: String, workspace: String, renew: @Sendable (Bool) async throws -> String) {
        guard linked, value["authSubject"] as? String == subject,
              value["receiverId"] as? String == receiverID,
              let workspace = value["workspaceId"] as? String,
              let token = value["bearerToken"] as? String,
              let requireWrite = value["authRequireWrite"] as? Bool else {
            throw GDTransferError(message: "The helper's Red-XAI account changed. Refresh before retrying.", status: 401)
        }
        let expectedSubject = subject, expectedReceiver = receiverID
        let lease = GDWorkerRenewalLease(token)
        return (expectedReceiver, workspace, { @MainActor [weak self] force in
            guard let self, self.linked, self.subject == expectedSubject, self.receiverID == expectedReceiver,
                  (requireWrite ? self.uploadProjects : self.readableProjects).flatMap({ $0.buckets }).contains(where: { $0.id == workspace }) else {
                throw GDTransferError(message: "The helper's account or MachineNote authorization changed.", status: 401)
            }
            // Reuse a token already renewed by another native request. Concurrent
            // refreshes otherwise share accessToken's existing single-flight task.
            let renewed = try await self.accessToken(forceRefresh: force && self.tokens?.access == lease.token)
            guard self.linked, self.subject == expectedSubject, self.receiverID == expectedReceiver else {
                throw GDTransferError(message: "The Red-XAI account changed during renewal.", status: 401)
            }
            lease.token = renewed
            return renewed
        })
    }

    func serviceRequest(path: String, method: String = "GET", json: [String: Any]? = nil) async throws -> [String: Any] {
        guard linked, !subject.isEmpty, path.hasPrefix("/"),
              let relative = URLComponents(string: path), relative.scheme == nil, relative.host == nil,
              relative.fragment == nil, !relative.path.contains("%"), !relative.path.contains("\\"),
              !relative.path.contains(".."), !path.unicodeScalars.contains(where: { $0.value < 32 }),
              ["/v1/receivers/", "/v1/integrations/", "/provider/v1/"].contains(where: { relative.path.hasPrefix($0) })
                || relative.path == "/v1/integrations",
              ["GET", "POST", "PUT", "PATCH", "DELETE"].contains(method) else {
            throw GDTransferError(message: "Invalid Red-XAI service endpoint.", status: 400)
        }
        let expectedSubject = subject, expectedReceiver = receiverID
        var components = URLComponents(url: cloudAPI, resolvingAgainstBaseURL: false)!
        components.path = relative.path; components.queryItems = relative.queryItems
        guard let url = components.url, url.scheme == "https", url.host == cloudAPI.host, url.port == nil else {
            throw GDTransferError(message: "Unsafe Red-XAI service endpoint.", status: 400)
        }
        let transport = URLSession(configuration: .ephemeral, delegate: GDMachineNotesRedirectDelegate(), delegateQueue: nil)
        defer { transport.invalidateAndCancel() }
        for attempt in 0...1 {
            guard linked, subject == expectedSubject, receiverID == expectedReceiver else {
                throw GDTransferError(message: "The Red-XAI account changed.", status: 401)
            }
            let token = try await accessToken(forceRefresh: attempt == 1)
            var request = URLRequest(url: url); request.httpMethod = method; request.timeoutInterval = 30
            request.cachePolicy = .reloadIgnoringLocalCacheData
            request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
            request.setValue("application/json", forHTTPHeaderField: "Accept")
            request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
            if let json {
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                request.httpBody = try JSONSerialization.data(withJSONObject: json)
                guard (request.httpBody?.count ?? 0) <= 1024 * 1024 else {
                    throw GDTransferError(message: "Red-XAI service request is too large.", status: 400)
                }
            }
            let (data, response) = try await transport.data(for: request)
            guard linked, subject == expectedSubject, receiverID == expectedReceiver else {
                throw GDTransferError(message: "The Red-XAI account changed.", status: 401)
            }
            guard let http = response as? HTTPURLResponse, http.url == url, data.count <= 4 * 1024 * 1024 else {
                throw GDTransferError(message: "Invalid Red-XAI service response.", status: 0)
            }
            if http.statusCode == 401 && attempt == 0 { continue }
            guard (200..<300).contains(http.statusCode) else {
                throw GDTransferError(message: "Red-XAI service request failed (HTTP \(http.statusCode)).", status: http.statusCode)
            }
            if data.isEmpty { return [:] }
            return try jsonObject(data)
        }
        throw GDTransferError(message: "Reconnect the Red-XAI app session.", status: 401)
    }

    func machineNotesInventory(allAccounts: Bool = false, cursor: String? = nil) async throws -> GDMachineNotesInventoryPage {
        guard linked, !subject.isEmpty, receiverID.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
            throw GDTransferError(message: "Connect Red-XAI to view MachineNotes.", status: 401)
        }
        if let cursor {
            guard allAccounts, cursor.range(of: "^[0-9]{1,16}$", options: .regularExpression) != nil,
                  let value = UInt64(cursor), value <= 0x000F_FFFF_FFFF_FFFF else {
                throw GDTransferError(message: "MachineNotes page cursor is invalid.", status: 400)
            }
        }
        let expectedSubject = subject, expectedReceiver = receiverID
        let transport = URLSession(configuration: .ephemeral, delegate: GDMachineNotesRedirectDelegate(), delegateQueue: nil)
        defer { transport.invalidateAndCancel() }

        func page(all: Bool, cursor: String?) async throws -> GDMachineNotesInventoryPage {
            let path = all ? "v1/receivers/admin/machine-notes" : "v1/receivers/me/machine-notes"
            let endpoint = cloudAPI.appendingPathComponent(path)
            guard var parts = URLComponents(url: endpoint, resolvingAgainstBaseURL: false),
                  parts.scheme == "https", parts.host == "api.red-xai.com", parts.port == nil,
                  parts.user == nil, parts.password == nil, parts.fragment == nil,
                  parts.path == "/" + path else {
                throw GDTransferError(message: "MachineNotes service configuration is invalid.", status: 0)
            }
            if all {
                parts.queryItems = [URLQueryItem(name: "limit", value: "20")]
                if let cursor { parts.queryItems?.append(URLQueryItem(name: "cursor", value: cursor)) }
            }
            guard let url = parts.url else { throw GDTransferError(message: "MachineNotes endpoint is invalid.", status: 0) }
            for attempt in 0...1 {
                let token = try await accessToken(forceRefresh: attempt == 1)
                var request = URLRequest(url: url)
                request.httpMethod = "GET"
                request.timeoutInterval = 60
                request.cachePolicy = .reloadIgnoringLocalCacheData
                request.setValue("application/json", forHTTPHeaderField: "Accept")
                request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
                request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
                let (data, response) = try await transport.data(for: request)
                guard linked, subject == expectedSubject, receiverID == expectedReceiver else {
                    throw GDTransferError(message: "The Red-XAI account changed. Refresh MachineNotes.", status: 401)
                }
                guard let http = response as? HTTPURLResponse, http.url == url else {
                    throw GDTransferError(message: "MachineNotes returned an unexpected response.", status: 0)
                }
                if http.statusCode == 401 && attempt == 0 { continue }
                guard http.statusCode == 200 else {
                    let message = http.statusCode == 403 ? "Owner access to the account inventory is unavailable." : "MachineNotes could not be loaded."
                    throw GDTransferError(message: message, status: http.statusCode)
                }
                guard data.count <= 8 * 1024 * 1024 else {
                    throw GDTransferError(message: "MachineNotes returned too much inventory data.", status: 0)
                }
                let result = try JSONDecoder().decode(GDMachineNotesInventoryPage.self, from: data)
                try result.validate(allAccounts: all, receiverID: expectedReceiver)
                return result
            }
            throw GDTransferError(message: "Red-XAI approval expired. Connect again to view MachineNotes.", status: 401)
        }

        let own = try await page(all: false, cursor: nil)
        guard allAccounts else { return own }
        guard own.ownerAdmin else { throw GDTransferError(message: "Owner access is required to view all accounts.", status: 403) }
        return try await page(all: true, cursor: cursor)
    }
}
