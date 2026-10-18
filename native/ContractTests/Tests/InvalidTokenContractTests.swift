import XCTest
@testable import GenDragoonContract

/// A Firebase-token 401 `{"error":"invalid_token"}` sends `signed_out`, clears only the session,
/// keeps the saved job, and keeps polling with `Bearer statusToken` until `done` wipes.
/// A status-token `invalid_token` sends `reauth_required`, stops the poll, keeps the job, and asks
/// for sign-in. Both signals share `GDDeletionAuthFailure`. `reauth_required` and a bare 401 still
/// ask for sign-in. None of them wipe.
///
/// Bodies are Riley's generated fixtures. Tokens and job ids are opaque, including `"<redacted>"`.
final class InvalidTokenContractTests: XCTestCase {
    private let area = "account-deletion"
    private let savedToken = String(repeating: "S", count: 42) + "1"

    private func savedJobId() throws -> String {
        let gone = try GDFixtureFile.load(area, "account-deleted")
        return try XCTUnwrap(gone.body["jobId"] as? String)
    }

    func testInvalidTokenFixtureIsTheGeneratedDelete401() throws {
        let fixture = try GDFixtureFile.load(area, "invalid-token")
        XCTAssertEqual(fixture.method, "DELETE")
        XCTAssertEqual(fixture.path, "/v2/account")
        XCTAssertEqual(GDFixtureFile.strings(fixture.requestBody)["confirm"], String?("DELETE"))
        XCTAssertEqual(fixture.status, 401)
        XCTAssertEqual(GDServerCode.read(fixture.body), "invalid_token")
        let start = GDAccountContract.interpretStart(status: fixture.status, json: fixture.body)
        XCTAssertNotEqual(start, .wipe)
        XCTAssertFalse(GDAccountContract.pollRecovery(for: start).wipe)
        XCTAssertFalse(GDAccountContract.pollRecovery(for: start).sendDelete)
    }

    func testInvalidTokenOnDeleteNeverWipesNorRetriesDelete() throws {
        let fixture = try GDFixtureFile.load(area, "invalid-token")
        let decision = GDAccountContract.unauthorizedDeletion(json: fixture.body, savedJobExists: false)
        XCTAssertFalse(decision.wipe)
        XCTAssertFalse(decision.retryDelete, "invalid_token is not fixed by a fresh sign-in, so DELETE is not queued again")
        XCTAssertFalse(decision.keepSavedJob, "nothing was saved, nothing is invented")
    }

    func testInvalidTokenWhilePollingKeepsTheSavedJobAndItIsPolledWithTheStatusToken() throws {
        let invalid = try GDFixtureFile.load(area, "invalid-token")
        let jobId = try savedJobId()
        let decision = GDAccountContract.unauthorizedDeletion(json: invalid.body, savedJobExists: true)
        XCTAssertFalse(decision.wipe)
        XCTAssertTrue(decision.keepSavedJob)
        XCTAssertFalse(decision.retryDelete)

        let poll = GDAccountContract.interpretPoll(status: invalid.status, json: invalid.body)
        let recovery = GDAccountContract.pollRecovery(for: poll)
        XCTAssertFalse(recovery.wipe)
        XCTAssertTrue(recovery.keepSavedJob)
        XCTAssertFalse(recovery.sendDelete)

        // After sign-out the kept job is still the thing that gets polled, never a new DELETE.
        guard case .pollSaved(let job) = GDAccountContract.deletionIntent(savedJobId: jobId, savedStatusToken: savedToken) else {
            return XCTFail("a job kept through invalid_token is polled, not re-sent as DELETE")
        }
        let request = GDAccountContract.pollRequest(jobId: job.jobId, statusToken: job.statusToken)
        let done = try GDFixtureFile.load(area, "status-done")
        XCTAssertEqual(request.method, done.method)
        XCTAssertEqual(request.path, done.path)
        XCTAssertEqual(request.authorization, "Bearer " + savedToken)
    }

