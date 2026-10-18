#!/usr/bin/env python3
"""Persist one explicit upload destination, source selection, and durable queue.

No credentials are read or stored here. CLI destination selection delegates to
gendragoon_connect.py for project membership/read checks and configuration. The
select_destination Python API is a state-only CAS commit for that validated
caller; it does not acquire the shared maintenance lock or contact the network.
run-next holds AutoUpdates/update.lock through the upload and gives that lock FD
to the library child, but releases the workspace lock during external work.
"""
import argparse
from contextlib import contextmanager
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
import uuid

DEFAULT_PREFIX = "GenDragoon-App-Library"
MAX_STATE_BYTES = 3 * 1024 * 1024
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_SOURCES = 1000
MAX_JOBS = 200
MAX_TREE_ENTRIES = 2000
MAX_FINGERPRINT_ENTRIES = 1000000
HELPER_TIMEOUT = 6 * 60 * 60
RESOURCE_DIR = Path(__file__).absolute().parent
SOURCE_KINDS = {"app", "folder", "file"}
JOB_STATES = {"queued", "running", "succeeded", "failed"}


class WorkspaceError(RuntimeError):
    def __init__(self, code, message, state=None):
        self.code, self.message, self.state = code, message, state
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
        if (not isinstance(job, dict) or not isinstance(job.get("id"), str) or job["id"] in job_ids
                or job.get("state") not in JOB_STATES or type(job.get("offload")) is not bool
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
            or not isinstance(source.get("path"), str) or not Path(source["path"]).is_absolute()
            or not isinstance(source.get("name"), str) or source.get("kind") not in SOURCE_KINDS
            or not isinstance(source.get("identity"), dict)
            or not re.fullmatch(r"[a-f0-9]{64}", str(source["identity"].get("sha256", "")))):
        raise WorkspaceError("invalid_state", "A saved source identity is invalid")


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


CONTENT_HASH_LIMIT = 8 * 1024 * 1024
RECENT_CONTENT_WINDOW_NS = 5_000_000_000


