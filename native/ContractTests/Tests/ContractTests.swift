import CryptoKit
import XCTest
@testable import GenDragoonContract

/// Riley's fixtures are `{request, response:{status, body}}` at `fixtures/<area>/<case>.json`
/// (cloud-ssd PR #5, `4dfde4b`). Account and storage files are the response bodies from
/// PR #6 `84f6fff` and PR #7 `cc1a1e7` until those areas land in the same folder.
struct GDFixtureFile {
    var method: String
    var path: String
    var requestBody: Any?
    var status: Int
    var body: [String: Any]

    static func load(_ area: String, _ name: String, file: StaticString = #filePath) throws -> GDFixtureFile {
        var directory = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        var match: URL?
        for _ in 0..<8 {
            let candidate = directory.appendingPathComponent("fixtures/\(area)/\(name).json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                match = candidate
                break
            }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { break }
            directory = parent
        }
        guard let match else {
            XCTFail("Missing fixtures/\(area)/\(name).json")
            throw NSError(domain: "GDFixture", code: 1)
        }
        let root = try JSONSerialization.jsonObject(with: Data(contentsOf: match)) as? [String: Any]
        guard let root,
              let request = root["request"] as? [String: Any],
              let response = root["response"] as? [String: Any],
              let status = (response["status"] as? NSNumber)?.intValue,
              let body = response["body"] as? [String: Any],
              let method = request["method"] as? String,
              let path = request["path"] as? String else {
            XCTFail("fixtures/\(area)/\(name).json is not {request, response}")
            throw NSError(domain: "GDFixture", code: 2)
        }
        return GDFixtureFile(method: method, path: path, requestBody: request["body"], status: status, body: body)
    }

    static func strings(_ value: Any?) -> [String: String] {
        guard let dict = value as? [String: Any] else { return [:] }
        var out: [String: String] = [:]
        for (key, item) in dict {
            if let text = item as? String { out[key] = text }
        }
        return out
    }
}

final class AccountDeletionContractTests: XCTestCase {
    func testSavedJobPollsAndNeverSendsDelete() throws {
        let saved = try GDFixtureFile.load("account", "delete-accepted")
        let jobId = saved.body["jobId"] as? String
        let token = saved.body["statusToken"] as? String
        guard case .pollSaved(let job) = GDAccountContract.deletionIntent(savedJobId: jobId, savedStatusToken: token) else {
            return XCTFail("a saved job is polled with its token")
        }
        let request = GDAccountContract.pollRequest(jobId: job.jobId, statusToken: job.statusToken)
        XCTAssertEqual(request.method, "GET")
        XCTAssertEqual(request.path, "/v2/account/deletions/" + job.jobId)
        XCTAssertEqual(request.authorization, "Bearer " + job.statusToken)
        XCTAssertEqual(GDAccountContract.deletionIntent(savedJobId: nil, savedStatusToken: nil), .sendDelete)
    }

    func testAcceptedDeleteBodyCarriesTheStatusToken() throws {
        let fixture = try GDFixtureFile.load("account", "delete-accepted")
        XCTAssertEqual(fixture.status, 202)
        XCTAssertEqual(fixture.method, "DELETE")
        XCTAssertEqual(GDFixtureFile.strings(fixture.requestBody)["confirm"], String?("DELETE"))
        let decision = GDAccountContract.interpretStart(status: fixture.status, json: fixture.body)
        let jobId = try XCTUnwrap(fixture.body["jobId"] as? String)
        let token = try XCTUnwrap(fixture.body["statusToken"] as? String)
        XCTAssertTrue(GDAccountContract.isStatusToken(token))
        XCTAssertEqual(decision, .poll(jobId: jobId, statusToken: token))
    }

    func testRepeatDeleteAfterDoneIs410AndDoesNotWipe() throws {
        let fixture = try GDFixtureFile.load("account", "account-deleted")
        XCTAssertEqual(fixture.status, 410)
        XCTAssertEqual(GDServerCode.read(fixture.body), "account_deleted")
        let decision = GDAccountContract.interpretStart(status: fixture.status, json: fixture.body)
        guard case .poll(let jobId, let token) = decision else {
            return XCTFail("410 account_deleted is polled")
        }
        XCTAssertEqual(jobId, fixture.body["jobId"] as? String ?? "")
        XCTAssertEqual(token, fixture.body["statusToken"] as? String ?? "")
        XCTAssertNotEqual(decision, .wipe)
        let done = try GDFixtureFile.load("account", "status-done")
        XCTAssertEqual(Set(done.body.keys), Set(["jobId", "retryable", "status"]))
        XCTAssertEqual(GDAccountContract.interpretPoll(status: done.status, json: done.body), .wipe)
    }

