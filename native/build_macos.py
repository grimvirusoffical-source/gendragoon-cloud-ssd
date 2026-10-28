#!/usr/bin/env python3
"""Build and sign in a separate staging folder; never replace the installed app.

The supplied base bundle provides licensed/pinned vendor binaries and artwork.
All first-party Swift and resource source comes from this checkout. Release
publication additionally requires successful tests, notarization and stapling.
"""
import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys

VERSION="0.22.6"
BUILD="43"
ROOT=Path(__file__).resolve().parent
NAME="GenDragoon Cloud SSD.app"
IDENTITY="Developer ID Application: Joshua Franklin (NZPU8H843J)"
RED_SECRETS_COMMIT="9235941b431bc1c23c34286b82052f845121592f"
VISUAL_PYTHON="3.13"
VISUAL_DEPENDENCIES={"numpy":"2.5.4","Pillow":"13.0.0"}
VISUAL_MODULES=("storage_image", "_image", "rs", "decode_math", "chaff", "look",
    "stencil_decode", "glyphs", "pyramid", "chromatic", "operators", "ct_sample",
    "confidence_map", "capacity", "damage_recover", "geom_sync")

def compile_private_modules(python,resources):
    """Compile only the pinned codec packages with the target interpreter.

    Adjacent bytecode is an intentional, immutable resource, not an import
    cache. The library itself is unchanged; its source stays in the checkout.
    Use relative code filenames so developer paths do not enter the package.
    """
    initializer=resources/"redsecretsxai/__init__.py"
    initializer.write_text(
        "from pathlib import Path as _Path\n"
        "from gendragoon_codec_loader import install_sourceless_runtime as _install\n"
        "_install(_Path(__file__).resolve().parent.parent)\n"
        + initializer.read_text())
    code="""
import hashlib, importlib.util, json, pathlib, py_compile, sys
root=pathlib.Path(sys.argv[1])
files={}
for package in ('redxai','redsecretsxai'):
    for source in sorted((root/package).glob('*.py')):
        if source.is_symlink() or not source.is_file():
            raise RuntimeError('Linked or missing codec source')
        relative=source.relative_to(root).as_posix()
        target=source.with_suffix('.pyc')
        if target.exists() or target.is_symlink():
            raise RuntimeError('Codec bytecode output already exists')
        py_compile.compile(str(source),cfile=str(target),dfile=relative,doraise=True,
            invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
        data=target.read_bytes()
        files[target.relative_to(root).as_posix()]={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        source.unlink()
print(json.dumps({'pythonMajorMinor':'.'.join(map(str,sys.version_info[:2])),
    'bytecodeMagic':importlib.util.MAGIC_NUMBER.hex(),'files':files}))
"""
    compiled=json.loads(run([python,"-B","-c",code,resources],timeout=60))
    if compiled["pythonMajorMinor"]!=VISUAL_PYTHON or compiled["bytecodeMagic"]!="f30d0d0a":
        raise RuntimeError("The compiled codec requires Python 3.13 bytecode")
    metadata=resources/"gendragoon_python_runtime.json"
    record=json.loads(metadata.read_text())
    record.update(pinnedLibrary=RED_SECRETS_COMMIT,bytecodeMagic=compiled["bytecodeMagic"],
        compiledModules=compiled["files"],sourceIncluded=False)
    metadata.write_text(json.dumps(record,indent=2)+"\n")
    return compiled

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

