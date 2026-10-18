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

    def test_linux_relaunch_offer_raises_instead_of_returning_none(self):
        with self.assertRaises(RuntimeError):
            redxai.offer_relaunch(Path("/tmp/GenDragoon Cloud SSD.app"))

    # Failure injection for the Red-XAI apply path. A disposable bundle stands in
    # for the installed app; its marker file says which version is on disk.
    def bundle(self, path, version):
        (path / "Contents").mkdir(parents=True)
        (path / "Contents/marker").write_text(version)

    def marker(self, path):
        return (path / "Contents/marker").read_text()

    def fixture(self, folder, *, replace=None, relaunch_fails=()):
        app = Path(folder) / "Applications/GenDragoon Cloud SSD.app"
        self.bundle(app, "old")
        staged = Path(folder) / "GenDragoon-Cloud-SSD-Mac-v0.18.0.zip"
        staged.write_bytes(b"PK-good")
        entry = dict(redxai.load_manifest()[0], installPath=str(app))
        calls, logs = [], []
        def quit_app(target):
            calls.append(("quit", target["bundleId"]))
        def replace_app(target, package):
            calls.append(("replace", package.name))
            if replace:
                replace(app, package)
            else:
                self.bundle(app, "new")
        def relaunch_app(target, path):
            version = self.marker(path) if path.is_dir() else None
            calls.append(("relaunch", str(path), version))
            if version in relaunch_fails:
                raise RuntimeError("open -n failed for " + str(version))
            return [path]
        callbacks = dict(quit_app=quit_app, replace_app=replace_app, relaunch_app=relaunch_app, log=logs.append)
        return app, staged, entry, calls, logs, callbacks

    def leftovers(self, app):
        return sorted(p.name for p in app.parent.iterdir() if p.name != app.name)

    def test_missing_or_non_file_package_is_rejected_before_quitting(self):
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, calls, logs, callbacks = self.fixture(folder)
            for package in (Path(folder) / "missing.zip", Path(folder)):
                with self.assertRaises(ValueError):
                    redxai.apply_ready_update(entry, package, **callbacks)
            self.assertEqual(calls, [])
            self.assertEqual(self.marker(app), "old")

    def test_missing_installed_app_is_rejected_before_quitting(self):
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, calls, logs, callbacks = self.fixture(folder)
            entry["installPath"] = str(Path(folder) / "Applications/Missing.app")
            with self.assertRaises(ValueError):
                redxai.apply_ready_update(entry, staged, **callbacks)
            self.assertEqual(calls, [])

    def test_successful_update_relaunches_the_new_bundle_and_drops_the_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, calls, logs, callbacks = self.fixture(folder)
            result = redxai.apply_ready_update(entry, staged, **callbacks)
            self.assertEqual(calls, [("quit", "app.gendragoon.cloudssd"),
                                     ("replace", staged.name),
                                     ("relaunch", str(app), "new")])
            self.assertEqual(result, [app])
            self.assertEqual(self.marker(app), "new")
            self.assertEqual(self.leftovers(app), [])
            self.assertEqual(redxai.apply_and_report(entry, staged, **dict(callbacks)), 0)

    def test_failed_install_restores_the_old_bundle_and_relaunches_it(self):
        def fail(app, package):
            (app / "Contents").mkdir(parents=True)
            (app / "Contents/half-written").write_bytes(b"partial")
            raise OSError("disk full while replacing the bundle")
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, calls, logs, callbacks = self.fixture(folder, replace=fail)
            with self.assertRaises(redxai.RedXAIUpdateFailed):
                redxai.apply_ready_update(entry, staged, **callbacks)
            self.assertEqual(calls[-1], ("relaunch", str(app), "old"), "relaunch gets the OLD bundle")
            self.assertEqual([call[0] for call in calls], ["quit", "replace", "relaunch"])
            self.assertEqual(self.marker(app), "old")
            self.assertFalse((app / "Contents/half-written").exists())
            self.assertEqual(self.leftovers(app), [])
            self.assertIn("redxai_install_failed", [record["event"] for record in logs])

    def test_corrupt_package_rejected_by_install_keeps_and_relaunches_old(self):
        def reject(app, package):
            if package.read_bytes() != b"PK-verified":
                raise RuntimeError("Downloaded update checksum failed")
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, calls, logs, callbacks = self.fixture(folder, replace=reject)
            self.assertEqual(redxai.apply_and_report(entry, staged, **callbacks), 1)
            self.assertEqual(calls[-1], ("relaunch", str(app), "old"))
            self.assertEqual(self.marker(app), "old")

    def test_new_version_that_cannot_relaunch_rolls_back_to_old_and_relaunches_it(self):
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, calls, logs, callbacks = self.fixture(folder, relaunch_fails=("new",))
            self.assertEqual(redxai.apply_and_report(entry, staged, **callbacks), 1)
            self.assertEqual([call[2] for call in calls if call[0] == "relaunch"], ["new", "old"])
            self.assertEqual(self.marker(app), "old")
            self.assertEqual(self.leftovers(app), [])

    def test_failed_install_and_failed_old_relaunch_logs_exits_nonzero_and_keeps_old(self):
        def fail(app, package):
            raise OSError("replace failed")
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, calls, logs, callbacks = self.fixture(folder, replace=fail, relaunch_fails=("old",))
            with self.assertRaises(redxai.RedXAIRelaunchFailed):
                redxai.apply_ready_update(entry, staged, **callbacks)
            self.assertEqual(self.marker(app), "old")
            self.assertEqual(self.leftovers(app), [])
            logs.clear()
            self.assertEqual(redxai.apply_and_report(entry, staged, **callbacks), 2)
            events = [record["event"] for record in logs]
            self.assertIn("redxai_relaunch_previous_failed", events)
            self.assertIn("redxai_attention", events)
            self.assertEqual(self.marker(app), "old")

    def test_default_log_writes_json_to_stderr(self):
        import io, json
        from contextlib import redirect_stderr
        def fail(app, package):
            raise OSError("replace failed")
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, calls, logs, callbacks = self.fixture(folder, replace=fail, relaunch_fails=("old",))
            callbacks.pop("log")
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                self.assertEqual(redxai.apply_and_report(entry, staged, **callbacks), 2)
            events = [json.loads(line)["event"] for line in stderr.getvalue().splitlines()]
            self.assertIn("redxai_relaunch_previous_failed", events)

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
