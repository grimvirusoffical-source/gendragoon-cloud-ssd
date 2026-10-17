#!/usr/bin/env python3
"""Windows/Linux companion using the same /v3/cloud API as native macOS/mobile.

Portable application packages are fully restored and verified into managed cache.
Startup-file warming is bounded; ZIP staging is not sparse/streamed execution.
No credential, uploaded program or cloud manifest can select a cleanup directory.
"""
from __future__ import annotations
import argparse
import base64
import concurrent.futures
import contextlib
import ctypes
import getpass
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

ORIGIN = "https://gendragoon-free-10068843866.us-central1.run.app"
CHUNK = 8 * 1024 * 1024
MANIFEST = "_gendragoon/manifest.json"
MAX_ENTRIES = 100_000
MAX_MANIFEST = 32 * 1024 * 1024
MAX_EXPANDED = 2 * 1024**4
RESERVE = 512 * 1024**2
APP_EXTENSIONS = (".app", ".app.zip", ".dmg", ".pkg", ".exe", ".msi", ".msix", ".appimage", ".deb", ".rpm", ".apk", ".aab", ".ipa", ".gdapp.zip")


def emit(**value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def digest(file: Path) -> str:
    h = hashlib.sha256()
    with file.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def safe_path(value: str) -> str:
    """One portable, unambiguous relative path on both Windows and Unix."""
    if not isinstance(value, str) or not value or len(value) > 4096 or value.startswith("/") or any(c in value for c in "\\:\0"):
        raise ValueError("Unsafe package path")
    for part in value.split("/"):
        if part in ("", ".", "..") or part.endswith((" ", ".")) or re.search(r'[<>"|?*\x00-\x1f]', part):
            raise ValueError("Unsafe package path")
        if part.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *["COM"+str(i) for i in range(1, 10)], *["LPT"+str(i) for i in range(1, 10)]}:
            raise ValueError("Unsupported reserved Windows name")
    return value


def canonical_id(value: str) -> str:
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError("Invalid cloud item ID")
    return value


def workspace_route(workspace: str) -> str:
    if workspace != "free":
        canonical_id(workspace)
    return "/v3/cloud/" + workspace


def native_platform() -> tuple[str, str]:
    system = {"Windows": "windows", "Linux": "linux"}.get(platform.system())
    architecture = {"x86_64": "x86_64", "AMD64": "x86_64", "aarch64": "arm64", "arm64": "arm64"}.get(platform.machine())
    if not system or not architecture:
        raise ValueError("This companion supports native Windows/Linux x86_64 and arm64. Use the macOS app on a Mac.")
    return system, architecture


def executable_platform(file: Path) -> tuple[str, str]:
    """Do not interpret scripts, shell associations, installers or foreign binaries."""
    with file.open("rb") as stream:
        head = stream.read(64)
        if head.startswith(b"\x7fELF") and len(head) >= 20 and head[4] == 2 and head[5] in (1, 2):
            machine = struct.unpack("<H" if head[5] == 1 else ">H", head[18:20])[0]
            architecture = {62: "x86_64", 183: "arm64"}.get(machine)
            if architecture:
                return "linux", architecture
        if head.startswith(b"MZ") and len(head) == 64:
            offset = struct.unpack("<I", head[60:64])[0]
            if offset < 64 or offset > min(file.stat().st_size-24, 4 * 1024 * 1024):
                raise ValueError("Invalid executable header")
            stream.seek(offset)
            pe = stream.read(24)
            architecture = {0x8664: "x86_64", 0xAA64: "arm64"}.get(struct.unpack("<H", pe[4:6])[0]) if pe[:4] == b"PE\0\0" else None
            if architecture and not (struct.unpack("<H", pe[22:24])[0] & 0x2000):
                return "windows", architecture
    raise ValueError("Only native 64-bit portable ELF or PE application binaries can be launched. Store other packages as files.")


