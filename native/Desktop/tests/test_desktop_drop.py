"""Real Tcl-list parsing and required target-platform TkDND native acceptance.

All filesystem items are disposable fixtures. Virtual callbacks exercise the
registered Tcl/Python boundary; they do not claim a physical OS drag gesture.
"""
import json
import hashlib
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

DESKTOP = Path(__file__).resolve().parents[1]
RUNTIME = Path(os.environ.get("GD_DESKTOP_RUNTIME", DESKTOP))
sys.path.insert(0, str(DESKTOP))
sys.path.insert(0, str(RUNTIME))
import desktop_drop as drop
import desktop_transfer_ui as transfer


def tcl_list(tcl, values):
    return tcl.call("format", "%s", tcl.call("list", *values))


class DropParsingTests(unittest.TestCase):
    def setUp(self):
        import tkinter
        self.tcl = tkinter.Tcl()
        self.temporary = tempfile.TemporaryDirectory(prefix="gd-drop-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.folder = self.root / "A folder {with braces}"
        self.folder.mkdir()
        self.file = self.root / "café 😀 [literal].txt"
        self.file.write_bytes(b"original retained")
        self.app = self.root / "Portable app.exe"
        self.app.write_bytes(b"explicit portable backup")

    def parse(self, names):
        return drop.parse_dropped_files(self.tcl, tcl_list(self.tcl, names))

    def test_real_tcl_list_preserves_mixed_paths_unicode_braces_and_originals(self):
        names = [str(self.file), str(self.folder), str(self.app)]
        self.assertEqual(self.parse(names), names)
        self.assertEqual(self.file.read_bytes(), b"original retained")
        self.assertEqual(self.app.read_bytes(), b"explicit portable backup")

    def test_tcl_syntax_is_never_evaluated(self):
        self.tcl.call("set", "drop_evaluated", "no")
        path = self.root / "semicolon;[set drop_evaluated yes]$variable.txt"
        path.write_bytes(b"literal filename")
        self.assertEqual(self.parse([str(path)]), [str(path)])
        self.assertEqual(self.tcl.call("set", "drop_evaluated"), "no")

    def test_count_payload_and_malformed_list_bounds(self):
        self.assertEqual(self.parse([str(self.file)] * 100), [str(self.file)])
        for raw in ("", "{unclosed", "}" , "x" * (drop.MAX_DROP_BYTES + 1)):
            with self.subTest(raw=raw[:20]), self.assertRaises(drop.DropError):
                drop.parse_dropped_files(self.tcl, raw)
        with self.assertRaises(drop.DropError): self.parse([str(self.file)] * 101)
        with self.assertRaises(drop.DropError): self.parse(["/" + "a" * drop.MAX_PATH_BYTES])

    def test_urls_unc_device_relative_dot_traversals_and_controls_rejected_before_stat(self):
        invalid = ["file:///tmp/test", "https://example.test/file", "sftp://example.test/file", "relative",
            "//server/share/file", "\\\\server\\share\\file", "\\\\?\\C:\\private", "\\\\.\\PhysicalDrive0",
            str(self.root) + "/./file", str(self.root) + "/../file", str(self.file) + "\0", str(self.file) + "\n"]
        with patch.object(drop, "validate_sources", side_effect=AssertionError("Must refuse before touching a foreign path")) as validated:
            for name in invalid:
                with self.subTest(name=name), self.assertRaises(drop.DropError): self.parse([name])
        validated.assert_not_called()

    def test_windows_requires_drive_qualified_local_paths_and_no_ads(self):
        with patch.object(drop.sys, "platform", "win32"), patch.object(drop, "_windows_local_drive", return_value=True), patch.object(drop, "validate_sources", side_effect=lambda values: values):
            self.assertEqual(self.parse([r"C:\Users\Fixture\café 😀.txt", "D:/Folder/file.txt"]), [r"C:\Users\Fixture\café 😀.txt", "D:/Folder/file.txt"])
            for name in (r"C:relative.txt", r"\root-relative.txt", r"C:\file:secret", r"C:\folder\..\file", "file:///C:/file", r"\\server\share\file"):
                with self.subTest(name=name), self.assertRaises(drop.DropError): self.parse([name])
        with patch.object(drop.sys, "platform", "win32"), patch.object(drop, "_windows_local_drive", return_value=False), patch.object(drop, "validate_sources") as validated:
            with self.assertRaises(drop.DropError): self.parse([r"Z:\remote\file"])
            validated.assert_not_called()

    def test_shared_picker_policy_rejects_overlap_reparse_and_special_files(self):
        child = self.folder / "child.txt"
        child.write_bytes(b"fixture")
        with self.assertRaises(drop.DropError): self.parse([str(self.folder), str(child)])
        info = SimpleNamespace(st_mode=stat.S_IFREG | 0o600, st_file_attributes=0x400)
        with patch.object(transfer, "real_path", return_value=info):
            with self.assertRaises(drop.DropError): self.parse([str(self.file)])
        app = self.root / "Mac.app"
        app.mkdir()
        with self.assertRaises(drop.DropError): self.parse([str(app)])

    @unittest.skipIf(os.name == "nt", "Actual Windows junction is tested separately")
    def test_posix_symlink_leaf_and_parent_refused_without_following(self):
        leaf = self.root / "linked-file"
        leaf.symlink_to(self.file)
        parent = self.root / "linked-parent"
        parent.symlink_to(self.folder, target_is_directory=True)
        child = self.folder / "child"
        child.write_bytes(b"retained")
        for path in (leaf, parent / "child"):
            with self.assertRaises(drop.DropError): self.parse([str(path)])
        self.assertEqual(child.read_bytes(), b"retained")

    @unittest.skipUnless(os.name == "nt", "Actual NTFS reparse handling")
    def test_actual_windows_junction_parent_is_rejected(self):
        child = self.folder / "child"
        child.write_bytes(b"retained junction target")
        junction = self.root / "junction"
        result = subprocess.run(["cmd", "/d", "/c", "mklink", "/J", str(junction), str(self.folder)], capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, "The disposable NTFS junction fixture could not be created")
        try:
            with self.assertRaises(drop.DropError): self.parse([str(junction / "child")])
            self.assertEqual(child.read_bytes(), b"retained junction target")
        finally:
            junction.rmdir()

    def test_copy_only_callback_stages_once_and_never_claims_move(self):
        binding = drop.FileDropBinding.__new__(drop.FileDropBinding)
        binding.widget = SimpleNamespace(tk=self.tcl)
        binding.on_paths = Mock()
        binding.on_error = Mock()
        event = SimpleNamespace(actions=("copy", "move"), data=tcl_list(self.tcl, [str(self.file)]))
        self.assertEqual(binding.drop(event), drop.COPY)
        binding.on_paths.assert_called_once_with([str(self.file)])
        binding.on_paths.reset_mock()
        event.actions = ("move", "link")
        self.assertEqual(binding.drop(event), drop.REFUSE_DROP)
        event.actions = None
        self.assertEqual(binding.drop(event), drop.REFUSE_DROP)
        binding.on_paths.assert_not_called()
        self.assertEqual(self.file.read_bytes(), b"original retained")

    def test_callback_rejects_invalid_and_cancelled_staging_with_fixed_safe_error(self):
        binding = drop.FileDropBinding.__new__(drop.FileDropBinding)
        binding.widget = SimpleNamespace(tk=self.tcl)
        binding.on_paths = Mock(side_effect=RuntimeError("private backend details must not escape"))
        binding.on_error = Mock()
        event = SimpleNamespace(actions=("copy",), data=tcl_list(self.tcl, [str(self.file)]))
        self.assertEqual(binding.drop(event), drop.REFUSE_DROP)
        binding.on_error.assert_called_once_with(drop.DROP_ERROR)
        self.assertNotIn("private backend", binding.on_error.call_args[0][0])
        binding.on_paths = Mock(return_value=False)
        self.assertEqual(binding.drop(event), drop.REFUSE_DROP)


class DependencyTests(unittest.TestCase):
    def test_selected_native_data_digest_and_links_are_required_before_loading(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve()
            package = root / "tkinterdnd2"
            directory = package / "tkdnd/linux-x64"
            directory.mkdir(parents=True)
            files = {"pkgIndex.tcl": b"synthetic Tcl fixture", "libtkdnd2.10.3.so": b"synthetic native fixture"}
            pin = {"wrapperVersion": "0.7.0", "nativeVersion": "2.10.3", "runtimeFiles": {"linux-x64": {}}}
            for name, data in files.items():
                (directory / name).write_bytes(data)
                pin["runtimeFiles"]["linux-x64"][name] = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
            (root / "tkdnd-runtime.json").write_text(json.dumps(pin))
            with patch.object(drop, "__file__", str(root / "desktop_drop.py")), patch.object(drop.metadata, "version", return_value="0.7.0"), patch.object(drop.util, "find_spec", return_value=SimpleNamespace(origin=str(package / "__init__.py"))), patch.object(drop.platform, "system", return_value="Linux"), patch.object(drop.platform, "machine", return_value="x86_64"), patch("tkinter.TclVersion", 8.6):
                self.assertEqual(drop.verify_dependency()["platformFolder"], "linux-x64")
                native = directory / "libtkdnd2.10.3.so"
                native.write_bytes(b"changed native fixture")
                with self.assertRaises(RuntimeError): drop.verify_dependency()
                native.unlink()
                original = root / "outside-native"
                original.write_bytes(files[native.name])
                if os.name != "nt":
                    native.symlink_to(original)
                    with self.assertRaises(RuntimeError): drop.verify_dependency()
                else:
                    with self.assertRaises(RuntimeError): drop.verify_dependency()

    def test_missing_or_wrong_required_dependency_has_no_plain_tk_fallback(self):
        with patch.object(drop.metadata, "version", side_effect=drop.metadata.PackageNotFoundError("tkinterdnd2")):
            with self.assertRaisesRegex(RuntimeError, "required native file-drop runtime"): drop.verify_dependency()
            with self.assertRaisesRegex(RuntimeError, "required native file-drop runtime"): drop.create_root()
        with patch.object(drop.metadata, "version", return_value="0.6.4"):
            with self.assertRaisesRegex(RuntimeError, "required native file-drop runtime"): drop.verify_dependency()

    def test_pinned_official_wheel_notice_and_staging_resources(self):
        import stage_runtime
        pin = json.loads((DESKTOP / "tkdnd-runtime.json").read_text())
        self.assertEqual(pin["wrapperVersion"], "0.7.0")
        self.assertEqual(pin["nativeVersion"], "2.10.3")
        self.assertEqual(pin["wheel"]["sha256"], "f93d4f5ad439648ba1673f15db3e271cdd08f075c87f43553ffcdde4e634a717")
        self.assertEqual(pin["wheel"]["bytes"], 819285)
        self.assertIn(pin["wheel"]["sha256"], (DESKTOP / "requirements.txt").read_text())
        for name in ("desktop_drop.py", "tkdnd-runtime.json", "tkinterdnd2-LICENSE.txt", "tkdnd-LICENSE.txt"):
            self.assertIn(name, stage_runtime.CLIENTS)
        self.assertIn("Copyright (c) 2020 Philippe Gagné", (DESKTOP / "tkinterdnd2-LICENSE.txt").read_text())
        self.assertIn("George Petasis", (DESKTOP / "tkdnd-LICENSE.txt").read_text())
        self.assertIn("included verbatim", (DESKTOP / "tkdnd-LICENSE.txt").read_text())

    def test_package_requires_notice_data_and_official_hook_import(self):
        import package_desktop
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            with self.assertRaisesRegex(RuntimeError, "required native file-drop"): package_desktop.drop_package_options(root)
            for name in ("tkdnd-runtime.json", "tkinterdnd2-LICENSE.txt", "tkdnd-LICENSE.txt"):
                (root / name).write_bytes((DESKTOP / name).read_bytes())
            options = package_desktop.drop_package_options(root)
            self.assertIn("--copy-metadata", options)
            self.assertIn("--hidden-import", options)
            self.assertEqual(options.count("--add-data"), 3)


@unittest.skipUnless(sys.platform == "win32" or sys.platform.startswith("linux"), "Actual target-platform native TkDND; macOS uses the native Swift app")
class NativeDropAcceptanceTests(unittest.TestCase):
    def test_actual_native_init_and_registered_virtual_drop_copy_boundary(self):
        import tkinter as tk
        root = drop.create_root()
        root.withdraw()
        try:
            info = drop.require_native_drop(root)
            self.assertEqual(info["native"], "2.10.3")
            self.assertIn(info["windowingSystem"], ("x11", "win32"))
            widget = tk.Listbox(root)
            widget.pack()
            root.update()
            accepted, errors = [], []
            binding = drop.bind_file_drop(widget, accepted.append, errors.append)
            self.assertIn(binding.commands["drop"], str(root.tk.call("bind", str(widget), "<<Drop>>")))
            with tempfile.TemporaryDirectory(prefix="gd-native-drop-") as td:
                directory = Path(td).resolve()
                file = directory / "space café 😀 {literal}.txt"
                file.write_bytes(b"original native fixture")
                folder = directory / "Folder"
                folder.mkdir()
                data = tcl_list(root.tk, [str(file), str(folder)])
                # Actual registered DnDWrapper._substitute_dnd boundary, 18
                # documented substitutions. This is not an OS drag gesture.
                arguments = ["copy", "copy move", "1", "", "", "DND_Files", "DND_Files", data,
                    "<<Drop>>", "DND_Files", "", "DND_Files", "DND_Files", "DND_Files", "DND_Files", str(widget), "0", "0"]
                self.assertEqual(str(root.tk.call(binding.commands["drop"], *arguments)), drop.COPY)
                self.assertEqual(accepted, [[str(file), str(folder)]])
                arguments[1] = "move link"
                self.assertEqual(str(root.tk.call(binding.commands["drop"], *arguments)), drop.REFUSE_DROP)
                self.assertEqual(len(accepted), 1)
                arguments[1], arguments[7] = "copy", "file:///not-an-accepted-path"
                self.assertEqual(str(root.tk.call(binding.commands["drop"], *arguments)), drop.REFUSE_DROP)
                self.assertEqual(len(errors), 1)
                self.assertEqual(file.read_bytes(), b"original native fixture")
        finally:
            root.destroy()


if __name__ == "__main__": unittest.main()
