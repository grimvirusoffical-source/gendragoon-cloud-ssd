#!/usr/bin/env python3
"""A bundled, retained update worker with an acknowledged pre-quit handoff.

Only this app's signed resources are copied. The detached worker performs no
download, preserves the shared maintenance lock, and never signals the app or
unmounts storage. Its private snapshot survives replacement of the app bundle.
"""
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import argparse
import ctypes
import hashlib
import importlib
import json
from pathlib import Path
import re
import select
import signal
import stat
import struct
import subprocess
import tempfile
import threading
import time
import uuid

DEPENDENCIES = (
    "gendragoon_update_restart.py", "gendragoon_auto_update.py",
    "gendragoon_app_control.py", "gendragoon_app_launch.py", "gendragoon_library.py",
    "gendragoon_upload_workspace.py", "gendragoon_performance.py",
    "gendragoon_performance_profiles.json",
)
MAX_SOURCE = 2 * 1024**2
MAX_RECEIPT = 128 * 1024
READY_TIMEOUT = 240
EXIT_TIMEOUT = 90
QUIET_SAMPLES = 3
PRIMARY_QUIET_INTERVAL = 6
MAX_META_FILES = 10000
MAX_META_BYTES = 16 * 1024**2
auto = control = launcher = None


def load_runtime(directory):
    """Called after snapshot hashes are verified; all lazy helpers are retained."""
    global auto, control, launcher
    directory = Path(directory)
    sys.path.insert(0, str(directory))
    auto = importlib.import_module("gendragoon_auto_update")
    control = importlib.import_module("gendragoon_app_control")
    launcher = importlib.import_module("gendragoon_app_launch")
    for module in (auto, control, launcher, launcher.lib, launcher.lib.performance):
        if Path(module.__file__).absolute().parent != directory.absolute():
            raise RuntimeError("Update worker dependency escaped its verified snapshot")


