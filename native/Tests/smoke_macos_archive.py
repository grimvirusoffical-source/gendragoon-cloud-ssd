#!/usr/bin/env python3
"""Real Darwin resource-fork/xattr archive roundtrip in a private tiny fixture.

Exercises the production library's ditto archive format, native metadata reader,
content/metadata verification, and mutation guard. It performs no cloud upload,
original offload, application launch, or production disk-reserve override. All
fixture files are removed when the test finishes; the source must remain intact
through every production-helper operation before that fixture cleanup.
"""
import argparse
import ctypes
import errno
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import tempfile
import time
import zipfile

MAX_SECONDS = 30
MAX_BYTES = 1024 * 1024
SOURCE_BYTES = b"GenDragoon disposable archive metadata fixture.\n"
ATTRIBUTES = {
    "com.apple.ResourceFork": b"GDRF\0" + bytes(range(64)) + b"\0end-of-fixture-fork",
    "app.gendragoon.smoke": b"harmless metadata that must survive the archive",
    "app.gendragoon.empty": b"",
}


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def digest_attributes(values):
    return {name: {"size": len(value), "sha256": hashlib.sha256(value).hexdigest()}
            for name, value in values.items()}


def native_setter(library):
    native = library._native_xattr_api()
    function = native.setxattr
    function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                         ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
    function.restype = ctypes.c_int
    def write(path, name, value):
        require(b"\0" not in os.fsencode(path) and "\0" not in name, "Invalid fixture metadata name")
        buffer = ctypes.create_string_buffer(value, max(1, len(value)))
        if function(os.fsencode(path), os.fsencode(name), buffer, len(value), 0, library.XATTR_NOFOLLOW) != 0:
            code = ctypes.get_errno() or errno.EIO
            raise OSError(code, "Could not set disposable fixture metadata", str(path))
    return write


def rejection(action, message):
    try:
        action()
    except RuntimeError as error:
        require("original retained" in str(error), "Verification failed for an unexpected reason: " + str(error))
        return
    raise AssertionError(message)


def fixture_bytes(root):
    return sum(path.stat().st_size for path in root.rglob("*") if path.is_file() and not path.is_symlink())


def own_archive_shape(archive, source_name, output):
    # This is only a size/root assertion about the archive created from our one
    # known fixture. Full upload validation and its 10 GiB reserve are outside
    # this component smoke; neither production function is replaced or bypassed.
    with zipfile.ZipFile(archive) as source:
        entries = source.infolist()
        output["archiveMembers"] = [entry.filename for entry in entries]
        require(0 < len(entries) < 32, "Unexpected fixture archive entry count")
        require(sum(entry.file_size for entry in entries) < MAX_BYTES, "Expanded fixture exceeds 1 MiB")
        require(any(entry.filename == source_name for entry in entries), "ditto omitted the named source file")
        for entry in entries:
            parts = entry.filename.rstrip("/").split("/")
            require(parts and parts[0] in {source_name, "__MACOSX"}
                    and not entry.filename.startswith("/")
                    and all(part not in {"", ".", ".."} for part in parts),
                    "Unexpected fixture archive path")


def timeout_handler(_signum, _frame):
    raise TimeoutError("Darwin archive smoke reached its 30-second wall limit")