    func testInvalidTokenShowsSignInAndKeepsTheSavedJob() throws {
        let fixture = try GDFixtureFile.load("account", "invalid-token")
        XCTAssertEqual(GDServerCode.read(fixture.body), "invalid_token")
        let kept = GDAccountContract.unauthorizedDeletion(json: fixture.body, savedJobExists: true)
        XCTAssertFalse(kept.wipe)
        XCTAssertTrue(kept.showSignIn)
        XCTAssertTrue(kept.keepSavedJob)
        XCTAssertFalse(kept.retryDelete)
        let absent = GDAccountContract.unauthorizedDeletion(json: fixture.body, savedJobExists: false)
        XCTAssertFalse(absent.wipe)
        XCTAssertFalse(absent.keepSavedJob)
        XCTAssertEqual(GDAccountContract.interpretStart(status: fixture.status, json: fixture.body), .reauthenticate(code: "invalid_token"))
        XCTAssertEqual(GDAccountContract.interpretPoll(status: fixture.status, json: fixture.body), .reauthenticate(code: "invalid_token"))
    }

    func testReauthRetriesDeleteOnlyWhenNothingIsSaved() throws {
        let fixture = try GDFixtureFile.load("account", "reauth-required")
        XCTAssertEqual(GDServerCode.read(fixture.body), "reauth_required")
        let saved = GDAccountContract.unauthorizedDeletion(json: fixture.body, savedJobExists: true)
        XCTAssertFalse(saved.wipe)
        XCTAssertFalse(saved.retryDelete)
        XCTAssertTrue(saved.keepSavedJob)
        let fresh = GDAccountContract.unauthorizedDeletion(json: fixture.body, savedJobExists: false)
        XCTAssertTrue(fresh.retryDelete)
        XCTAssertFalse(fresh.wipe)
    }

    func testPollReadsStatusAndOnlyQueuedOrRunningContinue() throws {
        let running = try GDFixtureFile.load("account", "status-running")
        let queued = try GDFixtureFile.load("account", "status-queued")
        XCTAssertEqual(GDAccountContract.interpretPoll(status: running.status, json: running.body), .polling(status: "running", retryable: true))
        XCTAssertEqual(GDAccountContract.interpretPoll(status: queued.status, json: queued.body), .polling(status: "queued", retryable: true))
        let failed = try GDFixtureFile.load("account", "status-failed")
        guard case .failed = GDAccountContract.interpretPoll(status: failed.status, json: failed.body) else {
            return XCTFail("failed stops without wiping")
        }
    }

    func testNotFoundAndUnavailableDoNotWipe() throws {
        let missing = try GDFixtureFile.load("account", "status-not-found")
        guard case .hold = GDAccountContract.interpretPoll(status: missing.status, json: missing.body) else {
            return XCTFail("an unknown job must not wipe")
        }
        let unavailable = try GDFixtureFile.load("account", "status-unavailable")
        guard case .hold = GDAccountContract.interpretPoll(status: unavailable.status, json: unavailable.body) else {
            return XCTFail("a non-2xx poll must not wipe")
        }
    }

    func testCompletedAndUnknownStatusFailWithoutWiping() {
        for status in ["completed", "cancelled"] {
            let body: [String: Any] = ["status": status, "retryable": false]
            guard case .failed = GDAccountContract.interpretPoll(status: 200, json: body) else {
                return XCTFail("\(status) must fail immediately")
            }
        }
    }

    func testErrorWinsWhenBothFieldsArePresent() {
        let body: [String: Any] = ["error": "invalid_token", "code": "reauth_required"]
        XCTAssertEqual(GDServerCode.read(body), "invalid_token")
    }

