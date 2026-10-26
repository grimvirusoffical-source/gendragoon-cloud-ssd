#!/usr/bin/env python3
"""Build a standalone desktop candidate from a verified staged platform runtime."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from build_native_host import build as build_host

def package(runtime,output):
    runtime=Path(runtime).resolve();output=Path(output).resolve()
    if sys.platform!="win32" and not sys.platform.startswith("linux"):raise RuntimeError("Package desktop candidates on their Windows/Linux target.")
    if not (runtime/"runtime.json").is_file():raise RuntimeError("Stage and verify the pinned platform runtime first.")
    output.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="gd-gui-build-") as td:
        args=[sys.executable,"-B","-m","PyInstaller","--onedir","--noconfirm","--clean","--name","GenDragoon",
            "--distpath",str(output),"--workpath",str(Path(td)/"work"),"--specpath",td,
            "--paths",str(runtime),"--paths",str(runtime/"runtime"),
            "--add-data",str(runtime/"runtime")+":runtime",
            "--add-data",str(runtime/"install_native_host.py")+":.",
            "--hidden-import","tkinter","--hidden-import","tkinter.ttk",
            "--exclude-module","redxai","--exclude-module","redsecretsxai"]
        if sys.platform=="win32":args.append("--windowed")
        for module in ("numpy","PIL","cryptography"):args.extend(["--collect-all",module])
        args.append(str(runtime/"gendragoon_gui.py"))
        result=subprocess.run(args,capture_output=True,text=True,timeout=900)
        if result.returncode:raise RuntimeError("Desktop GUI packaging failed:\n"+result.stderr[-5000:])
    folder=output/"GenDragoon";host=build_host(folder)
    binary=folder/("GenDragoon.exe" if sys.platform=="win32" else "GenDragoon")
    checked=subprocess.run([str(binary),"--check"],capture_output=True,timeout=90)
    if checked.returncode:raise RuntimeError("The packaged GUI could not load its native encryption runtime.")
    checked=subprocess.run([str(host),"--help"],capture_output=True,timeout=45)
    if checked.returncode:raise RuntimeError("The packaged native host could not start.")
    manifest={"schema":1,"platform":sys.platform,"protocol":"MachineNotes-v1","candidate":True,"files":{}}
    for path in folder.rglob("*"):
        if path.is_file():manifest["files"][path.relative_to(folder).as_posix()]={"bytes":path.stat().st_size,"sha256":hashlib.sha256(path.read_bytes()).hexdigest()}
    (folder/"CANDIDATE_MANIFEST.json").write_text(json.dumps(manifest,sort_keys=True,indent=2)+"\n")
    archive=shutil.make_archive(str(output/("GenDragoon-"+sys.platform+"-candidate")),"zip",output,"GenDragoon")
    return {"archive":archive,"sha256":hashlib.sha256(Path(archive).read_bytes()).hexdigest(),"gui":str(binary),"nativeHost":str(host)}

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--runtime",type=Path,required=True);parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args(argv);print(json.dumps(package(args.runtime,args.output)))

if __name__=="__main__":main()
