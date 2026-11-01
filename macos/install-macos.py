#!/usr/bin/env python3
"""Verify, install, and optionally restart the pinned GenDragoon macOS package.

Requires Python 3.9+. This is a local-archive installer, not an updater service.
The pinned v0.16.2 release is a draft; checksum verification alone does NOT make
it installable. macOS must also accept its Developer ID signature and Gatekeeper
assessment. No security bypass, owner API key, or credential storage is included.

Linux/package inspection:
  python3 install-macos.py --archive /path/to/GenDragoon-Cloud-SSD-Mac-v0.16.2.zip --verify-archive
Mac installation/reinstallation (only after the trust checks pass):
  python3 install-macos.py --archive /path/to/GenDragoon-Cloud-SSD-Mac-v0.16.2.zip --reinstall --restart

The original app is retained beside the installation as a uniquely named backup.
User settings, Keychain credentials, application data, and caches are untouched.
An active GenDragoon cloud mount blocks replacement; safely disconnect it in the
app first. This script never unmounts a drive or force-kills an application.
After a failed update, a restored previous app may remain stopped; it is not
automatically relaunched. Launch observation does not establish API or feature
readiness. The owner API key is neither needed nor read by this local installer.
"""

import argparse
from contextlib import contextmanager
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import plistlib
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unicodedata
import uuid
import zipfile


APP_NAME = "GenDragoon Cloud SSD.app"
EXECUTABLE = "GenDragoon Cloud SSD"
BUNDLE_ID = "app.gendragoon.cloudssd"
TEAM_ID = "NZPU8H843J"
VERSION = "0.16.2"
BUILD = "19"
MINIMUM_MACOS = (14, 0)
ARCHIVE_BYTES = 109663181
ARCHIVE_SHA256 = "02f238beb8614f27fa6b943ed9c79a4d23faa9ce1b65e125cb4cbd28b50ab144"
MAX_ENTRIES = 40000
MAX_UNPACKED = 5 * 1024 ** 3
MINIMUM_FREE = 64 * 1024 ** 2
INFO_MEMBER = APP_NAME + "/Contents/Info.plist"
EXECUTABLE_MEMBER = APP_NAME + "/Contents/MacOS/" + EXECUTABLE


class InstallError(RuntimeError):
    """An installation safety or validation requirement was not met."""


