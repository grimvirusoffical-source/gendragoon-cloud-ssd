import CryptoKit
import Foundation

protocol GDHostedReplaceTransport {
    func signedURLs(body: [String: Any]) async throws -> (status: Int, json: [String: Any])
    func transfer(url: URL, method: String, body: Data?, generationMatch: String?) async throws -> (status: Int, data: Data, headers: [String: String])
}

enum GDHostedReplaceError: Error, Equatable {
    case message(String)
}

/// Replaces one sealed file without dropping the previous copy until the new manifest is stored
/// and the old objects have been deleted.
enum GDHostedFileReplace {
    static func uploadAndCommit(workspace: String, file: GDManifestFile, chunkBodies: [String: Data], key: SymmetricKey, now: Date, transport: GDHostedReplaceTransport) async throws -> GDSealedManifestDocument {
        let urls = try await transport.signedURLs(body: GDStorageContract.putBody(objectIDs: file.chunks))
        guard (200...299).contains(urls.status) else {
            throw GDHostedReplaceError.message("A new chunk could not be uploaded. The stored file was left in place.")
        }
        let session = try GDStorageContract.parseSession(workspace: workspace, json: urls.json, now: now)
        for identifier in file.chunks {
            guard let signed = session.urls.first(where: { $0.object == identifier }),
                  let bytes = chunkBodies[identifier] else {
                throw GDHostedReplaceError.message("A new chunk could not be uploaded. The stored file was left in place.")
            }
            let put = try await transport.transfer(url: signed.url, method: signed.method, body: bytes, generationMatch: nil)
            guard (200...299).contains(put.status) else {
                throw GDHostedReplaceError.message("A new chunk could not be uploaded. The stored file was left in place.")
            }
        }
        for _ in 0..<4 {
            let listed = try await transport.signedURLs(body: GDStorageContract.getBody(objectIDs: [GDSealedManifest.objectID]))
            guard (200...299).contains(listed.status) else {
                throw GDHostedReplaceError.message("The manifest could not be read. The stored file was left in place.")
            }
            let download = try GDStorageContract.parseSession(workspace: workspace, json: listed.json, now: now)
            guard let source = download.urls.first(where: { $0.object == GDSealedManifest.objectID }) else {
                throw GDHostedReplaceError.message("The manifest could not be read. The stored file was left in place.")
            }
            let fetched = try await transport.transfer(url: source.url, method: source.method, body: nil, generationMatch: nil)
            let generationValue = try generation(signed: source.generation, status: fetched.status, headers: fetched.headers)
            let remote = try remoteDocument(status: fetched.status, data: fetched.data, generation: generationValue, key: key)
            let local = GDSealedManifestDocument(version: remote.version, files: [file])
            let merged = try GDSealedManifest.merge(local: local, remote: remote, lastSeen: remote.version)
            let sealed = try GDSealedManifest.seal(document: merged, key: key)
            let request = GDSealedManifest.uploadBody(generation: generationValue)
            guard request["ifGeneration"] as? String != nil else {
                throw GDHostedReplaceError.message("The manifest upload was missing its generation.")
            }
            let upload = try await transport.signedURLs(body: request)
            if upload.status == 400, GDServerCode.read(upload.json) == "manifest_generation_required" {
                throw GDHostedReplaceError.message("The manifest upload was missing its generation. This is a client bug, and the file was not replaced.")
            }
            guard (200...299).contains(upload.status) else {
                throw GDHostedReplaceError.message("The manifest could not be saved. The stored file was left in place.")
            }
            let putSession = try GDStorageContract.parseSession(workspace: workspace, json: upload.json, now: now)
            guard let target = putSession.urls.first(where: { $0.object == GDSealedManifest.objectID }) else {
                throw GDHostedReplaceError.message("The manifest could not be saved. The stored file was left in place.")
            }
            let wrote = try await transport.transfer(url: target.url, method: target.method, body: sealed, generationMatch: generationValue)
            switch GDSealedManifest.interpretUpload(status: wrote.status, json: [:]) {
            case .committed:
                return merged
            case .retryMerge:
                continue
            case .clientBug, .failed:
                throw GDHostedReplaceError.message("The manifest could not be saved. The stored file was left in place.")
            }
        }
        throw GDHostedReplaceError.message("The manifest changed while it was being saved. The original file is still on this Mac.")
    }

    /// Deletes the previous objects only after the manifest put has succeeded. Trash runs only after that delete.
    static func deletePreviousAndTrash(workspace: String, document: GDSealedManifestDocument, fileID: String, now: Date, transport: GDHostedReplaceTransport, trash: () throws -> Void) async throws -> GDSealedManifestDocument {
        guard let file = document.files.first(where: { $0.id == fileID }) else {
            throw GDHostedReplaceError.message("The stored file was left in place.")
        }
        guard !file.previousChunks.isEmpty else {
            try trash()
            return document
        }
        let listed = try await transport.signedURLs(body: GDStorageContract.deleteBody(objectIDs: file.previousChunks))
        guard (200...299).contains(listed.status) else {
            throw GDHostedReplaceError.message("The previous copy is still stored. The original on this Mac was kept.")
        }
        let session = try GDStorageContract.parseSession(workspace: workspace, json: listed.json, now: now)
        for identifier in file.previousChunks {
            guard let signed = session.urls.first(where: { $0.object == identifier }) else {
                throw GDHostedReplaceError.message("The previous copy is still stored. The original on this Mac was kept.")
            }
            let deleted = try await transport.transfer(url: signed.url, method: signed.method, body: nil, generationMatch: nil)
            guard (200...299).contains(deleted.status) else {
                throw GDHostedReplaceError.message("The previous copy is still stored. The original on this Mac was kept.")
            }
        }
        var cleared = document
        cleared.files = document.files.map { item in
            guard item.id == fileID else { return item }
            var copy = item
            copy.previousChunks = []
            return copy
        }
        try trash()
        return cleared
    }

    private static func generation(signed: String?, status: Int, headers: [String: String]) throws -> String {
        if let signed { return signed }
        if status == 404 { return "0" }
        if let header = GDStorageContract.decimalGeneration(headers["x-goog-generation"]) { return header }
        throw GDHostedReplaceError.message("The manifest download did not include a generation.")
    }

    private static func remoteDocument(status: Int, data: Data, generation: String, key: SymmetricKey) throws -> GDSealedManifestDocument {
        if status == 404 || (generation == "0" && data.isEmpty) {
            return GDSealedManifestDocument(version: 0, files: [])
        }
        guard (200...299).contains(status) else {
            throw GDHostedReplaceError.message("The manifest could not be read. The stored file was left in place.")
        }
        return try GDSealedManifest.open(sealed: data, key: key)
    }
}
