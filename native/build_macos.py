#!/usr/bin/env python3
"""Build and sign in a separate staging folder; never replace the installed app.

The supplied base bundle provides licensed/pinned vendor binaries and artwork.
All first-party Swift and resource source comes from this checkout. Release
publication additionally requires successful tests, notarization and stapling.
"""
import argparse
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

VERSION="0.17.0"
BUILD="20"
ROOT=Path(__file__).resolve().parent
NAME="GenDragoon Cloud SSD.app"
IDENTITY="Developer ID Application: Joshua Franklin (NZPU8H843J)"

def run(args,timeout=600):
    result=subprocess.run([str(x) for x in args],capture_output=True,text=True,timeout=timeout)
    if result.returncode:raise RuntimeError(Path(args[0]).name+" failed:\n"+result.stdout[-12000:]+result.stderr[-12000:])
    return result.stdout

def build(base,output):
    if sys.platform!="darwin":raise RuntimeError("Build this target on macOS with Xcode")
    with (base/"Contents/Info.plist").open("rb") as source:info=plistlib.load(source)
    if info.get("CFBundleIdentifier")!="app.gendragoon.cloudssd":raise RuntimeError("Base bundle identity mismatch")
    output.mkdir(parents=True,exist_ok=True)
    app=output/NAME
    if app.exists():raise RuntimeError("Output bundle already exists; use a fresh build folder")
    run(["/bin/cp","-cR",base,app])
    resources=app/"Contents/Resources"
    for source in (ROOT/"Resources").iterdir():
        if source.is_file() and source.suffix in (".py",".js",".json",".txt",".html",".css"):
            shutil.copy2(source,resources/source.name)
    for retired in ("gendragoon_updates.py","release-repo.json"):
        (resources/retired).unlink(missing_ok=True)
    binary=app/"Contents/MacOS/GenDragoon Cloud SSD"
    swift=sorted((ROOT/"Sources").glob("*.swift"))
    run(["/usr/bin/xcrun","swiftc","-parse-as-library","-O","-target","arm64-apple-macosx14.0",
         "-framework","SwiftUI","-framework","AppKit","-o",binary,*swift],timeout=900)
    info.update(CFBundleShortVersionString=VERSION,CFBundleVersion=BUILD,LSMinimumSystemVersion="14.0")
    (app/"Contents/Info.plist").write_bytes(plistlib.dumps(info))
    entitlements=output/"node-entitlements.plist"
    entitlements.write_bytes(plistlib.dumps({"com.apple.security.cs.allow-jit":True,
        "com.apple.security.cs.allow-unsigned-executable-memory":True}))
    for name in ("rclone","gendragoon_node"):
        helper=resources/name
        if not helper.is_file():raise RuntimeError("Missing vendor runtime "+name)
        command=["/usr/bin/codesign","--force","--options","runtime","--timestamp","--sign",IDENTITY]
        if name=="gendragoon_node":command += ["--entitlements",entitlements]
        run([*command,helper])
    run(["/usr/bin/codesign","--force","--options","runtime","--timestamp","--sign",IDENTITY,app])
    run(["/usr/bin/codesign","--verify","--deep","--strict",app])
    print("Signed staged build:",app,flush=True)
    print("Version "+VERSION+" ("+BUILD+"). Installation and notarization are separate verification gates.",flush=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--base-app",type=Path,default=Path.home()/"Applications"/NAME)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    try:build(args.base_app.absolute(),args.output.absolute())
    except Exception as error:print(str(error),file=sys.stderr);sys.exit(1)