def run_checked(arguments, timeout=90):
    """Run an explicit executable, with no shell interpolation."""
    try:
        result = subprocess.run(arguments, capture_output=True, text=True,
                                timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise InstallError("Command failed: " + str(arguments[0]) + ": " + str(exc)) from exc
    if result.returncode:
        detail = (result.stderr or result.stdout or "no diagnostic").strip()[:600]
        raise InstallError(str(arguments[0]) + " rejected the operation: " + detail)
    return result.stdout + "\n" + result.stderr


def release_version(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", value):
        raise InstallError("Unrecognized application version")
    return tuple(map(int, value.split(".")))


def require_metadata(info):
    expected = {
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": BUILD,
        "CFBundleExecutable": EXECUTABLE,
        "CFBundlePackageType": "APPL",
        "LSMinimumSystemVersion": "14.0",
    }
    if not isinstance(info, dict):
        raise InstallError("Application metadata is not a dictionary")
    for key, value in expected.items():
        if info.get(key) != value:
            raise InstallError("Package metadata mismatch: " + key)


def mach_architectures(header):
    """Read Mach-O CPU IDs without executing the binary (also works on Linux)."""
    arm64 = 0x0100000C
    if len(header) < 8:
        raise InstallError("Executable has an incomplete Mach-O header")
    magic = header[:4]
    thin = {b"\xcf\xfa\xed\xfe": "<", b"\xfe\xed\xfa\xcf": ">"}
    if magic in thin:
        cpu = struct.unpack(thin[magic] + "I", header[4:8])[0]
        return {"arm64" if cpu == arm64 else "unsupported-" + hex(cpu)}
    fat = {b"\xca\xfe\xba\xbe": (">", 20), b"\xbe\xba\xfe\xca": ("<", 20),
           b"\xca\xfe\xba\xbf": (">", 32), b"\xbf\xba\xfe\xca": ("<", 32)}
    if magic not in fat:
        raise InstallError("Executable is not a supported Mach-O binary")
    endian, entry_size = fat[magic]
    count = struct.unpack(endian + "I", header[4:8])[0]
    if not 0 < count <= 16 or len(header) < 8 + count * entry_size:
        raise InstallError("Executable has an invalid universal Mach-O header")
    cpus = {struct.unpack(endian + "I", header[8 + i * entry_size:12 + i * entry_size])[0]
            for i in range(count)}
    return {"arm64" if cpu == arm64 else "unsupported-" + hex(cpu) for cpu in cpus}


def validate_zip_entries(infos):
    if not infos or len(infos) > MAX_ENTRIES:
        raise InstallError("Archive has an invalid number of entries")
    unpacked = sum(entry.file_size for entry in infos)
    if unpacked > MAX_UNPACKED:
        raise InstallError("Archive exceeds the expanded-size limit")
    seen = {}
    for entry in infos:
        name = entry.filename
        trimmed = name[:-1] if name.endswith("/") else name
        parts = trimmed.split("/")
        if (not trimmed or name.startswith(("/", "~")) or "\\" in name or ":" in name
                or any(ord(char) < 32 or ord(char) == 127 for char in name)
                or any(piece in ("", ".", "..") for piece in parts)
                or PurePosixPath(trimmed).is_absolute()
                or parts[0] not in (APP_NAME, "__MACOSX")):
            raise InstallError("Unsafe archive path")
        normalized = unicodedata.normalize("NFC", trimmed).casefold()
        if normalized in seen:
            raise InstallError("Archive contains duplicate or case-colliding paths")
        mode = entry.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if kind == stat.S_IFLNK:
            raise InstallError("Archive contains a symlink")
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR):
            raise InstallError("Archive contains a special file")
        if kind == stat.S_IFDIR and not entry.is_dir():
            raise InstallError("Archive directory metadata is inconsistent")
        if entry.flag_bits & 1:
            raise InstallError("Encrypted archive entries are not supported")
        seen[normalized] = entry.is_dir()
    for normalized in seen:
        parents = PurePosixPath(normalized).parents
        if any(str(parent) in seen and not seen[str(parent)] for parent in parents):
            raise InstallError("Archive places a file inside another file")
    return unpacked


def verify_archive(archive):
    archive = Path(archive).expanduser().absolute()
    if archive.is_symlink() or not archive.is_file():
        raise InstallError("Archive must be an existing regular file, not a symlink")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(archive, flags)
    with os.fdopen(descriptor, "rb") as stream:
        before = os.fstat(stream.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size != ARCHIVE_BYTES:
            raise InstallError("Pinned archive size mismatch")
        digest = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 ** 2), b""):
            digest.update(chunk)
        if digest.hexdigest() != ARCHIVE_SHA256:
            raise InstallError("Pinned archive SHA-256 mismatch")
        stream.seek(0)
        try:
            with zipfile.ZipFile(stream) as package:
                unpacked = validate_zip_entries(package.infolist())
                if package.getinfo(INFO_MEMBER).file_size > 1024 ** 2:
                    raise InstallError("Application metadata is unexpectedly large")
                require_metadata(plistlib.loads(package.read(INFO_MEMBER)))
                with package.open(EXECUTABLE_MEMBER) as executable:
                    architectures = mach_architectures(executable.read(1024))
                if architectures != {"arm64"}:
                    raise InstallError("Pinned package is not an arm64-only build")
                if not (package.getinfo(EXECUTABLE_MEMBER).external_attr >> 16) & 0o111:
                    raise InstallError("Package binary lacks executable permissions")
        except (zipfile.BadZipFile, KeyError, plistlib.InvalidFileException, ValueError) as exc:
            raise InstallError("Package structure or metadata is invalid") from exc
        after = os.fstat(stream.fileno())
        if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            raise InstallError("Archive changed during verification")
    return {"archive": str(archive), "sha256": ARCHIVE_SHA256,
            "archive_bytes": ARCHIVE_BYTES, "expanded_bytes": unpacked,
            "bundle_id": BUNDLE_ID, "version": VERSION, "build": BUILD,
            "architecture": "arm64", "minimum_macos": "14.0",
            "status": "package_verified_only",
            "apple_signature_and_gatekeeper": "not_assessed",
            "release_status": "draft"}


