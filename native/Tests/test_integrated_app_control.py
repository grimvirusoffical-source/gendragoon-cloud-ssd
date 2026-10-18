"""Local restart fixtures; no app quits, mounts, Keychain or cloud access."""
import fcntl
import errno
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

HELPER = Path(__file__).resolve().parents[1] / "Resources/gendragoon_app_control.py"
spec = importlib.util.spec_from_file_location("gendragoon_app_control", HELPER)
control = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = control
spec.loader.exec_module(control)


class AppControlTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gd-reset-fixture-")
        self.home = Path(self.temporary.name).resolve()
        self.home.chmod(0o700)
        self.app = self.home / "Applications" / control.APP_NAME
        (self.app / "Contents/MacOS").mkdir(parents=True)
        self.executable = self.app / "Contents/MacOS/GenDragoon Cloud SSD"
        self.executable.write_bytes(b"fixture binary, never executed")
        with (self.app / "Contents/Info.plist").open("wb") as stream:
            plistlib.dump({"CFBundleIdentifier": control.BUNDLE_ID, "CFBundleExecutable": "GenDragoon Cloud SSD"}, stream)
        self.identity = control.ProcessIdentity(1234, str(self.executable), "Sat Oct 17 10:00:00 2026")
        self.request_id = "1" * 32

    def tearDown(self):
        self.temporary.cleanup()

    def assertCode(self, code, function, *args, **kwargs):
        with self.assertRaises(control.ControlError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def worker(self, **overrides):
        defaults = {
            "preflight": self.identity,
            "wait_for_exit": None,
            "trusted_bundle": self.executable,
            "ensure_idle": None,
            "relaunch": 2345,
        }
        defaults.update(overrides)
        patches = []
        for name, value in defaults.items():
            if isinstance(value, Exception):
                patches.append(patch.object(control, name, side_effect=value))
            else:
                patches.append(patch.object(control, name, return_value=value))
        for item in patches:
            item.start()
        reader, writer = os.pipe()
        try:
            code = control.run_worker(1234, self.app, False, writer, self.request_id, home=self.home)
            message = json.loads(os.read(reader, 4096))
            status = control.read_status(self.home, self.request_id)
            return code, message, status
        finally:
            os.close(reader)
            for item in reversed(patches):
                item.stop()

    def test_restart_preserves_all_user_cloud_config_and_cache_data(self):
        protected = [
            self.home / "originals/photo.jpg",
            self.home / "GenDragoon Cloud SSD/cloud-file.txt",
            control.support(self.home) / "app-library.json",
            control.support(self.home) / "gendragoon-rclone.conf",
            control.support(self.home) / "AppCache/Example.app/Contents/data",
            self.home / "Library/Keychains/login.keychain-db",
            control.support(self.home) / "AutoUpdates/previous-version.app/keep",
        ]
        for index, path in enumerate(protected):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"sentinel" + str(index).encode())
        # The updater owns this private directory; retain its bytes and modes.
        (control.support(self.home) / "AutoUpdates").chmod(0o700)
        before = {str(path): (path.read_bytes(), path.stat().st_mode) for path in protected}
        with patch.object(control, "command") as external:
            code, acknowledgement, status = self.worker()
        self.assertEqual(code, 0)
        self.assertEqual(acknowledgement["state"], "scheduled")
        self.assertEqual(status["state"], "restarted")
        self.assertEqual(before, {str(path): (path.read_bytes(), path.stat().st_mode) for path in protected})
        external.assert_not_called()  # Fixtures never contact Keychain or a cloud API.

    def test_active_cloud_mount_blocks_restart(self):
        mounted = (("localhost:/", "/Users/example/GenDragoon Cloud SSD", "nfs"),)
        with patch.object(control, "mounted_volumes", return_value=mounted), patch.object(control, "processes") as processes:
            self.assertCode("active_mount", control.ensure_idle, self.app)
        processes.assert_not_called()

    def test_ui_busy_and_resource_helpers_block_restart(self):
        self.assertCode("busy", control.ensure_idle, self.app, True)
        with patch.object(control, "mounted_volumes", return_value=(("/dev/disk", "/", "apfs"),)):
            for arguments in (
                str(self.app / "Contents/Resources/rclone") + " copy fixture remote:",
                "python3 " + str(self.app / "Contents/Resources/gendragoon_library.py") + " upload",
            ):
                with self.subTest(arguments=arguments), patch.object(control, "processes", return_value=[(321, 1234, os.getuid(), arguments)]):
                    self.assertCode("busy", control.ensure_idle, self.app)

    def test_unobservable_mounts_fail_closed(self):
        with patch.object(control, "mounted_volumes", side_effect=control.ControlError("inspection_failed")), \
                patch.object(control, "processes") as processes:
            self.assertCode("inspection_failed", control.ensure_idle, self.app)
        processes.assert_not_called()

    def test_native_source_target_and_filesystem_markers_preserve_busy_guard(self):
        for volume in (
            ("remote:gen-dragoon", "/Volumes/Other (Archive)", "nfs"),
            ("localhost:/", "/Volumes/CloudSSD \\040", "nfs"),
            ("localhost:/", "/Volumes/Other", "rclone"),
        ):
            with self.subTest(volume=volume), patch.object(control, "mounted_volumes", return_value=(volume,)), \
                    patch.object(control, "command") as command, patch.object(control, "processes") as processes:
                self.assertCode("active_mount", control.ensure_idle, self.app)
            command.assert_not_called()
            processes.assert_not_called()

    def test_wrong_pid_or_owner_is_refused(self):
        with patch.object(control, "kernel_path", return_value="/Applications/Another.app/Contents/MacOS/Another"):
            self.assertCode("wrong_pid", control.identify, 1234, self.executable)
        result = subprocess.CompletedProcess([], 0, "99999 Sat Oct 17 10:00:00 2026\n", "")
        with patch.object(control, "kernel_path", return_value=str(self.executable)), patch.object(control, "command", return_value=result):
            self.assertCode("wrong_pid", control.identify, 1234, self.executable)

    def test_protected_unrelated_names_never_require_executable_path_access(self):
        protected = ["loginwindow", "ScreenTimeAgent", "com.apple.Safari.SafeBrowsing.S",
                     "XProtect", "XProtectPluginService", "UsageTrackingAgent", "dmd"]
        names = {600 + index: name for index, name in enumerate(protected)}
        names.update({700: self.executable.name, 701: "sleep", 702: self.executable.name})
        rows = [(pid, 1, os.getuid(), str(self.executable)) for pid in names]
        rows.append((703, 1, os.getuid() + 1, str(self.executable)))
        queried = []
        def read_name(pid, buffer, size):
            self.assertEqual(size, 32)
            buffer.value = os.fsencode(names[pid])
            return len(buffer.value)
        def read_path(pid):
            queried.append(pid)
            if pid == 700: return str(self.executable)
            if pid == 702: return "/another/GenDragoon Cloud SSD"
            raise control.ControlError("inspection_failed")
        library = Mock(proc_name=Mock(side_effect=read_name))
        identity = subprocess.CompletedProcess([], 0, str(os.getuid()) + " Sat Oct 17 10:00:00 2026\n", "")
        with patch.object(control, "processes", return_value=rows), \
             patch.object(control.ctypes, "CDLL", return_value=library), \
             patch.object(control, "kernel_path", side_effect=read_path), \
             patch.object(control, "command", return_value=identity) as command:
            self.assertEqual(control.app_pids(self.executable), [700])
        self.assertEqual(queried, [700, 700, 702])
        command.assert_called_once_with(["/bin/ps", "-p", "700", "-o", "uid=", "-o", "lstart="])

    def test_potential_target_path_denial_and_identity_change_still_fail_closed(self):
        row = [(700, 1, os.getuid(), "untrusted argv text")]
        with patch.object(control, "processes", return_value=row), \
             patch.object(control, "kernel_name", return_value=self.executable.name):
            with patch.object(control, "kernel_path", side_effect=control.ControlError("inspection_failed")):
                self.assertCode("inspection_failed", control.app_pids, self.executable)
            with patch.object(control, "kernel_path", side_effect=[str(self.executable), "/another/executable"]):
                self.assertCode("wrong_pid", control.app_pids, self.executable)

    def test_kernel_name_exit_race_is_absent_but_live_inspection_denial_blocks(self):
        def denied(*args):
            control.ctypes.set_errno(errno.EPERM)
            return 0
        with patch.object(control.ctypes, "CDLL", return_value=Mock(proc_name=Mock(side_effect=denied))):
            with patch.object(control.os, "kill", side_effect=ProcessLookupError):
                self.assertIsNone(control.kernel_name(700))
            with patch.object(control.os, "kill", return_value=None):
                self.assertCode("inspection_failed", control.kernel_name, 700)

    def test_kernel_name_truncation_only_narrows_documented_name_fields(self):
        executable = Path("/fixture/" + "x" * 40)
        for name in ("x" * 15, "x" * 31):
            with patch.object(control, "kernel_name", return_value=name):
                self.assertTrue(control.candidate_name(700, executable))
        for name in ("x" * 14, "x" * 30, "unrelated", None):
            with patch.object(control, "kernel_name", return_value=name):
                self.assertFalse(control.candidate_name(700, executable))

    def test_wrong_bundle_identity_is_refused_before_signature_command(self):
        with (self.app / "Contents/Info.plist").open("wb") as stream:
            plistlib.dump({"CFBundleIdentifier": "unrelated.app", "CFBundleExecutable": "GenDragoon Cloud SSD"}, stream)
        with patch.object(control, "command") as command:
            self.assertCode("invalid_app", control.trusted_bundle, self.app)
        command.assert_not_called()

    def test_developer_id_gatekeeper_and_arm64_required(self):
        def success(arguments, timeout=12):
            return subprocess.CompletedProcess(arguments, 0, "arm64\n" if arguments[0].endswith("lipo") else "", "")
        with patch.object(control, "command", side_effect=success) as checked:
            self.assertEqual(control.trusted_bundle(self.app), self.executable)
        expected = ('=anchor apple generic and identifier "' + control.BUNDLE_ID
                    + '" and certificate leaf[subject.OU] = "' + control.TEAM_ID
                    + '" and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
                    + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
        self.assertEqual(checked.call_args_list[0].args[0][-2], expected)
        self.assertIn("/usr/sbin/spctl", checked.call_args_list[1].args[0])
        with patch.object(control, "command", return_value=subprocess.CompletedProcess([], 1, "", "private diagnostic omitted")):
            self.assertCode("untrusted_app", control.trusted_bundle, self.app)
        def denied_gatekeeper(arguments, timeout=12):
            return subprocess.CompletedProcess(arguments, 1, "", "") if arguments[0].endswith("spctl") else success(arguments, timeout)
        with patch.object(control, "command", side_effect=denied_gatekeeper):
            self.assertCode("untrusted_app", control.trusted_bundle, self.app)

    def test_worker_failure_before_ready_never_acknowledges_scheduled(self):
        code, acknowledgement, status = self.worker(preflight=control.ControlError("wrong_pid"))
        self.assertEqual(code, 1)
        self.assertEqual(acknowledgement["state"], "failed")
        self.assertEqual(acknowledgement["error"], "wrong_pid")
        self.assertEqual(status["error"], "wrong_pid")

    def test_update_lock_contention_is_nonblocking_and_preserves_status(self):
        existing = {"state": "waiting_for_exit", "request_id": "2" * 32}
        control.write_status(existing, self.home)
        started = time.monotonic()
        with control.update_lock(self.home):
            code, acknowledgement, status = self.worker()
        self.assertLess(time.monotonic() - started, 1)
        self.assertEqual(code, 1)
        self.assertEqual(acknowledgement["error"], "update_in_progress")
        self.assertEqual(control.read_status(self.home, "2" * 32)["state"], "waiting_for_exit")

    def test_exit_timeout_is_bounded_without_signalling_app(self):
        with patch.object(control, "kernel_path", return_value=str(self.executable)), patch.object(control, "identify", return_value=self.identity), patch.object(control.os, "kill") as kill:
            self.assertCode("exit_timeout", control.wait_for_exit, self.identity, timeout=0)
        kill.assert_not_called()
        code, ack, status = self.worker(wait_for_exit=control.ControlError("exit_timeout"))
        self.assertEqual(ack["state"], "scheduled")
        self.assertEqual(code, 1)
        self.assertEqual(status["error"], "exit_timeout")

    def test_pid_reuse_counts_as_original_exit(self):
        replaced = control.ProcessIdentity(1234, str(self.executable), "different start time")
        with patch.object(control, "kernel_path", return_value=str(self.executable)), patch.object(control, "identify", return_value=replaced):
            control.wait_for_exit(self.identity, timeout=0)

    def test_failed_launch_is_actionable_after_scheduled_ack(self):
        code, acknowledgement, status = self.worker(relaunch=control.ControlError("launch_failed"))
        self.assertEqual(acknowledgement["state"], "scheduled")
        self.assertEqual(code, 1)
        self.assertEqual(status["error"], "launch_failed")
        self.assertIn("Applications", status["message"])

    def test_open_success_alone_is_not_restart_confirmation(self):
        with patch.object(control, "app_pids", return_value=[]), patch.object(control, "command", return_value=subprocess.CompletedProcess([], 0, "", "")):
            self.assertCode("launch_unconfirmed", control.relaunch, self.app, self.executable, timeout=0)
        with patch.object(control, "app_pids", return_value=[]), patch.object(control, "command", return_value=subprocess.CompletedProcess([], 1, "", "")):
            self.assertCode("launch_failed", control.relaunch, self.app, self.executable, timeout=0)

    def test_symlinked_root_status_and_lock_are_rejected(self):
        outside = self.home / "outside"
        outside.mkdir()
        common = control.support(self.home)
        common.mkdir(parents=True)
        (common / "AppControl").symlink_to(outside, target_is_directory=True)
        self.assertCode("unsafe_path", control.write_status, {"state": "scheduled"}, self.home)
        (common / "AppControl").unlink()  # Test fixture cleanup only.
        control.write_status({"state": "scheduled", "request_id": self.request_id}, self.home)
        target = self.home / "preserved"
        target.write_bytes(b"must remain")
        status = common / "AppControl/status.json"
        status.unlink()  # Replace only this fixture-owned status.
        status.symlink_to(target)
        self.assertCode("unsafe_path", control.write_status, {"state": "scheduled"}, self.home)
        self.assertEqual(target.read_bytes(), b"must remain")
        updates = common / "AutoUpdates"
        updates.mkdir(mode=0o700)
        (updates / "update.lock").symlink_to(target)
        self.assertCode("unsafe_path", lambda: self._take_lock())
        self.assertEqual(target.read_bytes(), b"must remain")

    def _take_lock(self):
        with control.update_lock(self.home):
            pass

    def test_status_correlates_request_and_sanitizes_failure(self):
        control.write_status({"state": "failed", "request_id": self.request_id, "error": "launch_failed", "message": "secret fixture must not echo", "private": "omitted"}, self.home)
        record = control.read_status(self.home, self.request_id)
        self.assertEqual(record["error"], "launch_failed")
        self.assertNotIn("secret", json.dumps(record))
        other = control.read_status(self.home, "3" * 32)
        self.assertEqual(other, {"state": "not_found", "request_id": "3" * 32, "message": "No matching restart status was found."})
        with patch.object(control.Path, "home", return_value=self.home), patch("sys.stdout", new_callable=io.StringIO) as output:
            self.assertEqual(control.main(["status", "--request-id", self.request_id]), 0)
        self.assertEqual(json.loads(output.getvalue())["state"], "failed")

    def test_retained_worker_survives_bundle_replacement_and_reuses_exact_bytes(self):
        worker = control.retained_worker(self.home)
        self.assertNotIn(self.app, worker.parents)
        self.assertEqual(worker.read_bytes(), HELPER.read_bytes())
        self.assertEqual(worker.stat().st_mode & 0o777, 0o600)
        self.assertEqual(control.retained_worker(self.home), worker)

    def test_scheduled_ack_is_after_worker_lock_and_preflight(self):
        reader, writer = os.pipe()
        started = threading.Event()
        release = threading.Event()
        failure = []

        def verify(*_):
            # Readiness cannot be reported until the shared update lock is held.
            self.assertCode("update_in_progress", self._take_lock)
            started.set()
            self.assertTrue(release.wait(2))
            return self.identity

        def execute():
            try:
                control.run_worker(1234, self.app, False, writer, self.request_id, home=self.home)
            except Exception as error:
                failure.append(error)

        import select
        with patch.object(control, "preflight", side_effect=verify), patch.object(control, "wait_for_exit", return_value=None), patch.object(control, "trusted_bundle", return_value=self.executable), patch.object(control, "ensure_idle"), patch.object(control, "relaunch", return_value=2222):
            thread = threading.Thread(target=execute)
            thread.start()
            self.assertTrue(started.wait(2))
            self.assertFalse(select.select([reader], [], [], 0.05)[0])
            release.set()
            self.assertTrue(select.select([reader], [], [], 2)[0])
            acknowledgement = json.loads(os.read(reader, 4096))
            thread.join(2)
        os.close(reader)
        self.assertFalse(thread.is_alive())
        self.assertFalse(failure)
        self.assertEqual(acknowledgement["state"], "scheduled")
        self.assertEqual(acknowledgement["request_id"], self.request_id)

    def test_schedule_waits_for_detached_worker_ack_and_refuses_early_exit(self):
        fixture = self.home / "fixture_worker.py"
        fixture.write_text("""import json,os,sys,time
args=sys.argv
fd=int(args[args.index('--ready-fd')+1])
request_id=args[args.index('--request-id')+1]
time.sleep(0.08)
os.write(fd,(json.dumps({'state':'scheduled','request_id':request_id})+'\\n').encode())
os.close(fd)
""")
        started = time.monotonic()
        with patch.object(control, "require_mac"), patch.object(control, "retained_worker", return_value=fixture), patch.object(control.subprocess, "Popen", wraps=subprocess.Popen) as spawn:
            record = control.schedule(1234, self.app, False, home=self.home, ready_timeout=2)
        self.assertGreaterEqual(time.monotonic() - started, 0.07)
        self.assertEqual(record["state"], "scheduled")
        self.assertTrue(control.valid_request_id(record["request_id"]))
        self.assertTrue(spawn.call_args.kwargs["start_new_session"])
        self.assertEqual(len(spawn.call_args.kwargs["pass_fds"]), 1)
        fixture.write_text("raise SystemExit(1)\n")
        with patch.object(control, "require_mac"), patch.object(control, "retained_worker", return_value=fixture):
            self.assertCode("worker_failed", control.schedule, 1234, self.app, False, home=self.home, ready_timeout=2)

    def test_unacknowledged_worker_is_cancelled_and_reaped_before_failure(self):
        fixture = self.home / "unready_worker.py"
        marker = self.home / "late-restart-must-not-run"
        fixture.write_text("import time\nfrom pathlib import Path\ntime.sleep(0.4)\nPath(" + repr(str(marker)) + ").write_text('bad late action')\n")
        with patch.object(control, "require_mac"), patch.object(control, "retained_worker", return_value=fixture), patch.object(control.subprocess, "Popen", wraps=subprocess.Popen) as spawn:
            self.assertCode("worker_failed", control.schedule, 1234, self.app, False, home=self.home, ready_timeout=0.05)
        time.sleep(0.45)
        self.assertFalse(marker.exists())
        self.assertTrue(spawn.call_args.kwargs["start_new_session"])

    def test_hard_outcome_deadline_prevents_late_relaunch(self):
        reader, writer = os.pipe()
        with patch.object(control, "OUTCOME_TIMEOUT", 0.05), patch.object(control, "preflight", return_value=self.identity), patch.object(control, "wait_for_exit", side_effect=lambda *_: time.sleep(0.5)), patch.object(control, "relaunch") as relaunch:
            result = control.run_worker(1234, self.app, False, writer, self.request_id, home=self.home, enforce_deadline=True)
        acknowledgement = json.loads(os.read(reader, 4096))
        os.close(reader)
        self.assertEqual(acknowledgement["state"], "scheduled")
        self.assertEqual(result, 1)
        self.assertEqual(control.read_status(self.home, self.request_id)["error"], "operation_timeout")
        relaunch.assert_not_called()

    def test_restarted_requires_exact_kernel_identity(self):
        with patch.object(control, "app_pids", side_effect=[[], [2345]]), patch.object(control, "identify", return_value=self.identity) as identity, patch.object(control, "command", return_value=subprocess.CompletedProcess([], 0, "", "")) as launch:
            self.assertEqual(control.relaunch(self.app, self.executable, timeout=0), 2345)
        self.assertEqual(launch.call_args.args[0], ["/usr/bin/open", "-n", str(self.app)])
        identity.assert_called_once_with(2345, self.executable)


if __name__ == "__main__":
    unittest.main()
