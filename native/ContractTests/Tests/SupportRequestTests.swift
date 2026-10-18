import XCTest
@testable import GenDragoonContract

/// Support-request bodies are Riley's PR #6 fixtures. A missing-header 401 `unauthorized`
/// uses the same outcome as the 404 fixture (`support-unauthorized.json`, from PR #6 at 0486412).
final class SupportRequestTests: XCTestCase {
    func testReceivedAndRepeatShareTheRequestId() throws {
        let received = try GDFixtureFile.load("account-deletion", "support-received")
        let repeatRequest = try GDFixtureFile.load("account-deletion", "support-repeat")
        XCTAssertEqual(received.status, 202)
        XCTAssertEqual(repeatRequest.status, 202)
        XCTAssertEqual(received.path, repeatRequest.path)
        XCTAssertTrue(received.path.hasSuffix("/support-request"))
        let first = GDAccountContract.interpretSupportRequest(status: received.status, json: received.body)
        let second = GDAccountContract.interpretSupportRequest(status: repeatRequest.status, json: repeatRequest.body)
        guard case .received(let requestId) = first, case .received(let repeated) = second else {
            return XCTFail("a 202 received stays received")
        }
        XCTAssertEqual(requestId, repeated)
        XCTAssertEqual(requestId, received.body["requestId"] as? String)
        XCTAssertEqual(GDAccountContract.supportRequestMessage(first), "Request sent.")
        XCTAssertFalse(GDAccountContract.supportRequestShowsSignIn(first))
    }

    func testMissingAuthorizationMatchesTheNotFoundEmailFallback() throws {
        let missing = try GDFixtureFile.load("account-deletion", "support-bad-token")
        XCTAssertEqual(missing.status, 404)
        XCTAssertEqual(GDServerCode.read(missing.body), "not_found")
        let notFound = GDAccountContract.interpretSupportRequest(status: missing.status, json: missing.body)
        let published = try GDFixtureFile.load("account-deletion", "support-unauthorized")
        XCTAssertEqual(published.status, 401)
        XCTAssertEqual(GDServerCode.read(published.body), "unauthorized")
        let unauthorized = GDAccountContract.interpretSupportRequest(status: published.status, json: published.body)
        XCTAssertEqual(notFound, .emailFallback)
        XCTAssertEqual(unauthorized, .emailFallback)
        XCTAssertFalse(GDAccountContract.supportRequestShowsSignIn(unauthorized))
        XCTAssertFalse(GDAccountContract.supportRequestShowsSignIn(notFound))
        let message = GDAccountContract.supportRequestMessage(unauthorized)
        XCTAssertTrue(message.contains(GDSupportContact.current.value))
        XCTAssertTrue(message.contains("Sign-in was not opened."))
    }

    func testRateLimitAndNotNeededStayOffSignIn() throws {
        let limited = try GDFixtureFile.load("account-deletion", "support-rate-limited")
        let unneeded = try GDFixtureFile.load("account-deletion", "support-not-needed")
        let rate = GDAccountContract.interpretSupportRequest(status: limited.status, json: limited.body)
        XCTAssertEqual(rate, .rateLimited(retryAfterSec: 86400))
        XCTAssertEqual(GDAccountContract.interpretSupportRequest(status: unneeded.status, json: unneeded.body), .notNeeded)
        XCTAssertFalse(GDAccountContract.supportRequestShowsSignIn(rate))
        XCTAssertFalse(GDAccountContract.supportRequestShowsSignIn(.notNeeded))
    }
}
