"""Focused fixtures for safe notarization, durable receipts and Apple JSON output."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import stat
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "notarize_macos.py"
spec = importlib.util.spec_from_file_location("gd_notarize", MODULE)
notary = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notary)
SUBMISSION = "ae351563-c50b-435c-85c6-20b2241797d9"
OTHER_SUBMISSION = "6d42d386-24d9-4249-88a0-948d18df44a2"


def app_fixture(root):
    # macOS may expose its temporary directory through the /var symlink.
    app = Path(root).resolve() / notary.APP_NAME
    (app / "Contents/MacOS").mkdir(parents=True)
    (app / "Contents/_CodeSignature").mkdir()
    (app / "Contents/MacOS" / notary.EXECUTABLE).write_bytes(b"signed executable fixture")
    (app / "Contents/_CodeSignature/CodeResources").write_bytes(b"resource seal fixture")
    with (app / "Contents/Info.plist").open("wb") as target:
        plistlib.dump({"CFBundleIdentifier": notary.BUNDLE_ID,
                       "CFBundleExecutable": notary.EXECUTABLE,
                       "CFBundleShortVersionString": "0.17.0",
                       "CFBundleVersion": "20"}, target)
    return app


class NotarizationSafetyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = app_fixture(self.tmp.name)
        self.receipt = self.app.parent / notary.RECEIPT_NAME
        self.commands = []
        self.info_status = "Accepted"
        self.info_id = SUBMISSION
        self.submit_result = {"id": SUBMISSION, "name": "GenDragoon-notary-upload.zip"}
        self.submit_timeout = False
        self.info_timeout = False
        self.info_hook = None
        self.fail_command = None
        self.warn_stderr = False
        self.inspect = patch.object(notary, "inspect", return_value=(self.app, "0.17.0", "20"))
        self.inspect.start()
        self.addCleanup(self.inspect.stop)
        self.disk = patch.object(notary.shutil, "disk_usage", return_value=SimpleNamespace(free=14*1024**3))
        self.disk.start()
        self.addCleanup(self.disk.stop)
        self.run = patch.object(notary.subprocess, "run", side_effect=self.command)
        self.run.start()
        self.addCleanup(self.run.stop)

    def command(self, argv, **kwargs):
        self.commands.append(argv)
        if self.fail_command and self.fail_command in argv:
            return SimpleNamespace(returncode=69, stdout="", stderr="private authentication detail")
        if argv[0] == "/usr/bin/ditto":
            Path(argv[-1]).write_bytes(b"test submission archive")
        if "submit" in argv:
            self.assertNotIn("--wait", argv)
            marker = notary.read_receipt(self.receipt)
            self.assertEqual(marker["state"], "submitting")
            self.assertIsNone(marker["submissionId"])
            if self.submit_timeout:
                raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
            output = json.dumps(self.submit_result)
        elif "info" in argv:
            # The actual durable receipt must already exist before any wait.
            marker = notary.read_receipt(self.receipt)
            self.assertEqual(marker["submissionId"], SUBMISSION)
            if self.info_timeout:
                raise subprocess.TimeoutExpired(argv, kwargs["timeout"])
            if self.info_hook:
                self.info_hook()
            output = json.dumps({"id": self.info_id, "status": self.info_status})
        else:
            output = ""
        return SimpleNamespace(returncode=0, stdout=output,
                               stderr="Non-JSON diagnostic warning\n" if self.warn_stderr else "")

    def invoke(self, **kwargs):
        return notary.notarize(self.app, "GenDragoonNotary", wait_seconds=0, **kwargs)

    def count(self, word):
        return sum(word in argv for argv in self.commands)

    def test_check_only_never_contacts_apple_or_creates_receipt(self):
        result = notary.notarize(self.app, "", check_only=True)
        self.assertEqual(self.commands, [])
        self.assertFalse(self.receipt.exists())
        self.assertFalse(result["notarized"])
        self.assertEqual(result["mode"], "source_preflight_only")

    def test_no_profile_refuses_before_notary_activity(self):
        with self.assertRaisesRegex(notary.NotarizationError, "Keychain profile"):
            notary.notarize(self.app, "")
        self.assertEqual(self.commands, [])

    def test_storage_shortfall_blocks_before_credentials(self):
        with patch.object(notary.shutil, "disk_usage", return_value=SimpleNamespace(free=8*1024**3)):
            with self.assertRaisesRegex(notary.NotarizationError, "insufficient free storage"):
                self.invoke()
        self.assertEqual(self.commands, [])
        self.assertFalse(self.receipt.exists())

    def test_bad_credentials_never_submit_staple_or_leak_diagnostics(self):
        self.fail_command = "history"
        with self.assertRaises(notary.NotarizationError) as outcome:
            self.invoke()
        self.assertNotIn("private authentication detail", str(outcome.exception))
        self.assertEqual(len(self.commands), 1)
        self.assertFalse(self.receipt.exists())

    def test_stderr_warning_does_not_corrupt_accepted_json(self):
        self.warn_stderr = True
        result = self.invoke()
        self.assertTrue(result["notarized"])
        self.assertEqual(result["submissionId"], SUBMISSION)

    def test_accepted_submission_requires_staple_gatekeeper_and_final_receipt(self):
        result = self.invoke()
        self.assertTrue(result["gatekeeperAccepted"])
        self.assertEqual(self.count("submit"), 1)
        self.assertEqual(self.count("staple"), 1)
        self.assertEqual(self.count("validate"), 1)
        self.assertTrue(any(argv[0] == "/usr/sbin/spctl" for argv in self.commands))
        record = notary.read_receipt(self.receipt)
        self.assertEqual(record["state"], "complete")
        self.assertEqual(record["submissionId"], SUBMISSION)
        self.assertEqual(stat.S_IMODE(self.receipt.stat().st_mode), 0o600)
        self.assertEqual(list(self.app.parent.glob("gd-notary-*")), [])

    def test_processing_receipt_resumes_same_submission_without_second_upload(self):
        self.info_status = "In Progress"
        result = self.invoke()
        self.assertEqual(result["status"], "pending")
        self.assertEqual(self.count("staple"), 0)
        self.info_status = "Accepted"
        result = self.invoke()
        self.assertTrue(result["notarized"])
        self.assertEqual(self.count("submit"), 1)
        self.assertEqual(self.count("/usr/bin/ditto"), 1)
        self.assertEqual([argv[3] for argv in self.commands if "info" in argv], [SUBMISSION, SUBMISSION])

    def test_status_timeout_keeps_receipt_and_retry_uses_same_submission(self):
        self.info_timeout = True
        result = self.invoke()
        self.assertEqual(result["reason"], "status_check_timed_out")
        self.assertEqual(notary.read_receipt(self.receipt)["submissionId"], SUBMISSION)
        self.info_timeout = False
        result = self.invoke()
        self.assertTrue(result["notarized"])
        self.assertEqual(self.count("submit"), 1)

    def test_ambiguous_upload_timeout_blocks_automatic_resubmission(self):
        self.submit_timeout = True
        with self.assertRaises(notary.AppleToolTimeout):
            self.invoke()
        self.assertEqual(notary.read_receipt(self.receipt)["state"], "submitting")
        before = list(self.commands)
        with self.assertRaisesRegex(notary.NotarizationError, "outcome is uncertain"):
            self.invoke()
        self.assertEqual(self.commands, before)

    def test_missing_submission_id_blocks_automatic_resubmission(self):
        self.submit_result = {"status": "Accepted"}
        with self.assertRaisesRegex(notary.NotarizationError, "valid submission ID"):
            self.invoke()
        before = list(self.commands)
        with self.assertRaisesRegex(notary.NotarizationError, "outcome is uncertain"):
            self.invoke()
        self.assertEqual(self.commands, before)

    def test_rejected_submission_is_retained_and_never_stapled_or_resubmitted(self):
        self.info_status = "Invalid"
        with self.assertRaisesRegex(notary.NotarizationError, "not accepted"):
            self.invoke()
        self.assertEqual(notary.read_receipt(self.receipt)["state"], "rejected")
        before = list(self.commands)
        with self.assertRaisesRegex(notary.NotarizationError, "not accepted"):
            self.invoke()
        self.assertEqual(self.commands, before)
        self.assertEqual(self.count("staple"), 0)

    def test_different_submission_response_never_staples(self):
        self.info_id = OTHER_SUBMISSION
        with self.assertRaisesRegex(notary.NotarizationError, "different submission ID"):
            self.invoke()
        self.assertEqual(self.count("staple"), 0)
        self.assertEqual(notary.read_receipt(self.receipt)["submissionId"], SUBMISSION)

    def test_modified_build_cannot_reuse_submission_receipt(self):
        self.info_status = "In Progress"
        self.invoke()
        (self.app / "Contents/MacOS" / notary.EXECUTABLE).write_bytes(b"different build")
        before = list(self.commands)
        with self.assertRaisesRegex(notary.NotarizationError, "does not match"):
            self.invoke()
        self.assertEqual(self.commands, before)

    def test_modified_build_after_acceptance_is_not_stapled(self):
        self.info_hook = lambda: (self.app / "Contents/MacOS" / notary.EXECUTABLE).write_bytes(b"late change")
        with self.assertRaisesRegex(notary.NotarizationError, "changed after submission"):
            self.invoke()
        self.assertEqual(self.count("staple"), 0)

    def test_staple_failure_can_retry_same_accepted_submission(self):
        self.fail_command = "staple"
        with self.assertRaises(notary.NotarizationError):
            self.invoke()
        self.assertEqual(notary.read_receipt(self.receipt)["state"], "accepted")
        self.fail_command = None
        self.assertTrue(self.invoke()["notarized"])
        self.assertEqual(self.count("submit"), 1)

    def test_completed_receipt_still_revalidates_ticket_without_new_upload(self):
        self.invoke()
        self.fail_command = "validate"
        with self.assertRaises(notary.NotarizationError):
            self.invoke()
        self.assertEqual(self.count("submit"), 1)
        self.assertEqual(self.count("validate"), 2)

    def test_competing_invocation_is_rejected_before_apple_calls(self):
        with notary.receipt_lock(self.receipt):
            with self.assertRaisesRegex(notary.NotarizationError, "already using"):
                self.invoke()
        self.assertEqual(self.commands, [])

    def test_receipt_cannot_be_inside_bundle_or_outside_staging_folder(self):
        for path in (self.app / "receipt.json", self.app.parent.parent / "receipt.json"):
            with self.subTest(path=path):
                with self.assertRaisesRegex(notary.NotarizationError, "beside the staged app"):
                    self.invoke(receipt=path)
        self.assertEqual(self.commands, [])

    def test_receipt_symlink_cannot_read_or_overwrite_another_file(self):
        original = self.app.parent / "keep.txt"
        original.write_text("preserve this content")
        self.receipt.symlink_to(original)
        with self.assertRaises(OSError):
            self.invoke()
        self.assertEqual(original.read_text(), "preserve this content")
        self.assertEqual(self.commands, [])

    def test_shared_receipt_cannot_be_replaced(self):
        self.info_status = "In Progress"
        self.invoke()
        alias = self.app.parent / "shared.json"
        os.link(self.receipt, alias)
        old = alias.read_bytes()
        before = list(self.commands)
        with self.assertRaisesRegex(notary.NotarizationError, "Unsafe notarization receipt"):
            self.invoke()
        self.assertEqual(alias.read_bytes(), old)
        self.assertEqual(self.commands, before)

    def test_fifo_receipt_is_rejected_without_blocking(self):
        os.mkfifo(self.receipt, 0o600)
        with self.assertRaisesRegex(notary.NotarizationError, "Unsafe notarization receipt"):
            self.invoke()
        self.assertEqual(self.commands, [])

    def test_inconsistent_receipt_cannot_start_a_second_submission(self):
        self.info_status = "In Progress"
        self.invoke()
        record = notary.read_receipt(self.receipt)
        record["state"] = "prepared"
        notary.write_receipt(self.receipt, record)
        before = list(self.commands)
        with self.assertRaisesRegex(notary.NotarizationError, "Contradictory"):
            self.invoke()
        self.assertEqual(self.commands, before)

    def test_cli_reports_pending_with_exit_two(self):
        self.info_status = "In Progress"
        with patch("builtins.print") as output:
            status = notary.main(["--app", str(self.app), "--keychain-profile", "GenDragoonNotary", "--wait-seconds", "0"])
        self.assertEqual(status, 2)
        self.assertEqual(json.loads(output.call_args.args[0])["submissionId"], SUBMISSION)


class StagingGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.app = app_fixture(self.tmp.name)

    def test_private_stopped_staging_path_is_accepted(self):
        self.assertEqual(notary.staged_path(self.app), self.app)
        with patch.object(notary.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="")):
            notary.stopped(self.app)

    def test_standard_system_and_user_install_locations_are_rejected(self):
        for root in (Path("/Applications"), Path("/System/Applications"), Path.home() / "Applications"):
            with self.subTest(root=root):
                with self.assertRaisesRegex(notary.NotarizationError, "not staging folders"):
                    notary.staged_path(root / notary.APP_NAME)

    def test_alias_parent_is_rejected(self):
        alias = self.app.parent / "alias"
        alias.symlink_to(self.app.parent, target_is_directory=True)
        with self.assertRaisesRegex(notary.NotarizationError, "aliases"):
            notary.staged_path(alias / notary.APP_NAME)

    def test_nested_app_location_is_rejected(self):
        nested = self.app / "Contents/Resources" / notary.APP_NAME
        with self.assertRaisesRegex(notary.NotarizationError, "another app bundle"):
            notary.staged_path(nested)

    def test_symlink_and_hardlinked_bundle_files_are_rejected(self):
        extra = self.app / "Contents/unsafe"
        target = self.app / "Contents/Info.plist"
        extra.symlink_to(target)
        with self.assertRaisesRegex(notary.NotarizationError, "Unsafe"):
            notary.staged_path(self.app)
        extra.unlink()
        os.link(target, extra)
        with self.assertRaisesRegex(notary.NotarizationError, "Unsafe"):
            notary.staged_path(self.app)

    def test_shared_writable_staging_folder_is_rejected(self):
        self.app.parent.chmod(0o777)
        with self.assertRaisesRegex(notary.NotarizationError, "private staging"):
            notary.staged_path(self.app)

    def test_open_resource_or_executable_blocks_notarization(self):
        for result in (SimpleNamespace(returncode=0, stdout="p123\nn/path/resource\n", stderr=""),
                       SimpleNamespace(returncode=1, stdout="p123\n", stderr="")):
            with self.subTest(code=result.returncode):
                with patch.object(notary.subprocess, "run", return_value=result):
                    with self.assertRaisesRegex(notary.NotarizationError, "running or in use"):
                        notary.stopped(self.app)

    def test_incomplete_process_inspection_fails_closed(self):
        with patch.object(notary.subprocess, "run", return_value=SimpleNamespace(returncode=1, stdout="", stderr="warning")):
            with self.assertRaisesRegex(notary.NotarizationError, "fully inspect"):
                notary.stopped(self.app)

    def test_signature_description_is_read_from_stderr(self):
        signature = ("Identifier=" + notary.BUNDLE_ID + "\nTeamIdentifier=" + notary.TEAM_ID +
                     "\nAuthority=Developer ID Application: Example\n")
        def command(argv, **kwargs):
            if argv[0] == "/usr/sbin/lsof":
                return SimpleNamespace(returncode=1, stdout="", stderr="")
            return SimpleNamespace(returncode=0, stdout="", stderr=signature if "-dv" in argv else "")
        with patch.object(notary.sys, "platform", "darwin"), patch.object(notary.subprocess, "run", side_effect=command):
            self.assertEqual(notary.inspect(self.app), (self.app, "0.17.0", "20"))


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
        with tempfile.TemporaryDirectory(prefix="gd-package-fixture-") as folder, \
             patch.object(package.sys, "platform", "darwin"), \
             patch.object(package.subprocess, "run", side_effect=command):
            app = Path(folder) / "GenDragoon Cloud SSD.app"
            app.mkdir()
            with self.assertRaisesRegex(RuntimeError, "stapled Apple notarization ticket"):
                package.package(app, Path(folder) / "unused-release", candidate=False)
        self.assertTrue(any("-R" in args for args in commands))
        self.assertTrue(any("stapler" in args for args in commands))


if __name__ == "__main__":
    unittest.main()
