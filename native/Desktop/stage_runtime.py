#!/usr/bin/env python3
"""Build the pinned codec outside its source checkout and stage a desktop runtime."""
import argparse
import json
import hashlib
import importlib.util
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile
import stat

ROOT=Path(__file__).resolve().parent
NATIVE=ROOT.parent
PIN="9235941b431bc1c23c34286b82052f845121592f"
MODULES=("storage_image","_image","rs","decode_math","chaff","look","stencil_decode","glyphs","pyramid","chromatic","operators","ct_sample","confidence_map","capacity","damage_recover","geom_sync")
HELPERS=("gendragoon_redx_storage.py","gendragoon_auth_broker.py","gendragoon_transfer_errors.py","gendragoon_progress.py","gendragoon_performance.py","gendragoon_native_bridge.py","gendragoon_platform_ipc.py","gendragoon_device_origin.py")
CLIENTS=("gendragoon_gui.py","desktop_transfer_ui.py","desktop_drop.py","tkdnd-runtime.json","tkinterdnd2-LICENSE.txt","tkdnd-LICENSE.txt","gendragoon_desktop.py","machinenotes_client.py","portable_apps.py","portable_vault.py","redx_session.py","requirements.txt","companion_server.py","private_fs.py","codec_loader.py","windows_utf8.py","windows-utf8.manifest","workspace_mount.py","mount_platform.py")

def run(arguments,timeout=600):
    result=subprocess.run([str(a) for a in arguments],capture_output=True,text=True,timeout=timeout)
    if result.returncode:raise RuntimeError("Desktop runtime build failed: "+str(arguments[0])+"\n"+result.stderr[-4000:])
    return result.stdout.strip()

def prebuilt_archive():
    name={"Linux":"linux","Windows":"windows"}.get(platform.system())
    arch={"AMD64":"x86_64","x86_64":"x86_64","aarch64":"arm64","arm64":"arm64"}.get(platform.machine())
    return ROOT/"runtimes"/(str(name)+"-"+str(arch)+".zip")

