#!/usr/bin/env python3
"""Build the independent FLOSS Windows mount host, never an app/codec bundle."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile

MODULE=Path(__file__).resolve().parent/"MountHost"
LICENSE_NAMES=re.compile(r"^(?:LICEN[SC]E|COPYING|NOTICE|AUTHORS)(?:[._-].*)?$",re.I)

def command(args,environment):
    result=subprocess.run(args,cwd=MODULE,env=environment,capture_output=True,timeout=900)
    if result.returncode:raise RuntimeError("Public mount-host build failed: "+result.stderr.decode(errors="replace")[-5000:])
    return result.stdout

def json_stream(data):
    decoder=json.JSONDecoder();text=data.decode();position=0
    while position<len(text):
        while position<len(text) and text[position].isspace():position+=1
        if position==len(text):break
        item,position=decoder.raw_decode(text,position);yield item

def build(destination):
    destination=Path(destination).absolute()
    if destination.exists() or destination.is_symlink():raise RuntimeError("A fresh standalone host destination is required.")
    go=shutil.which("go")
    if not go:raise RuntimeError("Go 1.26 or newer is required for the public mount host.")
    environment=dict(os.environ,GOOS="windows",GOARCH="amd64",CGO_ENABLED="0",GOTOOLCHAIN="local")
    # No private application/runtime path is passed to Go or copied into output.
    packages=list(json_stream(command([go,"list","-mod=readonly","-tags=cmount","-deps","-json","."],environment)))
    modules={}
    for package in packages:
        module=package.get("Module")
        if module:
            if module.get("Replace"):raise RuntimeError("Dependency replacements are forbidden in the standalone host.")
            modules[module["Path"]]=module
    destination.mkdir(mode=0o700,parents=True)
    notices=destination/"licenses";notices.mkdir(mode=0o700)
    manifest={"schema":1,"name":"GenDragoon Mount Host","version":"1.0.0","target":"windows-amd64",
        "independentFlossArtifact":True,"containsGenDragoonApp":False,"containsPrivateCodec":False,
        "containsWinFsp":False,"modules":{},"files":{}}
    goroot=Path(command([go,"env","GOROOT"],environment).decode().strip())
    for name in ("LICENSE","PATENTS"):
        if (goroot/name).is_file():shutil.copyfile(goroot/name,notices/("Go--"+name))
    if not (notices/"Go--LICENSE").is_file():raise RuntimeError("The Go runtime license notice is required.")
    manifest["goVersion"]=command([go,"version"],environment).decode().strip()
    for name,module in sorted(modules.items()):
        directory=Path(module["Dir"]);label=re.sub(r"[^A-Za-z0-9_.-]","_",name)
        copied=[]
        for source in sorted(directory.iterdir()):
            if source.is_file() and LICENSE_NAMES.fullmatch(source.name):
                if source.stat().st_size>2*1024*1024:raise RuntimeError("A dependency notice exceeds its limit.")
                target=notices/(label+"--"+source.name)
                if target.exists():raise RuntimeError("Dependency notice names collide; retain both notices before release.")
                shutil.copyfile(source,target);copied.append(target.name)
        if not copied:raise RuntimeError("A public dependency is missing its license notice: "+name)
        manifest["modules"][name]={"version":module.get("Version","owned-source"),"sum":module.get("Sum"),"notices":copied}
    binary=destination/"GenDragoonMountHost.exe"
    command([go,"build","-mod=readonly","-trimpath","-buildvcs=false","-tags=cmount","-ldflags=-s -w","-o",str(binary),"."],environment)
    if binary.read_bytes()[:2]!=b"MZ":raise RuntimeError("The standalone host is not a Windows PE executable.")
    for name in ("README.md","LICENSE","THIRD_PARTY_NOTICES.md"):
        shutil.copyfile(MODULE/name,destination/name)
    legal=MODULE/"notices";target_notices=destination/"notices"
    if legal.is_symlink() or not legal.is_dir():raise RuntimeError("The standalone host's original third-party notices are required.")
    target_notices.mkdir(mode=0o700)
    for source in sorted(legal.iterdir()):
        if source.is_symlink() or not source.is_file() or source.suffix!=".txt" or not 0<source.stat().st_size<128*1024:
            raise RuntimeError("An unexpected third-party notice input was found.")
        shutil.copyfile(source,target_notices/source.name)
    # Corresponding owned source is an independent archive. Public dependencies
    # remain exact upstream modules, identified by go.mod/go.sum and notices.
    def source_metadata(info):
        info.uid=info.gid=0;info.uname=info.gname="";info.mtime=0;info.mode=0o644;info.pax_headers={}
        return info
    with tarfile.open(destination/"GenDragoonMountHost-source.tar.gz","w:gz") as archive:
        for source in sorted(MODULE.rglob("*")):
            relative=source.relative_to(MODULE)
            if any(p.startswith(".") for p in relative.parts):continue
            if source.is_symlink():raise RuntimeError("Linked inputs are forbidden in the independent host source archive.")
            if not source.is_file():continue
            if source.name not in ("LICENSE","go.mod","go.sum") and source.suffix not in (".go",".md",".txt",".json"):
                raise RuntimeError("Unexpected non-source input in the independent host module.")
            archive.add(source,arcname="GenDragoonMountHost/"+relative.as_posix(),recursive=False,filter=source_metadata)
    for path in destination.rglob("*"):
        if path.is_file():manifest["files"][path.relative_to(destination).as_posix()]={"bytes":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
    (destination/"STANDALONE_HOST_MANIFEST.json").write_text(json.dumps(manifest,sort_keys=True,indent=2)+"\n")
    return {"binary":str(binary),"sha256":hashlib.sha256(binary.read_bytes()).hexdigest(),"independentFlossArtifact":True}

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--destination",type=Path,required=True)
    args=parser.parse_args(argv);print(json.dumps(build(args.destination)))

if __name__=="__main__":main()
