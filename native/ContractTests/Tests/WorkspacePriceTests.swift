import XCTest
@testable import GenDragoonContract

/// Pricing cases are pinned to Riley's PR #5 fixtures at 0715b1a.
final class WorkspacePriceTests: XCTestCase {
    func testLabelOrderIsFreeThenIncludedThenFormattedCents() throws {
        let listed = try GDFixtureFile.load("workspaces", "grandfathered-plus-new")
        let rows = try XCTUnwrap(listed.body["workspaces"] as? [[String: Any]])
        let included = try XCTUnwrap(rows.first { ($0["grandfathered"] as? Bool) == true })
        let free = try XCTUnwrap(rows.first { ($0["isFree"] as? Bool) == true })
        XCTAssertEqual(included["feeWaived"] as? Bool, false)
        XCTAssertEqual(free["feeWaived"] as? Bool, false)
        XCTAssertEqual(GDWorkspacePriceLabel.label(isFree: false, grandfathered: true, feeWaived: false, monthlyPriceCents: GDWorkspacePriceLabel.cents(included["monthlyPriceCents"])), "Included")
        XCTAssertEqual(GDWorkspacePriceLabel.label(isFree: true, grandfathered: false, feeWaived: false, monthlyPriceCents: GDWorkspacePriceLabel.cents(free["monthlyPriceCents"])), "Free")
        let cents = try XCTUnwrap(GDWorkspacePriceLabel.cents((listed.body["policy"] as? [String: Any])?["workspaceMonthlyCents"]))
        XCTAssertEqual(GDWorkspacePriceLabel.label(isFree: true, grandfathered: true, feeWaived: true, monthlyPriceCents: cents), "Free")
        XCTAssertEqual(GDWorkspacePriceLabel.label(isFree: false, grandfathered: false, feeWaived: true, monthlyPriceCents: cents), "Included")
        XCTAssertEqual(GDWorkspacePriceLabel.label(isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: cents), GDWorkspacePriceLabel.format(cents))
        XCTAssertEqual(GDWorkspacePriceLabel.label(isFree: false, grandfathered: false, feeWaived: false, monthlyPriceCents: nil), "Price pending")
        XCTAssertEqual(GDWorkspacePriceLabel.format(499), "$4.99/month")
        XCTAssertTrue(GDWorkspacePriceLabel.isZeroPrice(isFree: false, grandfathered: true, feeWaived: false))
        XCTAssertTrue(GDWorkspacePriceLabel.isZeroPrice(isFree: false, grandfathered: false, feeWaived: true))
        XCTAssertFalse(GDWorkspacePriceLabel.isZeroPrice(isFree: false, grandfathered: false, feeWaived: false))
    }

    func testFeeWaivedIsRequiredAndAnOwnerBenefitIsIncluded() throws {
        let created = try GDFixtureFile.load("workspaces", "owner-fee-waived")
        XCTAssertEqual(created.body["feeWaived"] as? Bool, true)
        XCTAssertEqual(created.body["isFree"] as? Bool, false)
        XCTAssertEqual(GDWorkspacePriceLabel.cents(created.body["monthlyPriceCents"]), 0)
        let project = try XCTUnwrap(created.body["project"] as? [String: Any])
        let decoded = try JSONDecoder().decode(GDWorkspaceChoice.self, from: JSONSerialization.data(withJSONObject: project))
        XCTAssertTrue(decoded.feeWaived)
        XCTAssertEqual(decoded.priceLabel, "Included")
        XCTAssertTrue(GDWorkspacePriceLabel.isZeroPrice(isFree: decoded.isFree == true, grandfathered: decoded.grandfathered == true, feeWaived: decoded.feeWaived))
        var missing = project
        missing.removeValue(forKey: "feeWaived")
        XCTAssertThrowsError(try JSONDecoder().decode(GDWorkspaceChoice.self, from: JSONSerialization.data(withJSONObject: missing)))
    }

