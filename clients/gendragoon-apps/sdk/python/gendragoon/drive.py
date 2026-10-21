"""Encrypted (or plain) files and folders in one manifest per drive, committed with compare-and-swap."""
from __future__ import annotations

import hashlib
import json
import os
import random
import time
from dataclasses import dataclass
from typing import Callable, Optional

from .client import Client
from .crypto import (KEY_BYTES, b64u, drive_manifest_key, from_b64u, open_chunk, open_manifest, seal_chunk,
                     seal_manifest)
from .errors import APIError, CorruptError
from .keyring import Keyring

DEFAULT_CHUNK_SIZE = 4 << 20


def slot_path(folder: str, slot: str) -> str:
    """folder/slot for a save slot; slot must be one path segment and folder "" or a valid drive path."""
    if not slot or "/" in slot:
        raise ValueError(f"gendragoon: invalid slot name {slot!r}")
    return clean_path(f"{folder}/{slot}" if folder else slot)


def clean_path(p: str) -> str:
    """Slash-separated, no leading or trailing slash, no empty, "." or ".." segments, no backslash or control
    characters, at most 1024 bytes."""
    bad = ValueError(f"gendragoon: invalid path {p!r}")
    if not p or len(p.encode()) > 1024 or p.startswith("/") or p.endswith("/") or "\\" in p:
        raise bad
    for seg in p.split("/"):
        if seg in ("", ".", "..") or any(ord(ch) < 0x20 or ord(ch) == 0x7F for ch in seg):
            raise bad
    return p


def _dirname(p: str) -> str:
    return p.rsplit("/", 1)[0] if "/" in p else ""


def _folder_set(doc: dict) -> set[str]:
    s = set(doc.get("folders") or [])
    for p in doc["files"]:
        d = _dirname(p)
        while d:
            s.add(d)
            d = _dirname(d)
    return s


def _not_found() -> APIError:
    return APIError(404, "not_found")


def _entry_json(e: dict) -> dict:
    out = {"size": e["size"], "mtime": e["mtime"], "sha256": e["sha256"], "chunks": e["chunks"]}
    if e.get("key"):
        out["key"] = e["key"]
    return out


def _encode(doc: dict) -> bytes:
    files = {k: _entry_json(doc["files"][k]) for k in sorted(doc["files"])}
    folders = sorted(doc.get("folders") or []) or None
    body = {"v": 1, "encrypted": doc["encrypted"], "files": files, "folders": folders, "updatedAt": doc["updatedAt"]}
    return json.dumps(body, separators=(",", ":"), ensure_ascii=False).encode()


@dataclass
class Entry:
    name: str
    path: str
    folder: bool
    size: int = 0
    mtime: Optional[int] = None  # milliseconds since the Unix epoch


