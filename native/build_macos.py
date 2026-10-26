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

VERSION="0.19.0"
BUILD="30"
ROOT=Path(__file__).resolve().parent
NAME="GenDragoon Cloud SSD.app"
IDENTITY="Developer ID Application: Joshua Franklin (NZPU8H843J)"
RED_SECRETS_COMMIT="9235941b431bc1c23c34286b82052f845121592f"

def run(args,timeout=600,env=None):
    result=subprocess.run([str(x) for x in args],capture_output=True,text=True,timeout=timeout,env=env)
    if result.returncode:raise RuntimeError(Path(args[0]).name+" failed:\n"+result.stdout[-12000:]+result.stderr[-12000:])
    return result.stdout

def swift_sdk():
    compatibility=Path("/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk")
    if compatibility.is_dir():
        return compatibility
    path=run(["/usr/bin/xcrun","--show-sdk-path"]).strip()
    sdk=Path(path)
    if not sdk.is_dir():
        raise RuntimeError("No usable macOS SDK found for the native Swift build")
    return sdk

def stage_redsecrets_runtime(resources,output):
    vendor=ROOT/"vendor/Red-SecretsXAI"
    if vendor.is_symlink() or not (vendor/"core/CMakeLists.txt").is_file():
        raise RuntimeError("Missing pinned Red-SecretsXAI submodule; run git submodule update --init --recursive")
    actual=run(["/usr/bin/git","-C",vendor,"rev-parse","HEAD"]).strip()
    if actual!=RED_SECRETS_COMMIT:
        raise RuntimeError("Red-SecretsXAI revision mismatch: expected "+RED_SECRETS_COMMIT+", got "+actual)
    cmake=shutil.which("cmake")
    if not cmake:
        raise RuntimeError("CMake is required to build the pinned Red-SecretsXAI native runtime")
    build=output/"redsecrets-build"
    run([cmake,"-S",vendor/"core","-B",build,"-DRSX_SHARED=ON","-DRSX_IMAGE=OFF",
         "-DRSX_SANITIZE=OFF","-DCMAKE_BUILD_TYPE=Release","-DCMAKE_OSX_ARCHITECTURES=arm64"],timeout=600)
    run([cmake,"--build",build,"--target","rsx","-j","4"],timeout=900)
    dylib=build/"librsx.dylib"
    if dylib.is_symlink() or not dylib.is_file():
        raise RuntimeError("Pinned Red-SecretsXAI build did not produce librsx.dylib")
    runtime=ROOT/"PythonRuntime"
    for package in ("redxai","redsecretsxai"):
        destination=resources/package
        if destination.exists() or destination.is_symlink():
            if destination.is_dir() and not destination.is_symlink(): shutil.rmtree(destination)
            else: destination.unlink()
        destination.mkdir(mode=0o755)
        shutil.copy2(runtime/package/"__init__.py",destination/"__init__.py")
    shutil.copy2(vendor/"redxai/_librsx.py",resources/"redxai/_librsx.py")
    shutil.copy2(vendor/"redsecretsxai/storage_image.py",resources/"redsecretsxai/storage_image.py")
    native=resources/"redxai/_native";native.mkdir(mode=0o755)
    shutil.copy2(dylib,native/"librsx.dylib")
    shutil.copy2(vendor/"LICENSE",resources/"Red-SecretsXAI-LICENSE.txt")
    env=os.environ.copy();env["PYTHONDONTWRITEBYTECODE"]="1";env["PYTHONPATH"]=str(resources)
    code=("from redxai import _librsx; from redsecretsxai import encode_storage_image,decode_storage_image;"
          "assert _librsx.available() and _librsx.abi_version()==2;"
          "p=encode_storage_image(b'RSX3'+b'x'*1024);assert decode_storage_image(p).startswith(b'RSX3')")
    run([sys.executable,"-B","-c",code],timeout=60,env=env)
    return native/"librsx.dylib"

