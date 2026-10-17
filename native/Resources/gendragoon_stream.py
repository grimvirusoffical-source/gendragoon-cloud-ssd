#!/usr/bin/env python3
"""GenDragoon on-demand app streaming: remote apps, space reserve, safe archive offload."""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse,json,os,shutil,subprocess,sys,hashlib,tempfile
from pathlib import Path
HOME=Path.home()
SUPPORT=HOME/"Library/Application Support/GenDragoon Cloud SSD"
LIB=SUPPORT/"app-library.json"
CONFIG=SUPPORT/"gendragoon-rclone.conf"
RCLONE=HOME/"Applications/GenDragoon Cloud SSD.app/Contents/Resources/rclone"
MOUNT=HOME/"GenDragoon Cloud SSD"
RESERVE=10*1024**3
def out(**kw): print(json.dumps({"ok":True,**kw}),flush=True)
def err(e): print(json.dumps({"ok":False,"message":str(e)[-700:]}),flush=True);sys.exit(1)
def call(args,timeout=1800):
 p=subprocess.run([str(x) for x in args],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,errors="replace",timeout=timeout)
 if p.returncode: raise RuntimeError((p.stderr or p.stdout)[-550:])
 return p.stdout
def library(): return json.loads(LIB.read_text()) if LIB.exists() else {}
def save(items):
 SUPPORT.mkdir(parents=True,exist_ok=True)
 tmp=LIB.with_suffix(".stream.tmp");tmp.write_text(json.dumps(items,indent=2))
 os.chmod(tmp,0o600);os.replace(tmp,LIB)
def item(key):
 data=library().get(key)
 if not data:raise ValueError("App not registered in GenDragoon library")
 if data.get("kind","app")!="app":raise ValueError("Smart Launch is only for Mac application bundles")
 return data
def free(): return shutil.disk_usage(str(HOME)).free
def reserve(extra=0):
 actual=free();need=RESERVE+extra
 if actual<need:raise RuntimeError(f"Insufficient SSD space. Free {actual/1024**3:.1f} GiB; need {need/1024**3:.1f} GiB to keep 10 GiB available.")
 return actual
def mount_ready():
 if not os.path.ismount(MOUNT):raise RuntimeError("Mount GenDragoon SSD in Finder before Smart Launch")
def mount_path(remote_path):
 mount_ready()
 # Only the mounted primary Google Cloud bucket is currently supported for native streaming.
 if not remote_path.startswith("gen-dragoon-ssd/"):raise RuntimeError("This cloud provider is not mounted for streaming. Use Run Local Copy instead.")
 local=MOUNT.joinpath(*remote_path.removeprefix("gen-dragoon-ssd/").split("/"))
 if not local.resolve().is_relative_to(MOUNT.resolve()):raise RuntimeError("Unsafe cloud path")
 return local
def stream(key,execute=True):
 data=item(key)
 if data.get("format")!="raw":raise ValueError("This app is stored as a ZIP backup. Re-upload as a streamable app first, or use Run Local Copy.")
 if data.get("remote")!="gendragoon":raise RuntimeError("This provider is not the mounted GenDragoon volume; choose Run Local Copy.")
 reserve()
 p=mount_path(data.get("cloudPath",""))
 if p.suffix.lower()!=".app" or not (p/"Contents/Info.plist").is_file():
  raise RuntimeError("Cloud app bundle is not complete or Finder cannot access it")
 if execute:
  # Warm a bounded startup slice before opening; do not block on an offline/slow provider.
  preload=Path(__file__).with_name("gendragoon_preload.py")
  warmInfo={}
  if preload.is_file():
   try:
    result=call([sys.executable,"-B",preload,"--key",key,"--budget-mb","24","--seconds","0.75","--workers","2"],timeout=4)
    warmInfo=json.loads(result)
   except (OSError,ValueError,subprocess.TimeoutExpired,RuntimeError):pass
  call(["/usr/bin/open",str(p)],timeout=60)
  out(message="Requested cached cloud launch of "+data["name"]+". macOS determines whether the network app can run.",mode="streaming",prefetch=warmInfo)
 else:out(message="Cloud-backed app is accessible for Smart Launch.",mode="streaming",localPath=str(p),freeGiB=round(free()/1024**3,2))
def restore_capacity(key):
 data=item(key)
 cloud_path=data.get("cloudPath") if data.get("format")=="raw" else data.get("folder","")+"/"+data.get("file","")
 remote=data.get("remote","gendragoon")+":"+cloud_path
 stats=json.loads(call([RCLONE,"--config",CONFIG,"size",remote,"--json"],timeout=120))
 raw=int(stats.get("bytes",0))
 # ZIP archives require both the archive and unpacked bundle while restoring.
 factor=2.5 if data.get("format")!="raw" else 1.25
 overhead=int(raw*factor)+512*1024**2
 reserve(overhead)
 out(message="Sufficient SSD space for a local restore, with 10 GiB reserve.",estimatedRequiredGiB=round((overhead+RESERVE)/1024**3,2))
