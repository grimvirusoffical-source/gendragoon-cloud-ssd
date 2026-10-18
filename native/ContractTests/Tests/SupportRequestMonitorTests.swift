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
        var reply: (status: Int, json: [String: Any])?
        var sent: [Sent] = []
        init(_ reply: (status: Int, json: [String: Any])?) { self.reply = reply }
        func send(method: String, path: String, authorization: String, body: [String: String]?) async throws -> (status: Int, json: [String: Any]) {
            sent.append(Sent(method: method, path: path, authorization: authorization))
            guard let reply else { throw SupportFailure() }
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

    private func run(_ reply: (status: Int, json: [String: Any])?, savedJob: Bool = true,
                     file: StaticString = #filePath, line: UInt = #line) async -> RecordingTransport {
        let transport = RecordingTransport(reply)
        let jobs = Jobs()
        let saved = GDSavedDeletionJob(jobId: jobId, statusToken: statusToken, ownerUID: "uid-owner")
        if savedJob { jobs.job = saved }
        let session = Session()
        var wiped = 0
        var authFailures = 0
        let monitor = GDAccountDeletionMonitor(transport: transport, jobs: jobs, session: session,
                                               wipeLocal: { wiped += 1 }, sleep: { (_: UInt64) async in })
        monitor.onAuthFailure = { _ in authFailures += 1 }
        await monitor.requestSupport()
        XCTAssertEqual(monitor.statusText, GDAccountContract.supportRequestMessage(.emailFallback), file: file, line: line)
        XCTAssertTrue(monitor.statusText.contains(GDSupportContact.current.value), file: file, line: line)
        XCTAssertTrue(monitor.statusText.contains("Sign-in was not opened."), file: file, line: line)
        XCTAssertEqual(session.signInPrompts, [], "no sign-in", file: file, line: line)
        XCTAssertEqual(session.signOuts, 0, "no clearSession", file: file, line: line)
        XCTAssertEqual(authFailures, 0, file: file, line: line)
        XCTAssertEqual(jobs.deletes, 0, file: file, line: line)
        XCTAssertEqual(jobs.job, savedJob ? saved : nil, file: file, line: line)
        XCTAssertEqual(wiped, 0, file: file, line: line)
        XCTAssertFalse(monitor.isPolling, file: file, line: line)
        if savedJob {
            XCTAssertEqual(transport.sent, [RecordingTransport.Sent(
                method: "POST", path: GDAccountContract.supportRequestPath(jobId: jobId),
                authorization: "Bearer " + statusToken)], file: file, line: line)
        }
        return transport
    }

    func testUnauthorizedWithAHeaderShowsTheFallback() async throws {
        _ = await run((401, ["error": "unauthorized"]))
    }

    func testUnauthorizedWithoutAHeaderMatchesThePublishedFixture() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "support-unauthorized")
        XCTAssertEqual(fixture.method, "POST")
        XCTAssertEqual(fixture.status, 401)
        XCTAssertEqual(GDServerCode.read(fixture.body), "unauthorized")
        XCTAssertTrue(fixture.path.hasSuffix("/support-request"))
        XCTAssertEqual(GDAccountContract.interpretSupportRequest(status: fixture.status, json: fixture.body), .emailFallback)
        _ = await run((fixture.status, fixture.body))
    }

    func testNotFoundShowsTheFallback() async throws {
        let fixture = try GDFixtureFile.load("account-deletion", "support-bad-token")
        _ = await run((fixture.status, fixture.body))
    }

    func testNetworkErrorShowsTheFallbackWithoutThrowing() async throws {
        _ = await run(nil)
    }

    func testServerErrorShowsTheFallback() async throws {
        for status in [500, 502, 503] {
            _ = await run((status, ["error": "internal"]))
        }
    }

    func testMissingSavedTokenSendsNothingAndShowsTheFallback() async throws {
        let transport = await run((202, ["status": "received", "requestId": "never"]), savedJob: false)
        XCTAssertEqual(transport.sent.count, 0)
    }

    func testOtherClientErrorsShowTheFallback() async throws {
        for (status, code) in [(400, "bad_request"), (403, "forbidden"), (410, "gone"), (422, "invalid")] {
            _ = await run((status, ["error": code]))
        }
    }

    func testConflictOtherThanNotNeededShowsTheFallback() async throws {
        _ = await run((409, ["error": "deletion_not_retryable", "jobId": jobId]))
    }
}
