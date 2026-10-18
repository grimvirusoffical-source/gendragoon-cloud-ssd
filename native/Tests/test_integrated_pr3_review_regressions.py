"""Regression tests for Avery's PR #3 review blockers 1-3 (review tip 1e10c2f).

Tests marked @unittest.expectedFailure describe the fixed behaviour and fail on
the current code. When a fix lands they start passing, unittest reports an
"unexpected success", and the marker must be dropped.

Contract sources: Riley's PR #6 (native/Backend/account_delete.js):
- DELETE /v2/account -> 202 {"jobId": "<uuid>"}
- job status is one of queued | running | done | failed
- DELETE carries the JSON body {"confirm": "DELETE"}
- status is polled at GET /v2/account/deletions/:jobId (plural only)
- 401 "reauth_required" or "invalid_token" means "sign in again" (also returned for a repeat
  DELETE after the job is done). It never proves the account is gone.

The Swift client has no Linux-runnable test target, so the Swift checks below
read the source text. They are guards, not a substitute for XCTest on a Mac.
"""
import importlib.util
import re
import time
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "Sources"

# Avery's final ruling, confirmed by Riley (no singular alias): plural only.
DELETION_STATUS_PREFIX = "/v2/account/deletions/"
SINGULAR_PREFIX = "/v2/account/deletion/"
JOB_ID = "3f2b8c1e-6a4d-4e7b-9c2a-1d5e8f0a7b36"  # fixture, not a real job


