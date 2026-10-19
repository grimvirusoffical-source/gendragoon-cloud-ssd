#!/usr/bin/env python3
"""Upgrade the EXISTING GenDragoon Cloud SSD.app in place. No second app.

Requires macOS, an existing v0.2 installation, Xcode CLT's Swift compiler.
Keeps rclone, settings, auth, cache and data unchanged. Rolls back on failure.
"""
from pathlib import Path
import os
import plistlib
import platform
import shutil
import subprocess
import sys
import tempfile
import time

VERSION = "0.16.2"
BASE = Path(__file__).resolve().parent
APP = Path.home() / "Applications" / "GenDragoon Cloud SSD.app"
SUPPORT = Path.home() / "Library" / "Application Support" / "GenDragoon Cloud SSD"
BACKUP = SUPPORT / "Previous-App-Backup" / "GenDragoon Cloud SSD.app"
SOURCE = BASE / "Sources" / "GenDragoonApp.swift"
NEW_SCRIPTS = {
    "gendragoon_auto_update.py": BASE / "Resources" / "gendragoon_auto_update.py",
    "gendragoon_connect.py": BASE / "Resources" / "gendragoon_connect.py",
    "gendragoon_library.py": BASE / "Resources" / "gendragoon_library.py",
    "gendragoon_stream.py": BASE / "Resources" / "gendragoon_stream.py",
    "gendragoon_preload.py": BASE / "Resources" / "gendragoon_preload.py",
    "gendragoon_terms.txt": BASE / "Resources" / "gendragoon_terms.txt",
    "gendragoon_privacy.txt": BASE / "Resources" / "gendragoon_privacy.txt",
    "gendragoon_firebase_public.json": BASE / "Resources" / "gendragoon_firebase_public.json",
    "gendragoon_login_bridge.js": BASE / "Resources" / "gendragoon_login_bridge.js",
    "gendragoon_free_api.json": BASE / "Resources" / "gendragoon_free_api.json",
    "gendragoon_node": Path("/usr/local/bin/node"),
}


def run(args, *, timeout=180):
    print("    Executing:", Path(args[0]).name, "(working)", flush=True)
    proc = subprocess.run([str(x) for x in args], stdout=subprocess.PIPE,
                          stderr=subprocess.STDOUT, text=True, timeout=timeout)
    if proc.returncode:
        raise RuntimeError(f"{Path(args[0]).name} exited {proc.returncode}:\n" + proc.stdout[-3200:])
    return proc.stdout


def validate_existing():
    if platform.system() != "Darwin":
        raise RuntimeError("This updater must run on the Mac that has GenDragoon installed.")
    if not APP.is_dir() or not (APP / "Contents" / "MacOS" / "GenDragoon Cloud SSD").is_file():
        raise RuntimeError("Existing GenDragoon app not found at " + str(APP) + ". This patch will NOT create a duplicate installation.")
    if not (APP / "Contents" / "Resources" / "rclone").is_file():
        raise RuntimeError("Existing GenDragoon installation is missing rclone; refusing to overwrite it.")
    for f in [SOURCE, *NEW_SCRIPTS.values()]:
        if not f.is_file():
            raise RuntimeError("Updater file missing: " + str(f))
    swiftc = shutil.which("swiftc") or "/usr/bin/swiftc"
    if not shutil.which("swiftc") and not Path(swiftc).exists():
        raise RuntimeError("Swift compiler missing. Install Xcode Command Line Tools: xcode-select --install")
    mounted = run(["/sbin/mount"]).splitlines()
    mountpoint = str(Path.home() / "GenDragoon Cloud SSD")
    if any(" on " + mountpoint + " " in line for line in mounted):
        raise RuntimeError("Your cloud SSD is mounted. First choose Unmount in GenDragoon, then quit it, then re-run the updater.")
    running = run(["/bin/ps", "-axo", "command"]).splitlines()
    exe = str(APP / "Contents" / "MacOS" / "GenDragoon Cloud SSD")
    if any(line.strip().startswith(exe) for line in running):
        raise RuntimeError("GenDragoon is still running. Quit the app (Command-Q) before upgrading; then re-run this updater.")
    return swiftc


