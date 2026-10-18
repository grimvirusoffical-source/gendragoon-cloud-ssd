#!/usr/bin/env python3
"""Account deletion against Riley's contract: DELETE /v2/account.

Avery confirmed the status route stays plural:
- The user types DELETE. A sign-in older than 5 minutes asks them to sign in again
  before the request is sent.
- 202 returns {"job": {"id", "status", "progress", "phase", "statusPath"}}.
- statusPath, when present, must stay under /v2/account/deletions/.
- Otherwise the client polls GET /v2/account/deletions/:jobId.
- A repeat DELETE that returns 401 means the account is already gone. That is
  success: wipe the Keychain and caches, then sign out locally.
"""
import argparse
import json
import os
import re
import shutil
import sys
from pathlib import Path

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

FRESH_SECONDS = 5 * 60
CONFIRMATION = "DELETE"
DELETE_PATH = "/v2/account"
JOB_ID = re.compile(r"[A-Za-z0-9_-]{8,80}")


class AccountError(RuntimeError):
    pass


def start_deletion(age_seconds, confirmation):
    if confirmation != CONFIRMATION:
        raise AccountError("Type DELETE to confirm account deletion.")
    try:
        age = float(age_seconds)
    except (TypeError, ValueError):
        raise AccountError("Sign in again before deleting this account.") from None
    if age < 0 or age >= FRESH_SECONDS:
        return {"action": "reauthenticate",
                "message": "Sign in again. Account deletion needs a sign-in from the last 5 minutes."}
    return {"action": "request", "method": "DELETE", "path": DELETE_PATH}


def accept_start(status, body):
    if status == 401:
        return {"action": "wipe", "progress": 100, "phase": "already-deleted",
                "message": "This account is already deleted. Signing out on this Mac."}
    if status != 202:
        raise AccountError("Account deletion did not start.")
    job = body.get("job") if isinstance(body, dict) else None
    if not isinstance(job, dict) or not JOB_ID.fullmatch(str(job.get("id") or "")):
        raise AccountError("Account deletion did not return a job.")
    job_id = str(job["id"])
    path = job.get("statusPath") or f"/v2/account/deletions/{job_id}"
    if not isinstance(path, str) or not path.startswith("/v2/account/deletions/") or ".." in path:
        raise AccountError("Account deletion status path is invalid.")
    progress = job.get("progress", 0)
    if not isinstance(progress, int) or not 0 <= progress <= 100:
        progress = 0
    return {"action": "poll", "path": path, "progress": progress,
            "phase": str(job.get("phase") or job.get("status") or "queued")[:80]}


def accept_poll(status, body):
    if status == 401:
        return {"action": "wipe", "progress": 100, "phase": "already-deleted",
                "message": "This account is already deleted. Signing out on this Mac."}
    if status != 200 or not isinstance(body, dict):
        raise AccountError("Account deletion status could not be read.")
    state = str(body.get("status") or "")
    progress = body.get("progress", 0)
    if not isinstance(progress, int) or not 0 <= progress <= 100:
        progress = 0
    phase = str(body.get("phase") or state or "working")[:80]
    if state == "completed":
        return {"action": "wipe", "progress": 100, "phase": "completed"}
    if state in {"failed", "cancelled"}:
        raise AccountError(str(body.get("message") or "Account deletion did not finish.")[:200])
    if state not in {"queued", "running", "working"}:
        raise AccountError("Account deletion returned an unknown status.")
    return {"action": "poll", "progress": progress, "phase": phase}


def wipe_local(home, keychain):
    """Remove this app's caches and Keychain items. Leave the rest of the home alone."""
    home = Path(home).resolve()
    support = home / "Library/Application Support/GenDragoon Cloud SSD"
    targets = [
        home / "Library/Caches/GenDragoon Cloud SSD",
        support / "Cache",
        support / "LaunchSessions",
        support / "AutoUpdates",
    ]
    removed = []
    for path in targets:
        if path.is_symlink():
            raise AccountError("Refusing to wipe a linked cache path.")
        if path.exists():
            shutil.rmtree(path)
            removed.append(str(path))
    keychain.delete_service("app.gendragoon.cloudssd")
    return {"wiped": removed, "keychain": "app.gendragoon.cloudssd"}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Delete the signed-in GenDragoon account.")
    parser.add_argument("action", nargs="?", choices=("show",), default="show")
    parser.parse_args(argv)
    print("DELETE /v2/account starts a job. Caches and the Keychain are wiped only after it completes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