def bundle_size(root):
 return sum(f.stat().st_size for f in root.rglob("*") if f.is_file() and not f.is_symlink())
def upload_stream(source,remote,folder,offload=False):
 # Archive the original for safe offload first, then upload a streamable raw copy.
 import importlib.util
 helper=Path(__file__).with_name("gendragoon_library.py")
 spec=importlib.util.spec_from_file_location("gd_library",helper)
 lib=importlib.util.module_from_spec(spec);spec.loader.exec_module(lib)
 src=Path(source).expanduser().resolve(strict=True)
 lib.ensure_not_cloud(src)
 if lib.kindof(src)!="app":raise ValueError("Choose a macOS .app bundle to make streamable")
 if src.is_symlink() or not (src/"Contents/Info.plist").is_file():raise ValueError("Invalid or linked .app bundle")
 if offload and lib.is_running(src):raise ValueError("Quit the app before offloading it")
 folder=lib.pathpart(folder);lib.check_remote(remote)
 key=lib.keyfor(remote,folder,src.name)
 raw_path=folder+"/Streamable/"+key+"/"+src.name
 target=lib.cloud(remote,raw_path)
 # Raw uploads require rclone links support for macOS bundle symlinks.
 call([RCLONE,"--config",CONFIG,"copy",src,target,"--links","--create-empty-src-dirs","--retries","3"],timeout=3600)
 # Compare downloaded metadata and hashes where provided. If check fails original is kept.
 call([RCLONE,"--config",CONFIG,"check",src,target,"--links","--one-way"],timeout=1800)
 # For offload, retain the robust full round-trip verified ZIP backup.
 backup=None
 if offload:
  size=bundle_size(src)
  reserve(int(size*2.5)+512*1024**2)
  with tempfile.TemporaryDirectory(prefix="gd-safety-",dir=str(lib.CACHE)) as td:
   z=Path(td)/(key+".zip")
   lib.run(["/usr/bin/ditto","-c","-k","--sequesterRsrc","--keepParent",src,z],timeout=1000)
   checksum=lib.sha(z)
   remote_zip=lib.cloud(remote,folder,key+".zip")
   lib.run([RCLONE,"--config",CONFIG,"copyto",z,remote_zip],timeout=3600)
   received=Path(td)/"verify.zip"
   lib.run([RCLONE,"--config",CONFIG,"copyto",remote_zip,received],timeout=3600)
   if lib.sha(received)!=checksum:raise RuntimeError("Verified backup failed: original retained")
   test=Path(td)/"verify";test.mkdir()
   lib.run(["/usr/bin/ditto","-x","-k",received,test],timeout=1000)
   if not (test/src.name/"Contents/Info.plist").exists():raise RuntimeError("Extracted app backup invalid; original retained")
  backup={"file":key+".zip","sha256":checksum}
 entry={"name":src.name,"kind":"app","format":"raw","remote":remote,"folder":folder,"cloudPath":raw_path,"source":str(src),"offloaded":False}
 if backup:entry["archiveBackup"]=backup
 items=library();items[key]=entry;save(items)
 if offload:
  try:
   lib.trash(src)
   entry["offloaded"]=True;items[key]=entry;save(items)
   out(message="Raw cloud app and ZIP backup verified. Original moved to Trash, not permanently deleted. Empty Trash to recover space.",key=key,offloaded=True)
  except Exception as ex:out(message="Cloud app verified; original could not be moved to Trash: "+str(ex)[-250:],key=key,offloaded=False)
 else:out(message="Streamable app uploaded and checked. Original remains installed.",key=key,offloaded=False)
def main():
 p=argparse.ArgumentParser()
 p.add_argument("action",choices=["preflight","stream","capacity","upload"])
 p.add_argument("--key",default="")
 p.add_argument("--source",default="")
 p.add_argument("--remote",default="gendragoon")
 p.add_argument("--folder",default="gen-dragoon-ssd/GenDragoon-App-Library")
 p.add_argument("--offload",action="store_true")
 a=p.parse_args()
 if a.action=="preflight":stream(a.key,False)
 elif a.action=="stream":stream(a.key)
 elif a.action=="capacity":restore_capacity(a.key)
 elif a.action=="upload":upload_stream(a.source,a.remote,a.folder,a.offload)
if __name__=="__main__":
 try: main()
 except Exception as ex:err(ex)