def read_owned(path, limit, private=True):
    path = Path(path)
    for entry in (path, *path.parents):
        if entry.is_symlink():
            raise RuntimeError("Unsafe linked restart path")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_uid != os.getuid() or (private and info.st_mode & 0o077)):
            raise RuntimeError("Unsafe restart file ownership or permissions")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise RuntimeError("Restart file exceeds its size limit")
        after = os.fstat(stream.fileno())
        current = path.lstat()
        if ((info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
                != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
                or (current.st_dev,current.st_ino)!=(info.st_dev,info.st_ino)):
            raise RuntimeError("Restart file changed during inspection")
        return data


def write_owned(path, data):
    path = Path(path)
    fd, name = tempfile.mkstemp(prefix=".restart-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if path.exists() or path.is_symlink():
            read_owned(path, MAX_RECEIPT)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def verify_snapshot(directory):
    directory = Path(directory).absolute()
    for entry in (directory, *directory.parents):
        if entry.is_symlink():
            raise RuntimeError("Unsafe linked worker directory")
    info = directory.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise RuntimeError("Restart worker directory must be private")
    receipt = json.loads(read_owned(directory / "request.json", MAX_RECEIPT))
    if (not isinstance(receipt, dict) or receipt.get("schema") != 1
            or receipt.get("request_id") != directory.name
            or not re.fullmatch(r"[a-f0-9]{32}", directory.name)
            or set(receipt.get("sources", {})) != set(DEPENDENCIES)):
        raise RuntimeError("Invalid retained restart request")
    for name in DEPENDENCIES:
        content = read_owned(directory / name, MAX_SOURCE)
        if hashlib.sha256(content).hexdigest() != receipt["sources"][name]:
            raise RuntimeError("Retained update helper changed after staging")
    return receipt


def identity_record(identity):
    return {"pid": identity.pid, "uid": os.getuid(), "executable": identity.executable, "started": identity.started}


def metadata_roots(support):
    roots = [support / "Cache/vfsMeta"]
    sessions = support / "LaunchSessions"
    auto.safe_path(sessions, directory=True)
    if sessions.exists():
        entries = list(sessions.iterdir())
        if len(entries) > MAX_META_FILES:
            raise RuntimeError("Too many launch session records to inspect safely")
        for entry in entries:
            if entry.is_symlink():
                raise RuntimeError("Unsafe linked launch session")
            if entry.is_dir():
                if not re.fullmatch(r"[a-f0-9]{32}", entry.name):
                    raise RuntimeError("Unknown launch session directory; update postponed")
                roots.append(entry / "vfs/vfsMeta")
    return roots


def ensure_clean_cache(support=None):
    """Read only known rclone metadata trees; unknown/dirty state blocks quit."""
    support = control.support() if support is None else Path(support)
    count = total = 0
    def fail(error):
        raise error
    for root in metadata_roots(support):
        auto.safe_path(root, directory=True)
        if not root.exists():
            continue
        for directory, folders, files in os.walk(root, followlinks=False, onerror=fail):
            parent = Path(directory)
            info = parent.lstat()
            if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                    or len(parent.relative_to(root).parts) > 64):
                raise RuntimeError("Unsafe VFS metadata directory")
            for name in folders:
                if (parent / name).is_symlink():
                    raise RuntimeError("Linked VFS metadata is not safe to inspect")
            for name in files:
                count += 1
                if count > MAX_META_FILES:
                    raise RuntimeError("VFS metadata inspection limit reached")
                payload = read_owned(parent / name, MAX_RECEIPT, private=False)
                total += len(payload)
                if total > MAX_META_BYTES:
                    raise RuntimeError("VFS metadata inspection byte limit reached")
                record = json.loads(payload)
                if not isinstance(record, dict) or record.get("Dirty") is not False:
                    raise RuntimeError("Unsynced or unknown VFS cache state; update postponed")
    return count


def ensure_queue_idle(support):
    path = support / "UploadWorkspace/state.json"
    auto.safe_path(path, regular=True)
    if not path.exists():
        return
    workspace = importlib.import_module("gendragoon_upload_workspace")
    state = workspace.validate_state(workspace.strict_json(read_owned(path, workspace.MAX_STATE_BYTES)))
    if state["active_job_id"] is not None or any(job["state"] in ("queued", "running") for job in state["jobs"]):
        raise RuntimeError("An upload is queued or running; update postponed")


def parse_process_arguments(data):
    """Darwin procargs2: argc, executable C string, padding, argc C strings.

    Stop at argc. Environment strings are neither decoded nor retained.
    """
    if len(data) < 5:
        raise RuntimeError("Process arguments are incomplete")
    count = struct.unpack_from("=i", data)[0]
    if count <= 0 or count > 4096:
        raise RuntimeError("Process argument count is invalid")
    offset = data.find(b"\0", 4)
    if offset < 0:
        raise RuntimeError("Process executable argument is incomplete")
    while offset < len(data) and data[offset] == 0:
        offset += 1
    arguments = []
    for _ in range(count):
        end = data.find(b"\0", offset)
        if end < 0:
            raise RuntimeError("Process argument is incomplete")
        arguments.append(os.fsdecode(data[offset:end]))
        offset = end + 1
    return arguments


def process_arguments(pid):
    control.require_mac()
    # Public Darwin sysctl ABI, <sys/sysctl.h>: CTL_KERN, KERN_PROCARGS2.
    library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
    query = library.sysctl
    query.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p,
                      ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
    query.restype = ctypes.c_int
    mib = (ctypes.c_int * 3)(1, 49, pid)
    buffer = ctypes.create_string_buffer(1024**2)
    length = ctypes.c_size_t(len(buffer))
    if query(mib, 3, buffer, ctypes.byref(length), None, 0) != 0 or length.value > len(buffer):
        raise RuntimeError("Could not verify the primary mount arguments")
    return parse_process_arguments(buffer.raw[:length.value])


def verify_primary_arguments(arguments, executable, support, mount):
    if (len(arguments) < 7 or arguments[:4] != [str(executable), "--config", str(support / "gendragoon-rclone.conf"), "nfsmount"]
            or arguments[5] != str(mount)
            or not re.fullmatch(r"[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+", arguments[4])):
        raise RuntimeError("This is not the app's exact primary cloud mount")
    for prefix, expected in (("--cache-dir", str(support / "Cache")), ("--vfs-cache-mode", "full"),
                             ("--vfs-cache-min-free-space", "10G"), ("--vfs-write-back", "10s")):
        matches = [item for item in arguments[6:] if item == prefix or item.startswith(prefix + "=")]
        if matches != [prefix + "=" + expected]:
            raise RuntimeError("Primary mount safety arguments do not match")
    if "--daemon" in arguments or any(arg.startswith("--daemon=") for arg in arguments):
        raise RuntimeError("A detached mount is not the app's managed foreground mount")


def primary_mount(app):
    mount = Path.home() / "GenDragoon Cloud SSD"
    volumes = [row for row in control.mounted_volumes() if row[1] == str(mount)]
    if not volumes:
        return None
    if (len(volumes) != 1 or volumes[0][2] != "nfs"
            or not volumes[0][0].startswith(("127.0.0.1:", "localhost:"))):
        raise RuntimeError("The primary mount does not have its expected local NFS identity")
    executable = Path(app) / "Contents/Resources/rclone"
    found = []
    for pid in control.app_pids(executable):
        identity = control.identify(pid, executable)
        verify_primary_arguments(process_arguments(pid), executable, control.support(), mount)
        found.append(identity)
    if len(found) != 1:
        raise RuntimeError("Cannot identify one exact owned primary mount process")
    return found[0]


def verify_parent(pid, app):
    executable = control.trusted_bundle(app)
    identity = control.identify(pid, executable)
    if any(other != pid for other in control.app_pids(executable)):
        raise RuntimeError("Another application instance is active")
    return identity


def ensure_quiet(app, allowed_pids=(), samples=1, primary=None):
    allowed = {os.getpid(), *allowed_pids}
    support = control.support()
    mount = Path.home() / "GenDragoon Cloud SSD"
    watched = (Path(app), support / "Cache", support / "LaunchSessions", mount)
    prefixes = tuple(str(path).rstrip("/") + "/" for path in watched)
    for sample in range(samples):
        if primary is None:
            control.ensure_idle(app)
        else:
            if primary_mount(app) != primary:
                raise RuntimeError("Primary mount process changed during quiet verification")
            allowed.add(primary.pid)
            for volume in control.mounted_volumes():
                if volume[1] == str(mount):
                    continue
                if any(name in value.casefold() for value in volume
                       for name in ("gendragoon", "gen-dragoon", "cloudssd", "rclone")):
                    raise RuntimeError("Another cloud mount is active; update postponed")
        if launcher.sessions().get("active"):
            raise RuntimeError("An application session or cloud mount is active; update postponed")
        for pid, _, uid, arguments in control.processes():
            if uid == os.getuid() and pid not in allowed and any(
                    helper in arguments for helper in ("rclone", "gendragoon_stream.py", "gendragoon_library.py",
                        "gendragoon_preload.py", "gendragoon_connect.py", "gendragoon_app_launch.py",
                        "gendragoon_upload_workspace.py", "gendragoon_project_files.py")):
                raise RuntimeError("A cloud upload or file operation is active; update postponed")
        for pid, opened in launcher.open_files():
            if pid not in allowed and (opened in tuple(str(path) for path in watched) or opened.startswith(prefixes)):
                raise RuntimeError("Application or cache files are still open; update postponed")
        ensure_clean_cache(support)
        ensure_queue_idle(support)
        if sample + 1 < samples:
            time.sleep(1)


def quiesce_primary(app, parent_pid):
    primary = primary_mount(app)
    if primary is None:
        ensure_quiet(app, (parent_pid,))
        return
    for sample in range(QUIET_SAMPLES):
        ensure_quiet(app, (parent_pid,), primary=primary)
        if sample + 1 < QUIET_SAMPLES:
            time.sleep(PRIMARY_QUIET_INTERVAL)
    # Check the kernel path, UID and start time again immediately before the
    # single normal termination signal. No force kill or unmount command exists.
    if control.identify(primary.pid, Path(primary.executable)) != primary:
        raise RuntimeError("Primary mount identity changed; it was not signalled")
    os.kill(primary.pid, signal.SIGTERM)
    control.wait_for_exit(primary, timeout=45)
    deadline = time.monotonic() + 15
    mount = str(Path.home() / "GenDragoon Cloud SSD")
    while any(target == mount for _, target, _ in control.mounted_volumes()):
        if time.monotonic() >= deadline:
            raise RuntimeError("Primary mount did not shut down normally; update postponed")
        time.sleep(0.25)
    ensure_quiet(app, (parent_pid,))


def retained_request(app, pid, channel):
    """Called while the signed original is alive, before asking it to quit."""
    control.require_mac()
    app = Path(app).absolute()
    if Path(__file__).absolute().parent != app / "Contents/Resources":
        raise RuntimeError("Schedule updates using the helper bundled with the installed application")
    auto.configure(app, channel)
    with auto.update_lock(timeout=0):
        identity = verify_parent(pid, app)
        auto.validate_app(app, "v" + auto.version_of(app))
        stage = auto.staged_valid(strict=True)
        if stage is None or not stage.get("bundleDigest"):
            raise RuntimeError("No fully verified update is staged for this channel")
        ensure_quiet(app, (pid,), primary=primary_mount(app))
        original_digest = auto.bundle_digest(app)
        root = control.ensure_directory(auto.ROOT / "restart-workers", Path.home(), private=True)
        request_id = uuid.uuid4().hex
        directory = root / request_id
        directory.mkdir(mode=0o700)
        sources = {}
        for name in DEPENDENCIES:
            content = read_owned(app / "Contents/Resources" / name, MAX_SOURCE, private=False)
            sources[name] = hashlib.sha256(content).hexdigest()
            write_owned(directory / name, content)
        # Reject changes to any signed source while the snapshot was copied.
        auto.validate_app(app, "v" + auto.version_of(app))
        if auto.bundle_digest(app) != original_digest:
            raise RuntimeError("The installed application changed during the restart handoff")
        receipt = {"schema": 1, "request_id": request_id, "app": str(app), "channel": channel,
                   "identity": identity_record(identity), "originalDigest": original_digest,
                   "stage": stage, "sources": sources, "createdAt": time.time()}
        write_owned(directory / "request.json", (json.dumps(receipt) + "\n").encode())
        verify_snapshot(directory)
        return directory, receipt


def cancelled(directory, receipt):
    path = directory / "cancel.json"
    if not path.exists() and not path.is_symlink():
        return False
    record = json.loads(read_owned(path, MAX_RECEIPT))
    if record != {"request_id": receipt["request_id"], "pid": receipt["identity"]["pid"]}:
        raise RuntimeError("Invalid restart cancellation record")
    return True


def wait_for_parent(directory, receipt, timeout=EXIT_TIMEOUT):
    expected = receipt["identity"]
    deadline = time.monotonic() + timeout
    while True:
        if cancelled(directory, receipt):
            raise RuntimeError("Application quit was cancelled; update postponed")
        current = control.kernel_path(expected["pid"])
        if current is None or current != expected["executable"]:
            return
        try:
            identity = control.identify(expected["pid"], Path(expected["executable"]))
        except control.ControlError as error:
            if error.code == "wrong_pid" and control.kernel_path(expected["pid"]) is None:
                return
            raise
        if identity.started != expected["started"]:
            return  # PID reuse is not the original process remaining alive.
        if time.monotonic() >= deadline:
            raise RuntimeError("Application did not close normally; update postponed")
        time.sleep(0.25)


def run_worker(directory, ready_fd):
    ready_sent = False
    receipt = None
    locked = False
    try:
        directory = Path(directory).absolute()
        receipt = verify_snapshot(directory)
        load_runtime(directory)
        control.require_mac()
        app = Path(receipt["app"])
        auto.configure(app, receipt["channel"])
        # The library uses its runtime path only for local session inspection.
        # No command in this worker prepares or downloads an update.
        launcher.lib.RCLONE = app / "Contents/Resources/rclone"
        with auto.update_lock(timeout=0):
            locked = True
            if time.time() - receipt["createdAt"] > READY_TIMEOUT or time.time() < receipt["createdAt"] - 5:
                raise RuntimeError("Restart request expired; keep the app open")
            identity = verify_parent(receipt["identity"]["pid"], app)
            if identity_record(identity) != receipt["identity"]:
                raise RuntimeError("The application process changed before the restart handoff")
            auto.validate_app(app, "v" + auto.version_of(app))
            if auto.bundle_digest(app) != receipt["originalDigest"]:
                raise RuntimeError("The original application changed before restart")
            if auto.staged_valid(strict=True) != receipt["stage"]:
                raise RuntimeError("The staged update changed before restart")
            quiesce_primary(app, identity.pid)
            if cancelled(directory, receipt):
                raise RuntimeError("Restart handoff was cancelled")
            record = {"state": "scheduled", "request_id": receipt["request_id"], "pid": identity.pid,
                      "exitTimeoutSeconds": EXIT_TIMEOUT,
                      "message": "Verified restart worker is ready. The app will close and reopen automatically."}
            auto.write_status("scheduled", request_id=receipt["request_id"], version=receipt["stage"]["version"])
            os.write(ready_fd, (json.dumps(record) + "\n").encode())
            os.close(ready_fd)
            ready_fd = None
            ready_sent = True
            wait_for_parent(directory, receipt)
            if control.app_pids(auto.app_executable(app)):
                raise RuntimeError("Another application instance is running; update postponed")
            ensure_quiet(app, samples=QUIET_SAMPLES)
            auto.write_status("installing", request_id=receipt["request_id"], version=receipt["stage"]["version"])
            outcome = auto.install_worker(quiet=True, relaunch=True, expected_stage=receipt["stage"],
                safety_check=lambda: ensure_quiet(app), original_digest=receipt["originalDigest"],
                request_id=receipt["request_id"])
            return 0 if outcome["event"] in ("installed", "rolled_back") else 1
    except Exception as error:
        message = str(error)[:220]
        request_id = receipt.get("request_id") if isinstance(receipt, dict) else None
        if locked and auto is not None:
            try:
                existing = json.loads(auto.STATUS.read_text()) if auto.STATUS.exists() else {}
                if existing.get("request_id") != request_id or existing.get("state") not in ("rolled_back", "attention", "installed"):
                    restored = []
                    recovery_error = None
                    try:
                        if ready_sent and auto.bundle_digest(app) == receipt["originalDigest"] and not control.app_pids(auto.app_executable(app)):
                            # Disk/validation failure after normal quit must not
                            # leave the unchanged original needlessly closed.
                            auto.validate_app(app, "v" + auto.version_of(app))
                            ensure_quiet(app)
                            restored = auto.process_records(app, auto.launch_app(app))
                    except Exception:
                        recovery_error = "The existing app could not be safely reopened; open it after cloud activity finishes."
                    auto.write_status("postponed", request_id=request_id, reason=message, launchedProcesses=restored,
                                      launchStatus="exact_executable_observed" if restored else "not_relaunched",
                                      recoveryMessage=recovery_error,
                                      message="Automatic update postponed. Existing app and recovery copies are retained.")
            except Exception:
                pass
        if not ready_sent and ready_fd is not None:
            try:
                os.write(ready_fd, (json.dumps({"state": "failed", "request_id": request_id, "message": message}) + "\n").encode())
            except OSError:
                pass
        return 1
    finally:
        if ready_fd is not None:
            os.close(ready_fd)


def schedule(pid, app, ui_busy, channel="stable", ready_timeout=READY_TIMEOUT):
    if ui_busy:
        raise RuntimeError("Wait for current application work to finish before automatic restart")
    if pid <= 1 or not Path(app).is_absolute():
        raise RuntimeError("The current application process and absolute bundle path are required")
    if auto is None:
        load_runtime(Path(__file__).absolute().parent)
    directory, receipt = retained_request(app, pid, channel)
    read_fd, write_fd = os.pipe()
    child = None
    try:
        child = subprocess.Popen([sys.executable, "-I", "-B", str(directory / "gendragoon_update_restart.py"),
            "worker", "--directory", str(directory), "--ready-fd", str(write_fd)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True, pass_fds=(write_fd,))
        os.close(write_fd)
        write_fd = None
        deadline = time.monotonic() + ready_timeout
        data = bytearray()
        while b"\n" not in data:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([read_fd], [], [], remaining)[0]:
                raise RuntimeError("Restart worker did not become ready. The app will remain open")
            chunk = os.read(read_fd, 4096)
            if not chunk or len(data) + len(chunk) > MAX_RECEIPT:
                raise RuntimeError("Restart worker failed before acknowledging the handoff")
            data.extend(chunk)
        result = json.loads(data)
        if result.get("state") != "scheduled" or result.get("request_id") != receipt["request_id"]:
            raise RuntimeError(result.get("message", "Restart worker could not become ready"))
        threading.Thread(target=child.wait, daemon=True).start()
        return result
    except BaseException:
        # Cancel only this request. The worker cannot install until a successful
        # ACK and verified parent exit; a broken pipe also cancels its handoff.
        write_owned(directory / "cancel.json", json.dumps({"request_id": receipt["request_id"], "pid": pid}).encode())
        if child is not None:
            threading.Thread(target=child.wait, daemon=True).start()
        raise
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)


def cancel(request_id, pid, app):
    if auto is None:
        load_runtime(Path(__file__).absolute().parent)
    if not isinstance(request_id, str) or not re.fullmatch(r"[a-f0-9]{32}", request_id):
        raise RuntimeError("Invalid automatic restart request")
    directory = auto.ROOT / "restart-workers" / request_id
    receipt = verify_snapshot(directory)
    if str(Path(app).absolute()) != receipt["app"] or pid != receipt["identity"]["pid"]:
        raise RuntimeError("Restart cancellation does not match this app")
    if identity_record(control.identify(pid, auto.app_executable(app))) != receipt["identity"]:
        raise RuntimeError("Restart cancellation belongs to a different app process")
    write_owned(directory / "cancel.json", json.dumps({"request_id": request_id, "pid": pid}).encode())
    return {"state": "cancelled", "request_id": request_id,
            "message": "The app stayed open. Automatic update will retry when it is idle."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("worker",))
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--ready-fd", type=int, required=True)
    args = parser.parse_args(argv)
    os.umask(0o077)
    return run_worker(args.directory, args.ready_fd)


if __name__ == "__main__":
    sys.exit(main())