    func testGrandfatheredBYOConfirmationUsesTheRegisterResponse() throws {
        let listed = try GDFixtureFile.load("workspaces", "grandfathered-plus-new")
        let rows = try XCTUnwrap(listed.body["workspaces"] as? [[String: Any]])
        let included = try XCTUnwrap(rows.first { ($0["grandfathered"] as? Bool) == true })
        let isFree = (included["isFree"] as? Bool) == true
        let grandfathered = (included["grandfathered"] as? Bool) == true
        XCTAssertTrue(GDWorkspacePriceLabel.requiresGrandfatheredBYOConfirmation(isFree: isFree, grandfathered: grandfathered))
        XCTAssertFalse(GDWorkspacePriceLabel.byoConfirmationAllowsSubmit(isFree: isFree, grandfathered: grandfathered, acknowledged: false))
        let registered = try GDFixtureFile.load("workspaces", "byo-register-ends-grandfathered")
        XCTAssertEqual(registered.body["grandfatheringEnded"] as? Bool, true)
        XCTAssertEqual(registered.body["grandfathered"] as? Bool, false)
        XCTAssertEqual(registered.body["feeWaived"] as? Bool, false)
        let serverCents = try XCTUnwrap(GDWorkspacePriceLabel.cents(registered.body["monthlyPriceCents"]))
        let notice = try XCTUnwrap(GDWorkspacePriceLabel.grandfatheredBYONotice(response: registered.body))
        XCTAssertTrue(notice.contains("no longer be Included"))
        XCTAssertTrue(notice.contains(GDWorkspacePriceLabel.format(serverCents)))
        XCTAssertTrue(GDWorkspacePriceLabel.byoConfirmationAllowsSubmit(isFree: isFree, grandfathered: grandfathered, acknowledged: true))
        var response = registered.body
        response["projectStatus"] = "active"
        let status = GDWorkspacePriceLabel.byoRegisteredStatus(response)
        XCTAssertTrue(status.contains(GDWorkspacePriceLabel.format(serverCents)))
        XCTAssertTrue(status.contains("Status: active"))
        XCTAssertFalse(status.contains("Included"))
        XCTAssertFalse(status.contains("Free"))
    }

    func testByoResponseShowsReturnedPriceAndStatus() throws {
        let registered = try GDFixtureFile.load("workspaces", "byo-first-paid")
        XCTAssertEqual(registered.body["feeWaived"] as? Bool, false)
        XCTAssertEqual(registered.body["lapsed"] as? Bool, false)
        let status = GDWorkspacePriceLabel.byoRegisteredStatus(registered.body)
        let cents = try XCTUnwrap(GDWorkspacePriceLabel.cents(registered.body["monthlyPriceCents"]))
        XCTAssertTrue(status.contains(GDWorkspacePriceLabel.format(cents)))
        XCTAssertTrue(status.contains("Status: active"))
        XCTAssertFalse(status.contains("Payment is required"))
        XCTAssertFalse(status.contains("Included"))
    }

    func testDemotionGraceBannerStaysOnThatWorkspace() throws {
        let hosted = try GDFixtureFile.load("workspaces", "make-hosted")
        let demoted = try XCTUnwrap(GDWorkspacePriceLabel.demotedWorkspace(hosted.body))
        let demotedJSON = try XCTUnwrap(hosted.body["demoted"] as? [String: Any])
        let paid = try XCTUnwrap((demotedJSON["paidThroughMs"] as? NSNumber)?.doubleValue)
        let grace = try XCTUnwrap((demotedJSON["graceEndsAt"] as? NSNumber)?.doubleValue)
        XCTAssertEqual(grace - paid, 3 * 24 * 60 * 60 * 1000)
        XCTAssertEqual(demoted.workspaceID, "11111111-1111-4111-8111-000000000031")
        XCTAssertNotEqual(demoted.workspaceID, hosted.body["workspaceId"] as? String)
        XCTAssertNotEqual(demoted.workspaceID, hosted.body["freeWorkspaceId"] as? String)
        XCTAssertFalse(GDWorkspacePriceLabel.graceBlocksTransfers)
        XCTAssertEqual(GDWorkspacePriceLabel.paymentBannerTitle(workspaceName: "Hosted", graceEndsAt: demoted.graceEndsAt), "Payment due")
        XCTAssertEqual(GDWorkspacePriceLabel.paymentButtonTitle(graceEndsAt: demoted.graceEndsAt), "Pay")
        let now = Date(timeIntervalSince1970: paid / 1000)
        XCTAssertEqual(GDWorkspacePriceLabel.graceCountdown(until: demoted.graceEndsAt, now: now), "Grace period: 3d 0h remaining.")
        let duringGrace = try GDFixtureFile.load("workspaces", "byo-in-grace")
        XCTAssertEqual(duringGrace.status, 201)
        XCTAssertNil(GDStorageContract.parseLock(duringGrace.body))
        let sibling = try GDFixtureFile.load("workspaces", "byo-lapsed-others-open")
        XCTAssertEqual(sibling.status, 201)
        let lapsed = try GDFixtureFile.load("workspace-lock", "byo-lapsed")
        XCTAssertEqual(lapsed.status, 423)
        let lockedID = try XCTUnwrap(GDWorkspacePriceLabel.workspaceID(in: lapsed.path))
        let openID = try XCTUnwrap(GDWorkspacePriceLabel.workspaceID(in: sibling.path))
        XCTAssertNotEqual(lockedID, openID)
        let body = try XCTUnwrap(GDStorageContract.parseLock(lapsed.body))
        XCTAssertEqual(GDWorkspacePriceLabel.lockedWorkspaceIDs(requestWorkspaceID: lockedID, reason: body.reason, unpaid: body.unpaidWorkspaceIds), [lockedID])
    }

