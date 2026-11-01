"""Read-through app data cache for existing Red-SecretsXAI PNG objects.

This is a client-side building block, not a virtual filesystem driver. The
caller supplies an authenticated Receiver transport and a manifest obtained
from an authenticated/decrypted app index. No application is launched here.
Each read fetches only the PNG chunks covering its range. Disk usage is
bounded, cached bytes are checked, and 10 GiB is reserved on the cache volume.
The Red-SecretsXAI crypto/image implementations are imported unchanged.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import tempfile
import threading
from collections import OrderedDict
from typing import Callable

CHUNK_BYTES = 64 * 1024
MAX_PNG = 8 * 1024 * 1024
MIN_FREE = 10 * 1024**3
MAX_READ = 8 * 1024 * 1024
HEX32 = re.compile(r"[a-f0-9]{32}\Z")
HEX64 = re.compile(r"[a-f0-9]{64}\Z")


class CacheError(RuntimeError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def app_path(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 4096:
        raise CacheError("Invalid app-relative path")
    parts = value.split("/")
    if (PurePosixPath(value).is_absolute() or any(p in ("", ".", "..") for p in parts)
            or "\\" in value or ":" in value
            or any(ord(c) < 32 or ord(c) == 127 for c in value)):
        raise CacheError("Unsafe app-relative path")
    return value


def validate_manifest(manifest: dict) -> dict:
    """Validate structure, not authenticity; authenticate/decrypt index first."""
    if not isinstance(manifest, dict) or manifest.get("schema") != "redxai.app-chunks/v1":
        raise CacheError("Unsupported app chunk manifest")
    files = manifest.get("files")
    if not isinstance(files, list) or not files or len(files) > 10000:
        raise CacheError("Invalid application file list")
    result = {}
    folded = set()
    objects = set()
    chunk_count = 0
    for file in files:
        if not isinstance(file, dict):
            raise CacheError("Invalid application file")
        name = app_path(file.get("path"))
        if name.casefold() in folded:
            raise CacheError("Case-colliding application paths")
        folded.add(name.casefold())
        size = file.get("bytes")
        if type(size) is not int or size < 0 or size > 16 * 1024**3:
            raise CacheError("Invalid application file size")
        chunks = file.get("chunks")
        if not isinstance(chunks, list) or len(chunks) != (size + CHUNK_BYTES - 1) // CHUNK_BYTES:
            raise CacheError("Chunk list does not cover the file")
        normalized = []
        for index, chunk in enumerate(chunks):
            if not isinstance(chunk, dict):
                raise CacheError("Invalid chunk record")
            identifier = chunk.get("id")
            plain = chunk.get("plainSha256")
            encoded = chunk.get("pngSha256")
            count = min(CHUNK_BYTES, size - index * CHUNK_BYTES)
            if (not isinstance(identifier, str) or not HEX32.fullmatch(identifier)
                    or identifier in objects or chunk.get("bytes") != count
                    or not isinstance(plain, str) or not HEX64.fullmatch(plain)
                    or not isinstance(encoded, str) or not HEX64.fullmatch(encoded)
                    or type(chunk.get("pngBytes")) is not int
                    or not 8 <= chunk["pngBytes"] <= MAX_PNG):
                raise CacheError("Invalid or reused app chunk")
            objects.add(identifier)
            normalized.append(dict(id=identifier, bytes=count, plainSha256=plain,
                                   pngSha256=encoded, pngBytes=chunk["pngBytes"]))
        chunk_count += len(chunks)
        if chunk_count > 262144:
            raise CacheError("Application chunk index is too large")
        result[name] = {"path": name, "bytes": size, "chunks": normalized}
    for name in result:
        for parent in PurePosixPath(name).parents:
            if str(parent) in result:
                raise CacheError("A file cannot also be a directory")
    return result


class RedSecretsDecoder:
    """A reusable existing librsx session; no new cryptographic algorithm."""
    def __init__(self, password: str, keymap: str, receiver: str, workspace: str):
        from redxai import _librsx
        if not HEX64.fullmatch(receiver) or not HEX32.fullmatch(workspace):
            raise CacheError("Invalid Receiver/workspace context")
        key = Path(keymap).absolute()
        if (not key.is_file() or any(p.is_symlink() for p in (key, *key.parents))
                or key.stat().st_mode & 0o077):
            raise CacheError("A private existing keymap is required")
        self.rsx = _librsx
        self.receiver = receiver
        self.workspace = workspace
        self.manager = _librsx.session_open(password, str(key))
        self.session = self.manager.__enter__()
        self.closed = False

    def __call__(self, chunk: dict, png: bytes, directory: Path) -> bytes:
        from redsecretsxai import decode_image
        if self.closed:
            raise CacheError("Decoder session is closed")
        aad = json.dumps(["red-xai-receiver/png/v1", self.receiver,
                          self.workspace, chunk["id"]], separators=(",", ":")).encode()
        with tempfile.TemporaryDirectory(prefix=".decode-", dir=directory) as work:
            root = Path(work)
            sealed = root / "chunk.Red_SecretXAI"
            output = root / "verified"
            blob = decode_image(png)
            if len(blob) > CHUNK_BYTES + 64 * 1024:
                raise CacheError("Decoded chunk exceeds its bound")
            with sealed.open("xb") as handle:
                os.chmod(sealed, 0o600)
                handle.write(blob)
            self.rsx.decrypt_file(self.session, str(sealed), out_path=str(output), aad=aad)
            with output.open("rb") as handle:
                data = handle.read(CHUNK_BYTES + 1)
            if len(data) != chunk["bytes"] or digest(data) != chunk["plainSha256"]:
                raise CacheError("Decrypted app chunk does not match its index")
            return data

    def close(self):
        if not self.closed:
            self.closed = True
            self.manager.__exit__(None, None, None)


class AppRangeCache:
    def __init__(self, manifest: dict, directory: str | Path,
                 fetch_png: Callable[[dict], bytes],
                 decode_png: Callable[[dict, bytes, Path], bytes], *,
                 max_bytes: int = 256 * 1024 * 1024,
                 free_bytes: Callable[[Path], int] | None = None):
        self.files = validate_manifest(manifest)
        if type(max_bytes) is not int or not CHUNK_BYTES <= max_bytes <= 8 * 1024**3:
            raise CacheError("Cache budget must be between one chunk and 8 GiB")
        # A new session directory is required: never adopt or recursively delete
        # an existing directory containing user data or another app's cache.
        self.root = Path(directory).absolute()
        if any(p.is_symlink() for p in (self.root, *self.root.parents)):
            raise CacheError("Cache path cannot contain symlinks")
        self.root.mkdir(mode=0o700, parents=False, exist_ok=False)
        self.fetch_png = fetch_png
        self.decode_png = decode_png
        self.max_bytes = max_bytes
        self.free_bytes = free_bytes or (lambda p: shutil.disk_usage(p).free)
        self.cached: OrderedDict[str, dict] = OrderedDict()
        self.used = 0
        self.downloaded = 0
        self.hits = 0
        self.misses = 0
        self.lock = threading.RLock()
        self.closed = False

    def _verified_local(self, entry: dict) -> bytes:
        file = self.root / entry["id"]
        fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_uid != os.getuid() or info.st_mode & 0o077
                    or info.st_size != entry["bytes"]):
                raise CacheError("Cached chunk changed; retained for review")
            with os.fdopen(fd, "rb", closefd=False) as handle:
                data = handle.read(CHUNK_BYTES + 1)
            if len(data) != entry["bytes"] or digest(data) != entry["plainSha256"]:
                raise CacheError("Cached chunk changed; retained for review")
            return data
        finally:
            os.close(fd)

    def _chunk(self, entry: dict) -> bytes:
        identifier = entry["id"]
        if identifier in self.cached:
            result = self._verified_local(entry)
            self.cached.move_to_end(identifier)
            self.hits += 1
            return result
        # Reserve space for the downloaded carrier, decoded ciphertext and new
        # plaintext, before fetching. Existing unrelated files are untouched.
        transient = entry["pngBytes"] + 3 * CHUNK_BYTES + 1024 * 1024
        if self.free_bytes(self.root) < MIN_FREE + transient:
            raise CacheError("Preload stopped to preserve 10 GiB free")
        while self.used + entry["bytes"] > self.max_bytes:
            old_id, old = next(iter(self.cached.items()))
            self._verified_local(old)  # never delete modified cache data
            (self.root / old_id).unlink()
            self.used -= old["bytes"]
            del self.cached[old_id]
        raw = self.fetch_png(dict(entry))
        if (not isinstance(raw, bytes) or len(raw) != entry["pngBytes"]
                or raw[:8] != b"\x89PNG\r\n\x1a\n" or digest(raw) != entry["pngSha256"]):
            raise CacheError("Downloaded PNG failed size, format or integrity checks")
        data = self.decode_png(dict(entry), raw, self.root)
        if not isinstance(data, bytes) or len(data) != entry["bytes"] or digest(data) != entry["plainSha256"]:
            raise CacheError("App chunk authentication failed")
        if self.free_bytes(self.root) < MIN_FREE + entry["bytes"] + 1024 * 1024:
            raise CacheError("Caching stopped to preserve 10 GiB free")
        file = self.root / identifier
        fd = os.open(file, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
        try:
            with os.fdopen(fd, "wb", closefd=False) as handle:
                handle.write(data)
                handle.flush()
                os.fsync(fd)
        except BaseException:
            file.unlink(missing_ok=True)
            raise
        finally:
            os.close(fd)
        self.cached[identifier] = entry
        self.used += len(data)
        self.downloaded += len(raw)
        self.misses += 1
        return data

    def read(self, file: str, offset: int, count: int) -> bytes:
        with self.lock:
            if self.closed:
                raise CacheError("Cache session is closed")
            item = self.files.get(app_path(file))
            if item is None:
                raise FileNotFoundError(file)
            if type(offset) is not int or offset < 0 or type(count) is not int or not 0 <= count <= MAX_READ:
                raise CacheError("Invalid or unbounded app read")
            end = min(item["bytes"], offset + count)
            if offset >= end:
                return b""
            parts = []
            for number in range(offset // CHUNK_BYTES, (end - 1) // CHUNK_BYTES + 1):
                chunk = self._chunk(item["chunks"][number])
                start_at = max(0, offset - number * CHUNK_BYTES)
                stop_at = min(len(chunk), end - number * CHUNK_BYTES)
                parts.append(chunk[start_at:stop_at])
            return b"".join(parts)

    def preload(self, paths: list[str], budget: int) -> int:
        if type(budget) is not int or not 0 <= budget <= self.max_bytes:
            raise CacheError("Preload exceeds the cache budget")
        warmed = 0
        # Warm only the startup header of each selected file, not its complete
        # resources. The operating system's later reads request more ranges.
        for name in dict.fromkeys(paths):
            if warmed >= budget:
                break
            amount = min(CHUNK_BYTES, budget - warmed, self.files[app_path(name)]["bytes"])
            warmed += len(self.read(name, 0, amount))
        return warmed

    def status(self) -> dict:
        with self.lock:
            return {"cachedBytes": self.used, "cacheLimitBytes": self.max_bytes,
                    "downloadedPNGBytes": self.downloaded, "cacheHits": self.hits,
                    "downloadedChunks": self.misses, "files": len(self.files),
                    "logicalAppBytes": sum(item["bytes"] for item in self.files.values())}

    def close(self):
        with self.lock:
            if self.closed:
                return
            # Refuse cleanup if a user added or edited anything in our session.
            names = {p.name for p in self.root.iterdir()}
            if names != set(self.cached):
                raise CacheError("Unexpected local cache data retained for review")
            for entry in self.cached.values():
                self._verified_local(entry)
            for identifier in self.cached:
                (self.root / identifier).unlink()
            self.root.rmdir()
            self.cached.clear()
            self.used = 0
            self.closed = True
