import CryptoKit
import Foundation

struct GDManifestFile: Equatable {
    var name: String
    var chunkCount: Int
    var totalSize: Int
    var chunks: [String]
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

    static func authenticating(index: UInt32, isFinal: Bool) -> Data {
        var data = Data("GDCK".utf8)
        var big = index.bigEndian
        withUnsafeBytes(of: &big) { data.append(contentsOf: $0) }
        data.append(isFinal ? 1 : 0)
        return data
    }

    static func sealChunk(plaintext: Data, key: SymmetricKey, index: UInt32, isFinal: Bool) throws -> Data {
        let sealed = try AES.GCM.seal(plaintext, using: key, authenticating: authenticating(index: index, isFinal: isFinal))
        guard let combined = sealed.combined else {
            throw GDStorageContractError.message("The file could not be sealed on this Mac.")
        }
        return combined
    }

    static func openChunk(sealed: Data, key: SymmetricKey, index: UInt32, isFinal: Bool) throws -> Data {
        let box = try AES.GCM.SealedBox(combined: sealed)
        return try AES.GCM.open(box, using: key, authenticating: authenticating(index: index, isFinal: isFinal))
    }

    /// Opens every chunk in order. Only the last chunk may carry the final flag.
    static func openFile(chunks: [Data], key: SymmetricKey, chunkCount: Int, totalSize: Int) throws -> Data {
        guard chunkCount > 0, chunks.count == chunkCount else {
            throw GDStorageContractError.message("The sealed file is missing a chunk.")
        }
        var plain = Data()
        for (offset, chunk) in chunks.enumerated() {
            let isFinal = offset == chunkCount - 1
            plain.append(try openChunk(sealed: chunk, key: key, index: UInt32(offset), isFinal: isFinal))
        }
        guard plain.count == totalSize else {
            throw GDStorageContractError.message("The sealed file size does not match its file list.")
        }
        return plain
    }

    static func uploadBody(generation: String) -> [String: Any] {
        ["op": "upload", "objects": [objectID], "ifGeneration": generation]
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
        var byName: [String: GDManifestFile] = [:]
        for file in remote.files { byName[file.name] = try checked(file) }
        for file in local.files { byName[file.name] = try checked(file) }
        let files = byName.keys.sorted().compactMap { byName[$0] }
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
            return ["name": checked.name, "chunkCount": checked.chunkCount, "totalSize": checked.totalSize, "chunks": checked.chunks]
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
            guard let name = row["name"] as? String, !name.isEmpty,
                  let chunkCount = Self.integer(row["chunkCount"]),
                  let totalSize = Self.integer(row["totalSize"]),
                  let chunks = row["chunks"] as? [String] else {
                throw GDStorageContractError.message("The sealed file list could not be read.")
            }
            return try checked(GDManifestFile(name: name, chunkCount: chunkCount, totalSize: totalSize, chunks: chunks))
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
        return file
    }
}
