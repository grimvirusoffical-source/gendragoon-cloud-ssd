#!/usr/bin/env python3
"""Bounded, explicit real-GCS component trial using a signed Mac bundle.

Run with python3 -B. This uploads three tiny disposable fixtures to a new UUID
prefix, reads them back through the actual library, and retains all local and
cloud evidence. It never requests offload, deletion, mounting or app launch.
Only the imported library's INDEX/CACHE paths are isolated. HOME, SUPPORT,
CONFIG, the real maintenance/library locks and all integrity/disk checks stay
unchanged. Google/Firebase native sign-in and backend acceptance are not tested.

Example (use the actual newly verified bundle and validation directory):
  python3 -B smoke_gcs_roundtrip.py --resources /path/to/App.app/Contents/Resources \
    --work-dir /path/to/validation --project gendragood-ssd \
    --bucket gen-dragoon-ssd --remote gendragoon

The optional --fixture-app must be a tiny, signed app.gendragoon.smoke.* bundle.
Without it, a minimal C application that immediately exits is compiled locally;
no Clang modules, dependency downloads or application launch are involved.
"""
import sys

sys.dont_write_bytecode = True

import argparse
import configparser
import contextlib
import ctypes
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import platform
import plistlib
import re
import signal
import stat
import subprocess
import tempfile
import time
import urllib.parse
import uuid

os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

MAX_SECONDS = 180
FINAL_SECONDS = 20
COMMAND_SECONDS = 30
MAX_FIXTURE_BYTES = 1024 * 1024
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024
MAX_ENTRIES = 80
EXPECTED = ("gendragood-ssd", "gen-dragoon-ssd", "gendragoon")
BUNDLE_ID = "app.gendragoon.cloudssd"
TEAM_ID = "NZPU8H843J"
MARKER = "cloud-roundtrip-evidence.json"


class TrialError(RuntimeError):
    pass


class TrialDeadline(BaseException):
    pass


def require(value, message):
    if not value:
        raise TrialError(message)


def digest(path):
    value = hashlib.sha256()
    with Path(path).open("rb") as source:
        for block in iter(lambda: source.read(65536), b""):
            value.update(block)
    return value.hexdigest()


def no_links(path):
    path = Path(path).absolute()
    require(not any(p.is_symlink() for p in (path, *path.parents)), "A required path contains a symlink")
    return path


def check_directory(path):
    path = no_links(path)
    info = path.stat()
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.getuid() and not info.st_mode & 0o022,
            "The validation directory must be owned by this user and not writable by others")
    return path


def bounded_tree(root):
    """Bound input before manifest hashing, without following directory links."""
    total = count = 0
    pending = [Path(root)]
    while pending:
        path = pending.pop()
        info = path.lstat()
        count += 1
        require(count <= MAX_ENTRIES, "Fixture contains too many entries")
        if stat.S_ISREG(info.st_mode):
            total += info.st_size
        elif stat.S_ISDIR(info.st_mode):
            with os.scandir(path) as children:
                for child in children:
                    pending.append(Path(child.path))
                    require(count + len(pending) <= MAX_ENTRIES, "Fixture contains too many entries")
        else:
            require(stat.S_ISLNK(info.st_mode), "Fixture contains a special file")
        require(total <= MAX_FIXTURE_BYTES, "Fixture exceeds the one-MiB source limit")
    return total


def manifest_bytes(snapshot):
    return sum(entry.get("size", 0) + sum(value["size"] for value in entry.get("xattrs", {}).values())
               for entry in snapshot["manifest"])


class Budget:
    def __init__(self):
        self.started = time.monotonic()
        self.deadline = self.started + MAX_SECONDS

    def remaining(self, final=False):
        available = self.deadline - time.monotonic() - (0 if final else FINAL_SECONDS)
        if available <= 0:
            raise TrialDeadline("Cloud trial reached its deadline")
        return available

    def command(self, command, timeout=COMMAND_SECONDS, final=False):
        limit = min(timeout, self.remaining(final))
        try:
            result = subprocess.run([str(x) for x in command], stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=limit, check=False)
        except subprocess.TimeoutExpired:
            raise TrialError("A fixture command reached its deadline") from None
        # Never emit stderr, command arguments, tokens, or a CLI's raw error.
        require(result.returncode == 0, "A required fixture command failed")
        return result.stdout


