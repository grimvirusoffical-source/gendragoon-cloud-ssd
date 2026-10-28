#!/usr/bin/env python3
"""GenDragoon device identity and Red-SecretsXAI receipt adapter.

No vendor code is changed. Hardware IDs are hints, not immutable authentication.
Only an account-scoped digest leaves the local identity collector; raw IDs are
never printed, persisted, or placed in the displayed Red-X receipt.
"""
import sys
sys.dont_write_bytecode = True
import base64
import hashlib
import hmac
import json
import os
from pathlib import Path
import plistlib
import re
import stat
import subprocess

ACCOUNT = re.compile(r"[a-f0-9]{64}\Z")
HEX32 = re.compile(r"[a-f0-9]{32}\Z")
DOMAIN = b"GenDragoon/GDGSigned/device-id/v1\0"
AAD = b"GenDragoon/GDGSigned/receipt/v1\0"


def normalized_id(value):
    if not isinstance(value, str):
        raise ValueError("Device ID unavailable")
    cleaned = value.strip().lower().replace("-", "")
    if not HEX32.fullmatch(cleaned) or cleaned in ("0" * 32, "f" * 32):
        raise ValueError("Device ID unavailable")
    return cleaned


def collect_id(system=None, run=subprocess.run, read=lambda p: Path(p).read_text()):
    system = system or sys.platform
    if system == "darwin":
        result = run(["/usr/sbin/ioreg", "-a", "-rd1", "-c", "IOPlatformExpertDevice"],
                     capture_output=True, timeout=10, check=True)
        if len(result.stdout) > 1024 * 1024:
            raise ValueError("Device ID response exceeded its limit")
        roots = plistlib.loads(result.stdout)
        for root in roots if isinstance(roots, list) else []:
            if "IOPlatformUUID" in root:
                return normalized_id(root["IOPlatformUUID"]), "macos", "IOPlatformUUID"
    elif system == "win32":
        executable = str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32/WindowsPowerShell/v1.0/powershell.exe")
        result = run([executable, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
                      "[Console]::Out.Write((Get-CimInstance -ClassName Win32_ComputerSystemProduct).UUID)"],
                     capture_output=True, timeout=15, check=True)
        if len(result.stdout) > 256:
            raise ValueError("Device ID response exceeded its limit")
        return normalized_id(result.stdout.decode("utf-8-sig")), "windows", "SMBIOS-UUID"
    elif system.startswith("linux"):
        for path, source in (("/sys/class/dmi/id/product_uuid", "DMI-product-UUID"),
                             ("/etc/machine-id", "machine-id")):
            try:
                return normalized_id(read(path)), "linux", source
            except (OSError, ValueError):
                continue
    raise ValueError("No supported device identity is available; registration was not fabricated")


def fingerprint(account, **kwargs):
    if not isinstance(account, str) or not ACCOUNT.fullmatch(account):
        raise ValueError("A verified GenDragoon account is required")
    raw, platform, source = collect_id(**kwargs)
    derived = hmac.new(bytes.fromhex(raw), DOMAIN + account.encode("ascii"), hashlib.sha256).hexdigest()
    return {"schema": 1, "platform": platform, "source": source,
            "deviceFingerprint": derived, "immutable": False}


def prepare_receipt(config):
    import secrets
    import time
    import gendragoon_redx_storage as storage
    storage.validate_config(config)
    identity = fingerprint(config["receiverId"])
    object_id = secrets.token_hex(16)
    payload = {"schema": "GDGSigned/v1", "receiverId": config["receiverId"],
               "workspaceId": config["workspaceId"], "receiptId": object_id,
               "deviceFingerprint": identity["deviceFingerprint"],
               "platform": identity["platform"], "createdMs": int(time.time() * 1000)}
    plain = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    # Existing account vault, original encryption API and Red-X image codec.
    # The server receives neither this vault secret nor a raw hardware ID.
    receiver = storage.RedXReceiver(config)
    with storage.Codec(receiver) as codec:
        png = codec.seal(plain, object_id)
        if codec.open(png, object_id) != plain:
            raise ValueError("Device receipt verification failed")
    if len(png) > 128 * 1024:
        raise ValueError("Device receipt exceeds its size limit")
    return {**identity, "qr": {"format": "redsecretsxai-visual-v3", "objectId": object_id,
            "png": base64.b64encode(png).decode("ascii"), "sha256": hashlib.sha256(png).hexdigest()}}


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("fingerprint", "prepare"):
        raise ValueError("Unknown device operation")
    raw = sys.stdin.buffer.readline(131073)
    if len(raw) > 131072:
        raise ValueError("Device request too large")
    data = json.loads(raw)
    result = fingerprint(data.get("receiverId")) if sys.argv[1] == "fingerprint" else prepare_receipt(data)
    print(json.dumps({"ok": True, **result}, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never include raw device IDs, keys, tokens or native exception detail.
        print(json.dumps({"error": "device_receipt_unavailable"}))
        raise SystemExit(1)