def clean_obsolete_installers():
    """Move only confirmed old GenDragoon installers to macOS Trash.

    This is recoverable until Trash is emptied. Never touch installed apps,
    Keychain, rclone configuration, caches, cloud mount, or unrelated files.
    """
    downloads = Path.home() / "Downloads"
    folders = {
        "GenDragoon-Cloud-SSD-v0.1": "Install.command",
        "GenDragoon-Cloud-SSD-v0.2": "Install.command",
        "GenDragoon-InPlace-Updater-v0.3": "UpgradeGenDragoon.py",
    }
    files = {
        "GenDragoon-Cloud-SSD-Mac-v0.1.zip",
        "GenDragoon-Cloud-SSD-Mac-v0.2.zip",
        "GenDragoon-InPlace-Updater-v0.3.zip",
    }
    trashed = []
    trash = Path.home() / ".Trash"
    trash.mkdir(mode=0o700, exist_ok=True)
    candidates = []
    for dirname, witness in folders.items():
        path = downloads / dirname
        if path.is_dir() and not path.is_symlink() and (path / witness).is_file():
            candidates.append(path)
    for filename in files:
        path = downloads / filename
        if path.is_file() and not path.is_symlink():
            candidates.append(path)
    for path in candidates:
        destination = trash / path.name
        suffix = 1
        while destination.exists():
            destination = trash / (path.name + f".old-{suffix}")
            suffix += 1
        try:
            shutil.move(str(path), str(destination))
            trashed.append(path.name)
        except OSError as exc:
            print("Could not move obsolete installer to Trash:", path.name, exc)
    print("Old installer downloads moved to Trash:", ", ".join(sorted(trashed)) if trashed else "none found")


def validate_transfer_backend():
    """Do not install a v3-only client against an old deployed service."""
    import json, ssl, urllib.request
    config=json.loads((BASE / "Resources" / "gendragoon_free_api.json").read_text())
    endpoint=config["endpoint"].rstrip("/")
    if not endpoint.startswith("https://") or not endpoint.split("/")[2].endswith(".run.app"):
        raise RuntimeError("Unexpected cloud endpoint; update stopped safely.")
    try:
        context=ssl.create_default_context(cafile="/etc/ssl/cert.pem")
        with urllib.request.urlopen(endpoint+"/v3/capabilities",context=context,timeout=15) as response:
            capabilities=json.load(response)
        if capabilities.get("protocol")!=3 or capabilities.get("parallelChunks") is not True:
            raise ValueError("v3 transfer protocol missing")
    except Exception:
        raise RuntimeError("The new transfer backend has not been verified live. Deploy and verify it before installing v0.16.0. Your installed app has not been changed.") from None


