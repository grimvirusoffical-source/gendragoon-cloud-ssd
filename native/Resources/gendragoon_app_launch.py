#!/usr/bin/env python3
"""Managed macOS launch sessions; verified staging and isolated read-only VFS.

Only generated, unchanged application cache is removed. User settings outside
an application bundle are never part of the cache. Interrupted or ambiguous
sessions retain data. Launch Services enforces the platform's application policy.
"""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse
import contextlib
import ctypes
import fcntl
import io
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid

import gendragoon_library as lib

ROOT = lib.SUPPORT / "LaunchSessions"
RESOURCE = Path(__file__).absolute().parent
LIVE = {"preparing", "launching", "running", "cleaning"}
TERMINAL = {"exited-cleaned", "exited-retained", "interrupted-retained", "failed-retained"}
MAX_RECEIPT_BYTES = 128 * 1024
_PROC = None


def private_root():
    lib.prepare_cache()
    lib.safe_path(ROOT, directory=True)
    ROOT.mkdir(mode=0o700, exist_ok=True)
    ROOT.chmod(0o700)


def receipt_path(identifier):
    if not isinstance(identifier, str) or not re.fullmatch(r"[a-f0-9]{32}", identifier):
        raise ValueError("Invalid session")
    return lib.safe_path(ROOT / (identifier + ".json"))


def save(record):
    private_root()
    target = receipt_path(record["id"])
    fd, temporary = tempfile.mkstemp(prefix=".session-", dir=ROOT)
    try:
        with os.fdopen(fd, "w") as output:
            json.dump(record, output)
            output.flush()
            os.fsync(output.fileno())
        lib.safe_path(target)
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def valid_pid(value):
    return type(value) is int and 0 < value <= 2 ** 31 - 1


def read(identifier):
    target = receipt_path(identifier)
    fd = os.open(target, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            raise ValueError("Unsafe launch receipt")
        with os.fdopen(fd, "rb", closefd=False) as source:
            payload = source.read(MAX_RECEIPT_BYTES + 1)
        if len(payload) > MAX_RECEIPT_BYTES:
            raise ValueError("Launch receipt is too large")
        data = json.loads(payload)
    finally:
        os.close(fd)
    if not isinstance(data, dict) or data.get("id") != identifier:
        raise ValueError("Mismatched launch receipt")
    if data.get("mode") not in {"managed-local", "streamed"} or data.get("state") not in LIVE | TERMINAL:
        raise ValueError("Invalid launch state")
    if type(data.get("keepCache")) is not bool:
        raise ValueError("Invalid cache retention option")
    if not isinstance(data.get("name"), str):
        raise ValueError("Invalid application name")
    lib.check_name(data["name"])
    if not data["name"].lower().endswith(".app") or "\0" in data["name"]:
        raise ValueError("Invalid application name")
    context = lib.selected_context(data.get("project"), data.get("bucket"), data.get("remote"))
    if context is None:
        raise ValueError("Launch receipt has no verified cloud context")
    entry = lib.selected_entry(data.get("key"), **context)
    if entry.get("name") != data["name"] or entry.get("kind", "app") != "app":
        raise ValueError("Launch receipt no longer matches the cloud application")
    session_root = lib.safe_path(ROOT / identifier, directory=True)
    cache_name = data.get("cacheName", data["name"])
    lib.check_name(cache_name)
    if not cache_name.lower().endswith(".app"):
        raise ValueError("Invalid application cache name")
    expected = (lib.CACHE / data["key"] / cache_name if data["mode"] == "managed-local"
                else session_root / "mount" / data["name"])
    if data.get("cachePath") != str(expected):
        raise ValueError("Unsafe launch cache path")
    if data["mode"] == "managed-local":
        lib.safe_path(expected.parent, directory=True)
    for name in ("launcher", "watcher", "mount", "open"):
        pid = data.get(name + "Pid")
        identity = data.get(name + "Identity")
        if pid is not None and not valid_pid(pid):
            raise ValueError("Invalid launch process identifier")
        if identity is not None:
            if (not isinstance(identity, dict) or identity.get("pid") != pid
                    or identity.get("uid") != os.getuid()
                    or not isinstance(identity.get("started"), str)
                    or not 1 <= len(identity["started"]) <= 80
                    or not isinstance(identity.get("executable"), str)
                    or not identity["executable"].startswith("/")):
                raise ValueError("Invalid launch process identity")
    return data


def pid_path(pid):
    global _PROC
    if sys.platform != "darwin":
        return ""
    if _PROC is None:
        _PROC = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True).proc_pidpath
        _PROC.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_uint32]
        _PROC.restype = ctypes.c_int
    buffer = ctypes.create_string_buffer(4096)
    return os.fsdecode(buffer.value) if _PROC(int(pid), buffer, len(buffer)) > 0 else ""


