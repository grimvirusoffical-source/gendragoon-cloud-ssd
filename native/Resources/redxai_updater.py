#!/usr/bin/env python3
"""Red-XAI Updater.

Watches release feeds for grim's apps, starting with GenDragoon Cloud SSD.
When an update is already downloaded and ready, quit that app, replace it, and
relaunch it. Additional apps are entries in grim-apps-manifest.json.
"""
import json
import os
import platform
import sys
from pathlib import Path

sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

ROOT = Path(__file__).absolute().parent
MANIFEST = ROOT / "grim-apps-manifest.json"


def load_manifest(path=None):
    raw = json.loads(Path(path or MANIFEST).read_text())
    apps = raw.get("apps") if isinstance(raw, dict) else None
    if not isinstance(apps, list) or not apps:
        raise ValueError("Red-XAI manifest needs at least one app")
    required = ("bundleId", "appName", "repo", "zipPrefix", "installPath", "channel")
    for entry in apps:
        if not isinstance(entry, dict) or any(not isinstance(entry.get(key), str) or not entry[key] for key in required):
            raise ValueError("Red-XAI manifest entry is incomplete")
        if entry["bundleId"] != entry["bundleId"].strip() or " " in entry["repo"]:
            raise ValueError("Red-XAI manifest entry is invalid")
    if apps[0]["bundleId"] != "app.gendragoon.cloudssd":
        raise ValueError("GenDragoon Cloud SSD must be the first watched app")
    return apps


def apply_ready_update(entry, staged, *, quit_app, replace_app, relaunch_app):
    """Quit, replace, and relaunch one app whose update is already on disk."""
    if not isinstance(entry, dict) or "bundleId" not in entry:
        raise ValueError("Choose a manifest app before applying an update")
    staged = Path(staged)
    if not staged.is_file():
        raise ValueError("A downloaded update package is required")
    quit_app(entry)
    replace_app(entry, staged)
    return relaunch_app(entry)


def offer_relaunch(app):
    """Ask the companion to relaunch. Tests and Linux return None so the caller keeps its own error."""
    if platform.system() != "Darwin":
        return None
    companion = Path(app) / "Contents/Resources/Red-XAI Updater.app"
    if not companion.is_dir() or companion.is_symlink():
        return None
    return None
