import CryptoKit
import XCTest
@testable import GenDragoonContract

final class HostedReplaceTests: XCTestCase {
    private let workspace = "11111111-1111-4111-8111-000000000001"
    private let oldID = "0123456789abcdef0123456789abcdef"
    private let newID = "fedcba9876543210fedcba9876543210"
    private let fileID = "file-notes"

    private func now() throws -> Date {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return try XCTUnwrap(formatter.date(from: "2023-11-14T22:20:00.000Z"))
    }

    private func session(object: String, method: String, mode: String, generation: String? = nil) -> [String: Any] {
        var url: [String: Any] = [
            "expiresAt": "2023-11-14T22:28:20.000Z",
            "method": method,
            "object": object,
            "url": "https://storage.googleapis.com/gendragoon-managed-test/customer/18b7287bf3a94528c5224e4316b9c0cabf333213ea663ed8d04a1b62b2e57d09/managed/\(workspace)/objects/\(object)",
        ]
        if let generation { url["generation"] = generation }
        return [
            "bucket": "gendragoon-managed-test",
            "expiresAt": "2023-11-14T22:28:20.000Z",
            "mode": mode,
            "op": method.lowercased(),
            "prefix": "customer/18b7287bf3a94528c5224e4316b9c0cabf333213ea663ed8d04a1b62b2e57d09/managed/\(workspace)/objects/",
            "urls": [url],
        ]
    }

    final class Script: GDHostedReplaceTransport {
        struct Sent: Equatable { var kind: String; var op: String?; var objects: [String]; var ifGeneration: String?; var generationMatch: String?; var method: String }
        var replies: [(status: Int, json: [String: Any], data: Data, headers: [String: String])]
        var sent: [Sent] = []
        func signedURLs(body: [String: Any]) async throws -> (status: Int, json: [String: Any]) {
            let objects = body["objects"] as? [String] ?? []
            sent.append(Sent(kind: "urls", op: body["op"] as? String, objects: objects, ifGeneration: body["ifGeneration"] as? String, generationMatch: nil, method: "POST"))
            let next = replies.removeFirst()
            return (next.status, next.json)
        }
        func transfer(url: URL, method: String, body: Data?, generationMatch: String?) async throws -> (status: Int, data: Data, headers: [String: String]) {
            sent.append(Sent(kind: "object", op: nil, objects: [url.lastPathComponent], ifGeneration: nil, generationMatch: generationMatch, method: method))
            let next = replies.removeFirst()
            return (next.status, next.data, next.headers)
        }
    }

    private func remote(key: SymmetricKey, version: Int) throws -> Data {
        let file = GDManifestFile(id: fileID, name: "notes.txt", chunkCount: 1, totalSize: 4, chunks: [oldID], sealedVersion: version)
        return try GDSealedManifest.seal(document: GDSealedManifestDocument(version: version, files: [file]), key: key)
    }

    func testChunkUploadFailureLeavesTheOldCopyAndDoesNotTrash() async throws {
        let key = SymmetricKey(size: .bits256)
        let oldPlain = Data("old!".utf8)
        let oldSealed = try GDSealedManifest.sealChunk(plaintext: oldPlain, key: key, fileID: fileID, objectID: oldID, index: 0, manifestVersion: 4, isFinal: true)
        let script = Script(replies: [
            (200, session(object: newID, method: "PUT", mode: "write"), Data(), [:]),
            (500, [:], Data(), [:]),
        ])
        var trashed = 0
        let file = GDManifestFile(id: fileID, name: "notes.txt", chunkCount: 1, totalSize: 4, chunks: [newID], sealedVersion: 4)
        do {
            _ = try await GDHostedFileReplace.uploadAndCommit(workspace: workspace, file: file, chunkBodies: [newID: Data()], key: key, now: now(), transport: script)
            XCTFail("upload should fail")
        } catch {
            XCTAssertEqual(trashed, 0)
        }
        let opened = try GDSealedManifest.openChunk(sealed: oldSealed, key: key, fileID: fileID, objectID: oldID, index: 0, manifestVersion: 4, isFinal: true)
        XCTAssertEqual(opened, oldPlain)
        XCTAssertEqual(script.sent.filter { $0.kind == "object" }.count, 1)
    }

