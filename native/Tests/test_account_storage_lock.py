"""Account deletion, hosted storage seals, and the workspace lock screen."""
import datetime
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "Resources" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


account = load("gendragoon_account")
storage = load("gendragoon_hosted_storage")
NOW = datetime.datetime(2026, 10, 18, 2, 30, tzinfo=datetime.timezone.utc)
KEY = b"k" * 32


class AccountDeletionTests(unittest.TestCase):
    def test_stale_sign_in_and_missing_confirmation_do_not_call_the_server(self):
        stale = account.start_deletion(5 * 60, "DELETE")
        self.assertEqual(stale["action"], "reauthenticate")
        self.assertIn("5 minutes", stale["message"])
        with self.assertRaises(account.AccountError):
            account.start_deletion(10, "delete")

    def test_fresh_confirmation_starts_a_job_and_a_repeat_401_does_not_wipe(self):
        started = account.start_deletion(30, "DELETE")
        self.assertEqual(started["action"], "request")
        self.assertEqual(started["method"], "DELETE")
        self.assertEqual(started["path"], "/v2/account")
        self.assertEqual(started["body"], {"confirm": "DELETE"})
        job = account.accept_start(202, {"status": "deleting", "jobId": "job_12345678",
                                         "statusToken": "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg"})
        self.assertEqual(job["action"], "poll")
        self.assertEqual(job["path"], "/v2/account/deletions/job_12345678")
        self.assertEqual(job["statusToken"], "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg")
        gone = account.accept_start(410, {"error": "account_deleted", "jobId": "job_12345678",
                                          "statusToken": "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg"})
        self.assertEqual(gone["action"], "poll")
        with self.assertRaises(account.AccountError):
            account.accept_start(202, {"job": {"id": "job_12345678", "statusPath": "/v2/account/deletion/job_12345678"}})
        with self.assertRaises(account.AccountError):
            account.accept_poll(200, {"jobId": "job_12345678", "status": "completed", "retryable": False})
        done = account.accept_poll(200, {"jobId": "job_12345678", "status": "done", "retryable": False})
        self.assertEqual(done["action"], "wipe")
        repeat = account.accept_start(401, {"error": "invalid_token"})
        self.assertEqual(repeat["action"], "reauthenticate")
        self.assertNotEqual(repeat["action"], "wipe")

    def test_wipe_removes_only_app_caches_and_the_keychain_service(self):
        class Keychain:
            def __init__(self):
                self.deleted = []
            def delete_service(self, service):
                self.deleted.append(service)
        with tempfile.TemporaryDirectory() as folder:
            home = Path(folder)
            cache = home / "Library/Caches/GenDragoon Cloud SSD"
            cache.mkdir(parents=True)
            (cache / "secret").write_text("token")
            other = home / "Documents"
            other.mkdir()
            (other / "keep").write_text("stay")
            keychain = Keychain()
            removed = account.wipe_local(home, keychain)
            self.assertFalse(cache.exists())
            self.assertEqual((other / "keep").read_text(), "stay")
            self.assertEqual(keychain.deleted, ["app.gendragoon.cloudssd"])
            self.assertIn(str(cache), removed["wiped"])


class HostedStorageTests(unittest.TestCase):
    def session(self, **extra):
        body = {
            "prefix": "ws-1/",
            "expiresAt": (NOW + datetime.timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "readOnly": False,
            "urls": [{
                "op": "upload",
                "name": "sealed-name",
                "method": "PUT",
                "url": "https://storage.example/ws-1/sealed-name",
            }],
        }
        body.update(extra)
        return body

    def test_session_rejects_google_secrets_long_life_and_foreign_urls(self):
        self.assertEqual(storage.storage_path("ws-1"), "/v2/workspaces/ws-1/storage-urls")
        accepted = storage.validate_session("ws-1", self.session(), NOW)
        self.assertEqual(accepted["urls"][0]["method"], "PUT")
        with self.assertRaises(storage.StorageError):
            storage.validate_session("ws-1", self.session(access_token="ya29.secret"), NOW)
        with self.assertRaises(storage.StorageError):
            storage.validate_session("ws-1", self.session(
                expiresAt=(NOW + datetime.timedelta(minutes=20)).strftime("%Y-%m-%dT%H:%M:%SZ")), NOW)
        with self.assertRaises(storage.StorageError):
            storage.validate_session("ws-1", self.session(urls=[{
                "op": "upload", "name": "sealed-name", "method": "PUT",
                "url": "https://storage.example/other/sealed-name",
            }]), NOW)

    def test_files_and_names_round_trip_without_the_original_name(self):
        token = storage.object_name("Holiday.mp4", KEY)
        self.assertNotIn("holiday", token.casefold())
        self.assertEqual(storage.decrypt_name(token, KEY), "Holiday.mp4")
        sealed = storage.encrypt_file(b"frame-bytes", KEY)
        self.assertNotIn(b"frame-bytes", sealed)
        self.assertEqual(storage.decrypt_file(sealed, KEY), b"frame-bytes")

    def test_locked_session_refuses_an_upload_url(self):
        with self.assertRaisesRegex(storage.StorageError, "locked"):
            storage.validate_session("ws-1", self.session(readOnly=True), NOW)


class WorkspaceLockTests(unittest.TestCase):
    def test_423_opens_the_delete_or_merge_screen(self):
        screen = storage.interpret_workspace_lock(423, {
            "error": "workspace_lock", "reason": "over_cap", "overBy": 2,
            "unpaidWorkspaceIds": ["ws-9"],
        })
        self.assertEqual(screen["screen"], "delete-or-merge")
        self.assertEqual(screen["overBy"], 2)
        self.assertEqual(screen["unpaidWorkspaceIds"], ["ws-9"])
        self.assertIn("Delete or merge", screen["message"])
        self.assertNotIn("temporarily unavailable", screen["message"].lower())
        self.assertIsNone(storage.interpret_workspace_lock(500, {"error": "workspace_lock"}))
        self.assertIsNone(storage.interpret_workspace_lock(423, {"error": "other"}))
        scoped = storage.interpret_workspace_lock(423, {
            "error": "workspace_lock", "reason": "lapsed", "overBy": 0,
            "unpaidWorkspaceIds": ["ws-byo", "ws-paid"],
        }, workspace_id="ws-byo")
        self.assertEqual(scoped["screen"], "pay-workspace")
        self.assertEqual(scoped["lockedWorkspaceIds"], ["ws-byo"])
        self.assertFalse(scoped["locksEntireApp"])
        self.assertNotIn("ws-paid", scoped["lockedWorkspaceIds"])


if __name__ == "__main__":
    unittest.main()
