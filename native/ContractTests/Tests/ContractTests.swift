import CryptoKit
import XCTest
@testable import GenDragoonContract

/// Riley's fixtures are `{request, response:{status, body}}` at `fixtures/<area>/<case>.json`.
/// Account deletion is `npm run fixtures` from PR #6 `9d0f056`. Key envelopes are the same
/// command from PR #9 `24fba02`. `fixtures/errors/payload-too-large.json` is the JSON 413.
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
              let method = request["method"] as? String,
              let path = request["path"] as? String else {
            XCTFail("fixtures/\(area)/\(name).json is not {request, response}")
            throw NSError(domain: "GDFixture", code: 2)
        }
        // Express HTML (singular path) is not a JSON object. Fall back to the status code.
        let body = response["body"] as? [String: Any] ?? [:]
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
        let saved = try GDFixtureFile.load("account-deletion", "accepted")
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
        let fixture = try GDFixtureFile.load("account-deletion", "accepted")
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
        let fixture = try GDFixtureFile.load("account-deletion", "account-deleted")
        XCTAssertEqual(fixture.status, 410)
        XCTAssertEqual(GDServerCode.read(fixture.body), "account_deleted")
        let decision = GDAccountContract.interpretStart(status: fixture.status, json: fixture.body)
        guard case .poll(let jobId, let token) = decision else {
            return XCTFail("410 account_deleted is polled")
        }
        XCTAssertEqual(jobId, fixture.body["jobId"] as? String ?? "")
        XCTAssertEqual(token, fixture.body["statusToken"] as? String ?? "")
        XCTAssertNotEqual(decision, .wipe)
        let done = try GDFixtureFile.load("account-deletion", "status-done")
        XCTAssertEqual(Set(done.body.keys), Set(["jobId", "retryable", "status"]))
        XCTAssertEqual(GDAccountContract.interpretPoll(status: done.status, json: done.body), .wipe)
    }

    func testInvalidTokenShowsSignInAndKeepsTheSavedJob() throws {
        let fixture = try GDFixtureFile.load("account-deletion", "invalid-token")
        XCTAssertEqual(GDServerCode.read(fixture.body), "invalid_token")
        let kept = GDAccountContract.unauthorizedDeletion(json: fixture.body, savedJobExists: true)
        XCTAssertFalse(kept.wipe)
        XCTAssertTrue(kept.signOut)
        XCTAssertTrue(kept.keepPolling)
        XCTAssertEqual(kept.signal, .signedOut)
        XCTAssertEqual(kept.signal?.signal, "signed_out")
        XCTAssertFalse(kept.showSignIn)
        XCTAssertTrue(kept.keepSavedJob)
        XCTAssertFalse(kept.retryDelete)
        let absent = GDAccountContract.unauthorizedDeletion(json: fixture.body, savedJobExists: false)
        XCTAssertFalse(absent.wipe)
        XCTAssertFalse(absent.keepSavedJob)
        XCTAssertEqual(GDAccountContract.interpretStart(status: fixture.status, json: fixture.body), .reauthenticate(code: "invalid_token"))
        XCTAssertEqual(GDAccountContract.interpretPoll(status: fixture.status, json: fixture.body), .reauthenticate(code: "invalid_token"))
    }

    func testReauthRetriesDeleteOnlyWhenNothingIsSaved() throws {
        let fixture = try GDFixtureFile.load("account-deletion", "reauth-required")
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
        let running = try GDFixtureFile.load("account-deletion", "status-running")
        let queued = try GDFixtureFile.load("account-deletion", "status-queued")
        XCTAssertEqual(GDAccountContract.interpretPoll(status: running.status, json: running.body), .polling(status: "running", retryable: true))
        XCTAssertEqual(GDAccountContract.interpretPoll(status: queued.status, json: queued.body), .polling(status: "queued", retryable: true))
        let failed = try GDFixtureFile.load("account-deletion", "status-failed")
        guard case .failed = GDAccountContract.interpretPoll(status: failed.status, json: failed.body) else {
            return XCTFail("failed stops without wiping")
        }
    }

    func testNotFoundAndUnavailableDoNotWipe() throws {
        let missing = try GDFixtureFile.load("account-deletion", "expired-token")
        guard case .notFound = GDAccountContract.interpretPoll(status: missing.status, json: missing.body) else {
            return XCTFail("an unknown job must not wipe")
        }
        let unavailable = GDAccountContract.interpretPoll(status: 503, json: ["error": "deletion_status_unavailable"])
        guard case .hold = unavailable else {
            return XCTFail("a non-2xx poll must not wipe")
        }
    }

    func testUnauthorizedWithoutAnErrorCodeShowsSignInAndKeepsTheJob() throws {
        let body: [String: Any] = [:]
        XCTAssertEqual(GDServerCode.read(body), "")
        let kept = GDAccountContract.unauthorizedDeletion(json: body, savedJobExists: true)
        XCTAssertFalse(kept.wipe)
        XCTAssertTrue(kept.showSignIn)
        XCTAssertTrue(kept.keepSavedJob)
        XCTAssertFalse(kept.retryDelete)
        XCTAssertEqual(GDAccountContract.interpretStart(status: 401, json: body), .reauthenticate(code: "unauthorized"))
        XCTAssertEqual(GDAccountContract.interpretPoll(status: 401, json: body), .reauthenticate(code: "unauthorized"))
        let message = GDAccountContract.unauthorizedMessage(json: body)
        XCTAssertFalse(message.contains("5 minutes"))
        let saved = try GDFixtureFile.load("account-deletion", "accepted")
        let jobId = try XCTUnwrap(saved.body["jobId"] as? String)
        let token = try XCTUnwrap(saved.body["statusToken"] as? String)
        guard case .pollSaved = GDAccountContract.deletionIntent(savedJobId: jobId, savedStatusToken: token) else {
            return XCTFail("a bare 401 must not turn a saved job into a new DELETE")
        }
    }

    func testNotFoundWhilePollingKeepsTheJobAndOffersRetry() throws {
        let missing = try GDFixtureFile.load("account-deletion", "expired-token")
        XCTAssertEqual(missing.status, 404)
        XCTAssertEqual(GDServerCode.read(missing.body), "not_found")
        guard case .notFound(let message) = GDAccountContract.interpretPoll(status: missing.status, json: missing.body) else {
            return XCTFail("a 404 while polling keeps the saved job")
        }
        XCTAssertFalse(message.contains("not_found"))
        let recovery = GDAccountContract.pollRecovery(for: .notFound(message))
        XCTAssertFalse(recovery.wipe)
        XCTAssertTrue(recovery.keepSavedJob)
        XCTAssertTrue(recovery.showRetry)
        XCTAssertFalse(recovery.allowDismiss)
        XCTAssertTrue(recovery.sendDelete)
        let dismiss = GDAccountContract.dismissRecovery()
        XCTAssertFalse(dismiss.wipe)
        XCTAssertFalse(dismiss.keepSavedJob)
        XCTAssertFalse(dismiss.sendDelete)
        let done = GDAccountContract.pollRecovery(for: .wipe)
        XCTAssertTrue(done.wipe)
        XCTAssertFalse(done.keepSavedJob)
        XCTAssertFalse(done.sendDelete)
        let saved = try GDFixtureFile.load("account-deletion", "accepted")
        let jobId = try XCTUnwrap(saved.body["jobId"] as? String)
        let token = try XCTUnwrap(saved.body["statusToken"] as? String)
        guard case .pollSaved(let job) = GDAccountContract.deletionIntent(savedJobId: jobId, savedStatusToken: token) else {
            return XCTFail("a 404 must keep polling the saved token")
        }
        XCTAssertTrue(missing.path.hasPrefix(GDAccountContract.statusPrefix))
        XCTAssertEqual(job.statusToken, token)
    }

    func testResignInAdoptsOnlyTheSameAccountAndResumeKeepsTheStarter() {
        XCTAssertEqual(GDAccountContract.adoptSignIn(incomingUID: "uid-a", savedOwnerUID: nil), .adopt(uid: "uid-a"))
        XCTAssertEqual(GDAccountContract.adoptSignIn(incomingUID: "uid-a", savedOwnerUID: nil, currentUID: "uid-a"), .adopt(uid: "uid-a"))
        guard case .reject = GDAccountContract.adoptSignIn(incomingUID: "uid-b", savedOwnerUID: nil, currentUID: "uid-a") else {
            return XCTFail("a different account is rejected before any deletion is saved")
        }
        XCTAssertEqual(GDAccountContract.adoptSignIn(incomingUID: "uid-a", savedOwnerUID: ""), .adopt(uid: "uid-a"))
        XCTAssertEqual(GDAccountContract.adoptSignIn(incomingUID: "uid-a", savedOwnerUID: "uid-a"), .adopt(uid: "uid-a"))
        guard case .reject = GDAccountContract.adoptSignIn(incomingUID: "uid-b", savedOwnerUID: "uid-a") else {
            return XCTFail("a different account must not take the session")
        }
        XCTAssertEqual(GDAccountContract.retainedDeletionOwner(savedOwnerUID: "uid-a", incomingUID: "uid-b"), "uid-a")
        XCTAssertEqual(GDAccountContract.retainedDeletionOwner(savedOwnerUID: "uid-a", incomingUID: "uid-a"), "uid-a")
        XCTAssertEqual(GDAccountContract.retainedDeletionOwner(savedOwnerUID: "", incomingUID: "uid-b"), "uid-b")
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
        XCTAssertEqual(GDServerCode.read(["error": "PROJECT_NOT_FOUND", "code": "not_found"]), "PROJECT_NOT_FOUND")
        XCTAssertEqual(GDServerCode.read(["error": "  ", "code": "PROJECT_NOT_FOUND"]), "PROJECT_NOT_FOUND")
        XCTAssertEqual(GDServerCode.read(["error": "", "code": "deletion_not_retryable"]), "deletion_not_retryable")
        XCTAssertEqual(GDServerCode.read(["code": "PROJECT_NOT_FOUND"]), "PROJECT_NOT_FOUND")
    }

    func testOpaqueJobIdAndStatusTokenAreAnyNonEmptyString() throws {
        XCTAssertTrue(GDAccountContract.isStatusToken("<redacted>"))
        XCTAssertTrue(GDAccountContract.isStatusToken(String(repeating: "A", count: 43)))
        XCTAssertTrue(GDAccountContract.isJobID("00000000-0000-4000-8000-000000000001"))
        XCTAssertTrue(GDAccountContract.isJobID("job"))
        XCTAssertFalse(GDAccountContract.isStatusToken(""))
        XCTAssertFalse(GDAccountContract.isStatusToken("   "))
        XCTAssertFalse(GDAccountContract.isJobID(""))
        let accepted = try GDFixtureFile.load("account-deletion", "accepted")
        let token = try XCTUnwrap(accepted.body["statusToken"] as? String)
        XCTAssertEqual(token, "<redacted>")
        let decision = GDAccountContract.interpretStart(status: accepted.status, json: accepted.body)
        guard case .poll(let jobId, let statusToken) = decision else {
            return XCTFail("a redacted token is still a saved job, not a reason to send DELETE again")
        }
        guard case .pollSaved = GDAccountContract.deletionIntent(savedJobId: jobId, savedStatusToken: statusToken) else {
            return XCTFail("deletion intent polls an opaque token")
        }
        let missing = GDAccountContract.interpretStart(status: 202, json: ["jobId": jobId, "status": "deleting"])
        guard case .retryWithoutDelete = missing else {
            return XCTFail("a 202 without a token is an error, not a new DELETE")
        }
        let recovery = GDAccountContract.pollRecovery(for: missing)
        XCTAssertTrue(recovery.showRetry)
        XCTAssertFalse(recovery.sendDelete)
        XCTAssertFalse(recovery.wipe)
        let gone = try GDFixtureFile.load("account-deletion", "account-deleted")
        guard case .poll = GDAccountContract.interpretStart(status: gone.status, json: gone.body) else {
            return XCTFail("410 account_deleted with an opaque token is polled")
        }
    }

    func testFailedRetryableKeepsTheJobAndDismissDoesNotWipe() throws {
        let retryable = try GDFixtureFile.load("account-deletion", "status-failed")
        XCTAssertEqual(retryable.body["retryable"] as? Bool, true)
        guard case .failed(let message, true) = GDAccountContract.interpretPoll(status: retryable.status, json: retryable.body) else {
            return XCTFail("retryable failure keeps the job")
        }
        let retry = GDAccountContract.pollRecovery(for: .failed(message, retryable: true))
        XCTAssertFalse(retry.wipe)
        XCTAssertTrue(retry.keepSavedJob)
        XCTAssertTrue(retry.showRetry)
        XCTAssertTrue(retry.sendDelete)
        XCTAssertFalse(retry.allowDismiss)
        let terminal: [String: Any] = ["status": "failed", "retryable": false, "failure": "stripe_cancel_failed"]
        guard case .failed(_, false) = GDAccountContract.interpretPoll(status: 200, json: terminal) else {
            return XCTFail("a non-retryable failure is still failed")
        }
        let dismiss = GDAccountContract.pollRecovery(for: .failed("stripe_cancel_failed", retryable: false))
        XCTAssertFalse(dismiss.wipe)
        XCTAssertTrue(dismiss.keepSavedJob)
        XCTAssertFalse(dismiss.showRetry)
        XCTAssertTrue(dismiss.allowDismiss)
        XCTAssertFalse(dismiss.sendDelete)
        let cleared = GDAccountContract.dismissRecovery()
        XCTAssertFalse(cleared.wipe)
        XCTAssertFalse(cleared.keepSavedJob)
        XCTAssertFalse(cleared.sendDelete)
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

    func testStatus404FixturesKeepTheJobAndRetrySendsDelete() throws {
        for name in ["expired-token", "other-job-token"] {
            let fixture = try GDFixtureFile.load("account-deletion", name)
            XCTAssertEqual(fixture.status, 404, name)
            XCTAssertEqual(GDServerCode.read(fixture.body), "not_found", name)
            let recovery = GDAccountContract.pollRecovery(for: GDAccountContract.interpretPoll(status: fixture.status, json: fixture.body))
            XCTAssertTrue(recovery.keepSavedJob, name)
            XCTAssertTrue(recovery.showRetry, name)
            XCTAssertTrue(recovery.sendDelete, name)
            XCTAssertFalse(recovery.allowDismiss, name)
            XCTAssertFalse(recovery.wipe, name)
        }
    }

    func testStatusToken401StopsAndFirebaseInvalidTokenSignsOut() throws {
        let invalid = try GDFixtureFile.load("account-deletion", "status-invalid-token")
        XCTAssertEqual(invalid.method, "GET")
        XCTAssertEqual(invalid.status, 401)
        let polled = GDAccountContract.unauthorizedDeletion(json: invalid.body, savedJobExists: true, credential: .statusToken)
        XCTAssertFalse(polled.signOut)
        XCTAssertTrue(polled.showSignIn)
        XCTAssertFalse(polled.keepPolling)
        XCTAssertEqual(polled.signal, .reauthRequired)
        XCTAssertEqual(polled.signal?.signal, "reauth_required")
        XCTAssertTrue(polled.retryDelete)
        XCTAssertFalse(polled.wipe)
        let firebase = GDAccountContract.unauthorizedDeletion(json: invalid.body, savedJobExists: true, credential: .firebase)
        XCTAssertTrue(firebase.signOut)
        XCTAssertFalse(firebase.showSignIn)
        XCTAssertTrue(firebase.keepPolling)
        XCTAssertEqual(firebase.signal, .signedOut)
        let bare = try GDFixtureFile.load("account-deletion", "status-unauthorized")
        XCTAssertEqual(GDServerCode.read(bare.body), "unauthorized")
        let stopped = GDAccountContract.unauthorizedDeletion(json: bare.body, savedJobExists: true, credential: .statusToken)
        XCTAssertTrue(stopped.showSignIn)
        XCTAssertFalse(stopped.signOut)
        XCTAssertFalse(stopped.keepPolling)
        XCTAssertNil(stopped.signal)
    }

    func testSingularPathIsJSONNotFound() throws {
        let fixture = try GDFixtureFile.load("account-deletion", "singular-path")
        XCTAssertEqual(fixture.method, "GET")
        XCTAssertEqual(fixture.status, 404)
        XCTAssertEqual(GDServerCode.read(fixture.body), "not_found")
        guard case .notFound = GDAccountContract.interpretPoll(status: fixture.status, json: fixture.body) else {
            return XCTFail("the singular path 404 is not found")
        }
    }

    func testRetryAfterFailedFixtureReturnsTheSameJob() throws {
        let fixture = try GDFixtureFile.load("account-deletion", "retry-after-failed")
        XCTAssertEqual(fixture.status, 202)
        XCTAssertEqual(fixture.body["status"] as? String, "queued")
        XCTAssertEqual(fixture.body["jobId"] as? String, "00000000-0000-4000-8000-000000000004")
        guard case .poll(let jobId, let token) = GDAccountContract.interpretStart(status: fixture.status, json: fixture.body) else {
            return XCTFail("retry after failed returns the same job and a new token")
        }
        XCTAssertEqual(jobId, "00000000-0000-4000-8000-000000000004")
        XCTAssertEqual(token, "<redacted>")
    }

    func testRetryNotRetryableFixtureRaisesTheTypedError() throws {
        let fixture = try GDFixtureFile.load("account-deletion", "retry-not-retryable")
        XCTAssertEqual(fixture.status, 409)
        XCTAssertThrowsError(try GDAccountContract.deletionNotRetryable(status: fixture.status, json: fixture.body)) { error in
            let typed = try XCTUnwrap(error as? GDDeletionNotRetryable)
            XCTAssertEqual(typed.jobId, "00000000-0000-4000-8000-0000000000aa")
        }
        XCTAssertNoThrow(try GDAccountContract.deletionNotRetryable(status: 202, json: fixture.body))
    }

    func testPayloadTooLargeHoldsWithoutWiping() throws {
        let fixture = try GDFixtureFile.load("errors", "payload-too-large")
        XCTAssertEqual(fixture.method, "POST")
        XCTAssertEqual(fixture.path, "/v2/account")
        XCTAssertEqual(fixture.status, 413)
        XCTAssertEqual(GDServerCode.read(fixture.body), "payload_too_large")
        guard case .hold = GDAccountContract.interpretStart(status: fixture.status, json: fixture.body) else {
            return XCTFail("413 holds")
        }
        let recovery = GDAccountContract.pollRecovery(for: GDAccountContract.interpretStart(status: fixture.status, json: fixture.body))
        XCTAssertFalse(recovery.wipe)
        XCTAssertFalse(recovery.sendDelete)
    }

    func testSupportContactReleaseCheckFollowsThePlaceholderFlag() {
        XCTAssertFalse(GDSupportContact.current.value.isEmpty)
        if GDSupportContact.current.isPlaceholder {
            XCTAssertThrowsError(try GDSupportContact.assertReleaseReady()) { error in
                XCTAssertEqual(error as? GDSupportContactError, .stillPlaceholder)
            }
        } else {
            XCTAssertNoThrow(try GDSupportContact.assertReleaseReady())
        }
    }
}