def snapshot(source: Path) -> dict:
    source = source.absolute()
    if source.is_symlink() or not source.exists():
        raise ValueError("Choose an existing real file or folder")
    entries = {}
    folded = set()
    pending = [source]
    while pending:
        item = pending.pop()
        info = item.lstat()
        if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)) or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("Symbolic links, junctions and special files must be archived on their original platform first")
        name = safe_path(item.relative_to(source.parent).as_posix())
        folded_name = __import__("unicodedata").normalize("NFC", name).casefold()
        if folded_name in folded or len(entries) >= MAX_ENTRIES:
            raise ValueError("Duplicate portable paths or too many files")
        folded.add(folded_name)
        directory = stat.S_ISDIR(info.st_mode)
        entries[name] = {"type": "directory" if directory else "file", "size": 0 if directory else info.st_size,
                         "sha256": "" if directory else digest(item), "executable": bool(info.st_mode & 0o111)}
        if directory:
            pending.extend(sorted(item.iterdir(), reverse=True))
    return entries


def make_package(source: Path, archive: Path, application: str | None = None) -> dict:
    """application is an entry point relative to the selected folder, chosen locally."""
    source = source.absolute()
    entries = snapshot(source)
    package = {"schema": 1, "name": source.name, "kind": "folder" if source.is_dir() else "file", "entries": entries}
    if application is not None:
        relative = safe_path(source.name + ("/" + safe_path(application) if source.is_dir() else ""))
        if relative not in entries or entries[relative]["type"] != "file":
            raise ValueError("Select a native executable within this application's folder")
        system, arch = executable_platform(source.parent / relative)
        package.update(kind="app", entrypoint=relative, platform=system, architecture=arch, portable=True)
    size = sum(x["size"] for x in entries.values())
    if size > MAX_EXPANDED or shutil.disk_usage(archive.parent).free < size + RESERVE:
        raise ValueError("Insufficient local staging space or package too large")
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_STORED, allowZip64=True) as output:
        for name, record in sorted(entries.items()):
            output.write(source.parent / name, name + ("/" if record["type"] == "directory" else ""))
        output.writestr(MANIFEST, json.dumps(package, separators=(",", ":")))
    if snapshot(source) != entries:
        archive.unlink(missing_ok=True)
        raise ValueError("The original changed while packaging it; it was retained")
    return package


def inspect_package(archive: Path, max_bytes=MAX_EXPANDED) -> dict:
    with zipfile.ZipFile(archive) as z:
        metadata = z.getinfo(MANIFEST)
        if metadata.file_size > MAX_MANIFEST:
            raise ValueError("Package manifest too large")
        package = json.loads(z.read(metadata))
        entries = package.get("entries")
        if package.get("schema") != 1 or package.get("kind") not in ("file", "folder", "app") or not isinstance(entries, dict) or not (1 <= len(entries) <= MAX_ENTRIES):
            raise ValueError("Invalid GenDragoon package manifest")
        safe_path(package["name"])
        if "/" in package["name"] or package["name"] not in entries or package["name"] in ("_gendragoon", ".gendragoon-entry", ".lease"):
            raise ValueError("Invalid package root")
        names, folded, total = set(), set(), 0
        for member in z.infolist():
            name = safe_path(member.filename.rstrip("/"))
            folded_name = __import__("unicodedata").normalize("NFC", name).casefold()
            if name in names or folded_name in folded:
                raise ValueError("Duplicate package entry")
            names.add(name); folded.add(folded_name)
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)) or member.flag_bits & 1:
                raise ValueError("Package contains a link, special file or encrypted entry")
            if member.filename == MANIFEST:
                continue
            record = entries.get(name)
            if not isinstance(record, dict) or record.get("type") not in ("file", "directory") or not isinstance(record.get("size"), int) or record["size"] < 0:
                raise ValueError("Invalid package entry metadata")
            if (name != package["name"] and not name.startswith(package["name"] + "/")) or record["size"] != member.file_size or member.is_dir() != (record["type"] == "directory"):
                raise ValueError("Package entry does not match its manifest")
            if record["type"] == "file" and not re.fullmatch(r"[0-9a-f]{64}", record.get("sha256", "")):
                raise ValueError("Missing file integrity digest")
            total += member.file_size
            if total > max_bytes or member.file_size > max(1, member.compress_size) * 1000:
                raise ValueError("Archive exceeds safe expanded-size or compression limits")
        if names != set(entries) | {MANIFEST}:
            raise ValueError("Missing or unexpected archive entries")
        ordered = sorted(entries)
        for index, name in enumerate(ordered[:-1]):
            if entries[name]["type"] == "file" and ordered[index+1].startswith(name+"/"):
                raise ValueError("A package file cannot also be a folder")
        if package["kind"] == "app":
            entry = safe_path(package.get("entrypoint", ""))
            if package.get("portable") is not True or entries.get(entry, {}).get("type") != "file" or package.get("platform") not in ("windows", "linux") or package.get("architecture") not in ("x86_64", "arm64"):
                raise ValueError("Invalid portable application metadata")
        return package


