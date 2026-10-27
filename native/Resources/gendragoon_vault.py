#!/usr/bin/env python3
"""Validate an already encrypted KXAI keymap using the pinned read-only core API.

The storage credential arrives only on a private inherited stdin pipe. No
plaintext key material, credentials, or file contents are written to output.
"""
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse
import hashlib
import json
from pathlib import Path
import re
import stat

def validate(value):
    if (not isinstance(value, dict) or set(value) != {"storageSecret", "keymapPath", "keymapSha256"}
            or not isinstance(value.get("storageSecret"), str)
            or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", value["storageSecret"])
            or not isinstance(value.get("keymapPath"), str)
            or not Path(value["keymapPath"]).is_absolute() or "\0" in value["keymapPath"]
            or not isinstance(value.get("keymapSha256"),str) or not re.fullmatch(r"[a-f0-9]{64}",value["keymapSha256"])):
        raise ValueError("invalid private input")
    path = Path(value["keymapPath"])
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                or info.st_nlink != 1 or info.st_mode & 0o077):
            raise ValueError("unsafe keymap")
        data = os.read(fd, 97)
        if hashlib.sha256(data).hexdigest() != value["keymapSha256"]:
            raise ValueError("keymap changed")
        if len(data) < 11 or data[:4] != b"KXAI" or len(data) != {1:75, 2:87, 3:95}.get(data[4]):
            raise ValueError("nonportable keymap")
        t, p, memory = data[5], data[6], int.from_bytes(data[7:11], "big")
        if not (1 <= t <= 10 and 1 <= p <= 16 and 8*p <= memory <= 256*1024):
            raise ValueError("unsafe keymap cost")
        vendor = Path(__file__).resolve().parent.parent / "vendor" / "Red-SecretsXAI"
        if vendor.is_dir():
            sys.path.insert(0, str(vendor))
        from redxai import _librsx as rsx
        # The open descriptor pins the file being validated, including on Darwin.
        os.lseek(fd, 0, os.SEEK_SET)
        with rsx.session_open_readonly(value["storageSecret"], f"/dev/fd/{fd}")[0]:
            pass
        os.lseek(fd, 0, os.SEEK_SET)
        if os.read(fd,97) != data:
            raise ValueError("keymap changed")
        if path.lstat().st_ino != info.st_ino or path.lstat().st_dev != info.st_dev:
            raise ValueError("keymap changed")
    finally:
        os.close(fd)
    return {"ok": True, "validated": True}

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["check-keymap"])
    parser.parse_args(argv)
    try:
        raw = sys.stdin.buffer.read(4097)
        if len(raw) > 4096:
            raise ValueError("private input too large")
        result = validate(json.loads(raw))
    except Exception:
        print(json.dumps({"ok":False,"error":"invalid_vault_keymap",
            "message":"The encrypted keymap could not be unlocked. Existing keys were preserved."}))
        return 1
    print(json.dumps(result))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