    func testStaleReauthPromptsAgainInsteadOfFailing() {
        let now: TimeInterval = 1_792_300_000
        let stale = GDAccountContract.reauthFollowUp(expectedUID: "uid-a", signedInUID: "uid-a",
                                                      authTime: now - 3600, now: now, freshSeconds: 300, retryDelete: true)
        guard case .promptAgain = stale else { return XCTFail("a stale sign-in prompts again") }
        let other = GDAccountContract.reauthFollowUp(expectedUID: "uid-a", signedInUID: "uid-b",
                                                      authTime: now, now: now, freshSeconds: 300, retryDelete: true)
        guard case .promptAgain = other else { return XCTFail("a different account prompts again") }
        let fresh = GDAccountContract.reauthFollowUp(expectedUID: "uid-a", signedInUID: "uid-a",
                                                      authTime: now - 10, now: now, freshSeconds: 300, retryDelete: true)
        XCTAssertEqual(fresh, .retryDelete)
    }
}

final class WorkspaceFixtureContractTests: XCTestCase {
    func testEveryWorkspaceLockFixtureOpensTheReviewScreen() throws {
        for name in ["over-cap", "lapsed", "over-cap-and-lapsed", "scope-unavailable", "merge-in-progress"] {
            let fixture = try GDFixtureFile.load("workspace-lock", name)
            XCTAssertEqual(fixture.status, 423, name)
            XCTAssertEqual(GDServerCode.read(fixture.body), "workspace_lock", name)
            guard case .reviewWorkspaces(let lock) = GDStorageContract.routeLock(status: fixture.status, json: fixture.body) else {
                return XCTFail(name)
            }
            XCTAssertEqual(lock.reason, fixture.body["reason"] as? String ?? "", name)
            XCTAssertEqual(lock.overBy, (fixture.body["overBy"] as? NSNumber)?.intValue ?? -1, name)
            XCTAssertEqual(lock.unpaidWorkspaceIds, fixture.body["unpaidWorkspaceIds"] as? [String] ?? [], name)
        }
    }

    func testWorkspaceCreateListAndCapUseTheFixtureBodies() throws {
        let created = try GDFixtureFile.load("workspaces", "create")
        XCTAssertEqual(created.status, 201)
        XCTAssertEqual(created.method, "POST")
        XCTAssertEqual(created.path, "/v2/projects")
        let requested = GDFixtureFile.strings(created.requestBody)
        XCTAssertEqual(requested["name"], String?("Fixture Project"))
        XCTAssertEqual((created.body["project"] as? [String: Any])?["name"] as? String, String?("Fixture Project"))

        let listed = try GDFixtureFile.load("workspaces", "list")
        XCTAssertEqual(listed.method, "GET")
        XCTAssertEqual(listed.path, "/v2/workspaces")
        let workspaces = listed.body["workspaces"] as? [[String: Any]]
        XCTAssertEqual(workspaces?.first?["name"] as? String, String?("Fixture Project"))
        XCTAssertEqual(workspaces?.first?["id"] as? String, String?("11111111-1111-4111-8111-000000000001"))

        let cap = try GDFixtureFile.load("workspaces", "cap-reached")
        XCTAssertEqual(GDServerCode.read(cap.body), "PROJECT_LIMIT_REACHED")
        let message = GDStorageContract.explainProjectWrite(status: cap.status, json: cap.body)
        XCTAssertNotEqual(message, String?("PROJECT_LIMIT_REACHED"))
        XCTAssertFalse(message?.contains("PROJECT_LIMIT_REACHED") ?? true)
    }

    func testMergeFixturesUseTheSourceRouteAndConfirmName() throws {
        let source = "11111111-1111-4111-8111-000000000001"
        let preview = try GDFixtureFile.load("merge", "preview")
        XCTAssertEqual(preview.path, "/" + GDStorageContract.mergePreviewPath(sourceId: source))
        let previewBody = GDFixtureFile.strings(preview.requestBody)
        XCTAssertEqual(GDStorageContract.mergeBody(targetId: previewBody["targetId"] ?? "", confirmName: previewBody["confirmName"] ?? ""), previewBody)
        let renamed = ((preview.body["files"] as? [[String: Any]])?.first)?["renamedTo"] as? String
        XCTAssertEqual(renamed, String?("notes.txt (from Alpha)"))

        let confirm = try GDFixtureFile.load("merge", "confirm-name")
        XCTAssertEqual(GDServerCode.read(confirm.body), "CONFIRM_NAME_REQUIRED")
        let message = GDStorageContract.explainProjectWrite(status: confirm.status, json: confirm.body)
        XCTAssertFalse(message?.contains("CONFIRM_NAME_REQUIRED") ?? true)

        let completed = try GDFixtureFile.load("merge", "completed")
        XCTAssertEqual(completed.path, "/" + GDStorageContract.mergePath(sourceId: source))
        XCTAssertTrue(GDStorageContract.mergeCompleted(completed.body))

        let renamedFile = try GDFixtureFile.load("merge", "renamed-file")
        let names = (renamedFile.body["files"] as? [[String: Any]])?.compactMap { $0["name"] as? String }
        XCTAssertEqual(names ?? [], ["notes.txt", "notes.txt (from Alpha)"])
    }

