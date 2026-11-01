#!/usr/bin/env python3
"""CI-only checksum-pinned rclone fixture. Never installs a driver or global tool."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import sys
from urllib.parse import urlsplit
from urllib.request import urlopen
import zipfile

VERSION="1.75.2"
DIGESTS={"linux":"349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702",
         "windows":"8a9db2bad1dc79a65b3348fd857069598e2aab7cf4d118b77b1df23055aff818"}

def stage(destination):
    if os.environ.get("GITHUB_ACTIONS")!="true":raise RuntimeError("This fixture stages rclone only inside an ephemeral GitHub Actions runner.")
    target={"linux":"linux","win32":"windows"}.get(sys.platform if sys.platform=="win32" else "linux" if sys.platform.startswith("linux") else "")
    if target is None or platform.machine().lower() not in ("amd64","x86_64"):raise RuntimeError("This CI fixture requires Windows/Linux x86_64.")
    root=Path(os.environ["RUNNER_TEMP"]).resolve();destination=Path(destination).absolute()
    if not destination.is_relative_to(root) or destination.exists():raise RuntimeError("Choose a new fixture directory inside RUNNER_TEMP.")
    resources=Path(__file__).resolve().parent.parent/"Resources";sys.path.insert(0,str(resources))
    import private_fs as private
    private.private_directory(destination)
    name=f"rclone-v{VERSION}-{target}-amd64";url=f"https://github.com/rclone/rclone/releases/download/v{VERSION}/{name}.zip"
    with urlopen(url,timeout=60) as response:
        final=urlsplit(response.geturl())
        if final.scheme!="https" or final.hostname not in ("github.com","release-assets.githubusercontent.com","objects.githubusercontent.com"):
            raise RuntimeError("The CI fixture download left the official GitHub release hosts.")
        data=response.read(128*1024*1024+1)
    if len(data)>128*1024*1024 or hashlib.sha256(data).hexdigest()!=DIGESTS[target]:raise RuntimeError("The official rclone CI archive digest did not match.")
    executable="rclone.exe" if target=="windows" else "rclone"
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        member=archive.getinfo(name+"/"+executable)
        if member.file_size>256*1024*1024:raise RuntimeError("The CI executable exceeds its limit.")
        binary=archive.read(member)
    path=destination/executable;private.write_private(path,binary)
    if os.name!="nt":path.chmod(0o700)
    return path

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--destination",type=Path,required=True)
    args=parser.parse_args();path=stage(args.destination)
    if any(c in str(path) for c in ("\r","\n")):raise RuntimeError("Invalid fixture path.")
    with open(os.environ["GITHUB_ENV"],"a",encoding="utf-8") as output:output.write("GD_TEST_RCLONE="+str(path)+"\n")
    print(json.dumps({"fixture":"rclone","version":VERSION,"driverInstalled":False,"permissionsChanged":False}))

if __name__=="__main__":main()