def extract_package(archive: Path, destination: Path, max_bytes=MAX_EXPANDED) -> dict:
    package = inspect_package(archive, max_bytes)
    if destination.exists() or destination.is_symlink():
        raise ValueError("Restore must use a new managed directory")
    size = sum(x["size"] for x in package["entries"].values())
    if shutil.disk_usage(destination.parent).free < size + RESERVE:
        raise ValueError("Insufficient local space for verified restore")
    destination.mkdir(mode=0o700)
    try:
        with zipfile.ZipFile(archive) as z:
            for name, record in sorted(package["entries"].items()):
                target = destination / name
                if record["type"] == "directory":
                    target.mkdir(parents=True, exist_ok=True, mode=0o700)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    h = hashlib.sha256(); written = 0
                    with z.open(name) as source, target.open("xb") as out:
                        for block in iter(lambda: source.read(1024 * 1024), b""):
                            written += len(block)
                            if written > record["size"]:
                                raise ValueError("Unexpected expanded file size")
                            h.update(block); out.write(block)
                        out.flush(); os.fsync(out.fileno())
                    if written != record["size"] or h.hexdigest() != record["sha256"]:
                        raise ValueError("Restored package failed SHA-256 verification")
                    target.chmod(0o700 if record.get("executable") else 0o600)
        return package
    except BaseException:
        shutil.rmtree(destination)
        raise


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Cloud redirects are not allowed for authenticated requests")