def require_mac():
    if platform.system() != "Darwin":
        raise InstallError("Installation requires macOS; use --verify-archive for inspection here")
    if platform.machine() != "arm64":
        raise InstallError("This package requires an Apple Silicon Mac (arm64)")
    try:
        version = tuple(map(int, platform.mac_ver()[0].split(".")))
    except ValueError as exc:
        raise InstallError("Could not determine the macOS version") from exc
    if version < MINIMUM_MACOS:
        raise InstallError("This package requires macOS 14 or later")


def no_symlink_parents(path):
    if any(parent.is_symlink() for parent in [path, *path.parents]):
        raise InstallError("Installation path contains a symlink")


def prepare_destination(directory):
    parent = Path(directory).expanduser().absolute()
    if any(ord(char) < 32 or ord(char) == 127 for char in str(parent)):
        raise InstallError("Installation path contains a control character")
    no_symlink_parents(parent)
    parent.mkdir(parents=True, exist_ok=True)
    no_symlink_parents(parent)
    app = parent / APP_NAME
    if app.is_symlink() or (app.exists() and not app.is_dir()):
        raise InstallError("Existing app path is not a regular application directory")
    return app


def check_installed_version(app, reinstall):
    if not app.exists():
        return
    if app.is_symlink():
        raise InstallError("Installed app is a symlink")
    metadata = app / "Contents/Info.plist"
    no_symlink_parents(metadata)
    try:
        with metadata.open("rb") as stream:
            info = plistlib.load(stream)
    except (OSError, ValueError, plistlib.InvalidFileException) as exc:
        raise InstallError("Existing application metadata cannot be verified") from exc
    if not isinstance(info, dict) or info.get("CFBundleIdentifier") != BUNDLE_ID:
        raise InstallError("Refusing to replace a different application's bundle")
    installed = release_version(info.get("CFBundleShortVersionString"))
    target = release_version(VERSION)
    existing_build = str(info.get("CFBundleVersion", ""))
    if not existing_build.isdecimal():
        raise InstallError("Existing application build number is invalid")
    if installed > target or (installed == target and int(existing_build) > int(BUILD)):
        raise InstallError("Refusing an application downgrade")
    if installed == target and not reinstall:
        raise InstallError("This version is already installed; use --reinstall to explicitly replace it")


