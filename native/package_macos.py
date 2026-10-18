#!/usr/bin/env python3
"""Package a signed build and generate its checksum-pinned installer.

Production packaging requires Gatekeeper acceptance. --candidate produces a
clearly marked private test package; it does not weaken the generated installer
or make the package eligible for automatic updates.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parent

REQUIRED_RESOURCES=("gendragoon_update_restart.py", "gendragoon_auto_update.py",
    "gendragoon_app_control.py", "gendragoon_app_launch.py", "gendragoon_library.py",
    "gendragoon_upload_workspace.py", "gendragoon_performance.py",
    "gendragoon_performance_profiles.json", "gendragoon_project_files.py",
    "gendragoon_aes.py", "gendragoon_account.py", "gendragoon_hosted_storage.py",
    "gendragoon_byo_connect.py", "extension-map.json",
    "redxai_updater.py", "grim-apps-manifest.json")

def require_runtime_resources(app):
    resources=app/"Contents/Resources"
    for name in REQUIRED_RESOURCES:
        path=resources/name
        if path.is_symlink() or not path.is_file() or path.stat().st_size==0:
            raise RuntimeError("Required bundled runtime resource missing: "+name)
    return list(REQUIRED_RESOURCES)

def reject_python_caches(app):
    """Signed caches are mutable on import; a release must not contain them."""
    def fail(error):
        raise error
    for directory, folders, files in os.walk(app, followlinks=False, onerror=fail):
        for name in folders + files:
            if name == "__pycache__" or name.endswith((".pyc", ".pyo")):
                relative=(Path(directory)/name).relative_to(app)
                raise RuntimeError("Python cache artifact in app bundle: "+str(relative)+". Rebuild before signing and notarizing.")

def require_release_support_contact():
    """A distributable build must not ship the placeholder support contact.
    Runs native/Tests/check_support_contact_release.py unchanged; --candidate is exempt."""
    import importlib.util
    script=ROOT/"Tests/check_support_contact_release.py"
    spec=importlib.util.spec_from_file_location("gd_support_contact_release",script)
    check=importlib.util.module_from_spec(spec);spec.loader.exec_module(check)
    if check.main()!=0:
        raise RuntimeError("Release packaging requires the real support contact; GDSupportContact.current is still a placeholder")

def package(app,output,candidate=False):
    if sys.platform!="darwin":raise RuntimeError("Package on macOS to preserve bundle metadata")
    reject_python_caches(app)
    runtime_resources=require_runtime_resources(app)
    requirement=('anchor apple generic and identifier "app.gendragoon.cloudssd"'
        ' and certificate leaf[subject.OU] = "NZPU8H843J"'
        ' and certificate 1[field.1.2.840.113635.100.6.2.6] exists'
        ' and certificate leaf[field.1.2.840.113635.100.6.1.13] exists')
    subprocess.run(["/usr/bin/codesign","--verify","--deep","--strict",
                    "-R","="+requirement,str(app)],check=True)
    gate=subprocess.run(["/usr/sbin/spctl","--assess","--type","execute",str(app)],capture_output=True)
    staple=subprocess.run(["/usr/bin/xcrun","stapler","validate",str(app)],capture_output=True)
    if (gate.returncode or staple.returncode) and not candidate:
        raise RuntimeError("Release packaging requires a trusted Developer ID signature, accepted Gatekeeper assessment and a stapled Apple notarization ticket")
    if not candidate:require_release_support_contact()
    with (app/"Contents/Info.plist").open("rb") as handle:info=plistlib.load(handle)
    if info.get("CFBundleIdentifier")!="app.gendragoon.cloudssd":raise RuntimeError("Bundle ID mismatch")
    version=info["CFBundleShortVersionString"];build=info["CFBundleVersion"]
    if not re.fullmatch(r"\d+\.\d+\.\d+",version) or not build.isdecimal():raise RuntimeError("Invalid release version")
    output.mkdir(parents=True,exist_ok=True)
    archive=output/("GenDragoon-Cloud-SSD-Mac-v"+version+".zip")
    subprocess.run(["/usr/bin/ditto","-c","-k","--sequesterRsrc","--keepParent",str(app),str(archive)],check=True)
    digest=hashlib.file_digest(archive.open("rb"),"sha256").hexdigest()
    (output/"sha256.txt").write_text(digest+"  "+archive.name+"\n")
    template=(ROOT.parent/"macos/install-macos.py").read_text()
    template=template.replace("0.16.2",version).replace('BUILD = "19"','BUILD = "'+build+'"')
    template=re.sub(r"ARCHIVE_BYTES = \d+","ARCHIVE_BYTES = "+str(archive.stat().st_size),template)
    template=re.sub(r'ARCHIVE_SHA256 = "[a-f0-9]+"','ARCHIVE_SHA256 = "'+digest+'"',template)
    template=template.replace("The pinned v"+version+" release is a draft; checksum verification alone does NOT make\nit installable.",
        "Checksum verification alone does not make a package installable.")
    (output/"install-macos.py").write_text(template)
    # Do not assume every customer has the developer's Python.org 3.13 path.
    command=('#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\n'
        'if [ -x /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 ]; then\n'
        '  PYTHON=/Library/Frameworks/Python.framework/Versions/3.13/bin/python3\n'
        'elif command -v python3 >/dev/null 2>&1; then\n'
        '  PYTHON="$(command -v python3)"\n'
        'else\n  echo "Python 3.9 or newer is required for this verified installer." >&2\n  exit 1\nfi\n'
        'exec "$PYTHON" -B ./install-macos.py --archive "./'+archive.name+'" --reinstall --restart\n')
    (output/"Install.command").write_text(command)
    (output/"Install.command").chmod(0o755)
    report={"version":version,"build":build,"sha256":digest,"archiveBytes":archive.stat().st_size,
        "gatekeeperAccepted":gate.returncode==0,"stapledTicketValidated":staple.returncode==0,
        "candidate":candidate,"automaticUpdateEligible":not candidate and gate.returncode==0 and staple.returncode==0,
        "previewUpdateEligible":gate.returncode==0 and staple.returncode==0,
        "bundledRestartHelper":"Contents/Resources/gendragoon_update_restart.py",
        "requiredRuntimeResources":runtime_resources}
    (output/"package-status.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report),flush=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--app",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True);parser.add_argument("--candidate",action="store_true")
    args=parser.parse_args()
    try:package(args.app.absolute(),args.output.absolute(),args.candidate)
    except Exception as error:print(str(error),file=sys.stderr);sys.exit(1)
