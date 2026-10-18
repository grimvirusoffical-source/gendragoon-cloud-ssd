import XCTest
@testable import GenDragoonContract

/// Support-gap cases driven through the real `GDAccountDeletionMonitor.requestSupport()`.
/// Every failure shows the fallback support email. None opens sign-in, signs out,
/// clears the saved job, wipes local data, or throws.
@MainActor
final class SupportRequestMonitorTests: XCTestCase {
    struct SupportFailure: Error {}

    final class RecordingTransport: GDDeletionTransport {
        struct Sent: Equatable { var method: String; var path: String; var authorization: String }
        /// One entry per request in order. `nil` throws, as a network failure does.
        var replies: [(status: Int, json: [String: Any])?]
        var sent: [Sent] = []
        init(_ replies: [(status: Int, json: [String: Any])?]) { self.replies = replies }
        convenience init(_ reply: (status: Int, json: [String: Any])?) { self.init([reply]) }
        func send(method: String, path: String, authorization: String, body: [String: String]?) async throws -> (status: Int, json: [String: Any]) {
            sent.append(Sent(method: method, path: path, authorization: authorization))
            guard !replies.isEmpty, let reply = replies.removeFirst() else { throw SupportFailure() }
            return reply
        }
    }

    final class Jobs: GDDeletionJobStore {
        var job: GDSavedDeletionJob?
        var deletes = 0
        func load() -> GDSavedDeletionJob? { job }
        func save(_ job: GDSavedDeletionJob) throws { self.job = job }
        func delete() { deletes += 1; job = nil }
    }

    @MainActor final class Session: GDDeletionSession {
        var userID = "uid-owner"
        var firebaseIDToken = "firebase-id-token"
        var signOuts = 0
        var signInPrompts: [String] = []
        func signedInWithin(seconds: TimeInterval) -> Bool { true }
        func signOut() { signOuts += 1 }
        func requireFreshSignIn(message: String) { signInPrompts.append(message) }
    }

    private let jobId = "00000000-0000-4000-8000-00000000000a"
    private let statusToken = String(repeating: "S", count: 42) + "1"

    private var supportPath: String { GDAccountContract.supportRequestPath(jobId: jobId) }
    private var statusPath: String { GDAccountContract.statusPrefix + jobId }
    private var bearer: String { "Bearer " + statusToken }

    /// Runs one support request and checks what must hold for every outcome:
    /// no sign-in, no sign-out, no auth-failure signal, no wipe, and the saved job untouched.
    @discardableResult
    private func check(_ replies: [(status: Int, json: [String: Any])?],
                       saved: GDSavedDeletionJob?, requestJobId: String? = nil,
                       expect: GDSupportRequestResult = .emailFallback,
                       file: StaticString = #filePath, line: UInt = #line) async -> RecordingTransport {
        let transport = RecordingTransport(replies)
        let jobs = Jobs()
        jobs.job = saved
        let session = Session()
        var wiped = 0
        var authFailures = 0
        let monitor = GDAccountDeletionMonitor(transport: transport, jobs: jobs, session: session,
                                               wipeLocal: { wiped += 1 }, sleep: { (_: UInt64) async in })
        monitor.onAuthFailure = { _ in authFailures += 1 }
        let result = await monitor.requestSupport(jobId: requestJobId ?? saved?.jobId ?? "")
        XCTAssertEqual(result, expect, file: file, line: line)
        XCTAssertEqual(monitor.statusText, GDAccountContract.supportRequestMessage(expect), file: file, line: line)
        if expect == .emailFallback {
            XCTAssertTrue(monitor.statusText.contains(GDSupportContact.current.value), file: file, line: line)
            XCTAssertTrue(monitor.statusText.contains("Sign-in was not opened."), file: file, line: line)
        }
        XCTAssertEqual(session.signInPrompts, [], "no sign-in", file: file, line: line)
        XCTAssertEqual(session.signOuts, 0, "no clearSession", file: file, line: line)
        XCTAssertEqual(authFailures, 0, file: file, line: line)
        XCTAssertEqual(jobs.deletes, 0, file: file, line: line)
        XCTAssertEqual(jobs.job, saved, "the saved job is never touched", file: file, line: line)
        XCTAssertEqual(wiped, 0, file: file, line: line)
        XCTAssertFalse(monitor.isPolling, file: file, line: line)
        XCTAssertFalse(transport.sent.contains(where: { $0.authorization.trimmingCharacters(in: .whitespaces) == "Bearer" }),
                       "never an empty Bearer header", file: file, line: line)
        return transport
    }

    private var savedJob: GDSavedDeletionJob { GDSavedDeletionJob(jobId: jobId, statusToken: statusToken, ownerUID: "uid-owner") }
    private var post: RecordingTransport.Sent { .init(method: "POST", path: supportPath, authorization: bearer) }
    private var refresh: RecordingTransport.Sent { .init(method: "GET", path: statusPath, authorization: bearer) }

