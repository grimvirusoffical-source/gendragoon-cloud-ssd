"""Disposable-fixture safety tests; never execute a macOS app or system tool."""
import contextlib
import hashlib
import importlib.util
import io
import os
from pathlib import Path
import plistlib
import shutil
import struct
import tempfile
import unittest
from unittest import mock
import zipfile


SPEC = importlib.util.spec_from_file_location("gendragoon_installer", Path(__file__).parents[1] / "install-macos.py")
installer = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(installer)


def metadata(version=installer.VERSION, build=installer.BUILD, bundle=installer.BUNDLE_ID):
    return {"CFBundleIdentifier": bundle, "CFBundleShortVersionString": version,
            "CFBundleVersion": build, "CFBundleExecutable": installer.EXECUTABLE,
            "CFBundlePackageType": "APPL", "LSMinimumSystemVersion": "14.0"}


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gendragoon-installer-test-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.archive = self.root / "release.zip"
        self.app = self.root / "Applications" / installer.APP_NAME
        self.old_contents = self.app / "Contents"
        self.old_contents.mkdir(parents=True)
        (self.old_contents / "Info.plist").write_bytes(plistlib.dumps(metadata("0.16.1", "18")))
        (self.old_contents / "old-marker").write_text("original application")
        self.calls = []
        self.write_archive()

    def write_archive(self, info=None, extra=()):
        entries = [(installer.INFO_MEMBER, plistlib.dumps(metadata() if info is None else info), 0o100644),
                   (installer.EXECUTABLE_MEMBER,
                    b"\xcf\xfa\xed\xfe" + struct.pack("<I", 0x0100000C) + b"\x00" * 24, 0o100755),
                   (installer.APP_NAME + "/Contents/new-marker", b"new application", 0o100644)]
        entries.extend(extra)
        with zipfile.ZipFile(self.archive, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, contents, mode in entries:
                entry = zipfile.ZipInfo(name)
                entry.create_system = 3
                entry.external_attr = mode << 16
                archive.writestr(entry, contents)

    @contextlib.contextmanager
    def pin_fixture(self):
        data = self.archive.read_bytes()
        with mock.patch.object(installer, "ARCHIVE_BYTES", len(data)), \
                mock.patch.object(installer, "ARCHIVE_SHA256", hashlib.sha256(data).hexdigest()):
            yield

    def fake_command(self, arguments, timeout=90):
        self.calls.append(arguments)
        if arguments[0] == "/usr/bin/ditto":
            with zipfile.ZipFile(arguments[-2]) as archive:
                archive.extractall(arguments[-1])
                for entry in archive.infolist():
                    (Path(arguments[-1]) / entry.filename).chmod((entry.external_attr >> 16) & 0o777)
        if arguments[0] == "/usr/bin/codesign" and "-dv" in arguments:
            return ("Identifier=" + installer.BUNDLE_ID + "\nTeamIdentifier=" + installer.TEAM_ID
                    + "\nAuthority=Developer ID Application: Example (" + installer.TEAM_ID + ")\n")
        if arguments[0] == "/usr/bin/lipo":
            return "arm64\n"
        if arguments[0] == "/sbin/mount":
            return "/dev/disk3s1s1 on / (apfs, sealed, local, read-only)\n"
        return ""

    @contextlib.contextmanager
    def fake_mac(self, command=None):
        with self.pin_fixture(), \
                mock.patch.object(installer.Path, "home", return_value=self.root), \
                mock.patch.object(installer, "require_mac"), \
                mock.patch.object(installer, "run_checked", side_effect=command or self.fake_command), \
                mock.patch.object(installer, "running_pids", return_value=[]), \
                mock.patch.object(installer.os.path, "ismount", return_value=False), \
                mock.patch.object(installer.shutil, "disk_usage", return_value=shutil._ntuple_diskusage(10**12, 0, 10**12)):
            yield

    def assert_old_preserved(self):
        self.assertEqual((self.old_contents / "old-marker").read_text(), "original application")
        self.assertFalse((self.old_contents / "new-marker").exists())

    def test_shared_maintenance_busy_preserves_app_without_quit(self):
        with installer.maintenance_lock(self.root), self.fake_mac():
            with self.assertRaisesRegex(installer.InstallError, "active"):
                installer.install(self.archive, self.app.parent, restart=True)
        self.assert_old_preserved()
        self.assertFalse(any(call[0] in ("/usr/bin/ditto", "/usr/bin/osascript", "/usr/bin/open") for call in self.calls))

    def test_shared_maintenance_symlink_rejected(self):
        support = self.root / "Library/Application Support/GenDragoon Cloud SSD"
        support.parent.mkdir(parents=True)
        target = self.root / "external"
        target.mkdir()
        support.symlink_to(target, target_is_directory=True)
        with self.assertRaisesRegex(installer.InstallError, "symlink"):
            with installer.maintenance_lock(self.root):
                self.fail("Linked maintenance state must never be entered")
        self.assertEqual(list(target.iterdir()), [])

    def test_shared_maintenance_hardlink_rejected(self):
        with installer.maintenance_lock(self.root):
            pass
        root = self.root / "Library/Application Support/GenDragoon Cloud SSD/AutoUpdates"
        os.link(root / "update.lock", self.root / "other-lock-name")
        with self.assertRaisesRegex(installer.InstallError, "Unsafe"):
            with installer.maintenance_lock(self.root):
                self.fail("Hardlinked maintenance lock must not be entered")

    def test_fixture_package_verification_is_not_signature_or_readiness(self):
        with self.pin_fixture():
            result = installer.verify_archive(self.archive)
        self.assertEqual(result["status"], "package_verified_only")
        self.assertEqual(result["apple_signature_and_gatekeeper"], "not_assessed")

    def test_wrong_hash_rejected_before_replacement(self):
        with self.pin_fixture(), mock.patch.object(installer, "ARCHIVE_SHA256", "0" * 64):
            with self.assertRaisesRegex(installer.InstallError, "SHA-256"):
                installer.verify_archive(self.archive)
        self.assert_old_preserved()

    def test_wrong_bundle_identity_rejected(self):
        self.write_archive(metadata(bundle="another.vendor.app"))
        with self.pin_fixture(), self.assertRaisesRegex(installer.InstallError, "CFBundleIdentifier"):
            installer.verify_archive(self.archive)
        self.assert_old_preserved()

    def test_wrong_build_rejected(self):
        self.write_archive(metadata(build="20"))
        with self.pin_fixture(), self.assertRaisesRegex(installer.InstallError, "CFBundleVersion"):
            installer.verify_archive(self.archive)

    def test_zip_traversal_rejected_even_when_hash_matches(self):
        self.write_archive(extra=[(installer.APP_NAME + "/../../outside", b"bad", 0o100644)])
        with self.pin_fixture(), self.assertRaisesRegex(installer.InstallError, "Unsafe archive path"):
            installer.verify_archive(self.archive)
        self.assertFalse((self.root / "outside").exists())

    def test_zip_symlink_rejected_even_when_hash_matches(self):
        self.write_archive(extra=[(installer.APP_NAME + "/Contents/link", b"/tmp/target", 0o120777)])
        with self.pin_fixture(), self.assertRaisesRegex(installer.InstallError, "symlink"):
            installer.verify_archive(self.archive)

    def test_case_colliding_paths_rejected(self):
        self.write_archive(extra=[(installer.APP_NAME + "/Contents/NEW-MARKER", b"collision", 0o100644)])
        with self.pin_fixture(), self.assertRaisesRegex(installer.InstallError, "case-colliding"):
            installer.verify_archive(self.archive)

    def test_archive_symlink_rejected(self):
        link = self.root / "link.zip"
        link.symlink_to(self.archive)
        with self.pin_fixture(), self.assertRaisesRegex(installer.InstallError, "symlink"):
            installer.verify_archive(link)

    def test_destination_symlink_rejected(self):
        link = self.root / "symlink-parent"
        link.symlink_to(self.app.parent, target_is_directory=True)
        with self.assertRaisesRegex(installer.InstallError, "symlink"):
            installer.prepare_destination(link)
        self.assert_old_preserved()

    def test_non_macos_install_rejected(self):
        with mock.patch.object(installer.platform, "system", return_value="Linux"), \
                self.assertRaisesRegex(installer.InstallError, "requires macOS"):
            installer.install(self.archive, self.app.parent)
        self.assert_old_preserved()

    def test_newer_version_cannot_be_downgraded_with_reinstall(self):
        (self.old_contents / "Info.plist").write_bytes(plistlib.dumps(metadata("0.17.0", "20")))
        with self.fake_mac(), self.assertRaisesRegex(installer.InstallError, "downgrade"):
            installer.install(self.archive, self.app.parent, reinstall=True)
        self.assert_old_preserved()
        self.assertFalse(any(command[0] == "/usr/bin/ditto" for command in self.calls))

    def test_newer_same_version_build_cannot_be_downgraded(self):
        (self.old_contents / "Info.plist").write_bytes(plistlib.dumps(metadata(build="20")))
        with self.fake_mac(), self.assertRaisesRegex(installer.InstallError, "downgrade"):
            installer.install(self.archive, self.app.parent, reinstall=True)
        self.assert_old_preserved()

    def test_same_version_needs_explicit_reinstall(self):
        (self.old_contents / "Info.plist").write_bytes(plistlib.dumps(metadata()))
        with self.fake_mac(), self.assertRaisesRegex(installer.InstallError, "--reinstall"):
            installer.install(self.archive, self.app.parent)
        self.assert_old_preserved()
        with self.fake_mac():
            result = installer.install(self.archive, self.app.parent, reinstall=True)
        self.assertEqual(result["status"], "installed")

    def test_signature_failure_preserves_old_app_and_never_quits_it(self):
        def fail_signature(arguments, timeout=90):
            if arguments[0] == "/usr/bin/codesign" and "--verify" in arguments:
                raise installer.InstallError("signature rejected")
            return self.fake_command(arguments, timeout)
        with self.fake_mac(fail_signature), self.assertRaisesRegex(installer.InstallError, "signature rejected"):
            installer.install(self.archive, self.app.parent, restart=True)
        self.assert_old_preserved()
        self.assertFalse(any(command[0] in ("/usr/bin/osascript", "/usr/bin/open") for command in self.calls))

    def test_gatekeeper_failure_preserves_old_app(self):
        def fail_gatekeeper(arguments, timeout=90):
            if arguments[0] == "/usr/sbin/spctl":
                raise installer.InstallError("Gatekeeper rejected unnotarized build")
            return self.fake_command(arguments, timeout)
        with self.fake_mac(fail_gatekeeper), self.assertRaisesRegex(installer.InstallError, "Gatekeeper"):
            installer.install(self.archive, self.app.parent)
        self.assert_old_preserved()

    def test_wrong_signing_team_preserves_old_app(self):
        def wrong_identity(arguments, timeout=90):
            result = self.fake_command(arguments, timeout)
            return result.replace(installer.TEAM_ID, "WRONGTEAM")
        with self.fake_mac(wrong_identity), self.assertRaisesRegex(installer.InstallError, "Developer ID"):
            installer.install(self.archive, self.app.parent)
        self.assert_old_preserved()

    def test_active_mount_blocks_before_extraction(self):
        def mounted(arguments, timeout=90):
            if arguments[0] == "/sbin/mount":
                return "gendragoon: on " + str(Path.home() / "GenDragoon Cloud SSD") + " (macfuse, local)\n"
            return self.fake_command(arguments, timeout)
        with self.fake_mac(mounted), self.assertRaisesRegex(installer.InstallError, "Active GenDragoon"):
            installer.install(self.archive, self.app.parent)
        self.assert_old_preserved()
        self.assertFalse(any(command[0] == "/usr/bin/ditto" for command in self.calls))

    def test_mount_appearing_after_staging_still_blocks_replacement(self):
        count = 0
        def later_mount(arguments, timeout=90):
            nonlocal count
            if arguments[0] == "/sbin/mount":
                count += 1
                if count > 1:
                    return "gendragoon: on /Volumes/GenDragoon (macfuse, local)\n"
            return self.fake_command(arguments, timeout)
        with self.fake_mac(later_mount), self.assertRaisesRegex(installer.InstallError, "Active GenDragoon"):
            installer.install(self.archive, self.app.parent)
        self.assert_old_preserved()

    def test_success_keeps_old_backup_and_user_data_without_launching(self):
        data = self.root / "user-library"
        data.mkdir()
        token = data / "private-settings"
        token.write_text("unchanged fixture")
        with self.fake_mac():
            result = installer.install(self.archive, self.app.parent)
        self.assertTrue((self.app / "Contents/new-marker").exists())
        self.assertEqual((Path(result["backup"]) / "Contents/old-marker").read_text(), "original application")
        self.assertEqual(token.read_text(), "unchanged fixture")
        self.assertEqual(result["functional_readiness"], "not_tested")
        self.assertEqual(result["api_readiness"], "not_tested")
        self.assertEqual(result["launch"], "not_requested")
        self.assertFalse(any(command[0] == "/usr/bin/open" for command in self.calls))

    def test_failed_stage_move_restores_old_app(self):
        real_replace = installer.os.replace
        def fail_stage(source, destination):
            if Path(source).parent.name == "extracted":
                raise OSError("simulated stage rename failure")
            return real_replace(source, destination)
        with self.fake_mac(), mock.patch.object(installer.os, "replace", side_effect=fail_stage), \
                self.assertRaisesRegex(installer.InstallError, "previous app restored"):
            installer.install(self.archive, self.app.parent)
        self.assert_old_preserved()

    def test_post_install_signature_failure_rolls_back(self):
        def post_failure(arguments, timeout=90):
            if arguments[0] == "/usr/bin/codesign" and "--verify" in arguments and arguments[-1] == str(self.app):
                raise installer.InstallError("post-install signature rejected")
            return self.fake_command(arguments, timeout)
        with self.fake_mac(post_failure), self.assertRaisesRegex(installer.InstallError, "previous app restored"):
            installer.install(self.archive, self.app.parent)
        self.assert_old_preserved()

    def test_open_failure_rolls_back(self):
        def open_failure(arguments, timeout=90):
            if arguments[0] == "/usr/bin/open":
                raise installer.InstallError("simulated launch failure")
            return self.fake_command(arguments, timeout)
        with self.fake_mac(open_failure), self.assertRaisesRegex(installer.InstallError, "previous app restored"):
            installer.install(self.archive, self.app.parent, restart=True)
        self.assert_old_preserved()

    def test_graceful_quit_timeout_never_kills(self):
        with mock.patch.object(installer, "running_pids", return_value=[100]), \
                mock.patch.object(installer, "run_checked", return_value="") as commands, \
                mock.patch.object(installer.time, "monotonic", side_effect=[0, 50]), \
                self.assertRaisesRegex(installer.InstallError, "did not exit gracefully"):
            installer.graceful_quit(self.app)
        self.assertEqual(commands.call_args.args[0][0], "/usr/bin/osascript")
        self.assert_old_preserved()

    def test_launch_timeout_fails_without_claiming_readiness(self):
        with mock.patch.object(installer, "run_checked", return_value=""), \
                mock.patch.object(installer, "running_pids", return_value=[]), \
                mock.patch.object(installer.time, "monotonic", side_effect=[0, 21]), \
                self.assertRaisesRegex(installer.InstallError, "exact executable path"):
            installer.launch_app(self.app)

    def test_launch_checks_stable_exact_executable_pids(self):
        with mock.patch.object(installer, "run_checked", return_value="") as commands, \
                mock.patch.object(installer, "running_pids", side_effect=[[100], [100]]) as processes, \
                mock.patch.object(installer.time, "sleep"), \
                mock.patch.object(installer.time, "monotonic", side_effect=[0, 1]):
            self.assertEqual(installer.launch_app(self.app), [100])
        self.assertEqual(commands.call_args.args[0], ["/usr/bin/open", "-n", str(self.app)])
        self.assertEqual(processes.call_count, 2)

    def test_process_detection_uses_kernel_path_not_name_or_arguments(self):
        executable = str((self.app / "Contents/MacOS" / installer.EXECUTABLE).resolve())
        paths = {100: executable, 101: "/another/app/Contents/MacOS/" + installer.EXECUTABLE,
                 102: "/bin/something-else"}
        def proc_pidpath(pid, buffer, length):
            buffer.value = os.fsencode(paths[pid])
            return len(buffer.value)
        library = mock.Mock()
        library.proc_pidpath = mock.Mock(side_effect=proc_pidpath)
        with mock.patch.object(installer, "run_checked", return_value="100\n101\n102\n"), \
                mock.patch.object(installer.ctypes, "CDLL", return_value=library):
            self.assertEqual(installer.running_pids(self.app), [100])

    def test_failed_rollback_retains_backup_and_reports_its_location(self):
        real_replace = installer.os.replace
        def fail_restore(source, destination):
            if "previous-" in Path(source).name:
                raise OSError("simulated rollback permission failure")
            return real_replace(source, destination)
        def fail_open(arguments, timeout=90):
            if arguments[0] == "/usr/bin/open":
                raise installer.InstallError("simulated launch failure")
            return self.fake_command(arguments, timeout)
        with self.fake_mac(fail_open), mock.patch.object(installer.os, "replace", side_effect=fail_restore), \
                self.assertRaisesRegex(installer.InstallError, "retained backup") as failure:
            installer.install(self.archive, self.app.parent, restart=True)
        backups = list(self.app.parent.glob("GenDragoon Cloud SSD.previous-*.app"))
        self.assertEqual(len(backups), 1)
        self.assertEqual((backups[0] / "Contents/old-marker").read_text(), "original application")
        self.assertIn(str(backups[0]), str(failure.exception))


if __name__ == "__main__":
    unittest.main()
