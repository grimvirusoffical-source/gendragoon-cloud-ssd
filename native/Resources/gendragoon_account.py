#!/usr/bin/env python3
"""Account deletion against Riley's contract: DELETE /v2/account.

Avery's final ruling, with Riley's later status codes:
- Freshness is the ID token auth_time, not a local refresh clock.
- The request body is {"confirm": "DELETE"}.
- 202 returns a top-level jobId. Status is GET /v2/account/deletions/:jobId.
- Terminal states are done and failed. completed is not a status.
- 401 (reauth_required or invalid_token) means sign in again. It never wipes.
- 410 account_deleted carries the jobId. Poll it and wipe only when it is done.
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
STATUS_PREFIX = "/v2/account/deletions/"
JOB_ID = re.compile(r"[A-Za-z0-9_-]{8,80}")


class AccountError(RuntimeError):
    pass


def sign_in_age(claims, now):
    """Seconds since auth_time. A missing claim fails closed."""
    if not isinstance(claims, dict) or "auth_time" not in claims:
        raise AccountError("The ID token is missing auth_time. Sign in again.")
    value = claims.get("auth_time")
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise AccountError("The ID token is missing auth_time. Sign in again.")
    return float(now) - float(value)


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
    return {"action": "request", "method": "DELETE", "path": DELETE_PATH,
            "body": {"confirm": "DELETE"}}


def _reject_foreign_path(body):
    if not isinstance(body, dict):
        return
    for candidate in (body.get("statusPath"),):
        if isinstance(candidate, str) and (not candidate.startswith(STATUS_PREFIX) or ".." in candidate):
            raise AccountError("Account deletion status path is invalid.")
    job = body.get("job")
    if isinstance(job, dict) and isinstance(job.get("statusPath"), str):
        path = job["statusPath"]
        if not path.startswith(STATUS_PREFIX) or ".." in path:
            raise AccountError("Account deletion status path is invalid.")


def server_code(body):
    """Prefer the error field. Fall back to code when a response only has that."""
    if not isinstance(body, dict):
        return ""
    for key in ("error", "code"):
        value = body.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _job_id(body):
    if not isinstance(body, dict):
        return None
    raw = body.get("jobId")
    if JOB_ID.fullmatch(str(raw or "")):
        return str(raw)
    return None


def _with_token(result, body):
    if isinstance(body, dict) and isinstance(body.get("statusToken"), str) and body["statusToken"]:
        result = dict(result)
        result["statusToken"] = body["statusToken"]
    return result


def accept_start(status, body):
    if status == 401:
        return {"action": "reauthenticate",
                "code": server_code(body) or "unauthorized",
                "message": "Sign in again. Local keys and caches were kept."}
    if status == 410 and server_code(body) == "account_deleted":
        job_id = _job_id(body)
        if not job_id:
            raise AccountError("Account deletion did not return a job.")
        return _with_token({"action": "poll", "path": STATUS_PREFIX + job_id}, body)
    if status != 202:
        raise AccountError("Account deletion did not start.")
    _reject_foreign_path(body)
    job_id = _job_id(body)
    if not job_id:
        raise AccountError("Account deletion did not return a job.")
    suggested = body.get("statusPath") if isinstance(body, dict) else None
    if isinstance(suggested, str) and suggested != STATUS_PREFIX + job_id:
        raise AccountError("Account deletion status path is invalid.")
    return _with_token({"action": "poll", "path": STATUS_PREFIX + job_id}, body)


def accept_poll(status, body):
    if status == 401:
        return {"action": "reauthenticate",
                "message": "Sign in again. Local keys and caches were kept."}
    if status != 200 or not isinstance(body, dict):
        raise AccountError("Account deletion status could not be read.")
    state = str(body.get("status") or "")
    if state == "done":
        return {"action": "wipe", "progress": 100, "phase": "done"}
    if state == "failed":
        raise AccountError(str(body.get("failure") or body.get("message") or "Account deletion did not finish.")[:200])
    if state not in {"queued", "running"}:
        raise AccountError("Account deletion returned an unknown status.")
    return {"action": "poll", "phase": state}


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
    print("DELETE /v2/account starts a job. Caches and the Keychain are wiped only after it is done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
