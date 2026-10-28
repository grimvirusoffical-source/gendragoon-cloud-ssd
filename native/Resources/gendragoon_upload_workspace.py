#!/usr/bin/env python3
"""Persist one explicit upload destination, source selection, and durable queue.

No credentials are read or stored here. CLI destination selection delegates to
gendragoon_connect.py for project membership/read checks and configuration. The
select_destination Python API is a state-only CAS commit for that validated
caller; it does not acquire the shared maintenance lock or contact the network.
run-next holds AutoUpdates/update.lock through the upload and gives that lock FD
to the library child, but releases the workspace lock during external work.
"""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import threading
import sys
import time
import uuid

_performance_input = None
_progress_context = threading.local()

DEFAULT_PREFIX = "GenDragoon-App-Library"
MAX_STATE_BYTES = 3 * 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_SOURCES = 1000
MAX_JOBS = 200
MAX_TREE_ENTRIES = 2000
MAX_FINGERPRINT_ENTRIES = 1000000
HELPER_TIMEOUT = 6 * 60 * 60
RESOURCE_DIR = Path(__file__).absolute().parent
if str(RESOURCE_DIR) not in sys.path:
    sys.path.insert(0, str(RESOURCE_DIR))
from gendragoon_transfer_errors import MESSAGES as FAILURE_MESSAGES, validate_failure
SOURCE_KINDS = {"app", "folder", "file"}
JOB_STATES = {"queued", "running", "succeeded", "failed"}
MAX_PROGRESS_BYTES = 16 * 1024
PROGRESS_PHASES = {"preparing", "snapshot", "snapshotting", "archiving", "encoding", "uploading",
                   "publishing", "readback", "decoding", "downloading", "restoring", "verifying", "offloading", "complete"}
# Uploading includes concurrent encoding; the restoration stage is a separate
# authenticated readback. These weights describe work, not a time prediction.
PROGRESS_STAGES = {"preparing": (0, .02), "snapshot": (.02, .08), "snapshotting": (.02, .08),
                   "archiving": (.10, .15), "encoding": (.25, .45), "uploading": (.25, .45),
                   "publishing": (.69, .01), "readback": (.70, .20), "decoding": (.70, .20),
                   "downloading": (.70, .20), "restoring": (.70, .20),
                   "verifying": (.90, .09), "offloading": (.99, .009), "complete": (.999, 0)}


class WorkspaceError(RuntimeError):
    def __init__(self, code, message, state=None, failure=None):
        self.code, self.message, self.state = code, message, state
        self.failure = validate_failure(failure)
        super().__init__(message)


def support(home=None):
    return (Path.home() if home is None else Path(home)) / "Library/Application Support/GenDragoon Cloud SSD"


def ensure_directory(path, home, private=False):
    path, home = Path(path).absolute(), Path(home).absolute()
    try:
        relative = path.relative_to(home)
    except ValueError:
        raise WorkspaceError("unsafe_path", "Workspace path is outside the user home") from None
    if any(item.is_symlink() for item in (home, *home.parents)):
        raise WorkspaceError("unsafe_path", "A workspace parent is a symlink")
    current = home
    for part in (None, *relative.parts):
        if part is not None:
            current = current / part
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            try:
                current.mkdir(mode=0o700)
            except FileExistsError:
                # Another first-run process may have created the same directory.
                pass
            metadata = current.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid()
                or metadata.st_mode & 0o022):
            raise WorkspaceError("unsafe_path", "A workspace directory is linked, shared, or not owned by this user")
    if private and current.stat().st_mode & 0o077:
        raise WorkspaceError("unsafe_path", "The workspace directory must be private")
    return current


def regular_private(metadata):
    if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid != os.getuid()
            or metadata.st_nlink != 1 or metadata.st_mode & 0o077):
        raise WorkspaceError("unsafe_path", "A workspace file is linked, shared, or not owned by this user")


def check_name(descriptor, name):
    try:
        regular_private(os.stat(name, dir_fd=descriptor, follow_symlinks=False))
    except FileNotFoundError:
        pass


def fresh_state():
    return {"schema": 1, "revision": 0, "destination": None, "sources": [], "jobs": [], "active_job_id": None}


def destination_record(project, bucket, remote, prefix=DEFAULT_PREFIX):
    if not isinstance(project, str) or not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]", project):
        raise WorkspaceError("invalid_destination", "Choose an explicit Google Cloud project ID")
    if (not isinstance(bucket, str) or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", bucket)
            or ".." in bucket or re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}", bucket)):
        raise WorkspaceError("invalid_destination", "Choose an explicit bucket name")
    if not isinstance(remote, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,49}", remote):
        raise WorkspaceError("invalid_destination", "Choose an explicit configured cloud remote")
    if (not isinstance(prefix, str) or "\\" in prefix or ":" in prefix
            or any(ord(char) < 32 or ord(char) == 127 for char in prefix)
            or (prefix and any(part in ("", ".", "..") for part in prefix.split("/")))):
        raise WorkspaceError("invalid_destination", "Cloud prefix must be a relative folder path")
    return {"project": project, "bucket": bucket, "remote": remote, "prefix": prefix}


