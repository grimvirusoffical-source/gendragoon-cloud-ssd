#!/usr/bin/env python3
"""Restart GenDragoon without resetting accounts, caches, originals or cloud data.

CLI: reset --pid PID --app /absolute/App.app --ui-busy {true,false}
Exit 0 and {"state":"scheduled"} mean a detached, locked worker is ready.
Only then may the calling UI quit. Other outcomes exit 1 with a safe JSON error.
The worker never kills the app or unmounts a volume. Post-quit outcomes are in
AppControl/status.json (also available with the ``status`` subcommand).
UI isBusy must cover in-process transfers: OS checks cannot see every URLSession.
"""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse
from contextlib import contextmanager
import ctypes
from dataclasses import dataclass
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import platform
import plistlib
import select
import signal
import stat
import subprocess
import sys
import threading
import time
import uuid

BUNDLE_ID = "app.gendragoon.cloudssd"
TEAM_ID = "NZPU8H843J"
APP_NAME = "GenDragoon Cloud SSD.app"
READY_TIMEOUT = 90
EXIT_TIMEOUT = 90
LAUNCH_TIMEOUT = 30
OUTCOME_TIMEOUT = 240
MAX_STATUS = 16384
MESSAGES = {
    "unsupported_platform": "Restart requires macOS 14 or later on Apple silicon.",
    "unsafe_path": "An app-control path is linked, shared or unsafe. Restart was cancelled.",
    "invalid_app": "The selected application bundle is not the expected GenDragoon app.",
    "untrusted_app": "The installed app could not pass Apple signature and trust verification.",
    "wrong_pid": "The supplied process is not this installed GenDragoon application.",
    "busy": "Wait for transfers and cloud helpers to finish before restarting.",
    "active_mount": "Safely unmount the GenDragoon cloud drive before restarting.",
    "inspection_failed": "The app could not verify that restarting is safe. Restart was cancelled.",
    "update_in_progress": "An update or restart is already running. Try again after it finishes.",
    "worker_failed": "The restart helper could not become ready. The app will remain open.",
    "exit_timeout": "The app did not close in time. Quit it normally, then open it again.",
    "launch_failed": "The app closed but macOS could not reopen it. Open GenDragoon from Applications.",
    "launch_unconfirmed": "The restart could not confirm the app process. Open GenDragoon from Applications.",
    "operation_timeout": "Restart exceeded its time limit. Open GenDragoon from Applications.",
    "unexpected_error": "Restart could not finish. Your cloud files and local data were preserved.",
}


class ControlError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(MESSAGES[code])


def result_failure(error):
    code = error.code if isinstance(error, ControlError) else "unexpected_error"
    return {"state": "failed", "error": code, "message": MESSAGES[code]}


def emit(record):
    print(json.dumps(record, separators=(",", ":")), flush=True)


def support(home=None):
    return (Path.home() if home is None else Path(home)) / "Library/Application Support/GenDragoon Cloud SSD"


def ensure_directory(path, home, private=False):
    """Reject symlinked ancestry and unsafe ownership without chmodding user data."""
    path, home = Path(path).absolute(), Path(home).absolute()
    try:
        relative = path.relative_to(home)
    except ValueError:
        raise ControlError("unsafe_path") from None
    # Inspect home ancestry too; resolving first would hide a symlink.
    for ancestor in (home, *home.parents):
        if ancestor.is_symlink():
            raise ControlError("unsafe_path")
    current = home
    for part in (None, *relative.parts):
        if part is not None:
            current = current / part
        try:
            info = current.lstat()
        except FileNotFoundError:
            current.mkdir(mode=0o700)
            info = current.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ControlError("unsafe_path")
    if private and path.stat().st_mode & 0o077:
        raise ControlError("unsafe_path")
    return path


def regular_private(info):
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
        raise ControlError("unsafe_path")


@contextmanager
def control_root(home=None):
    home = Path.home() if home is None else Path(home)
    root = ensure_directory(support(home) / "AppControl", home, private=True)
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        yield root, descriptor
    finally:
        os.close(descriptor)


