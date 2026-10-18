"""Casey QA probes for PR #3 at bb704ed (Mac uploader + Red-XAI updater).

Passing tests pin behaviour that is correct today. Tests marked
``expectedFailure`` reproduce an open finding from
runs/mac-pr3-bb704ed.md; drop the marker when the fix lands.
Linux-safe: no network, no credentials, no real app bundles.
"""
import errno
import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

TESTS = Path(__file__).resolve().parent
NATIVE = TESTS.parent
sys.path.insert(0, str(NATIVE / "Resources"))
import redxai_updater as redxai  # noqa: E402

VECTORS = TESTS / "qa_vectors" / "manifest-merge"


def git_blob(data):
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def mac_merge(local, remote, last_seen):
    """Port of GDSealedManifest.merge (native/Sources/GDSealedManifest.swift:134-150).
    The Swift model has no tombstones or prunedThroughVersion, so they are dropped."""
    if remote["version"] < last_seen or local["version"] < last_seen:
        raise ValueError("older than last seen")
    by_id = {f["fileId"]: f for f in remote["files"]}
    by_id.update({f["fileId"]: f for f in local["files"]})
    return {"version": max(local["version"], remote["version"]) + 1,
            "files": sorted(({"fileId": k, "path": v["path"]} for k, v in by_id.items()), key=lambda f: f["fileId"])}


class ManifestMergeVectors(unittest.TestCase):
    def test_vendored_vectors_are_byte_identical_to_core(self):
        expected = dict(reversed(line.split()) for line in (VECTORS / "CORE_BLOBS.txt").read_text().splitlines()
                        if line and not line.startswith("#"))
        self.assertEqual(len(expected), 6)
        for name, blob in expected.items():
            self.assertEqual(git_blob((VECTORS / name).read_bytes()), blob, name)

    @unittest.expectedFailure
    def test_mac_repo_carries_the_six_core_vectors(self):
        # Finding F1: PR #3 ships none of the 6 vectors and nothing runs them.
        hits = list(NATIVE.parent.glob("fixtures/**/clock-skew.json")) + list(NATIVE.glob("ContractTests/**/clock-skew.json"))
        self.assertTrue(hits, "no manifest-merge vectors outside this QA folder")

    @unittest.expectedFailure
    def test_mac_merge_agrees_with_every_core_vector(self):
        # Finding F1: the Mac merge is a last-writer union with no tombstones, so deletes come back.
        for path in sorted(VECTORS.glob("*.json")):
            vector = json.loads(path.read_text())
            want = vector["expected"]
            got = mac_merge(vector["local"], vector["remote"], vector["lastSyncedVersion"])
            with self.subTest(path.name):
                self.assertEqual(got["files"], sorted(({"fileId": f["fileId"], "path": f["path"]} for f in want["files"]), key=lambda f: f["fileId"]))
                self.assertEqual(want.get("tombstones", []), [], "Mac cannot carry tombstones")


class SupportContactReleaseGate(unittest.TestCase):
    def run_check(self, swift_text):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "Sources").mkdir()
            (root / "Tests").mkdir()
            (root / "Sources/GDSupportContact.swift").write_text(swift_text)
            script = root / "Tests/check_support_contact_release.py"
            script.write_text((TESTS / "check_support_contact_release.py").read_text())
            return subprocess.run([sys.executable, str(script)], capture_output=True, text=True).returncode

    def current(self):
        return (NATIVE / "Sources/GDSupportContact.swift").read_text()

    def test_placeholder_fails_the_release_check(self):
        self.assertEqual(self.run_check(self.current()), 1)

    @unittest.expectedFailure
    def test_flipping_only_the_flag_cannot_ship_the_example_address(self):
        # Finding F2: the checker is a text match on the flag, not on the value.
        flipped = self.current().replace("isPlaceholder: true)", "isPlaceholder: false)")
        self.assertIn("support@example.com", flipped)
        self.assertEqual(self.run_check(flipped), 1)


