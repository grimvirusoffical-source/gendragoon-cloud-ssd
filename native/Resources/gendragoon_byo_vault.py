#!/usr/bin/env python3
"""Recover BYO encryption keys for one current account and exact pack context.

Only encrypted keymaps are installed. API keys and passphrases are not accepted.
The storage secret arrives over private stdin solely for read-only core validation.
"""
import sys
sys.dont_write_bytecode = True
import argparse
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import stat
import uuid

import gendragoon_redx_pack as pack
import gendragoon_upload_workspace as workspace

BASE = {"origin", "database", "pack", "accountId", "receiverId", "workspaceId", "keymapPath"}
PROFILE = ("Library", "Application Support", "Red-XAI", "GenDragoon")
KEYMAPS = ("Library", "Application Support", "GenDragoon Cloud SSD", "BYOKeymaps")


class RecoveryError(ValueError):
    pass


def publish_exclusive(fd, source, target):
    """Atomic no-replace rename: no crash window with a multiply linked keymap."""
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function, flags = libc.renameatx_np, 0x00000004  # sys/stdio.h RENAME_EXCL
    elif sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        function, flags = libc.renameat2, 1  # Linux RENAME_NOREPLACE (fixture runners)
    else:
        raise RecoveryError("exclusive_rename_unavailable")
    function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    function.restype = ctypes.c_int
    if function(fd, os.fsencode(source), fd, os.fsencode(target), flags) != 0:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))


def validate_pinned(value):
    """Validate a descriptor opened beneath our pinned private directory.

    fdescfs st_dev differs from fstat on Darwin, so a descriptor path cannot be
    passed to the ordinary path-based validator's final lstat comparison.
    """
    match = re.fullmatch(r"/dev/fd/([0-9]+)", value["keymapPath"])
    if match is None:
        raise RecoveryError("invalid_keymap")
    fd = int(match[1])
    before = os.fstat(fd)
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
            or before.st_nlink != 1 or before.st_mode & 0o077):
        raise RecoveryError("unsafe_path")
    os.lseek(fd, 0, os.SEEK_SET)
    data = os.read(fd, 97)
    if (hashlib.sha256(data).hexdigest() != value["keymapSha256"] or len(data) < 11
            or data[:4] != b"KXAI" or len(data) != {1: 75, 2: 87, 3: 95}.get(data[4])):
        raise RecoveryError("invalid_keymap")
    t, p, memory = data[5], data[6], int.from_bytes(data[7:11], "big")
    if not (1 <= t <= 10 and 1 <= p <= 16 and 8 * p <= memory <= 256 * 1024):
        raise RecoveryError("invalid_keymap")
    vendor = Path(__file__).resolve().parent.parent / "vendor" / "Red-SecretsXAI"
    if vendor.is_dir():
        sys.path.insert(0, str(vendor))
    from redxai import _librsx as rsx
    os.lseek(fd, 0, os.SEEK_SET)
    with rsx.session_open_readonly(value["storageSecret"], value["keymapPath"])[0]:
        pass
    os.lseek(fd, 0, os.SEEK_SET)
    after = os.fstat(fd)
    if os.read(fd, 97) != data or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
        raise RecoveryError("file_changed")
    return {"validated": True}


def directory(home, parts, create=False):
    """Pin every owned, non-shared directory; never traverse a symbolic link."""
    home = Path(home).absolute()
    if any(p.is_symlink() for p in (home, *home.parents)):
        raise RecoveryError("unsafe_path")
    fd = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in (None, *parts):
            if part is not None:
                if create:
                    try:
                        os.mkdir(part, 0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise RecoveryError("unsafe_path")
        return fd
    except BaseException:
        os.close(fd)
        raise


def private_read(fd, name, limit):
    leaf = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
    try:
        info = os.fstat(leaf)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077 or not 0 < info.st_size <= limit):
            raise RecoveryError("unsafe_path")
        data = os.read(leaf, limit + 1)
        after = os.fstat(leaf)
        current = os.stat(name, dir_fd=fd, follow_symlinks=False)
        if len(data) != info.st_size or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino):
            raise RecoveryError("file_changed")
        return data, (info.st_dev, info.st_ino)
    finally:
        os.close(leaf)


