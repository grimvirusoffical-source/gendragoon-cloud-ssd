import XCTest
@testable import GenDragoonContract

@MainActor
final class AccountDeletionMonitorInvalidTokenTests: XCTestCase {
    final class FixtureTransport: GDDeletionTransport {
        struct Sent: Equatable { var method: String; var path: String; var authorization: String; var body: [String: String]? }
        var replies: [GDFixtureFile]
        var sent: [Sent] = []
        init(_ names: [String]) throws { replies = try names.map { try GDFixtureFile.load("account-deletion", $0) } }
        func send(method: String, path: String, authorization: String, body: [String: String]?) async throws -> (status: Int, json: [String: Any]) {
            sent.append(Sent(method: method, path: path, authorization: authorization, body: body))
            let next = replies.count > 1 ? replies.removeFirst() : replies[0]
            return (next.status, next.body)
        }
    }

    final class ScriptTransport: GDDeletionTransport {
        struct Sent: Equatable { var method: String; var path: String; var authorization: String; var body: [String: String]? }
        var replies: [(status: Int, json: [String: Any])]
        var sent: [Sent] = []
        init(replies: [(status: Int, json: [String: Any])]) {
            self.replies = replies
        }
        func send(method: String, path: String, authorization: String, body: [String: String]?) async throws -> (status: Int, json: [String: Any]) {
            sent.append(Sent(method: method, path: path, authorization: authorization, body: body))
            let next = replies.count > 1 ? replies.removeFirst() : replies[0]
            return next
        }
    }

    final class MemoryJobs: GDDeletionJobStore {
        var job: GDSavedDeletionJob?
        func load() -> GDSavedDeletionJob? { job }
        func save(_ job: GDSavedDeletionJob) throws { self.job = job }
        func delete() { job = nil }
    }

    @MainActor final class FakeSession: GDDeletionSession {
        var userID = "uid-owner"
        var firebaseIDToken = "firebase-id-token"
        var authTimeSeconds: TimeInterval? = Date().timeIntervalSince1970
        var fresh = true
        var signOuts = 0
        var signInPrompts: [String] = []
        func signedInWithin(seconds: TimeInterval) -> Bool { fresh }
        func signOut() { signOuts += 1; firebaseIDToken = ""; userID = "" }
        func requireFreshSignIn(message: String) { signInPrompts.append(message) }
    }

    private let token = String(repeating: "S", count: 42) + "1"
    private let job = "00000000-0000-4000-8000-000000000005"

    private func monitor(_ transport: GDDeletionTransport, _ jobs: MemoryJobs, _ session: FakeSession, wipes: @escaping () -> Void) -> GDAccountDeletionMonitor {
        GDAccountDeletionMonitor(transport: transport, jobs: jobs, session: session,
                                 wipeLocal: { wipes() }, sleep: { (_: UInt64) async in })
    }

    func testPollInvalidTokenStopsAsksForSignInAndWipesOnlyAfterAFreshTokenReachesDone() async throws {
        let fresh = String(repeating: "n", count: 43)
        let transport = ScriptTransport(replies: [
            (401, ["error": "invalid_token"]),
            (410, ["error": "account_deleted", "jobId": job, "statusToken": fresh]),
            (200, ["jobId": job, "status": "done", "retryable": false]),
        ])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        let signals = SignalBox()
        deletion.onAuthFailure = { signals.values.append($0) }

        await deletion.resumeAndWait(maxPolls: 1)
        XCTAssertEqual(signals.values, [.reauthRequired])
        XCTAssertEqual(signals.values.map(\.signal), ["reauth_required"])
        XCTAssertEqual(session.signOuts, 0)
        XCTAssertEqual(session.signInPrompts.count, 1)
        XCTAssertEqual(transport.sent.map(\.method), ["GET"])
        XCTAssertEqual(wiped, 0)
        XCTAssertEqual(jobs.job?.statusToken, token)

        session.fresh = true
        await deletion.retrySavedDeletion()
        XCTAssertEqual(transport.sent.map(\.method), ["GET", "DELETE", "GET"])
        XCTAssertEqual(transport.sent[1].authorization, "Bearer firebase-id-token")
        XCTAssertEqual(transport.sent[2].authorization, "Bearer " + fresh)
        XCTAssertEqual(wiped, 1)
        XCTAssertNil(jobs.job)
    }