def stage_visual_dependencies(resources):
    candidates=[os.environ.get("GD_VISUAL_PYTHON"),
        "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3", sys.executable]
    python=None
    for candidate in candidates:
        if not candidate or not Path(candidate).is_file():continue
        try:
            identity=json.loads(run([candidate,"-B","-c",
                "import sys,platform,json;print(json.dumps({'version':'.'.join(map(str,sys.version_info[:2])),'architecture':platform.machine()}))"]).strip())
        except Exception:continue
        if identity=={"version":VISUAL_PYTHON,"architecture":"arm64"}:
            python=candidate;break
    if python is None:raise RuntimeError("Visual barcode build requires an arm64 Python 3.13 interpreter (GD_VISUAL_PYTHON)")
    run([python,"-B","-m","pip","install","--disable-pip-version-check","--no-deps",
        "--only-binary=:all:","--no-compile","--no-cache-dir","--upgrade","--target",resources,
        *[name+"=="+version for name,version in VISUAL_DEPENDENCIES.items()]],timeout=300)
    (resources/"gendragoon_python_runtime.json").write_text(json.dumps({"schema":1,
        "pythonMajorMinor":VISUAL_PYTHON,"architecture":"arm64",
        "dependencies":VISUAL_DEPENDENCIES},indent=2)+"\n")
    return python

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
    for module in VISUAL_MODULES:
        shutil.copy2(vendor/"redsecretsxai"/(module+".py"),resources/"redsecretsxai"/(module+".py"))
    native=resources/"redxai/_native";native.mkdir(mode=0o755)
    shutil.copy2(dylib,native/"librsx.dylib")
    shutil.copy2(vendor/"LICENSE",resources/"Red-SecretsXAI-LICENSE.txt")
    shutil.copy2(vendor/"NOTICE",resources/"Red-SecretsXAI-NOTICE.txt")
    shutil.copy2(ROOT/"Resources/gendragoon_codec_loader.py",resources/"gendragoon_codec_loader.py")
    python=stage_visual_dependencies(resources)
    compile_private_modules(python,resources)
    env=os.environ.copy();env["PYTHONDONTWRITEBYTECODE"]="1";env["PYTHONPATH"]=str(resources)
    code=("import tempfile,numpy,PIL;from redxai import _librsx;"
          "from redsecretsxai import encode_image,decode_image,encode_storage_image,decode_storage_image;"
          "assert numpy.__version__=='2.5.4' and PIL.__version__=='13.0.0';"
          "assert _librsx.available() and _librsx.abi_version()==2;"
          "p=encode_image(b'RSX3'+b'x'*1024,module=3,bits=3,noise=0,deterministic=True);"
          "assert decode_image(p)==b'RSX3'+b'x'*1024;"
          "assert decode_storage_image(encode_storage_image(b'RSX3'+b'x'*1024))==b'RSX3'+b'x'*1024")
    run([python,"-B","-c",code],timeout=90,env=env)
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
    if run([base/"Contents/Resources/rclone","version"]).splitlines()[0]!="rclone v1.75.2":
        raise RuntimeError("The licensed base runtime must contain the pinned rclone v1.75.2")
    output.mkdir(parents=True,exist_ok=True)
    app=output/NAME
    if app.exists() or app.is_symlink():raise RuntimeError("Output bundle already exists; use a fresh build folder")
    # Import-test native dependencies before creating or modifying any .app.
    # Loading extensions beneath a copied bundle with an obsolete resource seal
    # is rejected by macOS policy; the completed bundle is signed below and
    # receives its final runtime smoke check after notarization.
    staged_runtime=output/"redsecrets-runtime"
    staged_runtime.mkdir(mode=0o755)
    stage_redsecrets_runtime(staged_runtime,output)
    run(["/bin/cp","-cR",base,app])
    resources=app/"Contents/Resources"
    for directory in (app,app/"Contents",resources,app/"Contents/MacOS"):
        if directory.is_symlink() or not directory.is_dir():raise RuntimeError("The staged app has an unsafe bundle directory")
    remove_python_caches(app)
    for source in (ROOT/"Resources").iterdir():
        if source.is_file() and source.suffix in (".py",".js",".json",".txt",".html",".css"):
            shutil.copy2(source,resources/source.name)
    teams_resources=resources/"GenDragoonTeams"
    if teams_resources.exists():shutil.rmtree(teams_resources)
    teams_resources.mkdir(mode=0o755)
    for name in ("index.html","teams.css","teams-ui.js","dev-peer.js"):
        source=ROOT/"Collaboration"/name
        if source.is_symlink() or not source.is_file():raise RuntimeError("Missing Teams interface resource: "+name)
        shutil.copy2(source,teams_resources/name)
    stage_app_icon(resources,output)
    registry=ROOT/"Backend/performance_profiles.json"
    if registry.is_symlink() or not registry.is_file():raise RuntimeError("Missing canonical performance profile registry")
    shutil.copy2(registry,resources/"gendragoon_performance_profiles.json")
    for item in staged_runtime.iterdir():
        target=resources/item.name
        if target.exists() or target.is_symlink():
            if target.is_dir() and not target.is_symlink():shutil.rmtree(target)
            else:target.unlink()
        if item.is_dir():shutil.copytree(item,target)
        else:shutil.copy2(item,target)
    from package_macos import require_runtime_resources
    require_runtime_resources(app)
    for retired in ("gendragoon_updates.py","release-repo.json"):(resources/retired).unlink(missing_ok=True)
    binary=app/"Contents/MacOS/GenDragoon Cloud SSD"
    swift=sorted((ROOT/"Sources").glob("*.swift"))
    run(["/usr/bin/xcrun","swiftc","-parse-as-library","-O","-whole-module-optimization","-sdk",swift_sdk(),
         "-target","arm64-apple-macosx14.0","-framework","SwiftUI","-framework","AppKit",
         "-o",binary,*swift],timeout=900)
    info.update(CFBundleShortVersionString=VERSION,CFBundleVersion=BUILD,LSMinimumSystemVersion="14.0",
        CFBundleIconFile="GenDragoonAppIcon.icns")
    info["CFBundleURLTypes"]=[{"CFBundleURLName":"app.gendragoon.cloudssd.integration",
        "CFBundleURLSchemes":["gendragoon"],"CFBundleTypeRole":"Editor"}]
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
    # The visual carrier's binary NumPy/Pillow wheels are signed as nested code,
    # together with the pinned crypto library, before sealing the app bundle.
    native_code=sorted((p for p in resources.rglob("*") if p.is_file() and not p.is_symlink()
        and p.suffix in (".dylib",".so")),key=lambda p:(p.suffix!=".dylib",str(p)))
    for helper in native_code:
        run(["/usr/bin/codesign","--force","--options","runtime","--timestamp","--sign",IDENTITY,helper])
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
