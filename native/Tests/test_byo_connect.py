"""Launch BYO storage is S3-compatible. SFTP, Azure, and WebDAV stay closed."""
import datetime
import importlib.util
from pathlib import Path
import unittest
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("byo_connect", ROOT / "Resources" / "gendragoon_byo_connect.py")
byo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(byo)

NOW = datetime.datetime(2026, 10, 18, 2, 0, tzinfo=datetime.timezone.utc)
ENDPOINT = "https://bucket.example"
BUCKET = "customer-bucket"
NONCE = "nonce_value_16ch"
ACCESS = "AKIACHALLENGEEXAMPLE"
SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"


class BringYourOwnLaunchTests(unittest.TestCase):
    def test_catalog_keeps_sftp_azure_and_webdav_visible_but_closed(self):
        rows = {row["id"]: row for row in byo.catalog()}
        for key in ("s3", "r2", "b2", "wasabi", "minio", "gcs"):
            self.assertTrue(rows[key]["available"])
        for key in ("sftp", "azure", "webdav"):
            self.assertFalse(rows[key]["available"])
            self.assertEqual(rows[key]["note"], "Coming soon")
        self.assertTrue({"google-drive", "onedrive", "other"}.isdisjoint(rows))

    def test_coming_soon_has_no_connect_flow(self):
        for provider in ("sftp", "azure", "webdav"):
            called = []
            with self.assertRaises(byo.ConnectError) as caught:
                byo.activate(provider, nonce=NONCE, endpoint=ENDPOINT, bucket=BUCKET,
                             access_key=ACCESS, secret_key=SECRET, region="us-east-1",
                             write=lambda *args: called.append("write"),
                             confirm=lambda body: called.append(body),
                             delete=lambda name: called.append(name), now=NOW)
            self.assertEqual(caught.exception.code, "coming_soon")
            self.assertIn("coming soon", str(caught.exception).lower())
            self.assertIn("no connect flow", str(caught.exception).lower())
            self.assertEqual(called, [])
            with self.assertRaises(byo.ConnectError):
                byo.register_body(provider, ENDPOINT)

    def test_challenge_sends_presigned_get_and_deletes_only_after_confirm(self):
        written, deleted, sent = [], [], []

        def write(name, nonce, keys):
            self.assertEqual(name, ".gendragoon-challenge/" + NONCE)
            self.assertEqual(nonce, NONCE)
            self.assertEqual(keys["secretKey"], SECRET)
            written.append(name)

        def confirm(body):
            sent.append(body)
            self.assertEqual(set(body), {"presignedUrl"})
            self.assertNotEqual(body["presignedUrl"], NONCE)
            self.assertNotIn("readBack", body)
            self.assertNotIn("nonce", body)
            parsed = urllib.parse.urlsplit(body["presignedUrl"])
            self.assertEqual(parsed.scheme, "https")
            self.assertEqual(parsed.hostname, "bucket.example")
            self.assertIn("/.gendragoon-challenge/" + NONCE, parsed.path)
            self.assertNotIn(SECRET, body["presignedUrl"])
            self.assertNotIn("readBack", body)
            return {"verified": True}

        result = byo.activate("r2", nonce=NONCE, endpoint=ENDPOINT, bucket=BUCKET,
                              access_key=ACCESS, secret_key=SECRET, region="auto",
                              write=write, confirm=confirm, delete=deleted.append, now=NOW)
        self.assertEqual(written, [".gendragoon-challenge/" + NONCE])
        self.assertEqual(deleted, written)
        self.assertEqual(result["monthlyCents"], 500)
        self.assertNotEqual(result["monthlyCents"], 1000)

    def test_server_errors_are_specific_and_leave_the_object(self):
        cases = (
            (422, {"error": "byo_provider_unsupported"}, "not supported"),
            (409, {"error": "byo_unverifiable"}, "could not verify"),
        )
        for status, body, expected in cases:
            explained = byo.explain_server(status, body)
            self.assertNotIn("temporarily unavailable", explained["message"].lower())
            self.assertIn(expected, explained["message"].lower())
            deleted = []
            with self.assertRaises(byo.ConnectError) as caught:
                byo.activate("aws", nonce=NONCE, endpoint=ENDPOINT, bucket=BUCKET,
                             access_key=ACCESS, secret_key=SECRET, region="us-east-1",
                             write=lambda *args: None,
                             confirm=lambda payload: {"verified": False, **body, "status": status},
                             delete=deleted.append, now=NOW)
            self.assertEqual(caught.exception.code, body["error"])
            self.assertIn(expected, str(caught.exception).lower())
            self.assertEqual(deleted, [])

    def test_endpoint_change_requires_a_new_challenge(self):
        saved = {"verified": True, "endpoint": ENDPOINT, "bucket": BUCKET}
        self.assertFalse(byo.needs_challenge(saved, ENDPOINT, BUCKET))
        self.assertTrue(byo.needs_challenge(saved, "https://other.example", BUCKET))
        self.assertTrue(byo.needs_challenge({"verified": False, "endpoint": ENDPOINT, "bucket": BUCKET}, ENDPOINT, BUCKET))

    def test_price_stays_five_dollars(self):
        self.assertEqual(byo.MONTHLY_CENTS, 500)


if __name__ == "__main__":
    unittest.main()
