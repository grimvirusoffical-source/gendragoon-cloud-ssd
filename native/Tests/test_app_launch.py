"""Disposable lifecycle and cache-safety fixtures. No apps, mounts, or cloud calls."""
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

RESOURCES = Path(__file__).resolve().parents[1] / "Resources"
lib_spec = importlib.util.spec_from_file_location("launch_library_fixture", RESOURCES / "gendragoon_library.py")
library = importlib.util.module_from_spec(lib_spec)
lib_spec.loader.exec_module(library)
workspace_spec = importlib.util.spec_from_file_location("launch_workspace_fixture", RESOURCES / "gendragoon_upload_workspace.py")
workspace = importlib.util.module_from_spec(workspace_spec)
workspace_spec.loader.exec_module(workspace)
with patch.dict(sys.modules, {"gendragoon_library": library}):
    spec = importlib.util.spec_from_file_location("app_launch_fixture", RESOURCES / "gendragoon_app_launch.py")
    launch = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(launch)


class AppLaunchTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gd-launch-")
        self.home = Path(self.temporary.name)
        self.home.chmod(0o700)
        self.support = self.home / "Library/Application Support/GenDragoon Cloud SSD"
        self.support.mkdir(parents=True, mode=0o700)
        self.config = self.support / "gendragoon-rclone.conf"
        self.config.write_text("[fixture]\ntype = gcs\n")
        self.config.chmod(0o600)
        self.original = self.home / "original-user-file.txt"
        self.original.write_text("Preserve original user data")
        self.stack = []
        dependencies = patch.dict(sys.modules, {"gendragoon_upload_workspace": workspace})
        dependencies.start()
        self.stack.append(dependencies)
        self.real_process_identity = launch.process_identity
        for name, value in {"HOME": self.home, "SUPPORT": self.support, "CONFIG": self.config,
                            "CACHE": self.support / "AppLibrary", "INDEX": self.support / "app-library.json",
                            "RCLONE": self.home / "rclone"}.items():
            self.add_patch(library, name, value)
        self.add_patch(launch, "ROOT", self.support / "LaunchSessions")
        self.add_patch(launch, "process_identity", return_value=None)
        self.processes = self.add_patch(launch, "process_paths", return_value={})
        self.handles = self.add_patch(launch, "open_files", return_value=[])
        self.commands = self.add_patch(library, "run", return_value='{"ok":true}')
        self.add_patch(library, "is_running", return_value=False)
        self.add_patch(library, "reply")
        self.spawn = self.add_patch(launch.subprocess, "Popen", side_effect=AssertionError("Unexpected real process"))
        self.signals = self.add_patch(launch.os, "kill", side_effect=AssertionError("Unexpected real signal"))
        self.add_patch(launch.time, "sleep")

    def add_patch(self, owner, name, *args, **kwargs):
        item = patch.object(owner, name, *args, **kwargs)
        self.stack.append(item)
        return item.start()

    def tearDown(self):
        for item in reversed(self.stack):
            item.stop()
        self.temporary.cleanup()

    def identity(self, pid, executable=None, started="Sat Oct 17 10:00:00 2026"):
        return {"pid": pid, "uid": os.getuid(), "started": started,
                "executable": str(executable or self.home / "python3")}

    def fixture(self, key="1" * 18, mode="managed-local", state="exited-retained", keep=False, cache=True):
        entry = {"name": "Fixture.app", "kind": "app", "format": "raw", "remote": "gendragoon",
                 "project": "project-one", "bucket": "bucket-one", "folder": "bucket-one/Archive",
                 "cloudPath": "bucket-one/Archive/Fixture.app"}
        library.store(key, entry)
        library.prepare_cache()
        app = library.CACHE / key / entry["name"]
        if cache and not app.exists():
            (app / "Contents/MacOS").mkdir(parents=True, mode=0o700)
            binary = app / "Contents/MacOS/Fixture"
            binary.write_bytes(b"disposable executable fixture")
            binary.chmod(0o755)
            with (app / "Contents/Info.plist").open("wb") as output:
                plistlib.dump({"CFBundleExecutable": "Fixture", "CFBundleSupportedPlatforms": ["MacOSX"]}, output)
            library.cache_record(app.parent, library.snapshot(app)["manifest"])
        identifier = ("a" if key.startswith("1") else "b") * 32
        record = {"id": identifier, "key": key, "name": entry["name"], "project": entry["project"],
                  "bucket": entry["bucket"], "remote": entry["remote"], "mode": mode, "state": state,
                  "keepCache": keep, "createdAt": 1, "cachePath": str(app)}
        if mode == "streamed":
            root = launch.ROOT / identifier
            (root / "mount").mkdir(parents=True, mode=0o700)
            (root / "vfs").mkdir(mode=0o700)
            (root / "vfs/cache-data").write_bytes(b"generated read-only cache")
            record["cachePath"] = str(root / "mount" / entry["name"])
        launch.save(record)
        return record, app

    def assert_original_intact(self):
        self.assertEqual(self.original.read_text(), "Preserve original user data")

    def test_status_without_sessions_is_read_only_and_needs_no_cloud_auth(self):
        before = sorted(str(path.relative_to(self.home)) for path in self.home.rglob("*"))
        self.assertEqual(launch.sessions(), {"sessions": [], "active": False, "busy": False})
        self.assertEqual(before, sorted(str(path.relative_to(self.home)) for path in self.home.rglob("*")))
        self.assertFalse(library.CACHE.exists())
        self.processes.assert_not_called()
        self.commands.assert_not_called()

    def test_status_rejects_partial_context_without_creating_storage(self):
        with self.assertRaises(ValueError):
            launch.sessions(project="project-one")
        self.assertFalse(launch.ROOT.exists())

    def test_status_rejects_linked_session_root_without_touching_target(self):
        launch.ROOT.symlink_to(self.home)
        with self.assertRaises(ValueError):
            launch.sessions()
        self.assert_original_intact()

    def test_receipt_supports_existing_16_and_18_character_library_keys(self):
        for key in ("1" * 16, "2" * 18):
            record, _ = self.fixture(key=key)
            self.assertEqual(launch.read(record["id"])["key"], key)
            self.assertEqual(launch.receipt_path(record["id"]).stat().st_mode & 0o777, 0o600)

    def test_receipt_rejects_forged_name_mode_context_and_cache_path(self):
        record, app = self.fixture()
        for update in ({"name": "../Other.app"}, {"name": "Other.app"}, {"mode": "arbitrary"},
                       {"project": "project-two"}, {"cachePath": str(self.home)},
                       {"watcherPid": -1}, {"keepCache": "false"}):
            with self.subTest(update=update):
                launch.save(dict(record, **update))
                with self.assertRaises(ValueError):
                    launch.read(record["id"])
        self.assertTrue(app.exists())
        self.assert_original_intact()

    def test_receipt_rejects_symlinks_and_hardlinks(self):
        record, _ = self.fixture()
        receipt = launch.receipt_path(record["id"])
        content = receipt.read_bytes()
        receipt.unlink()
        outside = self.home / "outside.json"
        outside.write_bytes(content)
        outside.chmod(0o600)
        receipt.symlink_to(outside)
        with self.assertRaises(ValueError):
            launch.read(record["id"])
        receipt.unlink()
        os.link(outside, receipt)
        with self.assertRaises(ValueError):
            launch.read(record["id"])
        self.assertEqual(outside.read_bytes(), content)

    def test_preparing_launcher_is_busy_before_watcher_exists(self):
        record, _ = self.fixture(state="preparing", cache=False)
        record.update(launcherPid=800, launcherIdentity=self.identity(800))
        launch.save(record)
        launch.process_identity.side_effect = lambda pid: self.identity(800) if pid == 800 else None
        status = launch.sessions("project-one", "bucket-one")
        self.assertTrue(status["busy"])
        self.assertTrue(status["active"])
        self.assertEqual(status["sessions"][0]["state"], "preparing")
        self.assertFalse(status["sessions"][0]["cleanupPending"])

    def test_stale_watcher_does_not_release_surviving_bundle_helper(self):
        record, app = self.fixture(state="running")
        record.update(watcherPid=800, watcherIdentity=self.identity(800))
        launch.save(record)
        self.processes.return_value = {811: str(app / "Contents/Frameworks/Helper.app/Contents/MacOS/Helper")}
        status = launch.sessions()
        self.assertTrue(status["active"])
        self.assertTrue(status["busy"])
        self.assertFalse(status["sessions"][0]["cleanupPending"])
        with self.assertRaisesRegex(RuntimeError, "helpers"):
            launch.evict(record["key"], record["project"], record["bucket"], record["remote"])
        self.assertTrue(app.exists())

    def test_surviving_open_request_keeps_session_active_after_watcher_exit(self):
        record, _ = self.fixture(state="failed-retained")
        record.update(openPid=802, openIdentity=self.identity(802, "/usr/bin/open"))
        launch.save(record)
        launch.process_identity.side_effect = lambda pid: record["openIdentity"] if pid == 802 else None
        self.assertTrue(launch.sessions()["busy"])

    def test_outside_helper_with_open_bundle_resource_blocks_cleanup(self):
        record, app = self.fixture()
        self.handles.return_value = [(803, str(app / "Contents/Resources/user-session.db"))]
        self.assertTrue(launch.sessions()["active"])
        with self.assertRaisesRegex(RuntimeError, "still running"):
            launch.cleanup(record)
        self.assertTrue(app.exists())
        self.assert_original_intact()

    def test_orphan_mount_stays_busy_even_when_receipt_says_failed(self):
        record, _ = self.fixture(mode="streamed", state="failed-retained")
        mount = launch.ROOT / record["id"] / "mount"
        with patch.object(launch.os.path, "ismount", side_effect=lambda path: Path(path) == mount):
            status = launch.sessions()
            self.assertTrue(status["busy"])
            self.assertFalse(status["sessions"][0]["cleanupPending"])
            with self.assertRaisesRegex(RuntimeError, "owner"):
                launch.stop_mount(record)
        self.signals.assert_not_called()
        self.commands.assert_not_called()

    def test_ambiguous_process_inventory_never_reports_safe_idle(self):
        self.fixture(state="running")
        self.processes.side_effect = RuntimeError("process inspection unavailable")
        with self.assertRaisesRegex(RuntimeError, "inspection"):
            launch.sessions()

    def test_interrupted_unmounted_session_is_retained_without_auto_deletion(self):
        record, app = self.fixture(state="running")
        status = launch.sessions()
        self.assertFalse(status["active"])
        self.assertEqual(status["sessions"][0]["state"], "interrupted-retained")
        self.assertTrue(app.exists())
        self.assertEqual(launch.read(record["id"])["state"], "running")

    def test_mount_stop_does_not_signal_reused_rclone_pid(self):
        record, _ = self.fixture(mode="streamed")
        record.update(mountPid=900, mountIdentity=self.identity(900, library.RCLONE))
        launch.process_identity.return_value = self.identity(900, library.RCLONE, "Sat Oct 17 11:00:00 2026")
        launch.stop_mount(record)
        self.signals.assert_not_called()
        self.commands.assert_not_called()

    def test_mount_stop_rechecks_identity_after_unmount(self):
        record, _ = self.fixture(mode="streamed")
        old = self.identity(900, library.RCLONE)
        reused = self.identity(900, library.RCLONE, "Sat Oct 17 11:00:00 2026")
        record.update(mountPid=900, mountIdentity=old)
        current = {"identity": old, "mounted": True}
        launch.process_identity.side_effect = lambda pid: current["identity"] if pid == 900 else None
        def unmount(args, timeout):
            self.assertEqual(str(args[0]), "/sbin/umount")
            current.update(identity=reused, mounted=False)
            return ""
        self.commands.side_effect = unmount
        with patch.object(launch.os.path, "ismount", side_effect=lambda _: current["mounted"]):
            launch.stop_mount(record)
        self.commands.assert_called_once()
        self.signals.assert_not_called()

    def test_mount_stop_refuses_open_resources_without_signaling(self):
        record, _ = self.fixture(mode="streamed")
        self.handles.return_value = [(800, record["cachePath"] + "/Contents/Resources/data")]
        with self.assertRaisesRegex(RuntimeError, "still holds"):
            launch.stop_mount(record)
        self.signals.assert_not_called()
        self.commands.assert_not_called()

    def test_process_identity_uses_owner_start_time_and_kernel_executable(self):
        output = subprocess.CompletedProcess([], 0, f" {os.getuid()} Sat Oct 17 10:00:00 2026\n", "")
        with patch.object(launch.subprocess, "run", return_value=output) as command, \
                patch.object(launch, "pid_path", return_value=str(library.RCLONE)):
            value = self.real_process_identity(900)
        self.assertEqual(value, self.identity(900, library.RCLONE))
        self.assertIn("lstart=", command.call_args.args[0])

    def test_matching_prefix_of_another_app_does_not_block_exact_cache(self):
        record, app = self.fixture()
        self.processes.return_value = {800: str(app) + "-other/Contents/MacOS/other"}
        self.handles.return_value = [(801, str(app) + "-other/Contents/Resources/data")]
        launch.cleanup(record)
        self.assertFalse(app.exists())
        self.assert_original_intact()
        self.assertIn(record["key"], library.load())

    def test_modified_managed_cache_is_never_deleted(self):
        record, app = self.fixture()
        (app / "Contents/MacOS/Fixture").write_bytes(b"local user changes")
        with self.assertRaisesRegex(RuntimeError, "Restored content"):
            launch.cleanup(record)
        self.assertEqual((app / "Contents/MacOS/Fixture").read_bytes(), b"local user changes")
        self.assert_original_intact()

    def test_clear_legacy_cache_without_session_still_checks_helpers(self):
        record, app = self.fixture()
        launch.receipt_path(record["id"]).unlink()
        self.handles.return_value = [(801, str(app / "Contents/Resources/data"))]
        with self.assertRaisesRegex(RuntimeError, "resources are still open"):
            launch.evict(record["key"], record["project"], record["bucket"], record["remote"])
        self.assertTrue(app.exists())

    def test_keep_cache_retains_managed_application_and_cloud_index(self):
        record, app = self.fixture(keep=True)
        before = library.load()
        launch.cleanup(record)
        self.assertTrue(app.exists())
        self.assertEqual(library.load(), before)
        self.assert_original_intact()

    def test_streamed_cleanup_only_removes_generated_unmounted_session(self):
        record, app = self.fixture(mode="streamed")
        before = library.load()
        launch.cleanup(record)
        self.assertFalse((launch.ROOT / record["id"]).exists())
        self.assertTrue(app.exists())
        self.assertEqual(library.load(), before)
        self.assert_original_intact()

    def test_unexpected_files_in_stream_cache_are_retained(self):
        record, _ = self.fixture(mode="streamed")
        notes = launch.ROOT / record["id"] / "notes.txt"
        notes.write_text("user work")
        with self.assertRaisesRegex(RuntimeError, "unexpected files"):
            launch.cleanup(record)
        self.assertEqual(notes.read_text(), "user work")

    def test_streamed_keep_cache_retains_vfs_after_safe_unmount(self):
        record, _ = self.fixture(mode="streamed", keep=True)
        launch.cleanup(record)
        self.assertTrue((launch.ROOT / record["id"] / "vfs/cache-data").exists())

    def test_duplicate_watcher_and_completed_session_replay_are_rejected(self):
        record, app = self.fixture(state="launching")
        with launch.watch_lock(record["id"]):
            with self.assertRaisesRegex(RuntimeError, "already active"):
                launch.watch(record["id"])
        record["state"] = "exited-retained"
        launch.save(record)
        with self.assertRaisesRegex(RuntimeError, "cannot be launched again"):
            launch.watch(record["id"])
        self.spawn.assert_not_called()
        self.assertTrue(app.exists())

    def test_watcher_waits_for_surviving_helpers_then_removes_unchanged_cache(self):
        record, app = self.fixture(state="launching")
        live = {"open": True, "helper": True, "idlePolls": 0}
        class Opener:
            pid = 700
            returncode = None
            def poll(self): return self.returncode
            def wait(self):
                live["open"] = False
                self.returncode = 0
                return 0
        opener = Opener()
        self.spawn.side_effect = None
        self.spawn.return_value = opener
        launch.process_identity.side_effect = lambda pid: (self.identity(pid, "/usr/bin/open" if pid == 700 else None)
            if pid == os.getpid() or (pid == 700 and live["open"]) else None)
        self.processes.side_effect = lambda: {801: str(app / "Contents/Frameworks/Helper")} if live["helper"] else {}
        def wait(seconds):
            if seconds == 1:
                self.assertTrue(app.exists(), "Cache disappeared before helpers finished")
                live["idlePolls"] += 1
                if live["idlePolls"] == 3:
                    live["helper"] = False
        launch.time.sleep.side_effect = wait
        launch.watch(record["id"])
        self.assertGreaterEqual(live["idlePolls"], 3)
        self.assertFalse(app.exists())
        self.assertEqual(launch.read(record["id"])["state"], "exited-cleaned")
        self.assert_original_intact()
        self.assertIn(record["key"], library.load())

    def test_failed_mac_launch_keeps_cache_and_records_failure(self):
        record, app = self.fixture(state="launching")
        self.spawn.side_effect = None
        self.spawn.return_value = Mock(pid=700, poll=Mock(return_value=1))
        launch.process_identity.side_effect = lambda pid: self.identity(pid)
        launch.watch(record["id"])
        self.assertEqual(launch.read(record["id"])["state"], "failed-retained")
        self.assertTrue(app.exists())

    def test_slow_launcher_handoff_never_rewrites_or_unmounts_live_watcher(self):
        record, app = self.fixture()
        launch.receipt_path(record["id"]).unlink()
        watcher = Mock(pid=700, poll=Mock(return_value=None))
        launch.process_identity.side_effect = lambda pid: self.identity(pid)
        def spawn(args, **kwargs):
            identifier = args[-1]
            latest = launch.read(identifier)
            latest.update(watcherPid=700, watcherIdentity=self.identity(700))
            launch.save(latest)
            return watcher
        self.spawn.side_effect = spawn
        with patch.object(launch.sys, "platform", "darwin"), \
                patch.object(launch, "prepare_stream", return_value=None), \
                patch.object(launch, "stop_mount") as stop:
            result = launch.launch(record["key"], record["project"], record["bucket"], record["remote"])
        self.assertEqual(result["state"], "launching")
        self.assertIn("still opening", result["message"])
        receipt = next(launch.ROOT.glob("*.json"))
        self.assertEqual(launch.read(receipt.stem)["watcherPid"], 700)
        self.assertEqual(launch.read(receipt.stem)["state"], "launching")
        stop.assert_not_called()
        self.assertTrue(app.exists())

    def test_invalid_platform_and_cross_bucket_stream_never_launch(self):
        record, app = self.fixture()
        with (app / "Contents/Info.plist").open("wb") as output:
            plistlib.dump({"CFBundleExecutable": "Fixture", "CFBundleSupportedPlatforms": ["iPhoneOS"]}, output)
        with self.assertRaisesRegex(ValueError, "another platform"):
            launch.compatible(app)
        for raw in ("bucket-two/Streamable/Fixture.app", "bucket-one/Streamable/Other.app"):
            with self.assertRaises(ValueError):
                launch.prepare_stream({"name": "Fixture.app", "streamVerified": True, "streamPath": raw}, record)
        self.spawn.assert_not_called()
        self.assert_original_intact()

    def test_existing_byte_verified_stream_with_metadata_or_unknown_metadata_uses_local_copy(self):
        record, app = self.fixture()
        raw = "bucket-one/Streamable/Fixture.app"
        manifests = [None, [], [{"path": ".", "type": "directory"}]]
        for name in ("com.apple.ResourceFork", "com.apple.quarantine", "com.apple.FinderInfo", "app.example.empty"):
            manifests.append([{"path": ".", "type": "directory", "xattrs": {}},
                              {"path": "Contents/resource", "type": "file", "xattrs": {name: {"size": 0}}}])
        with patch.object(library, "require_space") as capacity:
            for manifest in manifests:
                with self.subTest(manifest=manifest):
                    data = {"name": "Fixture.app", "streamVerified": True, "streamPath": raw, "manifest": manifest}
                    self.assertIsNone(launch.prepare_stream(data, record))
                    self.assertEqual(record["mode"], "managed-local")
                    self.assertIn("metadata", record["streamIneligibleReason"])
            capacity.assert_not_called()
        self.spawn.assert_not_called()
        self.assertTrue(app.exists())
        self.assertFalse((launch.ROOT / record["id"]).exists())
        self.assert_original_intact()

    def test_known_metadata_free_stream_reaches_the_existing_capacity_guard(self):
        record, _ = self.fixture()
        manifest = [{"path": ".", "type": "directory", "xattrs": {}},
                    {"path": "Contents/main", "type": "file", "xattrs": {}},
                    {"path": "link", "type": "symlink", "target": "Contents/main"}]
        data = {"name": "Fixture.app", "streamVerified": True,
                "streamPath": "bucket-one/Streamable/Fixture.app", "manifest": manifest}
        with patch.object(library, "require_space", side_effect=RuntimeError("fixture capacity guard")):
            with self.assertRaisesRegex(RuntimeError, "fixture capacity guard"):
                launch.prepare_stream(data, record)
        self.assertNotIn("streamIneligibleReason", record)
        self.spawn.assert_not_called()
        self.assert_original_intact()

    def test_managed_local_eviction_retains_unexpected_sibling_files_folders_and_links(self):
        record, app = self.fixture()
        for kind in ("file", "folder", "link"):
            sibling = app.parent / ("user-created-" + kind)
            if kind == "folder":
                sibling.mkdir()
                (sibling / "saved.txt").write_text("Preserve user-created sibling data")
            elif kind == "link":
                sibling.symlink_to(self.original)
            else:
                sibling.write_text("Preserve user-created sibling data")
            for action in (lambda: launch.cleanup(record),
                           lambda: launch.evict(record["key"], record["project"], record["bucket"], record["remote"]),
                           lambda: library.clear_cache(record["key"], record["project"], record["bucket"], record["remote"])):
                with self.subTest(kind=kind), self.assertRaisesRegex(RuntimeError, "unexpected files"):
                    action()
                self.assertTrue(app.exists())
                self.assertTrue(sibling.exists())
                self.assertEqual((sibling / "saved.txt" if kind == "folder" else sibling).read_text(),
                                 "Preserve original user data" if kind == "link" else "Preserve user-created sibling data")
                self.assertIn(record["key"], library.load())
                self.assert_original_intact()
            if kind == "folder":
                shutil.rmtree(sibling)
            else:
                sibling.unlink()

    def test_sibling_created_during_cache_verification_is_not_recursively_deleted(self):
        record, app = self.fixture()
        sibling = app.parent / "saved-during-verification.txt"
        verify = library.verify_restored
        def create_sibling(path, manifest):
            verified = verify(path, manifest)
            sibling.write_text("Preserve concurrently created sibling data")
            return verified
        with patch.object(library, "verify_restored", side_effect=create_sibling):
            with self.assertRaisesRegex(RuntimeError, "unexpected files were retained"):
                launch.cleanup(record)
        self.assertEqual(sibling.read_text(), "Preserve concurrently created sibling data")
        self.assertFalse(app.exists())
        self.assertIn(record["key"], library.load())
        self.assert_original_intact()

    def test_nested_file_created_after_verification_survives_manifest_bounded_cleanup(self):
        record, app = self.fixture()
        nested = app / "Contents/MacOS/user-created-data.txt"
        manifest_path = app.parent / "cache-manifest.json"
        metadata = manifest_path.read_bytes()
        verify = library.verify_restored
        def create_nested(path, manifest):
            verified = verify(path, manifest)
            nested.write_text("Preserve nested user data created after verification")
            return verified
        with patch.object(library, "verify_restored", side_effect=create_nested):
            with self.assertRaisesRegex(RuntimeError, "unverified content retained"):
                launch.cleanup(record)
        self.assertEqual(nested.read_text(), "Preserve nested user data created after verification")
        self.assertEqual(manifest_path.read_bytes(), metadata)
        self.assertIn(record["key"], library.load())
        self.assert_original_intact()

    def test_changed_manifest_leaf_is_retained_after_verification(self):
        record, app = self.fixture()
        leaf = app / "Contents/Info.plist"
        verify = library.verify_restored
        def change_leaf(path, manifest):
            verified = verify(path, manifest)
            leaf.write_text("User replacement created after verification")
            return verified
        with patch.object(library, "verify_restored", side_effect=change_leaf):
            with self.assertRaisesRegex(RuntimeError, "item changed"):
                launch.cleanup(record)
        self.assertEqual(leaf.read_text(), "User replacement created after verification")
        self.assertTrue((app / "Contents/MacOS/Fixture").exists())
        self.assertTrue((app.parent / "cache-manifest.json").exists())
        self.assertIn(record["key"], library.load())
        self.assert_original_intact()

    def test_replaced_parent_symlink_cannot_redirect_manifest_leaf_deletion(self):
        record, app = self.fixture()
        outside = self.home / "outside-user-directory"
        outside.mkdir()
        original = outside / "Info.plist"
        original.write_text("Preserve outside user data")
        verify = library.verify_restored
        def swap_parent(path, manifest):
            verified = verify(path, manifest)
            (app / "Contents").rename(app / "SavedContents")
            (app / "Contents").symlink_to(outside, target_is_directory=True)
            return verified
        with patch.object(library, "verify_restored", side_effect=swap_parent):
            with self.assertRaises(OSError):
                launch.cleanup(record)
        self.assertEqual(original.read_text(), "Preserve outside user data")
        self.assertTrue((app / "SavedContents/Info.plist").exists())
        self.assertTrue((app.parent / "cache-manifest.json").exists())
        self.assertIn(record["key"], library.load())
        self.assert_original_intact()


if __name__ == "__main__":
    unittest.main()