final class WorkspaceFixtureContractTests: XCTestCase {
    func testWorkspaceLockOverCap() throws {
        try assertWorkspaceLock("over-cap", reason: "over_cap")
        XCTAssertEqual(GDStorageContract.lockMessage(reason: "over_cap"),
                       "This account is over its workspace limit. Delete or merge the extra workspaces. Downloads stay available.")
    }

    func testWorkspaceLockLapsed() throws {
        try assertWorkspaceLock("lapsed", reason: "lapsed")
        let message = GDStorageContract.lockMessage(reason: "lapsed")
        XCTAssertTrue(message.contains("Pay"))
        XCTAssertFalse(message.contains("Delete or merge"))
    }

    func testWorkspaceLockOverCapAndLapsed() throws {
        try assertWorkspaceLock("over-cap-and-lapsed", reason: "over_cap_and_lapsed")
        XCTAssertTrue(GDStorageContract.lockMessage(reason: "over_cap_and_lapsed").contains("Pay"))
        XCTAssertFalse(GDStorageContract.canMergeOrDelete(reason: "merge_in_progress"))
        XCTAssertTrue(GDStorageContract.canMergeOrDelete(reason: "lapsed"))
    }

    func testWorkspaceLockScopeUnavailable() throws {
        try assertWorkspaceLock("scope-unavailable", reason: "scope_unavailable")
        XCTAssertEqual(GDStorageContract.lockMessage(reason: "scope_unavailable"),
                       "This workspace is outside the current allowance. Review it before uploading. Downloads stay available.")
        XCTAssertNotEqual(GDStorageContract.lockMessage(reason: "scope_unavailable"),
                          GDStorageContract.lockMessage(reason: "over_cap"))
    }