    func testByoFixturesDriveRegisterChallengeAndVerify() throws {
        let register = try GDFixtureFile.load("byo", "register")
        let registerBody = GDFixtureFile.strings(register.requestBody)
        XCTAssertEqual(try XCTUnwrap(GDStorageContract.byoRegisterBody(provider: registerBody["provider"] ?? "",
                                                                       endpoint: registerBody["endpoint"] ?? "",
                                                                       bucketFingerprint: registerBody["bucketFingerprint"] ?? "")),
                       registerBody)
        XCTAssertEqual(register.path, "/" + GDStorageContract.byoRegisterPath(workspaceId: "11111111-1111-4111-8111-000000000001"))
        XCTAssertEqual(GDStorageContract.normalizedBYOProvider("r2"), "s3")
        XCTAssertNil(GDStorageContract.byoRegisterBody(provider: "sftp", endpoint: "sftp.example.com:22", bucketFingerprint: "abababababababab"))

        let challenge = try GDFixtureFile.load("byo", "challenge")
        let nonce = try XCTUnwrap(challenge.body["nonce"] as? String)
        XCTAssertEqual(GDStorageContract.challengeObject(nonce: nonce), ".gendragoon-challenge/" + nonce)
        XCTAssertEqual(challenge.path, "/" + GDStorageContract.byoChallengePath(workspaceId: "11111111-1111-4111-8111-000000000001"))

        let success = try GDFixtureFile.load("byo", "verify-success")
        let proof = GDFixtureFile.strings(success.requestBody)
        XCTAssertEqual(Set(proof.keys), Set(["presignedUrl"]))
        XCTAssertEqual(GDStorageContract.byoVerifyBody(presignedUrl: proof["presignedUrl"] ?? ""), proof)
        XCTAssertEqual(success.body["verified"] as? Bool, Bool?(true))
        XCTAssertTrue(GDStorageContract.presignedHostMatches(presignedUrl: proof["presignedUrl"] ?? "", endpoint: registerBody["endpoint"] ?? ""))

        let mismatch = try GDFixtureFile.load("byo", "verify-host-mismatch")
        let attacker = GDFixtureFile.strings(mismatch.requestBody)["presignedUrl"] ?? ""
        XCTAssertFalse(GDStorageContract.presignedHostMatches(presignedUrl: attacker, endpoint: registerBody["endpoint"] ?? ""))

        for name in ["verify-expired", "verify-host-mismatch", "verify-mismatch", "verify-proof-required", "verify-used", "provider-unsupported"] {
            let fixture = try GDFixtureFile.load("byo", name)
            let code = GDServerCode.read(fixture.body)
            XCTAssertFalse(code.isEmpty, name)
            let message = GDStorageContract.byoMessage(code: code, status: fixture.status)
            XCTAssertNotNil(message, name)
            XCTAssertFalse(message?.contains(code) ?? true, name)
        }
    }

    func testForeignWorkspaceIsNotOnThisAccount() throws {
        let fixture = try GDFixtureFile.load("ownership", "foreign-workspace")
        XCTAssertEqual(fixture.status, 404)
        XCTAssertEqual(GDServerCode.read(fixture.body), "PROJECT_NOT_FOUND")
        let message = GDStorageContract.explainProjectWrite(status: fixture.status, json: fixture.body)
        XCTAssertFalse(message?.contains("PROJECT_NOT_FOUND") ?? true)
    }
}

