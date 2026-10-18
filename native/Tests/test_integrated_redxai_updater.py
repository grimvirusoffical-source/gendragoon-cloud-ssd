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

    def test_linux_relaunch_offer_raises_instead_of_returning_none(self):
        with self.assertRaises(RuntimeError):
            redxai.offer_relaunch(Path("/tmp/GenDragoon Cloud SSD.app"))

    # Failure injection for the Red-XAI apply path. Each fake records what ran;
    # "installed" stands in for the app on disk.
    def _apply(self, staged, *, replace=None, relaunch=None):
        calls = []
        installed = {"version": "0.17.0"}
        def quit_app(app):
            calls.append("quit")
        def replace_app(app, package):
            calls.append("replace")
            if replace:
                replace(installed, package)
            else:
                installed["version"] = "0.18.0"
        def relaunch_app(app):
            calls.append("relaunch")
            return relaunch(installed) if relaunch else [installed["version"]]
        entry = redxai.load_manifest()[0]
        try:
            return calls, installed, redxai.apply_ready_update(entry, staged, quit_app=quit_app,
                                                               replace_app=replace_app, relaunch_app=relaunch_app)
        except Exception as error:
            return calls, installed, error

    def test_missing_or_non_file_package_is_rejected_before_quitting(self):
        with tempfile.TemporaryDirectory() as folder:
            for staged in (Path(folder) / "missing.zip", Path(folder)):
                calls, installed, result = self._apply(staged)
                self.assertIsInstance(result, ValueError)
                self.assertEqual(calls, [])
                self.assertEqual(installed["version"], "0.17.0")

    def test_corrupt_package_rejected_by_replace_is_not_installed_or_relaunched(self):
        def reject(installed, package):
            if package.read_bytes() != b"PK-good":
                raise RuntimeError("Downloaded update checksum failed")
            installed["version"] = "0.18.0"
        with tempfile.TemporaryDirectory() as folder:
            staged = Path(folder) / "GenDragoon-Cloud-SSD-Mac-v0.18.0.zip"
            staged.write_bytes(b"corrupt")
            calls, installed, result = self._apply(staged, replace=reject)
        self.assertIsInstance(result, RuntimeError)
        self.assertEqual(calls, ["quit", "replace"])
        self.assertEqual(installed["version"], "0.17.0", "the old version stays installed")

    def test_failed_install_keeps_old_version_and_does_not_relaunch_a_half_install(self):
        def fail(installed, package):
            raise OSError("disk full while replacing the bundle")
        with tempfile.TemporaryDirectory() as folder:
            staged = Path(folder) / "GenDragoon-Cloud-SSD-Mac-v0.18.0.zip"
            staged.write_bytes(b"PK-good")
            calls, installed, result = self._apply(staged, replace=fail)
        self.assertIsInstance(result, OSError)
        self.assertEqual(calls, ["quit", "replace"])
        self.assertEqual(installed["version"], "0.17.0")

    def test_successful_update_relaunches_the_new_version(self):
        with tempfile.TemporaryDirectory() as folder:
            staged = Path(folder) / "GenDragoon-Cloud-SSD-Mac-v0.18.0.zip"
            staged.write_bytes(b"PK-good")
            calls, installed, result = self._apply(staged)
        self.assertEqual(calls, ["quit", "replace", "relaunch"])
        self.assertEqual(result, ["0.18.0"])

    def test_relaunch_offer_rejects_missing_or_linked_companion(self):
        with tempfile.TemporaryDirectory() as folder:
            app = Path(folder) / "GenDragoon Cloud SSD.app"
            (app / "Contents/Resources").mkdir(parents=True)
            with self.assertRaisesRegex(RuntimeError, "not installed"):
                redxai.offer_relaunch(app)
            elsewhere = Path(folder) / "Elsewhere.app"
            elsewhere.mkdir()
            (app / "Contents/Resources/Red-XAI Updater.app").symlink_to(elsewhere)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                redxai.offer_relaunch(app)


if __name__ == "__main__":
    unittest.main()