    func testWorkspaceLockMergeInProgress() throws {
        try assertWorkspaceLock("merge-in-progress", reason: "merge_in_progress")
        XCTAssertEqual(GDStorageContract.lockMessage(reason: "merge_in_progress"),
                       "A workspace merge is still in progress. Wait for it to finish before uploading. Downloads stay available.")
        XCTAssertNotEqual(GDStorageContract.lockMessage(reason: "merge_in_progress"),
                          GDStorageContract.lockMessage(reason: "scope_unavailable"))
        XCTAssertNotEqual(GDStorageContract.lockMessage(reason: "merge_in_progress"),
                          GDStorageContract.lockMessage(reason: "over_cap"))
    }

    private func assertWorkspaceLock(_ name: String, reason: String, file: StaticString = #filePath, line: UInt = #line) throws {
        let fixture = try GDFixtureFile.load("workspace-lock", name)
        XCTAssertEqual(fixture.status, 423, name, file: file, line: line)
        XCTAssertEqual(GDServerCode.read(fixture.body), "workspace_lock", name, file: file, line: line)
        guard case .reviewWorkspaces(let lock) = GDStorageContract.routeLock(status: fixture.status, json: fixture.body) else {
            return XCTFail(name, file: file, line: line)
        }
        XCTAssertEqual(lock.reason, reason, file: file, line: line)
        XCTAssertEqual(lock.reason, fixture.body["reason"] as? String ?? "", file: file, line: line)
        XCTAssertEqual(lock.overBy, (fixture.body["overBy"] as? NSNumber)?.intValue ?? -1, file: file, line: line)
        XCTAssertEqual(lock.unpaidWorkspaceIds, fixture.body["unpaidWorkspaceIds"] as? [String] ?? [], file: file, line: line)
        let message = GDStorageContract.lockMessage(reason: lock.reason)
        XCTAssertFalse(message.contains(reason), file: file, line: line)
        XCTAssertTrue(message.contains("Downloads stay available."), file: file, line: line)
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

        for name in ["verify-expired", "verify-host-mismatch", "verify-mismatch", "verify-used", "provider-unsupported"] {
            let fixture = try GDFixtureFile.load("byo", name)
            let code = GDServerCode.read(fixture.body)
            XCTAssertFalse(code.isEmpty, name)
            let message = GDStorageContract.byoMessage(code: code, status: fixture.status)
            XCTAssertNotNil(message, name)
            XCTAssertFalse(message?.contains(code) ?? true, name)
        }
    }