def profile(home, account):
    fd = directory(home, PROFILE)
    try:
        raw, inode = private_read(fd, "cloud.json", 64 * 1024)
    finally:
        os.close(fd)
    value = json.loads(raw)
    if (not isinstance(value, dict) or value.get("schema") != 1
            or value.get("issuer") != "https://red-xai.com" or value.get("clientId") != "gendragoon"
            or value.get("authProvider") != "redx-site-session" or value.get("cloudApi") != "https://api.red-xai.com"
            or value.get("storageFormat") != "redsecretsxai-png-v1"
            or not isinstance(value.get("subject"), str) or not value["subject"] or len(value["subject"]) > 512):
        raise RecoveryError("account_changed")
    expected = hashlib.sha256(json.dumps(["red-xai-receiver/v1", value["issuer"], value["subject"]], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
    if expected != account or value.get("receiverId") != account:
        raise RecoveryError("account_changed")
    return hashlib.sha256(raw).digest(), inode


def idle(home):
    try:
        fd = directory(home, ("Library", "Application Support", "GenDragoon Cloud SSD", "UploadWorkspace"))
    except FileNotFoundError:
        return
    try:
        try:
            raw, _ = private_read(fd, "state.json", 3 * 1024 * 1024)
        except FileNotFoundError:
            return
        value = json.loads(raw)
        if (not isinstance(value, dict) or value.get("schema") != 1 or not isinstance(value.get("jobs"), list)
                or len(value["jobs"]) > 200 or value.get("active_job_id") is not None
                or any(not isinstance(j, dict) or j.get("state") not in {"failed", "succeeded"} for j in value["jobs"])):
            raise RecoveryError("activity_busy")
    finally:
        os.close(fd)


def system_idle():
    from gendragoon_app_control import ensure_idle
    ensure_idle(None, False)


def validate_input(action, value, home):
    extras = {"storageSecret", "keymapSha256"} if action == "check-keymap" else {"storageSecret", "keymap"} if action == "install-keymap" else set()
    if (not isinstance(value, dict) or set(value) - {"development"} != BASE | extras
            or ("development" in value and type(value["development"]) is not bool)):
        raise RecoveryError("invalid_context")
    context = pack.connection_context(value)
    keypath = Path(home) / Path(*KEYMAPS) / (context["receiverId"] + ".rsxkeymap")
    if (value["receiverId"] != context["receiverId"] or value["workspaceId"] != context["workspaceId"]
            or value["receiverId"] == value["accountId"] or value["keymapPath"] != str(keypath)):
        raise RecoveryError("invalid_context")
    if extras and (not isinstance(value["storageSecret"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", value["storageSecret"])):
        raise RecoveryError("invalid_context")
    if action == "check-keymap" and (not isinstance(value["keymapSha256"], str) or not re.fullmatch(r"[a-f0-9]{64}", value["keymapSha256"])):
        raise RecoveryError("invalid_context")
    if action == "install-keymap":
        raw = value["keymap"]
        if not isinstance(raw, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", raw):
            raise RecoveryError("invalid_keymap")
        data = base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4))
        if base64.urlsafe_b64encode(data).decode().rstrip("=") != raw:
            raise RecoveryError("invalid_keymap")
        if len(data) < 11 or data[:4] != b"KXAI" or len(data) != {1: 75, 2: 87, 3: 95}.get(data[4]):
            raise RecoveryError("invalid_keymap")
        return context, data
    return context, None


def execute(action, value, *, home=None, validator=None, idle_probe=None):
    """home/validator/probe injection is fixture-only; CLI always uses actual home."""
    home = Path(pwd.getpwuid(os.getuid()).pw_dir) if home is None else Path(home)
    validator = validate_pinned if validator is None else validator
    idle_probe = system_idle if idle_probe is None else idle_probe
    context, imported = validate_input(action, value, home)
    before = profile(home, value["accountId"])
    with workspace.maintenance_lock(home):
        idle(home)
        idle_probe()
        fd = directory(home, KEYMAPS, create=True)
        name = context["receiverId"] + ".rsxkeymap"
        temporary = None
        created_inode = None
        try:
            if os.fstat(fd).st_mode & 0o077:
                raise RecoveryError("unsafe_path")
            def unchanged():
                if profile(home, value["accountId"]) != before:
                    raise RecoveryError("account_changed")
            def check(leaf, data):
                # Darwin's fdescfs can duplicate a file descriptor, but cannot
                # traverse a directory descriptor as /dev/fd/N/child.
                pinned = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=fd)
                try:
                    result = validator({"storageSecret": value["storageSecret"], "keymapPath": f"/dev/fd/{pinned}", "keymapSha256": hashlib.sha256(data).hexdigest()})
                finally:
                    os.close(pinned)
                if result.get("validated") is not True:
                    raise RecoveryError("invalid_keymap")
                after, _ = private_read(fd, leaf, 95)
                if after != data:
                    raise RecoveryError("file_changed")
            if action == "preflight":
                unchanged()
                return {"ok": True, **context}
            if action == "check-keymap":
                data, _ = private_read(fd, name, 95)
                if hashlib.sha256(data).hexdigest() != value["keymapSha256"]:
                    raise RecoveryError("file_changed")
                check(name, data)
            else:
                data = imported
                try:
                    existing, _ = private_read(fd, name, 95)
                except FileNotFoundError:
                    existing = None
                if existing is not None:
                    if existing != data:
                        raise RecoveryError("keymap_conflict")
                    check(name, data)
                else:
                    temporary = ".byo-import-" + uuid.uuid4().hex
                    leaf = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                    try:
                        with os.fdopen(leaf, "wb", closefd=False) as stream:
                            stream.write(data)
                            stream.flush()
                            os.fsync(leaf)
                    finally:
                        os.close(leaf)
                    check(temporary, data)
                    unchanged()
                    try:
                        info = os.stat(temporary, dir_fd=fd, follow_symlinks=False)
                        publish_exclusive(fd, temporary, name)
                        created_inode = (info.st_dev, info.st_ino)
                        temporary = None
                    except FileExistsError:
                        retained, _ = private_read(fd, name, 95)
                        if retained != data:
                            raise RecoveryError("keymap_conflict")
                    if temporary is not None:
                        os.unlink(temporary, dir_fd=fd)
                        temporary = None
                    os.fsync(fd)
                    retained, _ = private_read(fd, name, 95)
                    if retained != data:
                        raise RecoveryError("file_changed")
            unchanged()
            return {"ok": True, "validated": True, **context, "created": created_inode is not None, "keymapSha256": hashlib.sha256(data).hexdigest()}
        except BaseException:
            if created_inode is not None:
                try:
                    retained, inode = private_read(fd, name, 95)
                    if inode == created_inode and retained == imported:
                        os.unlink(name, dir_fd=fd)
                        os.fsync(fd)
                except OSError:
                    pass
            raise
        finally:
            if temporary is not None:
                os.unlink(temporary, dir_fd=fd)
            os.close(fd)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["preflight", "check-keymap", "install-keymap"])
    action = parser.parse_args(argv).action
    try:
        raw = sys.stdin.buffer.read(8193)
        if len(raw) > 8192:
            raise RecoveryError("invalid_context")
        result = execute(action, json.loads(raw))
    except Exception:
        print(json.dumps({"ok": False, "error": "byo_vault_rejected", "message": "BYO recovery could not be verified. Check the current account, exact host/database/pack, passphrase, private files and idle activity. Existing keys were preserved."}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