def stage_app_icon(resources,output):
    source=ROOT/"Resources/GenDragoonAppIcon.svg"
    if not source.is_file() or source.is_symlink():
        raise RuntimeError("Missing GenDragoon app icon artwork")
    preview=output/"icon-preview";preview.mkdir()
    run(["/usr/bin/qlmanage","-t","-s","1024","-o",preview,source],timeout=60)
    pngs=list(preview.glob("*.png"))
    if len(pngs)!=1:raise RuntimeError("App icon preview renderer did not produce one PNG")
    iconset=output/"GenDragoonAppIcon.iconset";iconset.mkdir()
    for size in (16,32,128,256,512):
        run(["/usr/bin/sips","-z",str(size),str(size),pngs[0],"--out",iconset/f"icon_{size}x{size}.png"])
        double=size*2
        run(["/usr/bin/sips","-z",str(double),str(double),pngs[0],"--out",iconset/f"icon_{size}x{size}@2x.png"])
    target=resources/"GenDragoonAppIcon.icns"
    run(["/usr/bin/iconutil","-c","icns",iconset,"-o",target])
    if not target.is_file():raise RuntimeError("App icon conversion did not produce GenDragoonAppIcon.icns")
    return target

def remove_python_caches(app):
    """Prune only the new staging copy, never a symlink target or the base bundle."""
    if app.is_symlink() or not app.is_dir():
        raise RuntimeError("Python cache cleanup requires a real staged app directory")
    def fail(error): raise error
    for directory, folders, files in os.walk(app, topdown=True, followlinks=False, onerror=fail):
        for name in list(folders)+files:
            if name!="__pycache__" and not name.endswith((".pyc",".pyo")): continue
            path=Path(directory)/name
            if path.is_symlink() or not path.is_dir(): path.unlink()
            else: shutil.rmtree(path)
            if name in folders: folders.remove(name)

def build(base,output):
    if sys.platform!="darwin":raise RuntimeError("Build this target on macOS with Xcode")
    with (base/"Contents/Info.plist").open("rb") as source:info=plistlib.load(source)
    if info.get("CFBundleIdentifier")!="app.gendragoon.cloudssd":raise RuntimeError("Base bundle identity mismatch")
    output.mkdir(parents=True,exist_ok=True)
    app=output/NAME
    if app.exists() or app.is_symlink():raise RuntimeError("Output bundle already exists; use a fresh build folder")
    run(["/bin/cp","-cR",base,app])
    resources=app/"Contents/Resources"
    for directory in (app,app/"Contents",resources,app/"Contents/MacOS"):
        if directory.is_symlink() or not directory.is_dir():raise RuntimeError("The staged app has an unsafe bundle directory")
    remove_python_caches(app)
    for source in (ROOT/"Resources").iterdir():
        if source.is_file() and source.suffix in (".py",".js",".json",".txt",".html",".css"):
            shutil.copy2(source,resources/source.name)
    stage_app_icon(resources,output)
    registry=ROOT/"Backend/performance_profiles.json"
    if registry.is_symlink() or not registry.is_file():raise RuntimeError("Missing canonical performance profile registry")
    shutil.copy2(registry,resources/"gendragoon_performance_profiles.json")
    rsx_dylib=stage_redsecrets_runtime(resources,output)
    from package_macos import require_runtime_resources
    require_runtime_resources(app)
    for retired in ("gendragoon_updates.py","release-repo.json"):(resources/retired).unlink(missing_ok=True)
    binary=app/"Contents/MacOS/GenDragoon Cloud SSD"
    swift=sorted((ROOT/"Sources").glob("*.swift"))
    run(["/usr/bin/xcrun","swiftc","-parse-as-library","-O","-sdk",swift_sdk(),
         "-target","arm64-apple-macosx14.0","-framework","SwiftUI","-framework","AppKit",
         "-o",binary,*swift],timeout=900)
    info.update(CFBundleShortVersionString=VERSION,CFBundleVersion=BUILD,LSMinimumSystemVersion="14.0",
        CFBundleIconFile="GenDragoonAppIcon.icns")
    (app/"Contents/Info.plist").write_bytes(plistlib.dumps(info))
    entitlements=output/"node-entitlements.plist"
    entitlements.write_bytes(plistlib.dumps({"com.apple.security.cs.allow-jit":True,
        "com.apple.security.cs.allow-unsigned-executable-memory":True}))
    # cp -c and files produced on a developer Mac can carry Finder/provenance
    # extended attributes that Developer ID signing rejects. Strip only the
    # fresh staging copy; the installed/base application is never modified.
    run(["/usr/bin/xattr","-cr",app])
    for name in ("rclone","gendragoon_node"):
        helper=resources/name
        if not helper.is_file():raise RuntimeError("Missing vendor runtime "+name)
        command=["/usr/bin/codesign","--force","--options","runtime","--timestamp","--sign",IDENTITY]
        if name=="gendragoon_node":command += ["--entitlements",entitlements]
        run([*command,helper])
    run(["/usr/bin/codesign","--force","--options","runtime","--timestamp","--sign",IDENTITY,rsx_dylib])
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