def content_digest(item, info):
    """Hash bytes when size and mtime would not reveal a same-size edit."""
    recent = time.time_ns() - min(info.st_mtime_ns, info.st_ctime_ns) <= RECENT_CONTENT_WINDOW_NS
    if info.st_size > CONTENT_HASH_LIMIT and not recent:
        return None
    to_read = info.st_size if info.st_size <= CONTENT_HASH_LIMIT else min(info.st_size, 1024 * 1024)
    digest = hashlib.sha256()
    try:
        descriptor = os.open(item, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except OSError as exc:
        raise WorkspaceError("invalid_source", "A source file could not be read") from exc
    try:
        observed = os.fstat(descriptor)
        if not stat.S_ISREG(observed.st_mode):
            raise WorkspaceError("source_changed", "A source changed while being selected; try again")
        remaining = to_read
        while remaining:
            block = os.read(descriptor, min(remaining, 1024 * 1024))
            if not block:
                break
            digest.update(block)
            remaining -= len(block)
        after = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    if (after.st_size, after.st_mtime_ns) != (info.st_size, info.st_mtime_ns):
        raise WorkspaceError("source_changed", "A source changed while being selected; try again")
    return digest.hexdigest()


def fingerprint(path):
    """Hash identity/metadata for the complete tree without following symlinks.

    Library upload additionally hashes content manifests around backup/offload.
    This selection fingerprint catches replacements and ordinary edits between
    selection, enqueue, and worker admission. Same-size edits that land inside
    one timestamp tick are included by hashing file bytes.
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
        content = content_digest(item, info) if stat.S_ISREG(info.st_mode) and not stat.S_ISLNK(info.st_mode) else None
        record = [relative, info.st_dev, info.st_ino, info.st_mode, info.st_size,
                  info.st_mtime_ns, info.st_ctime_ns, os.readlink(item) if stat.S_ISLNK(info.st_mode) else None,
                  content]
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


def selected_source(value):
    path = source_path(value)
    if any(parent.name.casefold().endswith(".app") for parent in path.parents):
        raise WorkspaceError("atomic_app", "Select the complete application bundle rather than its internal files")
    return {"id": uuid.uuid4().hex, "path": str(path), "name": path.name,
            "kind": kindof(path), "identity": fingerprint(path)}


def add_sources(paths, expected_revision, home=None):
    if not isinstance(paths, list) or not paths or not all(isinstance(path, str) and path for path in paths):
        raise WorkspaceError("invalid_source", "Provide a nonempty JSON array of source paths")
    if len(paths) > MAX_SOURCES:
        raise WorkspaceError("selection_full", "Too many sources were selected")
    records = [selected_source(path) for path in paths]
    with locked_state(home) as (descriptor, state):
        require_revision(state, expected_revision)
        require_idle(state)
        existing = {source["path"] for source in state["sources"]}
        for source in records:
            if source["path"] not in existing:
                state["sources"].append(source)
                existing.add(source["path"])
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


def unchanged(source):
    try:
        path = source_path(source["path"])
        equal = (str(path) == source["path"] and kindof(path) == source["kind"]
                 and fingerprint(path) == source["identity"])
    except (OSError, WorkspaceError):
        equal = False
    if not equal:
        raise WorkspaceError("source_changed", "A source changed after selection; remove it and select it again")


def enqueue(expected_revision, offload, home=None):
    if type(offload) is not bool:
        raise WorkspaceError("invalid_option", "Offload must be explicitly true or false")
    state = read_state(home)
    require_revision(state, expected_revision)
    require_idle(state)
    if state["destination"] is None:
        raise WorkspaceError("destination_required", "Choose a project and bucket before uploading", state)
    if not state["sources"]:
        raise WorkspaceError("source_required", "Select applications, files, or folders to upload", state)
    names = set()
    paths = [(Path(source["path"]), source["kind"]) for source in state["sources"]]
    for source in state["sources"]:
        if source["name"] in names:
            raise WorkspaceError("name_conflict", "Selected roots share a name; rename one or upload to different cloud folders", state)
        names.add(source["name"])
    if any(kind in {"app", "folder"} and parent != child and parent in child.parents
           for parent, kind in paths for child, _ in paths):
        raise WorkspaceError("overlapping_sources", "A selected folder already contains another selected source; keep the complete folder", state)
    for existing in state["jobs"]:
        if existing["state"] == "queued" and existing["destination"] == state["destination"]:
            if any(old["name"] == new["name"] and old["path"] != new["path"]
                   for old in existing["sources"] for new in state["sources"]):
                raise WorkspaceError("name_conflict", "Another queued source already uses this name in the selected cloud folder", state)
    for source in state["sources"]:
        unchanged(source)
    with locked_state(home) as (descriptor, current):
        require_revision(current, expected_revision)
        require_idle(current)
        if len(current["jobs"]) >= MAX_JOBS:
            raise WorkspaceError("workspace_full", "The upload queue/history is full; existing jobs were retained")
        now = time.time()
        job = {"id": uuid.uuid4().hex, "state": "queued", "destination": copy.deepcopy(current["destination"]),
               "sources": copy.deepcopy(current["sources"]), "offload": offload,
               "items": [{"source_id": source["id"], "state": "pending", "key": None,
                          "offloaded": None, "message": "Waiting to upload"} for source in current["sources"]],
               "completed_items": 0, "total_items": len(current["sources"]),
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


def child_result(command, maintenance_fd=None):
    # The library child retains the flock descriptor if this worker is closed.
    # Its individual cloud commands already have bounded timeouts. Do not kill
    # a transaction halfway through configuration/offload with a parent timeout.
    options = {"stdin": subprocess.DEVNULL, "capture_output": True, "text": True,
               "encoding": "utf8", "errors": "strict", "check": False}
    if maintenance_fd is not None:
        options["pass_fds"] = (maintenance_fd,)
    try:
        result = subprocess.run(command, **options)
        if result.returncode != 0 or len(result.stdout.encode()) > MAX_RESPONSE_BYTES:
            raise ValueError("helper did not complete")
        value = strict_json(result.stdout)
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
    command = [sys.executable, str(helper_path("gendragoon_connect.py")), "configure",
               "--project", project, "--bucket", bucket, "--remote", remote,
               "--prefix", prefix, "--expected-revision", str(expected_revision)]
    child_result(command)
    current = read_state(home)
    if current["destination"] != desired or current["revision"] <= expected_revision:
        raise WorkspaceError("destination_changed", "The destination changed while configuration finished; refresh before uploading", current)
    return current


def library_key(destination, source):
    folder = destination["bucket"] + ("/" + destination["prefix"] if destination["prefix"] else "")
    value = "|".join((destination["project"], destination["bucket"], destination["remote"], folder, source["name"]))
    return hashlib.sha256(value.encode()).hexdigest()[:18]


def validate_upload_result(result, destination, source, offload):
    folder = destination["bucket"] + ("/" + destination["prefix"] if destination["prefix"] else "")
    expected = {"key": library_key(destination, source), "project": destination["project"],
                "bucket": destination["bucket"], "remote": destination["remote"], "folder": folder,
                "source": source["path"], "kind": source["kind"], "name": source["name"]}
    if (result.get("verified") is not True or type(result.get("offloaded")) is not bool
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
            queued["worker_pid"] = os.getpid()
            queued["updated_at"] = time.time()
            state["active_job_id"] = queued["id"]
            commit(descriptor, state)
            job = copy.deepcopy(queued)
        try:
            for index, source in enumerate(job["sources"]):
                def starting(current, state):
                    current["items"][index].update(state="running", message="Checking source and uploading")
                job_mutation(job["id"], starting, home)
                unchanged(source)
                destination = job["destination"]
                folder = destination["bucket"] + ("/" + destination["prefix"] if destination["prefix"] else "")
                command = [sys.executable, str(helper_path("gendragoon_library.py")), "upload",
                           "--source", source["path"], "--remote", destination["remote"], "--folder", folder,
                           "--project", destination["project"], "--bucket", destination["bucket"],
                           "--maintenance-fd", str(maintenance_fd)]
                if job["offload"]:
                    command.append("--offload")
                outcome = child_result(command, maintenance_fd)
                validate_upload_result(outcome, destination, source, job["offload"])
                def succeeded(current, state):
                    current["items"][index].update(state="succeeded", key=outcome["key"],
                                                   offloaded=outcome["offloaded"], message="Verified upload complete")
                    current["completed_items"] += 1
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
        sub.add_parser(name)
    browse = sub.add_parser("tree")
    browse.add_argument("--path")
    destination = sub.add_parser("select-destination")
    destination.add_argument("--project", required=True)
    destination.add_argument("--bucket", required=True)
    destination.add_argument("--remote", required=True)
    destination.add_argument("--prefix", default=DEFAULT_PREFIX)
    add = sub.add_parser("add-sources")
    add.add_argument("--paths-json", required=True)
    remove = sub.add_parser("remove-source")
    remove.add_argument("--id", required=True)
    clear = sub.add_parser("clear-sources")
    queue = sub.add_parser("enqueue")
    queue.add_argument("--offload", choices=("true", "false"), required=True)
    for command in (destination, add, remove, clear, queue):
        command.add_argument("--expected-revision", type=int, required=True)
    args = parser.parse_args(argv)
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
            state = add_sources(strict_json(args.paths_json), args.expected_revision)
        elif args.action == "remove-source":
            state = remove_source(args.id, args.expected_revision)
        elif args.action == "clear-sources":
            state = clear_sources(args.expected_revision)
        elif args.action == "enqueue":
            state, extra["job_id"] = enqueue(args.expected_revision, args.offload == "true")
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
