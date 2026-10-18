// SKETCH, NOT COMPILED. Lives outside ContractTests/Tests, so `swift test` and the Mac
// client compile step ignore it. Move it into the test target once GDAccountDeletionMonitor
// takes an injectable transport (Avery's ask on PR #3). Names below are assumptions; match
// whatever the transport PR introduces.
//
// Assumed seams:
//   protocol GDDeletionTransport {
//       func send(method: String, path: String, authorization: String, body: [String: String]?) async throws -> (status: Int, json: [String: Any])
//   }
//   protocol GDDeletionJobStore { func load() -> GDSavedDeletionJob?; func save(_ job: GDSavedDeletionJob) throws; func delete() }
//   protocol GDDeletionSession: AnyObject {
//       var userID: String { get }; var firebaseIDToken: String { get }
//       func signedInWithin(seconds: TimeInterval) -> Bool
//       func signOut()                              // clears only the session
//       func requireFreshSignIn(message: String)    // bare 401 and reauth_required
//   }
//   GDAccountDeletionMonitor(transport:jobs:session:wipeLocal:sleep:)
//
// Ruling under test (Avery, Oct 17): 401 invalid_token -> signOut(), keep the saved job, keep
// polling with Bearer statusToken, wipe only on `done`. Bare 401 / reauth_required ->
// requireFreshSignIn, keep the job. None wipe.

import XCTest
@testable import GenDragoonContract

@MainActor
final class AccountDeletionMonitorInvalidTokenTests: XCTestCase {
    /// Replays Riley's d788ccb fixtures in order and records every request.
    final class FixtureTransport: GDDeletionTransport {
        struct Sent: Equatable { var method: String; var path: String; var authorization: String }
        var replies: [GDFixtureFile]
        var sent: [Sent] = []
        init(_ names: [String]) throws { replies = try names.map { try GDFixtureFile.load("account-deletion", $0) } }
        func send(method: String, path: String, authorization: String, body: [String: String]?) async throws -> (status: Int, json: [String: Any]) {
            sent.append(Sent(method: method, path: path, authorization: authorization))
            let next = replies.count > 1 ? replies.removeFirst() : replies[0]
            return (next.status, next.body)
        }
    }

    final class MemoryJobs: GDDeletionJobStore {
        var job: GDSavedDeletionJob?
        func load() -> GDSavedDeletionJob? { job }
        func save(_ job: GDSavedDeletionJob) throws { self.job = job }
        func delete() { job = nil }
    }

    final class FakeSession: GDDeletionSession {
        var userID = "uid-owner"
        var firebaseIDToken = "firebase-id-token"
        var fresh = true
        var signOuts = 0
        var signInPrompts: [String] = []
        func signedInWithin(seconds: TimeInterval) -> Bool { fresh }
        func signOut() { signOuts += 1; firebaseIDToken = ""; userID = "" }
        func requireFreshSignIn(message: String) { signInPrompts.append(message) }
    }

    private let token = String(repeating: "S", count: 42) + "1"   // client Keychain value
    private let job = "00000000-0000-4000-8000-000000000005"        // fixture job ...0005

    private func monitor(_ transport: FixtureTransport, _ jobs: MemoryJobs, _ session: FakeSession, wipes: @escaping () -> Void) -> GDAccountDeletionMonitor {
        GDAccountDeletionMonitor(transport: transport, jobs: jobs, session: session,
                                 wipeLocal: { wipes() }, sleep: { _ in })
    }

    func testPollInvalidTokenSignsOutKeepsJobKeepsPollingAndWipesOnlyOnDone() async throws {
        // Riley's server answers a bad poll bearer with 404, not 401, so invalid_token on the poll
        // comes from a proxy or a future change. The body is still the generated invalid-token one.
        let transport = try FixtureTransport(["invalid-token", "status-running", "status-done"])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let m = monitor(transport, jobs, session) { wiped += 1 }

        await m.resumeAndWait()                                  // assumed: runs the poll loop to completion

        XCTAssertEqual(session.signOuts, 1, "invalid_token signs out")
        XCTAssertTrue(session.signInPrompts.isEmpty, "invalid_token is not the sign-in prompt path")
        XCTAssertFalse(transport.sent.contains { $0.method == "DELETE" })
        XCTAssertEqual(transport.sent.count, 3, "polling continued after sign-out")
        for request in transport.sent {
            XCTAssertEqual(request.path, "/v2/account/deletions/" + job)
            XCTAssertEqual(request.authorization, "Bearer " + token)
        }
        XCTAssertEqual(wiped, 1, "wiped once, on done")
        XCTAssertNil(jobs.job, "job cleared after done")
    }

    func testPollInvalidTokenThenRunningDoesNotWipeAndKeepsTheJob() async throws {
        let transport = try FixtureTransport(["invalid-token", "status-running"])
        let jobs = MemoryJobs(); jobs.job = GDSavedDeletionJob(jobId: job, statusToken: token, ownerUID: "uid-owner")
        let session = FakeSession()
        var wiped = 0
        let m = monitor(transport, jobs, session) { wiped += 1 }
        await m.resumeAndWait(maxPolls: 3)
        XCTAssertEqual(session.signOuts, 1)
        XCTAssertEqual(wiped, 0)
        XCTAssertEqual(jobs.job?.jobId, job)
        XCTAssertEqual(jobs.job?.statusToken, token)
    }

    func testDeleteInvalidTokenSignsOutAndSavesNothing() async throws {
        let transport = try FixtureTransport(["invalid-token"])
        let jobs = MemoryJobs()
        let session = FakeSession()
        var wiped = 0
        let m = monitor(transport, jobs, session) { wiped += 1 }
        await m.begin(confirmation: "DELETE")
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
        let m = monitor(transport, jobs, session) { wiped += 1 }
        await m.resumeAndWait(maxPolls: 1)
        XCTAssertEqual(session.signOuts, 0)
        XCTAssertEqual(session.signInPrompts.count, 1)
        XCTAssertEqual(jobs.job?.jobId, job)
        XCTAssertEqual(wiped, 0)
    }
}
