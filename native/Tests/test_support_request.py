"""Support-request outcomes. A missing-header 401 matches the 404 email fallback."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
import importlib.util


def load():
    spec = importlib.util.spec_from_file_location(
        "gendragoon_account",
        ROOT / "native/Resources/gendragoon_account.py",
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


account = load()


def fixture(name):
    return json.loads((ROOT / "fixtures/account-deletion" / name).read_text())


class SupportRequestTests(unittest.TestCase):
    def test_received_and_repeat_share_the_request_id(self):
        received = fixture("support-received.json")
        repeat = fixture("support-repeat.json")
        first = account.interpret_support_request(received["response"]["status"], received["response"]["body"])
        second = account.interpret_support_request(repeat["response"]["status"], repeat["response"]["body"])
        self.assertEqual(first["result"], "received")
        self.assertEqual(first["requestId"], second["requestId"])
        self.assertEqual(first["message"], "Request sent.")
        self.assertFalse(first["showSignIn"])

    def test_missing_authorization_matches_the_not_found_email_fallback(self):
        missing = fixture("support-bad-token.json")
        not_found = account.interpret_support_request(missing["response"]["status"], missing["response"]["body"])
        unauthorized = account.interpret_support_request(401, {"error": "unauthorized"})
        self.assertEqual(not_found["result"], "email_fallback")
        self.assertEqual(unauthorized["result"], "email_fallback")
        self.assertFalse(unauthorized["showSignIn"])
        self.assertFalse(not_found["showSignIn"])
        self.assertIn("support@example.com", unauthorized["message"])
        self.assertIn("Sign-in was not opened.", unauthorized["message"])

    def test_rate_limit_and_not_needed_stay_off_sign_in(self):
        limited = fixture("support-rate-limited.json")
        unneeded = fixture("support-not-needed.json")
        rate = account.interpret_support_request(limited["response"]["status"], limited["response"]["body"])
        idle = account.interpret_support_request(unneeded["response"]["status"], unneeded["response"]["body"])
        self.assertEqual(rate["result"], "rate_limited")
        self.assertEqual(rate["retryAfterSec"], 86400)
        self.assertEqual(idle["result"], "not_needed")
        self.assertFalse(rate["showSignIn"])
        self.assertFalse(idle["showSignIn"])

    def test_status_poll_401_still_asks_for_sign_in(self):
        polled = account.accept_poll(401, {"error": "unauthorized"})
        self.assertEqual(polled["action"], "reauthenticate")


if __name__ == "__main__":
    unittest.main()
