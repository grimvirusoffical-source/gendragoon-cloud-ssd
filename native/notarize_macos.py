#!/usr/bin/env python3
"""Notarize a stopped, separately staged Developer ID-signed Mac application.

Credentials stay in an existing notarytool Keychain profile. A local receipt is
saved before waiting so a subsequent invocation resumes the same submission.
This helper never installs software or deletes an earlier application.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid

BUNDLE_ID = "app.gendragoon.cloudssd"
TEAM_ID = "NZPU8H843J"
APP_NAME = "GenDragoon Cloud SSD.app"
EXECUTABLE = "GenDragoon Cloud SSD"
RESERVE = 10 * 1024**3
RECEIPT_NAME = "gendragoon-notarization-receipt.json"
MAX_RECEIPT_BYTES = 64 * 1024
MAX_BUNDLE_ENTRIES = 100000
PROTECTED_PARTS = {"applications", "system", "library", "bin", "sbin", "usr", "opt", "volumes"}


class NotarizationError(RuntimeError):
    pass


class AppleToolTimeout(NotarizationError):
    pass


def command_result(command, timeout=120, accepted=(0,)):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise AppleToolTimeout("Apple tooling timed out; any saved submission receipt was retained") from None
    except OSError:
        raise NotarizationError("Apple tooling unavailable") from None
    if result.returncode not in accepted:
        # Authentication diagnostics may contain account information. Never
        # echo command arguments, environment variables, or arbitrary stderr.
        raise NotarizationError("Apple tool failed: " + Path(command[0]).name +
                                " (exit " + str(result.returncode) + ")")
    return result


def execute(command, timeout=120, output="stdout"):
    result = command_result(command, timeout=timeout)
    if output == "combined":
        # codesign writes its non-secret signature description to stderr.
        return (result.stdout + "\n" + result.stderr).strip()
    return result.stdout.strip()


def execute_json(command, timeout=120):
    # JSON belongs to stdout. A warning on stderr must not corrupt the result.
    raw = execute(command, timeout=timeout)
    try:
        result = json.loads(raw)
    except (ValueError, TypeError):
        raise NotarizationError("Apple returned an unrecognized notarization result") from None
    if not isinstance(result, dict):
        raise NotarizationError("Apple returned an unrecognized notarization result")
    return result


def staged_path(app):
    """Reject install locations, path aliases, shared files and unsafe staging."""
    app = Path(app).expanduser()
    if not app.is_absolute() or ".." in app.parts or app.name != APP_NAME:
        raise NotarizationError("Supply the absolute path of a separately staged GenDragoon app")
    if any(part.casefold() in PROTECTED_PARTS for part in app.parts[:-1]):
        raise NotarizationError("Installed/system application locations are not staging folders")
    for item in (app, *app.parents):
        if item.is_symlink() or (item != app and item.suffix.casefold() == ".app"):
            raise NotarizationError("Staged paths must not traverse aliases or another app bundle")
    for item in (app, app.parent):
        info = item.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid()
                or info.st_mode & 0o022):
            raise NotarizationError("Use a private staging folder and app owned by the current user")
    count = 0
    for parent, directories, files in os.walk(app, followlinks=False):
        for name in directories + files:
            info = (Path(parent) / name).lstat()
            count += 1
            if (count > MAX_BUNDLE_ENTRIES or info.st_uid != os.getuid()
                    or info.st_mode & 0o022
                    or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))
                    or (stat.S_ISREG(info.st_mode) and info.st_nlink != 1)):
                raise NotarizationError("Unsafe, shared or excessively large staged bundle tree")
    return app


def stopped(app):
    # lsof includes mapped executables and open resources, including helpers.
    # Do not fall back to process-name matching if inspection is incomplete.
    result = command_result(["/usr/sbin/lsof", "-nP", "-Fpn", "+D", str(app)],
                            timeout=30, accepted=(0, 1))
    if result.stderr.strip():
        raise NotarizationError("Could not fully inspect staged app use; quit it before notarization")
    if result.returncode == 0 or result.stdout.strip():
        raise NotarizationError("The staged app is running or in use; quit it before notarization")


def inspect(app):
    if sys.platform != "darwin":
        raise NotarizationError("Requires macOS and Xcode command-line tools")
    app = staged_path(app)
    stopped(app)
    with (app / "Contents" / "Info.plist").open("rb") as source:
        info = plistlib.load(source)
    if (info.get("CFBundleIdentifier") != BUNDLE_ID
            or info.get("CFBundleExecutable") != EXECUTABLE
            or not re.fullmatch(r"\d+\.\d+\.\d+", str(info.get("CFBundleShortVersionString", "")))
            or not str(info.get("CFBundleVersion", "")).isdecimal()):
        raise NotarizationError("Staged bundle metadata does not match GenDragoon")
    requirement = ('anchor apple generic and identifier "' + BUNDLE_ID +
                   '" and certificate leaf[subject.OU] = "' + TEAM_ID +
                   '" and certificate 1[field.1.2.840.113635.100.6.2.6] exists' +
                   ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
    execute(["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", "=" + requirement, str(app)])
    signature = execute(["/usr/bin/codesign", "-dv", "--verbose=4", str(app)], output="combined")
    if (not re.search(r"(?m)^TeamIdentifier=" + TEAM_ID + r"$", signature)
            or "Authority=Developer ID Application:" not in signature
            or not re.search(r"(?m)^Identifier=" + re.escape(BUNDLE_ID) + r"$", signature)):
        raise NotarizationError("Wrong Developer ID signature")
    return app, str(info["CFBundleShortVersionString"]), str(info["CFBundleVersion"])


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024**2), b""):
            value.update(block)
    return value.hexdigest()


def signed_identity(app):
    # Strict/deep codesign validation verifies the sealed resources. Hash their
    # seal plus the signed executable and Info.plist to bind a receipt to this
    # exact signed build, while allowing stapler to attach its ticket.
    return {name: digest(app / name) for name in (
        "Contents/Info.plist", "Contents/MacOS/" + EXECUTABLE,
        "Contents/_CodeSignature/CodeResources")}


def valid_submission_id(value):
    if not isinstance(value, str):
        return False
    try:
        return str(uuid.UUID(value)) == value.lower()
    except ValueError:
        return False


def owned_record(info):
    return (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
            and info.st_nlink == 1 and not info.st_mode & 0o077)


@contextmanager
def receipt_lock(path):
    descriptor = os.open(str(path) + ".lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        if not owned_record(os.fstat(descriptor)):
            raise NotarizationError("Unsafe notarization receipt lock")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise NotarizationError("Another notarization operation is already using this receipt") from None
        yield
    finally:
        os.close(descriptor)


def read_receipt(path):
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    try:
        info = os.fstat(descriptor)
        if not owned_record(info) or info.st_size > MAX_RECEIPT_BYTES:
            raise NotarizationError("Unsafe notarization receipt")
        raw = os.read(descriptor, MAX_RECEIPT_BYTES + 1)
    finally:
        os.close(descriptor)
    try:
        result = json.loads(raw)
    except (ValueError, UnicodeError):
        raise NotarizationError("Invalid notarization receipt; it was retained for inspection") from None
    if not isinstance(result, dict):
        raise NotarizationError("Invalid notarization receipt; it was retained for inspection")
    return result


def write_receipt(path, record):
    record["updatedAt"] = datetime.now(timezone.utc).isoformat()
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as target:
            json.dump(record, target, sort_keys=True, indent=2)
            target.write("\n")
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def validate_receipt(record, app, version, build, identity):
    if (record.get("schema") != 1 or record.get("app") != str(app)
            or record.get("version") != version or record.get("build") != build
            or record.get("signedIdentity") != identity
            or not re.fullmatch(r"[a-f0-9]{64}", str(record.get("archiveSha256", "")))
            or record.get("state") not in {"prepared", "submitting", "submitted", "accepted", "rejected", "complete"}):
        raise NotarizationError("Receipt does not match this signed staging build; no submission was started")
    identifier = record.get("submissionId")
    if record["state"] in {"prepared", "submitting"} and identifier is not None:
        raise NotarizationError("Contradictory submission state in retained notarization receipt")
    if identifier is not None and not valid_submission_id(identifier):
        raise NotarizationError("Invalid submission ID in retained notarization receipt")
    if record["state"] in {"submitted", "accepted", "rejected", "complete"} and not identifier:
        raise NotarizationError("Retained notarization receipt is missing its submission ID")


def pending(record, receipt, reason="still_processing"):
    return {"version": record["version"], "build": record["build"], "signed": True,
            "notarized": False, "status": "pending", "reason": reason,
            "submissionId": record["submissionId"], "receipt": str(receipt),
            "resume": "Run the same command again to check this submission without uploading again"}


def await_submission(record, receipt, profile, wait_seconds):
    deadline = time.monotonic() + wait_seconds
    identifier = record["submissionId"]
    while True:
        try:
            result = execute_json(["/usr/bin/xcrun", "notarytool", "info", identifier,
                                   "--keychain-profile", profile, "--output-format", "json"], timeout=30)
        except AppleToolTimeout:
            return pending(record, receipt, "status_check_timed_out")
        if result.get("id") != identifier:
            raise NotarizationError("Apple returned a different submission ID; receipt retained")
        status = result.get("status")
        if status == "Accepted":
            record.update(state="accepted", status=status)
            write_receipt(receipt, record)
            return None
        if status in {"Invalid", "Rejected"}:
            record.update(state="rejected", status=status)
            write_receipt(receipt, record)
            raise NotarizationError("Notarization was not accepted; inspect the retained submission ID with notarytool log")
        if status != "In Progress":
            raise NotarizationError("Apple returned an unrecognized submission status; receipt retained")
        if time.monotonic() >= deadline:
            return pending(record, receipt)
        time.sleep(min(5, max(0, deadline - time.monotonic())))


def validate_ticket(app):
    execute(["/usr/bin/xcrun", "stapler", "validate", str(app)], timeout=120)
    execute(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", str(app)], timeout=120)


def notarize(app, profile, check_only=False, receipt=None, wait_seconds=60):
    app, version, build = inspect(app)
    if check_only:
        return {"version": version, "build": build, "signed": True,
                "notarized": False, "mode": "source_preflight_only",
                "freeGiB": round(shutil.disk_usage(app.parent).free / 1024**3, 2)}
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", profile or ""):
        raise NotarizationError("Specify the name of an existing notarytool Keychain profile")
    if not isinstance(wait_seconds, int) or not 0 <= wait_seconds <= 3600:
        raise NotarizationError("Wait seconds must be an integer between 0 and 3600")
    receipt = Path(receipt).expanduser() if receipt is not None else app.parent / RECEIPT_NAME
    if (not receipt.is_absolute() or receipt.parent != app.parent
            or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.json", receipt.name)):
        raise NotarizationError("Keep the JSON receipt beside the staged app, outside its bundle")
    identity = signed_identity(app)
    app_bytes = sum(p.stat().st_size for p in app.rglob("*") if p.is_file())
    required = RESERVE + max(256 * 1024**2, app_bytes * 2)
    if shutil.disk_usage(app.parent).free < required:
        raise NotarizationError("Notarization postponed: insufficient free storage above 10 GiB reserve")
    with receipt_lock(receipt):
        record = read_receipt(receipt)
        if record is not None:
            validate_receipt(record, app, version, build, identity)
            if record["state"] == "submitting" and not record.get("submissionId"):
                raise NotarizationError("Previous upload outcome is uncertain; inspect notarytool history and reconcile the recorded archive hash before retrying. No new upload was started")
            if record["state"] == "rejected":
                raise NotarizationError("This submission was not accepted; inspect its log and build a corrected candidate in a new staging folder")
        if record is None or record["state"] == "prepared":
            # Validate the existing profile before allocating the submission ZIP.
            execute(["/usr/bin/xcrun", "notarytool", "history", "--keychain-profile", profile], timeout=60)
            with tempfile.TemporaryDirectory(prefix="gd-notary-", dir=app.parent) as location:
                archive = Path(location) / "GenDragoon-notary-upload.zip"
                execute(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive)], timeout=240)
                inspect(app)
                if signed_identity(app) != identity:
                    raise NotarizationError("Staged application changed while preparing notarization")
                record = {"schema": 1, "app": str(app), "version": version, "build": build,
                          "signedIdentity": identity, "archiveSha256": digest(archive),
                          "archiveBytes": archive.stat().st_size, "state": "prepared",
                          "submissionId": None}
                write_receipt(receipt, record)
                # If submit itself has an ambiguous outcome, this durable marker
                # prevents an automatic second upload on the next invocation.
                record["state"] = "submitting"
                write_receipt(receipt, record)
                result = execute_json(["/usr/bin/xcrun", "notarytool", "submit", str(archive),
                                       "--keychain-profile", profile, "--output-format", "json"], timeout=300)
                identifier = result.get("id")
                if not valid_submission_id(identifier):
                    raise NotarizationError("Apple did not return a valid submission ID; reconcile the retained receipt before retrying")
                record.update(state="submitted", submissionId=str(uuid.UUID(identifier)))
                # Save and fsync the ID before checking or waiting for completion.
                write_receipt(receipt, record)
        if record["state"] != "complete":
            outcome = await_submission(record, receipt, profile, wait_seconds)
            if outcome is not None:
                return outcome
            # Recheck the exact signed build and its stopped state immediately
            # before stapling. Receipt identity remains stable across stapling.
            inspect(app)
            if signed_identity(app) != identity:
                raise NotarizationError("Staged application changed after submission; it was not stapled")
            execute(["/usr/bin/xcrun", "stapler", "staple", str(app)], timeout=180)
        validate_ticket(app)
        inspect(app)
        if signed_identity(app) != identity:
            raise NotarizationError("Signed application identity changed during ticket validation")
        record["state"] = "complete"
        write_receipt(receipt, record)
        return {"version": version, "build": build, "signed": True, "status": "complete",
                "notarized": True, "stapled": True, "gatekeeperAccepted": True,
                "submissionId": record["submissionId"], "receipt": str(receipt)}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--app", type=Path, required=True)
    ap.add_argument("--keychain-profile", default="")
    ap.add_argument("--check-only", action="store_true")
    ap.add_argument("--receipt", type=Path, help="JSON receipt beside the staged app; reused to resume")
    ap.add_argument("--wait-seconds", type=int, default=60,
                    help="Status polling window, 0–3600 seconds; 0 checks once (default: 60)")
    args = ap.parse_args(argv)
    try:
        result = notarize(args.app, args.keychain_profile, args.check_only,
                          receipt=args.receipt, wait_seconds=args.wait_seconds)
        print(json.dumps(result, sort_keys=True))
        return 2 if result.get("status") == "pending" else 0
    except (NotarizationError, OSError, ValueError, plistlib.InvalidFileException) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