def verify_app(app):
    if app.is_symlink() or not app.is_dir():
        raise InstallError("Extracted application is missing or symlinked")
    for directory, folders, files in os.walk(app, followlinks=False):
        if any((Path(directory) / name).is_symlink() for name in folders + files):
            raise InstallError("Extracted application contains a symlink")
    try:
        with (app / "Contents/Info.plist").open("rb") as stream:
            require_metadata(plistlib.load(stream))
    except (OSError, ValueError, plistlib.InvalidFileException) as exc:
        raise InstallError("Extracted application metadata is invalid") from exc
    executable = app / "Contents/MacOS" / EXECUTABLE
    if not executable.is_file() or not os.access(executable, os.X_OK):
        raise InstallError("Extracted executable is missing or not executable")
    requirement = ('anchor apple generic and identifier "' + BUNDLE_ID
                   + '" and certificate leaf[subject.OU] = "' + TEAM_ID
                   + '" and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
                   + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
    run_checked(["/usr/bin/codesign", "--verify", "--deep", "--strict", "--verbose=2",
                 "-R", "=" + requirement, str(app)], timeout=120)
    signature = run_checked(["/usr/bin/codesign", "-dv", "--verbose=4", str(app)])
    if (not re.search(r"(?m)^TeamIdentifier=" + re.escape(TEAM_ID) + r"$", signature)
            or not re.search(r"(?m)^Identifier=" + re.escape(BUNDLE_ID) + r"$", signature)
            or not re.search(r"(?m)^Authority=Developer ID Application:", signature)
            or "Signature=adhoc" in signature):
        raise InstallError("App does not have the required Developer ID identity")
    architectures = run_checked(["/usr/bin/lipo", "-archs", str(executable)]).split()
    if architectures != ["arm64"]:
        raise InstallError("Extracted executable architecture mismatch")
    run_checked(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", str(app)],
                timeout=120)
    # Gatekeeper may accept an online ticket; distribution requires an
    # actual stapled ticket for reliable offline first launch.
    run_checked(["/usr/bin/xcrun", "stapler", "validate", str(app)], timeout=120)


class _DarwinStatFS(ctypes.Structure):
    # Public arm64 statfs ABI, from Apple XNU bsd/sys/mount.h. On arm64 the
    # 64-bit-inode API has no symbol suffix; never use this layout on x86_64.
    _fields_ = [
        ("f_bsize", ctypes.c_uint32), ("f_iosize", ctypes.c_int32),
        ("f_blocks", ctypes.c_uint64), ("f_bfree", ctypes.c_uint64),
        ("f_bavail", ctypes.c_uint64), ("f_files", ctypes.c_uint64),
        ("f_ffree", ctypes.c_uint64), ("f_fsid", ctypes.c_int32 * 2),
        ("f_owner", ctypes.c_uint32), ("f_type", ctypes.c_uint32),
        ("f_flags", ctypes.c_uint32), ("f_fssubtype", ctypes.c_uint32),
        ("f_fstypename", ctypes.c_char * 16),
        ("f_mntonname", ctypes.c_char * 1024),
        ("f_mntfromname", ctypes.c_char * 1024),
        ("f_flags_ext", ctypes.c_uint32), ("f_reserved", ctypes.c_uint32 * 7),
    ]


def mounted_volumes():
    """Copy a read-only, owned Darwin mount snapshot; never touch a volume.

    getmntinfo_r_np (macOS 10.13+) avoids getmntinfo's shared static buffer.
    MNT_NOWAIT reads cached kernel information, including stale NFS mounts.
    See Apple Libc gen/FreeBSD/getmntinfo.c and XNU bsd/sys/mount.h.
    """
    error = "Cannot inspect macOS mount table; installation is postponed"
    if (sys.platform != "darwin" or platform.machine() != "arm64"
            or ctypes.sizeof(ctypes.c_void_p) != 8
            or ctypes.sizeof(_DarwinStatFS) != 2168
            or _DarwinStatFS.f_mntonname.offset != 88
            or _DarwinStatFS.f_mntfromname.offset != 1112):
        raise InstallError(error)
    try:
        library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        inventory = library.getmntinfo_r_np
        inventory.argtypes = [ctypes.POINTER(ctypes.POINTER(_DarwinStatFS)), ctypes.c_int]
        inventory.restype = ctypes.c_int
        release = library.free
        release.argtypes = [ctypes.c_void_p]
        release.restype = None
    except (OSError, AttributeError) as exc:
        raise InstallError(error) from exc
    pointer = ctypes.POINTER(_DarwinStatFS)()
    try:
        count = inventory(ctypes.byref(pointer), 2)  # MNT_NOWAIT; no disk operation.
        if not 0 < count <= 10000 or not pointer:
            raise InstallError(error)
        result = []
        for index in range(count):
            entry = pointer[index]
            names = []
            for name, capacity in (("f_mntfromname", 1024), ("f_mntonname", 1024),
                                   ("f_fstypename", 16)):
                raw = ctypes.string_at(ctypes.addressof(entry) + getattr(_DarwinStatFS, name).offset,
                                       capacity)
                end = raw.find(b"\0")
                if end <= 0:
                    raise InstallError(error)
                names.append(os.fsdecode(raw[:end]))
            if not names[1].startswith("/"):
                raise InstallError(error)
            result.append(tuple(names))
        if not any(target == "/" for _, target, _ in result):
            raise InstallError(error)
        return tuple(result)
    except (OSError, ValueError, ctypes.ArgumentError) as exc:
        raise InstallError(error) from exc
    finally:
        if pointer:
            release(pointer)


def ensure_no_active_mount(extra_paths=()):
    # Failure to read the mount table blocks an update rather than risking a transfer.
    mounts = mounted_volumes()
    paths = [Path.home() / "GenDragoon Cloud SSD", *[Path(p).expanduser().absolute() for p in extra_paths]]
    # Compare native names without shell unescaping or stat'ing a remote volume.
    # Case/canonical-equivalent names conservatively match common Mac filesystems.
    def comparable(value):
        return unicodedata.normalize("NFC", os.path.normpath(value)).casefold()
    expected = {comparable(str(path)) for path in paths}
    for source, target, _ in mounts:
        if (comparable(target) in expected or "gendragoon" in source.casefold()
                or "gendragoon" in target.casefold()):
            raise InstallError("Active GenDragoon cloud mount detected; safely disconnect it in the app first")


def running_pids(app, *, include_helpers=False):
    """Inspect kernel executable paths; launch confirmation remains main-only.

    Bundle replacement additionally checks every executable beneath the app,
    including rclone, Node and nested helper applications. Matching the bundle
    path with its separator excludes similarly named sibling applications.
    """
    output = run_checked(["/bin/ps", "-axo", "pid="], timeout=10)
    try:
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        proc_pidpath = library.proc_pidpath
        proc_pidpath.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        proc_pidpath.restype = ctypes.c_int
    except (OSError, AttributeError) as exc:
        raise InstallError("Cannot inspect executable paths; app replacement is blocked") from exc
    wanted = str((app / "Contents/MacOS" / EXECUTABLE).resolve())
    bundle_prefix = str(app.resolve()) + os.sep
    found = []
    for line in output.splitlines():
        if not line.strip().isdecimal():
            continue
        pid = int(line.strip())
        buffer = ctypes.create_string_buffer(4096)
        length = proc_pidpath(pid, buffer, len(buffer))
        if length > 0:
            executable = os.path.realpath(os.fsdecode(buffer.value))
            if executable == wanted or (include_helpers and executable.startswith(bundle_prefix)):
                found.append(pid)
    return found


def ensure_bundle_stopped(app):
    if running_pids(app, include_helpers=True):
        raise InstallError("Application or bundled helper is still running; replacement is postponed")


def graceful_quit(app, timeout=45):
    if not running_pids(app):
        return False
    quoted = '"' + str(app).replace("\\", "\\\\").replace('"', '\\"') + '"'
    run_checked(["/usr/bin/osascript", "-e", "tell application " + quoted + " to quit"], timeout=15)
    deadline = time.monotonic() + timeout
    while running_pids(app):
        if time.monotonic() >= deadline:
            raise InstallError("App did not exit gracefully; installation is postponed")
        time.sleep(0.25)
    return True


def launch_app(app, timeout=20):
    run_checked(["/usr/bin/open", "-n", str(app)], timeout=15)
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pids = running_pids(app)
        if pids:
            # Catch immediate crashes without presenting a PID as functional readiness.
            time.sleep(1)
            stable = sorted(set(pids).intersection(running_pids(app)))
            if stable:
                return stable
        time.sleep(0.25)
    raise InstallError("App launch could not be confirmed from its exact executable path")


@contextmanager
def maintenance_lock(home=None):
    """Coordinate with uploads, cleanup, reset and automatic updates."""
    import fcntl
    support = Path(home or Path.home()) / "Library/Application Support/GenDragoon Cloud SSD"
    root = support / "AutoUpdates"
    no_symlink_parents(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    no_symlink_parents(root)
    for directory in (support, root):
        metadata = directory.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o022):
            raise InstallError("Unsafe shared maintenance directory")
    path = root / "update.lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_nlink != 1 or metadata.st_mode & 0o077):
            raise InstallError("Unsafe shared maintenance lock")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise InstallError("An upload, cleanup, update or restart is active; installation is postponed") from exc
        yield
    finally:
        os.close(descriptor)


@contextmanager
def installation_lock(parent):
    import fcntl
    path = parent / ".gendragoon-install.lock"
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        metadata = os.fstat(descriptor)
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_nlink != 1 or metadata.st_mode & 0o077):
            raise InstallError("Installation lock is not a regular file owned by this user")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise InstallError("Another installation is already running") from exc
        yield
    finally:
        os.close(descriptor)


