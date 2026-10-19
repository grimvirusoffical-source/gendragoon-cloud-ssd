#!/usr/bin/env python3
"""Build and sign in a separate staging folder; never replace the installed app.

The supplied base bundle provides licensed/pinned vendor binaries and artwork.
All first-party Swift and resource source comes from this checkout. Release
publication additionally requires successful tests, notarization and stapling.
"""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

VERSION="0.18.0"
BUILD="29"
ROOT=Path(__file__).resolve().parent
NAME="GenDragoon Cloud SSD.app"
IDENTITY="Developer ID Application: Joshua Franklin (NZPU8H843J)"

def run(args,timeout=600):
    result=subprocess.run([str(x) for x in args],capture_output=True,text=True,timeout=timeout)
    if result.returncode:raise RuntimeError(Path(args[0]).name+" failed:\n"+result.stdout[-12000:]+result.stderr[-12000:])
    return result.stdout

def remove_python_caches(app):
    """Prune only the new staging copy, never a symlink target or the base bundle."""
    if app.is_symlink() or not app.is_dir():
        raise RuntimeError("Python cache cleanup requires a real staged app directory")
    def fail(error):
        raise error
    for directory, folders, files in os.walk(app, topdown=True, followlinks=False, onerror=fail):
        for name in list(folders) + files:
            if name != "__pycache__" and not name.endswith((".pyc", ".pyo")):
                continue
            path=Path(directory)/name
            if path.is_symlink() or not path.is_dir():
                path.unlink()
            else:
                shutil.rmtree(path)
            if name in folders:
                folders.remove(name)

ADHOC="-"
DISTRIBUTIONS=("direct","rotten-apple","mas")

def sign_commands(identity):
    """Developer ID: hardened runtime + secure timestamp (required for notarization).
    Ad-hoc ("-"): no hardened runtime and no timestamp. Ad-hoc code has no Team ID, so library validation under the
    hardened runtime would refuse to load the other ad-hoc signed binaries and libraries in the bundle; ad-hoc builds
    cannot be notarized anyway, so the runtime flag would buy nothing."""
    if identity==ADHOC:return ["/usr/bin/codesign","--force","--sign",ADHOC]
    return ["/usr/bin/codesign","--force","--options","runtime","--timestamp","--sign",identity]

def write_distribution(resources,distribution):
    """Bake the channel into the bundle before signing (read by gendragoon_auto_update.py and GDDistribution)."""
    if distribution is None:return
    if distribution not in DISTRIBUTIONS:raise RuntimeError("Unknown distribution "+distribution)
    import json
    (resources/"gendragoon_distribution.json").write_text(json.dumps({"distribution":distribution})+"\n","utf8")

def build(base,output,identity=IDENTITY,distribution=None):
    if sys.platform!="darwin":raise RuntimeError("Build this target on macOS with Xcode")
    with (base/"Contents/Info.plist").open("rb") as source:info=plistlib.load(source)
    if info.get("CFBundleIdentifier")!="app.gendragoon.cloudssd":raise RuntimeError("Base bundle identity mismatch")
    output.mkdir(parents=True,exist_ok=True)
    app=output/NAME
    if app.exists() or app.is_symlink():raise RuntimeError("Output bundle already exists; use a fresh build folder")
    run(["/bin/cp","-cR",base,app])
    resources=app/"Contents/Resources"
    for directory in (app, app/"Contents", resources, app/"Contents/MacOS"):
        if directory.is_symlink() or not directory.is_dir():
            raise RuntimeError("The staged app has an unsafe bundle directory")
    # APFS cloning inherits old runtime caches. Remove them before signing;
    # source helpers and their child interpreters now disable bytecode writes.
    remove_python_caches(app)
    for source in (ROOT/"Resources").iterdir():
        if source.is_file() and source.suffix in (".py",".js",".json",".txt",".html",".css"):
            shutil.copy2(source,resources/source.name)
    registry=ROOT/"Backend/performance_profiles.json"
    if registry.is_symlink() or not registry.is_file():
        raise RuntimeError("Missing canonical performance profile registry")
    shutil.copy2(registry,resources/"gendragoon_performance_profiles.json")
    from package_macos import require_runtime_resources
    require_runtime_resources(app)
    for retired in ("gendragoon_updates.py","release-repo.json"):
        (resources/retired).unlink(missing_ok=True)
    binary=app/"Contents/MacOS/GenDragoon Cloud SSD"
    swift=sorted((ROOT/"Sources").glob("*.swift"))
    run(["/usr/bin/xcrun","swiftc","-parse-as-library","-O","-target","arm64-apple-macosx14.0",
         "-framework","SwiftUI","-framework","AppKit","-o",binary,*swift],timeout=900)
    info.update(CFBundleShortVersionString=VERSION,CFBundleVersion=BUILD,LSMinimumSystemVersion="14.0")
    (app/"Contents/Info.plist").write_bytes(plistlib.dumps(info))
    write_distribution(resources,distribution)
    entitlements=output/"node-entitlements.plist"
    entitlements.write_bytes(plistlib.dumps({"com.apple.security.cs.allow-jit":True,
        "com.apple.security.cs.allow-unsigned-executable-memory":True}))
    for name in ("rclone","gendragoon_node"):
        helper=resources/name
        if not helper.is_file():raise RuntimeError("Missing vendor runtime "+name)
        command=sign_commands(identity)
        if name=="gendragoon_node" and identity!=ADHOC:command += ["--entitlements",entitlements]
        run([*command,helper])
    run([*sign_commands(identity),app])
    run(["/usr/bin/codesign","--verify","--deep","--strict",app])
    print(("Ad-hoc signed" if identity==ADHOC else "Signed")+" staged build:",app,flush=True)
    print("Version "+VERSION+" ("+BUILD+"). Installation and notarization are separate verification gates.",flush=True)

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--base-app",type=Path,default=Path.home()/"Applications"/NAME)
    parser.add_argument("--output",type=Path,required=True)
    parser.add_argument("--identity",default=IDENTITY,help='codesign identity; "-" = ad-hoc (no Apple Developer ID; cannot be notarized)')
    parser.add_argument("--distribution",choices=DISTRIBUTIONS,help="write gendragoon_distribution.json into the bundle before signing")
    args=parser.parse_args()
    if args.identity not in (IDENTITY,ADHOC):parser.error("--identity must be the pinned Developer ID or - (ad-hoc)")
    try:build(args.base_app.absolute(),args.output.absolute(),args.identity,args.distribution)
    except Exception as error:print(str(error),file=sys.stderr);sys.exit(1)