def extract_prebuilt(archive,destination):
    archive=Path(archive).absolute();index_path=ROOT/"runtimes/runtime-index.json"
    if archive.stat().st_size>32*1024*1024:raise RuntimeError("The prebuilt runtime exceeds its size limit.")
    index=json.loads(index_path.read_text())
    entries=index.get("runtimes",index) if isinstance(index,dict) else {}
    entry=next((v for v in entries.values() if isinstance(v,dict) and v.get("archive")==archive.name),None)
    if not entry or entry.get("pinnedLibrary")!=PIN or hashlib.sha256(archive.read_bytes()).hexdigest()!=entry.get("sha256"):
        raise RuntimeError("The prebuilt runtime does not match GenDragoon's pinned archive digest.")
    with zipfile.ZipFile(archive) as source:
        metadata=source.getinfo("manifest.json")
        if metadata.file_size>128*1024:raise RuntimeError("The runtime manifest is too large.")
        manifest=json.loads(source.read(metadata))
        current_platform={"Linux":"linux","Windows":"windows"}.get(platform.system())
        current_arch={"AMD64":"x86_64","x86_64":"x86_64","aarch64":"arm64","arm64":"arm64"}.get(platform.machine())
        if (manifest.get("schema")!=1 or manifest.get("pinnedLibrary")!=PIN or manifest.get("platform")!=current_platform
                or manifest.get("architecture")!=current_arch or manifest.get("pythonMajorMinor")!="3.13"
                or sys.version_info[:2]!=(3,13) or manifest.get("bytecodeMagic")!=importlib.util.MAGIC_NUMBER.hex()):
            raise RuntimeError("This compiled runtime requires the matching platform, architecture, and Python 3.13.")
        files=manifest.get("files")
        if not isinstance(files,dict) or not 1<=len(files)<=100:raise RuntimeError("The runtime file manifest is invalid.")
        required={"runtime/LICENSE","runtime/NOTICE","runtime/redxai/__init__.pyc","runtime/redxai/_librsx.pyc","runtime/redsecretsxai/__init__.pyc",
            "runtime/redxai/_native/"+("librsx.dll" if current_platform=="windows" else "librsx.so")}
        required.update("runtime/redsecretsxai/"+name+".pyc" for name in MODULES)
        if not required.issubset(files):raise RuntimeError("The compiled runtime is missing a required codec module.")
        names=set();total=0
        for info in source.infolist():
            name=info.filename
            if name in names or info.is_dir() or "\\" in name or any(p in ("",".","..") for p in name.split("/")) or name.startswith("/") or ":" in name:
                raise RuntimeError("The runtime archive contains unsafe or repeated paths.")
            names.add(name)
            if name=="manifest.json":continue
            record=files.get(name)
            if (not name.startswith("runtime/") or not isinstance(record,dict) or type(record.get("bytes")) is not int
                    or info.file_size!=record["bytes"] or info.file_size>16*1024*1024 or stat.S_IFMT(info.external_attr>>16) not in (0,stat.S_IFREG)
                    or name.endswith(".py")):
                raise RuntimeError("The runtime archive contains an unsupported file.")
            total+=info.file_size
            if total>64*1024*1024:raise RuntimeError("The runtime archive expands beyond its limit.")
        if names!={"manifest.json",*files}:raise RuntimeError("The runtime archive has missing or unexpected files.")
        for name,record in files.items():
            data=source.read(name)
            if hashlib.sha256(data).hexdigest()!=record.get("sha256"):raise RuntimeError("The prebuilt runtime file digest does not match.")
            if name.endswith(".pyc") and data[:4]!=importlib.util.MAGIC_NUMBER:raise RuntimeError("A compiled Python module has the wrong bytecode version.")
        with tempfile.TemporaryDirectory(prefix=".runtime-",dir=destination) as td:
            staging=Path(td)
            for name in files:
                target=staging/name;target.parent.mkdir(parents=True,exist_ok=True)
                target.write_bytes(source.read(name))
            runtime=Path(destination)/"runtime"
            if runtime.is_symlink():raise RuntimeError("The installed runtime directory is linked.")
            if runtime.exists():shutil.rmtree(runtime)
            os.replace(staging/"runtime",runtime)
    return manifest

