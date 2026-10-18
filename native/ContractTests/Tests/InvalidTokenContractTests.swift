import XCTest
@testable import GenDragoonContract

/// Avery's ruling (Oct 17): a 401 `{"error":"invalid_token"}` from DELETE /v2/account or from the
/// status poll signs the user out. Sign-out clears only the session. The saved jobId and
/// statusToken stay in the Keychain, polling continues with `Bearer statusToken`, and the Mac is
/// wiped only on `done`. `reauth_required` and a 401 with no code go to sign-in. None of them wipe.
///
/// Server bodies are Riley's generated fixtures from PR #6 at d788ccb, copied verbatim to
/// `fixtures/account-deletion/` (same path as PR #6, so the merge is a no-op).
/// The saved job is client Keychain state, not a server body. Riley's export redacts tokens to
/// `"<redacted>"`, which `GDAccountContract.isStatusToken` (43 base64url chars) rejects, so the
/// saved token below is a well-formed client value. The jobId is the fixture's job ...0005.
///
/// `testBug…` wraps the ruling in `XCTExpectFailure`: it passes while `GDUnauthorizedDeletion`
/// has no sign-out / keep-polling signal and starts failing once it does. Drop the wrapper then.
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

    /// BUG(contract): today `unauthorizedDeletion` returns the same value for `invalid_token`,
    /// `reauth_required` and a bare 401 (GDAccountContract.swift `unauthorizedDeletion`), and the
    /// monitor sends all three to `requireFreshSignIn` and stops polling
    /// (GDAccountDeletion.swift:148-151, 200-209). Proposed fields: `signOut` (clear only the
    /// session) and `keepPolling` (continue with the saved status token). Rename here if the
    /// fix picks other names.
    func testBugInvalidTokenSignsOutAndKeepsPollingUnlikeABare401() throws {
        let invalid = try GDFixtureFile.load(area, "invalid-token")
        let reauth = try GDFixtureFile.load(area, "reauth-required")
        let signOutCase = GDAccountContract.unauthorizedDeletion(json: invalid.body, savedJobExists: true)
        let bareCase = GDAccountContract.unauthorizedDeletion(json: [:], savedJobExists: true)
        let reauthCase = GDAccountContract.unauthorizedDeletion(json: reauth.body, savedJobExists: true)
        XCTExpectFailure("BUG(contract): invalid_token is handled as a sign-in prompt and polling stops")
        XCTAssertNotEqual(signOutCase, bareCase, "invalid_token must not be the bare-401 sign-in path")
        XCTAssertEqual(flag(signOutCase, "signOut"), true)
        XCTAssertEqual(flag(signOutCase, "keepPolling"), true)
        XCTAssertEqual(flag(bareCase, "signOut"), false)
        XCTAssertEqual(flag(reauthCase, "signOut"), false)
    }

    private func flag(_ value: GDUnauthorizedDeletion, _ label: String) -> Bool? {
        Mirror(reflecting: value).children.first { $0.label == label }?.value as? Bool
    }
}
