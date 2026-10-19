"""Private temporary fixtures only: no real user cleanup or cloud operations."""
import fcntl
import importlib.util
import errno
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch

HELPER = Path(__file__).resolve().parents[1] / "Resources/gendragoon_drive_cleanup.py"
spec = importlib.util.spec_from_file_location("gendragoon_drive_cleanup", HELPER)
cleanup = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = cleanup
spec.loader.exec_module(cleanup)


class DriveCleanupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gd-cleanup-fixture-")
        self.home = Path(self.temporary.name)
        self.home.chmod(0o700)
        self.root = self.home / "Chosen Folder"
        self.root.mkdir()
        self.kwargs = {"home": self.home, "ui_busy": False, "active_paths": []}

    def tearDown(self):
        self.temporary.cleanup()

    def file(self, name, content=b"fixture data"):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def preview(self):
        return cleanup.preview(self.root, **self.kwargs)

    def apply(self, plan):
        return cleanup.apply(plan["plan_id"], **self.kwargs)

    def undo(self, receipt):
        return cleanup.undo(receipt["receipt_id"], **self.kwargs)

    def assertCode(self, expected, function, *args, **kwargs):
        with self.assertRaises(cleanup.CleanupError) as caught:
            function(*args, **kwargs)
        self.assertEqual(caught.exception.code, expected)
        return caught.exception

    def test_preview_all_categories_and_apply_then_undo_preserve_bytes_modes_mtime(self):
        paths = ["Tool.app/Contents/MacOS/tool", "movie.MOV", "song.flac", "photo.heic",
                 "readme.unknown", "Folder Inside/sub/data.bin", "archive.zip"]
        for index, name in enumerate(paths):
            path = self.file(name, bytes([index]) * 123)
            path.chmod(0o751 if "tool" in name else 0o640)
            os.utime(path, ns=(1234567890000000000, 1234567890000000000 + index))
        before = {name: ((self.root / name).read_bytes(), stat.S_IMODE((self.root / name).stat().st_mode),
                         (self.root / name).stat().st_mtime_ns, (self.root / name).stat().st_ino) for name in paths}
        tree_before = sorted(str(path.relative_to(self.root)) for path in self.root.rglob("*"))
        preview = self.preview()
        self.assertEqual(preview["planned_count"], 7)
        self.assertEqual(tree_before, sorted(str(path.relative_to(self.root)) for path in self.root.rglob("*")))
        destinations = {move["source"]: move["destination"] for move in preview["moves"]}
        self.assertEqual(destinations["Tool.app"], "Applications/Tool.app")
        self.assertEqual(destinations["movie.MOV"], "Media/Videos/movie.MOV")
        self.assertEqual(destinations["song.flac"], "Media/Audio/song.flac")
        self.assertEqual(destinations["photo.heic"], "Media/Pictures/photo.heic")
        self.assertEqual(destinations["readme.unknown"], "Files/readme.unknown")
        self.assertEqual(destinations["Folder Inside"], "Folders/Folder Inside")
        receipt = self.apply(preview)
        self.assertEqual(receipt["state"], "applied")
        for name in paths:
            first, _, rest = name.partition("/")
            moved = self.root / destinations[first]
            if rest:
                moved /= rest
            self.assertEqual(before[name], (moved.read_bytes(), stat.S_IMODE(moved.stat().st_mode), moved.stat().st_mtime_ns, moved.stat().st_ino))
        self.assertEqual(self.undo(receipt)["state"], "undone")
        for name in paths:
            path = self.root / name
            self.assertEqual(before[name], (path.read_bytes(), stat.S_IMODE(path.stat().st_mode), path.stat().st_mtime_ns, path.stat().st_ino))
        self.assertEqual(tree_before, sorted(str(path.relative_to(self.root)) for path in self.root.rglob("*")))
        self.assertCode("already_used", self.undo, receipt)

    def test_collision_uses_deterministic_names_without_overwriting(self):
        self.file("Files/Report.txt", b"existing")
        self.file("Files/report (2).txt", b"existing suffix")
        self.file("report.txt", b"new")
        plan = self.preview()
        self.assertEqual(plan["moves"], [{"source": "report.txt", "destination": "Files/report (3).txt"}])
        self.apply(plan)
        self.assertEqual((self.root / "Files/Report.txt").read_bytes(), b"existing")
        self.assertEqual((self.root / "Files/report (2).txt").read_bytes(), b"existing suffix")
        self.assertEqual((self.root / "Files/report (3).txt").read_bytes(), b"new")

    def test_sources_added_removed_or_modified_after_preview_are_rejected(self):
        source = self.file("file.txt")
        plan = self.preview()
        source.write_bytes(b"different bytes")
        stamp = source.stat().st_mtime_ns + 2_000_000_000  # avoid coarse-clock-tick flake
        os.utime(source, ns=(stamp, stamp))
        self.assertCode("changed", self.apply, plan)
        self.assertTrue(source.exists())
        plan = self.preview()
        self.file("new.txt")
        self.bump_dir_mtime()
        self.assertCode("changed", self.apply, plan)
        plan = self.preview()
        source.unlink()
        self.bump_dir_mtime()
        self.assertCode("changed", self.apply, plan)

    def bump_dir_mtime(self):
        stamp = self.root.stat().st_mtime_ns + 2_000_000_000  # avoid coarse-clock-tick flake
        os.utime(self.root, ns=(stamp, stamp))

    def test_destination_added_or_changed_after_preview_is_rejected(self):
        self.file("Files/existing.txt")
        self.file("fresh.txt")
        plan = self.preview()
        self.file("Files/new.txt")
        self.assertCode("changed", self.apply, plan)
        self.assertTrue((self.root / "fresh.txt").exists())

    def test_same_metadata_content_change_is_rejected(self):
        source = self.file("data", b"one")
        plan = self.preview()
        before = source.stat()
        source.write_bytes(b"two")
        os.utime(source, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertCode("changed", self.apply, plan)

    def test_modified_destination_prevents_all_undo_moves(self):
        self.file("a.txt", b"a")
        self.file("b.txt", b"b")
        receipt = self.apply(self.preview())
        (self.root / "Files/b.txt").write_bytes(b"user edits")
        self.assertCode("changed", self.undo, receipt)
        self.assertFalse((self.root / "a.txt").exists())
        self.assertEqual((self.root / "Files/b.txt").read_bytes(), b"user edits")

    def test_new_source_conflict_prevents_undo_without_overwriting(self):
        self.file("a.txt", b"old")
        receipt = self.apply(self.preview())
        self.file("a.txt", b"new")
        self.assertCode("changed", self.undo, receipt)
        self.assertEqual((self.root / "a.txt").read_bytes(), b"new")
        self.assertEqual((self.root / "Files/a.txt").read_bytes(), b"old")

    def test_mid_apply_failure_rolls_back_completed_moves(self):
        self.file("a.txt", b"a")
        self.file("b.txt", b"b")
        plan = self.preview()
        rename = cleanup.rename_exclusive
        def injected(source_fd, source, destination_fd, destination):
            if source == "b.txt":
                raise OSError("injected move failure")
            return rename(source_fd, source, destination_fd, destination)
        with patch.object(cleanup, "rename_exclusive", side_effect=injected):
            error = self.assertCode("rolled_back", self.apply, plan)
        self.assertEqual(error.receipt_id, plan["plan_id"])
        self.assertEqual((self.root / "a.txt").read_bytes(), b"a")
        self.assertEqual((self.root / "b.txt").read_bytes(), b"b")
        self.assertFalse((self.root / "Files").exists())
        self.assertCode("already_used", self.apply, plan)

    def test_rename_cannot_overwrite_even_when_destination_appears_after_validation(self):
        self.file("a.txt", b"source")
        plan = self.preview()
        rename = cleanup.rename_exclusive
        def injected(source_fd, source, destination_fd, destination):
            if source == "a.txt":
                descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=destination_fd)
                os.write(descriptor, b"racing user content")
                os.close(descriptor)
            return rename(source_fd, source, destination_fd, destination)
        with patch.object(cleanup, "rename_exclusive", side_effect=injected):
            self.assertCode("rolled_back", self.apply, plan)
        self.assertEqual((self.root / "a.txt").read_bytes(), b"source")
        self.assertEqual((self.root / "Files/a.txt").read_bytes(), b"racing user content")

    def test_links_temporary_hidden_reserved_and_special_entries_stay_put(self):
        self.file("data.txt")
        os.symlink(self.home, self.root / "link")
        self.file("partial.crdownload")
        self.file(".secret")
        (self.root / "Applications").mkdir()
        (self.root / "Folders").mkdir()
        os.mkfifo(self.root / "pipe")
        plan = self.preview()
        self.assertEqual(plan["planned_count"], 1)
        self.assertEqual(len(plan["skipped"]), 6)
        self.apply(plan)
        self.assertTrue((self.root / "link").is_symlink())
        self.assertTrue((self.root / "Applications").is_dir())
        self.assertTrue(stat.S_ISFIFO((self.root / "pipe").lstat().st_mode))

    def test_embedded_app_links_are_preserved_not_followed(self):
        self.file("Example.app/Contents/data")
        target = self.home / "outside"
        target.write_bytes(b"outside")
        os.symlink(target, self.root / "Example.app/Contents/link")
        receipt = self.apply(self.preview())
        self.assertTrue((self.root / "Applications/Example.app/Contents/link").is_symlink())
        self.assertEqual(target.read_bytes(), b"outside")
        self.undo(receipt)
        self.assertTrue((self.root / "Example.app/Contents/link").is_symlink())

    def test_busy_ui_shared_lock_and_running_apps_are_blocked(self):
        self.file("Example.app/Contents/data")
        self.assertCode("busy", cleanup.preview, self.root, **{**self.kwargs, "ui_busy": True})
        self.assertCode("busy", cleanup.preview, self.root, **{**self.kwargs, "ui_busy": None})
        active = {**self.kwargs, "active_paths": [self.root / "Example.app"]}
        self.assertEqual(cleanup.preview(self.root, **active)["planned_count"], 0)
        plan = self.preview()
        self.assertCode("busy", cleanup.apply, plan["plan_id"], **active)
        with cleanup.operation(self.home, False):
            self.assertCode("busy", self.preview)

    def test_bad_root_home_system_library_cache_and_symlink_are_refused(self):
        roots = [Path("/"), self.home, self.home / "Library", self.home / ".cache", Path("/Applications")]
        (self.home / "Library").mkdir()
        (self.home / ".cache").mkdir()
        os.symlink(self.root, self.home / "linked")
        roots.append(self.home / "linked")
        for root in roots:
            with self.subTest(root=str(root)):
                self.assertCode("unsafe_root", cleanup.preview, root, **self.kwargs)

    def test_world_writable_root_is_not_chmodded(self):
        self.root.chmod(0o777)
        self.assertCode("unsafe_root", self.preview)
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o777)

    def test_symlink_category_and_private_storage_are_refused(self):
        self.file("a.txt")
        (self.home / "outside").mkdir()
        os.symlink(self.home / "outside", self.root / "Files")
        with self.assertRaises((cleanup.CleanupError, OSError)):
            self.preview()
        (self.root / "Files").unlink()
        app_support = cleanup.support(self.home)
        app_support.mkdir(parents=True, exist_ok=True)
        private = app_support / "DriveCleanup"
        for child in private.iterdir():
            child.unlink()
        private.rmdir()
        os.symlink(self.home / "outside", private)
        self.assertCode("unsafe_state", self.preview)

    def test_tampered_plan_and_path_traversal_are_refused(self):
        self.file("file.txt")
        plan = self.preview()
        path = cleanup.support(self.home) / "DriveCleanup" / f"plan-{plan['plan_id']}.json"
        envelope = json.loads(path.read_text())
        envelope["record"]["moves"][0]["source"] = "../../outside"
        path.write_text(json.dumps(envelope))
        self.assertCode("unsafe_state", self.apply, plan)
        self.assertCode("unsafe_state", cleanup.apply, "../plan", **self.kwargs)
        self.assertTrue((self.root / "file.txt").exists())

    def test_tampered_receipt_is_refused(self):
        self.file("a.txt")
        receipt = self.apply(self.preview())
        path = cleanup.support(self.home) / "DriveCleanup" / f"receipt-{receipt['receipt_id']}.json"
        envelope = json.loads(path.read_text())
        envelope["record"]["moves"][0]["name"] = "other"
        path.write_text(json.dumps(envelope))
        self.assertCode("unsafe_state", self.undo, receipt)
        self.assertTrue((self.root / "Files/a.txt").exists())

    def test_private_plan_and_key_permissions(self):
        self.file("a.txt")
        self.preview()
        private = cleanup.support(self.home) / "DriveCleanup"
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o700)
        for path in private.iterdir():
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_apply_is_single_use_and_new_preview_does_not_reorganize_categories(self):
        self.file("a.txt")
        plan = self.preview()
        self.apply(plan)
        self.assertCode("already_used", self.apply, plan)
        self.assertEqual(self.preview()["planned_count"], 0)

    def test_source_swap_race_never_claims_success_or_loses_data(self):
        self.file("a.txt", b"approved")
        plan = self.preview()
        rename = cleanup.rename_exclusive
        swapped = False
        def injected(source_fd, source, destination_fd, destination):
            nonlocal swapped
            if source == "a.txt" and not swapped:
                swapped = True
                os.rename(self.root / "a.txt", self.root / "original-backup.txt")
                self.file("a.txt", b"unapproved replacement")
            return rename(source_fd, source, destination_fd, destination)
        with patch.object(cleanup, "rename_exclusive", side_effect=injected):
            self.assertCode("rolled_back", self.apply, plan)
        self.assertEqual((self.root / "a.txt").read_bytes(), b"unapproved replacement")
        self.assertEqual((self.root / "original-backup.txt").read_bytes(), b"approved")
        self.assertFalse((self.root / "Files/a.txt").exists())

    def test_cross_volume_failure_never_falls_back_to_copy_and_delete(self):
        self.file("a.txt", b"keep")
        plan = self.preview()
        rename = cleanup.rename_exclusive
        def injected(source_fd, source, destination_fd, destination):
            if source == "a.txt":
                raise OSError(errno.EXDEV, "different volume")
            return rename(source_fd, source, destination_fd, destination)
        with patch.object(cleanup, "rename_exclusive", side_effect=injected):
            self.assertCode("rolled_back", self.apply, plan)
        self.assertEqual((self.root / "a.txt").read_bytes(), b"keep")

    def test_undo_failure_compensation_can_be_retried(self):
        self.file("a.txt", b"a")
        self.file("b.txt", b"b")
        receipt = self.apply(self.preview())
        rename = cleanup.rename_exclusive
        def injected(source_fd, source, destination_fd, destination):
            if source == "a.txt":
                raise OSError("injected second Undo failure")
            return rename(source_fd, source, destination_fd, destination)
        with patch.object(cleanup, "rename_exclusive", side_effect=injected):
            self.assertCode("recovery_needed", self.undo, receipt)
        self.assertTrue((self.root / "Files/a.txt").exists())
        self.assertTrue((self.root / "Files/b.txt").exists())
        self.assertEqual(self.undo(receipt)["state"], "undone")
        self.assertEqual((self.root / "a.txt").read_bytes(), b"a")
        self.assertEqual((self.root / "b.txt").read_bytes(), b"b")

    def write_receipt(self, identifier, **changes):
        store = cleanup.Store(self.home)
        try:
            receipt = store.read("receipt", identifier)
            receipt.update(changes)
            store.write(f"receipt-{identifier}.json", receipt)
        finally:
            store.close()

    def test_interrupted_apply_intent_recovers_only_exact_unchanged_destination(self):
        self.file("a.txt", b"a")
        receipt = self.apply(self.preview())
        self.write_receipt(receipt["receipt_id"], state="applying", completed=[], pending=0)
        self.assertEqual(self.undo(receipt)["state"], "undone")
        self.assertEqual((self.root / "a.txt").read_bytes(), b"a")

    def test_interrupted_apply_changed_pending_destination_refuses_recovery(self):
        self.file("a.txt", b"a")
        receipt = self.apply(self.preview())
        self.write_receipt(receipt["receipt_id"], state="applying", completed=[], pending=0)
        (self.root / "Files/a.txt").write_bytes(b"changed by user")
        self.assertCode("recovery_needed", self.undo, receipt)
        self.assertEqual((self.root / "Files/a.txt").read_bytes(), b"changed by user")

    def test_interrupted_undo_resumes_exact_already_restored_source(self):
        self.file("a.txt", b"a")
        self.file("b.txt", b"b")
        receipt = self.apply(self.preview())
        self.write_receipt(receipt["receipt_id"], state="undoing", undo_pending=1)
        os.rename(self.root / "Files/b.txt", self.root / "b.txt")
        self.assertEqual(self.undo(receipt)["state"], "undone")
        self.assertEqual((self.root / "a.txt").read_bytes(), b"a")
        self.assertEqual((self.root / "b.txt").read_bytes(), b"b")

    def test_xattr_change_prevents_apply_and_undo(self):
        source = self.file("a.txt", b"a")
        try:
            os.setxattr(source, "user.fixture", b"original attribute")
        except (OSError, AttributeError):
            self.skipTest("Fixture filesystem does not support CPython Linux xattrs")
        plan = self.preview()
        os.setxattr(source, "user.fixture", b"new attribute")
        self.assertCode("changed", self.apply, plan)
        receipt = self.apply(self.preview())
        os.setxattr(self.root / "Files/a.txt", "user.fixture", b"later attribute")
        self.assertCode("changed", self.undo, receipt)

    def test_nested_transfer_and_cloud_sync_roots_stay_untouched(self):
        self.file("Folder/live.crdownload", b"partial")
        plan = self.preview()
        self.assertEqual(plan["planned_count"], 0)
        cloud = self.home / "OneDrive - Work" / "folder"
        cloud.mkdir(parents=True)
        self.assertCode("unsafe_root", cleanup.preview, cloud, **self.kwargs)


if __name__ == "__main__":
    unittest.main()
