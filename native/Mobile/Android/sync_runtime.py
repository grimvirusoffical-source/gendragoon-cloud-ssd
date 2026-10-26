#!/usr/bin/env python3
"""Copy reviewed runtime sources into build outputs; never modify the vendor."""
import os
import sys
sys.dont_write_bytecode = True
import hashlib
import json
import re
import shutil
import struct
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
NATIVE = ROOT.parents[1]
VENDOR = NATIVE / "vendor/Red-SecretsXAI"
HELPERS = ("gendragoon_redx_storage.py", "gendragoon_progress.py", "gendragoon_auth_broker.py", "gendragoon_transfer_errors.py")
PACKAGED_RUNTIME = ROOT / "runtime/gendragoon-android-runtime-9235941b431b.zip"
PACKAGED_RUNTIME_SHA256 = "a9807f48747017a742e18ad4b6dce10a7d8bb22b93f5a4b5bf94ee39bc2aceaf"


def unpack_runtime(bundle, expected_sha, expected_commit, generated):
    if not re.fullmatch(r"[a-f0-9]{64}", expected_sha or "") or bundle.stat().st_size > 64*1024*1024 or hashlib.sha256(bundle.read_bytes()).hexdigest() != expected_sha:
        raise RuntimeError("Prebuilt Android runtime SHA-256 does not match its explicit trusted pin")
    with zipfile.ZipFile(bundle) as archive:
        names = archive.namelist()
        if len(names) > 1000 or len(set(names)) != len(names) or "manifest.json" not in names or archive.getinfo("manifest.json").file_size > 256*1024:
            raise RuntimeError("Invalid bounded Android runtime bundle")
        manifest = json.loads(archive.read("manifest.json"))
        files = manifest.get("files")
        if manifest.get("schema") != 1 or manifest.get("vendorCommit") != expected_commit or manifest.get("coreABI") != 2 or manifest.get("pythonVersion") != "3.13" or manifest.get("abis") != ["arm64-v8a", "x86_64"] or not isinstance(files, dict) or set(names) != {"manifest.json", *files}:
            raise RuntimeError("The Android runtime is not bound to the reviewed vendor commit and ABI")
        total = 0
        for name, record in files.items():
            if not re.fullmatch(r"(?:python/(?:redxai|redsecretsxai)/[A-Za-z0-9_/]+\.pyc|jniLibs/(?:arm64-v8a|x86_64)/librsx\.so|licenses/(?:Red-SecretsXAI-(?:LICENSE|NOTICE)|Android-NDK-r28c-(?:LLVM-)?NOTICE)\.txt)", name):
                raise RuntimeError("Source files or unsafe paths are forbidden in the compiled runtime")
            info = archive.getinfo(name)
            if not isinstance(record, dict) or type(record.get("bytes")) is not int or record["bytes"] != info.file_size or not 0 < info.file_size <= 16*1024*1024:
                raise RuntimeError("Invalid Android runtime member size")
            total += info.file_size
            if total > 64*1024*1024:
                raise RuntimeError("Compiled runtime exceeds its bounded size")
            data = archive.read(info)
            if hashlib.sha256(data).hexdigest() != record.get("sha256"):
                raise RuntimeError("Compiled runtime member SHA-256 verification failed")
            if name.endswith(".pyc"):
                import importlib.util
                if data[:4] != importlib.util.MAGIC_NUMBER:
                    raise RuntimeError("Compiled private modules must use the exact Python 3.13 bytecode version")
            if name.endswith(".so"):
                if data[:6] != b"\x7fELF\x02\x01" or len(data) < 64 or struct.unpack_from("<H",data,18)[0] != (183 if "/arm64-v8a/" in name else 62):
                    raise RuntimeError("Compiled native runtime has the wrong ELF architecture")
                offset=struct.unpack_from("<Q",data,32)[0];size,count=struct.unpack_from("<HH",data,54)
                if size<56 or count<1 or offset+size*count>len(data):
                    raise RuntimeError("Compiled ELF load headers are invalid")
                loads=[struct.unpack_from("<IIQQQQQQ",data,offset+i*size) for i in range(count) if struct.unpack_from("<I",data,offset+i*size)[0]==1]
                if not loads or any(header[7]<16384 or (header[2]-header[3])%16384 for header in loads):
                    raise RuntimeError("Compiled native runtime is not aligned for Android 16 KiB pages")
            target = generated / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        for required in ["python/redxai/__init__.pyc", "python/redxai/_librsx.pyc", "python/redsecretsxai/__init__.pyc", "python/redsecretsxai/_image.pyc", "jniLibs/arm64-v8a/librsx.so", "jniLibs/x86_64/librsx.so", "licenses/Android-NDK-r28c-NOTICE.txt", "licenses/Android-NDK-r28c-LLVM-NOTICE.txt"]:
            if required not in files:
                raise RuntimeError("Compiled Android runtime is incomplete")
        return manifest


