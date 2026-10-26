#!/usr/bin/env python3
"""Build a real console PE/ELF host, preserving stdin/stdout native messaging."""
import argparse
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parent

def build(destination):
    if sys.platform!="win32" and not sys.platform.startswith("linux"):
        raise RuntimeError("Build desktop native hosts on their Windows or Linux target.")
    destination=Path(destination).absolute();destination.mkdir(parents=True,exist_ok=True)
    if destination.is_symlink():raise RuntimeError("The host destination is linked.")
    with tempfile.TemporaryDirectory(prefix="gd-host-build-") as td:
        args=[sys.executable,"-B","-m","PyInstaller","--onefile","--console","--noconfirm","--clean",
            "--name","GenDragoonNativeHost","--distpath",str(destination),"--workpath",str(Path(td)/"work"),"--specpath",td,
            "--paths",str(ROOT.parent/"Resources")]
        if sys.platform=="win32":
            args.extend(["--manifest",str(ROOT/"windows-utf8.manifest")])
            for module in ("win32api","win32file","win32pipe","win32security","win32con","win32process","pywintypes","gendragoon_platform_ipc"):
                args.extend(["--hidden-import",module])
        args.append(str(ROOT/"native_host_entry.py"))
        result=subprocess.run(args,capture_output=True,text=True,timeout=600)
        if result.returncode:raise RuntimeError("Native host build failed:\n"+result.stderr[-4000:])
    binary=destination/("GenDragoonNativeHost.exe" if sys.platform=="win32" else "GenDragoonNativeHost")
    with binary.open("rb") as source:
        header=source.read(4)
        if (sys.platform=="win32" and header[:2]!=b"MZ") or (sys.platform.startswith("linux") and header!=b"\x7fELF"):
            raise RuntimeError("The native messaging host has an invalid executable format.")
    if sys.platform.startswith("linux"):binary.chmod(0o700)
    return binary

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--destination",type=Path,required=True)
    args=parser.parse_args(argv);print(build(args.destination))

if __name__=="__main__":main()
