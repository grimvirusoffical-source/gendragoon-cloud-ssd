"""Disposable tests for offloaded-app launch, safe Trash and opt-in quitting.

No Finder, application process, account token or actual cloud is touched.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Resources"))
import gendragoon_library as library
import gendragoon_upload_workspace as upload


class OffloadedAppRecovery(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="gd-offload-fixtures-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name) / "home"
        self.home.mkdir(mode=0o700)
        self.support = self.home / "Library/Application Support/GenDragoon Cloud SSD"
        self.cache = self.support / "AppLibrary"
        self.key = "a" * 18
        self.digest = "b" * 64
        self.manifest_id = "c" * 32
        self.workspace = "d" * 32
        for name, value in (("HOME", self.home), ("SUPPORT", self.support),
                            ("CACHE", self.cache), ("INDEX", self.support / "app-library.json")):
            patcher = patch.object(library, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.item = {"key": self.key, "name": "Sample.app", "kind": "app",
                     "workspace": self.workspace, "archiveBytes": 1024,
                     "archiveSha256": self.digest, "manifestId": self.manifest_id}
        self.entry = {"name": "Sample.app", "kind": "app", "format": "redxai",
                      "remote": "redxai", "folder": self.workspace + "/Library",
                      "project": "redxai", "bucket": self.workspace,
                      "redxManifestId": self.manifest_id, "sha256": self.digest,
                      "offloaded": True, "manifest": [], "source": str(self.home / "Sample.app")}
        library.store(self.key, self.entry)

    def fake_module(self, *, manifest=None, item=None, root=None):
        returned = item or self.item
        expected_manifest = manifest or [
            {"path": ".", "type": "directory", "executable": 0},
            {"path": "Contents/Info.plist", "type": "file", "size": 1024, "sha256": self.digest, "executable": 0}]
        expected_root = root or {"name": "Sample.app", "kind": "app",
                                  "archiveBytes": 1024, "archiveSha256": self.digest}
        return types.SimpleNamespace(
            find_item=lambda cfg, key: returned,
            read_archive_manifest=lambda cfg, it: {"root": expected_root, "manifest": expected_manifest})

    def test_offloaded_app_without_local_cache_restores_verified_size_manifest(self):
        with patch.object(library, "redx_config", return_value={"workspaceId": self.workspace}), \
             patch.object(library, "redx_module", return_value=self.fake_module()):
            refreshed = library.hydrate_launch_manifest(
                self.key, self.entry, "redxai", self.workspace, "redxai")
        self.assertEqual(refreshed["sizeBytes"], 1024)
        self.assertTrue(refreshed["offloaded"])
        self.assertTrue(refreshed["manifest"])
        self.assertEqual(library.load()[self.key]["manifest"], refreshed["manifest"])
        self.assertFalse((self.home / "Sample.app").exists())

    def test_replaced_cloud_root_cannot_authorize_cache_preflight(self):
        wrong = dict(self.item, archiveSha256="e" * 64)
        with patch.object(library, "redx_config", return_value={"workspaceId": self.workspace}), \
             patch.object(library, "redx_module", return_value=self.fake_module(item=wrong)):
            with self.assertRaisesRegex(RuntimeError, "revision changed"):
                library.hydrate_launch_manifest(self.key, self.entry, "redxai", self.workspace, "redxai")
        self.assertFalse(library.load()[self.key]["manifest"])

    def test_inode_replacement_is_rejected_but_incidental_timestamps_are_not(self):
        source = self.home / "record"
        source.write_bytes(b"unchanged")
        before = library.snapshot(source)
        os.utime(source, ns=(source.stat().st_atime_ns, source.stat().st_mtime_ns + 3_000_000_000))
        library.unchanged(source, before)
        source.write_bytes(b"changed")
        with self.assertRaisesRegex(RuntimeError, "content"):
            library.unchanged(source, before)

    def test_trash_fallback_is_same_volume_and_keeps_recoverable_copy(self):
        source = self.home / "app-copy"
        source.write_bytes(b"verified content")
        with patch.object(library, "run", side_effect=RuntimeError("Finder cannot script")):
            library.trash(source)
        self.assertFalse(source.exists())
        matches = list((self.home / ".Trash").glob("app-copy.GenDragoon-*"))
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].read_bytes(), b"verified content")

    def test_force_quit_refuses_non_macos_and_untrusted_bundle(self):
        with patch.object(library.sys, "platform", "linux"):
            with self.assertRaisesRegex(RuntimeError, "macOS"):
                library.quit_app_for_upload(self.home / "untrusted.app")
        with patch.object(library.sys, "platform", "darwin"):
            with self.assertRaisesRegex(ValueError, "actual macOS"):
                library.quit_app_for_upload(self.home / "untrusted.app")

    def test_opted_in_quit_uses_exact_owned_executable_identity(self):
        app = self.home / "Test.app"
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/Info.plist").write_bytes(b"fixture")
        executable = str(app / "Contents/MacOS/Test")
        identity = {"pid": 321, "uid": os.getuid(),
                    "started": "Oct 27", "executable": executable}
        active = {321: identity}
        signals = []
        def fake_signal(pid, sig):
            signals.append((pid, sig))
            active.pop(pid, None)
        import gendragoon_app_launch as monitor
        with patch.object(library.sys, "platform", "darwin"), \
             patch.object(monitor, "process_paths", return_value={321: executable, 999: "/Other.app/Contents/MacOS/Other"}), \
             patch.object(monitor, "process_identity", side_effect=lambda pid: active.get(pid)), \
             patch.object(library.os, "kill", side_effect=fake_signal), \
             patch.object(library.time, "sleep"):
            self.assertTrue(library.quit_app_for_upload(app))
        self.assertEqual(len(signals), 1)
        self.assertEqual(signals[0][0], 321)

    def test_reused_pid_never_receives_signal(self):
        app = self.home / "Test.app"
        (app / "Contents/MacOS").mkdir(parents=True)
        (app / "Contents/Info.plist").write_bytes(b"fixture")
        exe = str(app / "Contents/MacOS/Test")
        first = {"pid": 321, "uid": os.getuid(), "started": "initial", "executable": exe}
        reused = dict(first, started="different")
        import gendragoon_app_launch as monitor
        with patch.object(library.sys, "platform", "darwin"), \
             patch.object(monitor, "process_paths", return_value={321: exe}), \
             patch.object(monitor, "process_identity", side_effect=[first, reused]), \
             patch.object(library.os, "kill") as signaled:
            with self.assertRaisesRegex(RuntimeError, "reused"):
                library.quit_app_for_upload(app)
        signaled.assert_not_called()

    def test_offload_flag_survives_a_concurrent_metadata_only_library_refresh(self):
        latest = library.load()[self.key]
        latest["displayName"] = "New display name"
        library.store(self.key, latest)
        library.mark_offloaded(self.key, self.entry)
        result = library.load()[self.key]
        self.assertTrue(result["offloaded"])
        self.assertEqual(result["displayName"], "New display name")
        self.assertIn("trashedAt", result)

    def test_offload_flag_rejects_a_different_archive_revision(self):
        latest = library.load()[self.key]
        latest["sha256"] = "e" * 64
        library.store(self.key, latest)
        with self.assertRaisesRegex(RuntimeError, "revision changed"):
            library.mark_offloaded(self.key, self.entry)
        self.assertEqual(library.load()[self.key]["sha256"], "e" * 64)

    def test_workspace_refuses_force_quit_without_macos_opt_in(self):
        with self.assertRaisesRegex(upload.WorkspaceError, "macOS"):
            upload.enqueue(0, False, home=self.home, close_running_apps=True)


if __name__ == "__main__":
    unittest.main()
