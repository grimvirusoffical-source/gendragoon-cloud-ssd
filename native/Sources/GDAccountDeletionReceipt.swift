import Foundation
import CryptoKit
import Darwin

struct GDAccountDeletionFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

struct GDAccountDeletionPending: Codable, Equatable {
    let schema: Int
    let issuer: String
    let subject: String
    let receiverID: String
    let idempotencyKey: String
    var receiptID: String?

    init(subject: String, receiverID: String, idempotencyKey: String, receiptID: String? = nil) throws {
        schema = 1; issuer = "https://red-xai.com"; self.subject = subject; self.receiverID = receiverID
        self.idempotencyKey = idempotencyKey; self.receiptID = receiptID
        try validate()
    }
    func validate() throws {
        let input = try JSONSerialization.data(withJSONObject: ["red-xai-receiver/v1", issuer, subject], options: [.withoutEscapingSlashes])
        let expected = SHA256.hash(data: input).map { String(format: "%02x", $0) }.joined()
        guard schema == 1, issuer == "https://red-xai.com", !subject.isEmpty, subject.utf8.count <= 1024,
              receiverID == expected, idempotencyKey.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
              receiptID == nil || receiptID!.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil else {
            throw GDAccountDeletionFailure(message: "The saved deletion request could not be validated. Existing data was retained.")
        }
    }
    func matches(subject: String, receiver: String) -> Bool { self.subject == subject && receiverID == receiver }
    func binding(_ id: String) throws -> Self {
        guard receiptID == nil || receiptID == id else { throw GDAccountDeletionFailure(message: "The deletion receipt changed. Local keys were retained.") }
        var copy = self; copy.receiptID = id; try copy.validate(); return copy
    }
}

struct GDAccountDeletionResponse: Decodable {
    struct Receipt: Decodable {
        let id: String
        let status: String
        let phase: String
        let requestedAt: String
        let updatedAt: String
        let completedAt: String?
        let retryable: Bool
        let error: String?
        let cloudDataDeleted: Bool
        let externalIdentityDeleted: Bool
        let externalBYODataDeleted: Bool
        let localOriginalsDeleted: Bool
        var completed: Bool { status == "completed" && cloudDataDeleted }
        func validate(pending: GDAccountDeletionPending) throws {
            let formatter = ISO8601DateFormatter(); formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            func date(_ raw: String) -> Date? {
                if let result = formatter.date(from: raw) { return result }
                let fallback = ISO8601DateFormatter(); return fallback.date(from: raw)
            }
            guard id.range(of: "^[a-f0-9]{32}$", options: .regularExpression) != nil,
                  pending.receiptID == nil || pending.receiptID == id,
                  ["queued", "running", "failed", "completed"].contains(status),
                  ["billing", "workspaces", "metadata", "storage", "complete"].contains(phase),
                  retryable == (status == "failed"), cloudDataDeleted == (status == "completed"),
                  (phase == "complete") == (status == "completed"),
                  !externalIdentityDeleted, !externalBYODataDeleted, !localOriginalsDeleted,
                  let start = date(requestedAt), let updated = date(updatedAt), updated >= start else {
                throw GDAccountDeletionFailure(message: "The server did not return a matching valid deletion receipt. Local keys were retained.")
            }
            if completed {
                guard let raw = completedAt, let end = date(raw), end >= start, end <= updated else {
                    throw GDAccountDeletionFailure(message: "The deletion completion time could not be verified. Local keys were retained.")
                }
            }
            if status == "failed", !["account_deletion_retry_required", "billing_review_required"].contains(error ?? "") {
                throw GDAccountDeletionFailure(message: "The deletion failure receipt needs review. Local keys were retained.")
            }
        }
        func authorizesCleanup(pending: GDAccountDeletionPending, subject: String, receiver: String) -> Bool {
            completed && pending.receiptID == id && pending.matches(subject: subject, receiver: receiver)
        }
    }
    let schema: Int
    let deletion: Receipt?
    static func decode(_ data: Data, pending: GDAccountDeletionPending) throws -> Self {
        guard data.count <= 16_384 else { throw GDAccountDeletionFailure(message: "The deletion receipt exceeded its safety limit.") }
        let value = try JSONDecoder().decode(Self.self, from: data)
        guard value.schema == 1 else { throw GDAccountDeletionFailure(message: "Unsupported deletion receipt.") }
        try value.deletion?.validate(pending: pending)
        return value
    }
}