def process_identity(pid):
    """An observed executable plus start time prevents signaling a reused PID."""
    if not valid_pid(pid):
        return None
    result = subprocess.run(["/bin/ps", "-p", str(pid), "-o", "uid=", "-o", "lstart="],
                            capture_output=True, text=True, timeout=8)
    if result.returncode == 1 and not result.stdout.strip():
        return None
    if result.returncode:
        raise RuntimeError("Could not establish process ownership; cache retained")
    parts = result.stdout.strip().split(None, 1)
    if len(parts) != 2 or parts[0] != str(os.getuid()):
        return None
    executable = pid_path(pid)
    if not executable:
        return None
    return {"pid": pid, "uid": os.getuid(), "started": parts[1], "executable": executable}


def same_process(record, name, executable=None):
    expected = record.get(name + "Identity")
    pid = record.get(name + "Pid")
    if not expected or not valid_pid(pid):
        return False
    if executable is not None and expected.get("executable") != str(executable):
        return False
    return process_identity(pid) == expected


def process_paths():
    result = subprocess.run(["/bin/ps", "-axo", "pid=,uid="], capture_output=True,
                            text=True, timeout=12, check=True)
    values = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0].isdigit() and parts[1] == str(os.getuid()):
            values[int(parts[0])] = pid_path(int(parts[0]))
    return values


def app_pids(path, processes=None):
    processes = process_paths() if processes is None else processes
    prefix = str(path).rstrip("/") + "/"
    return [pid for pid, executable in processes.items() if executable.startswith(prefix)]


def open_files():
    # Do not recurse through a cloud mount with lsof +D. One current-user
    # snapshot includes mapped executables, open resources, and helper handles.
    result = subprocess.run(["/usr/sbin/lsof", "-n", "-P", "-a", "-u", str(os.getuid()), "-F0pn"],
                            capture_output=True, timeout=15)
    if result.returncode not in (0, 1):
        raise RuntimeError("Could not check open application resources; cache retained")
    values = []
    pid = None
    for raw in result.stdout.split(b"\0"):
        field = raw.lstrip(b"\n")
        if field.startswith(b"p"):
            pid = int(field[1:]) if field[1:].isdigit() else None
        elif field.startswith(b"n") and pid is not None:
            values.append((pid, os.fsdecode(field[1:])))
    return values


def resource_pids(path, files=None):
    files = open_files() if files is None else files
    prefix = str(path).rstrip("/") + "/"
    return [pid for pid, name in files if name == str(path) or name.startswith(prefix)]


def cache_users(path):
    return sorted(set(app_pids(path)) | set(resource_pids(path)))


def watcher_alive(data):
    return same_process(data, "watcher")


def session_mount_active(data):
    if data["mode"] != "streamed":
        return False
    mount = ROOT / data["id"] / "mount"
    # Even an orphan mount whose PID cannot be authenticated blocks maintenance.
    return os.path.ismount(mount) or same_process(data, "mount", lib.RCLONE)