def main():
    print("\n╔════════════════════════════════════════════════════╗")
    print("    GenDragoon Cloud SSD • IN-PLACE Updater v" + VERSION)
    print("╚════════════════════════════════════════════════════╝\n")
    print("Target:", APP)
    print("No extra .app will be installed.\n")
    validate_transfer_backend()
    swiftc = validate_existing()
    SUPPORT.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="GenDragoon-Upgrade-", dir=str(APP.parent)) as temp:
        stage = Path(temp) / APP.name
        print("[1/5] Cloning your existing app to a temporary build area…", flush=True)
        shutil.copytree(APP, stage, symlinks=True)
        print("[2/5] Rebuilding the native SwiftUI app (Opera connections and selectors)…", flush=True)
        exe = stage / "Contents" / "MacOS" / "GenDragoon Cloud SSD"
        run([swiftc, "-parse-as-library", "-O", "-target", "arm64-apple-macosx14.0", "-framework", "SwiftUI",
             "-framework", "AppKit", "-o", str(exe), str(SOURCE), str(BASE / "Sources" / "GenDragoonCommercialUI.swift"), str(BASE / "Sources" / "GenDragoonTermsGate.swift"), str(BASE / "Sources" / "GenDragoonStartupRoot.swift"), str(BASE / "Sources" / "GenDragoonAds.swift"), str(BASE / "Sources" / "GenDragoonCustomerCloud.swift"), str(BASE / "Sources" / "GenDragoonIntegration.swift"), str(BASE / "Sources" / "GenDragoonAutoUpdate.swift"),
             str(BASE / "Sources" / "GenDragoonStripePurchases.swift"), str(BASE / "Sources" / "GDTransferClient.swift")], timeout=500)
        # Remove retired GitHub login/publisher resources from distributed builds.
        for retired in ("gendragoon_updates.py","release-repo.json"):
            old = stage / "Contents" / "Resources" / retired
            if old.is_file(): old.unlink()
        for name, src in NEW_SCRIPTS.items():
            dest = stage / "Contents" / "Resources" / name
            shutil.copy2(src, dest)
            dest.chmod(0o755)
        info = stage / "Contents" / "Info.plist"
        with info.open("rb") as f:
            plist = plistlib.load(f)
        plist["CFBundleShortVersionString"] = VERSION
        plist["CFBundleVersion"] = "19"
        plist["LSMinimumSystemVersion"] = "14.0"
        with info.open("wb") as f:
            plistlib.dump(plist, f)
        print("[3/5] Re-signing and verifying your updated app locally…", flush=True)
        # Notarization checks every bundled Mach-O, not only the main executable.
        identity = "Developer ID Application: Joshua Franklin (NZPU8H843J)"
        node_entitlements = Path(temp) / "node-entitlements.plist"
        node_entitlements.write_bytes(plistlib.dumps({
            "com.apple.security.cs.allow-jit": True,
            "com.apple.security.cs.allow-unsigned-executable-memory": True,
        }))
        for helper in ("rclone", "gendragoon_node"):
            signing = ["/usr/bin/codesign", "--force", "--options", "runtime", "--timestamp", "--sign", identity]
            if helper == "gendragoon_node":
                signing += ["--entitlements", str(node_entitlements)]
            run(signing + [str(stage / "Contents" / "Resources" / helper)], timeout=180)
        run(["/usr/bin/codesign", "--force", "--deep", "--options", "runtime", "--timestamp",
             "--sign", "Developer ID Application: Joshua Franklin (NZPU8H843J)", str(stage)], timeout=200)
        run(["/usr/bin/codesign", "--verify", "--deep", "--strict", str(stage)], timeout=60)
        # Protect existing app until ALL risky build work succeeded.
        print("[4/5] Replacing the existing app, with rollback protection…", flush=True)
        BACKUP.parent.mkdir(parents=True, exist_ok=True)
        old_backup = None
        if BACKUP.exists():
            old_backup = BACKUP.parent / "previous-backup-to-remove.app"
            if old_backup.exists():
                shutil.rmtree(old_backup)
            os.replace(BACKUP, old_backup)
        old_moved = False
        try:
            os.replace(APP, BACKUP)
            old_moved = True
            os.replace(stage, APP)
        except BaseException:
            if old_moved and not APP.exists():
                os.replace(BACKUP, APP)
            if old_backup and old_backup.exists() and not BACKUP.exists():
                os.replace(old_backup, BACKUP)
            raise
        if old_backup and old_backup.exists():
            shutil.rmtree(old_backup)
    print("[5/5] Installed v" + VERSION + " in the SAME Applications location.")
    clean_obsolete_installers()
    print("Original v0.2 backup (not an extra active app):", BACKUP)
    print("Your cloud cache, Google credentials, GitHub login, and settings were not changed.")
    print("Opening existing GenDragoon…\n")
    try:
        subprocess.Popen(["/usr/bin/open", str(APP)])
    except OSError:
        print("Open the app yourself from ~/Applications/GenDragoon Cloud SSD.app")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, subprocess.TimeoutExpired) as exc:
        print("\nUPDATE STOPPED SAFELY:", str(exc), file=sys.stderr)
        sys.exit(1)
