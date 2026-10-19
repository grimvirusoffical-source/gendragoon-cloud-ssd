"""Native-memory fixtures for both mount readers; no real volume or OS command."""
import ctypes
import errno
import importlib.util
import os
from pathlib import Path
import sys
import types
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


INSTALLER = load("mount_inventory_installer", ROOT / "macos/install-macos.py")
CONTROL = load("mount_inventory_control", ROOT / "native/Resources/gendragoon_app_control.py")
READERS = ((INSTALLER, INSTALLER.InstallError), (CONTROL, CONTROL.ControlError))


class NativeSnapshot:
    """Supply real ctypes records at the native pointer boundary, never libc."""
    def __init__(self, module, rows, *, count=None, null=False):
        self.module = module
        self.array = (module._DarwinStatFS * max(1, len(rows)))()
        for record, (source, target, filesystem) in zip(self.array, rows):
            record.f_mntfromname = os.fsencode(source)
            record.f_mntonname = os.fsencode(target)
            record.f_fstypename = os.fsencode(filesystem)
        self.count = len(rows) if count is None else count
        self.null = null
        self.api = mock.Mock(side_effect=self.query)
        self.free = mock.Mock()
        self.library = types.SimpleNamespace(getmntinfo_r_np=self.api, free=self.free)

    def query(self, output, flags):
        if flags != 2:
            raise AssertionError("Only MNT_NOWAIT inventory is permitted")
        if not self.null:
            pointer = ctypes.POINTER(self.module._DarwinStatFS)
            ctypes.cast(output, ctypes.POINTER(pointer))[0] = ctypes.cast(self.array, pointer)
        return self.count

    def call(self):
        with mock.patch.object(self.module.sys, "platform", "darwin"), \
                mock.patch.object(self.module.platform, "machine", return_value="arm64"), \
                mock.patch.object(self.module.ctypes, "CDLL", return_value=self.library) as loaded, \
                mock.patch.object(self.module.subprocess, "run", side_effect=AssertionError("No command inventory")), \
                mock.patch.object(self.module.os.path, "ismount", side_effect=AssertionError("No volume traversal")):
            result = self.module.mounted_volumes()
        loaded.assert_called_once_with("/usr/lib/libSystem.B.dylib", use_errno=True)
        return result


class MountInventoryTests(unittest.TestCase):
    def test_literal_native_names_survive_owned_buffer_release(self):
        rows = (("/dev/disk3", "/", "apfs"),
                ("localhost:/", "/Users/example/Cloud (Archive) \\040 café", "nfs"),
                ("remote:bucket", "/Volumes/line\nbreak", "rclone"))
        for module, _ in READERS:
            with self.subTest(reader=module.__name__):
                fixture = NativeSnapshot(module, rows)
                def free(pointer):
                    self.assertEqual(ctypes.cast(pointer, ctypes.c_void_p).value,
                                     ctypes.addressof(fixture.array))
                    ctypes.memset(fixture.array, 0, ctypes.sizeof(fixture.array))
                fixture.free.side_effect = free
                self.assertEqual(fixture.call(), rows)
                fixture.api.assert_called_once()
                fixture.free.assert_called_once()

    def test_native_success_ignores_stale_errno(self):
        previous = ctypes.get_errno()
        self.addCleanup(ctypes.set_errno, previous)
        for module, _ in READERS:
            with self.subTest(reader=module.__name__):
                ctypes.set_errno(errno.EIO)
                fixture = NativeSnapshot(module, (("/dev/disk3", "/", "apfs"),))
                self.assertEqual(fixture.call()[0][1], "/")
                fixture.free.assert_called_once()

    def test_invalid_counts_and_null_results_fail_closed(self):
        for module, failure in READERS:
            for count, null in ((0, True), (-1, True), (1, True), (10001, False)):
                with self.subTest(reader=module.__name__, count=count, null=null):
                    fixture = NativeSnapshot(module, (("/dev/disk3", "/", "apfs"),), count=count, null=null)
                    with self.assertRaises(failure):
                        fixture.call()
                    self.assertEqual(fixture.free.call_count, int(not null))

    def test_unterminated_empty_and_relative_native_fields_fail_closed(self):
        for module, failure in READERS:
            for field, value in (("f_mntonname", b"x" * 1024),
                                 ("f_mntfromname", b""),
                                 ("f_fstypename", b"x" * 16),
                                 ("f_mntonname", b"relative")):
                with self.subTest(reader=module.__name__, field=field, size=len(value)):
                    fixture = NativeSnapshot(module, (("/dev/disk3", "/", "apfs"),))
                    setattr(fixture.array[0], field, value)
                    with self.assertRaises(failure):
                        fixture.call()
                    fixture.free.assert_called_once()

    def test_snapshot_without_root_cannot_establish_safe_absence(self):
        for module, failure in READERS:
            with self.subTest(reader=module.__name__):
                fixture = NativeSnapshot(module, (("localhost:/", "/Volumes/Cloud", "nfs"),))
                with self.assertRaises(failure):
                    fixture.call()
                fixture.free.assert_called_once()

    def test_missing_library_or_reentrant_symbol_blocks_inspection(self):
        for module, failure in READERS:
            for missing in (OSError("library unavailable"), types.SimpleNamespace()):
                with self.subTest(reader=module.__name__, missing=type(missing).__name__), \
                        mock.patch.object(module.sys, "platform", "darwin"), \
                        mock.patch.object(module.platform, "machine", return_value="arm64"):
                    behavior = {"side_effect": missing} if isinstance(missing, Exception) else {"return_value": missing}
                    with mock.patch.object(module.ctypes, "CDLL", **behavior), self.assertRaises(failure):
                        module.mounted_volumes()

    def test_other_architectures_never_use_arm64_native_layout(self):
        for module, failure in READERS:
            for system, architecture in (("darwin", "x86_64"), ("linux", "arm64")):
                with self.subTest(reader=module.__name__, system=system, architecture=architecture), \
                        mock.patch.object(module.sys, "platform", system), \
                        mock.patch.object(module.platform, "machine", return_value=architecture), \
                        mock.patch.object(module.ctypes, "CDLL") as loaded, self.assertRaises(failure):
                    module.mounted_volumes()
                loaded.assert_not_called()


if __name__ == "__main__":
    unittest.main()