final class StorageAndManifestContractTests: XCTestCase {
    func testStorageURLFixturesUseModeAndObject() throws {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let workspace = "12345678-1234-4000-8000-000000000001"
        let upload = try GDFixtureFile.load("storage", "upload-urls")
        let session = try GDStorageContract.parseSession(workspace: workspace, json: upload.body, now: now)
        XCTAssertEqual(session.mode, "write")
        XCTAssertEqual(session.urls.first?.method, String?("PUT"))
        XCTAssertEqual(session.urls.first?.object, String?(String(repeating: "a", count: 32)))
        XCTAssertEqual(GDFixtureFile.strings(upload.requestBody)["op"], String?("upload"))
        XCTAssertTrue(GDStorageContract.pathContainsWorkspace(upload.body["prefix"] as? String ?? "", workspace: workspace))
        XCTAssertFalse(GDStorageContract.pathContainsWorkspace("/customer/abc/managed/ws-10/objects/x", workspace: "ws-1"))

        let download = try GDFixtureFile.load("storage", "download-urls")
        let read = try GDStorageContract.parseSession(workspace: workspace, json: download.body, now: now)
        XCTAssertEqual(read.mode, "read")
        XCTAssertEqual(read.urls.first?.method, String?("GET"))

        for name in ["not-found", "workspace-lock", "invalid-object-id", "plaintext-rejected", "byo-external"] {
            let fixture = try GDFixtureFile.load("storage", name)
            XCTAssertFalse(GDServerCode.read(fixture.body).isEmpty, name)
        }
        let locked = try GDFixtureFile.load("storage", "workspace-lock")
        XCTAssertEqual(GDStorageContract.routeLock(status: locked.status, json: locked.body),
                       .reviewWorkspaces(GDWorkspaceLockBody(error: "workspace_lock", reason: "workspace_lock", overBy: 0, unpaidWorkspaceIds: [])))
        let external = try GDFixtureFile.load("storage", "byo-external")
        XCTAssertEqual(GDStorageContract.byoMessage(code: GDServerCode.read(external.body), status: external.status), String?(GDStorageContract.byoExternalMessage))
        let plaintext = try GDFixtureFile.load("storage", "plaintext-rejected")
        XCTAssertTrue(GDStorageContract.rejectsPlaintext(plaintext.requestBody as? [String: Any] ?? [:]))
        XCTAssertFalse(JSONSerialization.data(withJSONObject: plaintext.body).base64EncodedString().isEmpty)
        let encoded = String(decoding: try JSONSerialization.data(withJSONObject: plaintext.body), as: UTF8.self)
        XCTAssertFalse(encoded.contains("super-secret-report.pdf"))
        XCTAssertFalse(encoded.contains("not-a-real-key"))
        XCTAssertFalse(GDStorageContract.isOpaqueID("../" + String(repeating: "a", count: 32)))
    }

    func testManifestObjectCarriesGenerationAndRejectsAnOlderVersion() throws {
        XCTAssertTrue(GDStorageContract.isOpaqueID("manifest"))
        XCTAssertFalse(GDStorageContract.isOpaqueID("library"))
        XCTAssertFalse(GDSealedManifest.usesResumableUploads)
        XCTAssertEqual(GDSealedManifest.objectID, "manifest")
        let upload = GDSealedManifest.uploadBody(generation: "178")
        XCTAssertEqual(upload["op"] as? String, String?("upload"))
        XCTAssertEqual(upload["objects"] as? [String] ?? [], ["manifest"])
        XCTAssertEqual(upload["ifGeneration"] as? String, String?("178"))
        XCTAssertEqual(GDSealedManifest.generation(objectStatus: 200, headers: ["x-goog-generation": "178"]), .value("178"))
        XCTAssertEqual(GDSealedManifest.generation(objectStatus: 404, headers: [:]), .absentObject)
        XCTAssertEqual(GDSealedManifest.generationValue(.absentObject), String?("0"))
        XCTAssertEqual(GDSealedManifest.generation(objectStatus: 200, headers: [:]), .missing)
        XCTAssertNil(GDSealedManifest.generationValue(.missing))
        XCTAssertEqual(GDSealedManifest.interpretUpload(status: 412, json: [:]), .retryMerge)
        XCTAssertEqual(GDSealedManifest.interpretUpload(status: 400, json: ["error": "manifest_generation_required"]), .clientBug)

        let file = GDManifestFile(name: "notes.txt", chunkCount: 1, totalSize: 4, chunks: [String(repeating: "ab", count: 16)])
        let current = GDSealedManifestDocument(version: 4, files: [file])
        XCTAssertThrowsError(try GDSealedManifest.merge(local: current, remote: GDSealedManifestDocument(version: 3, files: []), lastSeen: 4))
        let merged = try GDSealedManifest.merge(local: current, remote: GDSealedManifestDocument(version: 4, files: []), lastSeen: 4)
        XCTAssertEqual(merged.version, 5)
        XCTAssertEqual(merged.files.first?.chunkCount, Int?(1))
        XCTAssertEqual(merged.files.first?.totalSize, Int?(4))
        let key = SymmetricKey(size: .bits256)
        let sealed = try GDSealedManifest.seal(document: merged, key: key)
        XCTAssertEqual(try GDSealedManifest.open(sealed: sealed, key: key), merged)
    }