def check_owned_name(descriptor, name):
    try:
        regular_private(os.stat(name, dir_fd=descriptor, follow_symlinks=False))
    except FileNotFoundError:
        pass


def atomic_owned_write(descriptor, name, data):
    check_owned_name(descriptor, name)
    temporary = ".control-" + uuid.uuid4().hex
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        check_owned_name(descriptor, name)
        os.replace(temporary, name, src_dir_fd=descriptor, dst_dir_fd=descriptor)
    finally:
        try:
            os.unlink(temporary, dir_fd=descriptor)
        except FileNotFoundError:
            pass


def write_status(record, home=None):
    with control_root(home) as (_, descriptor):
        atomic_owned_write(descriptor, "status.json", (json.dumps({**record, "updatedAt": time.time()}) + "\n").encode())


def read_status(home=None, request_id=None):
    with control_root(home) as (_, descriptor):
        try:
            fd = os.open("status.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        except FileNotFoundError:
            return {"state": "not_found", "request_id": request_id, "message": "No matching restart has been scheduled."}
        with os.fdopen(fd, "rb") as stream:
            regular_private(os.fstat(stream.fileno()))
            data = stream.read(MAX_STATUS + 1)
        if len(data) > MAX_STATUS:
            raise ControlError("unsafe_path")
        record = json.loads(data)
        stored_id = record.get("request_id")
        if request_id is not None and stored_id != request_id:
            return {"state": "not_found", "request_id": request_id, "message": "No matching restart status was found."}
        if not valid_request_id(stored_id):
            raise ControlError("unsafe_path")
        # Never echo arbitrary fields from a modified status file.
        state = record.get("state")
        if state not in {"scheduled", "waiting_for_exit", "restarting", "restarted", "failed"}:
            raise ControlError("unsafe_path")
        if state == "failed":
            code = record.get("error")
            return {**result_failure(ControlError(code if code in MESSAGES else "unexpected_error")), "request_id": stored_id}
        return {"state": state, "request_id": stored_id, "message": {
            "scheduled": "Restart scheduled; cloud files and local data are preserved.",
            "waiting_for_exit": "Waiting for the app to close normally.",
            "restarting": "Asking macOS to reopen the verified app.",
            "restarted": "The app process restarted. Backend readiness has not been tested.",
        }[state]}


@contextmanager
def update_lock(home=None):
    home = Path.home() if home is None else Path(home)
    root = ensure_directory(support(home) / "AutoUpdates", home, private=True)
    parent = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptor = None
    locked = False
    try:
        check_owned_name(parent, "update.lock")
        descriptor = os.open("update.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        regular_private(os.fstat(descriptor))
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except BlockingIOError:
            raise ControlError("update_in_progress") from None
        yield
    finally:
        if descriptor is not None:
            if locked:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)
        os.close(parent)


def command(arguments, timeout=12):
    try:
        return subprocess.run(arguments, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired):
        raise ControlError("inspection_failed") from None


def require_mac():
    try:
        major = int(platform.mac_ver()[0].split(".")[0])
    except ValueError:
        major = 0
    if platform.system() != "Darwin" or platform.machine() != "arm64" or major < 14:
        raise ControlError("unsupported_platform")


def no_symlink(path):
    path = Path(path).absolute()
    for component in (path, *path.parents):
        if component.is_symlink():
            raise ControlError("unsafe_path")
    return path


def trusted_bundle(app):
    app = no_symlink(app)
    if app.name != APP_NAME or not app.is_dir():
        raise ControlError("invalid_app")
    try:
        plist = no_symlink(app / "Contents/Info.plist")
        with plist.open("rb") as stream:
            info = plistlib.load(stream)
        if info.get("CFBundleIdentifier") != BUNDLE_ID or info.get("CFBundleExecutable") != "GenDragoon Cloud SSD":
            raise ControlError("invalid_app")
        executable = no_symlink(app / "Contents/MacOS" / info["CFBundleExecutable"])
        if not executable.is_file():
            raise ControlError("invalid_app")
    except (OSError, ValueError, plistlib.InvalidFileException):
        raise ControlError("invalid_app") from None
    requirement = ('anchor apple generic and identifier "' + BUNDLE_ID + '" and certificate leaf[subject.OU] = "' + TEAM_ID
                   + '" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
    for args in (
        ["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", "=" + requirement, str(app)],
        ["/usr/sbin/spctl", "--assess", "--type", "execute", str(app)],
    ):
        if command(args, timeout=30).returncode:
            raise ControlError("untrusted_app")
    architectures = command(["/usr/bin/lipo", "-archs", str(executable)])
    if architectures.returncode or "arm64" not in architectures.stdout.split():
        raise ControlError("untrusted_app")
    return executable


def kernel_path(pid):
    """proc_pidpath is kernel supplied; ps command text alone is not identity."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except (OSError, ValueError):
        raise ControlError("inspection_failed") from None
    try:
        library = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
        function = library.proc_pidpath
        function.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        function.restype = ctypes.c_int
        buffer = ctypes.create_string_buffer(4096)
        if function(pid, buffer, len(buffer)) <= 0:
            if ctypes.get_errno() == errno.ESRCH:
                return None
            raise ControlError("inspection_failed")
        return os.fsdecode(buffer.value)
    except OSError:
        raise ControlError("inspection_failed") from None


@dataclass(frozen=True)
class ProcessIdentity:
    pid: int
    executable: str
    started: str


def identify(pid, executable):
    if pid <= 1 or kernel_path(pid) != str(executable):
        raise ControlError("wrong_pid")
    details = command(["/bin/ps", "-p", str(pid), "-o", "uid=", "-o", "lstart="])
    fields = details.stdout.strip().split(maxsplit=1)
    if details.returncode or len(fields) != 2 or fields[0] != str(os.getuid()):
        raise ControlError("wrong_pid")
    return ProcessIdentity(pid, str(executable), fields[1])


def processes():
    result = command(["/bin/ps", "-axo", "pid=,ppid=,uid=,command="])
    if result.returncode:
        raise ControlError("inspection_failed")
    entries = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(maxsplit=3)
        if len(fields) == 4 and all(value.isdecimal() for value in fields[:3]):
            entries.append((int(fields[0]), int(fields[1]), int(fields[2]), fields[3]))
    return entries


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
    if (sys.platform != "darwin" or platform.machine() != "arm64"
            or ctypes.sizeof(ctypes.c_void_p) != 8
            or ctypes.sizeof(_DarwinStatFS) != 2168
            or _DarwinStatFS.f_mntonname.offset != 88
            or _DarwinStatFS.f_mntfromname.offset != 1112):
        raise ControlError("inspection_failed")
    try:
        library = ctypes.CDLL("/usr/lib/libSystem.B.dylib", use_errno=True)
        inventory = library.getmntinfo_r_np
        inventory.argtypes = [ctypes.POINTER(ctypes.POINTER(_DarwinStatFS)), ctypes.c_int]
        inventory.restype = ctypes.c_int
        release = library.free
        release.argtypes = [ctypes.c_void_p]
        release.restype = None
    except (OSError, AttributeError):
        raise ControlError("inspection_failed") from None
    pointer = ctypes.POINTER(_DarwinStatFS)()
    try:
        count = inventory(ctypes.byref(pointer), 2)  # MNT_NOWAIT; no disk operation.
        if not 0 < count <= 10000 or not pointer:
            raise ControlError("inspection_failed")
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
                    raise ControlError("inspection_failed")
                names.append(os.fsdecode(raw[:end]))
            if not names[1].startswith("/"):
                raise ControlError("inspection_failed")
            result.append(tuple(names))
        if not any(target == "/" for _, target, _ in result):
            raise ControlError("inspection_failed")
        return tuple(result)
    except (OSError, ValueError, ctypes.ArgumentError):
        raise ControlError("inspection_failed") from None
    finally:
        if pointer:
            release(pointer)


def ensure_idle(app, ui_busy=False):
    if ui_busy:
        raise ControlError("busy")
    for volume in mounted_volumes():
        if any(name in value.casefold() for value in volume
               for name in ("gendragoon", "gen-dragoon", "cloudssd", "rclone")):
            raise ControlError("active_mount")
    known = ("gendragoon_stream.py", "gendragoon_library.py", "gendragoon_preload.py", "gendragoon_connect.py", "gendragoon_app_launch.py")
    for pid, _, uid, arguments in processes():
        if uid != os.getuid() or pid == os.getpid():
            continue
        # Arguments are inspected locally and never included in logs or status.
        words = arguments.lower()
        if "rclone" in words or any(name in words for name in known):
            raise ControlError("busy")


def app_pids(executable):
    candidates = []
    for pid, _, uid, _ in processes():
        if uid == os.getuid() and pid != os.getpid() and kernel_path(pid) == str(executable):
            candidates.append(pid)
    return candidates


def preflight(pid, app, ui_busy):
    require_mac()
    executable = trusted_bundle(app)
    identity = identify(pid, executable)
    ensure_idle(app, ui_busy)
    if any(other != pid for other in app_pids(executable)):
        raise ControlError("busy")
    return identity


def wait_for_exit(identity, timeout=EXIT_TIMEOUT):
    deadline = time.monotonic() + timeout
    while True:
        current = kernel_path(identity.pid)
        if current is None or current != identity.executable:
            return
        try:
            if identify(identity.pid, Path(identity.executable)).started != identity.started:
                return  # PID reused: the original process has actually exited.
        except ControlError as error:
            if error.code == "wrong_pid" and kernel_path(identity.pid) is None:
                return
            raise
        if time.monotonic() >= deadline:
            raise ControlError("exit_timeout")
        time.sleep(0.25)


def relaunch(app, executable, timeout=LAUNCH_TIMEOUT):
    if app_pids(executable):
        raise ControlError("busy")
    try:
        opened = command(["/usr/bin/open", "-n", str(app)], timeout=15)
    except ControlError:
        raise ControlError("launch_failed") from None
    if opened.returncode:
        raise ControlError("launch_failed")
    deadline = time.monotonic() + timeout
    while True:
        pids = app_pids(executable)
        if pids:
            # Confirm with the kernel and owner/start identity rather than open's
            # success code. This verifies a process, never backend readiness.
            identify(pids[0], executable)
            return pids[0]
        if time.monotonic() >= deadline:
            raise ControlError("launch_unconfirmed")
        time.sleep(0.25)


def valid_request_id(value):
    return isinstance(value, str) and len(value) == 32 and all(character in "0123456789abcdef" for character in value)


def scheduled_record(request_id):
    return {"state": "scheduled", "request_id": request_id, "exit_timeout_seconds": EXIT_TIMEOUT,
            "deadline_seconds": OUTCOME_TIMEOUT, "message": "Restart scheduled; cloud files and local data are preserved."}


def run_worker(pid, app, ui_busy, ready_fd, request_id, home=None, enforce_deadline=False):
    ready_sent = False
    previous_handler = None
    previous_timer = None
    try:
        with update_lock(home):
            if not valid_request_id(request_id):
                raise ControlError("worker_failed")
            identity = preflight(pid, app, ui_busy)
            if enforce_deadline:
                # CLI workers run on their main thread. An actual hard timer,
                # started before the ACK, prevents any later relaunch after the
                # advertised outcome deadline even if a safety probe stalls.
                def expired(_signum, _frame):
                    raise ControlError("operation_timeout")
                previous_handler = signal.signal(signal.SIGALRM, expired)
                previous_timer = signal.setitimer(signal.ITIMER_REAL, OUTCOME_TIMEOUT)
            record = scheduled_record(request_id)
            write_status(record, home)
            os.write(ready_fd, (json.dumps(record) + "\n").encode())
            os.close(ready_fd)
            ready_fd = None
            ready_sent = True
            write_status({"state": "waiting_for_exit", "request_id": request_id}, home)
            wait_for_exit(identity)
            executable = trusted_bundle(app)
            if str(executable) != identity.executable:
                raise ControlError("invalid_app")
            ensure_idle(app)
            write_status({"state": "restarting", "request_id": request_id}, home)
            new_pid = relaunch(app, executable)
            write_status({"state": "restarted", "request_id": request_id, "pid": new_pid}, home)
        return 0
    except Exception as error:
        record = {**result_failure(error), "request_id": request_id}
        # A failed lock acquisition must not overwrite an active worker's state.
        if not isinstance(error, ControlError) or error.code != "update_in_progress":
            try:
                write_status(record, home)
            except Exception:
                pass
        if not ready_sent and ready_fd is not None:
            try:
                os.write(ready_fd, (json.dumps(record) + "\n").encode())
            except OSError:
                pass
        return 1
    finally:
        if previous_handler is not None:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_handler)
            if previous_timer is not None and previous_timer[0]:
                signal.setitimer(signal.ITIMER_REAL, *previous_timer)
        if ready_fd is not None:
            os.close(ready_fd)


def retained_worker(home=None):
    content = Path(__file__).read_bytes()
    name = "restart-worker-" + hashlib.sha256(content).hexdigest() + ".py"
    with control_root(home) as (root, descriptor):
        check_owned_name(descriptor, name)
        try:
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        except FileNotFoundError:
            atomic_owned_write(descriptor, name, content)
        else:
            with os.fdopen(fd, "rb") as existing:
                regular_private(os.fstat(existing.fileno()))
                if existing.read(len(content) + 1) != content:
                    raise ControlError("unsafe_path")
        return root / name


def schedule(pid, app, ui_busy, home=None, ready_timeout=READY_TIMEOUT):
    require_mac()
    if ui_busy:
        raise ControlError("busy")
    if pid <= 1 or not Path(app).is_absolute():
        raise ControlError("wrong_pid")
    worker = retained_worker(home)
    request_id = uuid.uuid4().hex
    read_fd, write_fd = os.pipe()
    child = None
    try:
        child = subprocess.Popen(
            [sys.executable, "-B", str(worker), "worker", "--pid", str(pid), "--app", str(app),
             "--ui-busy", "false", "--ready-fd", str(write_fd), "--request-id", request_id],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            start_new_session=True, close_fds=True, pass_fds=(write_fd,),
        )
        os.close(write_fd)
        write_fd = None
        if not select.select([read_fd], [], [], ready_timeout)[0]:
            raise ControlError("worker_failed")
        data = os.read(read_fd, 4096)
        try:
            record = json.loads(data)
        except (ValueError, UnicodeError):
            raise ControlError("worker_failed") from None
        if record.get("state") != "scheduled" or record.get("request_id") != request_id:
            code = record.get("error")
            raise ControlError(code if code in MESSAGES else "worker_failed")
        # Keep/reap our child while this short-lived CLI remains running without
        # keeping the caller alive. setsid above lets it survive caller exit.
        threading.Thread(target=child.wait, daemon=True).start()
        return scheduled_record(request_id)
    except BaseException as error:
        if child is not None and child.poll() is None:
            # Cancel/reap only the worker we created; never signal the app PID.
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)
        elif child is not None:
            child.wait()
        if isinstance(error, OSError):
            raise ControlError("worker_failed") from None
        raise
    finally:
        os.close(read_fd)
        if write_fd is not None:
            os.close(write_fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    for action in ("reset", "worker"):
        command_parser = sub.add_parser(action)
        command_parser.add_argument("--pid", type=int, required=True)
        command_parser.add_argument("--app", type=Path, default=Path.home() / "Applications" / APP_NAME)
        command_parser.add_argument("--ui-busy", choices=("true", "false"), required=True)
        if action == "worker":
            command_parser.add_argument("--ready-fd", type=int, required=True)
            command_parser.add_argument("--request-id", required=True)
    status_parser = sub.add_parser("status")
    status_parser.add_argument("--request-id")
    args = parser.parse_args(argv)
    os.umask(0o077)
    if args.action == "worker":
        return run_worker(args.pid, args.app, args.ui_busy == "true", args.ready_fd, args.request_id, enforce_deadline=True)
    try:
        if args.action == "status" and args.request_id is not None and not valid_request_id(args.request_id):
            raise ControlError("unsafe_path")
        emit(read_status(request_id=args.request_id) if args.action == "status" else schedule(args.pid, args.app, args.ui_busy == "true"))
        return 0
    except Exception as error:
        emit(result_failure(error))
        return 1


if __name__ == "__main__":
    sys.exit(main())