def sessions(project=None, bucket=None, remote="gendragoon"):
    context = lib.selected_context(project, bucket, remote)
    lib.safe_path(ROOT, directory=True)
    if not ROOT.exists():
        return {"sessions": [], "active": False, "busy": False}
    records = [read(path.stem) for path in sorted(ROOT.glob("*.json"))]
    records = [record for record in records if not context or lib.in_context(record, context)]
    if not records:
        return {"sessions": [], "active": False, "busy": False}
    processes = process_paths()
    files = None
    values = []
    for data in records:
        active = (watcher_alive(data) or same_process(data, "open")
                  or (data["state"] == "preparing" and same_process(data, "launcher"))
                  or bool(app_pids(data["cachePath"], processes)) or session_mount_active(data))
        if not active and Path(data["cachePath"]).exists():
            if files is None:
                files = open_files()
            active = bool(resource_pids(data["cachePath"], files))
        state = data["state"]
        if state in LIVE and not active:
            state = "interrupted-retained"
        values.append({k: data.get(k) for k in ("id", "key", "name", "mode", "pid", "cachePath", "message")} | {
            "state": state, "active": active,
            "cleanupPending": active and watcher_alive(data) and not data["keepCache"]})
    return {"sessions": values, "active": any(x["active"] for x in values),
            "busy": any(x["active"] for x in values)}


def compatible(path):
    if path.suffix.lower() != ".app" or path.is_symlink():
        raise ValueError("Choose an actual macOS application bundle")
    with (path / "Contents/Info.plist").open("rb") as source:
        info = plistlib.load(source)
    name = info.get("CFBundleExecutable", "")
    lib.check_name(name)
    binary = path / "Contents/MacOS" / name
    if not binary.is_file() or not binary.resolve().is_relative_to(path.resolve()):
        raise ValueError("Application executable is missing or outside the bundle")
    if "MacOSX" not in info.get("CFBundleSupportedPlatforms", ["MacOSX"]):
        raise ValueError("This application targets another platform")
    return binary


def stop_mount(record):
    if cache_users(record["cachePath"]) or same_process(record, "open"):
        raise RuntimeError("Application or helper still holds the cloud mount; cache retained")
    mount = ROOT / record["id"] / "mount"
    owned = same_process(record, "mount", lib.RCLONE)
    if os.path.ismount(mount):
        if not owned:
            raise RuntimeError("Cloud mount owner could not be verified; cache retained")
        lib.run(["/sbin/umount", mount], timeout=30)
    # Recheck after unmount: a PID may have been reused while it was running.
    pid = record.get("mountPid")
    if same_process(record, "mount", lib.RCLONE):
        try:
            os.kill(pid, 15)
        except ProcessLookupError:
            pass
        for _ in range(40):
            if not same_process(record, "mount", lib.RCLONE):
                break
            time.sleep(.1)
    if os.path.ismount(mount) or same_process(record, "mount", lib.RCLONE):
        raise RuntimeError("Cloud application cache is still mounted; retained")


def cleanup(record):
    path = Path(record["cachePath"])
    if cache_users(path) or same_process(record, "open"):
        raise RuntimeError("Application or helper is still running; cache retained")
    if record["mode"] == "streamed":
        stop_mount(record)
        if not record["keepCache"]:
            root = lib.safe_path(ROOT / record["id"], directory=True)
            if root.exists():
                if any(child.name not in {"mount", "vfs"} for child in root.iterdir()):
                    raise RuntimeError("Session cache contains unexpected files; retained for review")
                if (root / "mount").exists() and any((root / "mount").iterdir()):
                    raise RuntimeError("Session mount contains unexpected local files; retained for review")
                shutil.rmtree(root)
    elif not record["keepCache"]:
        with contextlib.redirect_stdout(io.StringIO()):
            lib.clear_cache(record["key"], record["project"], record["bucket"], record["remote"])


