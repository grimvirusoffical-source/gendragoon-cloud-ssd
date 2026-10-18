#!/usr/bin/env python3
"""Preview, explicitly apply, and undo local folder organization.

No deletion, copying, cloud access, process termination, or symlink traversal.
The calling app MUST hold its operation coordinator's exclusive reservation and
pass --ui-busy false. The shared update lock also excludes cooperating helpers.
Plans and receipts contain paths and fingerprints, never file contents/secrets.
"""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse
from contextlib import contextmanager
import ctypes
import errno
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import platform
import re
import stat
import subprocess
import sys
import time
import uuid

VERSION = 1
MAX_RECORD = 16 * 1024 * 1024
MAX_ENTRIES = 100_000
CATEGORIES = {("Applications",), ("Media", "Videos"), ("Media", "Audio"),
              ("Media", "Pictures"), ("Files",), ("Folders",)}
RESERVED = {"applications", "media", "files", "folders"}
def shared_extension_map():
    here = Path(__file__).resolve()
    for path in (
        here.with_name("extension-map.json"),
        here.parents[1] / "Resources" / "extension-map.json",
        here.parents[2] / "native" / "Resources" / "extension-map.json",
    ):
        if path.is_file():
            return json.loads(path.read_text())
    raise RuntimeError("The shared extension map is missing")


def _dotted(category):
    return {"." + name for name in shared_extension_map()["extensions"][category]}


VIDEO = _dotted("videos")
AUDIO = _dotted("audio")
PICTURE = _dotted("pictures")
TEMPORARY_SUFFIXES = (".part", ".partial", ".download", ".crdownload", ".tmp", ".lock")
MESSAGES = {
    "unsafe_root": "Choose a normal local folder you own, away from system, cloud, cache, and app-support locations.",
    "unsafe_state": "The cleanup plan or private storage is unsafe or has changed. Create a new preview.",
    "changed": "Files or their destination changed after preview. Nothing new was moved; create a new preview.",
    "busy": "Wait for transfers, running applications, installs, resets, and updates to finish.",
    "inspection_failed": "Cleanup could not verify local process or storage safety.",
    "unsupported": "Atomic no-overwrite local moves are not supported on this system.",
    "rolled_back": "Organization failed; completed moves were rolled back. Your files were preserved.",
    "recovery_needed": "Organization stopped and some moves need review. Keep the receipt and use Undo after resolving conflicts.",
    "already_used": "This preview has already been applied. Create a new preview or undo its receipt.",
    "unexpected": "Cleanup could not finish. Check the receipt before retrying; your files were not deleted.",
}


class CleanupError(RuntimeError):
    def __init__(self, code, receipt_id=None):
        self.code, self.receipt_id = code, receipt_id
        super().__init__(MESSAGES[code])


def identity(info):
    return [info.st_dev, info.st_ino, info.st_uid, info.st_mode]


def private_regular(info):
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077 or info.st_nlink != 1:
        raise CleanupError("unsafe_state")


def no_links(path):
    path = Path(os.path.abspath(path))
    for part in (path, *path.parents):
        try:
            if stat.S_ISLNK(part.lstat().st_mode):
                raise CleanupError("unsafe_root")
        except FileNotFoundError:
            raise CleanupError("unsafe_root") from None
    return path


def private_directory(path, home):
    home = no_links(home)
    path = Path(path)
    try:
        relative = path.relative_to(home)
    except ValueError:
        raise CleanupError("unsafe_state") from None
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
            raise CleanupError("unsafe_state")
    if path.stat().st_mode & 0o077:
        raise CleanupError("unsafe_state")
    return path


def support(home):
    return Path(home) / "Library/Application Support/GenDragoon Cloud SSD"


def valid_id(value):
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{32}", value) is not None


def child_name(value):
    return isinstance(value, str) and value not in {"", ".", ".."} and "/" not in value and "\0" not in value


def encoded(value):
    return json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()