class CloudClient:
    def __init__(self, token: str):
        if not token or any(x in token for x in "\r\n"):
            raise ValueError("A signed-in session or scoped account API key is required")
        self.token = token
        self.transport = urllib.request.build_opener(NoRedirect())

    def request(self, path: str, method="GET", body=None, headers=None):
        if not path.startswith(("/v3/cloud/", "/v2/workspaces")) or "#" in path:
            raise ValueError("Unsupported cloud API route")
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            headers = {"Content-Type": "application/json", **(headers or {})}
        req = urllib.request.Request(ORIGIN+path, data=body, method=method,
            headers={"Authorization": "Bearer "+self.token, "Accept-Encoding": "identity", **(headers or {})})
        for attempt in range(5):
            try:
                with self.transport.open(req, timeout=90) as response:
                    value = response.read(CHUNK+MAX_MANIFEST+1)
                    if len(value) > CHUNK+MAX_MANIFEST:
                        raise ValueError("Cloud response exceeds the bounded buffer")
                    return response.status, response.headers, value
            except urllib.error.HTTPError as error:
                if error.code not in (408, 429, 500, 502, 503, 504) or attempt == 4:
                    raise ValueError(f"Cloud request failed (HTTP {error.code}); no originals were removed") from None
                time.sleep(min(4, 0.25*2**attempt))
        raise ValueError("Cloud request failed")

    def json(self, path, method="GET", body=None):
        return json.loads(self.request(path, method, body)[2])

    def files(self, workspace):
        result, cursor, seen = [], None, set()
        while True:
            page = self.json(workspace_route(workspace)+"/files" + ("?cursor="+canonical_id(cursor) if cursor else ""))
            result.extend(page["files"])
            cursor = page.get("nextCursor")
            if not cursor:
                return result
            if cursor in seen:
                raise ValueError("Invalid repeating cloud pagination cursor")
            seen.add(cursor)

    def upload(self, source: Path, workspace: str, checkpoint: Path):
        route = workspace_route(workspace); config = self.json(route+"/config")
        size = source.stat().st_size
        if config["transfer"]["chunkBytes"] != CHUNK or not 0 < size <= config["maxFileBytes"]:
            raise ValueError("File exceeds workspace limit or server transfer profile is invalid")
        original_hash = digest(source)
        request_id = str(uuid.uuid4())
        if checkpoint.exists():
            saved = json.loads(checkpoint.read_text())
            if saved.get("sha256") == original_hash and saved.get("workspace") == workspace:
                request_id = canonical_id(saved["id"])
        atomic_json(checkpoint, {"id": request_id, "sha256": original_hash, "workspace": workspace})
        job = self.json(route+"/uploads", "POST", {"requestId": request_id, "name": source.name, "sizeBytes": size})
        if job["uploadId"] != request_id or job["sizeBytes"] != size or job["chunkBytes"] != CHUNK or job["totalChunks"] != (size+CHUNK-1)//CHUNK:
            raise ValueError("Invalid cloud upload session")
        if job["status"] not in ("active", "assembling", "completed"):
            checkpoint.unlink(missing_ok=True)
            raise ValueError("Upload expired; choose the same file to start again")
        if job["status"] == "active":
            with source.open("rb") as stream:
                for index in range(job["totalChunks"]):
                    stream.seek(index*CHUNK)
                    data = stream.read(min(CHUNK, size-index*CHUNK))
                    if any(a <= index <= b for a, b in job["receivedRanges"]):
                        continue
                    if not data:
                        raise ValueError("Source changed during upload")
                    self.request(route+f"/uploads/{request_id}/chunks/{index}", "PUT", data,
                        {"Content-Type": "application/octet-stream", "X-Chunk-SHA256": hashlib.sha256(data).hexdigest()})
                    emit(phase="Uploading", completed=min(size, (index+1)*CHUNK), total=size)
        if digest(source) != original_hash:
            raise ValueError("Source changed during upload; original retained")
        deadline = time.monotonic()+1800
        if job["status"] != "completed":
            while time.monotonic() < deadline:
                code, _, _ = self.request(route+f"/uploads/{request_id}/finalize", "POST", {})
                if code == 200:
                    break
                if code != 202:
                    raise ValueError("Unexpected upload verification response")
                time.sleep(1)
            else:
                raise TimeoutError("Cloud assembly did not finish; original retained")
        checkpoint.unlink(missing_ok=True)
        return {"id": request_id, "name": source.name, "sizeBytes": size, "sha256": original_hash}

    def download(self, item: dict, workspace: str, destination: Path):
        route = workspace_route(workspace)+"/files/"+canonical_id(item["id"])+"/download"
        size = item["sizeBytes"]
        if not isinstance(size, int) or not 0 < size <= MAX_EXPANDED:
            raise ValueError("Invalid cloud file size")
        code, headers, _ = self.request(route, "HEAD")
        etag = headers.get("ETag")
        if code != 200 or not etag or headers.get("Content-Length") != str(size):
            raise ValueError("Cloud file changed; refresh the library")
        if destination.exists() or shutil.disk_usage(destination.parent).free < size+RESERVE:
            raise ValueError("Choose an unused destination with sufficient disk space")
        try:
            with destination.open("xb") as output:
                h = hashlib.sha256(); crc = 0xffffffff
                for first in range(0, size, CHUNK):
                    last = min(size-1, first+CHUNK-1)
                    code, response, data = self.request(route, headers={"Range": f"bytes={first}-{last}", "If-Match": etag})
                    if code != 206 or response.get("ETag") != etag or response.get("Content-Range") != f"bytes {first}-{last}/{size}" or len(data) != last-first+1:
                        raise ValueError("Cloud range verification failed")
                    h.update(data); output.write(data)
                    if item.get("crc32c"):
                        crc = crc32c(data, crc)
                output.flush(); os.fsync(output.fileno())
            if item.get("sha256") and h.hexdigest() != item["sha256"]:
                raise ValueError("Cloud read-back failed SHA-256 verification")
            if item.get("crc32c") and base64.b64encode(struct.pack(">I", crc^0xffffffff)).decode() != item["crc32c"]:
                raise ValueError("Cloud restore failed CRC32C verification")
        except BaseException:
            destination.unlink(missing_ok=True)
            raise
        return destination


def _crc_table():
    values = []
    for byte in range(256):
        value = byte
        for _ in range(8):
            value = (value >> 1) ^ (0x82f63b78 if value & 1 else 0)
        values.append(value)
    return values


CRC_TABLE = _crc_table()


def crc32c(data, seed=0xffffffff):
    for byte in data:
        seed = CRC_TABLE[(seed ^ byte) & 255] ^ (seed >> 8)
    return seed