    private func run(_ reply: (status: Int, json: [String: Any])?, file: StaticString = #filePath, line: UInt = #line) async {
        let transport = await check([reply], saved: savedJob, file: file, line: line)
        XCTAssertEqual(transport.sent, [post], file: file, line: line)
    }

    func testUnauthorizedWithAHeaderShowsTheFallback() async throws {
        await run((401, ["error": "unauthorized"]))
    }

    func testUnauthorizedWithoutAHeaderMatchesThePublishedFixture() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "support-unauthorized")
        XCTAssertEqual(fixture.method, "POST")
        XCTAssertEqual(fixture.status, 401)
        XCTAssertEqual(GDServerCode.read(fixture.body), "unauthorized")
        XCTAssertTrue(fixture.path.hasSuffix("/support-request"))
        XCTAssertEqual(GDAccountContract.interpretSupportRequest(status: fixture.status, json: fixture.body), .emailFallback)
        await run((fixture.status, fixture.body))
    }

    func testNotFoundShowsTheFallback() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "support-bad-token")
        await run((fixture.status, fixture.body))
    }

    func testNetworkErrorShowsTheFallbackWithoutThrowing() async throws {
        await run(nil)
    }

    func testServerErrorShowsTheFallback() async throws {
        for status in [500, 502, 503] {
            await run((status, ["error": "internal"]))
        }
    }

    func testMissingSavedJobSendsNothingAndShowsTheFallback() async throws {
        let transport = await check([(202, ["status": "received", "requestId": "never"])], saved: nil, requestJobId: jobId)
        XCTAssertEqual(transport.sent.count, 0)
    }

    func testEmptyStatusTokenSendsNothingAndShowsTheFallback() async throws {
        for token in ["", "   ", "\n"] {
            let saved = GDSavedDeletionJob(jobId: jobId, statusToken: token, ownerUID: "uid-owner")
            let transport = await check([(202, ["status": "received", "requestId": "never"])], saved: saved)
            XCTAssertEqual(transport.sent.count, 0)
        }
    }

    func testEmptyJobIdSendsNothingAndShowsTheFallback() async throws {
        let transport = await check([(202, ["status": "received", "requestId": "never"])], saved: savedJob, requestJobId: "")
        XCTAssertEqual(transport.sent.count, 0)
        let blankSaved = GDSavedDeletionJob(jobId: "", statusToken: statusToken, ownerUID: "uid-owner")
        let second = await check([(202, ["status": "received", "requestId": "never"])], saved: blankSaved, requestJobId: "")
        XCTAssertEqual(second.sent.count, 0)
    }

    func testJobIdMismatchSendsNothingAndKeepsTheSavedJob() async throws {
        let transport = await check([(202, ["status": "received", "requestId": "never"])], saved: savedJob,
                                    requestJobId: "00000000-0000-4000-8000-000000000009")
        XCTAssertEqual(transport.sent.count, 0)
    }

    func testReceivedStillSendsExactlyOnePost() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "support-received")
        let requestId = fixture.body["requestId"] as? String ?? ""
        let transport = await check([(fixture.status, fixture.body)], saved: savedJob, expect: .received(requestId: requestId))
        XCTAssertEqual(transport.sent, [post])
    }

    func testNotNeededConflictIsNotNeededWithoutARefresh() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "support-not-needed")
        let transport = await check([(fixture.status, fixture.body)], saved: savedJob, expect: .notNeeded)
        XCTAssertEqual(transport.sent, [post])
        let short = await check([(409, ["error": "not_needed"])], saved: savedJob, expect: .notNeeded)
        XCTAssertEqual(short.sent, [post])
    }

    func testOtherConflictThenFailedRefreshShowsTheFallback() async throws {
        let failures: [(status: Int, json: [String: Any])?] = [
            nil,
            (401, ["error": "invalid_token"]),
            (404, ["error": "not_found"]),
            (500, ["error": "internal"]),
            (200, ["jobId": jobId, "status": "failed", "retryable": false]),
            (200, ["jobId": "00000000-0000-4000-8000-000000000009", "status": "done"]),
            (200, [:]),
        ]
        for refreshReply in failures {
            let transport = await check([(409, ["error": "deletion_not_retryable", "jobId": jobId]), refreshReply],
                                        saved: savedJob)
            XCTAssertEqual(transport.sent, [post, refresh], "exactly one refresh")
        }
    }

    func testOtherConflictThenRefreshShowingNoSupportNeededIsNotNeeded() async throws {
        for state in ["queued", "running", "done"] {
            let transport = await check([(409, ["error": "conflict"]), (200, ["jobId": jobId, "status": state, "retryable": true])],
                                        saved: savedJob, expect: .notNeeded)
            XCTAssertEqual(transport.sent, [post, refresh])
        }
    }

    func testOtherClientErrorsShowTheFallback() async throws {
        for (status, code) in [(400, "bad_request"), (403, "forbidden"), (410, "gone"), (422, "invalid")] {
            await run((status, ["error": code]))
        }
    }

}
