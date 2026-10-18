"""Price labels, demotion grace, and workspace delete conflicts. Pinned to 0715b1a."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
import importlib.util


def load():
    spec = importlib.util.spec_from_file_location(
        "gendragoon_workspace_price",
        ROOT / "native/Resources/gendragoon_workspace_price.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


price = load()


def fixture(area, name):
    return json.loads((ROOT / "fixtures" / area / name).read_text())


class WorkspacePriceTests(unittest.TestCase):
    def test_label_order_is_free_then_included_then_formatted_cents(self):
        body = fixture("workspaces", "grandfathered-plus-new.json")["response"]["body"]
        rows = {row["name"]: row for row in body["workspaces"]}
        included = rows["One-time paid"]
        free = rows["New Hosted"]
        self.assertIs(price.require_fee_waived(included), False)
        self.assertEqual(
            price.label(included["isFree"], included["grandfathered"], included["feeWaived"], included["monthlyPriceCents"]),
            "Included",
        )
        self.assertEqual(price.label(free["isFree"], free["grandfathered"], free["feeWaived"], free["monthlyPriceCents"]), "Free")
        cents = body["policy"]["workspaceMonthlyCents"]
        self.assertEqual(price.label(False, False, False, cents), price.format_cents(cents))
        self.assertEqual(price.label(False, False, True, cents), "Included")
        self.assertEqual(price.label(True, True, True, cents), "Free")
        self.assertEqual(price.label(False, False, False, None), "Price pending")
        self.assertEqual(price.format_cents(499), "$4.99/month")
        self.assertTrue(price.is_zero_price(False, True, False))
        self.assertTrue(price.is_zero_price(False, False, True))
        self.assertFalse(price.is_zero_price(False, False, False))

    def test_fee_waived_is_required_and_an_owner_benefit_is_included(self):
        body = fixture("workspaces", "owner-fee-waived.json")["response"]["body"]
        self.assertIs(price.require_fee_waived(body), True)
        self.assertEqual(body["monthlyPriceCents"], 0)
        self.assertFalse(body["isFree"])
        project = body["project"]
        self.assertIs(price.require_fee_waived(project), True)
        self.assertEqual(price.label(project["isFree"], project["grandfathered"], project["feeWaived"], project["monthlyPriceCents"]), "Included")
        self.assertTrue(price.is_zero_price(project["isFree"], project["grandfathered"], project["feeWaived"]))
        with self.assertRaises(ValueError):
            price.require_fee_waived({"isFree": False, "monthlyPriceCents": 0})

    def test_grandfathered_byo_confirmation_uses_the_register_response(self):
        listed = fixture("workspaces", "grandfathered-plus-new.json")["response"]["body"]
        included = next(row for row in listed["workspaces"] if row["grandfathered"] is True)
        self.assertTrue(price.requires_grandfathered_byo_confirmation(included["isFree"], included["grandfathered"]))
        self.assertFalse(price.byo_confirmation_allows_submit(included["isFree"], included["grandfathered"], False))
        registered = fixture("workspaces", "byo-register-ends-grandfathered.json")["response"]["body"]
        self.assertIs(registered["grandfatheringEnded"], True)
        self.assertIs(registered["grandfathered"], False)
        self.assertIs(price.require_fee_waived(registered), False)
        notice = price.grandfathered_byo_notice(registered)
        self.assertIn("no longer be Included", notice)
        self.assertIn(price.format_cents(registered["monthlyPriceCents"]), notice)
        self.assertTrue(price.byo_confirmation_allows_submit(included["isFree"], included["grandfathered"], True))
        status = price.byo_registered_status({**registered, "projectStatus": "active"})
        self.assertIn(price.format_cents(registered["monthlyPriceCents"]), status)
        self.assertIn("Status: active", status)
        self.assertNotIn("Included", status)

    def test_byo_response_price_comes_from_the_fixture(self):
        registered = fixture("workspaces", "byo-first-paid.json")["response"]["body"]
        status = price.byo_registered_status(registered)
        self.assertIn(price.format_cents(registered["monthlyPriceCents"]), status)
        self.assertIn("Status: active", status)
        self.assertNotIn("Payment is required", status)
        self.assertNotIn("Included", status)

    def test_demotion_grace_banner_is_only_on_that_workspace(self):
        body = fixture("workspaces", "make-hosted.json")["response"]["body"]
        demoted = price.demoted_workspace(body)
        self.assertEqual(demoted["workspaceId"], "11111111-1111-4111-8111-000000000031")
        self.assertNotEqual(demoted["workspaceId"], body["workspaceId"])
        self.assertNotEqual(demoted["workspaceId"], body["freeWorkspaceId"])
        self.assertEqual(demoted["graceEndsAt"] - demoted["paidThroughMs"], price.THREE_DAY_MS)
        self.assertFalse(demoted["blocksTransfers"])
        self.assertEqual(demoted["banner"], "Payment due")
        self.assertFalse(demoted["otherWorkspacesLocked"])
        grace = fixture("workspaces", "byo-in-grace.json")
        self.assertEqual(grace["response"]["status"], 201)
        sibling = fixture("workspaces", "byo-lapsed-others-open.json")
        self.assertEqual(sibling["response"]["status"], 201)
        lapsed = fixture("workspace-lock", "byo-lapsed.json")
        self.assertEqual(lapsed["response"]["status"], 423)
        locked = price.workspace_id(lapsed["request"]["path"])
        opened = price.workspace_id(sibling["request"]["path"])
        self.assertNotEqual(locked, opened)
        ids = price.locked_workspace_ids(locked, lapsed["response"]["body"]["reason"], lapsed["response"]["body"]["unpaidWorkspaceIds"])
        self.assertEqual(ids, [locked])

    def test_deleting_disables_actions_and_busy_delete_asks_to_retry(self):
        self.assertEqual(price.DELETING_TITLE, "Deleting…")
        self.assertFalse(price.actions_enabled("deleting"))
        self.assertTrue(price.actions_enabled("active"))
        for reason in ("merge_active", "uploads_pending", "checkout_open"):
            self.assertEqual(
                price.deletion_blocked(409, {"error": "workspace_busy", "reason": reason}),
                "This workspace is busy, try again.",
            )
        self.assertEqual(price.deletion_blocked(409, {"error": "MERGE_IN_PROGRESS"}), "Finish or cancel the merge first.")
        self.assertEqual(price.deletion_blocked(409, {"error": "PROJECT_HAS_PENDING_UPLOADS"}), "Finish or cancel the upload first.")
        self.assertEqual(price.deletion_blocked(409, {"error": "CHECKOUT_BUSY"}), "Finish or cancel checkout first.")
        self.assertIsNone(price.deletion_blocked(409, {"error": "PROJECT_LIMIT_REACHED"}))

    def test_423_locks_only_the_requested_workspace(self):
        locked = fixture("workspace-lock", "lapsed.json")
        path = locked["request"]["path"]
        body = locked["response"]["body"]
        workspace = price.workspace_id(path)
        ids = price.locked_workspace_ids(workspace, body["reason"], body["unpaidWorkspaceIds"])
        self.assertEqual(ids, [workspace])
        self.assertNotIn("11111111-1111-4111-8111-000000000002", ids)

    def test_swift_ui_does_not_hardcode_the_workspace_fee(self):
        banned = ("$5/month", "$5.00", "$4.99", "$5/mo", "monthlyCents = 500", "?? 500")
        sources = (ROOT / "native/Sources").rglob("*.swift")
        for path in sources:
            text = path.read_text()
            for phrase in banned:
                self.assertNotIn(phrase, text, f"{path.name} still contains {phrase}")
        notice = (ROOT / "native/Sources/GDWorkspacePrice.swift").read_text()
        self.assertIn("no longer be Included", notice)


if __name__ == "__main__":
    unittest.main()
