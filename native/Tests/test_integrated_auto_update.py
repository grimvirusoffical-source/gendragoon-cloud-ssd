"""Updater safety/CLI tests using disposable bundles and mocked macOS trust tools.

These tests do not validate Apple's signature service or execute a native app.
"""
from contextlib import contextmanager, redirect_stdout
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import ssl
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock
import zipfile
import urllib.request


SCRIPT = Path(__file__).parents[1] / "Resources/gendragoon_auto_update.py"
SPEC = importlib.util.spec_from_file_location("tested_auto_update", SCRIPT)
updater = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(updater)


def write_bundle(app, version="0.16.2", marker="new-good"):
    contents = app / "Contents"
    (contents / "MacOS").mkdir(parents=True)
    (contents / "Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier": updater.BUNDLE_ID,
        "CFBundleShortVersionString": version,
        "CFBundleVersion": "23" if version == "0.16.2" else "22",
        "CFBundleExecutable": "GenDragoon Cloud SSD",
        "LSMinimumSystemVersion": "14.0",
    }))
    binary = contents / "MacOS/GenDragoon Cloud SSD"
    binary.write_bytes(b"fixture binary; never executed")
    binary.chmod(0o755)
    (contents / "marker").write_text(marker)


class AutoUpdateTests(unittest.TestCase):
    def setUp(self):
        # Session inspection is a separate dependency; these fixtures model the
        # updater transaction without touching the machine's real app library.
        launcher = types.ModuleType("gendragoon_app_launch")
        launcher.sessions = mock.Mock(return_value={"active": False})
        self.mounts = (("/dev/disk3", "/", "apfs"),)
        self.mount_reader = types.ModuleType("gendragoon_app_control")
        self.mount_reader.mounted_volumes = mock.Mock(side_effect=lambda: self.mounts)
        self.mount_reader.identify = lambda pid, executable: types.SimpleNamespace(
            pid=pid, executable=str(executable), started="fixture-start")
        active = mock.patch.dict(sys.modules, {"gendragoon_app_launch": launcher,
                                              "gendragoon_app_control": self.mount_reader})
        active.start(); self.addCleanup(active.stop)
        temporary = tempfile.TemporaryDirectory(prefix="gendragoon-auto-update-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.app = self.root / "Applications" / updater.APP_NAME
        self.update_root = self.root / "Support/AutoUpdates"
        self.staged = self.update_root / "pending"
        self.status = self.update_root / "status.json"
        self.log = self.update_root / "updater.log"
        write_bundle(self.app, version="0.16.1", marker="original-good")
        self.calls = []
        self.running = []
        for name, value in {"APP": self.app, "ROOT": self.update_root, "STAGED": self.staged,
                            "STATUS": self.status, "LOG": self.log}.items():
            patch = mock.patch.object(updater, name, value)
            patch.start()
            self.addCleanup(patch.stop)

    def stage(self):
        write_bundle(self.staged / updater.APP_NAME)
        (self.staged / "pending.json").write_text(json.dumps({"version": "v0.16.2", "sha256": "a" * 64}))

    def commands(self, arguments, timeout=80):
        self.calls.append(arguments)
        tool = arguments[0]
        if tool == "/usr/bin/ditto":
            if arguments[1] == "-x":
                with zipfile.ZipFile(arguments[-2]) as package:
                    package.extractall(arguments[-1])
                    for entry in package.infolist():
                        (Path(arguments[-1]) / entry.filename).chmod((entry.external_attr >> 16) & 0o777)
            else:
                shutil.copytree(arguments[1], arguments[2])
        elif tool == "/usr/bin/codesign":
            if "--verify" in arguments:
                marker = Path(arguments[-1]) / "Contents/marker"
                if marker.read_text() not in ("new-good", "original-good"):
                    raise RuntimeError("fixture signed-resource tampering detected")
                self.assertIn("--deep", arguments)
                self.assertIn("--strict", arguments)
                expected = ('=anchor apple generic and identifier "' + updater.BUNDLE_ID
                            + '" and certificate leaf[subject.OU] = "' + updater.TEAM_ID
                            + '" and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
                            + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
                self.assertEqual(arguments[arguments.index("-R") + 1], expected)
            if "-dv" in arguments:
                return ("Identifier=" + updater.BUNDLE_ID + "\nTeamIdentifier=" + updater.TEAM_ID
                        + "\nAuthority=Developer ID Application: Fixture (" + updater.TEAM_ID + ")")
        elif tool == "/usr/bin/lipo":
            return "arm64"
        elif tool == "/usr/bin/open":
            self.running = [4200]
        elif tool == "/usr/bin/osascript":
            self.running = []
        return ""

    @contextmanager
    def mac(self, command=None):
        with mock.patch.object(updater, "subprocess_ok", side_effect=command or self.commands), \
                mock.patch.object(updater.platform, "machine", return_value="arm64"), \
                mock.patch.object(updater.platform, "mac_ver", return_value=("14.5", (), "")), \
                mock.patch.object(updater, "app_pids", side_effect=lambda app=None: self.running.copy()), \
                mock.patch.object(updater.time, "sleep"), \
                mock.patch.object(updater, "sufficient_space"):
            yield

    def assert_original(self):
        self.assertEqual((self.app / "Contents/marker").read_text(), "original-good")

    def test_no_update_does_not_restart(self):
        with self.mac(), mock.patch.object(updater, "latest", return_value=None):
            self.assertIsNone(updater.prepare(quiet=True))
            result = updater.install_worker(relaunch=True)
        self.assertEqual(result["event"], "up_to_date")
        self.assertFalse(any(command[0] == "/usr/bin/open" for command in self.calls))
        self.assert_original()

    def test_check_message_does_not_claim_draft_build_is_installed(self):
        with mock.patch.object(updater, "latest", return_value=None), redirect_stdout(io.StringIO()) as output:
            updater.check()
        record = json.loads(output.getvalue())
        self.assertEqual(record["event"], "up_to_date")
        self.assertEqual(record["message"], "No newer eligible stable release is published.")

    def test_redirect_transport_rejects_http_downgrade_and_userinfo(self):
        handler = updater.HTTPSOnlyRedirect()
        request = urllib.request.Request("https://github.com/example/releases/file.zip")
        for target in ("http://objects.githubusercontent.com/file.zip",
                       "https://user:password@objects.githubusercontent.com/file.zip"):
            with self.subTest(target=target), self.assertRaisesRegex(RuntimeError, "requires HTTPS"):
                handler.redirect_request(request, None, 302, "Found", {}, target)
        result = handler.redirect_request(request, None, 302, "Found", {},
                                          "https://objects.githubusercontent.com/file.zip")
        self.assertEqual(result.full_url, "https://objects.githubusercontent.com/file.zip")

    def test_transport_preserves_tls_validation_context(self):
        request = urllib.request.Request("https://api.github.com/repos/example/releases")
        with mock.patch.object(updater.urllib.request, "build_opener") as build:
            updater.open_https(request, timeout=25)
        handlers = build.call_args.args
        self.assertTrue(any(isinstance(handler, updater.HTTPSOnlyRedirect) for handler in handlers))
        https = next(handler for handler in handlers if isinstance(handler, urllib.request.HTTPSHandler))
        self.assertIs(https._context, updater.CTX)
        self.assertTrue(https._context.check_hostname)
        self.assertEqual(https._context.verify_mode, ssl.CERT_REQUIRED)
        build.return_value.open.assert_called_once_with(request, timeout=25)

    def test_initial_non_https_transport_is_rejected_before_open(self):
        with mock.patch.object(updater.urllib.request, "build_opener") as build, \
                self.assertRaisesRegex(RuntimeError, "requires HTTPS"):
            updater.open_https(urllib.request.Request("http://example.invalid/update.zip"), timeout=1)
        build.assert_not_called()

    def test_latest_uses_stable_published_mac_release_only(self):
        def release(version, draft=False, prerelease=False, mac=True):
            filename = updater.ZIP_PREFIX + version + ".zip"
            base = "https://github.com/" + updater.REPO + "/releases/download/" + version + "/"
            assets = [{"name": "sha256.txt", "browser_download_url": base + "sha256.txt"}]
            if mac:
                assets.append({"name": filename, "browser_download_url": base + filename})
            return {"tag_name": version, "draft": draft, "prerelease": prerelease, "assets": assets}
        releases = [release("v9.0.0", draft=True), release("v8.0.0", prerelease=True),
                    release("v0.16.4", mac=False), release("v0.16.2"), release("v0.16.1")]
        with mock.patch.object(updater, "request_json", return_value=releases):
            self.assertEqual(updater.latest()["version"], "v0.16.2")

    def test_active_mount_blocks_install(self):
        self.stage()
        self.mounts = (("gendragoon:", "/Volumes/GenDragoon (Archive)", "macfuse"),)
        with self.mac():
            result = updater.install_worker(relaunch=True)
        self.assertEqual(result["event"], "postponed")
        self.assert_original()
        self.assertFalse(any(command[0] in ("/usr/bin/ditto", "/usr/bin/open") for command in self.calls))

    def test_native_inventory_failure_preserves_app_and_staged_update(self):
        self.stage()
        self.mount_reader.mounted_volumes.side_effect = RuntimeError("snapshot unavailable")
        with self.mac():
            result = updater.install_worker(relaunch=True)
        self.assertEqual(result["event"], "postponed")
        self.assert_original()
        self.assertTrue((self.staged / updater.APP_NAME / "Contents/marker").is_file())
        self.assertFalse(any(command[0] in ("/usr/bin/ditto", "/usr/bin/osascript", "/usr/bin/open")
                             for command in self.calls))

    def test_snapshot_reader_does_not_execute_a_mount_command_or_touch_a_volume(self):
        with mock.patch.object(updater.subprocess, "check_output") as command, \
                mock.patch.object(updater.os.path, "ismount") as stat_mount:
            self.assertFalse(updater.active_mount())
        self.mount_reader.mounted_volumes.assert_called_once()
        command.assert_not_called()
        stat_mount.assert_not_called()

    def test_pid_zero_cannot_replace_running_app(self):
        self.stage()
        self.running = [100]
        with self.mac():
            result = updater.install_worker(pid=0, relaunch=True)
        self.assertEqual(result["event"], "postponed")
        self.assertEqual(json.loads(self.status.read_text())["reason"], "app_running")
        self.assert_original()

    def test_app_starting_after_staging_blocks_install(self):
        self.stage()
        def busy_after_copy(arguments, timeout=80):
            result = self.commands(arguments, timeout)
            if arguments[0] == "/usr/bin/ditto":
                self.running = [100]
            return result
        with self.mac(busy_after_copy):
            result = updater.install_worker(relaunch=True)
        self.assertEqual(result["event"], "postponed")
        self.assert_original()

    def test_staged_tampering_fails_without_mutation_or_restart(self):
        self.stage()
        (self.staged / updater.APP_NAME / "Contents/marker").write_text("tampered")
        with self.mac(), self.assertRaisesRegex(RuntimeError, "tampering"):
            updater.install_worker(relaunch=True)
        self.assert_original()
        self.assertFalse(any(command[0] == "/usr/bin/open" for command in self.calls))

    def test_tampering_during_candidate_copy_is_rechecked(self):
        self.stage()
        def tamper_after_copy(arguments, timeout=80):
            result = self.commands(arguments, timeout)
            if arguments[0] == "/usr/bin/ditto":
                (self.staged / updater.APP_NAME / "Contents/marker").write_text("tampered")
            return result
        with self.mac(tamper_after_copy), self.assertRaisesRegex(RuntimeError, "tampering"):
            updater.install_worker(relaunch=True)
        self.assert_original()

    def test_update_and_checked_restart_preserve_backup_and_user_data(self):
        self.stage()
        data = self.root / "user-settings"
        data.write_text("keep this")
        old_backup = self.update_root / "previous-version.app"
        old_backup.mkdir()
        (old_backup / "keep").write_text("pre-existing backup")
        with self.mac():
            result = updater.install_worker(relaunch=True)
        status = json.loads(self.status.read_text())
        self.assertEqual(result["event"], "installed")
        self.assertEqual((self.app / "Contents/marker").read_text(), "new-good")
        self.assertEqual((Path(status["backupPath"]) / "Contents/marker").read_text(), "original-good")
        self.assertEqual(Path(status["backupPath"]).parent, self.app.parent)
        self.assertEqual((old_backup / "keep").read_text(), "pre-existing backup")
        self.assertEqual(data.read_text(), "keep this")
        self.assertEqual(status["launchStatus"], "exact_executable_observed")
        self.assertEqual(status["functionalReadiness"], "not_tested")
        self.assertEqual(status["launchedProcesses"], [{"pid":4200,"uid":os.getuid(),
                         "executable":str(self.app/"Contents/MacOS/GenDragoon Cloud SSD"),"started":"fixture-start"}])
        self.assertTrue(any(command == ["/usr/bin/open", "-n", str(self.app)] for command in self.calls))

    def test_launch_failure_rolls_back_previous_app(self):
        self.stage()
        def fail_launch(arguments, timeout=80):
            if arguments[0] == "/usr/bin/open" and (self.app / "Contents/marker").read_text() == "new-good":
                raise RuntimeError("fixture open failed")
            return self.commands(arguments, timeout)
        with self.mac(fail_launch):
            self.assertEqual(updater.install_worker(relaunch=True)["event"], "rolled_back")
        self.assert_original()
        status=json.loads(self.status.read_text())
        self.assertEqual(status["state"],"rolled_back")
        self.assertEqual(status["launchStatus"],"exact_executable_observed")
        self.assertEqual(status["launchedProcesses"][0]["pid"],4200)
        self.assertTrue(Path(status["failedCopyPath"]).exists())

    def test_failed_replacement_restores_previous_app(self):
        self.stage()
        replace = updater.os.replace
        def fail_candidate(source, destination):
            if Path(source).name == updater.APP_NAME and ".gendragoon-update-" in str(source):
                raise OSError("fixture rename failed")
            return replace(source, destination)
        with self.mac(), mock.patch.object(updater.os, "replace", side_effect=fail_candidate):
            self.assertEqual(updater.install_worker(relaunch=True)["event"], "rolled_back")
        self.assert_original()

    def test_post_replacement_trust_failure_rolls_back(self):
        self.stage()
        def fail_after_swap(arguments, timeout=80):
            if (arguments[0] == "/usr/bin/codesign" and "--verify" in arguments and arguments[-1] == str(self.app)
                    and (self.app / "Contents/marker").read_text()=="new-good"):
                raise RuntimeError("post-install trust failure")
            return self.commands(arguments, timeout)
        with self.mac(fail_after_swap):
            self.assertEqual(updater.install_worker(relaunch=True)["event"], "rolled_back")
        self.assert_original()

    def test_failed_rollback_relaunch_records_attention_and_preserves_old_app(self):
        self.stage()
        def fail_all_launches(arguments, timeout=80):
            if arguments[0] == "/usr/bin/open":raise RuntimeError("fixture launch failure")
            return self.commands(arguments,timeout)
        with self.mac(fail_all_launches),self.assertRaisesRegex(RuntimeError,"rollback needs attention"):
            updater.install_worker(relaunch=True,request_id="f"*32)
        self.assert_original()
        result=json.loads(self.status.read_text())
        self.assertEqual(result["state"],"attention")
        self.assertEqual(result["launchStatus"],"unconfirmed")
        self.assertEqual(result["request_id"],"f"*32)
        self.assertTrue(Path(result["failedCopyPath"]).exists())

    def test_verified_stage_and_original_digest_are_bound_before_replacement(self):
        self.stage()
        with self.mac():
            meta=updater.staged_valid(strict=True)
            original=updater.bundle_digest(self.app)
            bad=dict(meta,sha256="b"*64)
            with self.assertRaisesRegex(RuntimeError,"acknowledged restart"):
                updater.install_worker(expected_stage=bad,original_digest=original)
            with self.assertRaisesRegex(RuntimeError,"changed after the restart"):
                updater.install_worker(expected_stage=meta,original_digest="0"*64)
        self.assert_original()
        self.assertFalse(any(args[0] in ("/usr/bin/ditto","/usr/bin/open") for args in self.calls))

    def test_obsolete_exit_hook_cannot_install_or_relaunch(self):
        self.stage()
        with self.mac():
            result = updater.main(["auto-on-exit"])
        self.assertEqual(result, 1)
        self.assertFalse(self.calls)
        self.assert_original()

    def test_auto_on_exit_explicit_restart_optout(self):
        self.stage()
        with self.mac():
            result = updater.main(["auto-on-exit", "--no-relaunch"])
        self.assertEqual(result, 1)
        self.assert_original()
        self.assertFalse(any(command[0] == "/usr/bin/open" for command in self.calls))

    def test_unacknowledged_worker_cli_cannot_install(self):
        self.stage()
        with self.mac():
            result = updater.main(["install-worker", "--relaunch"])
        self.assertEqual(result, 1)
        self.assertFalse(self.calls)
        self.assert_original()

    def test_failed_auto_action_returns_nonzero_and_records_error(self):
        self.stage()
        (self.staged / updater.APP_NAME / "Contents/marker").write_text("tampered")
        # prepare normally retries invalid staging; isolate a failed action here.
        with self.mac(), mock.patch.object(updater, "prepare", side_effect=RuntimeError("fixture update failed")), \
                redirect_stdout(io.StringIO()) as output:
            result = updater.main(["prepare"])
        self.assertEqual(result, 1)
        self.assertEqual(json.loads(output.getvalue())["event"], "error")
        self.assertIn("fixture update failed", json.loads(output.getvalue())["message"])
        self.assert_original()

    def test_root_symlink_is_rejected_before_chmod_or_writes(self):
        victim = self.root / "victim"
        victim.mkdir(mode=0o755)
        self.update_root.parent.mkdir(parents=True)
        self.update_root.symlink_to(victim, target_is_directory=True)
        before = victim.stat().st_mode
        with self.assertRaisesRegex(RuntimeError, "symlinked"):
            updater.safe_root()
        self.assertEqual(victim.stat().st_mode, before)
        self.assertEqual(list(victim.iterdir()), [])

    def test_status_symlink_cannot_overwrite_user_file(self):
        updater.safe_root()
        victim = self.root / "user-file"
        victim.write_text("preserve")
        self.status.symlink_to(victim)
        with self.assertRaisesRegex(RuntimeError, "symlinked"):
            updater.write_status("installed")
        self.assertEqual(victim.read_text(), "preserve")

    def test_log_hardlink_cannot_append_to_user_file(self):
        updater.safe_root()
        victim = self.root / "user-file"
        victim.write_text("preserve")
        os.link(victim, self.log)
        with self.assertRaisesRegex(RuntimeError, "Unsafe managed"):
            updater.log_quiet(lambda: None)
        self.assertEqual(victim.read_text(), "preserve")

    def test_shared_lock_path_and_exclusion(self):
        with updater.update_lock(timeout=0):
            self.assertTrue((self.update_root / "update.lock").exists())
            with self.assertRaisesRegex(RuntimeError, "Another update operation"):
                with updater.update_lock(timeout=0):
                    self.fail("second writer acquired lock")

    def test_process_lookup_uses_shared_exact_identity_scanner_and_keeps_failures(self):
        expected = updater.app_executable().resolve()
        scanner = self.mount_reader.app_pids = mock.Mock(return_value=[100])
        with mock.patch.object(updater.platform, "system", return_value="Darwin"):
            self.assertEqual(updater.app_pids(), [100])
            scanner.assert_called_once_with(expected)
            scanner.side_effect = RuntimeError("inspection_failed")
            with self.assertRaisesRegex(RuntimeError, "inspection_failed"): updater.app_pids()

    def test_launch_timeout_reports_failure(self):
        with mock.patch.object(updater, "subprocess_ok", return_value=""), \
                mock.patch.object(updater, "app_pids", return_value=[]), \
                mock.patch.object(updater.time, "monotonic", side_effect=[0, 21]), \
                self.assertRaisesRegex(RuntimeError, "exact executable path"):
            updater.launch_app()

    def test_cli_actual_process_returns_nonzero_for_unsafe_root(self):
        home = self.root / "cli-home"
        control = home / "Library/Application Support/GenDragoon Cloud SSD"
        control.mkdir(parents=True)
        victim = self.root / "cli-victim"
        victim.mkdir()
        (control / "AutoUpdates").symlink_to(victim, target_is_directory=True)
        environment = os.environ.copy()
        environment.update({"HOME": str(home), "PYTHONDONTWRITEBYTECODE": "1"})
        result = subprocess.run([sys.executable, str(SCRIPT), "status"], env=environment,
                                capture_output=True, text=True, timeout=10, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout)["event"], "error")
        self.assertEqual(list(victim.iterdir()), [])

    def test_prepare_verifies_sha_before_extraction(self):
        filename = updater.ZIP_PREFIX + "v0.16.2.zip"
        release = {"version": "v0.16.2", "filename": filename,
                   "assets": {filename: "https://example.invalid/release.zip",
                              "sha256.txt": "https://example.invalid/sha256.txt"}}
        def wrong_download(url, path, *args):
            if path.name == "sha256.txt":
                path.write_text("0" * 64 + "  " + filename + "\n")
            else:
                path.write_bytes(b"wrong archive")
        with self.mac(), mock.patch.object(updater, "latest", return_value=release), \
                mock.patch.object(updater, "download", side_effect=wrong_download), \
                self.assertRaisesRegex(RuntimeError, "checksum failed"):
            updater.prepare(quiet=True)
        self.assert_original()
        self.assertFalse(any(command[0] == "/usr/bin/ditto" for command in self.calls))

    def test_prepare_preserves_unknown_files_in_previous_stage(self):
        self.staged.mkdir(parents=True)
        (self.staged / "user-recovery-file").write_text("preserve")
        source = self.root / "release-source" / updater.APP_NAME
        write_bundle(source)
        archive = self.root / "release-fixture.zip"
        with zipfile.ZipFile(archive, "w") as package:
            for path in source.rglob("*"):
                if path.is_file():
                    package.write(path, str(path.relative_to(source.parent)))
        filename = updater.ZIP_PREFIX + "v0.16.2.zip"
        release = {"version": "v0.16.2", "filename": filename,
                   "assets": {filename: "https://example.invalid/release.zip",
                              "sha256.txt": "https://example.invalid/sha256.txt"}}
        checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
        def download_fixture(url, path, *args):
            if path.name == "sha256.txt":
                path.write_text(checksum + "  " + filename + "\n")
            else:
                shutil.copyfile(archive, path)
        with self.mac(), mock.patch.object(updater, "latest", return_value=release), \
                mock.patch.object(updater, "download", side_effect=download_fixture):
            result = updater.prepare(quiet=True)
            self.assertEqual(updater.staged_valid(strict=True)["version"], "v0.16.2")
        self.assertEqual(result["version"], "v0.16.2")
        retained = list(self.update_root.glob("pending-retained-*"))
        self.assertEqual(len(retained), 1)
        self.assertEqual((retained[0] / "user-recovery-file").read_text(), "preserve")
        self.assert_original()

    def test_install_checks_space_on_destination_volume(self):
        self.stage()
        check_space = updater.sufficient_space
        def disk_usage(path):
            return shutil._ntuple_diskusage(10 ** 12, 0, 0 if Path(path) == self.app.parent else 10 ** 12)
        with self.mac(), mock.patch.object(updater, "sufficient_space", wraps=check_space), \
                mock.patch.object(updater.shutil, "disk_usage", side_effect=disk_usage), \
                self.assertRaisesRegex(RuntimeError, "preserve 10 GiB"):
            updater.install_worker(relaunch=True)
        self.assert_original()
        self.assertFalse(any(command[0] == "/usr/bin/ditto" for command in self.calls))

    def test_download_rejects_body_with_zero_declared_length(self):
        response = io.BytesIO(b"unexpected body")
        response.headers = {"Content-Length": "0"}
        with mock.patch.object(updater, "open_https", return_value=response), \
                mock.patch.object(updater, "sufficient_space"), \
                self.assertRaisesRegex(RuntimeError, "Download size mismatch"):
            updater.download("https://example.invalid/update.zip", self.root / "download", 1024, 0, 10, True)

    def test_zip_traversal_and_symlinks_are_rejected(self):
        for name, mode in (("../outside", 0o100644), (updater.APP_NAME + "/link", 0o120777)):
            with self.subTest(name=name):
                archive = self.root / "unsafe.zip"
                with zipfile.ZipFile(archive, "w") as package:
                    entry = zipfile.ZipInfo(name)
                    entry.external_attr = mode << 16
                    package.writestr(entry, b"/tmp/target")
                with mock.patch.object(updater, "sufficient_space"), self.assertRaises(RuntimeError):
                    updater.validate_zip(archive)


if __name__ == "__main__":
    unittest.main()