    func testVerifyMissingUrlSendsOnlyPresignedUrl() throws {
        let missing = try GDFixtureFile.load("byo", "verify-missing-url")
        XCTAssertEqual(missing.method, "POST")
        XCTAssertEqual(missing.status, 400)
        XCTAssertEqual(GDServerCode.read(missing.body), "presigned_url_required")
        let request = try XCTUnwrap(missing.requestBody as? [String: Any])
        XCTAssertTrue(request.isEmpty)
        let success = try GDFixtureFile.load("byo", "verify-success")
        let proof = GDFixtureFile.strings(success.requestBody)
        XCTAssertEqual(Set(proof.keys), Set(["presignedUrl"]))
        XCTAssertNil(proof["readBack"])
        XCTAssertNil(proof["proofUrl"])
        let sent = GDStorageContract.byoVerifyBody(presignedUrl: proof["presignedUrl"] ?? "")
        XCTAssertEqual(sent, proof)
        XCTAssertEqual(Array(sent.keys), ["presignedUrl"])
        XCTAssertNil(sent["readBack"])
        XCTAssertNil(sent["proofUrl"])
        let message = try XCTUnwrap(GDStorageContract.byoMessage(code: "presigned_url_required", status: missing.status))
        XCTAssertFalse(message.contains("presigned_url_required"))
        XCTAssertFalse(message.isEmpty)
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
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = try XCTUnwrap(formatter.date(from: "2023-11-14T22:20:00.000Z"))
        let workspace = "11111111-1111-4111-8111-000000000001"
        let upload = try GDFixtureFile.load("storage-urls", "put")
        let session = try GDStorageContract.parseSession(workspace: workspace, json: upload.body, now: now)
        XCTAssertEqual(session.mode, "write")
        XCTAssertEqual(session.urls.first?.method, String?("PUT"))
        XCTAssertEqual(session.urls.first?.object, String?("0123456789abcdef0123456789abcdef"))
        XCTAssertEqual(GDFixtureFile.strings(upload.requestBody)["op"], String?("put"))
        XCTAssertTrue(GDStorageContract.pathContainsWorkspace(upload.body["prefix"] as? String ?? "", workspace: workspace))
        XCTAssertFalse(GDStorageContract.pathContainsWorkspace("/customer/abc/managed/ws-10/objects/x", workspace: "ws-1"))

        let download = try GDFixtureFile.load("storage-urls", "get")
        let read = try GDStorageContract.parseSession(workspace: workspace, json: download.body, now: now)
        XCTAssertEqual(read.mode, "read")
        XCTAssertEqual(read.urls.first?.method, String?("GET"))
        let removing = try GDFixtureFile.load("storage-urls", "delete")
        let deleted = try GDStorageContract.parseSession(workspace: workspace, json: removing.body, now: now)
        XCTAssertEqual(deleted.mode, "delete")
        XCTAssertEqual(deleted.urls.first?.method, String?("DELETE"))

        let locked = try GDFixtureFile.load("storage-urls", "locked")
        guard case .reviewWorkspaces = GDStorageContract.routeLock(status: locked.status, json: locked.body) else {
            return XCTFail("a locked put opens the workspace lock")
        }
        XCTAssertEqual(GDStorageContract.byoMessage(code: "byo_external", status: 409), String?(GDStorageContract.byoExternalMessage))
        let plaintext: [String: Any] = ["filename": "super-secret-report.pdf", "encryptionKey": "not-a-real-key"]
        XCTAssertTrue(GDStorageContract.rejectsPlaintext(plaintext))
        XCTAssertFalse(GDStorageContract.isOpaqueID("../" + String(repeating: "a", count: 32)))
        XCTAssertNil(GDStorageContract.decimalGeneration(NSNumber(value: 0)))
        XCTAssertEqual(GDStorageContract.decimalGeneration("9223372036854775807"), String?("9223372036854775807"))
    }