class Drive:
    """A named tree of files and folders. Encrypted unless opened with plain=True."""

    def __init__(self, client: Client, name: str, keys: Optional[Keyring] = None, *, plain: bool = False, chunk_size: int = DEFAULT_CHUNK_SIZE):
        if not name or len(name.encode()) > 128:
            raise ValueError("gendragoon: drive name must be 1 to 128 bytes")
        if chunk_size <= 0 or chunk_size > (16 << 20) - 64:
            raise ValueError("gendragoon: chunk size must be below 16 MiB")
        self._c, self.name, self._chunk = client, name, chunk_size
        if plain:
            self._keys = None
            self.manifest_key = drive_manifest_key(None, name)
        else:
            if keys is None:
                raise ValueError("gendragoon: an encrypted drive needs a keyring (or plain=True)")
            self._keys = keys
            self.manifest_key = drive_manifest_key(keys.master(), name)

    @property
    def encrypted(self) -> bool:
        return self._keys is not None

    def _mk(self) -> Optional[bytes]:
        return self._keys.master() if self._keys else None

    def load(self) -> tuple[dict, str]:
        try:
            m = self._c.get_manifest(self.manifest_key)
        except APIError as e:
            if e.not_found:
                return {"v": 1, "encrypted": self.encrypted, "files": {}, "folders": None, "updatedAt": 0}, ""
            raise
        try:
            doc = json.loads(open_manifest(self._mk(), self.manifest_key, m.data))
        except ValueError:
            raise CorruptError() from None
        if not isinstance(doc, dict) or doc.get("v") != 1:
            raise CorruptError()
        doc["files"] = doc.get("files") or {}
        return doc, m.generation

    def update(self, fn: Callable[[dict], None]) -> None:
        """Applies fn to the latest document and commits it, retrying on conflict."""
        for attempt in range(13):
            doc, gen = self.load()
            fn(doc)
            doc["updatedAt"] = int(time.time() * 1000)
            sealed = seal_manifest(self._mk(), self.manifest_key, _encode(doc))
            try:
                self._c.put_manifest(self.manifest_key, sealed, if_absent=not gen, if_generation=gen)
                return
            except APIError as e:
                if not e.precondition_failed or attempt >= 12:
                    raise
            time.sleep((10 + random.randrange(40 << min(attempt, 4))) / 1000)

    def snapshot(self) -> dict:
        self._c.check("files.list")
        return self.load()[0]

    def list(self, folder: str = "") -> list[Entry]:
        """Direct children of folder ("" is the root): folders first, then by name."""
        self._c.check("files.list")
        if folder:
            clean_path(folder)
        doc, _ = self.load()
        out = [Entry(f.rsplit("/", 1)[-1], f, True) for f in _folder_set(doc) if _dirname(f) == folder]
        out += [Entry(p.rsplit("/", 1)[-1], p, False, e["size"], e["mtime"]) for p, e in doc["files"].items() if _dirname(p) == folder]
        return sorted(out, key=lambda e: (not e.folder, e.name))

    def stat(self, p: str) -> dict:
        self._c.check("files.stat")
        e = self.load()[0]["files"].get(p)
        if e is None:
            raise _not_found()
        return e

    def write_file(self, p: str, data: bytes, mtime_ms: Optional[int] = None) -> dict:
        """Creates or replaces a file. Unchanged chunks of an existing file are not uploaded again."""
        self._c.check("files.write")
        clean_path(p)
        file_key = None
        if self._keys:
            try:
                old = self.load()[0]["files"].get(p)
                if old and old.get("key"):
                    file_key = from_b64u(old["key"])
            except (APIError, CorruptError, ValueError):
                pass
            if not file_key or len(file_key) != KEY_BYTES:
                file_key = os.urandom(KEY_BYTES)
        entry = self.upload(file_key, data)
        entry["mtime"] = mtime_ms if mtime_ms is not None else int(time.time() * 1000)

        def apply(doc: dict) -> None:
            if p in _folder_set(doc):
                raise ValueError(f"gendragoon: {p!r} is a folder")
            d = _dirname(p)
            while d:
                if d in doc["files"]:
                    raise ValueError(f"gendragoon: {d!r} is a file")
                d = _dirname(d)
            doc["files"][p] = entry
        self.update(apply)
        return entry

    def upload(self, file_key: Optional[bytes], data: bytes) -> dict:
        entry = {"size": len(data), "mtime": 0, "sha256": hashlib.sha256(data).hexdigest(), "chunks": []}
        if file_key:
            entry["key"] = b64u(file_key)
        parts = []
        for off in range(0, len(data), self._chunk):
            chunk = data[off:off + self._chunk]
            parts.append(seal_chunk(file_key, chunk) if file_key else (hashlib.sha256(chunk).hexdigest(), chunk))
        have = set(self._c.has_blobs([i for i, _ in parts]))
        for blob_id, blob in parts:
            entry["chunks"].append(blob_id)
            if blob_id in have:
                continue
            if file_key:
                self._c.put_sealed_blob(blob_id, blob)
            else:
                self._c.put_blob(blob)
            have.add(blob_id)
        return entry

    def read_file(self, p: str) -> bytes:
        """A file's content, verified against its SHA-256."""
        self._c.check("files.read")
        e = self.load()[0]["files"].get(p)
        if e is None:
            raise _not_found()
        return read_entry(self._c, e)

    def mkdir(self, p: str) -> None:
        """Creates a folder and its parents. An existing folder is not an error."""
        self._c.check("files.mkdir")
        clean_path(p)

        def apply(doc: dict) -> None:
            s = _folder_set(doc)
            doc["folders"] = doc.get("folders") or []
            d = p
            while d:
                if d in doc["files"]:
                    raise ValueError(f"gendragoon: {d!r} is a file")
                if d not in s:
                    doc["folders"].append(d)
                    s.add(d)
                d = _dirname(d)
        self.update(apply)

    def move(self, src: str, dst: str) -> None:
        """Renames a file or a folder with everything in it. The destination must not exist."""
        self._c.check("files.move")
        clean_path(src), clean_path(dst)
        if dst == src or dst.startswith(src + "/"):
            raise ValueError("gendragoon: cannot move a folder into itself")

        def apply(doc: dict) -> None:
            s = _folder_set(doc)
            if dst in doc["files"] or dst in s:
                raise ValueError(f"gendragoon: {dst!r} already exists")
            if src in doc["files"]:
                doc["files"][dst] = doc["files"].pop(src)
                return
            if src not in s:
                raise _not_found()
            for q in [q for q in doc["files"] if q.startswith(src + "/")]:
                doc["files"][dst + q[len(src):]] = doc["files"].pop(q)
            folders = [dst + f[len(src):] if f == src or f.startswith(src + "/") else f for f in doc.get("folders") or []]
            doc["folders"] = list(dict.fromkeys(folders + [dst]))
        self.update(apply)

    def delete(self, p: str) -> None:
        """Removes one file or one empty folder. Level L3, risk destructive. Blobs stay until collect_garbage.
        Cloud saves at L2 use delete_slot."""
        self._c.check("files.delete")

        def apply(doc: dict) -> None:
            if p in doc["files"]:
                del doc["files"][p]
                return
            s = _folder_set(doc)
            if p not in s:
                raise _not_found()
            if any(q.startswith(p + "/") for q in list(s) + list(doc["files"])):
                raise ValueError(f"gendragoon: folder {p!r} is not empty")
            doc["folders"] = [f for f in doc.get("folders") or [] if f != p]
        self.update(apply)

    def delete_slot(self, folder: str, slot: str) -> None:
        """Removes one save slot, the file folder/slot, where slot is a single path segment. It never removes a
        folder, a nested file or anything outside folder, and only changes this drive's manifest (blobs stay until
        collect_garbage). Its reach equals overwriting the slot, which L2 allows. Level L2, risk destructive."""
        self._c.check("files.deleteSlot")
        p = slot_path(folder, slot)

        def apply(doc: dict) -> None:
            if p not in doc["files"]:
                raise _not_found()
            del doc["files"][p]
        self.update(apply)

    def delete_folder(self, p: str) -> int:
        """Removes a folder and everything in it; returns the number of files removed. Level L3, risk bulk-destructive."""
        self._c.check("files.deleteFolder")
        n = 0

        def apply(doc: dict) -> None:
            nonlocal n
            gone = [q for q in doc["files"] if q.startswith(p + "/")]
            n = len(gone)
            for q in gone:
                del doc["files"][q]
            doc["folders"] = [f for f in doc.get("folders") or [] if f != p and not f.startswith(p + "/")]
        self.update(apply)
        return n