class RedXAIApply(unittest.TestCase):
    def fixture(self, folder, replace):
        app = Path(folder) / "Applications/GenDragoon Cloud SSD.app"
        (app / "Contents").mkdir(parents=True)
        (app / "Contents/marker").write_text("old")
        staged = Path(folder) / "update.zip"
        staged.write_bytes(b"PK")
        entry = dict(redxai.load_manifest()[0], installPath=str(app))
        relaunched = []
        cb = dict(quit_app=lambda e: None, replace_app=lambda e, p: replace(app, p),
                  relaunch_app=lambda e, p: relaunched.append((p / "Contents/marker").read_text() if (p / "Contents/marker").exists() else None) or [p],
                  log=lambda r: None)
        return app, staged, entry, cb, relaunched

    @staticmethod
    def partial_then_enospc(app, package):
        (app / "Contents").mkdir(parents=True)
        (app / "Contents/half-copied").write_bytes(b"x" * 1024)
        raise OSError(errno.ENOSPC, "No space left on device")

    def test_real_enospc_after_partial_copy_restores_and_relaunches_old(self):
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, cb, relaunched = self.fixture(folder, self.partial_then_enospc)
            self.assertEqual(redxai.apply_and_report(entry, staged, **cb), 1)
            self.assertEqual((app / "Contents/marker").read_text(), "old")
            self.assertFalse((app / "Contents/half-copied").exists())
            self.assertEqual(relaunched, ["old"])
            self.assertEqual([p.name for p in app.parent.iterdir()], [app.name])

    @unittest.expectedFailure
    def test_failed_discard_of_half_install_still_restores_the_old_bundle(self):
        # Finding F3: if the half-installed bundle cannot be moved aside, the old bundle stays
        # in a .redxai-previous-* sibling, nothing relaunches, and the error says it is installed.
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, cb, relaunched = self.fixture(folder, self.partial_then_enospc)
            real = os.replace

            def replace(src, dst):
                if ".redxai-failed-" in str(dst):
                    raise PermissionError(errno.EACCES, "Operation not permitted")
                return real(src, dst)
            with mock.patch.object(redxai.os, "replace", side_effect=replace):
                redxai.apply_and_report(entry, staged, **cb)
            self.assertEqual((app / "Contents/marker").read_text() if (app / "Contents/marker").exists() else None, "old")

    @unittest.expectedFailure
    def test_quit_failure_returns_an_exit_code(self):
        # Finding F4: apply_and_report promises 0/1/2 but a quit_app error escapes.
        with tempfile.TemporaryDirectory() as folder:
            app, staged, entry, cb, relaunched = self.fixture(folder, lambda a, p: None)
            cb["quit_app"] = mock.Mock(side_effect=RuntimeError("quit timed out"))
            self.assertIn(redxai.apply_and_report(entry, staged, **cb), (1, 2))


class FlatFileMode(unittest.TestCase):
    def test_single_file_restore_uses_the_recorded_mode(self):
        import gendragoon_library as library
        for mode in (0o644, 0o640, 0o600, 0o755, 0o444):
            with tempfile.TemporaryDirectory() as folder:
                source = Path(folder) / "doc.txt"
                source.write_bytes(b"payload")
                source.chmod(mode)
                manifest = library.snapshot(source)["manifest"]
                self.assertEqual(library.flat_file_mode(manifest), mode, oct(mode))
                restored = Path(folder) / "restored.txt"
                restored.write_bytes(b"payload")
                restored.chmod(library.flat_file_mode(manifest))
                library.verify_restored(restored, manifest)
                restored.chmod(0o600)
                if mode != 0o600:
                    with self.assertRaises(RuntimeError, msg="forced 0600 must fail verification"):
                        library.verify_restored(restored, manifest)

    def test_legacy_manifest_without_mode_keeps_the_old_rule(self):
        import gendragoon_library as library
        self.assertEqual(library.flat_file_mode([{"executable": 0o100}]), 0o700)

    @unittest.skipUnless(sys.version_info >= (3, 13), "Path.resolve stops raising on loops in 3.13")
    @unittest.expectedFailure
    def test_looping_symlink_is_rejected_as_the_message_says(self):
        # Finding F5 (Low): "escaping or looping" but a loop passes on Python 3.13.
        import gendragoon_library as library
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / "bundle"
            root.mkdir()
            (root / "a").symlink_to("b")
            (root / "b").symlink_to("a")
            with self.assertRaisesRegex(ValueError, "looping"):
                library.snapshot(root)


if __name__ == "__main__":
    unittest.main()
