#!/usr/bin/env python3
"""Validate the maintained Android project without regenerating user source."""
import argparse
from pathlib import Path

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    root=Path(__file__).resolve().parent
    required=("app/build.gradle","app/src/main/AndroidManifest.xml","sync_runtime.py","runtime/gendragoon-android-runtime-9235941b431b.zip")
    missing=[name for name in required if not (root/name).is_file()]
    if missing:parser.exit(1,"Missing maintained Android inputs: "+", ".join(missing)+"\n")
    print("Maintained Red-XAI Android project is present. Nothing was regenerated. See README.md for the pinned build and device gates.")

if __name__=="__main__":main()
