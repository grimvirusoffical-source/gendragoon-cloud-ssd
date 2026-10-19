"""Folder sync between the local disk and a drive: push, pull and mirror."""
from __future__ import annotations

import hashlib
import os
import tempfile
from dataclasses import dataclass, field
from typing import Callable, Optional

from .client import Client
from .crypto import KEY_BYTES, from_b64u
from .drive import Drive, clean_path, read_entry


@dataclass
class SyncReport:
    uploaded: list[str] = field(default_factory=list)
    downloaded: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    unchanged: int = 0


def _scan(root: str, skip: Optional[Callable[[str], bool]]) -> dict[str, tuple[str, int, int]]:
    out: dict[str, tuple[str, int, int]] = {}
    if not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        rel_dir = os.path.relpath(dirpath, root).replace(os.sep, "/")
        rel_dir = "" if rel_dir == "." else rel_dir
        dirnames[:] = [d for d in dirnames if not (skip and skip(f"{rel_dir}/{d}" if rel_dir else d))
                       and not os.path.islink(os.path.join(dirpath, d))]
        for name in filenames:
            rel = f"{rel_dir}/{name}" if rel_dir else name
            abs_path = os.path.join(dirpath, name)
            if (skip and skip(rel)) or os.path.islink(abs_path) or not os.path.isfile(abs_path):
                continue  # symlinks and special files are never followed or uploaded
            st = os.stat(abs_path)
            out[rel] = (abs_path, st.st_size, st.st_mtime_ns // 1_000_000)
    return out


def _dp(prefix: str, rel: str) -> str:
    return f"{prefix}/{rel}" if prefix else rel


def _under(p: str, prefix: str) -> bool:
    return not prefix or p.startswith(prefix + "/")


def _rel(p: str, prefix: str) -> str:
    return p[len(prefix) + 1:] if prefix else p


def _sha(path: str) -> tuple[str, bytes]:
    with open(path, "rb") as f:
        data = f.read()
    return hashlib.sha256(data).hexdigest(), data


def _push(d: Drive, local_dir: str, prefix: str, dry_run: bool, skip, mirror: bool) -> SyncReport:
    if prefix:
        clean_path(prefix)
    local = _scan(local_dir, skip)
    doc, _ = d.load()
    rep, changed = SyncReport(), {}
    for rel in sorted(local):
        p = clean_path(_dp(prefix, rel))
        abs_path, size, mtime = local[rel]
        sha, data = _sha(abs_path)
        old = doc["files"].get(p)
        if old and old["sha256"] == sha and old["size"] == size:
            rep.unchanged += 1
            continue
        rep.uploaded.append(p)
        if dry_run:
            continue
        key = None
        if d.encrypted:
            key = from_b64u(old["key"]) if old and old.get("key") else None
            if not key or len(key) != KEY_BYTES:
                key = os.urandom(KEY_BYTES)
        entry = d.upload(key, data)
        entry["mtime"] = mtime
        changed[p] = entry
    gone = sorted(p for p in doc["files"] if _under(p, prefix) and _rel(p, prefix) not in local) if mirror else []
    rep.deleted = gone
    if dry_run or (not changed and not gone):
        return rep

    def apply(latest: dict) -> None:
        latest["files"].update(changed)
        for p in gone:
            latest["files"].pop(p, None)
    d.update(apply)
    return rep


def _write_atomic(target: str, data: bytes, mtime_ms: int) -> None:
    os.makedirs(os.path.dirname(target), exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=".gd-", dir=os.path.dirname(target))
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.replace(tmp, target)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    os.utime(target, ns=(mtime_ms * 1_000_000, mtime_ms * 1_000_000))


def _pull(c: Client, d: Drive, local_dir: str, prefix: str, dry_run: bool, skip, mirror: bool) -> SyncReport:
    doc, _ = d.load()
    local = _scan(local_dir, skip)
    root = os.path.realpath(local_dir)
    rep, remote = SyncReport(), set()
    for p in sorted(doc["files"]):
        if not _under(p, prefix):
            continue
        rel = _rel(p, prefix)
        if skip and skip(rel):
            continue
        remote.add(rel)
        e = doc["files"][p]
        lf = local.get(rel)
        if lf and lf[1] == e["size"] and _sha(lf[0])[0] == e["sha256"]:
            rep.unchanged += 1
            continue
        rep.downloaded.append(p)
        if dry_run:
            continue
        target = os.path.realpath(os.path.join(root, *rel.split("/")))
        if not target.startswith(root + os.sep):
            raise ValueError("gendragoon: drive path escapes the local folder")
        _write_atomic(target, read_entry(c, e), e["mtime"])
    if mirror:
        for rel in sorted(local):
            if rel not in remote:
                rep.deleted.append(_dp(prefix, rel))
                if not dry_run:
                    os.remove(local[rel][0])
    return rep


def push(c: Client, d: Drive, local_dir: str, *, prefix: str = "", dry_run: bool = False, skip=None) -> SyncReport:
    """Uploads local files that are new or differ (by SHA-256). Remote-only files are kept. Level L2, risk write."""
    c.check("sync.push")
    return _push(d, local_dir, prefix, dry_run, skip, False)


def pull(c: Client, d: Drive, local_dir: str, *, prefix: str = "", dry_run: bool = False, skip=None) -> SyncReport:
    """Downloads drive files that are new or differ, written atomically. Local-only files are kept. Level L2, risk write."""
    c.check("sync.pull")
    return _pull(c, d, local_dir, prefix, dry_run, skip, False)


def mirror(c: Client, d: Drive, local_dir: str, direction: str, *, prefix: str = "", dry_run: bool = False, skip=None) -> SyncReport:
    """Makes one side ("to_drive" or "to_local") identical to the other, deleting files only on the target side.
    Level L3, risk bulk-destructive. Run with dry_run=True first."""
    c.check("sync.mirror")
    if direction == "to_drive":
        return _push(d, local_dir, prefix, dry_run, skip, True)
    if direction == "to_local":
        return _pull(c, d, local_dir, prefix, dry_run, skip, True)
    raise ValueError("gendragoon: direction must be 'to_drive' or 'to_local'")
