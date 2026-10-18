import CryptoKit
import Foundation

struct GDManifestFile: Equatable {
    var id: String
    var name: String
    var chunkCount: Int
    var totalSize: Int
    var chunks: [String]
    /// Old object ids stay listed until their delete returns 2xx.
    var previousChunks: [String] = []
    /// Manifest version the chunks were sealed under. A later 412 bump does not change it.
    var sealedVersion: Int = 0

    init(id: String, name: String, chunkCount: Int, totalSize: Int, chunks: [String], previousChunks: [String] = [], sealedVersion: Int = 0) {
        self.id = id
        self.name = name
        self.chunkCount = chunkCount
        self.totalSize = totalSize
        self.chunks = chunks
        self.previousChunks = previousChunks
        self.sealedVersion = sealedVersion
    }
}

struct GDSealedManifestDocument: Equatable {
    var version: Int
    var files: [GDManifestFile]
}

enum GDManifestGeneration: Equatable {
    /// The object is not there yet. The upload uses generation `0`.
    case absentObject
    /// A 200 download did not include a generation. Uploading would be a client bug.
    case missing
    case value(String)
}

enum GDManifestUploadResult: Equatable {
    case committed
    case retryMerge
    case clientBug
    case failed
}

/// The file-name list is one sealed object named `manifest`. Each ciphertext
/// chunk is its own object. There is no resumable upload session.
enum GDSealedManifest {
    static let objectID = "manifest"
    static let usesResumableUploads = false

    static func versionKey(workspace: String) -> String { "gd.manifest.version." + workspace }

    static func authenticating(fileID: String, objectID: String, index: UInt32, manifestVersion: UInt32, isFinal: Bool) -> Data {
        var data = Data("GDCK".utf8)
        func append(_ text: String) {
            let bytes = Data(text.utf8)
            var length = UInt16(bytes.count).bigEndian
            withUnsafeBytes(of: &length) { data.append(contentsOf: $0) }
            data.append(bytes)
        }
        append(fileID)
        append(objectID)
        var big = index.bigEndian
        withUnsafeBytes(of: &big) { data.append(contentsOf: $0) }
        var version = manifestVersion.bigEndian
        withUnsafeBytes(of: &version) { data.append(contentsOf: $0) }
        data.append(isFinal ? 1 : 0)
        return data
    }