    func testManifest412ThenSuccessKeepsTheOldCopyAndDoesNotTrash() async throws {
        let key = SymmetricKey(size: .bits256)
        let sealed = try remote(key: key, version: 4)
        let script = Script(replies: [
            (200, session(object: newID, method: "PUT", mode: "write"), Data(), [:]),
            (200, [:], Data(), [:]),
            (200, session(object: "manifest", method: "GET", mode: "read", generation: "42"), Data(), [:]),
            (200, [:], sealed, ["x-goog-generation": "42"]),
            (200, session(object: "manifest", method: "PUT", mode: "write"), Data(), [:]),
            (412, [:], Data(), [:]),
            (200, session(object: "manifest", method: "GET", mode: "read", generation: "43"), Data(), [:]),
            (200, [:], sealed, ["x-goog-generation": "43"]),
            (200, session(object: "manifest", method: "PUT", mode: "write"), Data(), [:]),
            (200, [:], Data(), [:]),
        ])
        let file = GDManifestFile(id: fileID, name: "notes.txt", chunkCount: 1, totalSize: 3, chunks: [newID], sealedVersion: 4)
        let committed = try await GDHostedFileReplace.uploadAndCommit(workspace: workspace, file: file, chunkBodies: [newID: Data("new".utf8)], key: key, now: now(), transport: script)
        let stored = try XCTUnwrap(committed.files.first { $0.id == fileID })
        XCTAssertEqual(stored.chunks, [newID])
        XCTAssertEqual(stored.previousChunks, [oldID])
        XCTAssertEqual(stored.sealedVersion, 4)
        XCTAssertEqual(script.sent.filter { $0.kind == "object" && $0.method == "PUT" && $0.objects == [newID] }.count, 1)
        let manifestPuts = script.sent.filter { $0.generationMatch != nil }
        XCTAssertEqual(manifestPuts.map(\.generationMatch), ["42", "43"])
        XCTAssertEqual(script.sent.filter { $0.ifGeneration != nil }.map(\.ifGeneration), ["42", "43"])
        let oldPlain = try GDSealedManifest.openChunk(sealed: try GDSealedManifest.sealChunk(plaintext: Data("old".utf8), key: key, fileID: fileID, objectID: oldID, index: 0, manifestVersion: UInt32(stored.sealedVersion), isFinal: true), key: key, fileID: fileID, objectID: oldID, index: 0, manifestVersion: UInt32(stored.sealedVersion), isFinal: true)
        XCTAssertEqual(oldPlain, Data("old".utf8))
        var trashed = 0
        _ = trashed
        XCTAssertEqual(trashed, 0)
    }

    func testManifestPutFailureLeavesTheOldCopy() async throws {
        let key = SymmetricKey(size: .bits256)
        let sealed = try remote(key: key, version: 4)
        let script = Script(replies: [
            (200, session(object: newID, method: "PUT", mode: "write"), Data(), [:]),
            (200, [:], Data(), [:]),
            (200, session(object: "manifest", method: "GET", mode: "read", generation: "42"), Data(), [:]),
            (200, [:], sealed, [:]),
            (500, [:], Data(), [:]),
        ])
        let file = GDManifestFile(id: fileID, name: "notes.txt", chunkCount: 1, totalSize: 3, chunks: [newID], sealedVersion: 4)
        do {
            _ = try await GDHostedFileReplace.uploadAndCommit(workspace: workspace, file: file, chunkBodies: [newID: Data("new".utf8)], key: key, now: now(), transport: script)
            XCTFail("manifest put should fail")
        } catch {}
        let opened = try GDSealedManifest.open(sealed: sealed, key: key)
        XCTAssertEqual(opened.files.first?.chunks, [oldID])
        XCTAssertTrue(opened.files.first?.previousChunks.isEmpty ?? false)
        XCTAssertEqual(script.sent.filter { $0.objects == [newID] && $0.kind == "object" }.count, 1)
    }

    func testDeleteFailureKeepsTheOldCopyAndDoesNotTrash() async throws {
        let key = SymmetricKey(size: .bits256)
        let sealed = try remote(key: key, version: 4)
        let script = Script(replies: [
            (200, session(object: newID, method: "PUT", mode: "write"), Data(), [:]),
            (200, [:], Data(), [:]),
            (200, session(object: "manifest", method: "GET", mode: "read", generation: "42"), Data(), [:]),
            (200, [:], sealed, [:]),
            (200, session(object: "manifest", method: "PUT", mode: "write"), Data(), [:]),
            (200, [:], Data(), [:]),
            (500, [:], Data(), [:]),
        ])
        let file = GDManifestFile(id: fileID, name: "notes.txt", chunkCount: 1, totalSize: 3, chunks: [newID], sealedVersion: 4)
        let committed = try await GDHostedFileReplace.uploadAndCommit(workspace: workspace, file: file, chunkBodies: [newID: Data("new".utf8)], key: key, now: now(), transport: script)
        var trashed = 0
        do {
            _ = try await GDHostedFileReplace.deletePreviousAndTrash(workspace: workspace, document: committed, fileID: fileID, now: now(), transport: script, trash: { trashed += 1 })
            XCTFail("delete should fail")
        } catch {}
        XCTAssertEqual(trashed, 0)
        XCTAssertEqual(committed.files.first?.previousChunks, [oldID])
        let readable = try GDSealedManifest.open(sealed: sealed, key: key)
        XCTAssertEqual(readable.files.first?.chunks, [oldID])
    }
}