def atomic_json(destination: Path, data: dict):
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=destination.parent, delete=False, prefix=".gd-") as temporary:
        json.dump(data, temporary); temporary.flush(); os.fsync(temporary.fileno())
        path = Path(temporary.name)
    path.chmod(0o600); os.replace(path, destination)


def default_cache():
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA", str(Path.home()/"AppData/Local")))/"GenDragoon/ManagedCache"
    return Path(os.environ.get("XDG_CACHE_HOME", str(Path.home()/".cache")))/"gendragoon/managed"


class ManagedCache:
    def __init__(self, root=None):
        self.root = Path(root or default_cache()).absolute()
        if self.root.is_symlink() or any(x.is_symlink() for x in self.root.parents):
            raise ValueError("Managed cache path must not traverse a symbolic link")
        marker = self.root/".gendragoon-cache-root"
        if self.root.exists() and not marker.is_file() and any(self.root.iterdir()):
            raise ValueError("Refusing to use an existing unrelated directory as cache")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if hasattr(os, "getuid") and self.root.stat().st_uid != os.getuid():
            raise ValueError("Managed cache belongs to a different user")
        if not marker.exists():
            atomic_json(marker, {"schema": 1})
        if marker.is_symlink() or json.loads(marker.read_text()).get("schema") != 1:
            raise ValueError("Invalid managed cache root")
        self.root.chmod(0o700)

    def entry(self, key):
        path = self.root/canonical_id(key)
        if path.is_symlink() or (path.exists() and not path.is_dir()):
            raise ValueError("Unsafe managed cache entry")
        return path

    def stage(self, archive, key, workspace):
        destination = self.entry(key)
        if destination.exists():
            raise ValueError("A cache already exists for this item. Evict it before replacing it.")
        with tempfile.TemporaryDirectory(prefix=".stage-", dir=self.root) as temporary:
            package = extract_package(archive, Path(temporary)/"payload")
            atomic_json(Path(temporary)/"payload/.gendragoon-entry", {"schema": 1, "fileId": key, "workspace": workspace, "package": package})
            os.replace(Path(temporary)/"payload", destination)
        return destination

    def metadata(self, key):
        destination = self.entry(key)
        path = destination/".gendragoon-entry"
        if path.is_symlink() or not path.is_file():
            raise ValueError("Cache is missing its ownership metadata")
        data = json.loads(path.read_text())
        if data.get("fileId") != key or data.get("schema") != 1:
            raise ValueError("Invalid managed cache metadata")
        return data

    def verify(self, key):
        metadata = self.metadata(key)
        package = metadata["package"]
        actual = snapshot(self.entry(key)/safe_path(package["name"]))
        if actual != package["entries"]:
            raise ValueError("The managed application changed. Restore a fresh verified cloud copy before launching.")
        return package

    def evict(self, key):
        path = self.entry(key)
        if not path.exists():
            return False
        self.metadata(key)
        if (path/".lease").exists() or running_from(path):
            raise ValueError("This cache is in use, or an interrupted launch needs inspection. No cache files removed.")
        shutil.rmtree(path)
        return True

    def launch(self, key, cleanup=True):
        package = self.verify(key)
        path = self.entry(key)
        if package.get("kind") != "app" or (package.get("platform"), package.get("architecture")) != native_platform():
            raise ValueError("This package is not a compatible native portable application")
        executable = path/safe_path(package["entrypoint"])
        if executable_platform(executable) != native_platform():
            raise ValueError("Executable platform differs from package metadata")
        lease = path/".lease"
        descriptor = os.open(lease, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w") as handle:
            json.dump({"pid": os.getpid(), "created": time.time()}, handle)
        completed = False
        try:
            executable.chmod(executable.stat().st_mode | 0o100)
            warmed = preload(executable)
            emit(phase="Launching verified local cache", bytesWarmed=warmed, localPath=str(executable))
            if sys.platform == "win32":
                exitcode = windows_run(executable)
            else:
                child = subprocess.Popen([str(executable)], cwd=executable.parent, stdin=subprocess.DEVNULL, start_new_session=True)
                exitcode = child.wait()
                # A portable app may keep helpers after its initial process exits.
                while process_group_alive(child.pid) or running_from(path):
                    time.sleep(0.2)
            completed = True
        finally:
            # An interrupted monitor deliberately retains the lease and cache.
            if completed:
                lease.unlink()
        if cleanup:
            self.evict(key)
        return {"exitCode": exitcode, "cacheRemoved": cleanup, "cloudRetained": True}


def preload(executable: Path, budget=16*1024*1024, seconds=2.0):
    budget = max(0, min(budget, 64*1024*1024)); deadline = time.monotonic()+max(0, min(seconds, 5.0)); read = 0
    with executable.open("rb") as stream:
        while read < budget and time.monotonic() < deadline:
            block = stream.read(min(1024*1024, budget-read))
            if not block:
                break
            read += len(block)
    return read


def process_group_alive(group):
    # Exclude already-exited zombie processes, which cannot use the cached app.
    if sys.platform.startswith("linux"):
        for record in Path("/proc").glob("[0-9]*/stat"):
            try:
                fields = record.read_text().rsplit(") ", 1)[1].split()
                if fields[0] != "Z" and int(fields[2]) == group:
                    return True
            except (FileNotFoundError, PermissionError, ValueError, IndexError):
                pass
        return False
    return False


def running_from(path):
    if sys.platform.startswith("linux"):
        for record in Path("/proc").glob("[0-9]*/exe"):
            try:
                if Path(os.readlink(record)).is_relative_to(path):
                    return True
            except (FileNotFoundError, PermissionError, OSError):
                pass
    elif sys.platform == "win32":
        # Handle Windows process paths through the system CIM provider, without executing filenames as code.
        script = "Get-CimInstance Win32_Process | Select-Object -ExpandProperty ExecutablePath | ConvertTo-Json -Compress"
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script], capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise ValueError("Could not verify running Windows applications; cache retained")
        try:
            values = json.loads(result.stdout or "[]")
            if isinstance(values, str): values = [values]
            return any(Path(value).is_relative_to(path) for value in values if value)
        except (ValueError, TypeError):
            raise ValueError("Could not verify Windows process state; cache retained") from None
    return False