def sync():
    # The superproject gitlink is authoritative; this script never fetches or
    # checks out another revision of the explicitly protected encryption source.
    expected = subprocess.check_output(["git", "ls-files", "--stage", "native/vendor/Red-SecretsXAI"], cwd=NATIVE.parent, text=True).split()[1]
    generated = ROOT / "app/build/generated"
    python = generated / "python"
    python.mkdir(parents=True, exist_ok=True)
    for target in (python / "redxai",python / "redsecretsxai",generated / "jniLibs"):
        if target.exists():shutil.rmtree(target)
    prebuilt = os.environ.get("GENDRAGOON_ANDROID_RUNTIME")
    expected_sha = os.environ.get("GENDRAGOON_ANDROID_RUNTIME_SHA256")
    if not prebuilt and PACKAGED_RUNTIME.is_file():
        prebuilt = str(PACKAGED_RUNTIME)
        expected_sha = PACKAGED_RUNTIME_SHA256
    if prebuilt:
        runtime = unpack_runtime(Path(prebuilt).resolve(),expected_sha,expected,generated)
        current = runtime["vendorCommit"]
    else:
        if not (VENDOR / "core/include/rsx.h").is_file():
            raise RuntimeError("Private source is unavailable. Configure the SHA-256-pinned compiled Android runtime; no unpinned crypto is downloaded.")
        current = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=VENDOR, text=True).strip()
        if expected != current or subprocess.check_output(["git", "status", "--porcelain"], cwd=VENDOR, text=True).strip():
            raise RuntimeError("Pinned encryption source is missing, changed, or not at the superproject gitlink")
        sys.path.insert(0,str(ROOT))
        from build_private_runtime import compile_python
        compile_python(VENDOR,generated)
    for name in HELPERS:
        shutil.copyfile(NATIVE / "Resources" / name, python / name)
    teams = generated / "teamsAssets/teams"
    teams.mkdir(parents=True, exist_ok=True)
    for name in ("index.html", "teams.css", "teams-ui.js", "dev-peer.js"):
        shutil.copyfile(NATIVE / "Collaboration" / name, teams / name)
    adapter = ROOT / "app/src/main/assets/teams-adapter.js"
    if adapter.exists():
        shutil.copyfile(adapter, teams / "teams-adapter.js")
        page = (teams / "index.html").read_text()
        (teams / "index.html").write_text(page.replace('<script src="dev-peer.js">', '<script src="teams-adapter.js"></script><script src="dev-peer.js">'))
    licenses = generated / "licenses/licenses"
    licenses.mkdir(parents=True, exist_ok=True)
    for name in ("LICENSE", "NOTICE"):
        if not prebuilt and (VENDOR / name).exists():
            shutil.copyfile(VENDOR / name, licenses / ("Red-SecretsXAI-" + name + ".txt"))
        elif prebuilt and (generated / "licenses" / ("Red-SecretsXAI-"+name+".txt")).exists():
            shutil.copyfile(generated / "licenses" / ("Red-SecretsXAI-"+name+".txt"),licenses / ("Red-SecretsXAI-"+name+".txt"))
    if prebuilt:
        for name in ("Android-NDK-r28c-NOTICE.txt","Android-NDK-r28c-LLVM-NOTICE.txt"):
            shutil.copyfile(generated/"licenses"/name,licenses/name)
    fixture=NATIVE / "Tests/fixtures/portable-vault-v1.json"
    if fixture.is_file():
        for target in (generated / "testResources",generated / "androidTestAssets"):
            target.mkdir(parents=True,exist_ok=True);shutil.copyfile(fixture,target/fixture.name)
    manifest = {"schema": 1, "vendorCommit": current, "helpers": {name: hashlib.sha256((python / name).read_bytes()).hexdigest() for name in HELPERS}}
    (generated / "runtime-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    return manifest


if __name__ == "__main__":
    print(json.dumps(sync(), indent=2))