def run(resources):
    require(sys.platform == "darwin", "This archive smoke must run on macOS")
    require(sys.version_info >= (3, 10), "Python 3.10 or newer is required")
    resources = resources.resolve(strict=True)
    helper = resources / "gendragoon_library.py"
    require(helper.is_file() and not helper.is_symlink(), "Missing or linked native library helper")
    sys.path.insert(0, str(resources))
    library = importlib.import_module("gendragoon_library")
    started = time.monotonic()
    signal.signal(signal.SIGALRM, timeout_handler)
    signal.setitimer(signal.ITIMER_REAL, MAX_SECONDS)
    home = Path(tempfile.mkdtemp(prefix="gd-macos-archive-")).resolve(strict=True)
    home.chmod(0o700)
    output = {"ok": False}
    try:
        # Any helper paths not used by this component test are also confined.
        # The process HOME and the user's configuration are left alone.
        library.HOME = home
        library.SUPPORT = home / "Library/Application Support/GenDragoon Cloud SSD"
        library.CACHE = library.SUPPORT / "AppLibrary"
        library.INDEX = library.SUPPORT / "app-library.json"
        library.CONFIG = library.SUPPORT / "NO_CLOUD_CONFIG"
        library.RCLONE = home / "NO_CLOUD_EXECUTABLE"
        source = home / "Original metadata $literal 'quotes'.txt"
        source.write_bytes(SOURCE_BYTES)
        source.chmod(0o600)
        set_attribute = native_setter(library)
        for name, value in ATTRIBUTES.items():
            set_attribute(source, name, value)
        baseline = library.snapshot(source)
        expected = digest_attributes(ATTRIBUTES)
        actual = library._native_macos_xattrs(source)
        require(all(actual.get(name) == value for name, value in expected.items()),
                "Native metadata reader did not reproduce the fixture's resource fork and attributes")
        require(baseline["manifest"][0]["xattrs"] == actual, "Snapshot and native metadata reader disagree")
        require(bool(baseline["manifest"][0]["xattrs"]), "Metadata fixture would not select zip-root file packaging")
        output["expectedAttributes"] = expected
        archive = home / "fixture.zip"
        # The same production packaging function used by library._upload().
        # The overall smoke deadline bounds its normal production timeout.
        library.package(source, archive)
        library.unchanged(source, baseline)
        own_archive_shape(archive, source.name, output)
        require(archive.stat().st_size < MAX_BYTES, "Fixture archive exceeds 1 MiB")
        verified = home / "readback.zip"
        shutil.copyfile(archive, verified)
        require(library.sha(archive) == library.sha(verified), "Local fixture archive read-back changed bytes")
        destination = home / "restore"
        destination.mkdir(mode=0o700)
        library.run(["/usr/bin/ditto", "-x", "-k", verified, destination], timeout=10)
        restored = destination / source.name
        require(restored.is_file() and not restored.is_symlink(), "Restored fixture is not the expected regular file")
        restored_snapshot = library.snapshot(restored)
        output["restoredAttributes"] = restored_snapshot["manifest"][0].get("xattrs", {})
        library.verify_restored(restored, baseline["manifest"])
        require(restored.read_bytes() == SOURCE_BYTES, "Restored data fork differs")
        require(all(output["restoredAttributes"].get(name) == value for name, value in expected.items()),
                "Restored resource fork or harmless metadata differs")
        library.unchanged(source, baseline)
        # Alter only the restored fixture. Both integrity checking and the
        # pre-offload mutation guard must reject the metadata change.
        set_attribute(restored, "app.gendragoon.smoke", b"changed after the successful restore")
        rejection(lambda: library.verify_restored(restored, baseline["manifest"]), "Metadata mutation escaped restore verification")
        rejection(lambda: library.unchanged(restored, restored_snapshot), "Metadata mutation escaped the unchanged-source guard")
        set_attribute(restored, "app.gendragoon.smoke", ATTRIBUTES["app.gendragoon.smoke"])
        library.verify_restored(restored, baseline["manifest"])
        restored.write_bytes(SOURCE_BYTES + b"changed data fork\n")
        rejection(lambda: library.verify_restored(restored, baseline["manifest"]), "Data mutation escaped restore verification")
        library.unchanged(source, baseline)
        require(source.read_bytes() == SOURCE_BYTES, "Original fixture data changed")
        used = fixture_bytes(home) + sum(len(value) for value in ATTRIBUTES.values()) * 2
        require(used < MAX_BYTES, "Fixture data exceeds 1 MiB")
        output.update(ok=True, bytes=used, seconds=round(time.monotonic() - started, 3),
                      nativeMetadataReadVerified=True, dataForkRestored=True, resourceForkRestored=True,
                      customAttributesRestored=True, emptyAttributeRestored=True,
                      metadataMutationRejected=True, dataMutationRejected=True,
                      unchangedSourceGuardVerified=True, sourcePreservedUntilFixtureCleanup=True,
                      cloudOperations=0, archiveLayout="zip-root", productionReserveOverride=False)
    except Exception as error:
        output.update(error=str(error), seconds=round(time.monotonic() - started, 3))
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        shutil.rmtree(home)
        output["fixturesRemoved"] = True
        print(json.dumps(output, sort_keys=True), flush=True)
    return 0 if output["ok"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path, default=Path(__file__).resolve().parents[1] / "Resources")
    try:
        sys.exit(run(parser.parse_args().resources))
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}), flush=True)
        sys.exit(1)
