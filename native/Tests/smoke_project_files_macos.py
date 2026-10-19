#!/usr/bin/env python3
"""Real ditto project-envelope acceptance using only generated local fixtures."""
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse
import importlib
import json
from pathlib import Path
import plistlib
import shutil
import signal
import tempfile
import time

from smoke_macos_archive import ATTRIBUTES, native_setter, require


def run(resources, fixture_parent):
    require(sys.platform == "darwin", "This gate requires macOS and real ditto")
    resources = resources.resolve(strict=True)
    fixture_parent = fixture_parent.resolve(strict=True)
    require(shutil.disk_usage(fixture_parent).free >= 10 * 1024**3 + 128 * 1024**2,
            "The unchanged 10 GiB reserve cannot accommodate this fixture")
    sys.path.insert(0, str(resources))
    project = importlib.import_module("gendragoon_project_files")
    library = project.library
    home = Path(tempfile.mkdtemp(prefix="gd-project-macos-", dir=fixture_parent)).resolve()
    home.chmod(0o700)
    library.HOME = home
    library.SUPPORT = home / "support"
    library.CACHE = library.SUPPORT / "cache"
    library.INDEX = library.SUPPORT / "index.json"
    library.CONFIG = library.SUPPORT / "NO_CLOUD_CONFIG"
    library.RCLONE = home / "NO_CLOUD_EXECUTABLE"
    project.ROOT = library.SUPPORT / "ProjectFiles"
    scope = "a" * 64
    set_attribute = native_setter(library)
    output = {"ok": False, "scope": "real macOS project packaging and exclusive restore",
              "cloudOperations": 0, "applicationLaunches": 0, "offloads": 0,
              "productionReserveOverride": False, "cases": []}
    started = time.monotonic()
    def deadline(*_):
        raise TimeoutError("Project fixture exceeded its 45-second wall budget")
    signal.signal(signal.SIGALRM, deadline)
    signal.setitimer(signal.ITIMER_REAL, 45)
    try:
        folder = home / "Complete folder with spaces"
        (folder / "nested/empty folder").mkdir(parents=True, mode=0o700)
        (folder / "EMPTY").write_bytes(b"")
        executable = folder / "nested/run.command"
        executable.write_bytes(b"#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)
        (folder / "nested/relative link").symlink_to("run.command")
        set_attribute(folder, "app.gendragoon.directory", b"root metadata")
        set_attribute(folder / "nested", "app.gendragoon.empty", b"")
        for name, value in ATTRIBUTES.items():
            set_attribute(executable, name, value)
        empty = home / "extensionless-empty"
        empty.write_bytes(b"")
        single = home / "Data with metadata.txt"
        single.write_bytes(b"GenDragoon project fixture\n")
        for name, value in ATTRIBUTES.items():
            set_attribute(single, name, value)
        app = home / "Disposable Metadata.app"
        (app / "Contents/Resources").mkdir(parents=True, mode=0o700)
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "app.gendragoon.project.fixture",
            "CFBundleName": "Disposable Metadata", "CFBundlePackageType": "APPL"}))
        (app / "Contents/Resources/data").write_bytes(b"Fixture application resource")
        set_attribute(app, "app.gendragoon.directory", b"application root metadata")
        for index, source in enumerate([folder, empty, single, app]):
            baseline = library.snapshot(source)
            prepared = project.prepare(source, scope)
            downloaded = home / ("readback-" + str(index) + ".gdpackage")
            shutil.copyfile(prepared["path"], downloaded)
            require(library.sha(downloaded) == prepared["packageSHA256"], "Readback package differs")
            verified = project.verify_remote(downloaded, scope, prepared["key"], offload=False)
            require(verified["verified"] and not verified["offloaded"], "Readback did not verify")
            destination = home / ("Restored " + source.name)
            restored = project.restore(downloaded, destination, prepared["manifestSHA256"])
            library.verify_restored(Path(restored["restored"]), baseline["manifest"])
            project.source_unchanged(source, baseline)
            require(not Path(prepared["path"]).exists(), "Verified preparation was not released")
            output["cases"].append({"kind": prepared["kind"], "logicalBytes": prepared["logicalBytes"],
                "entryCount": prepared["entryCount"], "packageBytes": prepared["sizeBytes"],
                "restored": True, "sourceUnchanged": True})
        prepared = project.prepare(folder, scope)
        downloaded = home / "mutation-readback.gdpackage"
        shutil.copyfile(prepared["path"], downloaded)
        mutation = folder / "created after preparation"
        mutation.write_bytes(b"Retain the changed original")
        def forbidden_trash(_):
            raise AssertionError("A mutated original reached offload")
        library.trash = forbidden_trash
        try:
            project.verify_remote(downloaded, scope, prepared["key"], offload=True)
        except RuntimeError as error:
            require("source changed" in str(error), "Unexpected mutation rejection")
        else:
            raise AssertionError("Source mutation did not block offload")
        require(mutation.read_bytes() == b"Retain the changed original", "Changed original lost")
        require(shutil.disk_usage(home).free >= 10 * 1024**3, "Reserve fell below 10 GiB")
        output.update(ok=True, mutationBlockedOffload=True, nestedEmptyDirectoryPreserved=True,
            emptyFilesPreserved=True, executableModePreserved=True, relativeSymlinkPreserved=True,
            resourceForkAndCustomAttributesPreserved=True, nativeExclusiveRestoreUsed=True)
    except Exception as error:
        output["error"] = str(error)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        output["seconds"] = round(time.monotonic() - started, 3)
        if output["ok"]:
            shutil.rmtree(home)
        output["fixturesRemoved"] = output["ok"]
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--fixture-parent", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    options = parser.parse_args()
    try:
        result = run(options.resources, options.fixture_parent)
    except Exception as error:
        result = {"ok": False, "error": str(error)}
    options.report.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result), flush=True)
    sys.exit(0 if result["ok"] else 1)
