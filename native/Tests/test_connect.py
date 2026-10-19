import importlib.util
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("connector", ROOT / "Resources" / "gendragoon_connect.py")
connect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connect)


class ConnectorTests(unittest.TestCase):
    def test_project_input_validation(self):
        self.assertEqual(connect.valid_project("gendragood-ssd"), "gendragood-ssd")
        for sample in ["../bad", "", "some/id", "UPPER", "abc"]:
            with self.assertRaises(ValueError):
                connect.valid_project(sample)

    def test_bucket_input_validation(self):
        self.assertEqual(connect.valid_bucket("gen-dragoon-ssd"), "gen-dragoon-ssd")
        for sample in ["a/../b", "ABC", "x", "; touch /tmp/pwn", ""]:
            with self.assertRaises(ValueError):
                connect.valid_bucket(sample)

    def test_sha256_helper(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / "data"
            p.write_bytes(b"good")
            self.assertEqual(connect.sha256(p), hashlib.sha256(b"good").hexdigest())

    @patch.object(connect, "find_executable", return_value="/fake/gcloud")
    @patch.object(connect, "google_json")
    @patch.object(connect, "reply")
    def test_google_project_selection(self, reply, req, _):
        req.return_value = {"projects": [
            {"name":"GenDragoon SSD", "projectId":"gendragood-ssd", "lifecycleState":"ACTIVE"},
            {"name":"Deleted", "projectId":"deleted-one", "lifecycleState":"DELETE_REQUESTED"},
        ]}
        connect.projects()
        self.assertEqual(reply.call_args.kwargs["projects"], [{"id":"gendragood-ssd", "name":"GenDragoon SSD"}])

    @patch.object(connect, "find_executable", return_value="/fake/gcloud")
    @patch.object(connect, "google_json")
    @patch.object(connect, "reply")
    def test_google_bucket_selection(self, reply, req, _):
        req.return_value = {"items": [{"name":"gen-dragoon-ssd"}]}
        connect.buckets("gendragood-ssd")
        self.assertEqual(reply.call_args.kwargs["buckets"], ["gen-dragoon-ssd"])

    @patch.object(connect, "RCLONE", new_callable=lambda: Path(__file__))
    @patch.object(connect, "find_executable", return_value="/fake/gcloud")
    @patch.object(connect, "google_json")
    @patch.object(connect, "run")
    @patch.object(connect, "reply")
    def test_configure_correct_remote_uses_adc(self, reply, run, get, _, __):
        get.return_value={"name":"gen-dragoon-ssd", "projectNumber":"123"}
        connect.configure("gendragood-ssd", "gen-dragoon-ssd")
        argv = run.call_args_list[0].args[0]
        self.assertIn("env_auth", argv)
        self.assertIn("true", argv)
        self.assertIn("bucket_policy_only", argv)
        self.assertIn("gendragoon:gen-dragoon-ssd", run.call_args_list[1].args[0])
        # A temporary remote is tested BEFORE changes to the user's rclone config.
        self.assertEqual(run.call_args_list[1].args[0][3:5], ["lsf", "gendragoon:gen-dragoon-ssd"])
        self.assertIn("listremotes", run.call_args_list[2].args[0])

    def test_opera_required_no_browser_fallback(self):
        with patch.object(connect.platform, "system", return_value="Linux"):
            with self.assertRaisesRegex(RuntimeError, "macOS"):
                connect.opera_env()


if __name__ == '__main__':
    unittest.main()
