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
    subprocess.run(["/usr/bin/codesign","--verify","--deep","--strict",str(app)],check=True)
    gate=subprocess.run(["/usr/sbin/spctl","--assess","--type","execute",str(app)],capture_output=True)
    if gate.returncode and not candidate:raise RuntimeError("Notarize and staple this build before release packaging")
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
    (output/"Install.command").write_text('#!/bin/sh\nset -eu\ncd -- "$(dirname -- "$0")"\nexec /Library/Frameworks/Python.framework/Versions/3.13/bin/python3 ./install-macos.py --archive ./'+archive.name+' --reinstall --restart\n')
    (output/"Install.command").chmod(0o755)
    report={"version":version,"build":build,"sha256":digest,"archiveBytes":archive.stat().st_size,
        "gatekeeperAccepted":gate.returncode==0,"candidate":candidate,"automaticUpdateEligible":not candidate and gate.returncode==0}
    (output/"package-status.json").write_text(json.dumps(report,indent=2)+"\n")
    print(json.dumps(report),flush=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser();parser.add_argument("--app",type=Path,required=True)
    parser.add_argument("--output",type=Path,required=True);parser.add_argument("--candidate",action="store_true")
    args=parser.parse_args()
    try:package(args.app.absolute(),args.output.absolute(),args.candidate)
    except Exception as error:print(str(error),file=sys.stderr);sys.exit(1)
