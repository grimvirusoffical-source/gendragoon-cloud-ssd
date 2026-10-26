#!/usr/bin/env python3
"""Build a real console PE native-messaging host; no shell/batch host substitution."""
import argparse
from pathlib import Path
import subprocess
import sys
import tempfile
from build_native_host import build as build_native

ROOT=Path(__file__).resolve().parent

def build(destination):
    if sys.platform!="win32":raise RuntimeError("Build the Windows native host on Windows.")
    return build_native(destination)

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument("--destination",type=Path,required=True)
    args=parser.parse_args(argv);print(build(args.destination))

if __name__=="__main__":main()