    func testAfterInvalidTokenOnlyDoneWipes() throws {
        for name in ["status-queued", "status-running"] {
            let fixture = try GDFixtureFile.load(area, name)
            let decision = GDAccountContract.interpretPoll(status: fixture.status, json: fixture.body)
            XCTAssertFalse(GDAccountContract.pollRecovery(for: decision).wipe, name)
            XCTAssertTrue(GDAccountContract.pollRecovery(for: decision).keepSavedJob, name)
        }
        let expired = try GDFixtureFile.load(area, "expired-token")
        let missing = GDAccountContract.pollRecovery(for: GDAccountContract.interpretPoll(status: expired.status, json: expired.body))
        XCTAssertFalse(missing.wipe)
        XCTAssertTrue(missing.keepSavedJob)
        XCTAssertTrue(missing.showRetry)
        let done = try GDFixtureFile.load(area, "status-done")
        let decision = GDAccountContract.interpretPoll(status: done.status, json: done.body)
        XCTAssertEqual(decision, .wipe)
        XCTAssertTrue(GDAccountContract.pollRecovery(for: decision).wipe)
        XCTAssertFalse(GDAccountContract.pollRecovery(for: decision).keepSavedJob)
    }

    func testReauthRequiredFixtureStillGoesToSignInAndKeepsTheJob() throws {
        let reauth = try GDFixtureFile.load(area, "reauth-required")
        let decision = GDAccountContract.unauthorizedDeletion(json: reauth.body, savedJobExists: true)
        XCTAssertFalse(decision.wipe)
        XCTAssertTrue(decision.showSignIn)
        XCTAssertTrue(decision.keepSavedJob)
        XCTAssertTrue(GDAccountContract.unauthorizedMessage(json: reauth.body).contains("5 minutes"))
    }

    func testInvalidTokenSignsOutOnFirebaseAndStopsAStatusPoll() throws {
        let invalid = try GDFixtureFile.load(area, "invalid-token")
        let reauth = try GDFixtureFile.load(area, "reauth-required")
        let signOutCase = GDAccountContract.unauthorizedDeletion(json: invalid.body, savedJobExists: true)
        let bareCase = GDAccountContract.unauthorizedDeletion(json: [:], savedJobExists: true)
        let reauthCase = GDAccountContract.unauthorizedDeletion(json: reauth.body, savedJobExists: true)
        XCTAssertNotEqual(signOutCase, bareCase, "invalid_token must not be the bare-401 sign-in path")
        XCTAssertEqual(flag(signOutCase, "signOut"), true)
        XCTAssertEqual(flag(signOutCase, "keepPolling"), true)
        XCTAssertEqual(signOutCase.signal, .signedOut)
        XCTAssertEqual(signOutCase.signal?.signal, "signed_out")
        XCTAssertEqual(flag(signOutCase, "showSignIn"), false)
        XCTAssertNil(bareCase.signal)
        XCTAssertEqual(flag(bareCase, "signOut"), false)
        XCTAssertEqual(flag(bareCase, "showSignIn"), true)
        XCTAssertNil(reauthCase.signal)
        XCTAssertEqual(flag(reauthCase, "signOut"), false)
        XCTAssertEqual(flag(reauthCase, "showSignIn"), true)
        let polled = GDAccountContract.unauthorizedDeletion(json: invalid.body, savedJobExists: true, credential: .statusToken)
        XCTAssertEqual(flag(polled, "signOut"), false)
        XCTAssertEqual(flag(polled, "showSignIn"), true)
        XCTAssertEqual(flag(polled, "keepPolling"), false)
        XCTAssertEqual(polled.signal, .reauthRequired)
        XCTAssertEqual(polled.signal?.signal, "reauth_required")
        XCTAssertEqual(flag(polled, "retryDelete"), true)
        XCTAssertEqual(flag(polled, "wipe"), false)
    }

    private func flag(_ value: GDUnauthorizedDeletion, _ label: String) -> Bool? {
        Mirror(reflecting: value).children.first { $0.label == label }?.value as? Bool
    }
}