/// Same nonblocking update.lock used by GenDragoon helpers; no perpetual lease.
final class GDAccountDeletionLocalLease {
    private var descriptor: Int32 = -1
    init(home: URL = FileManager.default.homeDirectoryForCurrentUser) throws {
        let fm = FileManager.default, home = home.standardizedFileURL
        var homeInfo = stat()
        guard home.resolvingSymlinksInPath() == home, lstat(home.path, &homeInfo) == 0,
              homeInfo.st_mode & S_IFMT == S_IFDIR, homeInfo.st_uid == getuid(), homeInfo.st_mode & 0o022 == 0 else { throw GDAccountDeletionFailure(message: "Linked or shared private maintenance directory rejected.") }
        var directory = home
        for component in ["Library", "Application Support", "GenDragoon Cloud SSD", "AutoUpdates"] {
            directory.appendPathComponent(component, isDirectory: true)
            if !fm.fileExists(atPath: directory.path) { try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700]) }
            var info = stat()
            guard lstat(directory.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(), info.st_mode & 0o022 == 0 else {
                throw GDAccountDeletionFailure(message: "The private maintenance path is linked, shared, or not owned by this user.")
            }
        }
        let path = directory.appendingPathComponent("update.lock").path
        let fd = Darwin.open(path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw GDAccountDeletionFailure(message: "Could not reserve private account maintenance.") }
        var info = stat()
        guard fstat(fd, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1,
              info.st_mode & 0o077 == 0, flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            Darwin.close(fd)
            throw GDAccountDeletionFailure(message: "Another GenDragoon helper is active, or its maintenance lock needs review. Nothing was deleted.")
        }
        descriptor = fd
    }
    deinit { if descriptor >= 0 { _ = flock(descriptor, LOCK_UN); Darwin.close(descriptor) } }
}

/// Exact files only. Preflight all candidates before unlinking the first one.
enum GDAccountDeletionOwnedFiles {
    struct FileIdentity { let url: URL; let device: dev_t; let inode: ino_t }
    static func inspect(_ url: URL) throws -> FileIdentity? {
        let parent = url.deletingLastPathComponent().standardizedFileURL
        guard parent.resolvingSymlinksInPath() == parent else {
            throw GDAccountDeletionFailure(message: "Linked account cleanup path rejected. Existing files were retained.")
        }
        var parentInfo = stat()
        if lstat(parent.path, &parentInfo) != 0 {
            if errno == ENOENT { return nil }
            throw GDAccountDeletionFailure(message: "The private account directory could not be inspected.")
        }
        guard parentInfo.st_mode & S_IFMT == S_IFDIR, parentInfo.st_uid == getuid(), parentInfo.st_mode & 0o022 == 0 else {
            throw GDAccountDeletionFailure(message: "Shared account cleanup directory rejected. Existing files were retained.")
        }
        var info = stat()
        if lstat(url.path, &info) != 0 {
            if errno == ENOENT { return nil }
            throw GDAccountDeletionFailure(message: "The account file could not be inspected.")
        }
        guard info.st_mode & S_IFMT == S_IFREG, info.st_uid == getuid(), info.st_nlink == 1, info.st_mode & 0o077 == 0 else {
            throw GDAccountDeletionFailure(message: "An account file is linked or shared. It was retained for review.")
        }
        return FileIdentity(url: url, device: info.st_dev, inode: info.st_ino)
    }
    static func remove(_ identities: [FileIdentity]) throws {
        for item in identities {
            guard let current = try inspect(item.url), current.device == item.device, current.inode == item.inode else {
                throw GDAccountDeletionFailure(message: "An account file changed during cleanup. It was retained for review.")
            }
            guard unlink(item.url.path) == 0 else { throw GDAccountDeletionFailure(message: "Verified cloud deletion completed, but this account's local file cleanup needs attention.") }
        }
    }
}

/// Fresh read-only snapshots are taken while update.lock prevents helper starts.
enum GDAccountDeletionActivityProbe {
    private struct Apps: Decodable {
        struct Session: Decodable { let active: Bool }
        let active: Bool; let busy: Bool; let sessions: [Session]
    }
    private struct Mounts: Decodable {
        struct Mount: Decodable { let state: String }
        let unknownMounts: Bool; let mounts: [Mount]
    }
    private struct Upload: Decodable {
        struct State: Decodable {
            struct Job: Decodable { let state: String }
            let schema: Int; let activeJobID: String?; let jobs: [Job]
            enum CodingKeys: String, CodingKey { case schema, jobs; case activeJobID = "active_job_id" }
            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                guard container.contains(.activeJobID) else { throw GDAccountDeletionFailure(message: "Upload worker status is unknown.") }
                schema = try container.decode(Int.self, forKey: .schema)
                activeJobID = try container.decodeIfPresent(String.self, forKey: .activeJobID)
                jobs = try container.decode([Job].self, forKey: .jobs)
            }
        }
        let state: State
    }
    static func validate(apps: Data, mounts: Data, uploads: Data) throws {
        guard [apps, mounts, uploads].allSatisfy({ $0.count <= 4 * 1024 * 1024 }) else {
            throw GDAccountDeletionFailure(message: "Local activity inspection exceeded its safety limit.")
        }
        let decoder = JSONDecoder(), a = try decoder.decode(Apps.self, from: apps)
        let m = try decoder.decode(Mounts.self, from: mounts), u = try decoder.decode(Upload.self, from: uploads)
        guard !a.active, !a.busy, a.sessions.count <= 2000, a.sessions.allSatisfy({ !$0.active }),
              !m.unknownMounts, m.mounts.count <= 200, m.mounts.allSatisfy({ $0.state == "unmounted" }),
              u.state.schema == 1, u.state.activeJobID == nil, u.state.jobs.count <= 200,
              u.state.jobs.allSatisfy({ ["queued", "succeeded", "failed"].contains($0.state) }) else {
            throw GDAccountDeletionFailure(message: "A transfer, managed application or mounted/unknown drive is still active. Close or finish it normally and refresh status; nothing was stopped.")
        }
    }
}