    func testStatusInvalidTokenFixtureStopsPollingAndKeepsTheJob() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "status-invalid-token")
        let transport = ScriptTransport(replies: [(fixture.status, fixture.body)])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        let signals = SignalBox()
        deletion.onAuthFailure = { signals.values.append($0) }
        await deletion.resumeAndWait(maxPolls: 3)
        XCTAssertEqual(signals.values, [.reauthRequired])
        XCTAssertEqual(transport.sent.count, 1)
        XCTAssertEqual(session.signOuts, 0)
        XCTAssertEqual(session.signInPrompts.count, 1)
        XCTAssertEqual(wiped, 0)
        XCTAssertEqual(jobs.job?.jobId, job)
        XCTAssertEqual(jobs.job?.statusToken, token)
    }

    func testDeleteInvalidTokenSignsOutAndSavesNothing() async throws {
        let transport = try FixtureTransport(["invalid-token"])
        let jobs = MemoryJobs()
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        let signals = SignalBox()
        deletion.onAuthFailure = { signals.values.append($0) }
        await deletion.begin(confirmation: "DELETE")
        XCTAssertEqual(signals.values, [.signedOut])
        XCTAssertEqual(transport.sent.map(\.method), ["DELETE"])
        XCTAssertEqual(transport.sent.first?.authorization, "Bearer firebase-id-token")
        XCTAssertEqual(session.signOuts, 1)
        XCTAssertTrue(session.signInPrompts.isEmpty)
        XCTAssertNil(jobs.job)
        XCTAssertEqual(wiped, 0)
    }

    func testReauthRequiredPromptsSignInKeepsJobAndDoesNotSignOut() async throws {
        let transport = try FixtureTransport(["reauth-required"])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        await deletion.resumeAndWait(maxPolls: 1)
        XCTAssertEqual(session.signOuts, 0)
        XCTAssertEqual(session.signInPrompts.count, 1)
        XCTAssertEqual(jobs.job?.jobId, job)
        XCTAssertEqual(wiped, 0)
    }

    func testSupportRequestUnauthorizedShowsTheEmailAndNeverOpensSignIn() async throws {
        let notFound = try GDFixtureFile.load("account-deletion", "support-bad-token")
        let transport = ScriptTransport(replies: [(401, ["error": "unauthorized"])])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        let signals = SignalBox()
        deletion.onAuthFailure = { signals.values.append($0) }
        await deletion.requestSupport()
        XCTAssertEqual(transport.sent.map(\.method), ["POST"])
        XCTAssertEqual(transport.sent.first?.path, GDAccountContract.supportRequestPath(jobId: job))
        XCTAssertEqual(transport.sent.first?.authorization, "Bearer " + token)
        XCTAssertNil(transport.sent.first?.body)
        XCTAssertTrue(session.signInPrompts.isEmpty)
        XCTAssertEqual(session.signOuts, 0)
        XCTAssertTrue(signals.values.isEmpty)
        XCTAssertEqual(wiped, 0)
        XCTAssertEqual(jobs.job?.jobId, job)
        XCTAssertEqual(deletion.statusText, GDAccountContract.supportRequestMessage(.emailFallback))
        XCTAssertEqual(
            GDAccountContract.interpretSupportRequest(status: 401, json: ["error": "unauthorized"]),
            GDAccountContract.interpretSupportRequest(status: notFound.status, json: notFound.body))
    }

    func testStatusUnauthorizedFixtureStopsAndAsksForSignIn() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "status-unauthorized")
        XCTAssertEqual(fixture.status, 401)
        XCTAssertEqual(GDServerCode.read(fixture.body), "unauthorized")
        let transport = ScriptTransport(replies: [(fixture.status, fixture.body)])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        let signals = SignalBox()
        deletion.onAuthFailure = { signals.values.append($0) }
        await deletion.resumeAndWait(maxPolls: 3)
        XCTAssertEqual(signals.values, [.reauthRequired])
        XCTAssertEqual(signals.values.map(\.signal), ["reauth_required"])
        XCTAssertEqual(transport.sent.count, 1)
        XCTAssertEqual(session.signOuts, 0)
        XCTAssertEqual(session.signInPrompts.count, 1)
        XCTAssertEqual(wiped, 0)
        XCTAssertEqual(jobs.job?.jobId, job)
    }

    func testExpiredStatusTokenKeepsTheJobAndRetrySwapsThe410Token() async throws {
        let fresh = String(repeating: "t", count: 43)
        let expired = try GDFixtureFile.load("account-deletion", "expired-token")
        let transport = ScriptTransport(replies: [
            (expired.status, expired.body),
            (410, ["error": "account_deleted", "jobId": job, "statusToken": fresh]),
            (200, ["jobId": job, "status": "queued", "retryable": true]),
        ])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession(); session.fresh = false
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        await deletion.resumeAndWait(maxPolls: 1)
        XCTAssertTrue(deletion.offersPollRetry)
        XCTAssertEqual(jobs.job?.statusToken, token)
        XCTAssertEqual(wiped, 0)
        await deletion.retryStatus()
        XCTAssertEqual(session.signInPrompts.count, 1)
        XCTAssertEqual(transport.sent.map(\.method), ["GET"])
        session.fresh = true
        await deletion.retrySavedDeletion()
        XCTAssertEqual(transport.sent.map(\.method), ["GET", "DELETE", "GET"])
        XCTAssertEqual(jobs.job?.statusToken, fresh)
        XCTAssertEqual(transport.sent[2].authorization, "Bearer " + fresh)
        XCTAssertEqual(wiped, 0)
    }

    func testRedactedTokenIsPolledAndNeverResent() async throws {
        let transport = try FixtureTransport(["status-running"])
        let jobs = MemoryJobs()
        jobs.job = GDSavedDeletionJob(jobId: job, statusToken: "<redacted>", ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        await deletion.resumeAndWait(maxPolls: 1)
        XCTAssertEqual(transport.sent.map(\.method), ["GET"])
        XCTAssertEqual(transport.sent.first?.authorization, "Bearer <redacted>")
        XCTAssertEqual(wiped, 0)
        XCTAssertEqual(jobs.job?.statusToken, "<redacted>")
    }

    func testMissingTokenFromAcceptedDeleteOffersRetryAndDoesNotResend() async throws {
        let transport = ScriptTransport(replies: [
            (202, ["jobId": job, "status": "deleting"]),
        ])
        let jobs = MemoryJobs()
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        await deletion.begin(confirmation: "DELETE")
        await deletion.begin(confirmation: "DELETE")
        await deletion.retryStatus()
        XCTAssertEqual(transport.sent.map(\.method), ["DELETE"])
        XCTAssertNil(jobs.job)
        XCTAssertEqual(wiped, 0)
        XCTAssertTrue(deletion.offersPollRetry)
    }

    func testRetryableFailureSwapsTheNewTokenFromThe202() async throws {
        let failedJob = "00000000-0000-4000-8000-000000000004"
        let failed = try GDFixtureFile.load("account-deletion", "status-failed")
        let retry = try GDFixtureFile.load("account-deletion", "retry-after-failed")
        let transport = ScriptTransport(replies: [
            (failed.status, failed.body),
            (retry.status, retry.body),
            (200, ["jobId": failedJob, "status": "running", "retryable": true]),
        ])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: failedJob, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        await deletion.resumeAndWait(maxPolls: 1)
        XCTAssertTrue(deletion.offersPollRetry)
        XCTAssertFalse(deletion.offersJobDismiss)
        XCTAssertEqual(wiped, 0)
        await deletion.retryStatus()
        XCTAssertEqual(transport.sent.map(\.method), ["GET", "DELETE", "GET"])
        XCTAssertEqual(transport.sent[1].body, ["confirm": "DELETE"] as [String: String]?)
        XCTAssertEqual(jobs.job?.jobId, failedJob)
        XCTAssertEqual(jobs.job?.statusToken, "<redacted>")
        XCTAssertEqual(transport.sent[2].authorization, "Bearer <redacted>")
        XCTAssertEqual(wiped, 0)
    }

    func testNotRetryableDeleteShowsSupportAndDismissKeepsTheJobUntilDismiss() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "retry-not-retryable")
        let transport = ScriptTransport(replies: [(fixture.status, fixture.body)])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        deletion.offersPollRetry = true
        await deletion.retrySavedDeletion()
        XCTAssertEqual(transport.sent.map(\.method), ["DELETE"])
        XCTAssertEqual(deletion.notRetryable, GDDeletionNotRetryable(jobId: "00000000-0000-4000-8000-000000000009"))
        XCTAssertTrue(deletion.statusText.contains("support"))
        XCTAssertTrue(deletion.showsSupportContact)
        XCTAssertEqual(GDSupportContact.current.value.isEmpty, false)
        XCTAssertTrue(deletion.offersJobDismiss)
        XCTAssertFalse(deletion.offersPollRetry)
        XCTAssertEqual(jobs.job?.jobId, job, "the saved job stays; the 409 job id is only on the error")
        XCTAssertEqual(wiped, 0)
        deletion.dismissSavedJob()
        XCTAssertNil(jobs.job)
        XCTAssertNil(deletion.notRetryable)
        XCTAssertFalse(deletion.showsSupportContact)
        XCTAssertEqual(wiped, 0)
    }

    func testFirebaseInvalidTokenSignsOutKeepsTheJobAndPollsUntilDone() async throws {
        let invalid = try GDFixtureFile.load("account-deletion", "invalid-token")
        let done = try GDFixtureFile.load("account-deletion", "status-done")
        let transport = ScriptTransport(replies: [
            (invalid.status, invalid.body),
            (done.status, done.body),
        ])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        let signals = SignalBox()
        deletion.onAuthFailure = { signals.values.append($0) }
        await deletion.retrySavedDeletion()
        XCTAssertEqual(signals.values, [.signedOut])
        XCTAssertEqual(signals.values.map(\.signal), ["signed_out"])
        XCTAssertEqual(transport.sent.map(\.method), ["DELETE", "GET"])
        XCTAssertEqual(transport.sent[0].authorization, "Bearer firebase-id-token")
        XCTAssertEqual(transport.sent[1].authorization, "Bearer " + token)
        XCTAssertEqual(session.signOuts, 1)
        XCTAssertTrue(session.signInPrompts.isEmpty)
        XCTAssertEqual(wiped, 1)
        XCTAssertNil(jobs.job)
    }

    func testBareStatus401SignalsReauthRequiredAndDoesNotWipe() async throws {
        let transport = ScriptTransport(replies: [(401, [:])])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        let signals = SignalBox()
        deletion.onAuthFailure = { signals.values.append($0) }
        await deletion.resumeAndWait(maxPolls: 3)
        XCTAssertEqual(signals.values, [.reauthRequired])
        XCTAssertEqual(transport.sent.count, 1)
        XCTAssertEqual(session.signOuts, 0)
        XCTAssertEqual(session.signInPrompts.count, 1)
        XCTAssertEqual(wiped, 0)
        XCTAssertEqual(jobs.job?.jobId, job)
        XCTAssertEqual(jobs.job?.statusToken, token)
    }

    func testNonRetryableFailureOffersDismissAndClearsTheJobOnlyThen() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "status-failed-not-retryable")
        XCTAssertEqual(Set(fixture.body.keys), Set(["jobId", "retryable", "status"]))
        let failedJob = try XCTUnwrap(fixture.body["jobId"] as? String)
        let transport = ScriptTransport(replies: [(fixture.status, fixture.body)])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: failedJob, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let deletion = monitor(transport, jobs, session) { wiped += 1 }
        await deletion.resumeAndWait(maxPolls: 1)
        XCTAssertFalse(deletion.offersPollRetry)
        XCTAssertTrue(deletion.offersJobDismiss)
        XCTAssertTrue(deletion.showsSupportContact)
        XCTAssertNil(deletion.notRetryable)
        XCTAssertEqual(jobs.job?.jobId, failedJob)
        XCTAssertTrue(deletion.statusText.contains("support"))
        XCTAssertEqual(wiped, 0)
        deletion.dismissSavedJob()
        XCTAssertNil(jobs.job)
        XCTAssertFalse(deletion.showsSupportContact)
        XCTAssertEqual(wiped, 0)
        XCTAssertFalse(deletion.offersJobDismiss)
    }
}

private final class SignalBox {
    var values: [GDDeletionAuthFailure] = []
}