class Store:
    def __init__(self, home):
        self.path = private_directory(support(home) / "DriveCleanup", home)
        self.fd = os.open(self.path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            try:
                keyfd = os.open("authentication.key", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
            except FileExistsError:
                pass
            else:
                with os.fdopen(keyfd, "wb") as stream:
                    stream.write(os.urandom(32))
                    stream.flush()
                    os.fsync(stream.fileno())
            keyfd = os.open("authentication.key", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
            with os.fdopen(keyfd, "rb") as stream:
                private_regular(os.fstat(stream.fileno()))
                self.key = stream.read(33)
            if len(self.key) != 32:
                raise CleanupError("unsafe_state")
        except BaseException:
            os.close(self.fd)
            raise

    def close(self):
        os.close(self.fd)

    def write(self, name, record, exclusive=False):
        if not re.fullmatch(r"(?:plan|receipt)-[0-9a-f]{32}\.json", name):
            raise CleanupError("unsafe_state")
        payload = encoded({"record": record, "signature": hmac.new(self.key, encoded(record), hashlib.sha256).hexdigest()})
        if len(payload) > MAX_RECORD:
            raise CleanupError("unsafe_state")
        temporary = ".pending-" + uuid.uuid4().hex
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=self.fd)
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                info = os.stat(name, dir_fd=self.fd, follow_symlinks=False)
            except FileNotFoundError:
                pass
            else:
                private_regular(info)
                if exclusive:
                    raise CleanupError("already_used")
            if exclusive:
                rename_exclusive(self.fd, temporary, self.fd, name)
            else:
                os.replace(temporary, name, src_dir_fd=self.fd, dst_dir_fd=self.fd)
            os.fsync(self.fd)
        finally:
            try:
                os.unlink(temporary, dir_fd=self.fd)
            except FileNotFoundError:
                pass

    def read(self, kind, identifier):
        if kind not in {"plan", "receipt"} or not valid_id(identifier):
            raise CleanupError("unsafe_state")
        try:
            descriptor = os.open(f"{kind}-{identifier}.json", os.O_RDONLY | os.O_NOFOLLOW, dir_fd=self.fd)
            with os.fdopen(descriptor, "rb") as stream:
                private_regular(os.fstat(stream.fileno()))
                data = stream.read(MAX_RECORD + 1)
            if len(data) > MAX_RECORD:
                raise CleanupError("unsafe_state")
            envelope = json.loads(data)
            record, signature = envelope["record"], envelope["signature"]
            expected = hmac.new(self.key, encoded(record), hashlib.sha256).hexdigest()
            if not isinstance(signature, str) or not hmac.compare_digest(signature, expected):
                raise CleanupError("unsafe_state")
            validate_record(record, kind, identifier)
            return record
        except (OSError, ValueError, KeyError, TypeError):
            raise CleanupError("unsafe_state") from None

    def exists(self, name):
        try:
            private_regular(os.stat(name, dir_fd=self.fd, follow_symlinks=False))
            return True
        except FileNotFoundError:
            return False


@contextmanager
def operation(home, ui_busy):
    if ui_busy is not False:
        raise CleanupError("busy")
    directory = private_directory(support(home) / "AutoUpdates", home)
    parent = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    lock = None
    store = None
    try:
        lock = os.open("update.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        private_regular(os.fstat(lock))
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise CleanupError("busy") from None
        store = Store(home)
        yield store
    finally:
        if store:
            store.close()
        if lock is not None:
            os.close(lock)
        os.close(parent)


def rename_exclusive(source_fd, source, destination_fd, destination):
    """Use the kernel's atomic fail-if-present rename, never an exists/rename race."""
    libc = ctypes.CDLL(None, use_errno=True)
    arguments = [source_fd, os.fsencode(source), destination_fd, os.fsencode(destination)]
    if sys.platform == "darwin" and hasattr(libc, "renameatx_np"):
        function, flag = libc.renameatx_np, 0x00000004  # RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        function, flag = libc.renameat2, 1  # RENAME_NOREPLACE; fixtures only
    else:
        raise CleanupError("unsupported")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(*arguments, flag) != 0:
        code = ctypes.get_errno()
        if code in {errno.ENOSYS, errno.EINVAL, errno.ENOTSUP}:
            raise CleanupError("unsupported")
        raise OSError(code, os.strerror(code))


def inspect_active_paths():
    try:
        result = subprocess.run(["/bin/ps", "-axo", "command="], stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=12, check=True)
    except (OSError, subprocess.SubprocessError):
        raise CleanupError("inspection_failed") from None
    if len(result.stdout) > 4 * 1024 * 1024:
        raise CleanupError("inspection_failed")
    active = []
    for line in result.stdout.splitlines():
        if any(word in line.lower() for word in ("rclone mount", "rclone copy", "rclone move", "gendragoon_auto_update", "gendragoon_app_control")):
            raise CleanupError("busy")
        match = re.match(r"(/.*?\.app)(?:/|\s|$)", line)
        if match:
            active.append(Path(match.group(1)))
    if sys.platform == "darwin":
        try:
            opened = subprocess.run(["/usr/sbin/lsof", "-nP", "-a", "-u", str(os.getuid()), "-Fn"],
                                    stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=20)
        except (OSError, subprocess.SubprocessError):
            raise CleanupError("inspection_failed") from None
        if opened.returncode != 0 or len(opened.stdout) > 16 * 1024 * 1024:
            raise CleanupError("inspection_failed")
        for line in opened.stdout.splitlines():
            if line.startswith("n/"):
                item = Path(line[1:])
                try:
                    if stat.S_ISREG(item.lstat().st_mode):
                        active.append(item)
                except OSError:
                    pass
    return active


def root_path(path, home):
    if not isinstance(path, (str, Path)) or not Path(path).is_absolute():
        raise CleanupError("unsafe_root")
    root, home = no_links(path), no_links(home)
    forbidden = [Path(p) for p in ("/Applications", "/System", "/Library", "/bin", "/sbin", "/usr", "/etc", "/private", "/var", "/dev", "/proc", "/sys")]
    forbidden += [home / name for name in ("Library", ".cache", ".config", "GenDragoon Cloud SSD", "Dropbox", "OneDrive", "Google Drive", "Box")]
    if root == Path("/") or root == home or root == Path("/Users") or root == Path("/Volumes"):
        raise CleanupError("unsafe_root")
    if any(root == item or item in root.parents or root in item.parents for item in forbidden):
        raise CleanupError("unsafe_root")
    if any(part.startswith(".") or part.lower().endswith(".app") for part in root.parts[1:]):
        raise CleanupError("unsafe_root")
    if any(part.casefold().startswith(("dropbox", "onedrive", "google drive", "box sync")) for part in root.parts[1:]):
        raise CleanupError("unsafe_root")
    info = root.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022 or root.is_mount():
        raise CleanupError("unsafe_root")
    if os.getuid() != os.geteuid() or not os.access(root, os.R_OK | os.W_OK | os.X_OK):
        raise CleanupError("unsafe_root")
    # A local subdirectory on a cloud/FUSE volume is unsafe too. macOS reports
    # the backing filesystem for this exact path; fail closed if inspection fails.
    if sys.platform == "darwin":
        try:
            result = subprocess.run(["/sbin/mount"], stdin=subprocess.DEVNULL,
                                    capture_output=True, text=True, timeout=12, check=True)
        except (OSError, subprocess.SubprocessError):
            raise CleanupError("inspection_failed") from None
        mounts = []
        for line in result.stdout.splitlines():
            match = re.search(r" on (.+) \(([^,)]+)", line)
            if match:
                mountpoint = Path(match.group(1))
                if mountpoint == root or mountpoint in root.parents:
                    mounts.append((len(mountpoint.parts), match.group(2).lower()))
        if not mounts or max(mounts)[1] not in {"apfs", "hfs", "msdos", "exfat"}:
            raise CleanupError("unsafe_root")
    return root


def xattr_values(descriptor):
    """CPython's os xattr APIs are Linux-only; use Darwin's descriptor APIs."""
    try:
        if sys.platform != "darwin":
            return [(name, os.getxattr(descriptor, name)) for name in sorted(os.listxattr(descriptor))]
        libc = ctypes.CDLL(None, use_errno=True)
        listing, getting = libc.flistxattr, libc.fgetxattr
        listing.argtypes = [ctypes.c_int, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_int]
        listing.restype = ctypes.c_ssize_t
        getting.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32, ctypes.c_int]
        getting.restype = ctypes.c_ssize_t

        def read(function, prefix, suffix):
            size = function(*prefix, None, 0, *suffix)
            if size < 0:
                raise OSError(ctypes.get_errno(), "xattr query failed")
            if size > MAX_RECORD:
                raise CleanupError("inspection_failed")
            buffer = ctypes.create_string_buffer(max(1, size))
            count = function(*prefix, buffer, size, *suffix)
            if count < 0:
                raise OSError(ctypes.get_errno(), "xattr read failed")
            if count != size:
                raise CleanupError("changed")
            return buffer.raw[:count]

        names = sorted(value for value in read(listing, [descriptor], [0]).split(b"\0") if value)
        return [(os.fsdecode(name), read(getting, [descriptor, name], [0, 0])) for name in names]
    except OSError as error:
        if error.errno in {errno.ENOTSUP, errno.EOPNOTSUPP}:
            return []
        raise CleanupError("changed") from None


def fingerprint_at(parent_fd, name, budget=None):
    """Hash an lstat walk through descriptors; embedded symlinks are recorded only."""
    budget = [MAX_ENTRIES] if budget is None else budget
    digest = hashlib.sha256()

    def attributes(descriptor):
        for attribute, value in xattr_values(descriptor):
            digest.update(encoded([attribute, value.hex()]))

    def visit(directory, entry, relative):
        budget[0] -= 1
        if budget[0] < 0:
            raise CleanupError("inspection_failed")
        if entry.lower().endswith(TEMPORARY_SUFFIXES) or entry in {".fseventsd", ".Spotlight-V100", ".Trashes"}:
            raise CleanupError("unsafe_root")
        before = os.stat(entry, dir_fd=directory, follow_symlinks=False)
        if before.st_uid != os.getuid() or before.st_dev != os.fstat(parent_fd).st_dev:
            raise CleanupError("unsafe_root")
        # Rename changes only the root entry's ctime. Exclude that field while
        # hashing bytes, xattrs, modes, mtime, flags and birthtime so fingerprints
        # remain invariant under our own renames, including crash recovery.
        metadata = [relative, before.st_dev, before.st_ino, before.st_mode, before.st_uid,
                    before.st_gid, before.st_size, before.st_mtime_ns,
                    before.st_ctime_ns if relative else None, getattr(before, "st_flags", 0),
                    getattr(before, "st_birthtime", None)]
        digest.update(encoded(metadata))
        if stat.S_ISLNK(before.st_mode):
            digest.update(os.fsencode(os.readlink(entry, dir_fd=directory)))
        elif stat.S_ISDIR(before.st_mode):
            descriptor = os.open(entry, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
            try:
                if identity(os.fstat(descriptor)) != identity(before):
                    raise CleanupError("changed")
                attributes(descriptor)
                for child in sorted(os.listdir(descriptor)):
                    visit(descriptor, child, relative + "/" + child)
            finally:
                os.close(descriptor)
        elif stat.S_ISREG(before.st_mode):
            descriptor = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
            try:
                if identity(os.fstat(descriptor)) != identity(before):
                    raise CleanupError("changed")
                attributes(descriptor)
                while True:
                    chunk = os.read(descriptor, 1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
            finally:
                os.close(descriptor)
        else:
            raise CleanupError("unsafe_root")
        after = os.stat(entry, dir_fd=directory, follow_symlinks=False)
        if [before.st_ino, before.st_mode, before.st_size, before.st_mtime_ns, before.st_ctime_ns] != [after.st_ino, after.st_mode, after.st_size, after.st_mtime_ns, after.st_ctime_ns]:
            raise CleanupError("changed")
        return before

    info = visit(parent_fd, name, "")
    return {"identity": identity(info), "digest": digest.hexdigest()}


def root_context(descriptor):
    info = os.fstat(descriptor)
    return {"identity": identity(info), "mtime_ns": info.st_mtime_ns, "ctime_ns": info.st_ctime_ns}


def category(name, info):
    extension = Path(name).suffix.lower()
    if extension == ".app" and stat.S_ISDIR(info.st_mode):
        return ("Applications",)
    if stat.S_ISDIR(info.st_mode):
        return ("Folders",)
    if extension in VIDEO:
        return ("Media", "Videos")
    if extension in AUDIO:
        return ("Media", "Audio")
    if extension in PICTURE:
        return ("Media", "Pictures")
    return ("Files",)


@contextmanager
def category_fd(root_fd, parts, created=None):
    if tuple(parts) not in CATEGORIES:
        raise CleanupError("unsafe_state")
    descriptors, current = [], root_fd
    try:
        for index, name in enumerate(parts):
            try:
                descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            except FileNotFoundError:
                if created is None:
                    raise
                os.mkdir(name, 0o700, dir_fd=current)
                created.append(tuple(parts[:index + 1]))
                descriptor = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
            info = os.fstat(descriptor)
            if info.st_uid != os.getuid() or info.st_mode & 0o022 or info.st_dev != os.fstat(root_fd).st_dev:
                os.close(descriptor)
                raise CleanupError("unsafe_root")
            descriptors.append(descriptor)
            current = descriptor
        yield current
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)


def assert_root(root, descriptor, expected):
    if identity(no_links(root).lstat()) != expected or identity(os.fstat(descriptor)) != expected:
        raise CleanupError("changed")


def validate_record(record, kind, identifier):
    def valid_identity(value):
        return isinstance(value, list) and len(value) == 4 and all(isinstance(item, int) and item >= 0 for item in value)

    def valid_fingerprint(value):
        return isinstance(value, dict) and valid_identity(value.get("identity")) and isinstance(value.get("digest"), str) and re.fullmatch(r"[0-9a-f]{64}", value["digest"]) is not None

    try:
        if record["version"] != VERSION or record[kind + "_id"] != identifier or not Path(record["root"]).is_absolute():
            raise CleanupError("unsafe_state")
        if not valid_identity(record["context"]["identity"]):
            raise CleanupError("unsafe_state")
        if not isinstance(record["moves"], list) or len(record["moves"]) > MAX_ENTRIES:
            raise CleanupError("unsafe_state")
        sources, destinations = set(), set()
        for move in record["moves"]:
            if not child_name(move["source"]) or move["source"].startswith(".") or move["source"].lower() in RESERVED:
                raise CleanupError("unsafe_state")
            if not child_name(move["name"]) or tuple(move["category"]) not in CATEGORIES:
                raise CleanupError("unsafe_state")
            if not valid_fingerprint(move["fingerprint"]):
                raise CleanupError("unsafe_state")
            destination = tuple(move["category"]) + (move["name"].casefold(),)
            if move["source"] in sources or destination in destinations:
                raise CleanupError("unsafe_state")
            sources.add(move["source"])
            destinations.add(destination)
        if kind == "receipt" and (not valid_id(record["plan_id"]) or record["state"] not in {"applying", "applied", "undoing", "rolled_back", "recovery_needed", "undone"}):
            raise CleanupError("unsafe_state")
        if set(record["destinations"]) != {"/".join(parts) for parts in CATEGORIES}:
            raise CleanupError("unsafe_state")
        if kind == "receipt":
            if record["plan_id"] != identifier or not isinstance(record["completed"], list):
                raise CleanupError("unsafe_state")
            indices = set()
            for completed in record["completed"]:
                index = completed["index"]
                if not isinstance(index, int) or not 0 <= index < len(record["moves"]) or index in indices or not valid_fingerprint(completed["fingerprint"]):
                    raise CleanupError("unsafe_state")
                indices.add(index)
            for field in ("pending", "undo_pending"):
                index = record.get(field)
                if index is not None and (not isinstance(index, int) or not 0 <= index < len(record["moves"])):
                    raise CleanupError("unsafe_state")
            if not isinstance(record["created_directories"], list) or any(tuple(parts) not in CATEGORIES | {("Media",)} for parts in record["created_directories"]):
                raise CleanupError("unsafe_state")
    except (KeyError, TypeError, ValueError):
        raise CleanupError("unsafe_state") from None


def destination_state(root_fd, parts):
    try:
        with category_fd(root_fd, parts) as descriptor:
            return {"identity": identity(os.fstat(descriptor)), "names": sorted(os.listdir(descriptor))}
    except FileNotFoundError:
        return None


def candidate_busy(path, active):
    return any(path == item or path in item.parents or item in path.parents for item in active)


def root_busy(path, active):
    return any(path == item or item in path.parents for item in active)


def preview(root, *, home=None, ui_busy=None, active_paths=None):
    home = Path.home() if home is None else Path(home)
    with operation(home, ui_busy) as store:
        active = inspect_active_paths() if active_paths is None else active_paths
        root = root_path(root, home)
        if root_busy(root, active):
            raise CleanupError("busy")
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            initial_context = root_context(descriptor)
            destinations = {"/".join(parts): destination_state(descriptor, parts) for parts in sorted(CATEGORIES)}
            used = {key: {name.casefold() for name in (value or {}).get("names", [])} for key, value in destinations.items()}
            moves, skipped = [], []
            for name in sorted(os.listdir(descriptor), key=lambda value: (value.casefold(), value)):
                info = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                reason = None
                if name.startswith(".") or name.lower() in RESERVED:
                    reason = "Hidden/system entry or existing organization folder."
                elif stat.S_ISLNK(info.st_mode):
                    reason = "Symbolic links are kept in place."
                elif name.lower().endswith(TEMPORARY_SUFFIXES):
                    reason = "Temporary, incomplete-transfer, or lock entry."
                elif candidate_busy(root / name, active):
                    reason = "A running application uses this entry."
                if reason:
                    skipped.append({"name": name, "reason": reason})
                    continue
                try:
                    fingerprint = fingerprint_at(descriptor, name)
                except CleanupError as error:
                    if error.code != "unsafe_root":
                        raise
                    skipped.append({"name": name, "reason": "Not an owned regular local file/folder tree, or it contains a special entry."})
                    continue
                parts = category(name, info)
                key = "/".join(parts)
                chosen, number = name, 2
                while chosen.casefold() in used[key]:
                    suffix = Path(name).suffix
                    chosen = (name[:-len(suffix)] if suffix else name) + f" ({number})" + suffix
                    number += 1
                used[key].add(chosen.casefold())
                moves.append({"source": name, "category": list(parts), "name": chosen, "fingerprint": fingerprint})
            if root_context(descriptor) != initial_context:
                raise CleanupError("changed")
            record = {"version": VERSION, "plan_id": uuid.uuid4().hex, "root": str(root),
                      "created_at": time.time(), "context": initial_context, "destinations": destinations,
                      "moves": moves, "skipped": skipped}
            store.write(f"plan-{record['plan_id']}.json", record, exclusive=True)
            return public_reply(record, "preview")
        finally:
            os.close(descriptor)


def public_reply(record, state):
    return {"state": state, "plan_id": record["plan_id"], "receipt_id": record.get("receipt_id"),
            "root": record["root"], "planned_count": len(record["moves"]),
            "moves": [{"source": move["source"], "destination": "/".join([*move["category"], move["name"]])} for move in record["moves"]],
            "skipped": record.get("skipped", [])}


def cleanup_created(root_fd, created):
    for parts in reversed(created):
        parent = root_fd
        descriptor = None
        try:
            if len(parts) == 2:
                descriptor = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
                parent = descriptor
            os.rmdir(parts[-1], dir_fd=parent)
        except OSError:
            pass  # Never delete contents or remove a folder that acquired data.
        finally:
            if descriptor is not None:
                os.close(descriptor)


def apply(plan_id, *, home=None, ui_busy=None, active_paths=None):
    home = Path.home() if home is None else Path(home)
    with operation(home, ui_busy) as store:
        active = inspect_active_paths() if active_paths is None else active_paths
        plan = store.read("plan", plan_id)
        receipt_id = plan_id  # one immutable plan can be applied at most once
        receipt_name = f"receipt-{receipt_id}.json"
        if store.exists(receipt_name):
            raise CleanupError("already_used")
        root = root_path(plan["root"], home)
        if root_busy(root, active) or any(candidate_busy(root / move["source"], active) for move in plan["moves"]):
            raise CleanupError("busy")
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        created, completed = [], []
        pending_moved = False
        receipt = {**plan, "receipt_id": receipt_id, "state": "applying", "completed": [], "pending": None, "created_directories": created}
        try:
            assert_root(root, descriptor, plan["context"]["identity"])
            if root_context(descriptor) != plan["context"]:
                raise CleanupError("changed")
            for key, expected in plan["destinations"].items():
                if destination_state(descriptor, key.split("/")) != expected:
                    raise CleanupError("changed")
            for move in plan["moves"]:
                if fingerprint_at(descriptor, move["source"]) != move["fingerprint"]:
                    raise CleanupError("changed")
            store.write(receipt_name, receipt, exclusive=True)
            try:
                for index, move in enumerate(plan["moves"]):
                    assert_root(root, descriptor, plan["context"]["identity"])
                    if fingerprint_at(descriptor, move["source"]) != move["fingerprint"]:
                        raise CleanupError("changed")
                    with category_fd(descriptor, move["category"], created) as destination:
                        receipt["pending"] = index
                        store.write(receipt_name, receipt)
                        rename_exclusive(descriptor, move["source"], destination, move["name"])
                        pending_moved = True
                        moved = {"index": index, "fingerprint": fingerprint_at(destination, move["name"])}
                        completed.append(moved)
                        pending_moved = False
                        receipt["completed"] = completed.copy()
                        receipt["pending"] = None
                        store.write(receipt_name, receipt)
                        if moved["fingerprint"] != move["fingerprint"]:
                            raise CleanupError("changed")
                receipt["state"] = "applied"
                store.write(receipt_name, receipt)
                return public_reply(receipt, "applied")
            except BaseException:
                # Reverse only destinations that still match our post-move
                # fingerprint. New/conflicting content is never overwritten.
                recovered = not pending_moved
                if not pending_moved:
                    receipt["pending"] = None
                for moved in reversed(completed):
                    move = plan["moves"][moved["index"]]
                    try:
                        with category_fd(descriptor, move["category"]) as destination:
                            if fingerprint_at(destination, move["name"]) != moved["fingerprint"]:
                                raise CleanupError("changed")
                            rename_exclusive(destination, move["name"], descriptor, move["source"])
                    except BaseException:
                        recovered = False
                cleanup_created(descriptor, created)
                receipt["state"] = "rolled_back" if recovered else "recovery_needed"
                try:
                    store.write(receipt_name, receipt)
                except BaseException:
                    recovered = False
                raise CleanupError("rolled_back" if recovered else "recovery_needed", receipt_id) from None
        except OSError:
            raise CleanupError("changed", receipt_id if store.exists(receipt_name) else None) from None
        finally:
            os.close(descriptor)


def maybe_fingerprint(parent, name):
    try:
        return fingerprint_at(parent, name)
    except FileNotFoundError:
        return None


def destination_fingerprint(root_fd, move):
    try:
        with category_fd(root_fd, move["category"]) as destination:
            return maybe_fingerprint(destination, move["name"])
    except FileNotFoundError:
        return None


def undo(receipt_id, *, home=None, ui_busy=None, active_paths=None):
    home = Path.home() if home is None else Path(home)
    with operation(home, ui_busy) as store:
        active = inspect_active_paths() if active_paths is None else active_paths
        receipt = store.read("receipt", receipt_id)
        if receipt["state"] not in {"applied", "applying", "undoing", "recovery_needed"}:
            raise CleanupError("already_used")
        root = root_path(receipt["root"], home)
        if root_busy(root, active) or any(candidate_busy(root.joinpath(*move["category"], move["name"]), active) for move in receipt["moves"]):
            raise CleanupError("busy")
        descriptor = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        restored = []
        try:
            assert_root(root, descriptor, receipt["context"]["identity"])
            completed = {item["index"]: item["fingerprint"] for item in receipt["completed"]}
            pending = receipt.get("pending")
            recovering = receipt["state"] in {"applying", "undoing", "recovery_needed"}
            # A durable intent precedes each apply rename. A move-invariant
            # fingerprint can recover it only if exactly one unchanged entry is
            # present at its approved source or destination, never by guessing.
            if pending is not None:
                move = receipt["moves"][pending]
                source = maybe_fingerprint(descriptor, move["source"])
                destination = destination_fingerprint(descriptor, move)
                if source is None and destination == move["fingerprint"]:
                    completed[pending] = destination
                elif source != move["fingerprint"] or destination is not None:
                    raise CleanupError("recovery_needed", receipt_id)
                receipt["pending"] = None
                receipt["completed"] = [{"index": index, "fingerprint": value} for index, value in sorted(completed.items())]
            moves = []
            for index, expected in sorted(completed.items()):
                move = receipt["moves"][index]
                source = maybe_fingerprint(descriptor, move["source"])
                destination = destination_fingerprint(descriptor, move)
                if source is not None:
                    if recovering and source == expected and destination is None:
                        continue  # a recorded/interrupted undo or rollback
                    raise CleanupError("changed")
                if destination != expected:
                    raise CleanupError("changed")
                moves.append((index, move, expected))
            receipt["state"] = "undoing"
            receipt["undo_pending"] = None
            store.write(f"receipt-{receipt_id}.json", receipt)
            try:
                for index, move, expected in reversed(moves):
                    assert_root(root, descriptor, receipt["context"]["identity"])
                    with category_fd(descriptor, move["category"]) as destination:
                        if fingerprint_at(destination, move["name"]) != expected:
                            raise CleanupError("changed")
                        receipt["undo_pending"] = index
                        store.write(f"receipt-{receipt_id}.json", receipt)
                        rename_exclusive(destination, move["name"], descriptor, move["source"])
                    actual = fingerprint_at(descriptor, move["source"])
                    restored.append((move, actual))
                    if actual != expected:
                        raise CleanupError("changed")
                    receipt["undo_pending"] = None
                    store.write(f"receipt-{receipt_id}.json", receipt)
                receipt["state"] = "undone"
                store.write(f"receipt-{receipt_id}.json", receipt)
                cleanup_created(descriptor, receipt.get("created_directories", []))
                return public_reply(receipt, "undone")
            except BaseException:
                # Keep data safe even when an Undo itself is interrupted by a
                # conflict: move verified items forward again, never overwrite.
                for move, expected in reversed(restored):
                    try:
                        if fingerprint_at(descriptor, move["source"]) != expected:
                            raise CleanupError("changed")
                        with category_fd(descriptor, move["category"]) as destination:
                            rename_exclusive(descriptor, move["source"], destination, move["name"])
                    except BaseException:
                        pass
                receipt["state"] = "recovery_needed"
                store.write(f"receipt-{receipt_id}.json", receipt)
                raise CleanupError("recovery_needed", receipt_id) from None
        except OSError:
            raise CleanupError("changed", receipt_id) from None
        finally:
            os.close(descriptor)


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("preview", "apply", "undo"):
        child = commands.add_parser(command)
        child.add_argument("--ui-busy", choices=("true", "false"), required=True)
        child.add_argument({"preview": "--root", "apply": "--plan", "undo": "--receipt"}[command], required=True)
    args = parser.parse_args(arguments)
    try:
        if platform.system() != "Darwin":
            raise CleanupError("unsupported")
        if args.command == "preview":
            reply = preview(args.root, ui_busy=args.ui_busy == "true")
        elif args.command == "apply":
            reply = apply(args.plan, ui_busy=args.ui_busy == "true")
        else:
            reply = undo(args.receipt, ui_busy=args.ui_busy == "true")
        print(json.dumps(reply, ensure_ascii=True))
        return 0
    except Exception as error:
        code = error.code if isinstance(error, CleanupError) else "unexpected"
        print(json.dumps({"state": "failed", "error": code, "message": MESSAGES[code],
                          "receipt_id": getattr(error, "receipt_id", None)}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
