"""macOS xattr fallback and file archive-layout regression fixtures."""
import base64
import ctypes
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import zipfile

import test_integrated_library as fixture_module
library = fixture_module.library


class NativeAttributes:
    def __init__(self, values, names=None):
        self.values = values
        self.names = names
        self.calls = []

    def data(self, value, buffer, size):
        if buffer is None:
            return len(value)
        if size < len(value):
            ctypes.set_errno(errno.ERANGE)
            return -1
        if value:
            ctypes.memmove(buffer, value, len(value))
        return len(value)

    def listxattr(self, path, buffer, size, options):
        self.calls.append(("list", path, buffer is None, size, options))
        value = self.names if self.names is not None else b"".join(name + b"\0" for name in self.values)
        return self.data(value, buffer, size)

    def getxattr(self, path, name, buffer, size, position, options):
        self.calls.append(("get", path, name, buffer is None, size, position, options))
        return self.data(self.values[name], buffer, size)


class NativeXattrTests(unittest.TestCase):
    def native_read(self, backend, path=Path("/private/fixture with spaces/$literal;name")):
        with patch.object(library.os, "listxattr", None, create=True), \
                patch.object(library.os, "getxattr", None, create=True), \
                patch.object(library, "_native_xattr_api", return_value=backend):
            return library.macos_xattrs(path)

    def test_missing_python_os_apis_use_native_no_follow_and_hash_resource_fork(self):
        values = {b"com.apple.ResourceFork": b"resource-fork-data", b"user.fixture": b"metadata",
                  b"com.apple.provenance": b"local-generated-bookkeeping", b"user.empty": b""}
        backend = NativeAttributes(values)
        result = self.native_read(backend)
        expected = {name.decode(): {"size": len(value), "sha256": hashlib.sha256(value).hexdigest()}
                    for name, value in values.items() if name != b"com.apple.provenance"}
        self.assertEqual(result, expected)
        self.assertTrue(backend.calls)
        for call in backend.calls:
            self.assertEqual(call[-1], library.XATTR_NOFOLLOW)
            self.assertEqual(call[1], b"/private/fixture with spaces/$literal;name")
            if call[0] == "get":
                self.assertEqual(call[-2], 0)
                self.assertNotEqual(call[2], b"com.apple.provenance")

    def test_native_missing_permissions_fail_closed(self):
        def denied(*_):
            ctypes.set_errno(errno.EACCES)
            return -1
        with self.assertRaisesRegex(PermissionError, "original retained"):
            self.native_read(SimpleNamespace(listxattr=denied))

    def test_oversized_name_list_is_rejected_before_allocation(self):
        backend = SimpleNamespace(listxattr=lambda *_: library.MAX_XATTR_NAMES_BYTES + 1)
        with patch.object(library.ctypes, "create_string_buffer") as allocate:
            with self.assertRaisesRegex(RuntimeError, "bounded"):
                self.native_read(backend)
        allocate.assert_not_called()

    def test_oversized_value_is_rejected_before_value_buffer_allocation(self):
        backend = NativeAttributes({b"user.large": b""})
        calls = []
        def large(path, name, buffer, size, position, options):
            calls.append((buffer, size))
            return library.MAX_XATTR_VALUE_BYTES + 1
        backend.getxattr = large
        with self.assertRaisesRegex(RuntimeError, "bounded"):
            self.native_read(backend)
        self.assertEqual(calls, [(None, 0)])

    def test_changing_metadata_retries_are_bounded(self):
        reads = []
        def changing(path, buffer, size, options):
            reads.append(buffer is None)
            if buffer is None:
                return 1
            ctypes.set_errno(errno.ERANGE)
            return -1
        with self.assertRaisesRegex(RuntimeError, "changed"):
            self.native_read(SimpleNamespace(listxattr=changing))
        self.assertEqual(len(reads), 6)

    def test_malformed_duplicate_and_embedded_empty_attribute_names_fail_closed(self):
        for names in (b"missing terminator", b"duplicate\0duplicate\0", b"first\0\0"):
            with self.subTest(names=names), self.assertRaises(RuntimeError):
                self.native_read(NativeAttributes({}, names=names))

    def test_embedded_nul_path_is_rejected_before_native_call(self):
        backend = NativeAttributes({})
        with self.assertRaises(ValueError):
            self.native_read(backend, Path("/private/fixture\0other"))
        self.assertFalse(backend.calls)


class DirectoryMetadataPackingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="gd-directory-metadata-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.source = self.root / "Folder"
        self.source.mkdir()
        self.packed = self.root / "root.appledouble"

    def serializer(self, content=b"fixture AppleDouble"):
        def copy(source, destination, state, flags):
            self.assertEqual(source, os.fsencode(self.source))
            self.assertEqual(destination, os.fsencode(self.packed))
            self.assertIsNone(state)
            self.assertEqual(flags, 7 | (1 << 22) | (1 << 17) | (1 << 18) | (1 << 19))
            Path(os.fsdecode(destination)).write_bytes(content)
            return 0
        return Mock(side_effect=copy)

    def test_native_serializer_uses_exclusive_metadata_only_nofollow_flags(self):
        before = library.snapshot(self.source)
        native = SimpleNamespace(copyfile=self.serializer())
        with patch.object(library, "_native_xattr_api", return_value=native):
            library._pack_directory_metadata(self.source, self.packed)
        native.copyfile.assert_called_once()
        self.assertEqual(self.packed.read_bytes(), b"fixture AppleDouble")
        self.assertEqual(stat.S_IMODE(self.packed.stat().st_mode), 0o600)
        library.unchanged(self.source, before)

    def test_linked_or_existing_outputs_are_rejected_before_native_copy(self):
        external = self.root / "outside"
        external.write_bytes(b"untouched")
        self.packed.symlink_to(external)
        with patch.object(library, "_native_xattr_api") as native:
            with self.assertRaises(ValueError):
                library._pack_directory_metadata(self.source, self.packed)
            native.assert_not_called()
        self.assertEqual(external.read_bytes(), b"untouched")
        self.packed.unlink()
        self.packed.write_bytes(b"existing")
        with patch.object(library, "_native_xattr_api") as native:
            with self.assertRaises(ValueError):
                library._pack_directory_metadata(self.source, self.packed)
            native.assert_not_called()
        self.assertEqual(self.packed.read_bytes(), b"existing")

    def test_oversized_native_metadata_is_refused(self):
        native = SimpleNamespace(copyfile=self.serializer(b"12345"))
        with patch.object(library, "_native_xattr_api", return_value=native), \
             patch.object(library, "MAX_PACKED_METADATA_BYTES", 4):
            with self.assertRaisesRegex(RuntimeError, "safe limit"):
                library._pack_directory_metadata(self.source, self.packed)

    def archive(self, names):
        archive = self.root / "fixture.zip"
        with zipfile.ZipFile(archive, "w") as output:
            for name in names:
                item = zipfile.ZipInfo(name)
                item.create_system = 3
                item.external_attr = (stat.S_IFREG | 0o600) << 16
                output.writestr(item, b"original metadata")
        return archive

    def test_existing_exact_metadata_is_preserved_without_duplicate_or_replacement(self):
        archive = self.archive(["__MACOSX/._Folder"])
        before = archive.read_bytes()
        with patch.object(library, "_pack_directory_metadata") as pack:
            library._supplement_root_directory_metadata(self.source, archive)
            pack.assert_not_called()
        self.assertEqual(archive.read_bytes(), before)

    def test_case_equivalent_or_directory_metadata_names_are_refused(self):
        for members in (("__macosx/._folder",), ("__MACOSX/._Folder/",),
                        ("__MACOSX/._Folder", "__macosx/._folder")):
            archive = self.archive(members)
            before = archive.read_bytes()
            with self.subTest(members=members), patch.object(library, "_pack_directory_metadata") as pack:
                with self.assertRaisesRegex(ValueError, "ambiguous"):
                    library._supplement_root_directory_metadata(self.source, archive)
                pack.assert_not_called()
            self.assertEqual(archive.read_bytes(), before)

    def test_reserved_root_and_escaping_names_are_rejected_before_packaging(self):
        reserved = self.root / "__MACOSX"
        reserved.mkdir()
        archive = self.root / "never-created.zip"
        with patch.object(library, "run") as external:
            with self.assertRaisesRegex(ValueError, "reserved"):
                library.package(reserved, archive)
            external.assert_not_called()
        with self.assertRaisesRegex(ValueError, "reserved"):
            library.validate_archive(archive, "__macosx")
        with self.assertRaises(ValueError):
            library.validate_archive(archive, "../Folder")
        self.assertFalse(archive.exists())


@unittest.skipUnless(all(callable(getattr(os, name, None)) for name in ("listxattr", "getxattr", "setxattr")),
                     "Archive fixture backend requires local xattr test APIs; libc fallback has separate coverage")
class ArchiveMetadataTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixture_module.LibraryTests()
        self.fixture.setUp()
        self.platform = patch.object(library.sys, "platform", "darwin")
        self.platform.start()
        self.preserve_metadata = True
        self.real_commands = self.fixture.fake_command
        self.fixture.fake_run.stop()
        self.commands = patch.object(library, "run", side_effect=self.archive_command)
        self.commands.start()
        # Linux fixture AppleDouble payload; the real Darwin smoke exercises
        # Apple's copyfile serializer and ditto unpacker without this backend.
        self.packer = patch.object(library, "_pack_directory_metadata", side_effect=self.pack_directory_metadata)
        self.packer.start()

    def tearDown(self):
        self.packer.stop()
        self.commands.stop()
        self.platform.stop()
        self.fixture.tearDown()

    def pack_directory_metadata(self, source, destination):
        values = {name: base64.b64encode(os.getxattr(source, name, follow_symlinks=False)).decode()
                  for name in os.listxattr(source, follow_symlinks=False)}
        Path(destination).write_bytes(b"fixture-appledouble\n" + json.dumps(values).encode())

    def archive_command(self, args, timeout=1800):
        values = [str(value) for value in args]
        result = self.real_commands(args, timeout)
        if values[0] == "/usr/bin/ditto":
            if "-c" in values:
                source, destination = map(Path, values[-2:])
                metadata = {}
                for path in [source, *sorted(source.rglob("*"))]:
                    if path.is_symlink() or (path == source and source.is_dir()):
                        continue
                    metadata[str(path.relative_to(source.parent))] = {
                        name: base64.b64encode(os.getxattr(path, name, follow_symlinks=False)).decode()
                        for name in os.listxattr(path, follow_symlinks=False)}
                # Model the observed Darwin omission of the selected directory's
                # root metadata while preserving nested directory/file metadata.
                with zipfile.ZipFile(destination, "a") as archive:
                    archive.comment = json.dumps(metadata).encode()
            elif self.preserve_metadata:
                source, destination = map(Path, values[-2:])
                with zipfile.ZipFile(source) as archive:
                    metadata = json.loads(archive.comment or b"{}")
                    for entry in archive.infolist():
                        if entry.filename.startswith("__MACOSX/._") and entry.filename.count("/") == 1:
                            data = archive.read(entry)
                            if data.startswith(b"fixture-appledouble\n"):
                                metadata[entry.filename[len("__MACOSX/._"):]] = json.loads(data.split(b"\n", 1)[1])
                for relative, attributes in metadata.items():
                    for name, encoded in attributes.items():
                        os.setxattr(destination / relative, name, base64.b64decode(encoded), follow_symlinks=False)
        return result

    def test_folder_and_app_root_metadata_survives_real_upload_and_restore_paths(self):
        for kind in ("folder", "app"):
            with self.subTest(kind=kind):
                source = self.fixture.source(kind)
                os.setxattr(source, "user.gendragoon.root", b"root directory metadata")
                os.setxattr(source, "user.gendragoon.empty", b"")
                os.setxattr(source / "nested", "user.gendragoon.nested", b"nested directory metadata")
                os.setxattr(source / "empty", "user.gendragoon.empty", b"")
                baseline = library.snapshot(source)
                result = self.fixture.upload(source)
                entry = library.load()[result["key"]]
                archive = self.fixture.remote[library.item_path(entry)]
                with zipfile.ZipFile(io.BytesIO(archive)) as packed:
                    self.assertEqual(packed.namelist().count("__MACOSX/._" + source.name), 1)
                self.assertEqual(hashlib.sha256(archive).hexdigest(), entry["sha256"])
                library.stage_item(result["key"], False, "project-one", "bucket-one")
                restored = Path(self.fixture.mock_reply.call_args.kwargs["localPath"])
                library.verify_restored(restored, baseline["manifest"])
                library.unchanged(source, baseline)
                os.setxattr(restored, "user.gendragoon.root", b"changed root metadata")
                with self.assertRaisesRegex(RuntimeError, "metadata"):
                    library.verify_restored(restored, baseline["manifest"])
        self.fixture.mock_trash.assert_not_called()

    def test_root_metadata_loss_still_blocks_offload_and_library_commit(self):
        source = self.fixture.source("folder")
        os.setxattr(source, "user.gendragoon.root", b"must survive")
        with patch.object(library, "_supplement_root_directory_metadata"):
            with self.assertRaisesRegex(RuntimeError, "metadata"):
                self.fixture.upload(source, True)
        self.assertEqual(library.load(), {})
        self.fixture.mock_trash.assert_not_called()
        self.assertEqual(os.getxattr(source, "user.gendragoon.root"), b"must survive")

    def tagged_source(self):
        source = self.fixture.source("file")
        os.setxattr(source, "user.gendragoon.fixture", b"metadata that must survive", follow_symlinks=False)
        return source

    def test_file_with_metadata_uses_zip_root_and_roundtrips_before_offload(self):
        source = self.tagged_source()
        baseline = library.snapshot(source)["manifest"]
        result = self.fixture.upload(source, True)
        entry = library.load()[result["key"]]
        self.assertEqual(entry["archiveLayout"], "zip-root")
        self.assertEqual(entry["kind"], "file")
        self.assertTrue(entry["file"].endswith(".zip"))
        self.fixture.mock_trash.assert_called_once_with(source)
        library.stage_item(result["key"], False, "project-one", "bucket-one")
        restored = Path(self.fixture.mock_reply.call_args.kwargs["localPath"])
        library.verify_restored(restored, baseline)
        self.assertEqual(os.getxattr(restored, "user.gendragoon.fixture"), b"metadata that must survive")

    def test_metadata_loss_during_restore_never_removes_original(self):
        source = self.tagged_source()
        self.preserve_metadata = False
        with self.assertRaisesRegex(RuntimeError, "metadata"):
            self.fixture.upload(source, True)
        self.fixture.mock_trash.assert_not_called()
        self.assertTrue(source.exists())
        self.assertEqual(library.load(), {})
        self.assertEqual(os.getxattr(source, "user.gendragoon.fixture"), b"metadata that must survive")

    def test_metadata_mutation_after_verification_preserves_changed_original(self):
        source = self.tagged_source()
        commit = library.store_revision
        def mutate(key, entry, expected):
            commit(key, entry, expected)
            os.setxattr(source, "user.gendragoon.fixture", b"changed after verification", follow_symlinks=False)
        with patch.object(library, "store_revision", side_effect=mutate):
            with self.assertRaisesRegex(RuntimeError, "Source changed"):
                self.fixture.upload(source, True)
        self.fixture.mock_trash.assert_not_called()
        self.assertEqual(os.getxattr(source, "user.gendragoon.fixture"), b"changed after verification")

    def test_large_app_metadata_keeps_verified_archive_without_claiming_raw_stream_integrity(self):
        source = self.fixture.source("app")
        os.setxattr(source / "nested/payload", "user.gendragoon.fixture", b"required application metadata")
        baseline = library.snapshot(source)["manifest"]
        # Exercise the production large-app branch with a tiny real archive.
        # The disk-reserve and verification functions remain unchanged.
        with patch.object(library, "STREAM_MIN_BYTES", 1):
            result = self.fixture.upload(source, True)
        entry = library.load()[result["key"]]
        self.assertTrue(entry["verified"])
        self.assertNotIn("streamVerified", entry)
        self.assertNotIn("streamPath", entry)
        self.assertIn("metadata", entry["streamIneligibleReason"])
        self.fixture.mock_trash.assert_called_once_with(source)
        library.stage_item(result["key"], False, "project-one", "bucket-one")
        restored = Path(self.fixture.mock_reply.call_args.kwargs["localPath"])
        library.verify_restored(restored, baseline)
        self.assertEqual(os.getxattr(restored / "nested/payload", "user.gendragoon.fixture"),
                         b"required application metadata")

    def test_legacy_flat_file_manifest_restores_without_fabricated_metadata(self):
        source = self.fixture.source("file")
        result = self.fixture.upload(source)
        entry = library.load()[result["key"]]
        self.assertEqual(entry.pop("archiveLayout"), "flat")
        for item in entry["manifest"]:
            item.pop("xattrs", None)
        library.store(result["key"], entry)
        library.stage_item(result["key"], False, "project-one", "bucket-one")
        restored = Path(self.fixture.mock_reply.call_args.kwargs["localPath"])
        library.verify_restored(restored, entry["manifest"])
        self.assertEqual(restored.read_bytes(), source.read_bytes())

    def test_metadata_api_failure_aborts_before_cloud_write_or_removal(self):
        source = self.fixture.source("file")
        with patch.object(library, "macos_xattrs", side_effect=PermissionError("metadata read denied")):
            with self.assertRaises(PermissionError):
                self.fixture.upload(source, True)
        self.assertFalse(self.fixture.remote)
        self.fixture.mock_trash.assert_not_called()
        self.assertTrue(source.exists())


if __name__ == "__main__":
    unittest.main()