    static func sealChunk(plaintext: Data, key: SymmetricKey, fileID: String, objectID: String, index: UInt32, manifestVersion: UInt32, isFinal: Bool) throws -> Data {
        let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: authenticating(fileID: fileID, objectID: objectID, index: index, manifestVersion: manifestVersion, isFinal: isFinal))
        guard let combined = sealed.combined else {
            throw GDStorageContractError.message("The file could not be sealed on this Mac.")
        }
        return combined
    }

    static func openChunk(sealed: Data, key: SymmetricKey, fileID: String, objectID: String, index: UInt32, manifestVersion: UInt32, isFinal: Bool) throws -> Data {
        let box = try AES.GCM.SealedBox(combined: sealed)
        return try AES.GCM.open(box, using: key, authenticating: authenticating(fileID: fileID, objectID: objectID, index: index, manifestVersion: manifestVersion, isFinal: isFinal))
    }

    /// Opens every chunk in order. Only the last chunk may carry the final flag.
    static func openFile(fileID: String, chunks: [(objectID: String, sealed: Data)], key: SymmetricKey, manifestVersion: UInt32, totalSize: Int) throws -> Data {
        guard !chunks.isEmpty else {
            throw GDStorageContractError.message("The sealed file is missing a chunk.")
        }
        var plain = Data()
        for (offset, chunk) in chunks.enumerated() {
            let isFinal = offset == chunks.count - 1
            plain.append(try openChunk(sealed: chunk.sealed, key: key, fileID: fileID, objectID: chunk.objectID, index: UInt32(offset), manifestVersion: manifestVersion, isFinal: isFinal))
        }
        guard plain.count == totalSize else {
            throw GDStorageContractError.message("The sealed file size does not match its file list.")
        }
        return plain
    }

    static func uploadBody(generation: String) -> [String: Any] {
        GDStorageContract.putBody(objectIDs: [objectID], ifGeneration: generation)
    }

    static func generation(objectStatus: Int, headers: [String: String]) -> GDManifestGeneration {
        if objectStatus == 404 { return .absentObject }
        guard (200...299).contains(objectStatus) else { return .missing }
        let header = headers["x-goog-generation"]?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let header, !header.isEmpty { return .value(header) }
        return .missing
    }

    static func generationValue(_ generation: GDManifestGeneration) -> String? {
        switch generation {
        case .absentObject: return "0"
        case .value(let text): return text
        case .missing: return nil
        }
    }

    static func interpretUpload(status: Int, json: [String: Any]) -> GDManifestUploadResult {
        if status == 412 { return .retryMerge }
        if status == 400, GDServerCode.read(json) == "manifest_generation_required" { return .clientBug }
        if (200...299).contains(status) { return .committed }
        return .failed
    }

    static func checkVersion(remote: Int, lastSeen: Int) throws {
        guard remote >= lastSeen else {
            throw GDStorageContractError.message("The stored file list is older than the last version saved on this Mac.")
        }
    }

    static func merge(local: GDSealedManifestDocument, remote: GDSealedManifestDocument, lastSeen: Int) throws -> GDSealedManifestDocument {
        try checkVersion(remote: remote.version, lastSeen: lastSeen)
        guard local.version >= lastSeen else {
            throw GDStorageContractError.message("The stored file list is older than the last version saved on this Mac.")
        }
        var byID: [String: GDManifestFile] = [:]
        for file in remote.files { byID[file.id] = try checked(file) }
        for file in local.files {
            var next = try checked(file)
            if let existing = byID[file.id], existing.chunks != next.chunks, next.previousChunks.isEmpty {
                next.previousChunks = existing.chunks
            }
            byID[file.id] = next
        }
        let files = byID.keys.sorted().compactMap { byID[$0] }
        return GDSealedManifestDocument(version: max(local.version, remote.version) + 1, files: files)
    }

    static func seal(document: GDSealedManifestDocument, key: SymmetricKey) throws -> Data {
        let sealed = try AES.GCM.seal(try plaintext(document), using: key)
        guard let combined = sealed.combined else {
            throw GDStorageContractError.message("The file list could not be sealed on this Mac.")
        }
        return combined
    }

    static func open(sealed: Data, key: SymmetricKey) throws -> GDSealedManifestDocument {
        let box = try AES.GCM.SealedBox(combined: sealed)
        return try document(from: try AES.GCM.open(box, using: key))
    }

    static func plaintext(_ document: GDSealedManifestDocument) throws -> Data {
        let files: [[String: Any]] = try document.files.map { file in
            let checked = try checked(file)
            return ["id": checked.id, "name": checked.name, "chunkCount": checked.chunkCount, "totalSize": checked.totalSize,
                    "chunks": checked.chunks, "previousChunks": checked.previousChunks, "sealedVersion": checked.sealedVersion]
        }
        return try JSONSerialization.data(withJSONObject: ["version": document.version, "files": files], options: [.sortedKeys])
    }

    static func document(from data: Data) throws -> GDSealedManifestDocument {
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = Self.integer(json["version"]),
              let rows = json["files"] as? [[String: Any]] else {
            throw GDStorageContractError.message("The sealed file list could not be read.")
        }
        let files: [GDManifestFile] = try rows.map { row in
            guard let id = row["id"] as? String, !id.isEmpty,
                  let name = row["name"] as? String, !name.isEmpty,
                  let chunkCount = Self.integer(row["chunkCount"]),
                  let totalSize = Self.integer(row["totalSize"]),
                  let chunks = row["chunks"] as? [String] else {
                throw GDStorageContractError.message("The sealed file list could not be read.")
            }
            let previous = row["previousChunks"] as? [String] ?? []
            let sealedVersion = Self.integer(row["sealedVersion"]) ?? 0
            return try checked(GDManifestFile(id: id, name: name, chunkCount: chunkCount, totalSize: totalSize, chunks: chunks, previousChunks: previous, sealedVersion: sealedVersion))
        }
        return GDSealedManifestDocument(version: version, files: files)
    }

    private static func integer(_ value: Any?) -> Int? {
        if let number = value as? Int { return number }
        if let number = value as? NSNumber { return number.intValue }
        return nil
    }

    private static func checked(_ file: GDManifestFile) throws -> GDManifestFile {
        guard file.chunkCount > 0, file.chunks.count == file.chunkCount, file.totalSize >= 0 else {
            throw GDStorageContractError.message("The sealed file is missing a chunk.")
        }
        guard file.chunks.allSatisfy({ $0 == objectID || GDStorageContract.isOpaqueID($0) }) else {
            throw GDStorageContractError.message("The sealed file list names an object this Mac cannot store.")
        }
        guard file.previousChunks.allSatisfy({ $0 == objectID || GDStorageContract.isOpaqueID($0) }) else {
            throw GDStorageContractError.message("The sealed file list names an object this Mac cannot store.")
        }
        return file
    }
}
