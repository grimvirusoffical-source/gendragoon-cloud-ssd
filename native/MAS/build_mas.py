#!/usr/bin/env python3
"""Prepare (and, on a Mac with YOUR identities, sign) a Mac App Store build of the Mac app. NEVER uploads or submits anything.

  python3 native/MAS/build_mas.py --plan                  # any OS: validate config and print what a real build would do
  python3 native/MAS/build_mas.py --base-app <app> --output <dir>   # macOS only; needs the env vars below

Env for a real build (nothing is stored in this repo):
  GD_MAS_TEAM_ID, GD_MAS_APP_IDENTITY ("3rd Party Mac Developer Application: ..." / "Apple Distribution: ..."),
  GD_MAS_INSTALLER_IDENTITY ("3rd Party Mac Developer Installer: ..." / "Mac Installer Distribution: ..."),
  GD_MAS_PROVISIONING_PROFILE (path to the Mac App Store .provisionprofile)

What this build changes versus the Developer ID build:
  * gendragoon_distribution.json = {"distribution": "mas"}  -> every self-update path is disabled and the update UI is hidden.
  * App Sandbox entitlements; helpers get the inherit sandbox. See MAS_CONSTRAINTS.md for what cannot work in the sandbox.
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

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parent
BUNDLE_ID = "app.gendragoon.cloudssd"
NAME = "GenDragoon Cloud SSD.app"
HELPERS = {"rclone": "GenDragoon-MAS-child.entitlements", "gendragoon_node": "GenDragoon-MAS-node.entitlements"}
REQUIRED_ENV = ("GD_MAS_TEAM_ID", "GD_MAS_APP_IDENTITY", "GD_MAS_INSTALLER_IDENTITY", "GD_MAS_PROVISIONING_PROFILE")


def load_entitlements(name, team_id="TEAMID1234"):
    text = (HERE / name).read_bytes().decode("utf8").replace("$(TEAM_ID)", team_id).replace("$(BUNDLE_ID)", BUNDLE_ID)
    return plistlib.loads(text.encode("utf8"))


def validate():
    problems = []
    app = load_entitlements("GenDragoon-MAS.entitlements")
    if app.get("com.apple.security.app-sandbox") is not True:
        problems.append("app entitlements must enable the App Sandbox")
    for forbidden in ("com.apple.security.cs.disable-library-validation", "com.apple.security.temporary-exception.files.absolute-path.read-write",
                      "com.apple.security.files.all", "com.apple.security.cs.allow-dyld-environment-variables"):
        if forbidden in app:
            problems.append("forbidden entitlement in app: " + forbidden)
    for name in HELPERS.values():
        ent = load_entitlements(name)
        if ent.get("com.apple.security.inherit") is not True or ent.get("com.apple.security.app-sandbox") is not True:
            problems.append(name + " must be sandboxed with inherit")
    dist = json.loads((NATIVE / "Resources/gendragoon_distribution.json").read_text())
    if dist.get("distribution") != "direct":
        problems.append("the shared Resources/gendragoon_distribution.json must stay 'direct'; this script writes 'mas' only into the staged MAS bundle")
    return problems


def plan():
    return {
        "bundleId": BUNDLE_ID,
        "distributionResource": {"distribution": "mas"},
        "sandboxedHelpers": sorted(HELPERS),
        "steps": ["copy base app", "write gendragoon_distribution.json=mas", "embed provisioning profile", "codesign helpers with inherit entitlements",
                  "codesign app with sandbox entitlements", "productbuild .pkg signed with the installer identity", "(manual) validate + upload with Transporter/altool by the account holder"],
        "notDone": "no build, signing, upload or submission is performed by this script unless run on macOS with the env vars set",
    }


def run(args):
    result = subprocess.run([str(x) for x in args], capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(Path(args[0]).name + " failed:\n" + result.stderr[-4000:])
    return result.stdout


def build(base, output):
    if sys.platform != "darwin":
        raise RuntimeError("A real MAS build needs macOS and Xcode tools")
    missing = [v for v in REQUIRED_ENV if not os.environ.get(v)]
    if missing:
        raise RuntimeError("Missing env: " + ", ".join(missing))
    team = os.environ["GD_MAS_TEAM_ID"]
    if not re.fullmatch(r"[A-Z0-9]{10}", team):
        raise RuntimeError("GD_MAS_TEAM_ID must be the 10-character Apple team id")
    problems = validate()
    if problems:
        raise RuntimeError("Config problems: " + "; ".join(problems))
    output.mkdir(parents=True, exist_ok=True)
    app = output / NAME
    if app.exists():
        raise RuntimeError("Output bundle already exists; use a fresh folder")
    run(["/bin/cp", "-cR", base, app])
    resources = app / "Contents/Resources"
    (resources / "gendragoon_distribution.json").write_text('{\n  "distribution": "mas"\n}\n')
    shutil.copy2(os.environ["GD_MAS_PROVISIONING_PROFILE"], app / "Contents/embedded.provisionprofile")
    ident = os.environ["GD_MAS_APP_IDENTITY"]
    for helper, ent in HELPERS.items():
        path = resources / helper
        if path.is_file():
            (output / ent).write_bytes((HERE / ent).read_bytes())
            run(["/usr/bin/codesign", "--force", "--timestamp", "--sign", ident, "--entitlements", output / ent, path])
    app_ent = output / "app.entitlements"
    app_ent.write_bytes(plistlib.dumps(load_entitlements("GenDragoon-MAS.entitlements", team)))
    run(["/usr/bin/codesign", "--force", "--timestamp", "--sign", ident, "--entitlements", app_ent, app])
    pkg = output / "GenDragoon-Cloud-SSD-MAS.pkg"
    run(["/usr/bin/productbuild", "--component", app, "/Applications", "--sign", os.environ["GD_MAS_INSTALLER_IDENTITY"], pkg])
    print("Built (NOT uploaded):", pkg)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--base-app", type=Path)
    ap.add_argument("--output", type=Path)
    a = ap.parse_args()
    try:
        if a.plan or not (a.base_app and a.output):
            problems = validate()
            print(json.dumps({"plan": plan(), "problems": problems}, indent=2))
            sys.exit(1 if problems else 0)
        build(a.base_app.absolute(), a.output.absolute())
    except Exception as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)