def prepare_stream(data, record):
    raw = data.get("streamPath")
    if not raw or data.get("streamVerified") is not True:
        return None
    raw = lib.pathpart(raw)
    if raw.split("/")[0] != record["bucket"] or Path(raw).name != data["name"]:
        raise ValueError("Stream does not match the selected cloud application")
    # Recheck older indexes too: a raw byte check never establishes that NFS
    # can preserve resource forks, quarantine, FinderInfo, or other attributes.
    reason = lib.stream_metadata_reason(data.get("manifest"))
    if reason:
        record["streamIneligibleReason"] = reason
        return None
    lib.require_space(128 * 1024 ** 2)
    root = ROOT / record["id"]
    root.mkdir(mode=0o700)
    mount = root / "mount"
    mount.mkdir(mode=0o700)
    target = lib.cloud(record["remote"], str(Path(raw).parent))
    process = subprocess.Popen([str(lib.RCLONE), "--config", str(lib.CONFIG), "nfsmount", target, str(mount),
        "--read-only", "--vfs-cache-mode=full", "--cache-dir=" + str(root / "vfs"),
        *lib.performance.stream_arguments(), "--vfs-links",
        "--file-perms=0755", "--dir-perms=0755"], stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    record.update(mode="streamed", mountPid=process.pid, mountIdentity=process_identity(process.pid),
                  cachePath=str(mount / data["name"]))
    save(record)
    if not record["mountIdentity"]:
        raise RuntimeError("Cloud mount process identity could not be verified; cache retained")
    for _ in range(100):
        if os.path.ismount(mount):
            break
        if process.poll() is not None:
            raise RuntimeError("Cloud application mount failed")
        time.sleep(.2)
    if not os.path.ismount(mount):
        raise RuntimeError("Cloud application mount timed out")
    path = mount / data["name"]
    compatible(path)
    lib.run(["/usr/bin/codesign", "--verify", "--deep", "--strict", path], timeout=180)
    return path


def local_cache_preflight(data, destination):
    """Bound complete-bundle fallback; never clear caches to make room silently."""
    budget_gib = lib.performance.current().get("cacheGiB")
    if type(budget_gib) is not int or not 1 <= budget_gib <= 64:
        raise RuntimeError("Invalid application cache budget")
    limit = budget_gib * 1024 ** 3
    used = 0
    entries = 0
    def inventory_error(error):
        raise RuntimeError("Application cache could not be measured safely; nothing downloaded") from error
    for directory, folders, files in os.walk(lib.CACHE, followlinks=False, onerror=inventory_error):
        for name in list(folders):
            child = Path(directory) / name
            if child.is_symlink():
                folders.remove(name)
            elif os.path.ismount(child):
                raise RuntimeError("Unexpected mounted application cache; retained for review")
        for name in files:
            entries += 1
            if entries > 250000:
                raise RuntimeError("Application cache inventory exceeds its safety limit")
            info = (Path(directory) / name).lstat()
            if stat.S_ISREG(info.st_mode):
                used += info.st_size
    extra = 0
    if not destination.exists():
        manifest = data.get("manifest")
        if not isinstance(manifest, list) or not manifest:
            raise RuntimeError("This legacy app has no verified size manifest. "
                               "A bounded cloud launch cannot download it automatically.")
        for entry in manifest:
            size = entry.get("size", 0) if isinstance(entry, dict) else None
            if type(size) is not int or size < 0:
                raise RuntimeError("Invalid application size manifest")
            extra += size
    if used + extra > limit:
        raise RuntimeError("This complete-bundle fallback would exceed the " + str(budget_gib) +
                           " GiB app cache budget. Use a compatible streamed app or "
                           "explicitly clear an unused cache. Existing files were retained.")
    lib.require_space(extra * 2 + 64 * 1024 ** 2)
    return {"cacheLimitBytes": limit, "existingCacheBytes": used, "additionalBytes": extra}


def launch(key, project, bucket, remote, keep_cache=False):
    if sys.platform != "darwin":
        raise RuntimeError("macOS application launching requires macOS")
    if not project or not bucket:
        raise ValueError("Choose and verify the MachineNote destination")
    private_root()
    data = lib.selected_entry(key, project, bucket, remote)
    lib.assert_restore_compatible(key,data,project,bucket,remote)
    if data.get("kind", "app") != "app":
        raise ValueError("Use Restore for files and folders")
    # The cloud SSD has one active application slot across ALL workspaces.
    # The caller holds the shared maintenance lock while inspecting sessions
    # and writing the preparing receipt, so two launchers cannot both pass.
    active = [item for item in sessions()["sessions"] if item["active"]]
    if active:
        if any(item["key"] == key for item in active):
            raise RuntimeError("This application already has an active managed session")
        raise RuntimeError("Another cloud application is still running or cleaning up. "
                           "Quit it and wait for its helpers before launching the next app. "
                           "No application was stopped and no cache was deleted.")
    cache_name = data.get("displayName") or data.get("cacheName") or data["name"]
    lib.check_name(cache_name)
    if not cache_name.lower().endswith(".app"):
        raise ValueError("Application names must retain the .app extension before launching")
    record = {"id": uuid.uuid4().hex, "key": key, "name": data["name"], "cacheName": cache_name, "project": project,
              "bucket": bucket, "remote": remote, "state": "preparing", "mode": "managed-local",
              "keepCache": bool(keep_cache), "createdAt": time.time(),
              "launcherPid": os.getpid(), "launcherIdentity": process_identity(os.getpid()),
              "performance": lib.performance.current(),
              "cachePath": str(lib.CACHE / key / cache_name)}
    if not record["launcherIdentity"]:
        raise RuntimeError("Launch process identity could not be verified")
    save(record)
    handed_off = False
    try:
        path = prepare_stream(data, record)
        if path is None:
            preflight_path = Path(record["cachePath"])
            previous_name = data.get("cacheName") or data["name"]
            lib.check_name(previous_name)
            previous_path = lib.CACHE / key / previous_name
            if not preflight_path.exists() and previous_path.exists():
                preflight_path = previous_path
            if not preflight_path.exists() and data.get("format") == "redxai" and not data.get("manifest"):
                data = lib.hydrate_launch_manifest(key, data, project, bucket, remote)
            record["cachePreflight"] = local_cache_preflight(data, preflight_path)
            save(record)
            with contextlib.redirect_stdout(io.StringIO()):
                staged = lib.stage_item(key, False, project, bucket, remote)
            if not isinstance(staged, (str, Path)):
                raise RuntimeError("Application staging did not return its verified cache path")
            path = Path(staged)
            if not path.is_absolute() or path.parent != lib.CACHE / key:
                raise ValueError("Application staging returned an unsafe cache path")
            lib.check_name(path.name)
            lib.safe_path(path.parent, directory=True)
            record.update(cachePath=str(path), cacheName=path.name)
            save(record)
            compatible(path)
        try:
            # Use the already verified manifest size, rather than traversing a
            # potentially remote bundle merely to decide how much to preload.
            app_bytes = data.get("rawBytes") or data.get("sizeBytes") or data.get("archiveBytes")
            preload_args = lib.performance.preload_arguments(app_bytes=app_bytes)
            preload_timeout = float(preload_args[preload_args.index("--seconds") + 1]) + 2.5
            result = lib.run([sys.executable, "-B", RESOURCE / "gendragoon_preload.py", "--app", path,
                              *preload_args], timeout=preload_timeout)
            record["preload"] = json.loads(result)
        except Exception:
            record["preload"] = {"ok": False, "message": "Preload unavailable; normal launch continues"}
        record["state"] = "launching"
        save(record)
        process = subprocess.Popen([sys.executable, "-B", str(RESOURCE / "gendragoon_app_launch.py"),
                                    "watch", "--session", record["id"]], stdin=subprocess.DEVNULL,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
        handed_off = True
        for _ in range(100):
            current = read(record["id"])
            if current["state"] != "launching":
                break
            if process.poll() is not None:
                raise RuntimeError("Application monitor exited before launch confirmation; cache retained")
            time.sleep(.1)
        if current["state"] == "failed-retained":
            raise RuntimeError(current.get("message", "Launch failed; cache retained"))
        pending = current["state"] == "launching"
        # A slow Launch Services request remains owned by the live watcher.
        # Never rewrite its receipt or unmount its application from this parent.
        return {"key": key, "name": data.get("displayName") or data["name"], "mode": current["mode"], "cachePath": current["cachePath"],
                "pid": current.get("pid", process.pid), "cleanup": "keep" if keep_cache else "on-exit",
                "state": current["state"],
                "message": ("Launch requested. macOS is still opening the application; inspect its session status."
                            if pending else "Application opened with a managed " +
                            ("cloud cache" if current["mode"] == "streamed" else "local copy") + ".")}
    except Exception as error:
        if not handed_off:
            if record["mode"] == "streamed":
                try:
                    stop_mount(record)
                except Exception:
                    pass
            record["state"] = "failed-retained"
            record["message"] = str(error)[:400]
            save(record)
        raise


@contextlib.contextmanager
def watch_lock(identifier):
    target = receipt_path(identifier).with_suffix(".lock")
    lib.safe_path(target)
    fd = os.open(target, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            raise ValueError("Unsafe application monitor lock")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("This application monitor is already active") from None
        yield
    finally:
        os.close(fd)


def watch(identifier):
    with watch_lock(identifier):
        record = read(identifier)
        if record["state"] != "launching" or watcher_alive(record):
            raise RuntimeError("This session cannot be launched again")
        record.update(watcherPid=os.getpid(), watcherIdentity=process_identity(os.getpid()))
        if not record["watcherIdentity"]:
            raise RuntimeError("Application monitor identity could not be verified")
        save(record)
        try:
            path = Path(record["cachePath"])
            process = subprocess.Popen(["/usr/bin/open", "-n", "-W", str(path)], stdin=subprocess.DEVNULL,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            record.update(openPid=process.pid, openIdentity=process_identity(process.pid))
            save(record)
            time.sleep(.5)
            if process.poll() not in (None, 0):
                raise RuntimeError("macOS refused this application; managed cache retained")
            if process.poll() is None and not record["openIdentity"]:
                raise RuntimeError("macOS launch process could not be tracked; cache retained")
            pids = app_pids(path)
            record.update(state="running", pid=pids[0] if pids else process.pid)
            save(record)
            process.wait()
            if process.returncode:
                raise RuntimeError("macOS launch did not complete successfully; cache retained")
            idle = 0
            while idle < 5:
                idle = 0 if cache_users(path) else idle + 1
                time.sleep(1)
            record["state"] = "cleaning"
            save(record)
            for attempt in range(60):
                try:
                    with lib.maintenance_lock():
                        cleanup(record)
                    break
                except RuntimeError as error:
                    if "already active" not in str(error) or attempt == 59:
                        raise
                    time.sleep(2)
            record["state"] = "exited-retained" if record["keepCache"] else "exited-cleaned"
            record["message"] = "Application exited. Cloud copy retained."
            save(record)
        except Exception as error:
            record["state"] = "failed-retained"
            record["message"] = str(error)[:400]
            save(record)


def evict(key, project, bucket, remote):
    if not project or not bucket:
        raise ValueError("Choose and verify the MachineNote destination")
    entry = lib.selected_entry(key, project, bucket, remote)
    for data in sessions(project, bucket, remote)["sessions"]:
        if data["key"] != key:
            continue
        if data["active"]:
            raise RuntimeError("Quit the application and wait for its helpers before removing cache")
        record = read(data["id"])
        record["keepCache"] = False
        cleanup(record)
        record["state"] = "exited-cleaned"
        save(record)
    cache_name = entry.get("cacheName") or entry.get("displayName") or entry["name"]
    lib.check_name(cache_name)
    local_path = lib.CACHE / key / cache_name
    if local_path.exists() and cache_users(local_path):
        raise RuntimeError("Application resources are still open; managed cache retained")
    with contextlib.redirect_stdout(io.StringIO()):
        lib.clear_cache(key, project, bucket, remote)
    return {"key": key, "evicted": True, "message": "Managed cache removed. Cloud application retained."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["launch", "status", "evict", "watch"])
    parser.add_argument("--key")
    parser.add_argument("--project")
    parser.add_argument("--bucket")
    parser.add_argument("--remote", default="gendragoon")
    parser.add_argument("--prefix")
    parser.add_argument("--session")
    parser.add_argument("--keep-cache", action="store_true")
    parser.add_argument("--performance-stdin", action="store_true")
    args = parser.parse_args()
    if args.performance_stdin:
        lib.performance.configure_from_stdin()
    if args.action == "watch":
        return watch(args.session)
    if args.action == "status":
        return lib.reply(**sessions(args.project, args.bucket, args.remote))
    with lib.maintenance_lock():
        value = (launch(args.key, args.project, args.bucket, args.remote, args.keep_cache)
                 if args.action == "launch" else evict(args.key, args.project, args.bucket, args.remote))
    lib.reply(**value)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        lib.fail(error)
