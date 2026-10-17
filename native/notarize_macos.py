#!/usr/bin/env python3
"""Notarize a separate, Developer ID-signed staging bundle, never the installed app.

Credentials must be stored in the current user's Apple Keychain with
"xcrun notarytool store-credentials PROFILE". No .p8 file or password is read
by this helper. This tool does not package releases or install anything.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import tempfile

BUNDLE_ID = "app.gendragoon.cloudssd"
TEAM_ID = "NZPU8H843J"
APP_NAME = "GenDragoon Cloud SSD.app"
RESERVE = 10 * 1024**3

class NotarizationError(RuntimeError):
    pass

def execute(command, timeout=120):
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise NotarizationError("Apple tooling unavailable or timed out") from exc
    if result.returncode:
        # Do not reproduce arbitrary authentication diagnostics, command lines,
        # environment variables or Keychain contents in release logs.
        raise NotarizationError("Apple tool failed: " + Path(command[0]).name +
                                " (exit " + str(result.returncode) + ")")
    return (result.stdout + "\n" + result.stderr).strip()

def inspect(app):
    if sys.platform != "darwin":
        raise NotarizationError("Requires macOS and Xcode command-line tools")
    app = Path(app).expanduser().absolute()
    installed = (Path.home() / "Applications" / APP_NAME).absolute()
    if app == installed or app.resolve() == installed.resolve():
        raise NotarizationError("Refusing to mutate the existing installed application")
    if app.is_symlink() or not app.is_dir() or app.name != APP_NAME:
        raise NotarizationError("Provide a separate staged GenDragoon app bundle")
    with (app / "Contents" / "Info.plist").open("rb") as source:
        info = plistlib.load(source)
    if (info.get("CFBundleIdentifier") != BUNDLE_ID
            or not re.fullmatch(r"\d+\.\d+\.\d+", str(info.get("CFBundleShortVersionString", "")))
            or not str(info.get("CFBundleVersion", "")).isdecimal()):
        raise NotarizationError("Staged bundle metadata does not match GenDragoon")
    requirement = ('anchor apple generic and identifier "' + BUNDLE_ID +
                   '" and certificate leaf[subject.OU] = "' + TEAM_ID +
                   '" and certificate 1[field.1.2.840.113635.100.6.2.6] exists' +
                   ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
    execute(["/usr/bin/codesign", "--verify", "--deep", "--strict", "-R", "=" + requirement, str(app)])
    signature = execute(["/usr/bin/codesign", "-dv", "--verbose=4", str(app)])
    if (not re.search(r"(?m)^TeamIdentifier=" + TEAM_ID + r"$", signature)
            or "Authority=Developer ID Application:" not in signature
            or not re.search(r"(?m)^Identifier=" + re.escape(BUNDLE_ID) + r"$", signature)):
        raise NotarizationError("Wrong Developer ID signature")
    return app, str(info["CFBundleShortVersionString"]), str(info["CFBundleVersion"])

def notarize(app, profile, check_only=False):
    app, version, build = inspect(app)
    if check_only:
        return {"version": version, "build": build, "signed": True,
                "notarized": False, "mode": "source_preflight_only",
                "freeGiB": round(shutil.disk_usage(app.parent).free / 1024**3, 2)}
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,79}", profile or ""):
        raise NotarizationError("Specify the name of an existing notarytool Keychain profile")
    # A zipped upload and the notarization workspace must never consume the
    # minimum 10 GiB free reserve. No automatic disk cleanup is performed.
    app_bytes = sum(p.stat().st_size for p in app.rglob("*") if p.is_file())
    required = RESERVE + max(256 * 1024**2, app_bytes * 2)
    if shutil.disk_usage(app.parent).free < required:
        raise NotarizationError("Notarization postponed: insufficient free storage above 10 GiB reserve")
    # Validate credentials before allocating disk, without reading any key file.
    execute(["/usr/bin/xcrun", "notarytool", "history", "--keychain-profile", profile], timeout=60)
    with tempfile.TemporaryDirectory(prefix="gd-notary-", dir=app.parent) as location:
        archive = Path(location) / "GenDragoon-notary-upload.zip"
        execute(["/usr/bin/ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive)], timeout=240)
        raw = execute(["/usr/bin/xcrun", "notarytool", "submit", str(archive),
                       "--keychain-profile", profile, "--wait", "--output-format", "json"], timeout=3600)
        try:
            result = json.loads(raw)
        except ValueError as exc:
            raise NotarizationError("Apple returned an unrecognized notarization result") from exc
        if result.get("status") != "Accepted":
            raise NotarizationError("Notarization was not accepted; inspect the submission log in Apple's portal")
    # Stapling changes only the explicitly staged app, not the user's installation.
    execute(["/usr/bin/xcrun", "stapler", "staple", str(app)], timeout=180)
    execute(["/usr/bin/xcrun", "stapler", "validate", str(app)], timeout=120)
    execute(["/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", str(app)], timeout=120)
    inspect(app)
    return {"version": version, "build": build, "signed": True,
            "notarized": True, "stapled": True, "gatekeeperAccepted": True,
            "submissionId": str(result.get("id") or "")}

def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--app", type=Path, required=True)
    ap.add_argument("--keychain-profile", default="")
    ap.add_argument("--check-only", action="store_true")
    args = ap.parse_args(argv)
    try:
        print(json.dumps(notarize(args.app, args.keychain_profile, args.check_only), sort_keys=True))
        return 0
    except (NotarizationError, OSError, ValueError, plistlib.InvalidFileException) as exc:
        print(json.dumps({"status": "blocked", "error": str(exc)}), file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
