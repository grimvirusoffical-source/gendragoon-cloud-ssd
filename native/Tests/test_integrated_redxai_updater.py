"""Red-XAI quits, replaces, and relaunches a ready update without touching Linux launches."""
import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path

HELPER = Path(__file__).resolve().parents[1] / "Resources/redxai_updater.py"
spec = importlib.util.spec_from_file_location("redxai_fixture", HELPER)
redxai = importlib.util.module_from_spec(spec)
spec.loader.exec_module(redxai)


class RedXAITests(unittest.TestCase):
    def test_manifest_lists_gendragoon_first_and_can_grow(self):
        apps = redxai.load_manifest()
        self.assertEqual(apps[0]["bundleId"], "app.gendragoon.cloudssd")
        self.assertEqual(apps[0]["repo"], "grimvirusoffical-source/gendragoon-cloud-ssd")
        self.assertIn("zipPrefix", apps[0])

    def test_ready_update_quits_replaces_and_relaunches_in_order(self):
        calls = []
        with tempfile.TemporaryDirectory() as folder:
            staged = Path(folder) / "GenDragoon-Cloud-SSD-Mac-v0.18.0.zip"
            staged.write_bytes(b"zip")
            entry = redxai.load_manifest()[0]
            result = redxai.apply_ready_update(entry, staged,
                quit_app=lambda app: calls.append(("quit", app["bundleId"])),
                replace_app=lambda app, package: calls.append(("replace", package.name)),
                relaunch_app=lambda app: calls.append(("relaunch", app["appName"])) or [4321])
        self.assertEqual(calls, [
            ("quit", "app.gendragoon.cloudssd"),
            ("replace", "GenDragoon-Cloud-SSD-Mac-v0.18.0.zip"),
            ("relaunch", "GenDragoon Cloud SSD")])
        self.assertEqual(result, [4321])

    def test_linux_relaunch_offer_stays_with_the_caller(self):
        self.assertIsNone(redxai.offer_relaunch(Path("/tmp/GenDragoon Cloud SSD.app")))


if __name__ == "__main__":
    unittest.main()