    @MainActor
    func testDemotionNoticeDoesNotLockTheRestOfTheAccount() throws {
        let hosted = try GDFixtureFile.load("workspaces", "make-hosted")
        let demoted = try XCTUnwrap(GDWorkspacePriceLabel.demotedWorkspace(hosted.body))
        let hostedID = try XCTUnwrap(hosted.body["workspaceId"] as? String)
        GDWorkspaceLock.shared.noteDemotion(hosted.body)
        defer { GDWorkspaceLock.shared.clear(workspaceID: demoted.workspaceID) }
        let notice = try XCTUnwrap(GDWorkspaceLock.shared.notice(for: demoted.workspaceID))
        XCTAssertEqual(notice.graceEndsAt, demoted.graceEndsAt)
        XCTAssertFalse(notice.blocksTransfers)
        XCTAssertNil(GDWorkspaceLock.shared.notice(for: hostedID))
        XCTAssertFalse(GDWorkspaceLock.shared.presented)
        GDWorkspaceLock.shared.clearSettled(workspaceID: demoted.workspaceID)
        XCTAssertNotNil(GDWorkspaceLock.shared.notice(for: demoted.workspaceID))
    }

    func testDeletingDisablesActionsAndBusyDeleteAsksToRetry() {
        XCTAssertEqual(GDWorkspacePriceLabel.deletingTitle, "Deleting…")
        XCTAssertFalse(GDWorkspacePriceLabel.actionsEnabled(projectStatus: "deleting"))
        XCTAssertTrue(GDWorkspacePriceLabel.actionsEnabled(projectStatus: "active"))
        for reason in ["merge_active", "uploads_pending", "checkout_open"] {
            XCTAssertEqual(
                GDWorkspacePriceLabel.deletionBlocked(status: 409, json: ["error": "workspace_busy", "reason": reason]),
                "This workspace is busy, try again.")
            XCTAssertEqual(
                GDStorageContract.explainProjectWrite(status: 409, json: ["error": "workspace_busy", "reason": reason]),
                "This workspace is busy, try again.")
        }
        XCTAssertEqual(GDWorkspacePriceLabel.deletionBlocked(status: 409, json: ["error": "MERGE_IN_PROGRESS"]), "Finish or cancel the merge first.")
        XCTAssertEqual(GDStorageContract.explainProjectWrite(status: 409, json: ["error": "PROJECT_HAS_PENDING_UPLOADS"]), "Finish or cancel the upload first.")
        XCTAssertEqual(GDStorageContract.explainProjectWrite(status: 409, json: ["error": "CHECKOUT_BUSY"]), "Finish or cancel checkout first.")
        XCTAssertNil(GDWorkspacePriceLabel.deletionBlocked(status: 409, json: ["error": "PROJECT_LIMIT_REACHED"]))
    }

    func testUnpaidLockStaysOnTheRequestedWorkspace() throws {
        let locked = try GDFixtureFile.load("workspace-lock", "lapsed")
        let workspace = try XCTUnwrap(GDWorkspacePriceLabel.workspaceID(in: locked.path))
        let body = try XCTUnwrap(GDStorageContract.parseLock(locked.body))
        let ids = GDWorkspacePriceLabel.lockedWorkspaceIDs(requestWorkspaceID: workspace, reason: body.reason, unpaid: ["11111111-1111-4111-8111-000000000002"] + body.unpaidWorkspaceIds)
        XCTAssertEqual(ids, [workspace])
        XCTAssertFalse(ids.contains("11111111-1111-4111-8111-000000000002"))
        var grace = locked.body
        grace["graceEndsAt"] = "2026-10-21T00:00:00.000Z"
        let end = try XCTUnwrap(GDWorkspacePriceLabel.graceEnd(grace))
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-18T00:00:00Z"))
        let countdown = try XCTUnwrap(GDWorkspacePriceLabel.graceCountdown(until: end, now: now))
        XCTAssertTrue(countdown.contains("Grace period"))
        XCTAssertTrue(countdown.contains("3d"))
    }
}
