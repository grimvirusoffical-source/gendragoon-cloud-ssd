#!/usr/bin/env python3
"""Bounded native manifest/index stress and hostile-archive validation.

Runs only against disposable fixtures. No cloud traffic or user files.
"""
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import zipfile
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"Resources"))
import gendragoon_library as lib

def main():
    started=time.monotonic()
    with tempfile.TemporaryDirectory(prefix="gendragoon-stress-") as temporary:
        home=Path(temporary);home.chmod(0o700);support=home/"Support";support.mkdir(mode=0o700)
        root=home/"ManyFiles";root.mkdir()
        for i in range(10000):
            folder=root/str(i//100);folder.mkdir(exist_ok=True)
            (folder/(str(i)+".bin")).write_bytes(("fixture-"+str(i)).encode()*32)
        manifest=lib.snapshot(root)["manifest"]
        if sum(x["type"]=="file" for x in manifest)!=10000:raise AssertionError("Manifest dropped files")
        lib.verify_restored(root,manifest)
        (root/"0/0.bin").write_bytes(b"changed")
        try:lib.verify_restored(root,manifest)
        except RuntimeError:pass
        else:raise AssertionError("Mutation was not detected")
        with patch.object(lib,"HOME",home),patch.object(lib,"SUPPORT",support),patch.object(lib,"INDEX",support/"index.json"):
            def store(i):lib.store(format(i,"018x"),{"name":"Fixture-"+str(i),"kind":"file"})
            with ThreadPoolExecutor(max_workers=16) as pool:list(pool.map(store,range(512)))
            if len(lib.load())!=512:raise AssertionError("Concurrent index commits were lost")
        bad=("../escape","App/../../escape","/absolute","App/../escape","App//file","OtherRoot/file")
        rejected=0
        for i in range(300):
            archive=home/(str(i)+".zip")
            with zipfile.ZipFile(archive,"w") as output:output.writestr(bad[i%len(bad)],b"data")
            try:lib.validate_archive(archive,"App")
            except ValueError:rejected+=1
            else:raise AssertionError("Unsafe archive accepted")
            archive.unlink()
        report={"ok":True,"filesVerified":10000,"parallelIndexWriters":16,"indexCommits":512,
            "hostileArchivesRejected":rejected,"mutationDetected":True,"seconds":round(time.monotonic()-started,3),
            "scope":"disposable local native-helper stress; not full-UI or production cloud load"}
        print(json.dumps(report),flush=True)

if __name__=="__main__":main()