def validate_state(value):
    if (not isinstance(value, dict) or not {"schema", "revision", "destination", "sources", "jobs", "active_job_id"} <= value.keys()
            or value.get("schema") != 1
            or type(value.get("revision")) is not int or value["revision"] < 0
            or not isinstance(value.get("sources"), list) or len(value["sources"]) > MAX_SOURCES
            or not isinstance(value.get("jobs"), list) or len(value["jobs"]) > MAX_JOBS):
        raise WorkspaceError("invalid_state", "The saved upload workspace is invalid; it was preserved")
    if value.get("destination") is not None:
        destination_record(**value["destination"])
    identifiers = set()
    for source in value["sources"]:
        validate_source_record(source)
        if source["id"] in identifiers:
            raise WorkspaceError("invalid_state", "Saved source IDs are duplicated")
        identifiers.add(source["id"])
    job_ids = set()
    running = []
    for job in value["jobs"]:
        if (not isinstance(job, dict) or not isinstance(job.get("id"), str) or not re.fullmatch(r"[a-f0-9]{32}", job["id"]) or job["id"] in job_ids
                or job.get("state") not in JOB_STATES or type(job.get("offload")) is not bool
                or type(job.get("encrypted",True)) is not bool
                or job.get("encryption_mode", "standard" if job.get("encrypted",True) else "off") not in ("standard","fast","off")
                or not isinstance(job.get("sources"), list) or not job["sources"]
                or not isinstance(job.get("items"), list) or len(job["items"]) != len(job["sources"])):
            raise WorkspaceError("invalid_state", "A saved upload job is invalid")
        destination_record(**job["destination"])
        for source in job["sources"]:
            validate_source_record(source)
        for item, source in zip(job["items"], job["sources"]):
            if (not isinstance(item, dict) or item.get("source_id") != source["id"]
                    or item.get("state") not in {"pending", "running", "succeeded", "failed"}):
                raise WorkspaceError("invalid_state", "A saved upload item is invalid")
        job_ids.add(job["id"])
        if job["state"] == "running":
            running.append(job["id"])
    active = value.get("active_job_id")
    if (active is None and running) or (active is not None and running != [active]):
        raise WorkspaceError("invalid_state", "Saved active upload state is inconsistent")
    return value


def validate_source_record(source):
    if (not isinstance(source, dict) or not isinstance(source.get("id"), str)
            or not re.fullmatch(r"[a-f0-9]{32}", source["id"])
            or not isinstance(source.get("path"), str) or not Path(source["path"]).is_absolute()
            or not isinstance(source.get("name"), str) or source.get("kind") not in SOURCE_KINDS
            or not isinstance(source.get("identity"), dict)
            or not re.fullmatch(r"[a-f0-9]{64}", str(source["identity"].get("sha256", "")))):
        raise WorkspaceError("invalid_state", "A saved source identity is invalid")
    parent_key_record(source.get("parent_key"))


