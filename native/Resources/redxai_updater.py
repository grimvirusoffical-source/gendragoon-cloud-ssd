#!/usr/bin/env python3
"""Red-XAI Updater.

Watches release feeds for grim's apps, starting with GenDragoon Cloud SSD.
When an update is already downloaded and ready, quit that app, replace it, and
relaunch it. Additional apps are entries in grim-apps-manifest.json.
"""
import argparse
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


class RedXAIUpdateFailed(RuntimeError):
    """The update did not install. The previous version was restored and relaunched."""


class RedXAIRelaunchFailed(RuntimeError):
    """Neither the new nor the restored previous version could be relaunched.
    The previous bundle is left in place at the install path."""


def _log(log, event, **fields):
    record = {"event": event, **{key: str(value) for key, value in fields.items()}}
    if log is not None:
        log(record)
    else:
        print(json.dumps(record), file=sys.stderr, flush=True)


def _discard(path, log):
    """Remove a half-installed bundle that is not the previous version."""
    import shutil
    import uuid
    if not os.path.lexists(path):
        return
    aside = path.with_name(path.name + ".redxai-failed-" + uuid.uuid4().hex)
    os.replace(path, aside)
    try:
        if aside.is_dir() and not aside.is_symlink():
            shutil.rmtree(aside)
        else:
            aside.unlink()
    except OSError as error:
        _log(log, "redxai_cleanup_failed", path=aside, error=error)


def install_path(entry):
    return Path(os.path.expanduser(entry["installPath"]))


def apply_ready_update(entry, staged, *, quit_app, replace_app, relaunch_app, log=None):
    """Quit, replace, and relaunch one app whose update is already on disk.

    The installed bundle is moved aside first. If the replacement or the new
    version's relaunch fails, the previous bundle is put back and relaunched,
    so the app is never left quit. ``relaunch_app(entry, path)`` gets the path
    of the bundle that is actually installed at that moment.
    """
    if not isinstance(entry, dict) or "bundleId" not in entry or "installPath" not in entry:
        raise ValueError("Choose a manifest app before applying an update")
    staged = Path(staged)
    if not staged.is_file():
        raise ValueError("A downloaded update package is required")
    app = install_path(entry)
    if app.is_symlink() or not app.is_dir():
        raise ValueError("The installed app was not found; nothing was changed")
    import uuid
    previous = app.with_name(app.name + ".redxai-previous-" + uuid.uuid4().hex)
    quit_app(entry)
    failure = None
    moved = False
    try:
        os.replace(app, previous)
        moved = True
        replace_app(entry, staged)
        if app.is_symlink() or not app.is_dir():
            raise RuntimeError("The update did not install an app bundle")
    except Exception as error:
        failure = error
        _log(log, "redxai_install_failed", app=app, error=error)
    if failure is None:
        try:
            result = relaunch_app(entry, app)
        except Exception as error:
            failure = error
            _log(log, "redxai_relaunch_new_failed", app=app, error=error)
        else:
            import shutil
            try:
                shutil.rmtree(previous)
            except OSError as error:
                _log(log, "redxai_cleanup_failed", path=previous, error=error)
            return result
    # Roll back: discard whatever was installed, restore the previous bundle, relaunch it.
    try:
        if moved:
            _discard(app, log)
            os.replace(previous, app)
            _log(log, "redxai_restored_previous", app=app)
        relaunch_app(entry, app)
    except Exception as error:
        _log(log, "redxai_relaunch_previous_failed", app=app, error=error)
        raise RedXAIRelaunchFailed("The update failed and the previous version could not be relaunched. "
                                   "It is still installed at " + str(app)) from error
    raise RedXAIUpdateFailed("The update failed. The previous version was restored and relaunched.") from failure


def apply_and_report(entry, staged, *, quit_app, replace_app, relaunch_app, log=None):
    """Exit status for the Red-XAI process: 0 updated and relaunched, 1 update failed but
    the previous version was restored and relaunched, 2 nothing could be relaunched."""
    try:
        apply_ready_update(entry, staged, quit_app=quit_app, replace_app=replace_app,
                           relaunch_app=relaunch_app, log=log)
    except RedXAIRelaunchFailed as error:
        _log(log, "redxai_attention", message=error)
        return 2
    except (RedXAIUpdateFailed, ValueError) as error:
        _log(log, "redxai_update_failed", message=error)
        return 1
    return 0


def offer_relaunch(app):
    """Relaunch through the companion bundle. Never returns None."""
    app = Path(app)
    companion = app / "Contents/Resources/Red-XAI Updater.app"
    if companion.is_symlink():
        raise RuntimeError("Red-XAI Updater must be a real bundle, not a symlink")
    if not companion.is_dir():
        raise RuntimeError("Red-XAI Updater is not installed beside this app")
    info = companion / "Contents/Info.plist"
    if not info.is_file() or info.is_symlink():
        raise RuntimeError("Red-XAI Updater bundle is incomplete")
    if platform.system() != "Darwin":
        raise RuntimeError("Red-XAI Updater can relaunch only on macOS")
    import plistlib
    bundle_id = plistlib.loads(info.read_bytes()).get("CFBundleIdentifier")
    if bundle_id != "app.gendragoon.redxai.updater":
        raise RuntimeError("Red-XAI Updater bundle id does not match")
    import subprocess
    verified = subprocess.run(["/usr/bin/codesign", "--verify", "--strict", str(companion)], capture_output=True)
    if verified.returncode != 0:
        raise RuntimeError("Red-XAI Updater failed codesign verification")
    launched = subprocess.run(["/usr/bin/open", "-n", str(app)], capture_output=True)
    if launched.returncode != 0:
        raise RuntimeError("Red-XAI Updater could not relaunch the app")
    return [app]


def main(argv=None):
    parser = argparse.ArgumentParser(description="Red-XAI relaunches a ready update when GenDragoon cannot relaunch itself.")
    parser.add_argument("action", nargs="?", choices=("show",), default="show")
    parser.parse_args(argv)
    print("Red-XAI relaunches a ready update from grim-apps-manifest.json.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
