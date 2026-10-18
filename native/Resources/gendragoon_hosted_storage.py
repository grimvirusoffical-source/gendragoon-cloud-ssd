#!/usr/bin/env python3
"""Hosted storage via POST /v2/workspaces/:id/storage-urls.

Riley issues signed upload and download URLs scoped to that workspace. They
must expire within 15 minutes. A locked workspace is read-only. This client
never accepts Google credentials. Files and filenames are sealed with AES-256-GCM
before anything is uploaded.

docs/SECURITY.md is not in the tree. Assumptions until Avery publishes it:
- Request {"objects": [{"op": "upload"|"download", "name": "<sealed object name>"}]}.
- Response {"prefix", "expiresAt", "readOnly", "urls": [{"op", "name", "method", "url"}]}.
- expiresAt is ISO-8601 UTC. A lifetime over 15 minutes is rejected.
- Every URL is https, has no userinfo, and its path contains the workspace id.
- Bodies that contain access tokens, private keys, or other Google secrets are rejected.
"""
import argparse
import base64
import datetime
import json
import os
import re
import sys
import urllib.parse
from pathlib import Path

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

from gendragoon_aes import VaultError, open_seal, seal

TTL_SECONDS = 15 * 60
WORKSPACE_ID = re.compile(r"[A-Za-z0-9_-]{1,80}")
SECRET_KEYS = {
    "access_token", "accessToken", "refresh_token", "refreshToken", "id_token", "idToken",
    "private_key", "privateKey", "client_secret", "clientSecret", "googleCredentials",
    "authorization", "secretAccessKey", "sessionToken",
}


class StorageError(RuntimeError):
    pass


def storage_path(workspace_id):
    if not isinstance(workspace_id, str) or not WORKSPACE_ID.fullmatch(workspace_id):
        raise StorageError("Choose a workspace before asking for storage URLs.")
    return f"/v2/workspaces/{workspace_id}/storage-urls"


def _reject_secrets(value):
    if isinstance(value, dict):
        for key, item in value.items():
            if key in SECRET_KEYS:
                raise StorageError("Hosted storage must not hand this Mac a Google credential.")
            _reject_secrets(item)
    elif isinstance(value, list):
        for item in value:
            _reject_secrets(item)


def _expires_in(expires_at, now):
    if not isinstance(expires_at, str):
        raise StorageError("Signed URLs need an expiry.")
    text = expires_at.replace("Z", "+00:00")
    try:
        moment = datetime.datetime.fromisoformat(text)
    except ValueError:
        raise StorageError("Signed URL expiry is not a time.") from None
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=datetime.timezone.utc)
    return (moment - now).total_seconds()


def validate_session(workspace_id, body, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if not isinstance(body, dict):
        raise StorageError("Storage session was empty.")
    _reject_secrets(body)
    if body.get("workspaceId") not in (None, workspace_id):
        raise StorageError("Storage session is for a different workspace.")
    prefix = body.get("prefix")
    if not isinstance(prefix, str) or workspace_id not in prefix or prefix.startswith("/") or ".." in prefix:
        raise StorageError("Storage session is not scoped to this workspace.")
    remaining = _expires_in(body.get("expiresAt"), now)
    if remaining <= 0 or remaining > TTL_SECONDS:
        raise StorageError("Signed URLs must expire within 15 minutes.")
    read_only = body.get("readOnly")
    if not isinstance(read_only, bool):
        raise StorageError("Storage session did not say whether uploads are allowed.")
    urls = body.get("urls")
    if not isinstance(urls, list) or not urls:
        raise StorageError("Storage session did not include a signed URL.")
    checked = []
    for item in urls:
        if not isinstance(item, dict):
            raise StorageError("A signed URL entry is invalid.")
        op = item.get("op")
        name = item.get("name")
        method = str(item.get("method") or "").upper()
        url = item.get("url")
        if op not in {"upload", "download"} or not isinstance(name, str) or not name or "/" in name or ".." in name:
            raise StorageError("A signed URL is not limited to one object in this workspace.")
        if read_only and op == "upload":
            raise StorageError("This workspace is locked. Uploads stay off until it is unlocked.")
        if op == "upload" and method not in {"PUT", "POST"}:
            raise StorageError("An upload URL has an unexpected method.")
        if op == "download" and method not in {"GET", "HEAD"}:
            raise StorageError("A download URL has an unexpected method.")
        parsed = urllib.parse.urlsplit(url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password:
            raise StorageError("Signed URLs must be https and carry no Google login.")
        if workspace_id not in urllib.parse.unquote(parsed.path):
            raise StorageError("A signed URL is outside this workspace.")
        checked.append({"op": op, "name": name, "method": method, "url": url})
    return {"prefix": prefix, "expiresAt": body["expiresAt"], "readOnly": read_only, "urls": checked}


def object_name(display_name, key):
    """Seal the filename. The returned token is safe inside one URL path segment."""
    if not isinstance(display_name, str) or not display_name or display_name in {".", ".."} or "/" in display_name or "\\" in display_name:
        raise StorageError("Choose a file name on this Mac.")
    token = base64.urlsafe_b64encode(seal(display_name.encode("utf-8"), key)).decode("ascii").rstrip("=")
    if display_name.casefold() in token.casefold():
        raise StorageError("The original file name would still be visible.")
    return token


def encrypt_file(plaintext, key):
    return seal(plaintext, key)


def decrypt_file(ciphertext, key):
    try:
        return open_seal(ciphertext, key)
    except VaultError as exc:
        raise StorageError("The downloaded file failed its integrity check.") from exc


def decrypt_name(token, key):
    pad = "=" * (-len(token) % 4)
    try:
        return open_seal(base64.urlsafe_b64decode(token + pad), key).decode("utf-8")
    except (VaultError, UnicodeError, ValueError) as exc:
        raise StorageError("The stored file name could not be opened on this device.") from exc


def main(argv=None):
    parser = argparse.ArgumentParser(description="Hosted workspace storage through signed URLs.")
    parser.add_argument("action", nargs="?", choices=("show",), default="show")
    parser.parse_args(argv)
    print("POST /v2/workspaces/<id>/storage-urls. Files and names are AES-256 sealed on this Mac.")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(main())
