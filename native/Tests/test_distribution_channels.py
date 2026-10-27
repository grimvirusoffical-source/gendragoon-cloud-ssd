"""Per-distribution updater behaviour for the Mac helper: direct self-updates; Rotten Apple and Mac App Store never do.
No network, no macOS tools: everything runs against disposable directories."""
from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).parents[1] / "Resources/gendragoon_auto_update.py"
SPEC = importlib.util.spec_from_file_location("distribution_auto_update", SCRIPT)
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)


class Channel(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name).resolve()
        self.app = self.root / updater.APP_NAME
        (self.app / "Contents").mkdir(parents=True)
        self.dist_file = self.root / "gendragoon_distribution.json"
        self.patches = [
            mock.patch.object(updater, "DISTRIBUTION_FILE", self.dist_file),
            mock.patch.object(updater, "APP", self.app),
            mock.patch.dict(os.environ, {}, clear=False),
        ]
        for p in self.patches:
            p.start()
        os.environ.pop("ROTTEN_APPLE_LAUNCHER", None)

    def tearDown(self):
        for p in reversed(self.patches):
            p.stop()
        self.tmp.cleanup()

    def write(self, value):
        self.dist_file.write_text(json.dumps({"distribution": value}))

    def run_main(self, action):
        out = io.StringIO()
        with redirect_stdout(out):
            code = updater.main([action, "--app", str(self.app)])
        return code, [json.loads(line) for line in out.getvalue().splitlines() if line.strip()]

    def test_default_without_file_is_direct(self):
        self.assertEqual(updater.distribution(), "direct")
        self.assertTrue(updater.self_update_allowed())

    def test_direct_check_reaches_the_release_feed(self):
        self.write("direct")
        with mock.patch.object(updater, "latest", return_value=None) as latest:
            code, events = self.run_main("check")
        self.assertEqual(code, 0)
        latest.assert_called_once()
        self.assertEqual(events[-1]["event"], "up_to_date")

    def test_store_builds_never_touch_the_feed_or_install(self):
        cases = {"rotten-apple": lambda: self.write("rotten-apple"), "mas-json": lambda: self.write("mas")}
        for name, setup in cases.items():
            with self.subTest(name):
                setup()
                for action in ("check", "prepare", "schedule-restart", "cancel-restart", "install-worker", "auto-on-exit"):
                    with mock.patch.object(updater, "latest", side_effect=AssertionError("network used")) as latest, \
                         mock.patch.object(updater, "request_json", side_effect=AssertionError("network used")):
                        code, events = self.run_main(action)
                    self.assertEqual(code, 0, action)
                    self.assertEqual(events[-1]["event"], "disabled", action)
                    latest.assert_not_called()

    def test_mas_receipt_always_wins_even_over_a_direct_resource_file(self):
        self.write("direct")
        receipt = self.app / "Contents/_MASReceipt/receipt"
        receipt.parent.mkdir()
        receipt.write_bytes(b"x")
        os.environ["ROTTEN_APPLE_LAUNCHER"] = "0"
        self.assertEqual(updater.distribution(), "mas")
        code, events = self.run_main("check")
        self.assertEqual((code, events[-1]["event"]), (0, "disabled"))

    def test_rotten_apple_launcher_marker(self):
        self.write("direct")
        os.environ["ROTTEN_APPLE_LAUNCHER"] = "1"
        self.assertEqual(updater.distribution(), "rotten-apple")
        self.assertFalse(updater.self_update_allowed())

    def test_unknown_or_corrupt_distribution_fails_safe_to_no_self_update(self):
        self.write("something-else")
        self.assertFalse(updater.self_update_allowed())
        self.dist_file.write_text("{not json")
        self.assertFalse(updater.self_update_allowed())
        self.dist_file.write_text('{"distribution": 7}')
        self.assertFalse(updater.self_update_allowed())

    def test_internal_entry_points_refuse_directly_too(self):
        self.write("mas")
        for call in (updater.check, updater.prepare, updater.install_worker):
            with self.assertRaises(updater.UpdatesDisabled):
                call()

    def test_status_still_works_in_store_builds(self):
        self.write("mas")
        with mock.patch.object(updater, "safe_root"), mock.patch.object(updater, "STATUS", self.root / "status.json"):
            code, events = self.run_main("status")
        self.assertEqual(code, 0)
        self.assertEqual(events[-1], {"state": "idle"})


if __name__ == "__main__":
    unittest.main()
