"""Safety regression tests for the staged-only Apple notarization helper."""
import importlib.util
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "notarize_macos.py"
spec = importlib.util.spec_from_file_location("gd_notarize", MODULE)
notary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notary)

class NotarizationSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = Path(self.tmp.name) / notary.APP_NAME
        self.app.mkdir()
        self.inspect = patch.object(notary, "inspect", return_value=(self.app, "0.17.0", "20"))
        self.inspect.start()
        self.addCleanup(self.inspect.stop)

    def test_check_only_never_contacts_apple_or_changes_app(self):
        with patch.object(notary, "execute") as execute:
            result = notary.notarize(self.app, "", check_only=True)
        execute.assert_not_called()
        self.assertFalse(result["notarized"])
        self.assertEqual(result["mode"], "source_preflight_only")

    def test_no_profile_refuses_before_notary_activity(self):
        with patch.object(notary, "execute") as execute:
            with self.assertRaisesRegex(notary.NotarizationError, "Keychain profile"):
                notary.notarize(self.app, "")
        execute.assert_not_called()

    def test_storage_shortfall_blocks_before_credentials(self):
        with patch.object(notary, "execute") as execute, patch.object(notary.shutil, "disk_usage",
                return_value=SimpleNamespace(free=8*1024**3)):
            with self.assertRaisesRegex(notary.NotarizationError, "insufficient free storage"):
                notary.notarize(self.app, "GenDragoonNotary")
        execute.assert_not_called()

    def test_bad_credentials_never_staple_or_replace(self):
        def command(argv, timeout=120):
            raise notary.NotarizationError("Apple tool failed")
        with patch.object(notary.shutil, "disk_usage", return_value=SimpleNamespace(free=14*1024**3)), \
             patch.object(notary, "execute", side_effect=command) as execute:
            with self.assertRaises(notary.NotarizationError):
                notary.notarize(self.app, "GenDragoonNotary")
        self.assertEqual(execute.call_count, 1)
        self.assertEqual(execute.call_args.args[0][1:3], ["notarytool", "history"])

    def test_rejected_submission_never_staples(self):
        commands = []
        def command(argv, timeout=120):
            commands.append(argv)
            if "submit" in argv:
                return '{"status":"Invalid","id":"fake-id"}'
            return ""
        with patch.object(notary.shutil, "disk_usage", return_value=SimpleNamespace(free=14*1024**3)), \
             patch.object(notary, "execute", side_effect=command):
            with self.assertRaisesRegex(notary.NotarizationError, "not accepted"):
                notary.notarize(self.app, "GenDragoonNotary")
        self.assertFalse(any("stapler" in c for c in commands))

    def test_accepted_submission_requires_staple_validation(self):
        commands = []
        def command(argv, timeout=120):
            commands.append(argv)
            if "submit" in argv:
                return '{"status":"Accepted","id":"fake-id"}'
            return ""
        with patch.object(notary.shutil, "disk_usage", return_value=SimpleNamespace(free=14*1024**3)), \
             patch.object(notary, "execute", side_effect=command):
            result = notary.notarize(self.app, "GenDragoonNotary")
        self.assertTrue(result["gatekeeperAccepted"])
        self.assertTrue(any("stapler" in c and "staple" in c for c in commands))
        self.assertTrue(any("stapler" in c and "validate" in c for c in commands))
        self.assertTrue(any("/usr/sbin/spctl" in c for c in commands))

class PackagingFailClosedTests(unittest.TestCase):
    def test_production_package_rejects_missing_stapled_ticket(self):
        package_spec = importlib.util.spec_from_file_location("gd_package",
                Path(__file__).resolve().parents[1] / "package_macos.py")
        package = importlib.util.module_from_spec(package_spec)
        package_spec.loader.exec_module(package)
        commands = []
        def command(argv, **kwargs):
            commands.append(argv)
            code = 1 if "stapler" in argv else 0
            return SimpleNamespace(returncode=code)
        with patch.object(package.sys, "platform", "darwin"), \
             patch.object(package.subprocess, "run", side_effect=command):
            with self.assertRaisesRegex(RuntimeError, "stapled Apple notarization ticket"):
                package.package(Path("/fake/GenDragoon Cloud SSD.app"),
                                Path("/fake/unused-release"), candidate=False)
        self.assertTrue(any("-R" in args for args in commands))
        self.assertTrue(any("stapler" in args for args in commands))

if __name__ == "__main__":
    unittest.main()