def parent_key_record(value):
    if value is not None and (not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{18}", value)):
        raise WorkspaceError("invalid_parent", "Choose a folder in the selected MachineNote")
    return value


def strict_json(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result
    return json.loads(data, object_pairs_hook=pairs,
                      parse_constant=lambda value: (_ for _ in ()).throw(ValueError("non-finite JSON number")))


def load_state(descriptor):
    check_name(descriptor, "state.json")
    try:
        fd = os.open("state.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
    except FileNotFoundError:
        return fresh_state()
    with os.fdopen(fd, "rb") as stream:
        regular_private(os.fstat(stream.fileno()))
        data = stream.read(MAX_STATE_BYTES + 1)
    if len(data) > MAX_STATE_BYTES:
        raise WorkspaceError("invalid_state", "Saved workspace exceeds its size limit; it was preserved")
    try:
        return validate_state(strict_json(data))
    except (ValueError, TypeError, KeyError) as exc:
        raise WorkspaceError("invalid_state", "Saved workspace could not be read; it was preserved") from exc


def save_state(descriptor, state):
    validate_state(state)
    data = (json.dumps(state, separators=(",", ":")) + "\n").encode("utf8")
    if len(data) > MAX_STATE_BYTES:
        raise WorkspaceError("workspace_full", "Upload history is full; no selection or job was removed")
    check_name(descriptor, "state.json")
    name = ".state-" + uuid.uuid4().hex
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        check_name(descriptor, "state.json")
        os.replace(name, "state.json", src_dir_fd=descriptor, dst_dir_fd=descriptor)
        os.fsync(descriptor)
    finally:
        try:
            os.unlink(name, dir_fd=descriptor)
        except FileNotFoundError:
            pass


@contextmanager
def locked_state(home=None):
    home = Path.home() if home is None else Path(home)
    root = ensure_directory(support(home) / "UploadWorkspace", home, private=True)
    descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    try:
        check_name(descriptor, "state.lock")
        lock = os.open("state.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        regular_private(os.fstat(lock))
        fcntl.flock(lock, fcntl.LOCK_EX)
        yield descriptor, load_state(descriptor)
    finally:
        if lock is not None:
            os.close(lock)
        os.close(descriptor)


def read_state(home=None):
    """Return the authoritative snapshot; acquire only the short state lock."""
    with locked_state(home) as (_, state):
        return state


def require_revision(state, expected_revision):
    if type(expected_revision) is not int or state["revision"] != expected_revision:
        raise WorkspaceError("revision_conflict", "The upload workspace changed; refresh and try again", state)


def require_idle(state):
    if state["active_job_id"] is not None:
        raise WorkspaceError("busy", "Wait for the active upload before changing the selection", state)


def commit(descriptor, state):
    state["revision"] += 1
    save_state(descriptor, state)
    return state


def select_destination(project, bucket, remote, prefix, expected_revision, home=None):
    """State-only commit for configure after membership/read/config validation.

    The caller must hold AutoUpdates/update.lock when updating rclone settings.
    This function never acquires that maintenance lock, avoiding lock inversion.
    """
    destination = destination_record(project, bucket, remote, prefix)
    with locked_state(home) as (descriptor, state):
        require_revision(state, expected_revision)
        require_idle(state)
        state["destination"] = destination
        return commit(descriptor, state)


def kindof(path):
    if path.is_dir():
        return "app" if path.name.casefold().endswith(".app") else "folder"
    if path.is_file():
        return "file"
    raise WorkspaceError("invalid_source", "Choose an actual application, folder, or regular file")


def source_path(value):
    original = Path(value).expanduser().absolute()
    if original.is_symlink():
        raise WorkspaceError("invalid_source", "Choose the source itself rather than a symlink")
    try:
        path = original.resolve(strict=True)
    except OSError as exc:
        raise WorkspaceError("invalid_source", "A selected source is unavailable") from exc
    kindof(path)
    return path


def fingerprint(path):
    """Hash identity/metadata for the complete tree without following symlinks.

    Library upload additionally hashes content manifests around backup/offload.
    This selection fingerprint catches replacements and ordinary edits between
    selection, enqueue, and worker admission without reading big file contents.
    """
    digest, count = hashlib.sha256(), 0
    first = path.lstat()
    if stat.S_ISLNK(first.st_mode):
        raise WorkspaceError("source_changed", "A source became a symlink; select it again")
    def add(item, relative):
        nonlocal count
        info = item.lstat()
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode)):
            raise WorkspaceError("invalid_source", "A source contains an unsupported special filesystem entry")
        count += 1
        if count > MAX_FINGERPRINT_ENTRIES:
            raise WorkspaceError("source_too_large", "This source exceeds the safe tree entry limit")
        record = [relative, info.st_dev, info.st_ino, info.st_mode, info.st_size,
                  info.st_mtime_ns, info.st_ctime_ns, os.readlink(item) if stat.S_ISLNK(info.st_mode) else None]
        digest.update(json.dumps(record, separators=(",", ":")).encode())
    add(path, "")
    def unavailable(error):
        raise WorkspaceError("invalid_source", "A source folder could not be read completely") from error
    if path.is_dir():
        for parent, folders, files in os.walk(path, followlinks=False, onerror=unavailable):
            folders.sort(); files.sort()
            for name in folders + files:
                item = Path(parent) / name
                add(item, str(item.relative_to(path)))
    last = path.lstat()
    if (first.st_dev, first.st_ino, first.st_mtime_ns, first.st_ctime_ns) != (
            last.st_dev, last.st_ino, last.st_mtime_ns, last.st_ctime_ns):
        raise WorkspaceError("source_changed", "A source changed while being selected; try again")
    return {"sha256": digest.hexdigest(), "entries": count}


def selected_source(value, parent_key=None):
    path = source_path(value)
    if any(parent.name.casefold().endswith(".app") for parent in path.parents):
        raise WorkspaceError("atomic_app", "Select the complete application bundle rather than its internal files")
    return {"id": uuid.uuid4().hex, "path": str(path), "name": path.name,
            "kind": kindof(path), "identity": fingerprint(path), "parent_key": parent_key_record(parent_key)}


def add_sources(paths, expected_revision, home=None, parent_key=None):
    if not isinstance(paths, list) or not paths or not all(isinstance(path, str) and path for path in paths):
        raise WorkspaceError("invalid_source", "Provide a nonempty JSON array of source paths")
    if len(paths) > MAX_SOURCES:
        raise WorkspaceError("selection_full", "Too many sources were selected")
    parent_key_record(parent_key)
    records = [selected_source(path, parent_key) for path in paths]
    with locked_state(home) as (descriptor, state):
        require_revision(state, expected_revision)
        require_idle(state)
        existing = {source["path"] for source in state["sources"]}
        for source in records:
            if source["path"] in existing:
                continue  # Reselecting never silently retargets an existing item.
            target = Path(source["path"])
            if any(old["kind"] in {"folder", "app"} and Path(old["path"]) in target.parents
                   and old.get("parent_key") == parent_key for old in state["sources"]):
                continue  # The complete selected folder already includes it.
            if source["kind"] in {"folder", "app"}:
                state["sources"] = [old for old in state["sources"] if not
                    (target in Path(old["path"]).parents and old.get("parent_key") == parent_key)]
            state["sources"].append(source)
            existing = {old["path"] for old in state["sources"]}
        if len(state["sources"]) > MAX_SOURCES:
            raise WorkspaceError("selection_full", "Too many sources were selected")
        return commit(descriptor, state)


def remove_source(identifier, expected_revision, home=None):
    with locked_state(home) as (descriptor, state):
        require_revision(state, expected_revision)
        require_idle(state)
        if not any(source["id"] == identifier for source in state["sources"]):
            raise WorkspaceError("source_not_found", "The selected source is no longer in this workspace", state)
        state["sources"] = [source for source in state["sources"] if source["id"] != identifier]
        return commit(descriptor, state)


def clear_sources(expected_revision, home=None):
    with locked_state(home) as (descriptor, state):
        require_revision(state, expected_revision)
        require_idle(state)
        state["sources"] = []
        return commit(descriptor, state)


def cancel_job(identifier, expected_revision, home=None):
    """Cancel only a not-yet-started job; never touch its sources or remote data."""
    with locked_state(home) as (descriptor, state):
        require_revision(state, expected_revision)
        require_idle(state)
        job = next((value for value in state["jobs"] if value["id"] == identifier), None)
        if job is None or job["state"] != "queued":
            raise WorkspaceError("job_not_queued", "Only a queued upload can be cancelled", state)
        job["state"] = "failed"
        job["error"] = "Cancelled before upload. Original files were retained."
        job["updated_at"] = time.time()
        for item in job["items"]:
            item["state"] = "failed"
            item["message"] = job["error"]
            item["offloaded"] = False
        return commit(descriptor, state)


def unchanged(source):
    try:
        path = source_path(source["path"])
        equal = (str(path) == source["path"] and kindof(path) == source["kind"]
                 and fingerprint(path) == source["identity"])
    except (OSError, WorkspaceError):
        equal = False
    if not equal:
        raise WorkspaceError("source_changed", "A source changed after selection; remove it and select it again")


def enqueue(expected_revision, offload, home=None, *, encryption=True, explicit_selection=None, explicit_destination=None, encryption_mode=None):
    if type(offload) is not bool or type(encryption) is not bool:
        raise WorkspaceError("invalid_option", "Upload options must be explicitly true or false")
    mode=("standard" if encryption else "off") if encryption_mode is None else encryption_mode
    if mode not in ("standard","fast","off") or (not encryption and mode!="off"):
        raise WorkspaceError("invalid_option", "Choose standard, fast, or off encryption")
    encryption=mode!="off"
    state = read_state(home)
    require_revision(state, expected_revision)
    require_idle(state)
    if explicit_selection is not None:
        if offload or not isinstance(explicit_selection,list) or not 1<=len(explicit_selection)<=64 or any(not isinstance(p,str) for p in explicit_selection):
            raise WorkspaceError("invalid_source", "Choose at most 64 explicit local sources; companion offload is disabled")
        if not isinstance(explicit_destination,dict) or set(explicit_destination)!={"project","bucket","remote","prefix"}:
            raise WorkspaceError("invalid_destination", "Choose an authorized MachineNote")
        state=copy.deepcopy(state)
        state["destination"]=destination_record(**explicit_destination)
        state["sources"]=[selected_source(path) for path in dict.fromkeys(explicit_selection)]
    if state["destination"] is None:
        raise WorkspaceError("destination_required", "Choose a project and bucket before uploading", state)
    if mode != "standard" and state["destination"]["remote"] != "redxai":
        raise WorkspaceError("invalid_option", "Fast unencrypted uploads require a Red-XAI MachineNote", state)
    if not state["sources"]:
        raise WorkspaceError("source_required", "Select applications, files, or folders to upload", state)
    names = set()
    paths = [(Path(source["path"]), source["kind"]) for source in state["sources"]]
    for source in state["sources"]:
        name_context = (source.get("parent_key"), source["name"])
        if name_context in names:
            raise WorkspaceError("name_conflict", "Selected roots share a name; rename one or upload to different cloud folders", state)
        names.add(name_context)
    if any(kind in {"app", "folder"} and parent != child and parent in child.parents
           for parent, kind in paths for child, _ in paths):
        raise WorkspaceError("overlapping_sources", "A selected folder already contains another selected source; keep the complete folder", state)
    for existing in state["jobs"]:
        if existing["state"] == "queued" and existing["destination"] == state["destination"]:
            if any(old["name"] == new["name"] and old.get("parent_key") == new.get("parent_key") and old["path"] != new["path"]
                   for old in existing["sources"] for new in state["sources"]):
                raise WorkspaceError("name_conflict", "Another queued source already uses this name in the selected cloud folder", state)
    # Clicking Upload explicitly captures the CURRENT selected files. Ordinary
    # metadata edits and an app exiting since selection should not force a
    # tedious remove/reselect cycle. This never reuses an old fingerprint: the
    # immutable job freezes this fresh scan and the worker verifies it again
    # before invoking the archive/round-trip/offload helper.
    fresh_sources = []
    for source in state["sources"]:
        path = source_path(source["path"])
        if str(path) != source["path"] or kindof(path) != source["kind"] or path.name != source["name"]:
            raise WorkspaceError("source_changed", "A selected source was replaced or renamed; select it again")
        fresh = copy.deepcopy(source)
        fresh["identity"] = fingerprint(path)
        fresh_sources.append(fresh)
    with locked_state(home) as (descriptor, current):
        require_revision(current, expected_revision)
        require_idle(current)
        if len(current["jobs"]) >= MAX_JOBS:
            raise WorkspaceError("workspace_full", "The upload queue/history is full; existing jobs were retained")
        if explicit_selection is None: current["sources"] = fresh_sources
        now = time.time()
        job = {"id": uuid.uuid4().hex, "state": "queued", "destination": copy.deepcopy(state["destination"]),
               "sources": copy.deepcopy(fresh_sources), "offload": offload, "encrypted": encryption, "encryption_mode": mode,
               "items": [{"source_id": source["id"], "state": "pending", "key": None,
                          "offloaded": None, "message": "Waiting to upload"} for source in fresh_sources],
               "completed_items": 0, "total_items": len(fresh_sources),
               "created_at": now, "updated_at": now, "error": None}
        current["jobs"].append(job)
        return commit(descriptor, current), job["id"]


@contextmanager
def maintenance_lock(home=None):
    home = Path.home() if home is None else Path(home)
    root = ensure_directory(support(home) / "AutoUpdates", home, private=True)
    directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    fd = None
    try:
        check_name(directory, "update.lock")
        fd = os.open("update.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=directory)
        regular_private(os.fstat(fd))
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise WorkspaceError("maintenance_busy", "An upload, update, restart, or cloud configuration is already running") from exc
        yield fd
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)


def helper_path(name):
    path = RESOURCE_DIR / name
    if path.is_symlink() or not path.is_file():
        raise WorkspaceError("helper_unavailable", "A required bundled cloud helper is unavailable")
    return path


def read_progress(path):
    """Accept only bounded numeric telemetry from the private library child."""
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            regular_private(os.fstat(stream.fileno()))
            data = stream.read(MAX_PROGRESS_BYTES + 1)
        if len(data) > MAX_PROGRESS_BYTES:
            return None
        value = strict_json(data)
        if (not isinstance(value, dict) or type(value.get("schema")) is not int or value.get("schema") != 1
                or not isinstance(value.get("phase"), str) or value["phase"] not in PROGRESS_PHASES):
            return None
        clean = {"phase": value["phase"]}
        integers = {"workers", "objects_done", "objects_total"}
        for key in ("completed_bytes", "total_bytes", "updated_at", "workers", "rate_bytes_per_second", "eta_seconds",
                    "network_elapsed_seconds", "baseline_network_seconds", "saved_network_seconds", "uploaded_bytes",
                    "downloaded_bytes", "encoded_bytes", "objects_done", "objects_total"):
            number = value.get(key)
            if number is None:
                continue
            if (type(number) not in (int, float) or not 0 <= number <= 2 ** 63 - 1 or not math.isfinite(number)
                    or key in integers and (type(number) is not int or key == "workers" and not 1 <= number <= 24)):
                return None
            clean[key] = number
        if clean.get("completed_bytes", 0) > clean.get("total_bytes", 2 ** 63 - 1):
            return None
        if clean.get("objects_done", 0) > clean.get("objects_total", 2 ** 63 - 1):
            return None
        return clean
    except (OSError, ValueError, UnicodeError, WorkspaceError):
        return None  # Telemetry can never fail or change the upload transaction.


@contextmanager
def progress_scope(job, index, home):
    actual_home = Path.home() if home is None else Path(home)
    root = ensure_directory(support(actual_home) / "UploadWorkspace/Progress", actual_home, private=True)
    path = root / (job["id"] + "-" + job["sources"][index]["id"] + ".json")
    try:
        last = None
        def publish():
            nonlocal last
            progress = read_progress(path)
            if progress is None or progress == last:
                return
            last = progress
            def update(current, state):
                phase = progress["phase"]
                start, span = PROGRESS_STAGES[phase]
                total = progress.get("total_bytes", 0)
                ratio = min(1, progress.get("completed_bytes", 0) / total) if total > 0 else 0
                local = min(.999, start + span * ratio)
                fraction = (index + local) / len(job["sources"])
                previous = current.get("progress", {}).get("fraction", 0)
                fraction = max(previous, fraction)
                current["progress"] = {**progress, "fraction": fraction, "source_index": index}
                elapsed = max(0, time.time() - current.get("started_at", time.time()))
                if elapsed >= 5 and .05 <= fraction < .99:
                    # A measured work-fraction projection, explicitly labeled
                    # as an estimate; it can change across CPU/network stages.
                    current["progress"]["overall_eta_seconds"] = min(31_536_000, elapsed * (1 - fraction) / fraction)
            try:
                job_mutation(job["id"], update, home)
            except (OSError, WorkspaceError):
                pass  # A telemetry write never interrupts the library child.
        _progress_context.current = (path, publish)
        try:
            yield
            publish()
        finally:
            _progress_context.current = None
    finally:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass


def run_with_progress(command, options, path, publish):
    """Poll telemetry while a file-backed child runs without filling pipes."""
    environment = os.environ.copy()
    environment["GD_UPLOAD_PROGRESS_FILE"] = str(path)
    child_options = {key: value for key, value in options.items()
                     if key not in {"capture_output", "text", "encoding", "errors", "check", "input"}}
    private_input = options.get("input")
    if private_input is not None:
        child_options["stdin"] = subprocess.PIPE
    with tempfile.TemporaryFile(dir=path.parent) as output, tempfile.TemporaryFile(dir=path.parent) as errors:
        child = subprocess.Popen(command, stdout=output, stderr=errors, env=environment, **child_options)
        if private_input is not None:
            try:
                child.stdin.write(private_input.encode("utf8"))
                child.stdin.close()
            except BrokenPipeError:
                pass  # The structured exit envelope still determines success.
        while True:
            try:
                child.wait(timeout=.5)
                break
            except subprocess.TimeoutExpired:
                publish()
        publish()
        output.seek(0)
        data = output.read(MAX_RESPONSE_BYTES + 1)
        if len(data) > MAX_RESPONSE_BYTES:
            raise ValueError("helper response exceeded its limit")
        return subprocess.CompletedProcess(command, child.returncode, data.decode("utf8"), "")


def child_result(command, maintenance_fd=None):
    # The library child retains the flock descriptor if this worker is closed.
    # Its individual cloud commands already have bounded timeouts. Do not kill
    # a transaction halfway through configuration/offload with a parent timeout.
    options = {"stdin": subprocess.DEVNULL, "capture_output": True, "text": True,
               "encoding": "utf8", "errors": "strict", "check": False}
    if maintenance_fd is not None:
        options["pass_fds"] = (maintenance_fd,)
    credential = _performance_input
    if credential is not None and len(command)>2 and Path(command[2]).name == "gendragoon_library.py":
        import gendragoon_auth_broker
        current_credential=gendragoon_auth_broker.attach(json.loads(credential))
        credential=json.dumps(current_credential,separators=(",", ":")).encode()
        inherited = gendragoon_auth_broker.inherited_fds(current_credential)
        options["pass_fds"] = tuple(dict.fromkeys((*options.get("pass_fds", ()), *inherited)))
        command = [*command, "--performance-stdin"]
        options.pop("stdin")
        options["input"] = credential.decode("utf8")
    try:
        progress = getattr(_progress_context, "current", None)
        result = run_with_progress(command, options, *progress) if progress else subprocess.run(command, **options)
        if len(result.stdout.encode()) > MAX_RESPONSE_BYTES:
            raise ValueError("helper response exceeded its limit")
        value = strict_json(result.stdout)
        if result.returncode != 0:
            # Only an exact known local guard may cross this boundary. Never
            # expose arbitrary child output, stderr, credentials or tracebacks.
            if (isinstance(value, dict) and value.get("ok") is False
                    and value.get("message") == "Quit this application before offloading it"):
                raise WorkspaceError("source_in_use",
                    "Quit the selected application before moving it to Trash, or turn off Move originals to Trash to upload a backup while keeping it on this Mac.")
            failure=validate_failure(value.get("failure")) if isinstance(value,dict) and value.get("ok") is False else None
            if failure:
                raise WorkspaceError(failure["code"],FAILURE_MESSAGES[failure["code"]],failure=failure)
            raise ValueError("helper did not complete")
        if not isinstance(value, dict) or value.get("ok") is not True:
            raise ValueError("helper did not return success")
        return value
    except (OSError, UnicodeError, ValueError) as exc:
        raise WorkspaceError("helper_failed", "The cloud helper did not return a verified result; the selection and job were retained") from exc


def select_destination_cli(project, bucket, remote, prefix, expected_revision, home=None):
    desired = destination_record(project, bucket, remote, prefix)
    snapshot = read_state(home)
    require_revision(snapshot, expected_revision)
    require_idle(snapshot)
    if remote == "redxai":
        if project != "redxai" or not re.fullmatch(r"[a-f0-9]{32}", bucket):
            raise WorkspaceError("invalid_destination", "Choose a verified Red-XAI Receiver workspace")
        return select_destination(project, bucket, remote, prefix, expected_revision, home)
    command = [sys.executable, "-B", str(helper_path("gendragoon_connect.py")), "configure",
               "--project", project, "--bucket", bucket, "--remote", remote,
               "--prefix", prefix, "--expected-revision", str(expected_revision)]
    child_result(command)
    current = read_state(home)
    if current["destination"] != desired or current["revision"] <= expected_revision:
        raise WorkspaceError("destination_changed", "The destination changed while configuration finished; refresh before uploading", current)
    return current


def library_key(destination, source):
    folder = destination["bucket"] + ("/" + destination["prefix"] if destination["prefix"] else "")
    parts = [destination["project"], destination["bucket"], destination["remote"], folder, source["name"]]
    if source.get("parent_key") is not None:
        parts += ["parent", parent_key_record(source["parent_key"])]
    value = "|".join(parts)
    return hashlib.sha256(value.encode()).hexdigest()[:18]


def validate_upload_result(result, destination, source, offload):
    folder = destination["bucket"] + ("/" + destination["prefix"] if destination["prefix"] else "")
    expected = {"key": library_key(destination, source), "project": destination["project"],
                "bucket": destination["bucket"], "remote": destination["remote"], "folder": folder,
                "source": source["path"], "kind": source["kind"], "name": source["name"]}
    if (result.get("verified") is not True or type(result.get("offloaded")) is not bool
            or result.get("parentKey") != source.get("parent_key")
            or any(result.get(key) != value for key, value in expected.items())):
        raise WorkspaceError("result_mismatch", "Upload result did not match this job's frozen source and destination")
    if result["offloaded"] != offload:
        raise WorkspaceError("offload_incomplete", "The verified upload did not complete the requested local-copy action")


def job_mutation(identifier, operation, home=None):
    with locked_state(home) as (descriptor, state):
        if state["active_job_id"] != identifier:
            raise WorkspaceError("job_changed", "The active upload job changed; its result was not applied", state)
        job = next(job for job in state["jobs"] if job["id"] == identifier)
        operation(job, state)
        job["updated_at"] = time.time()
        return commit(descriptor, state)


def interrupted_job(descriptor, state):
    previous = next(job for job in state["jobs"] if job["id"] == state["active_job_id"])
    previous["state"] = "failed"
    previous["error"] = "worker_interrupted"
    previous["updated_at"] = time.time()
    for item in previous["items"]:
        if item["state"] == "running":
            item.update(state="failed", message="Worker interrupted; check the cloud library before retrying")
    state["active_job_id"] = None
    return commit(descriptor, state)


def observed_state(home=None):
    """Unfreeze a crashed worker on UI refresh, but never interrupt its child.

    Public read_state deliberately remains state-lock-only for configure callers.
    Here the initial read releases that lock before the nonblocking maintenance
    probe, preserving maintenance -> state lock order. A surviving library child
    retains the inherited lease, so its operation remains protected and visible.
    """
    state = read_state(home)
    if state["active_job_id"] is None:
        return state
    try:
        with maintenance_lock(home):
            with locked_state(home) as (descriptor, current):
                return interrupted_job(descriptor, current) if current["active_job_id"] is not None else current
    except WorkspaceError as exc:
        if exc.code == "maintenance_busy":
            return read_state(home)
        raise


def run_next(home=None):
    """Run one frozen job synchronously; other processes may poll state freely."""
    with maintenance_lock(home) as maintenance_fd:
        with locked_state(home) as (descriptor, state):
            if state["active_job_id"] is not None:
                # A previous worker disappeared. Its child would still own the
                # shared flock while uploading, so reaching here is safe. Do not
                # retry an uncertain offload automatically or claim it succeeded.
                interrupted_job(descriptor, state)
                raise WorkspaceError("worker_interrupted", "An earlier worker stopped; its job was retained for review", state)
            queued = next((job for job in state["jobs"] if job["state"] == "queued"), None)
            if queued is None:
                return state, None
            queued["state"] = "running"
            queued["started_at"] = time.time()
            queued["worker_pid"] = os.getpid()
            queued["updated_at"] = time.time()
            state["active_job_id"] = queued["id"]
            commit(descriptor, state)
            job = copy.deepcopy(queued)
        try:
            for index, source in enumerate(job["sources"]):
                def starting(current, state):
                    current["items"][index].update(state="running", message="Checking source and uploading")
                    previous = current.get("progress", {}).get("fraction", 0)
                    current["progress"] = {"phase": "preparing", "fraction": max(previous, index / len(job["sources"])),
                                           "source_index": index}
                job_mutation(job["id"], starting, home)
                unchanged(source)
                destination = job["destination"]
                folder = destination["bucket"] + ("/" + destination["prefix"] if destination["prefix"] else "")
                command = [sys.executable, "-B", str(helper_path("gendragoon_library.py")), "upload",
                           "--source", source["path"], "--remote", destination["remote"], "--folder", folder,
                           "--project", destination["project"], "--bucket", destination["bucket"],
                           "--maintenance-fd", str(maintenance_fd)]
                if source.get("parent_key") is not None:
                    command += ["--parent-key", parent_key_record(source["parent_key"])]
                if destination["remote"] == "redxai" and _performance_input is None:
                    raise WorkspaceError("redxai_auth_required", "Connect Red-XAI in the app or with REDXAI Auth-CLI before uploading")
                if job["offload"]:
                    command.append("--offload")
                if job.get("encrypted",True) is False:
                    command.append("--no-encryption")
                elif job.get("encryption_mode")=="fast":
                    command.extend(["--encryption-mode","fast"])
                with progress_scope(job, index, home):
                    outcome = child_result(command, maintenance_fd)
                validate_upload_result(outcome, destination, source, job["offload"])
                def succeeded(current, state):
                    current["items"][index].update(state="succeeded", key=outcome["key"],
                                                   offloaded=outcome["offloaded"], message="Verified upload complete")
                    current["completed_items"] += 1
                    current["progress"] = {**current.get("progress", {}), "phase": "complete",
                                           "fraction": current["completed_items"] / len(current["sources"])}
                job_mutation(job["id"], succeeded, home)
            def finished(current, state):
                current["state"] = "succeeded"
                current["error"] = None
                state["active_job_id"] = None
            return job_mutation(job["id"], finished, home), job["id"]
        except Exception as exc:
            error = exc if isinstance(exc, WorkspaceError) else WorkspaceError("upload_failed", "Upload could not finish; the selection and job were retained")
            def failed(current, state):
                current["state"] = "failed"
                current["error"] = error.code
                failure=error.failure or validate_failure({"code":error.code}) or {"code":"helper_failed"}
                phase=current.get("progress",{}).get("phase","preparing")
                if phase not in PROGRESS_PHASES:phase="preparing"
                current["failure"]={**failure,"phase":phase,"at":int(time.time())}
                for item in current["items"]:
                    if item["state"] == "running":
                        item.update(state="failed", message=error.message)
                state["active_job_id"] = None
            current = job_mutation(job["id"], failed, home)
            error.state = current
            raise error


def tree_node(path, identifier=None):
    metadata = path.lstat()
    symlink = stat.S_ISLNK(metadata.st_mode)
    directory = stat.S_ISDIR(metadata.st_mode)
    kind = ("app" if directory and path.name.casefold().endswith(".app") else "folder") if directory else "file"
    return {"id": identifier or hashlib.sha256(os.fsencode(str(path))).hexdigest()[:24],
            "path": str(path), "name": path.name, "kind": kind,
            "has_children": directory and kind != "app", "selectable": directory or stat.S_ISREG(metadata.st_mode),
            "symlink": symlink}


def tree(path=None, home=None):
    state = read_state(home)
    actual_home = Path.home() if home is None else Path(home)
    quick = []
    for entry in (Path("/Applications"), actual_home / "Applications"):
        if entry.exists() and not entry.is_symlink():
            quick.append(tree_node(entry))
        else:
            quick.append({"id": hashlib.sha256(os.fsencode(str(entry))).hexdigest()[:24], "path": str(entry),
                          "name": str(entry), "kind": "folder", "has_children": False, "selectable": False,
                          "symlink": entry.is_symlink()})
    if path is None:
        children = [{key: value for key, value in source.items() if key in {"id", "path", "name", "kind"}}
                    | {"has_children": source["kind"] == "folder", "selectable": True, "symlink": False}
                    for source in state["sources"]]
        root = {"path": None, "name": "Selected sources", "kind": "folder", "atomic": False,
                "children": children, "truncated": False}
    else:
        target = source_path(path)
        if any(parent.name.casefold().endswith(".app") for parent in target.parents):
            raise WorkspaceError("atomic_app", "Applications are selected as complete bundles")
        node = tree_node(target)
        children, truncated = [], False
        if node["kind"] == "folder":
            with os.scandir(target) as entries:
                for entry in entries:
                    if len(children) >= MAX_TREE_ENTRIES:
                        truncated = True
                        break
                    children.append(tree_node(Path(entry.path)))
            children.sort(key=lambda value: (value["kind"] == "file", value["name"].casefold()))
        root = {"path": str(target), "name": target.name, "kind": node["kind"], "atomic": node["kind"] == "app",
                "children": children, "truncated": truncated}
    response = {"ok": True, "state": state, "tree": root, "quick_entries": quick}
    # Bound the complete output, including state and long filenames.
    while root["children"] and len(json.dumps(response).encode()) >= MAX_RESPONSE_BYTES - 1024:
        root["children"].pop()
        root["truncated"] = True
    return response


def emit(response):
    data = json.dumps(response, separators=(",", ":"))
    if len(data.encode()) >= MAX_RESPONSE_BYTES:
        data = json.dumps({"ok": False, "error": "response_too_large", "message": "Workspace output exceeded its safe size limit"})
    print(data, flush=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    for name in ("state", "jobs", "run-next"):
        command = sub.add_parser(name)
        if name == "run-next":
            command.add_argument("--performance-stdin", action="store_true")
    browse = sub.add_parser("tree")
    browse.add_argument("--path")
    destination = sub.add_parser("select-destination")
    destination.add_argument("--project", required=True)
    destination.add_argument("--bucket", required=True)
    destination.add_argument("--remote", required=True)
    destination.add_argument("--prefix", default=DEFAULT_PREFIX)
    add = sub.add_parser("add-sources")
    add.add_argument("--paths-json", required=True)
    add.add_argument("--parent-key")
    remove = sub.add_parser("remove-source")
    remove.add_argument("--id", required=True)
    cancel = sub.add_parser("cancel-job")
    cancel.add_argument("--id", required=True)
    clear = sub.add_parser("clear-sources")
    queue = sub.add_parser("enqueue")
    queue.add_argument("--offload", choices=("true", "false"), required=True)
    queue.add_argument("--encryption", choices=("true", "false"), default="true")
    queue.add_argument("--encryption-mode", choices=("standard","fast","off"))
    companion = sub.add_parser("enqueue-selection")
    companion.add_argument("--paths-json", required=True)
    companion.add_argument("--destination-json", required=True)
    for command in (destination, add, remove, clear, queue, cancel, companion):
        command.add_argument("--expected-revision", type=int, required=True)
    args = parser.parse_args(argv)
    if getattr(args, "performance_stdin", False):
        import gendragoon_performance as performance
        global _performance_input
        performance.configure_from_stdin()
        _performance_input = performance.forwarded_input()
    try:
        extra = {}
        if args.action in ("state", "jobs"):
            state = observed_state()
        elif args.action == "tree":
            emit(tree(args.path))
            return 0
        elif args.action == "select-destination":
            state = select_destination_cli(args.project, args.bucket, args.remote, args.prefix, args.expected_revision)
        elif args.action == "add-sources":
            state = add_sources(strict_json(args.paths_json), args.expected_revision, parent_key=args.parent_key)
        elif args.action == "remove-source":
            state = remove_source(args.id, args.expected_revision)
        elif args.action == "cancel-job":
            state = cancel_job(args.id, args.expected_revision)
        elif args.action == "clear-sources":
            state = clear_sources(args.expected_revision)
        elif args.action == "enqueue":
            state, extra["job_id"] = enqueue(args.expected_revision, args.offload == "true", encryption=args.encryption == "true", encryption_mode=args.encryption_mode)
        elif args.action == "enqueue-selection":
            state, extra["job_id"] = enqueue(args.expected_revision, False,
                explicit_selection=strict_json(args.paths_json), explicit_destination=strict_json(args.destination_json))
        else:
            state, extra["job_id"] = run_next()
        emit({"ok": True, "state": state, **extra})
        return 0
    except Exception as exc:
        error = exc if isinstance(exc, WorkspaceError) else WorkspaceError("workspace_failed", "Upload workspace could not finish; existing data was preserved")
        response = {"ok": False, "error": error.code, "message": error.message}
        if error.state is not None:
            response["state"] = error.state
        emit(response)
        return 1


if __name__ == "__main__":
    sys.exit(main())
