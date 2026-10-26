#!/usr/bin/env python3
"""Build compiled Android crypto inputs privately; never package vendor source."""
import os
import sys
sys.dont_write_bytecode = True
import argparse
import hashlib
import json
import py_compile
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
ABIS = ("arm64-v8a", "x86_64")


def compile_python(vendor, output):
    if sys.version_info[:2] != (3, 13):
        raise RuntimeError("Compiled Android runtime packages require Python 3.13")
    for package in ("redxai", "redsecretsxai"):
        for source in sorted((vendor / package).rglob("*.py")):
            if "_native" in source.parts or "__pycache__" in source.parts:
                continue
            relative = source.relative_to(vendor)
            target = (output / "python" / relative).with_suffix(".pyc")
            target.parent.mkdir(parents=True, exist_ok=True)
            py_compile.compile(str(source), cfile=str(target), dfile=relative.as_posix(), doraise=True, invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH)
    commit=subprocess.check_output(["git","rev-parse","HEAD"],cwd=vendor,text=True).strip()
    files={p.relative_to(output/"python").as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for package in ("redxai","redsecretsxai") for p in sorted((output/"python"/package).rglob("*.pyc"))}
    (output/"python/.vendor-python.json").write_text(json.dumps({"schema":1,"vendorCommit":commit,"pythonVersion":"3.13","magic":"f30d0d0a","files":files},indent=2)+"\n")


def build(vendor, ndk, output, cmake="cmake", compiled_python=None, ninja=None):
    vendor, ndk, output = vendor.resolve(), ndk.resolve(), output.resolve()
    if output.exists() or output.is_relative_to(vendor):
        raise RuntimeError("Choose a new output directory outside the immutable vendor source")
    if subprocess.check_output(["git", "status", "--porcelain"], cwd=vendor, text=True).strip():
        raise RuntimeError("Private encryption checkout must be clean and pinned")
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=vendor, text=True).strip()
    toolchain = ndk / "build/cmake/android.toolchain.cmake"
    if not toolchain.is_file():
        raise RuntimeError("Provide the installed Android NDK 28.2.13676358 directory")
    props = (ndk / "source.properties").read_text()
    if "28.2.13676358" not in props:
        raise RuntimeError("The reviewed Android runtime requires NDK 28.2.13676358")
    output.mkdir(parents=True, mode=0o700)
    runtime = output / "runtime"
    runtime.mkdir(mode=0o700)
    if compiled_python:
        source=Path(compiled_python).resolve()
        proof=json.loads((source/".vendor-python.json").read_text())
        if proof.get("schema")!=1 or proof.get("vendorCommit")!=commit or proof.get("pythonVersion")!="3.13" or proof.get("magic")!="f30d0d0a" or not isinstance(proof.get("files"),dict):raise RuntimeError("Compiled private packages lack matching vendor provenance")
        observed={}
        for package in ("redxai","redsecretsxai"):
            for item in sorted((source/package).rglob("*")):
                if item.is_dir():continue
                if item.is_symlink() or item.suffix!=".pyc" or item.read_bytes()[:4]!=bytes.fromhex("f30d0d0a"):
                    raise RuntimeError("Precompiled private packages must contain Python 3.13 bytecode only")
                relative=item.relative_to(source).as_posix();observed[relative]=hashlib.sha256(item.read_bytes()).hexdigest()
                target=runtime/"python"/item.relative_to(source);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(item,target)
            if not (runtime/"python"/package/"__init__.pyc").is_file():raise RuntimeError("Compiled private package is incomplete")
        if observed!=proof["files"]:raise RuntimeError("Compiled private package hashes do not match their pinned provenance")
    else:compile_python(vendor, runtime)
    for abi in ABIS:
        directory = output / ("build-" + abi)
        subprocess.run([cmake, "-S", str(ROOT), "-B", str(directory), *( ["-G","Ninja","-DCMAKE_MAKE_PROGRAM="+str(Path(ninja).resolve())] if ninja else []), "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_TOOLCHAIN_FILE="+str(toolchain), "-DANDROID_ABI="+abi, "-DANDROID_PLATFORM=android-28", "-DRSX_VENDOR_DIR="+str(vendor / "core"), "-DANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON"], check=True)
        subprocess.run([cmake, "--build", str(directory), "--target", "rsx", "--parallel", "2"], check=True)
        library = directory / "librsx/librsx.so"
        destination = runtime / "jniLibs" / abi / "librsx.so"
        destination.parent.mkdir(parents=True)
        shutil.copyfile(library, destination)
    notices = runtime / "licenses"
    notices.mkdir()
    for name in ("LICENSE", "NOTICE"):
        if (vendor / name).is_file():
            shutil.copyfile(vendor / name, notices / ("Red-SecretsXAI-"+name+".txt"))
    llvm_notices=sorted((ndk/"toolchains/llvm/prebuilt").glob("*/NOTICE"))
    if not (ndk/"NOTICE").is_file() or len(llvm_notices)!=1:
        raise RuntimeError("Official NDK and LLVM runtime redistribution notices are required")
    shutil.copyfile(ndk/"NOTICE",notices/"Android-NDK-r28c-NOTICE.txt")
    shutil.copyfile(llvm_notices[0],notices/"Android-NDK-r28c-LLVM-NOTICE.txt")
    (runtime/"python/.vendor-python.json").unlink(missing_ok=True)
    files = {p.relative_to(runtime).as_posix(): {"sha256": hashlib.sha256(p.read_bytes()).hexdigest(), "bytes": p.stat().st_size} for p in sorted(runtime.rglob("*")) if p.is_file()}
    manifest = {"schema": 1, "vendorCommit": commit, "coreABI": 2, "pythonVersion": "3.13", "ndkVersion": "28.2.13676358", "abis": list(ABIS), "files": files}
    (runtime / "manifest.json").write_text(json.dumps(manifest, indent=2)+"\n")
    archive = output / ("gendragoon-android-runtime-"+commit[:12]+".zip")
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
        for item in sorted(runtime.rglob("*")):
            if item.is_file():
                bundle.write(item, item.relative_to(runtime).as_posix())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (output / "SHA256SUMS").write_text(digest+"  "+archive.name+"\n")
    # The caller may publish this compiled bundle only after its ABI/codec and
    # native alignment checks pass. Private build trees and sources stay private.
    return {"archive": str(archive), "sha256": digest, "vendorCommit": commit, "containsPrivateSource": False}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vendor", type=Path, required=True)
    parser.add_argument("--ndk", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cmake", default="cmake")
    parser.add_argument("--compiled-python",type=Path,help="Private staging directory containing Python3.13 redxai/redsecretsxai bytecode; avoids a second host interpreter")
    parser.add_argument("--ninja",type=Path,help="Private Ninja executable; selects the Ninja generator explicitly")
    args = parser.parse_args()
    print(json.dumps(build(args.vendor, args.ndk, args.output, args.cmake,args.compiled_python,args.ninja), indent=2))