def windows_run(executable):
    """Track the complete application process tree with a Windows Job Object.

    Child creation is suspended until it belongs to the job. Breakaway is not
    permitted. No kill-on-close flag is used: monitor failure retains the cache.
    """
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    class STARTUPINFO(ctypes.Structure):
        _fields_ = [("cb", w.DWORD), ("reserved", w.LPWSTR), ("desktop", w.LPWSTR), ("title", w.LPWSTR),
                    ("x", w.DWORD), ("y", w.DWORD), ("xSize", w.DWORD), ("ySize", w.DWORD), ("xChars", w.DWORD), ("yChars", w.DWORD),
                    ("fill", w.DWORD), ("flags", w.DWORD), ("show", w.WORD), ("reserved2", w.WORD), ("reservedBytes", ctypes.POINTER(ctypes.c_byte)),
                    ("stdin", w.HANDLE), ("stdout", w.HANDLE), ("stderr", w.HANDLE)]
    class PROCESSINFO(ctypes.Structure):
        _fields_ = [("process", w.HANDLE), ("thread", w.HANDLE), ("pid", w.DWORD), ("tid", w.DWORD)]
    class ACCOUNTING(ctypes.Structure):
        _fields_ = [("user", ctypes.c_longlong), ("kernel", ctypes.c_longlong), ("periodUser", ctypes.c_longlong), ("periodKernel", ctypes.c_longlong),
                    ("faults", w.DWORD), ("total", w.DWORD), ("active", w.DWORD), ("terminated", w.DWORD)]
    kernel.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]; kernel.CreateJobObjectW.restype = w.HANDLE
    kernel.CreateProcessW.argtypes = [w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD, ctypes.c_void_p, w.LPCWSTR, ctypes.POINTER(STARTUPINFO), ctypes.POINTER(PROCESSINFO)]
    kernel.CreateProcessW.restype = w.BOOL
    kernel.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]; kernel.AssignProcessToJobObject.restype = w.BOOL
    kernel.ResumeThread.argtypes = [w.HANDLE]; kernel.ResumeThread.restype = w.DWORD
    kernel.QueryInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.c_void_p]; kernel.QueryInformationJobObject.restype = w.BOOL
    kernel.TerminateProcess.argtypes = [w.HANDLE, w.UINT]; kernel.TerminateProcess.restype = w.BOOL
    kernel.GetExitCodeProcess.argtypes = [w.HANDLE, ctypes.POINTER(w.DWORD)]; kernel.GetExitCodeProcess.restype = w.BOOL
    kernel.CloseHandle.argtypes = [w.HANDLE]; kernel.CloseHandle.restype = w.BOOL
    job = kernel.CreateJobObjectW(None, None)
    if not job: raise ctypes.WinError(ctypes.get_last_error())
    si = STARTUPINFO(); si.cb = ctypes.sizeof(si); pi = PROCESSINFO(); assigned = False
    try:
        command = ctypes.create_unicode_buffer(subprocess.list2cmdline([str(executable)]))
        if not kernel.CreateProcessW(str(executable), command, None, None, False, 0x00000004, None, str(executable.parent), ctypes.byref(si), ctypes.byref(pi)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.AssignProcessToJobObject(job, pi.process):
            # This new process is still suspended and has never executed user code.
            kernel.TerminateProcess(pi.process, 1)
            raise ctypes.WinError(ctypes.get_last_error())
        assigned = True
        if kernel.ResumeThread(pi.thread) == 0xffffffff:
            raise ctypes.WinError(ctypes.get_last_error())
        while True:
            accounting = ACCOUNTING()
            if not kernel.QueryInformationJobObject(job, 1, ctypes.byref(accounting), ctypes.sizeof(accounting), None):
                raise ctypes.WinError(ctypes.get_last_error())
            if not accounting.active: break
            time.sleep(0.2)
        code = w.DWORD()
        if not kernel.GetExitCodeProcess(pi.process, ctypes.byref(code)):
            raise ctypes.WinError(ctypes.get_last_error())
        return code.value
    finally:
        for handle in (pi.thread, pi.process, job):
            if handle: kernel.CloseHandle(handle)


def recycle_original(source: Path, expected: dict):
    source = source.absolute()
    if source == Path.home() or len(source.parts) < 3 or source.name.lower().startswith("gendragoon") or source.is_relative_to(default_cache()):
        raise ValueError("Original is protected; it was retained")
    if snapshot(source) != expected:
        raise ValueError("Original changed after upload; it was retained")
    if sys.platform == "win32":
        from ctypes import wintypes as w
        class OP(ctypes.Structure):
            _fields_ = [("hwnd", w.HWND), ("operation", w.UINT), ("source", w.LPCWSTR), ("destination", w.LPCWSTR),
                        ("flags", w.WORD), ("aborted", w.BOOL), ("mapping", ctypes.c_void_p), ("title", w.LPCWSTR)]
        value = ctypes.create_unicode_buffer(str(source)+"\0")
        operation = OP(None, 3, ctypes.cast(value, w.LPCWSTR), None, 0x40 | 0x10, False, None, None)
        shell = ctypes.WinDLL("shell32", use_last_error=True)
        shell.SHFileOperationW.argtypes = [ctypes.POINTER(OP)]; shell.SHFileOperationW.restype = ctypes.c_int
        if shell.SHFileOperationW(ctypes.byref(operation)) or operation.aborted or source.exists():
            raise ValueError("Recycle Bin did not accept the original; it was retained")
    else:
        data = Path(os.environ.get("XDG_DATA_HOME", str(Path.home()/".local/share")))
        trash = data/"Trash"
        for part in (trash, trash/"files", trash/"info"):
            if part.is_symlink(): raise ValueError("Unsafe Trash directory; original retained")
            part.mkdir(parents=True, exist_ok=True, mode=0o700)
        if source.stat().st_dev != (trash/"files").stat().st_dev:
            raise ValueError("The original is on another filesystem. Move it to Trash using the system file manager after verification.")
        name = str(uuid.uuid4())+"-"+source.name
        record = trash/"info"/(name+".trashinfo")
        with record.open("x") as stream:
            stream.write("[Trash Info]\nPath="+urllib.parse.quote(str(source), safe="/")+"\nDeletionDate="+time.strftime("%Y-%m-%dT%H:%M:%S")+"\n")
        try: os.rename(source, trash/"files"/name)
        except BaseException:
            record.unlink(); raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["workspaces", "list", "upload", "restore", "launch", "evict", "capabilities"])
    parser.add_argument("--workspace", default="free")
    parser.add_argument("--source", type=Path)
    parser.add_argument("--application-entrypoint", help="Relative native entrypoint inside a portable application folder; no installers")
    parser.add_argument("--file-id")
    parser.add_argument("--destination", type=Path, help="Destination for a plain cloud-file restore; an existing file is never overwritten")
    parser.add_argument("--remove-original", action="store_true", help="Recycle only after full cloud read-back and restored tree verification")
    parser.add_argument("--keep-cache", action="store_true")
    parser.add_argument("--token-stdin", action="store_true", help="Read a bearer/API credential from stdin, never command-line arguments")
    args = parser.parse_args()
    if args.action == "capabilities":
        system, arch = native_platform()
        return emit(ok=True, platform=system, architecture=arch, transferAPI="v3", portableApplications=True, files=True, folders=True, sparseApplicationStreaming=False, cleanup="managed cache after complete process-tree exit")
    cache = ManagedCache()
    if args.action == "evict": return emit(ok=True, removed=cache.evict(args.file_id))
    if args.action == "launch": return emit(ok=True, **cache.launch(args.file_id, cleanup=not args.keep_cache))
    workspace_route(args.workspace)
    token = sys.stdin.readline().strip() if args.token_stdin else getpass.getpass("GenDragoon account API key or session token (hidden): ")
    client = CloudClient(token)
    if args.action == "workspaces": return emit(ok=True, **client.json("/v2/workspaces"))
    if args.action == "list": return emit(ok=True, workspace=args.workspace, files=client.files(args.workspace))
    with tempfile.TemporaryDirectory(prefix=".transfer-", dir=cache.root) as temporary:
        temporary = Path(temporary)
        if args.action == "upload":
            if not args.source: raise ValueError("Choose a source file, folder or application")
            source = args.source.absolute(); original = snapshot(source)
            packaged = source.is_dir() or source.stat().st_size == 0 or args.application_entrypoint is not None
            upload = source
            if packaged:
                upload = temporary/(source.name+(".gdapp.zip" if args.application_entrypoint is not None else ".zip"))
                make_package(source, upload, args.application_entrypoint)
            checkpoint_key = hashlib.sha256((str(source)+"|"+args.workspace).encode()).hexdigest()
            item = client.upload(upload, args.workspace, cache.root/("upload-"+checkpoint_key+".json"))
            restored = client.download(item, args.workspace, temporary/"verified-download")
            if packaged:
                extract_package(restored, temporary/"restore-check")
            if snapshot(source) != original: raise ValueError("Original changed; cloud copy retained and original untouched")
            if args.remove_original: recycle_original(source, original)
            return emit(ok=True, file=item, cloudReadbackVerified=True, originalRecycled=args.remove_original)
        canonical_id(args.file_id)
        item = next((x for x in client.files(args.workspace) if x["id"] == args.file_id), None)
        if not item: raise ValueError("Cloud item was not found in the selected workspace")
        archive = client.download(item, args.workspace, temporary/"download")
        managed_package = False
        if zipfile.is_zipfile(archive):
            with zipfile.ZipFile(archive) as check:
                managed_package = MANIFEST in check.namelist()
        if not managed_package:
            if not args.destination:
                raise ValueError("Choose --destination to restore this plain file or foreign application package. Native launch requires a verified GenDragoon portable-app package.")
            target = args.destination.absolute()
            if target.exists() or target.is_symlink() or not target.parent.is_dir():
                raise ValueError("Choose an unused destination in an existing folder")
            with archive.open("rb") as source, target.open("xb") as output:
                shutil.copyfileobj(source, output, length=1024*1024)
                output.flush(); os.fsync(output.fileno())
            return emit(ok=True, restoredTo=str(target), cloudRetained=True)
        destination = cache.stage(archive, item["id"], args.workspace)
        emit(ok=True, restoredTo=str(destination), cloudRetained=True)


if __name__ == "__main__":
    try: main()
    except (ValueError, OSError, TimeoutError, zipfile.BadZipFile, KeyError, TypeError) as error:
        emit(ok=False, message=str(error)[:500]); sys.exit(1)
