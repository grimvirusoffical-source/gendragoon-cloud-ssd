import Foundation
import CryptoKit
import ZIPFoundation

/// User-selected folders are portable ZIP files, including empty files/directories.
/// Application packages remain stored files on iOS; this code never executes them.
enum MobileArchive {
    struct Record: Equatable, Sendable {
        let directory: Bool
        let size: Int64
        let digest: String
    }
    struct Prepared: Sendable {
        let original: URL
        let uploadURL: URL
        let snapshot: [String: Record]
        let temporaryDirectory: URL?
        let archive: Bool
    }
    static let maximumEntries = 100_000
    static func isApplication(_ name: String) -> Bool {
        let lower = name.lowercased()
        return [".app", ".app.zip", ".dmg", ".pkg", ".exe", ".msi", ".msix", ".appimage", ".deb", ".rpm", ".apk", ".aab", ".ipa", ".gdapp.zip"].contains { lower.hasSuffix($0) }
    }
    static func digest(_ url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hash = SHA256()
        while let bytes = try handle.read(upToCount: 1024 * 1024), !bytes.isEmpty {
            try Task.checkCancellation()
            hash.update(data: bytes)
        }
        return hash.finalize().map { String(format: "%02x", $0) }.joined()
    }
    static func safeName(_ path: String) throws {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false)
        guard !path.isEmpty, !path.hasPrefix("/"), !path.contains("\\"), !path.contains(":"), !path.contains("\0"),
              !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else {
            throw GDTransferError(message: "This folder contains an unsafe or unsupported file name.", status: 0)
        }
    }
    static func snapshot(_ original: URL) throws -> [String: Record] {
        var result: [String: Record] = [:]
        var folded = Set<String>()
        let base = original.deletingLastPathComponent().standardizedFileURL.path + "/"
        func add(_ url: URL) throws {
            try Task.checkCancellation()
            let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
            let type = attributes[.type] as? FileAttributeType
            guard type == .typeRegular || type == .typeDirectory else {
                throw GDTransferError(message: "Archive this symbolic link or special file on its original computer before uploading it.", status: 0)
            }
            guard url.standardizedFileURL.path.hasPrefix(base) else { throw GDTransferError(message: "Folder path escaped the selection.", status: 0) }
            let path = String(url.standardizedFileURL.path.dropFirst(base.count))
            try safeName(path)
            guard folded.insert(path.precomposedStringWithCanonicalMapping.lowercased()).inserted,
                  result.count < maximumEntries else { throw GDTransferError(message: "Folder has duplicate portable names or too many entries.", status: 0) }
            result[path] = Record(directory: type == .typeDirectory,
                                  size: type == .typeDirectory ? 0 : (attributes[.size] as? NSNumber)?.int64Value ?? 0,
                                  digest: type == .typeDirectory ? "" : try digest(url))
        }
        try add(original)
        if result[original.lastPathComponent]?.directory == true {
            var enumerationError: Error?
            guard let iterator = FileManager.default.enumerator(at: original, includingPropertiesForKeys: nil,
                options: [], errorHandler: { _, error in enumerationError = error; return false }) else {
                throw GDTransferError(message: "The selected folder is not readable.", status: 0)
            }
            for case let child as URL in iterator { try add(child) }
            if let error = enumerationError { throw error }
        }
        return result
    }
    static func prepare(_ original: URL, maximumBytes: Int64) throws -> Prepared {
        let state = try snapshot(original)
        let mustArchive = state[original.lastPathComponent]?.directory == true || state[original.lastPathComponent]?.size == 0
        guard mustArchive else { return Prepared(original: original, uploadURL: original, snapshot: state, temporaryDirectory: nil, archive: false) }
        let total = state.values.reduce(Int64(0)) { $0 + $1.size }
        let reserve = Int64(state.count) * 512 + 16 * 1024 * 1024
        guard total <= maximumBytes - min(maximumBytes, reserve) else {
            throw GDTransferError(message: "The complete folder exceeds this workspace's file limit. Choose a smaller folder.", status: 0)
        }
        let temporary = FileManager.default.temporaryDirectory.appendingPathComponent("gd-folder-" + UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: temporary, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700, .protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        do {
            let volume = try FileManager.default.attributesOfFileSystem(forPath: temporary.path)
            guard ((volume[.systemFreeSize] as? NSNumber)?.int64Value ?? 0) > total + reserve + 512 * 1024 * 1024 else {
                throw GDTransferError(message: "Free more local space to prepare this complete folder.", status: 0)
            }
            let destination = temporary.appendingPathComponent(original.lastPathComponent + ".zip")
            let archive = try Archive(url: destination, accessMode: .create)
            for path in state.keys.sorted() {
                try Task.checkCancellation()
                try archive.addEntry(with: path, relativeTo: original.deletingLastPathComponent(), compressionMethod: .none)
            }
            let prepared = Prepared(original: original, uploadURL: destination, snapshot: state, temporaryDirectory: temporary, archive: true)
            try verifyArchive(destination, against: state)
            guard try snapshot(original) == state else { throw GDTransferError(message: "The folder changed while preparing it. Original retained.", status: 0) }
            return prepared
        } catch { try? FileManager.default.removeItem(at: temporary); throw error }
    }
    static func verifyArchive(_ url: URL, against expected: [String: Record]) throws {
        let archive = try Archive(url: url, accessMode: .read)
        var seen = Set<String>()
        for entry in archive {
            try Task.checkCancellation()
            let path = entry.path.hasSuffix("/") ? String(entry.path.dropLast()) : entry.path
            try safeName(path)
            guard seen.insert(path).inserted, let record = expected[path],
                  entry.type == (record.directory ? .directory : .file),
                  entry.uncompressedSize == UInt64(record.size) else {
                throw GDTransferError(message: "Folder restore verification failed. Original retained.", status: 0)
            }
            var hasher = SHA256()
            let checksum = try archive.extract(entry, bufferSize: 64 * 1024) { bytes in
                try Task.checkCancellation()
                hasher.update(data: bytes)
            }
            guard checksum == entry.checksum else { throw GDTransferError(message: "Archive integrity check failed.", status: 0) }
            if !record.directory {
                let value = hasher.finalize().map { String(format: "%02x", $0) }.joined()
                guard value == record.digest else { throw GDTransferError(message: "Restored folder content differs from the original.", status: 0) }
            }
        }
        guard seen == Set(expected.keys) else { throw GDTransferError(message: "Restored archive is incomplete.", status: 0) }
    }
    static func verifyReadback(_ restored: URL, prepared: Prepared) throws {
        guard try digest(restored) == digest(prepared.uploadURL) else { throw GDTransferError(message: "Cloud read-back differs. Original retained.", status: 0) }
        if prepared.archive { try verifyArchive(restored, against: prepared.snapshot) }
        guard try snapshot(prepared.original) == prepared.snapshot else { throw GDTransferError(message: "Original changed after upload. It has been retained.", status: 0) }
    }
    static func removeOriginal(_ prepared: Prepared) throws {
        // Only the exact picker selection is eligible; there is no automatic disk cleanup.
        guard try snapshot(prepared.original) == prepared.snapshot,
              prepared.original.pathComponents.count > 3 else { throw GDTransferError(message: "Original changed or is protected. It has been retained.", status: 0) }
        var coordinationError: NSError?
        var deletionError: Error?
        NSFileCoordinator().coordinate(writingItemAt: prepared.original, options: .forDeleting, error: &coordinationError) { url in
            do {
                guard try snapshot(url) == prepared.snapshot else { throw GDTransferError(message: "Original changed. It has been retained.", status: 0) }
                try FileManager.default.removeItem(at: url)
            } catch { deletionError = error }
        }
        if let error = coordinationError { throw error }
        if let error = deletionError { throw error }
    }
}