def stage(destination,build=None,prebuilt=None):
    vendor=NATIVE/"vendor/Red-SecretsXAI"
    destination=Path(destination).absolute()
    if destination.is_symlink():raise RuntimeError("The runtime destination is linked.")
    destination.mkdir(parents=True,exist_ok=True,mode=0o700)
    if (destination/"runtime").is_symlink() or any((destination/name).is_symlink() for name in CLIENTS):
        raise RuntimeError("The existing desktop installation contains linked files.")
    if prebuilt is not None or not (vendor/"core/CMakeLists.txt").is_file():
        manifest=extract_prebuilt(prebuilt or prebuilt_archive(),destination)
        for helper in HELPERS:shutil.copy2(NATIVE/"Resources"/helper,destination/"runtime"/helper)
        shutil.copy2(NATIVE/"Backend/performance_profiles.json",destination/"runtime/gendragoon_performance_profiles.json")
        for name in CLIENTS:
            if ROOT/name!=destination/name:shutil.copy2(ROOT/name,destination/name)
        shutil.copy2(NATIVE/"Extensions/install_native_host.py",destination/"install_native_host.py")
        (destination/"runtime.json").write_text(json.dumps(manifest,indent=2)+"\n")
        return manifest
    if not (vendor/"core/CMakeLists.txt").is_file():raise RuntimeError("Initialize the pinned submodule with git submodule update --init --recursive.")
    if run(["git","-C",vendor,"rev-parse","HEAD"])!=PIN:raise RuntimeError("The encryption library revision does not match GenDragoon's pinned runtime.")
    if run(["git","-C",vendor,"status","--porcelain","--untracked-files=no"]):raise RuntimeError("The pinned encryption source has local changes; restore its expected revision before packaging.")
    build=Path(build).absolute() if build else destination/".codec-build"
    if vendor==build or vendor in build.parents:raise RuntimeError("Build outputs must remain outside the vendor checkout.")
    cmake=shutil.which("cmake")
    if not cmake:raise RuntimeError("CMake and a native C++ compiler are required for the pinned encryption runtime.")
    run([cmake,"-S",vendor/"core","-B",build,"-DRSX_SHARED=ON","-DRSX_IMAGE=OFF","-DRSX_SANITIZE=OFF","-DCMAKE_BUILD_TYPE=Release","-DCMAKE_WINDOWS_EXPORT_ALL_SYMBOLS=ON"])
    run([cmake,"--build",build,"--target","rsx","--config","Release","--parallel","4"],timeout=900)
    names=("librsx.so","librsx.dylib","rsx.dll","librsx.dll")
    libraries=[p for p in build.rglob("*") if p.name in names and p.is_file() and not p.is_symlink()]
    if len(libraries)!=1:raise RuntimeError("Expected exactly one platform encryption library.")
    runtime=destination/"runtime";runtime.mkdir(exist_ok=True,mode=0o700)
    for package in ("redxai","redsecretsxai"):
        folder=runtime/package;folder.mkdir(exist_ok=True)
        shutil.copy2(NATIVE/"PythonRuntime"/package/"__init__.py",folder/"__init__.py")
    shutil.copy2(vendor/"redxai/_librsx.py",runtime/"redxai/_librsx.py")
    for module in MODULES:shutil.copy2(vendor/"redsecretsxai"/(module+".py"),runtime/"redsecretsxai"/(module+".py"))
    binaries=runtime/"redxai/_native";binaries.mkdir(exist_ok=True)
    shutil.copy2(libraries[0],binaries/libraries[0].name)
    for name in ("LICENSE","NOTICE"):shutil.copy2(vendor/name,runtime/name)
    freeze_codec_sources(runtime)
    for helper in HELPERS:shutil.copy2(NATIVE/"Resources"/helper,runtime/helper)
    shutil.copy2(NATIVE/"Backend/performance_profiles.json",runtime/"gendragoon_performance_profiles.json")
    for name in CLIENTS:
        if ROOT/name!=destination/name:shutil.copy2(ROOT/name,destination/name)
    shutil.copy2(NATIVE/"Extensions/install_native_host.py",destination/"install_native_host.py")
    manifest={"schema":1,"protocol":"MachineNotes-v1","pinnedLibrary":PIN,"encryptedTransfer":"redsecretsxai-png-v1","library":str(binaries/libraries[0].name)}
    (destination/"runtime.json").write_text(json.dumps(manifest,indent=2)+"\n")
    return manifest

def freeze_codec_sources(runtime):
    """Freeze the pinned private wrapper into adjacent Python3.13 bytecode."""
    import py_compile
    if sys.version_info[:2]!=(3,13):raise RuntimeError("A source-built desktop codec requires Python 3.13, matching the portable compiled runtime.")
    runtime=Path(runtime)
    expected={runtime/"redxai"/(name+".py") for name in ("__init__","_librsx")}
    expected.update(runtime/"redsecretsxai"/(name+".py") for name in ("__init__",*MODULES))
    actual={path for package in ("redxai","redsecretsxai") for path in (runtime/package).rglob("*.py")}
    if actual!=expected or any(path.is_symlink() for path in actual):raise RuntimeError("The source-built codec contains unexpected wrapper sources.")
    for source in sorted(expected):
        py_compile.compile(str(source),cfile=str(source.with_suffix(".pyc")),dfile=source.relative_to(runtime).as_posix(),
            doraise=True,invalidation_mode=py_compile.PycInvalidationMode.CHECKED_HASH)
    for source in expected:source.unlink()

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination",type=Path,required=True)
    parser.add_argument("--build-directory",type=Path)
    parser.add_argument("--prebuilt",type=Path,help="Use a hash-pinned compiled Python3.13 platform runtime archive")
    args=parser.parse_args(argv)
    print(json.dumps(stage(args.destination,args.build_directory,args.prebuilt)))

if __name__=="__main__":main()