    func testManifestObjectCarriesGenerationAndRejectsAnOlderVersion() throws {
        XCTAssertTrue(GDStorageContract.isOpaqueID("manifest"))
        XCTAssertFalse(GDStorageContract.isOpaqueID("library"))
        XCTAssertFalse(GDSealedManifest.usesResumableUploads)
        XCTAssertEqual(GDSealedManifest.objectID, "manifest")
        let upload = GDSealedManifest.uploadBody(generation: "178")
        XCTAssertEqual(upload["op"] as? String, String?("put"))
        XCTAssertEqual(upload["ifGeneration"] as? String, String?("178"))
        XCTAssertEqual(upload["objects"] as? [String] ?? [], ["manifest"])
        XCTAssertEqual(upload["ifGeneration"] as? String, String?("178"))
        XCTAssertEqual(GDSealedManifest.generation(objectStatus: 200, headers: ["x-goog-generation": "178"]), .value("178"))
        XCTAssertEqual(GDSealedManifest.generation(objectStatus: 404, headers: [:]), .absentObject)
        XCTAssertEqual(GDSealedManifest.generationValue(.absentObject), String?("0"))
        XCTAssertEqual(GDSealedManifest.generation(objectStatus: 200, headers: [:]), .missing)
        XCTAssertNil(GDSealedManifest.generationValue(.missing))
        XCTAssertEqual(GDSealedManifest.interpretUpload(status: 412, json: [:]), .retryMerge)
        XCTAssertEqual(GDSealedManifest.interpretUpload(status: 400, json: ["error": "manifest_generation_required"]), .clientBug)

        let file = GDManifestFile(id: "file-notes", name: "notes.txt", chunkCount: 1, totalSize: 4, chunks: [String(repeating: "ab", count: 16)])
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
        let fileID = "file-1"
        let ids = ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccccccccccccc"]
        let sealed = try parts.enumerated().map { index, part in
            try GDSealedManifest.sealChunk(plaintext: part, key: key, fileID: fileID, objectID: ids[index], index: UInt32(index), manifestVersion: 4, isFinal: index == parts.count - 1)
        }
        let opened = try GDSealedManifest.openFile(fileID: fileID, chunks: zip(ids, sealed).map { (objectID: $0.0, sealed: $0.1) }, key: key, manifestVersion: 4, totalSize: 10)
        XCTAssertEqual(opened, Data("aaaabbbbcc".utf8))
        XCTAssertThrowsError(try GDSealedManifest.openFile(fileID: fileID, chunks: [(objectID: ids[1], sealed: sealed[1]), (objectID: ids[0], sealed: sealed[0]), (objectID: ids[2], sealed: sealed[2])], key: key, manifestVersion: 4, totalSize: 10))
        XCTAssertThrowsError(try GDSealedManifest.openFile(fileID: fileID, chunks: [(objectID: ids[0], sealed: sealed[0]), (objectID: ids[2], sealed: sealed[2])], key: key, manifestVersion: 4, totalSize: 6))
        let earlyFinal = try GDSealedManifest.sealChunk(plaintext: parts[0], key: key, fileID: fileID, objectID: ids[0], index: 0, manifestVersion: 4, isFinal: true)
        XCTAssertThrowsError(try GDSealedManifest.openFile(fileID: fileID, chunks: [(objectID: ids[0], sealed: earlyFinal), (objectID: ids[1], sealed: sealed[1]), (objectID: ids[2], sealed: sealed[2])], key: key, manifestVersion: 4, totalSize: 10))
        let unfinished = try GDSealedManifest.sealChunk(plaintext: parts[2], key: key, fileID: fileID, objectID: ids[2], index: 2, manifestVersion: 4, isFinal: false)
        XCTAssertThrowsError(try GDSealedManifest.openFile(fileID: fileID, chunks: [(objectID: ids[0], sealed: sealed[0]), (objectID: ids[1], sealed: sealed[1]), (objectID: ids[2], sealed: unfinished)], key: key, manifestVersion: 4, totalSize: 10))
        XCTAssertThrowsError(try GDSealedManifest.openFile(fileID: fileID, chunks: zip(ids, sealed).map { (objectID: $0.0, sealed: $0.1) }, key: key, manifestVersion: 4, totalSize: 9))
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
