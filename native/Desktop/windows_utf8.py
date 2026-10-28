#!/usr/bin/env python3
"""Create an application-owned UTF-8 Python launcher without altering Python.

Windows chooses the ANSI code page when creating a process. A Python UTF-8
text-I/O flag cannot change the native codec DLL's narrow filename APIs.
This private launcher embeds the documented activeCodePage manifest, retains
the current interpreter's explicit module paths and validates the new process.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import sysconfig

ROOT=Path(__file__).resolve().parent
resources=ROOT.parent/"Resources"
if not resources.is_dir():resources=ROOT/"runtime"
sys.path.insert(0,str(resources))
import private_fs as private

def build(destination,paths=()):
    if sys.platform!="win32" or sys.version_info[:2]!=(3,13):
        raise RuntimeError("The UTF-8 desktop launcher requires a trusted Windows Python 3.13 installation.")
    from PyInstaller.utils.win32 import winmanifest
    source=Path(sys.base_prefix).resolve();destination=Path(destination).absolute()
    if destination.exists() or destination.is_symlink():raise RuntimeError("Choose a new GenDragoon UTF-8 launcher directory.")
    private.private_directory(destination)
    originals={}
    def copy_file(original,target):
        original=Path(original)
        if original.is_symlink() or not original.is_file() or original.stat().st_size>64*1024*1024:
            raise RuntimeError("The trusted Python runtime contains an unsupported binary.")
        data=original.read_bytes();originals[str(original)]=hashlib.sha256(data).hexdigest()
        private.private_directory(target.parent);private.write_private(target,data)
    executable=source/"python.exe"
    if not executable.is_file() or not (source/"python313.dll").is_file():
        raise RuntimeError("Use a full, trusted Python 3.13 installation to create the private desktop launcher.")
    for original in (executable,*sorted(source.glob("*.dll"))):copy_file(original,destination/original.name)
    pywin32=Path(sysconfig.get_path("platlib"))/"pywin32_system32"
    if pywin32.is_dir():
        for original in pywin32.glob("*.dll"):copy_file(original,destination/original.name)
    for folder in ("DLLs","tcl"):
        source_folder=source/folder
        if source_folder.is_dir():
            for original in source_folder.rglob("*"):
                if original.is_symlink():raise RuntimeError("The trusted Python runtime contains a linked dependency.")
                target=destination/folder/original.relative_to(source_folder)
                if original.is_dir():private.private_directory(target)
                else:copy_file(original,target)
    for name in ("LICENSE.txt","LICENSE"):
        if (source/name).is_file():copy_file(source/name,destination/name)
    module_paths=[]
    for value in (destination/"DLLs",source/"Lib",*paths,*sys.path):
        if not value:continue
        path=Path(value).absolute()
        if not path.exists():continue
        text=str(path)
        if any(c in text for c in ("\r","\n")):raise RuntimeError("A Python module path contains an invalid line break.")
        if text not in module_paths:module_paths.append(text)
    private.write_private(destination/"python313._pth",("\n".join(module_paths)+"\nimport site\n").encode("utf-8"))
    clone=destination/"python.exe"
    manifest=(ROOT/"windows-utf8.manifest").read_bytes()
    winmanifest.write_manifest_to_executable(str(clone),winmanifest.create_application_manifest(manifest))
    private.protect_generated_tree(destination)
    private.verify(clone)
    probe="import ctypes,tkinter,numpy,PIL,cryptography,win32api,win32event,win32file,win32security,pywintypes; assert ctypes.windll.kernel32.GetACP()==65001, 'The process code page is not UTF-8'"
    checked=subprocess.run([str(clone),"-I","-B","-c",probe],capture_output=True,timeout=45)
    if checked.returncode:raise RuntimeError("The private UTF-8 Python launcher failed its native runtime check: "+checked.stderr.decode("utf-8","replace")[-2000:])
    for name,digest in originals.items():
        if hashlib.sha256(Path(name).read_bytes()).hexdigest()!=digest:
            raise RuntimeError("The source Python runtime changed while creating the private launcher.")
    private.write_private(destination/"SOURCE_MANIFEST.json",json.dumps({"schema":1,"python":"3.13","codePage":65001,"originals":originals},sort_keys=True).encode("utf-8"))
    return clone

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--destination",type=Path,required=True);parser.add_argument("--path",type=Path,action="append",default=[])
    arguments=parser.parse_args();print(json.dumps({"python":str(build(arguments.destination,arguments.path)),"codePage":65001}))

if __name__=="__main__":main()