def load(name):
    spec = importlib.util.spec_from_file_location("pr3_" + name, ROOT / "Resources" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


account = load("gendragoon_account")
updater = load("gendragoon_auto_update")


def swift(name):
    return (SOURCES / name).read_text(encoding="utf-8")


def blocks_after(source, pattern):
    """Return the brace-balanced bodies that follow each match of pattern."""
    bodies = []
    for match in re.finditer(pattern, source):
        start = source.index("{", match.end() - 1)
        depth = 0
        for index in range(start, len(source)):
            depth += {"{": 1, "}": -1}.get(source[index], 0)
            if depth == 0:
                bodies.append(source[start + 1:index])
                break
    return bodies


def wipes(result):
    return isinstance(result, dict) and result.get("action") == "wipe"


# Blocker 1: a 401 must never wipe keys, and freshness comes from auth_time.
class ReauthNeverWipesTests(unittest.TestCase):
    @unittest.expectedFailure
    def test_start_401_routes_to_sign_in_without_wiping(self):
        for code in ("reauth_required", "invalid_token"):
            with self.subTest(code=code):
                result = account.accept_start(401, {"error": code})
                self.assertFalse(wipes(result))
                self.assertEqual(result.get("action"), "reauthenticate")

    @unittest.expectedFailure
    def test_poll_401_routes_to_sign_in_without_wiping(self):
        for code in ("reauth_required", "invalid_token"):
            with self.subTest(code=code):
                result = account.accept_poll(401, {"error": code})
                self.assertFalse(wipes(result))
                self.assertEqual(result.get("action"), "reauthenticate")

    @unittest.expectedFailure
    def test_bare_401_never_wipes(self):
        for call in (account.accept_start, account.accept_poll):
            for body in ({}, {"error": "unauthorized"}, None):
                with self.subTest(call=call.__name__, body=body):
                    try:
                        result = call(401, body)
                    except account.AccountError:
                        continue  # refusing is fine; wiping is not
                    self.assertFalse(wipes(result))

    def test_stale_sign_in_reauthenticates_before_any_request(self):
        # Guard (passes today): 5 minutes or older never builds a request.
        for age in (300, 301, 3600):
            with self.subTest(age=age):
                self.assertEqual(account.start_deletion(age, "DELETE")["action"], "reauthenticate")

    @unittest.expectedFailure
    def test_freshness_uses_id_token_auth_time_not_refresh_time(self):
        # A silent refresh re-issues the token (new iat/exp) but keeps the
        # original auth_time. Signed in an hour ago, refreshed 10 s ago: stale.
        # Expected helper: account.sign_in_age(claims, now) -> now - auth_time.
        now = 1_792_300_000
        claims = {"auth_time": now - 3600, "iat": now - 10, "exp": now + 3590}
        age = account.sign_in_age(claims, now)
        self.assertGreaterEqual(age, 3600)
        self.assertEqual(account.start_deletion(age, "DELETE")["action"], "reauthenticate")
        # Missing auth_time must fail closed, never count as fresh.
        with self.assertRaises(account.AccountError):
            account.sign_in_age({"iat": now - 10}, now)

    @unittest.expectedFailure
    def test_swift_401_branches_never_call_wipe_local(self):
        bodies = blocks_after(swift("GDAccountDeletion.swift"), r"status\s*==\s*401\s*\{")
        for body in bodies:
            self.assertNotIn("wipeLocal", body)

    @unittest.expectedFailure
    def test_swift_freshness_check_is_not_based_on_last_verified(self):
        source = swift("GenDragoonStartupRoot.swift")
        bodies = blocks_after(source, r"func\s+signedInWithin\s*\([^)]*\)[^{]*\{")
        self.assertTrue(bodies, "signedInWithin(seconds:) not found")
        self.assertNotIn("lastVerified", bodies[0])
        self.assertRegex(bodies[0], r"auth_?[tT]ime")


# Blocker 2: 202 body is {"jobId"}, terminal states are done / failed.
class DeletionContractTests(unittest.TestCase):
    @unittest.expectedFailure
    def test_202_reads_top_level_job_id(self):
        result = account.accept_start(202, {"jobId": JOB_ID})
        self.assertEqual(result["action"], "poll")
        self.assertEqual(result["path"], DELETION_STATUS_PREFIX + JOB_ID)

    @unittest.expectedFailure
    def test_delete_request_carries_confirm_body(self):
        request = account.start_deletion(30, "DELETE")
        self.assertEqual(request["method"], "DELETE")
        self.assertEqual(request["path"], "/v2/account")
        self.assertEqual(request.get("body"), {"confirm": "DELETE"})

    def test_status_path_is_plural_and_singular_is_refused(self):
        # Guard (passes today): a server-suggested singular path is rejected.
        with self.assertRaises(account.AccountError):
            account.accept_start(202, {"jobId": JOB_ID, "statusPath": SINGULAR_PREFIX + JOB_ID})
        with self.assertRaises(account.AccountError):
            account.accept_start(202, {"job": {"id": JOB_ID, "statusPath": SINGULAR_PREFIX + JOB_ID}})

    def test_wipe_only_after_done(self):
        # Guard (passes today): no non-terminal or failed state wipes keys.
        for body in ({"status": "queued"}, {"status": "running"}):
            with self.subTest(body=body):
                self.assertFalse(wipes(account.accept_poll(200, body)))
        for status in (200, 202, 404, 500, 503):
            with self.subTest(status=status):
                try:
                    self.assertFalse(wipes(account.accept_poll(status, {"status": "failed"})))
                except account.AccountError:
                    pass

    @unittest.expectedFailure
    def test_completed_is_not_a_contract_state(self):
        # The server only reports queued | running | done | failed.
        with self.assertRaises(account.AccountError):
            account.accept_poll(200, {"status": "completed"})

    def test_202_without_job_id_does_not_start(self):
        with self.assertRaises(account.AccountError):
            account.accept_start(202, {})

    @unittest.expectedFailure
    def test_done_is_the_success_state(self):
        result = account.accept_poll(200, {"status": "done"})
        self.assertTrue(wipes(result))

    def test_failed_is_terminal_and_never_wipes(self):
        with self.assertRaises(account.AccountError):
            account.accept_poll(200, {"status": "failed", "retryable": True, "failure": "stripe_cancel_failed"})

    def test_queued_and_running_keep_polling(self):
        for state in ("queued", "running"):
            with self.subTest(state=state):
                self.assertEqual(account.accept_poll(200, {"status": state})["action"], "poll")

    @unittest.expectedFailure
    def test_swift_reads_job_id_and_finishes_on_done(self):
        source = swift("GDAccountDeletion.swift")
        self.assertRegex(source, r'json\["jobId"\]')
        self.assertRegex(source, r'==\s*"done"')
        self.assertNotRegex(source, r'json\["job"\]')
        self.assertNotRegex(source, r'==\s*"completed"')

    @unittest.expectedFailure
    def test_swift_delete_sends_confirm_body(self):
        source = swift("GDAccountDeletion.swift")
        self.assertIn("httpBody", source)
        self.assertRegex(source, r'"confirm"\s*:\s*"DELETE"')

    def test_swift_never_uses_singular_status_path(self):
        self.assertNotIn(SINGULAR_PREFIX, swift("GDAccountDeletion.swift"))
        self.assertIn(DELETION_STATUS_PREFIX, swift("GDAccountDeletion.swift"))


# Blocker 3: the stable channel never installs a GitHub prerelease.
class StableSkipsPrereleaseTests(unittest.TestCase):
    def release(self, tag, prerelease=False):
        version = "v" + ".".join(updater.RELEASE_TAG.fullmatch(tag).groups()[:3])
        base = "https://github.com/" + updater.REPO + "/releases/download/" + tag + "/"
        names = [updater.ZIP_PREFIX + version + ".zip", "sha256.txt", "package-status.json"]
        return {"tag_name": tag, "draft": False, "prerelease": prerelease,
                "assets": [{"name": n, "browser_download_url": base + n} for n in names]}

    def check(self, channel):
        releases = [self.release("v0.18.0-rc.1", prerelease=True), self.release("v0.17.0")]

        def fake_json(url):
            if url.startswith("https://api.github.com/"):
                return releases
            version = re.search(r"/download/v([0-9.]+)", url).group(1)
            # Complete, Apple-trusted metadata that even says eligible: stable
            # must still refuse the prerelease.
            return {"version": version, "build": "42", "gatekeeperAccepted": True,
                    "stapledTicketValidated": True, "automaticUpdateEligible": True}

        with mock.patch.object(updater, "CHANNEL", channel), \
                mock.patch.object(updater, "installed_version", return_value="0.16.0"), \
                mock.patch.object(updater, "request_json", side_effect=fake_json):
            return updater.latest()

    @unittest.expectedFailure
    def test_stable_skips_newest_prerelease_even_when_marked_eligible(self):
        self.assertEqual(self.check("stable")["releaseTag"], "v0.17.0")

    def test_preview_still_sees_the_prerelease(self):
        self.assertEqual(self.check("preview")["releaseTag"], "v0.18.0-rc.1")


if __name__ == "__main__":
    unittest.main()
