#!/usr/bin/env python3
"""Bounded, startup-first cache warming. Reads only; never changes app contents.
Logical bytes read are not a measurement of provider network traffic: rclone may read ahead.
"""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse, concurrent.futures, json, multiprocessing, os, plistlib, queue
import shutil, sys, threading, time
from collections import deque
from pathlib import Path
SUPPORT=Path.home()/"Library/Application Support/GenDragoon Cloud SSD"
LIB=SUPPORT/"app-library.json"
MOUNT=Path.home()/"GenDragoon Cloud SSD"
MIN_FREE=64*1024**2  # Small working allowance; the 10 GB recommendation is advisory.
BLOCK=256*1024

def bundle(key):
    entry=json.loads(LIB.read_text()).get(key)
    if not entry or entry.get("format")!="raw" or entry.get("remote")!="gendragoon":
        raise ValueError("This entry is not a mounted, streamable Mac app")
    remote=entry.get("cloudPath","")
    if not remote.startswith("gen-dragoon-ssd/") or not os.path.ismount(MOUNT):
        raise ValueError("Mount the owner cloud SSD first")
    app=MOUNT.joinpath(*remote[len("gen-dragoon-ssd/"):].split("/"))
    if app.is_symlink() or not app.resolve().is_relative_to(MOUNT.resolve()) or app.suffix!=".app":
        raise ValueError("Unsafe application path")
    if not (app/"Contents/Info.plist").is_file():raise ValueError("Incomplete app bundle")
    return app

def candidates(app,deadline=None):
    """Prioritize launch metadata and executable headers, not huge resource archives."""
    app=Path(app).resolve();root=app/"Contents";deadline=deadline or time.monotonic()+10
    found={};seen=set();todo=deque([(root,0)])
    def score(p):
        relative=p.relative_to(app).as_posix()
        if relative in ("Contents/Info.plist","Contents/PkgInfo"):return 0
        if relative.startswith("Contents/MacOS/"):return 2
        if relative.endswith("CodeResources"):return 3
        if "/Frameworks/" in relative and (p.suffix in (".dylib",".so") or not p.suffix):return 4
        if p.suffix.lower() in (".plist",".json",".nib",".storyboardc"):return 5
        return 6
    while todo and len(seen)<100 and len(found)<220 and time.monotonic()<deadline:
        folder,depth=todo.popleft()
        try:
            resolved=folder.resolve(strict=True)
            if not resolved.is_relative_to(app) or resolved in seen:continue
            seen.add(resolved)
            with os.scandir(resolved) as entries:
                for n,entry in enumerate(entries):
                    if n>=300 or time.monotonic()>=deadline:break
                    p=Path(entry.path).resolve(strict=True)
                    # Valid framework symlinks inside the bundle are allowed, escaping links are not.
                    if not p.is_relative_to(app):continue
                    if p.is_file():found[p]=min(score(p),found.get(p,99))
                    elif p.is_dir() and depth<5:todo.append((p,depth+1))
        except (OSError,RuntimeError):continue
    return sorted(found,key=lambda p:(found[p],len(p.parts),str(p)))[:180]

def plan(app,budget,deadline):
    files=candidates(app,deadline);sizes={};ranges=[];left=budget
    for path in files:
        try:sizes[path]=path.stat().st_size
        except OSError:continue
    offsets={p:0 for p in sizes}
    # Spread the first pass over startup files before extending a large executable.
    for path,size in sizes.items():
        if left<=0:break
        amount=min(size,64*1024,left)
        if amount:ranges.append((path,0,amount));offsets[path]=amount;left-=amount
    while left>0 and time.monotonic()<deadline:
        changed=False
        for path,size in sizes.items():
            # Continue prioritizing headers across files, then warm more of a
            # large executable when the caller has a larger startup budget.
            per_file_cap=min(128*1024*1024,max(16*1024*1024,budget//4))
            cap=min(size,per_file_cap)
            amount=min(1024*1024,max(0,cap-offsets[path]),left)
            if amount:
                ranges.append((path,offsets[path],amount));offsets[path]+=amount;left-=amount;changed=True
            if left<=0:break
        if not changed:break
    return ranges

def warm(app,mb=64,limit=8,workers=2,constrained=False):
    started=time.monotonic();deadline=started+max(0.1,min(20,float(limit)))
    budget=max(1,min(512,int(mb)))*1024**2
    if constrained:return {"ok":True,"bytesWarmed":0,"filesWarmed":0,"errors":0,"skipped":"data-saver","seconds":0}
    if shutil.disk_usage(Path.home()).free<MIN_FREE+budget:
        return {"ok":True,"bytesWarmed":0,"filesWarmed":0,"errors":0,"skipped":"low-disk-space","seconds":0}
    tasks=plan(app,budget,deadline);lock=threading.Lock();stats={"bytes":0,"files":set(),"errors":0}
    def read_range(job):
        path,offset,size=job;done=0
        if time.monotonic()>=deadline:return
        try:
            with path.open("rb") as handle:
                handle.seek(offset)
                while done<size and time.monotonic()<deadline:
                    data=handle.read(min(BLOCK,size-done))
                    if not data:break
                    done+=len(data)
        except OSError:
            with lock:stats["errors"]+=1
        finally:
            if done:
                with lock:stats["bytes"]+=done;stats["files"].add(path)
    actual_workers=max(1,min(8,int(workers)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=actual_workers) as executor:
        list(executor.map(read_range,tasks))
    return {"ok":True,"bytesWarmed":stats["bytes"],"filesWarmed":len(stats["files"]),
        "errors":stats["errors"],"seconds":round(time.monotonic()-started,3),"budgetBytes":budget,
        "workers":actual_workers,"rangesPlanned":len(tasks),"deadlineSeconds":round(deadline-started,3),
        "message":"Warmed startup-first byte ranges. This does not guarantee launch speed or app compatibility."}

def worker(result,args):
    try:
        app=Path(args.app).absolute() if args.app else bundle(args.key)
        if args.app:
            allowed=(SUPPORT/"AppLibrary",SUPPORT/"LaunchSessions")
            if app.is_symlink() or not any(app.is_relative_to(root) for root in allowed) or ".." in app.parts or app.suffix.lower()!=".app":
                raise ValueError("Preload path is outside managed application storage")
        result.put(warm(app,args.budget_mb,args.seconds,args.workers,args.constrained))
    except Exception as error:result.put({"ok":False,"message":str(error)[:400]})

def main():
    parser=argparse.ArgumentParser();choice=parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--key");choice.add_argument("--app")
    parser.add_argument("--budget-mb",type=int,default=64);parser.add_argument("--seconds",type=float,default=8)
    parser.add_argument("--workers",type=int,default=2);parser.add_argument("--constrained",action="store_true")
    args=parser.parse_args();args.seconds=max(0.1,min(20,args.seconds))
    # Terminate the isolated read-only worker if an offline filesystem blocks a read.
    context=multiprocessing.get_context("spawn");result=context.Queue();process=context.Process(target=worker,args=(result,args))
    process.start()
    try:response=result.get(timeout=args.seconds+1.25)
    except queue.Empty:response={"ok":False,"timedOut":True,"message":"Preload paused because the provider is slow or offline. No app files were changed."}
    finally:
        if process.is_alive():process.terminate()
        process.join(timeout=0.4)
        if process.is_alive():process.kill();process.join(timeout=0.4)
        result.close()
    print(json.dumps(response),flush=True)
    return 0 if response.get("ok") else 1
if __name__=="__main__":sys.exit(main())