def load_exact(name, path):
    path = no_links(path)
    require(path.is_file(), "A required signed helper is missing")
    specification = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(specification)
    sys.modules[name] = module
    specification.loader.exec_module(module)
    require(Path(module.__file__).absolute() == path, "The wrong helper module was loaded")
    return module


def verify_bundle(app, budget, final=False):
    requirement = ('anchor apple generic and identifier "' + BUNDLE_ID
                   + '" and certificate leaf[subject.OU] = "' + TEAM_ID
                   + '" and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
                   + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
    budget.command(["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", "=" + requirement, app], final=final)
    resources = app / "Contents/Resources"
    require(not any(path.name == "__pycache__" or path.suffix in {".pyc", ".pyo"}
                    for path in resources.rglob("*")), "Signed Resources contain Python bytecode")


def index_state(library, path):
    with library.library_lock():
        library.safe_path(path)
        if not path.exists():
            return {"exists": False}
        before = path.stat()
        require(before.st_size <= 16 * 1024 * 1024, "Production index exceeds the diagnostic read limit")
        value = digest(path)
        after = path.stat()
        require((before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_ino, after.st_size, after.st_mtime_ns), "Production index changed while being observed")
        return {"exists": True, "bytes": before.st_size, "sha256": value}


def set_attribute(library, path, name, value):
    function = library._native_xattr_api().setxattr
    function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_void_p,
                         ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
    function.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(value, max(1, len(value)))
    require(function(os.fsencode(path), os.fsencode(name), buffer, len(value), 0, library.XATTR_NOFOLLOW) == 0,
            "Could not create disposable macOS metadata")


def make_fixtures(root, library, budget, supplied_app, nonce):
    sources = root / "Sources"
    sources.mkdir(mode=0o700)
    plain = sources / "Small File.txt"
    plain.write_bytes(b"GenDragoon real cloud roundtrip fixture.\n" * 16)
    plain.chmod(0o600)
    folder = sources / "Complete Folder"
    (folder / "nested").mkdir(parents=True, mode=0o700)
    (folder / "empty").mkdir(mode=0o700)
    payload = folder / "nested/payload.bin"
    payload.write_bytes(bytes(range(256)) * 4)
    (folder / "nested/relative-link").symlink_to("payload.bin")
    command = folder / "executable.command"
    command.write_text("#!/bin/sh\nexit 0\n")
    command.chmod(0o755)
    set_attribute(library, folder, "app.gendragoon.cloudsmoke", b"folder metadata")
    set_attribute(library, payload, "com.apple.ResourceFork", b"GDRF\0" + bytes(range(64)))
    set_attribute(library, payload, "app.gendragoon.empty", b"")
    app = sources / "Cloud Roundtrip.app"
    if supplied_app:
        original = no_links(supplied_app)
        require(original.is_dir() and original.suffix == ".app", "Fixture app must be a real .app directory")
        bounded_tree(original)
        info = plistlib.loads((original / "Contents/Info.plist").read_bytes())
        require(str(info.get("CFBundleIdentifier", "")).startswith("app.gendragoon.smoke."),
                "Only a disposable GenDragoon smoke application may be supplied")
        original_snapshot = library.snapshot(original)
        require(manifest_bytes(original_snapshot) <= MAX_FIXTURE_BYTES,
                "Supplied fixture including metadata exceeds one MiB")
        budget.command(["/usr/bin/codesign", "--verify", "--deep", "--strict", original])
        budget.command(["/usr/bin/ditto", original, app])
        library.verify_restored(app, original_snapshot["manifest"])
        library.unchanged(original, original_snapshot)
    else:
        (app / "Contents/MacOS").mkdir(parents=True, mode=0o700)
        (app / "Contents/Resources").mkdir(mode=0o700)
        source = root / "fixture.c"
        source.write_text("int main(void) { return 0; }\n")
        binary = app / "Contents/MacOS/GenDragoonCloudFixture"
        budget.command(["/usr/bin/xcrun", "clang", "-x", "c", "-Os", "-fno-modules",
                        "-fno-implicit-modules", "-arch", "arm64", "-mmacosx-version-min=14.0",
                        source, "-o", binary], timeout=20)
        info = {"CFBundleIdentifier": "app.gendragoon.smoke.gcs." + nonce,
                "CFBundleExecutable": binary.name, "CFBundleName": "Cloud Roundtrip",
                "CFBundlePackageType": "APPL", "CFBundleShortVersionString": "1.0.0",
                "CFBundleVersion": "1", "CFBundleSupportedPlatforms": ["MacOSX"],
                "LSMinimumSystemVersion": "14.0", "LSUIElement": True}
        (app / "Contents/Info.plist").write_bytes(plistlib.dumps(info))
        (app / "Contents/Resources/fixture.txt").write_text("Disposable fixture; no user content.\n")
        budget.command(["/usr/bin/codesign", "--force", "--sign", "-", "--timestamp=none", app])
    info = plistlib.loads((app / "Contents/Info.plist").read_bytes())
    name = info.get("CFBundleExecutable", "")
    library.check_name(name)
    require("MacOSX" in info.get("CFBundleSupportedPlatforms", [])
            and (app / "Contents/MacOS" / name).is_file(), "Fixture is not a compatible Mac application bundle")
    require("arm64" in budget.command(["/usr/bin/lipo", "-archs", app / "Contents/MacOS" / name]).split(),
            "Fixture app does not contain an arm64 executable")
    budget.command(["/usr/bin/codesign", "--verify", "--deep", "--strict", app])
    paths = [plain, folder, app]
    require(sum(bounded_tree(path) for path in paths) <= MAX_FIXTURE_BYTES, "Combined fixtures exceed one MiB")
    snapshots = [library.snapshot(path) for path in paths]
    folder_entries = {entry["path"]: entry for entry in snapshots[1]["manifest"]}
    attributes = folder_entries["nested/payload.bin"].get("xattrs", {})
    fork = b"GDRF\0" + bytes(range(64))
    require(attributes.get("com.apple.ResourceFork") == {"size": len(fork), "sha256": hashlib.sha256(fork).hexdigest()}
            and attributes.get("app.gendragoon.empty") == {"size": 0, "sha256": hashlib.sha256(b"").hexdigest()}
            and folder_entries["empty"]["type"] == "directory"
            and folder_entries["nested/relative-link"].get("target") == "payload.bin"
            and folder_entries["executable.command"]["executable"] == 0o111,
            "Folder fixture did not capture its independently expected metadata")
    total = sum(manifest_bytes(snapshot) for snapshot in snapshots)
    require(total <= MAX_FIXTURE_BYTES, "Fixtures including metadata exceed one MiB")
    return paths, snapshots, total


class CloudCommands:
    """Restrict actual production commands to this fixture and remote prefix."""
    def __init__(self, library, root, folder, remote, budget, report, save):
        self.library, self.root, self.folder, self.remote = library, root, folder, remote
        self.budget, self.report, self.save = budget, report, save
        self.original_run = library.run
        self.key = None

    def __call__(self, arguments, timeout=1800):
        args = [str(value) for value in arguments]
        if args[0] == str(self.library.RCLONE):
            require(len(args) >= 6 and args[1:4] == ["--config", str(self.library.CONFIG), "copyto"],
                    "Unexpected cloud operation was blocked")
            require(args[6:] in ([], ["--retries", "3"]), "Unexpected cloud flags were blocked")
            source, destination = args[4:6]
            prefix = self.remote + ":" + self.folder + "/"
            write = destination.startswith(prefix)
            read = source.startswith(prefix)
            require(write != read, "Cloud operation escaped the test prefix")
            cloud_name, local_name = (destination, source) if write else (source, destination)
            filename = cloud_name[len(prefix):]
            require(self.key is not None and re.fullmatch(re.escape(self.key) + r"-[a-f0-9]{64}-[a-f0-9]{32}\.(?:zip|txt)", filename),
                    "Cloud object is not an immutable fixture archive")
            local = no_links(local_name)
            require(local.is_relative_to(self.root), "Cloud command escaped local fixture storage")
            object_name = self.folder.partition("/")[2] + "/" + filename
            record = next((item for item in self.report["objects"] if item["name"] == object_name), None)
            if write:
                require(record is None and local.is_file() and local.stat().st_size <= MAX_ARCHIVE_BYTES,
                        "Unexpected duplicate or oversized cloud upload")
                sha256 = digest(local)
                require("-" + sha256 + "-" in filename, "Immutable archive name and bytes disagree")
                record = {"name": object_name, "key": self.key, "sha256": sha256,
                          "archiveBytes": local.stat().st_size, "state": "upload_outcome_unknown",
                          "readbacks": 0}
                self.report["objects"].append(record)
                self.save()
            else:
                require(record is not None, "Read was not tied to an observed fixture upload")
            result = self.original_run(args, timeout=min(timeout, COMMAND_SECONDS, self.budget.remaining()))
            if write:
                record["state"] = "uploaded"
            else:
                require(local.is_file() and local.stat().st_size == record["archiveBytes"]
                        and digest(local) == record["sha256"], "Cloud fixture readback differs from its uploaded bytes")
                record["readbacks"] += 1
            self.save()
            return result
        require(args[0] == "/usr/bin/ditto", "Unexpected local helper operation was blocked")
        for value in args[-2:]:
            require(no_links(value).is_relative_to(self.root), "Archive operation escaped local fixture storage")
        return self.original_run(args, timeout=min(timeout, COMMAND_SECONDS, self.budget.remaining()))


def call_reply(function, *args, **kwargs):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        function(*args, **kwargs)
    value = output.getvalue()
    require(len(value) <= 65536, "Helper response exceeded the fixture limit")
    result = json.loads(value)
    require(isinstance(result, dict) and result.get("ok") is True, "Helper did not report success")
    return result


def run(args):
    require(sys.platform == "darwin" and platform.machine() == "arm64", "Run this trial on an Apple Silicon Mac")
    require(sys.version_info >= (3, 10), "Python 3.10 or newer is required")
    require((args.project, args.bucket, args.remote) == EXPECTED, "Explicit cloud arguments do not match the authorized test destination")
    budget = Budget()
    def alarm(_signum, _frame):
        raise TrialDeadline("Cloud trial reached its hard deadline")
    prior_alarm = signal.signal(signal.SIGALRM, alarm)
    signal.setitimer(signal.ITIMER_REAL, MAX_SECONDS)
    root = library = production_index = None
    paths, snapshots = [], []
    report = {"ok": False, "scope": "authenticated GCS component roundtrip only", "objects": [], "checks": [],
              "project": args.project, "bucket": args.bucket, "remote": args.remote,
              "limits": {"totalSeconds": MAX_SECONDS, "commandSeconds": COMMAND_SECONDS,
                         "googleAPISeconds": 35, "finalVerificationSeconds": FINAL_SECONDS,
                         "originalBytes": MAX_FIXTURE_BYTES, "objects": 3},
              "cloudCleanupPerformed": False, "offloadRequested": False, "originalsDeleted": False,
              "nativeFirebaseSignInTested": False, "backendAcceptanceTested": False, "appLaunchTested": False,
              "productionReserveOverridden": False, "bytecodeWritingEnabled": False,
              "originalFixturesUnchanged": None}
    def save():
        if root:
            temporary = root / (MARKER + ".tmp")
            with temporary.open("w") as output:
                json.dump(report, output, indent=2); output.write("\n"); output.flush(); os.fsync(output.fileno())
            temporary.chmod(0o600)
            os.replace(temporary, root / MARKER)
    try:
        resources = no_links(args.resources)
        require(resources.name == "Resources" and resources.parent.name == "Contents"
                and resources.parent.parent.suffix == ".app", "Supply Resources inside the signed GenDragoon app")
        app = resources.parent.parent
        verify_bundle(app, budget)
        report["bundleSignatureBefore"] = True
        base = check_directory(args.work_dir)
        root = Path(tempfile.mkdtemp(prefix="gd-gcs-roundtrip-", dir=base)).resolve()
        root.chmod(0o700)
        nonce = uuid.uuid4().hex
        prefix = "GenDragoon-Validation/roundtrip-" + nonce
        report.update(fixtureDirectory=str(root), cloudPrefix=prefix,
                      resources=str(resources), runID=nonce)
        save()
        library = load_exact("gendragoon_library", resources / "gendragoon_library.py")
        connect = load_exact("gd_cloud_smoke_connect", resources / "gendragoon_connect.py")
        workspace = load_exact("gendragoon_upload_workspace", resources / "gendragoon_upload_workspace.py")
        report["helperSHA256"] = {name: digest(resources / name) for name in
                                  ("gendragoon_library.py", "gendragoon_connect.py", "gendragoon_upload_workspace.py")}
        production_index = library.INDEX
        report["productionIndexBefore"] = index_state(library, production_index)
        require(root.stat().st_dev == library.SUPPORT.stat().st_dev,
                "Fixture and real library lock must share a filesystem for atomic index writes")
        # Preserve authentication, HOME and the actual cross-process locks.
        library.CACHE = root / "Cache"
        library.INDEX = root / "app-library.json"
        library.check_remote(args.remote)
        require(library.CONFIG.stat().st_size <= MAX_FIXTURE_BYTES, "Cloud configuration exceeds the diagnostic limit")
        configuration = configparser.RawConfigParser(interpolation=None)
        configuration.read(library.CONFIG)
        require(configuration.has_section(args.remote), "Requested remote is not configured")
        remote = configuration[args.remote]
        require(remote.get("type", "").casefold() in {"gcs", "google cloud storage"}
                and remote.get("env_auth", "").casefold() == "true"
                and not any(remote.get(name, "") for name in ("endpoint", "service_account_file", "service_account_credentials")),
                "Trial requires the existing delegated Google Cloud remote without endpoint or credential overrides")
        require(not any(name.startswith(("RCLONE_GCS_", "RCLONE_CONFIG_" + args.remote.upper() + "_"))
                        for name in os.environ), "Rclone environment overrides prevent a controlled fixture trial")
        raw_connect_run = connect.run
        def bounded_connect(command, *, timeout=300, **options):
            return raw_connect_run(command, timeout=min(timeout, COMMAND_SECONDS, budget.remaining()), **options)
        connect.run = bounded_connect
        paths, snapshots, source_bytes = make_fixtures(root, library, budget, args.fixture_app, nonce)
        report["originalFixtureBytes"] = source_bytes
        report["appFixture"] = "copied supplied smoke app" if args.fixture_app else "locally compiled immediately exiting C app"
        context = {"project": args.project, "bucket": args.bucket, "remote": args.remote}
        folder = args.bucket + "/" + prefix
        with library.maintenance_lock():
            chosen = workspace.read_state().get("destination") or {}
            require(all(chosen.get(key) == value for key, value in context.items()),
                    "Verified native workspace does not match the requested cloud destination")
            gcloud = connect.find_executable("gcloud")
            require(gcloud is not None, "Existing Google Cloud CLI authorization is unavailable")
            owner = connect.google_json(gcloud, "https://cloudresourcemanager.googleapis.com/v1/projects/" + args.project)
            bucket = connect.google_json(gcloud, "https://storage.googleapis.com/storage/v1/b/" + args.bucket)
            require(owner.get("projectId") == args.project and owner.get("lifecycleState") == "ACTIVE"
                    and str(owner.get("projectNumber", "")).isdecimal()
                    and bucket.get("name") == args.bucket
                    and str(bucket.get("projectNumber")) == str(owner["projectNumber"]),
                    "Google did not verify the selected project's bucket ownership")
            listing = connect.google_json(gcloud, "https://storage.googleapis.com/storage/v1/b/" + args.bucket
                                          + "/o?maxResults=10&prefix=" + urllib.parse.quote(prefix + "/", safe=""))
            require(not listing.get("items") and not listing.get("nextPageToken"), "New test prefix is not empty")
            report["cloudOwnershipVerified"] = True
            report["prefixInitiallyEmpty"] = True
            guard = CloudCommands(library, root, folder, args.remote, budget, report, save)
            library.run = guard
            for source, baseline in zip(paths, snapshots):
                print(json.dumps({"phase": "cloud_roundtrip", "fixture": source.name}), file=sys.stderr, flush=True)
                guard.key = library.keyfor(args.remote, folder, source.name, args.project, args.bucket)
                result = call_reply(library.upload, source, args.remote, folder, offload=False,
                                    project=args.project, bucket=args.bucket)
                require(result.get("verified") is True and result.get("offloaded") is False
                        and result.get("key") == guard.key
                        and all(result.get(key) == value for key, value in context.items())
                        and result.get("folder") == folder and result.get("source") == str(source)
                        and result.get("kind") == library.kindof(source),
                        "Upload did not match the explicit fixture destination and source")
                result = call_reply(library.stage_item, guard.key, open_after=False, **context)
                expected = library.CACHE / guard.key / source.name
                require(result.get("localPath") == str(expected), "Restore escaped the isolated cache")
                library.verify_restored(expected, baseline["manifest"])
                library.unchanged(source, baseline)
                if source.suffix == ".app":
                    budget.command(["/usr/bin/codesign", "--verify", "--deep", "--strict", expected])
                record = next(item for item in report["objects"] if item["key"] == guard.key)
                metadata = connect.google_json(gcloud, "https://storage.googleapis.com/storage/v1/b/" + args.bucket
                                               + "/o/" + urllib.parse.quote(record["name"], safe=""))
                require(metadata.get("name") == record["name"] and str(metadata.get("generation", "")).isdecimal()
                        and int(metadata.get("size", -1)) == record["archiveBytes"], "Cloud object metadata does not match the fixture")
                record.update(state="verified", generation=str(metadata["generation"]))
                report["checks"].append({"fixture": source.name, "kind": library.kindof(source), "key": guard.key,
                                         "uploadReadbackVerified": True, "separateRestoreVerified": True,
                                         "contentAndMetadataMatched": True, "originalUnchanged": True})
                save()
            require(len(report["objects"]) == 3 and all(item["readbacks"] == 2 for item in report["objects"]),
                    "Trial did not complete exactly three uploads and six readbacks")
            for source, baseline in zip(paths, snapshots):
                library.unchanged(source, baseline)
            report["ok"] = True
    except BaseException as error:
        # Diagnostics are intentionally bounded and contain no raw CLI/network output.
        report["errorType"] = type(error).__name__
        report["error"] = str(error) if isinstance(error, (TrialError, TrialDeadline)) else "A production helper or fixture operation failed; retained evidence must be reviewed before retrying"
    finally:
        try:
            budget.remaining(final=True)
            if len(paths) == 3 and len(snapshots) == 3:
                for source, baseline in zip(paths, snapshots):
                    library.unchanged(source, baseline)
                report["originalFixturesUnchanged"] = True
        except BaseException:
            report["ok"] = False
            report["originalVerificationIncomplete"] = True
        try:
            budget.remaining(final=True)
            if library is not None and production_index is not None:
                report["productionIndexAfter"] = index_state(library, production_index)
                report["productionIndexUnchanged"] = report.get("productionIndexBefore") == report["productionIndexAfter"]
                if not report["productionIndexUnchanged"]:
                    report["ok"] = False
        except BaseException:
            report["ok"] = False
            report["indexVerificationIncomplete"] = True
        try:
            budget.remaining(final=True)
            if root is not None:
                verify_bundle(Path(report["resources"]).parent.parent, budget, final=True)
                report["bundleSignatureAfter"] = True
        except BaseException:
            report["ok"] = False
            report["finalVerificationIncomplete"] = True
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, prior_alarm)
        report["elapsedSeconds"] = round(time.monotonic() - budget.started, 3)
        report["evidenceRetained"] = root is not None
        save()
    print(json.dumps(report, indent=2, sort_keys=True), flush=True)
    return 0 if report["ok"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--work-dir", type=Path, required=True)
    parser.add_argument("--project", required=True)
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--remote", required=True)
    parser.add_argument("--fixture-app", type=Path)
    args = parser.parse_args()
    try:
        return run(args)
    except BaseException as error:
        print(json.dumps({"ok": False, "scope": "GCS component trial preflight", "errorType": type(error).__name__,
                          "error": str(error) if isinstance(error, TrialError) else "Trial preflight could not finish"}), flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
