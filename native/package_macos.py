#!/usr/bin/env python3
"""Package a signed build and generate its checksum-pinned installer.

Production packaging requires Gatekeeper acceptance. --candidate produces a
clearly marked private test package; it does not weaken the generated installer
or make the package eligible for automatic updates.
"""
import argparse
import hashlib
import json
from pathlib import Path
import plistlib
import re
import subprocess
import sys

ROOT=Path(__file__).resolve().parent

def package(app,output,candidate=False):
    if sys.platform!="darwin":raise RuntimeError("Package on macOS to preserve bundle metadata")
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
        'exec "$PYTHON" ./install-macos.py --archive "./'+archive.name+'" --reinstall --restart\n')
    (output/"Install.command").write_text(command)
    (output/"Install.command").chmod(0o755)
    report={"version":version,"build":build,"sha256":digest,"archiveBytes":archive.stat().st_size,
        "gatekeeperAccepted":gate.returncode==0,"stapledTicketValidated":staple.returncode==0,
        "candidate":candidate,"automaticUpdateEligible":not candidate and gate.returncode==0 and staple.returncode==0}
    (output/"package-status.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report),flush=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--app",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True);parser.add_argument("--candidate",action="store_true")
    args=parser.parse_args()
    try:package(args.app.absolute(),args.output.absolute(),args.candidate)
    except Exception as error:print(str(error),file=sys.stderr);sys.exit(1)