def read_entry(c: Client, e: dict) -> bytes:
    """Downloads and verifies one file entry."""
    try:
        file_key = from_b64u(e["key"]) if e.get("key") else None
    except ValueError:
        raise CorruptError() from None
    parts = []
    for blob_id in e["chunks"]:
        blob = c.get_blob(blob_id)
        parts.append(open_chunk(file_key, blob_id, blob) if file_key else blob)
    data = b"".join(parts)
    if len(data) != e["size"] or hashlib.sha256(data).hexdigest() != e["sha256"]:
        raise CorruptError()
    return data


def collect_garbage(c: Client, keys: Optional[Keyring] = None, force: bool = False) -> int:
    """Deletes blobs no drive references. Refuses if any manifest is not a readable drive, unless force.
    Level L3, risk bulk-destructive."""
    c.check("files.collectGarbage")
    mk = keys.master() if keys and keys.unlocked else None
    used: set[str] = set()
    for m in c.all_manifests():
        try:
            got = c.get_manifest(m.id)
        except APIError as e:
            if e.not_found:
                continue
            raise
        try:
            doc = json.loads(open_manifest(mk, m.id, got.data))
            ok = isinstance(doc, dict) and doc.get("v") == 1
        except Exception:
            ok = False
        if not ok:
            if force:
                continue
            raise RuntimeError(f"gendragoon: manifest {m.id[:12]} is not a readable drive; refusing to collect garbage")
        for e in (doc.get("files") or {}).values():
            used.update(e["chunks"])
    deleted = 0
    for b in c.all_blobs():
        if b.id not in used:
            c.request("files.collectGarbage", "DELETE", f"/blobs/{b.id}")
            deleted += 1
    return deleted