def install(archive, directory, reinstall=False, restart=False, mount_paths=()):
    require_mac()
    # Validate before creating anything beside the existing app.
    details = verify_archive(archive)
    archive = Path(details["archive"])
    app = prepare_destination(directory)
    with maintenance_lock(), installation_lock(app.parent):
        check_installed_version(app, reinstall)
        ensure_no_active_mount(mount_paths)
        required = MINIMUM_FREE + details["archive_bytes"] + details["expanded_bytes"]
        if shutil.disk_usage(app.parent).free < required:
            raise InstallError("Insufficient space for the verified archive and extracted app plus filesystem staging allowance")
        with tempfile.TemporaryDirectory(prefix=".gendragoon-install-", dir=app.parent) as work:
            work = Path(work)
            local_archive = work / "release.zip"
            shutil.copyfile(archive, local_archive, follow_symlinks=False)
            # Revalidate the private copy that ditto will actually extract.
            verify_archive(local_archive)
            extracted = work / "extracted"
            extracted.mkdir(mode=0o700)
            run_checked(["/usr/bin/ditto", "-x", "-k", str(local_archive), str(extracted)], timeout=240)
            staged = extracted / APP_NAME
            verify_app(staged)
            # All package/signature/Gatekeeper checks precede any quit or app mutation.
            ensure_no_active_mount(mount_paths)
            graceful_quit(app)
            ensure_no_active_mount(mount_paths)
            check_installed_version(app, reinstall)
            verify_app(staged)
            # A prior app can leave rclone or another bundled helper running
            # even after its main process and cloud mount have stopped.
            ensure_bundle_stopped(app)
            backup = None
            installed = False
            launched = []
            try:
                if app.exists():
                    backup = app.parent / ("GenDragoon Cloud SSD.previous-" + uuid.uuid4().hex + ".app")
                    os.replace(app, backup)
                os.replace(staged, app)
                installed = True
                verify_app(app)
                if restart:
                    launched = launch_app(app)
            except Exception as failure:
                # Never remove a running app. If it refuses a graceful quit, retain
                # both bundles and report the exact backup for manual recovery.
                try:
                    if installed:
                        graceful_quit(app)
                        ensure_bundle_stopped(app)
                    if backup is not None and backup.exists():
                        ensure_bundle_stopped(backup)
                    # Check both bundles before moving either one. A surviving
                    # helper must leave the candidate and rollback copy intact.
                    if installed:
                        failed = work / "failed.app"
                        os.replace(app, failed)
                    if backup is not None and backup.exists():
                        os.replace(backup, app)
                except Exception as rollback_failure:
                    raise InstallError("Update failed and automatic rollback could not complete safely; "
                                       "do not delete the retained backup. Previous app: " + str(backup)
                                       + "; installation: " + str(app) + "; reason: "
                                       + str(rollback_failure)) from failure
                raise InstallError("Installation failed; previous app restored when present: "
                                   + str(failure)) from failure
    return {"status": "installed", "app": str(app), "version": VERSION, "build": BUILD,
            "backup": str(backup) if backup else None,
            "apple_signature_and_gatekeeper": "passed",
            "launch": "exact_executable_observed" if launched else "not_requested",
            "pids": launched, "functional_readiness": "not_tested",
            "api_readiness": "not_tested"}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--archive", required=True, type=Path, help="Local pinned v0.16.2 release ZIP")
    parser.add_argument("--verify-archive", action="store_true", help="Verify package only; works on Linux")
    parser.add_argument("--install-dir", type=Path, default=Path.home() / "Applications")
    parser.add_argument("--reinstall", action="store_true", help="Explicitly permit reinstalling the same version")
    parser.add_argument("--restart", action="store_true", help="Launch after a successful installation")
    parser.add_argument("--mount-path", action="append", default=[],
                        help="Additional cloud mount path to guard (repeatable)")
    args = parser.parse_args(argv)
    if args.verify_archive and (args.restart or args.reinstall):
        parser.error("--verify-archive cannot be combined with --restart or --reinstall")
    try:
        if args.verify_archive:
            result = verify_archive(args.archive)
        else:
            result = install(args.archive, args.install_dir, args.reinstall, args.restart, args.mount_path)
    except (InstallError, OSError) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}, sort_keys=True), file=sys.stderr)
        return 1
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