    func testChunksFailUnlessTheyAreCompleteAndOnlyTheLastIsFinal() throws {
        let key = SymmetricKey(size: .bits256)
        let parts = [Data("aaaa".utf8), Data("bbbb".utf8), Data("cc".utf8)]
        let sealed = try parts.enumerated().map { index, part in
            try GDSealedManifest.sealChunk(plaintext: part, key: key, index: UInt32(index), isFinal: index == parts.count - 1)
        }
        let opened = try GDSealedManifest.openFile(chunks: sealed, key: key, chunkCount: 3, totalSize: 10)
        XCTAssertEqual(opened, Data("aaaabbbbcc".utf8))
        XCTAssertThrowsError(try GDSealedManifest.openFile(chunks: [sealed[1], sealed[0], sealed[2]], key: key, chunkCount: 3, totalSize: 10))
        XCTAssertThrowsError(try GDSealedManifest.openFile(chunks: [sealed[0], sealed[2]], key: key, chunkCount: 2, totalSize: 6))
        let earlyFinal = try GDSealedManifest.sealChunk(plaintext: parts[0], key: key, index: 0, isFinal: true)
        XCTAssertThrowsError(try GDSealedManifest.openFile(chunks: [earlyFinal, sealed[1], sealed[2]], key: key, chunkCount: 3, totalSize: 10))
        let unfinished = try GDSealedManifest.sealChunk(plaintext: parts[2], key: key, index: 2, isFinal: false)
        XCTAssertThrowsError(try GDSealedManifest.openFile(chunks: [sealed[0], sealed[1], unfinished], key: key, chunkCount: 3, totalSize: 10))
        XCTAssertThrowsError(try GDSealedManifest.openFile(chunks: sealed, key: key, chunkCount: 3, totalSize: 9))
    }

    func testChunkedSealRoundTrip() throws {
        let key = SymmetricKey(size: .bits256)
        let plaintext = Data("workspace-file".utf8)
        let sealed = try GDChunkCrypto.seal(plaintext: plaintext, key: key, chunkBytes: 4)
        XCTAssertNil(sealed.range(of: plaintext))
        XCTAssertEqual(try GDChunkCrypto.open(sealed: sealed, key: key), plaintext)
    }

    func testArgon2idMatchesTheRfcVector() {
        let derived = GDArgon2.derive(
            password: Data(repeating: 0x01, count: 32),
            salt: Data(repeating: 0x02, count: 16),
            secret: Data(repeating: 0x03, count: 8),
            associatedData: Data(repeating: 0x04, count: 12),
            parameters: GDArgon2.Parameters(memoryKiB: 32, iterations: 3, parallelism: 4, tagLength: 32))
        XCTAssertEqual(derived.map { String(format: "%02x", $0) }.joined(),
                       "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659")
    }

    func testEnvelopeRoundTripUsesTheRecordedParameters() throws {
        let workspaceKey = Data(repeating: 0x11, count: 32)
        let envelope = try GDWorkspaceKeyEnvelope.wrap(workspaceKey: workspaceKey, passphrase: "correct horse",
                                                        parameters: .interactiveTest)
        XCTAssertEqual(envelope.kdf, "argon2id")
        XCTAssertEqual(try GDWorkspaceKeyEnvelope.unwrap(envelope: envelope, passphrase: "correct horse"), workspaceKey)
        XCTAssertThrowsError(try GDWorkspaceKeyEnvelope.unwrap(envelope: envelope, passphrase: "wrong"))
    }
}
