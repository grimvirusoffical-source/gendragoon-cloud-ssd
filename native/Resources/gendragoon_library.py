#!/usr/bin/env python3
"""GenDragoon cloud library: verified app/file/folder archives, remote discovery and local staging."""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import argparse, hashlib, json, os, plistlib, re, shutil, subprocess, sys, tempfile
from contextlib import contextmanager
import ctypes, errno, fcntl, posixpath, stat, time, unicodedata, uuid, zipfile
from pathlib import Path
import gendragoon_performance as performance
import gendragoon_progress as progress
import gendragoon_device_origin as device_origin
HOME=Path.home()
def rclone_path(helper=__file__):
    helper=Path(helper).absolute()
    if helper.parent.name=="Resources" and helper.parent.parent.name=="Contents" and helper.parent.parent.parent.suffix.lower()==".app":
        return helper.with_name("rclone")
    return HOME/"Applications/GenDragoon Cloud SSD.app/Contents/Resources/rclone"
SUPPORT=HOME/"Library/Application Support/GenDragoon Cloud SSD"
CONFIG=SUPPORT/"gendragoon-rclone.conf"
RCLONE=rclone_path()
CACHE=SUPPORT/"AppLibrary"
INDEX=SUPPORT/"app-library.json"
DEFAULT_ROOT="gen-dragoon-ssd"
ARCHIVE_DIR="GenDragoon-App-Library"
STREAM_MIN_BYTES=512*1024**2
def reply(**v): print(json.dumps(dict(ok=True,**v)),flush=True)
def fail(e):
    from gendragoon_transfer_errors import failure_for, MESSAGES
    failure=failure_for(e)
    value=dict(ok=False,message=MESSAGES[failure["code"]] if failure else str(e)[-650:])
    if failure:value["failure"]=failure
    print(json.dumps(value),flush=True);sys.exit(1)
def run(cmd,timeout=1800):
    if str(cmd[0])==str(RCLONE) and any(str(x) in {"copy", "copyto", "check"} for x in cmd[1:]):
        cmd=[cmd[0],*performance.rclone_arguments(),*cmd[1:]]
    p=subprocess.run([str(x) for x in cmd],stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,errors="replace",timeout=timeout)
    if p.returncode: raise RuntimeError("Cloud/local operation failed (exit "+str(p.returncode)+"). Original files were preserved.")
    return p.stdout
def sha(path):
    h=hashlib.sha256()
    with open(path,"rb") as f:
        for part in iter(lambda:f.read(1024*1024),b""):h.update(part)
    return h.hexdigest()
def safe_path(path, directory=False):
    path=Path(path).absolute()
    for part in (path,*path.parents):
        if part.is_symlink():raise ValueError("Unsafe linked library path")
        if (part==HOME or HOME in part.parents) and part.exists() and part.is_dir():
            info=part.lstat()
            if info.st_uid!=os.getuid() or info.st_mode&0o022:raise ValueError("Unsafe library directory ancestry")
    if path.exists():
        info=path.lstat()
        if info.st_uid!=os.getuid():raise ValueError("Library path is not owned by this user")
        if directory:
            if not stat.S_ISDIR(info.st_mode) or info.st_mode&0o022:raise ValueError("Unsafe library directory")
        elif not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_mode&0o077:
            raise ValueError("Unsafe shared library file")
    return path
def prepare_cache():
    safe_path(SUPPORT,directory=True);SUPPORT.mkdir(parents=True,exist_ok=True,mode=0o700)
    safe_path(CACHE,directory=True);CACHE.mkdir(mode=0o700,exist_ok=True)
    CACHE.chmod(0o700)
@contextmanager
def library_lock():
    safe_path(SUPPORT,directory=True);SUPPORT.mkdir(parents=True,exist_ok=True,mode=0o700)
    path=safe_path(SUPPORT/"app-library.lock")
    fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError("Unsafe library lock")
        fcntl.flock(fd,fcntl.LOCK_EX)
        yield
    finally:fcntl.flock(fd,fcntl.LOCK_UN);os.close(fd)
def _load():
    safe_path(INDEX)
    if not INDEX.exists():return {}
    data=json.loads(INDEX.read_text())
    if not isinstance(data,dict):raise ValueError("Invalid app-library index")
    if any(not re.fullmatch(r"[a-f0-9]{16}(?:[a-f0-9]{2})?",k) or not isinstance(v,dict) for k,v in data.items()):raise ValueError("Invalid library entry")
    return data
def load():
    with library_lock():return _load()
def _save(data):
    safe_path(INDEX)
    fd,name=tempfile.mkstemp(prefix=".library-",dir=SUPPORT)
    try:
        with os.fdopen(fd,"w",encoding="utf8") as output:
            json.dump(data,output,ensure_ascii=False,indent=2);output.flush();os.fsync(output.fileno())
        safe_path(INDEX);os.replace(name,INDEX)
    finally:
        if os.path.exists(name):os.unlink(name)
def save(data):
    with library_lock():_save(data)
def store(key,entry):
    with library_lock():
        data=_load();data[key]=entry;_save(data)
def store_revision(key,entry,expected):
    with library_lock():
        data=_load()
        if data.get(key)!=expected:raise RuntimeError("Library entry changed during upload; original retained")
        data[key]=entry;_save(data)
@contextmanager
def upload_lease(key):
    prepare_cache()
    root=CACHE/".upload-locks";safe_path(root,directory=True);root.mkdir(mode=0o700,exist_ok=True)
    path=safe_path(root/(key+".lock"));fd=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
    locked=False
    try:
        info=os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or info.st_mode&0o077:raise ValueError("Unsafe upload lease")
        try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB);locked=True
        except BlockingIOError:raise RuntimeError("This library item already has an upload in progress") from None
        yield
    finally:
        if locked:fcntl.flock(fd,fcntl.LOCK_UN)
        os.close(fd)
@contextmanager
def maintenance_lock(inherited=None):
    safe_path(SUPPORT,directory=True);SUPPORT.mkdir(parents=True,exist_ok=True,mode=0o700)
    root=SUPPORT/"AutoUpdates";safe_path(root,directory=True);root.mkdir(mode=0o700,exist_ok=True)
    path=safe_path(root/"update.lock")
    own=inherited is None
    descriptor=os.open(path,os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600) if own else inherited
    locked=False
    try:
        if not path.exists():raise ValueError("Inherited maintenance lock does not match the managed lock")
        info=os.fstat(descriptor);expected=path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1 or info.st_mode&0o077 or (info.st_dev,info.st_ino)!=(expected.st_dev,expected.st_ino):raise ValueError("Unsafe inherited maintenance lock")
        try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB);locked=True
        except BlockingIOError:raise RuntimeError("An upload, update, restart or cloud configuration is already active") from None
        yield
    finally:
        # Never unlock an inherited open-file description: the parent workspace
        # owns the same lease across its complete queued transaction.
        if own:
            if locked:fcntl.flock(descriptor,fcntl.LOCK_UN)
            os.close(descriptor)
def check_remote(s):
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,49}",s or ""):raise ValueError("Invalid cloud remote")
    if s=="redxai":return s
    safe_path(CONFIG)
    if not CONFIG.exists():raise ValueError("No GenDragoon cloud configuration")
    if any(path.is_symlink() for path in (RCLONE,*RCLONE.parents)):raise ValueError("Unsafe linked bundled cloud tool")
    return s
def pathpart(s):
    if not s or s.startswith("/") or "\\" in s or ":" in s or any(x in ("..",".") for x in Path(s).parts):raise ValueError("Invalid cloud path")
    return s.strip("/")
def selected_context(project=None,bucket=None,remote="gendragoon",folder=None):
    if not project and not bucket:return None
    if not project or not bucket:raise ValueError("Choose both a project and bucket")
    if not re.fullmatch(r"[a-z][a-z0-9-]{4,28}[a-z0-9]",project):raise ValueError("Invalid project")
    if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]",bucket) or ".." in bucket or re.fullmatch(r"[0-9]+(?:\.[0-9]+){3}",bucket):raise ValueError("Invalid bucket")
    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,49}",remote):raise ValueError("Invalid remote")
    if folder is not None and pathpart(folder).split("/")[0]!=bucket:raise ValueError("Cloud folder does not belong to the selected bucket")
    return {"project":project,"bucket":bucket,"remote":remote}
def in_context(entry,context):
    return context is None or all(entry.get(k)==v for k,v in context.items())
def adopt_legacy_context(context):
    """Keep old keys/cache paths; bind only to an independently verified workspace.

    A bucket name is globally unique. Never infer ownership from a display name
    or mark legacy content verified merely because its destination matches.
    """
    if context is None:return
    import gendragoon_upload_workspace as workspace
    if not any(not entry.get("project") and not entry.get("bucket") for entry in load().values()):return
    chosen=workspace.read_state(home=HOME).get("destination") or {}
    if any(chosen.get(k)!=v for k,v in context.items()):return
    with library_lock():
        entries=_load();changed=False
        for entry in entries.values():
            location=entry.get("cloudPath") or entry.get("folder") or ""
            if (entry.get("project") or entry.get("bucket") or entry.get("remote")!=context["remote"]
                    or location.split("/")[0]!=context["bucket"]):continue
            entry.update(context)
            entry.setdefault("kind","app" if str(entry.get("name","")).lower().endswith(".app") else "file")
            entry.setdefault("format","raw" if entry.get("cloudPath") else "archive")
            entry["legacyContextMigratedAt"]=time.time();changed=True
        if changed:_save(entries)
def cloud(remote,folder,name=None):
    v=check_remote(remote)+":"+pathpart(folder)
    return v+("/"+pathpart(name) if name else "")
def kindof(src):
    if src.is_dir() and src.name.lower().endswith(".app"):return "app"
    return "folder" if src.is_dir() else "file"
def ensure_not_cloud(src):
    path=str(src)
    forbidden=[str(HOME/"GenDragoon Cloud SSD"),str(SUPPORT),str(HOME/"Applications/GenDragoon Cloud SSD.app"),"/System","/usr","/bin","/sbin"]
    forbidden += [str(parent) for parent in Path(__file__).absolute().parents if parent.suffix.lower()==".app"]
    for bad in forbidden:
        if path==bad or path.startswith(bad+"/"):raise ValueError("This source is protected or already in GenDragoon cloud storage")
        if src.is_dir() and src in Path(bad).parents:raise ValueError("Selected folder contains protected cloud, cache or application paths; choose a smaller folder")
    if src in (Path("/"),HOME,HOME/"Library",HOME/"Applications",Path("/Applications"),Path("/Library")):
        raise ValueError("Select individual files, folders or app bundles rather than an entire protected root")
def keyfor(remote,folder,name,project=None,bucket=None,parent_key=None):
    context=selected_context(project,bucket,remote,folder)
    parts=([project,bucket] if context else [])+[remote,folder,name]
    if parent_key is not None:
        if remote!="redxai" or not re.fullmatch(r"[a-f0-9]{18}",parent_key):raise ValueError("Invalid MachineNote folder")
        parts += ["parent",parent_key]
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:18]
def remote_list():
    if not CONFIG.exists():return reply(remotes=[])
    output=run([RCLONE,"--config",CONFIG,"listremotes"],timeout=30)
    reply(remotes=[x.rstrip(":") for x in output.splitlines() if x.strip()])
def scan(remote,root,project=None,bucket=None):
    check_remote(remote);root=pathpart(root)
    context=selected_context(project,bucket,remote,root)
    base=cloud(remote,root)
    directories=run([RCLONE,"--config",CONFIG,"lsf",base,"--dirs-only","--max-depth","1"],timeout=120).splitlines()
    files=run([RCLONE,"--config",CONFIG,"lsf",base,"--files-only","--max-depth","1"],timeout=120).splitlines()
    discovered=0
    with library_lock():
        entries=_load()
        existing_raw={(x.get("remote"),x.get("cloudPath")) for x in entries.values() if x.get("format")=="raw" and in_context(x,context)}
        for line in directories+files:
            name=line.rstrip("/")
            if not name or name.startswith(".") or "/" in name or name==ARCHIVE_DIR:continue
            check_name(name)
            isdir=line.endswith("/");location=root+"/"+name
            if (remote,location) in existing_raw:continue
            k=keyfor(remote,root,name,project,bucket)
            if k in entries:continue
            kind="app" if name.lower().endswith(".app") and isdir else ("folder" if isdir else "file")
            entries[k]={"name":name,"kind":kind,"format":"raw","remote":remote,"folder":root,"cloudPath":location,"offloaded":True,"sha256":"",**(context or {})}
            discovered+=1
        if discovered:_save(entries)
    reply(message=f"Found {discovered} new cloud items",discovered=discovered,items=present(entries,context))
def present(entries,context):
    return [dict(key=k,kind=v.get("kind","app"),format=v.get("format","archive"),previousVersionCount=len(v.get("previousVersions",[])),**{a:b for a,b in v.items() if a not in ("kind","format","manifest","previousVersions","previousVersionCount")}) for k,v in sorted(entries.items()) if in_context(v,context) and not(v.get("format")=="redxai" and v.get("cloudMissing"))]
def redx_module():
    import gendragoon_storage_mode
    return gendragoon_storage_mode

def redx_config():
    value=performance.private_payload()
    return redx_module().validate_config(value)

def sync_redx_library(project,bucket,remote,cloud_snapshot=None):
    if remote!="redxai":return
    context=selected_context(project,bucket,remote)
    config=redx_config()
    if config["workspaceId"]!=bucket:raise ValueError("Red-XAI workspace changed; refresh the destination")
    client=redx_module().RedXReceiver(config)
    if cloud_snapshot is None:client.verified_workers()
    snapshot=client.library_snapshot() if cloud_snapshot is None else cloud_snapshot
    cloud_items=snapshot["items"]
    with library_lock():
        entries=_load();changed=False;seen=set()
        for item in cloud_items:
            if item.get("workspace")!=bucket:continue
            key=item["key"];seen.add(key);existing=entries.get(key,{})
            virtual=item.get("virtualFolder") is True
            same=existing.get("redxManifestId")==item.get("manifestId")
            base={"name":item["name"],"kind":item["kind"],"format":"redxai","archiveLayout":existing.get("archiveLayout",""),
                  "displayName":item.get("displayName",item["name"]),"parentKey":item.get("parentKey"),"virtualFolder":virtual,"archiveKey":item.get("archiveKey",key),
                  "origin":device_origin.validate_origin(item.get("origin")),"applicationPlatform":device_origin.validate_application_platform(item.get("applicationPlatform")),
                  "remote":"redxai","folder":bucket+"/Library","file":item.get("manifestId","")+".png" if not virtual else "","sha256":item.get("archiveSha256",""),
                  "source":existing.get("source",""),"offloaded":existing.get("offloaded",True),
                  "verified":existing.get("verified",False) if same else False,"verifiedAt":existing.get("verifiedAt",0) if same else 0,
                  "manifest":existing.get("manifest",[]) if same else [],"sizeBytes":item.get("archiveBytes",0),
                  "redxManifestId":item.get("manifestId"),"redxGeneration":item.get("generation",1),"redxTreeRevision":snapshot["revision"],
                  "cacheTreeRevision":existing.get("cacheTreeRevision"),**context}
            if existing.get("cacheName"):base["cacheName"]=existing["cacheName"]
            if existing!=base:
                if existing.get("previousVersions"):base["previousVersions"]=existing["previousVersions"]
                entries[key]=base;changed=True
        for key,entry in entries.items():
            if in_context(entry,context) and entry.get("format")=="redxai" and key not in seen and not entry.get("cloudMissing"):
                entry["cloudMissing"]=True;changed=True
        if changed:_save(entries)
    return snapshot["revision"]

def listing(project=None,bucket=None,remote="gendragoon"):
    context=selected_context(project,bucket,remote);adopt_legacy_context(context)
    revision=sync_redx_library(project,bucket,remote) if remote=="redxai" else None
    reply(items=present(load(),context),revision=revision)
def remotes():remote_list()

def organize(operation,keys,name=None,parent_key=None,expected_revision=None,project=None,bucket=None,remote="redxai"):
    if remote!="redxai":raise ValueError("Library organization requires a Red-XAI MachineNote")
    context=selected_context(project,bucket,remote);config=redx_config()
    if config["workspaceId"]!=bucket:raise ValueError("MachineNote changed; refresh the folder")
    if operation not in {"create-folder","rename","move","copy","delete"}:raise ValueError("Invalid library operation")
    if (not isinstance(keys,list) or len(keys)>100 or len(set(keys))!=len(keys)
            or any(not isinstance(key,str) or not re.fullmatch(r"[a-f0-9]{18}",key) for key in keys)):
        raise ValueError("Invalid library selection")
    if parent_key is not None and not re.fullmatch(r"[a-f0-9]{18}",parent_key):raise ValueError("Invalid destination folder")
    if type(expected_revision) is not int or expected_revision<0:raise ValueError("Refresh the folder before organizing its items")
    if name is not None:check_name(name)
    client=redx_module().RedXReceiver(config);client.verified_workers(write=True)
    snapshot=client.library_snapshot();by_key={item["key"]:item for item in snapshot["items"]}
    if snapshot["revision"]!=expected_revision:raise RuntimeError("Library changed. Refresh the folder and try again.")
    if any(key not in by_key for key in keys):raise ValueError("Selected item is not in this MachineNote")
    if parent_key is not None and (parent_key not in by_key or by_key[parent_key].get("virtualFolder") is not True):
        raise ValueError("Choose an existing library folder as the destination")
    if operation=="move":
        visited=set();ancestor=parent_key
        while ancestor:
            if ancestor in keys:raise ValueError("A folder cannot be moved inside itself or one of its children")
            if ancestor in visited or ancestor not in by_key:raise ValueError("Invalid library folder hierarchy")
            visited.add(ancestor);ancestor=by_key[ancestor].get("parentKey")
    result=client.organize(operation,keys,parent_key=parent_key,name=name,expected_revision=expected_revision)
    revision=sync_redx_library(project,bucket,remote,result)
    message="Removed from the library. Encrypted archive data is retained until the MachineNote is deleted." if operation=="delete" else "Library updated."
    reply(message=message,revision=revision,items=present(load(),context),changedKeys=result.get("changedKeys",[]),
          deletedKeys=result.get("deletedKeys",[]),freedBytes=result.get("freedBytes",0),retainedArchiveData=result.get("retainedArchiveData",False))
def is_running(app):
    # Compare executable's app bundle path; don't infer process identity from app name alone.
    result=run(["/bin/ps","-axo","command"],timeout=20)
    p=str(app)
    return any(line.strip()==p or line.strip().startswith(p+" ") or (line.strip().startswith(p+"/") and "/Contents/MacOS/" in line) for line in result.splitlines())
def trash(src):
    # Finder moves items into Trash without deleting them permanently.
    program=['/usr/bin/osascript',
       '-e','on run argv',
       '-e','tell application "Finder"',
       '-e','delete (POSIX file (item 1 of argv))',
       '-e','end tell',
       '-e','end run',str(src)]
    run(program,timeout=150)
# Python.org macOS builds do not necessarily expose os.listxattr/getxattr.
# The libc fallback uses Darwin's ABI and never follows a changed symlink.
XATTR_NOFOLLOW=0x0001
MAX_XATTR_NAMES_BYTES=1024*1024
MAX_XATTR_VALUE_BYTES=64*1024*1024
MAX_XATTR_TOTAL_BYTES=128*1024*1024
MAX_XATTR_NAMES=4096
_XATTR_NATIVE=None

def _native_xattr_api():
    global _XATTR_NATIVE
    if _XATTR_NATIVE is None:
        try:
            native=ctypes.CDLL("/usr/lib/libSystem.B.dylib",use_errno=True)
            native.listxattr.argtypes=[ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int]
            native.listxattr.restype=ctypes.c_ssize_t
            native.getxattr.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_uint32,ctypes.c_int]
            native.getxattr.restype=ctypes.c_ssize_t
        except (OSError,AttributeError) as error:
            raise RuntimeError("macOS metadata verification is unavailable; original retained") from error
        _XATTR_NATIVE=native
    return _XATTR_NATIVE

def _native_xattr_bytes(call,maximum,path):
    for _ in range(3):
        size=call(None,0)
        if size<0:
            code=ctypes.get_errno() or errno.EIO
            raise OSError(code,"Cannot verify extended attributes; original retained",os.fspath(path))
        if size>maximum:
            raise RuntimeError("Extended attributes exceed the bounded verification limit; original retained")
        buffer=ctypes.create_string_buffer(max(1,size))
        count=call(buffer,size)
        if count<0:
            code=ctypes.get_errno() or errno.EIO
            if code==errno.ERANGE:continue
            raise OSError(code,"Cannot verify extended attributes; original retained",os.fspath(path))
        if count!=size:continue
        return buffer.raw[:count]
    raise RuntimeError("Extended attributes changed while being read; original retained")

def _native_macos_xattrs(path):
    encoded=os.fsencode(path)
    if b"\0" in encoded:raise ValueError("Invalid metadata path")
    native=_native_xattr_api()
    names=_native_xattr_bytes(lambda buffer,size:native.listxattr(encoded,buffer,size,XATTR_NOFOLLOW),MAX_XATTR_NAMES_BYTES,path)
    if not names:return {}
    if not names.endswith(b"\0"):
        raise RuntimeError("Invalid extended attribute list; original retained")
    names=names[:-1].split(b"\0")
    if len(names)>MAX_XATTR_NAMES or len(set(names))!=len(names) or any(not name or len(name)>255 for name in names):
        raise RuntimeError("Invalid or excessive extended attributes; original retained")
    attributes={};total=0
    for name in sorted(names):
        # Provenance is local security bookkeeping generated by macOS on receipt.
        if name==b"com.apple.provenance":continue
        value=_native_xattr_bytes(lambda buffer,size:native.getxattr(encoded,name,buffer,size,0,XATTR_NOFOLLOW),
                                  min(MAX_XATTR_VALUE_BYTES,MAX_XATTR_TOTAL_BYTES-total),path)
        total+=len(value)
        attributes[os.fsdecode(name)]={"size":len(value),"sha256":hashlib.sha256(value).hexdigest()}
    return attributes

def macos_xattrs(path):
    list_api=getattr(os,"listxattr",None);get_api=getattr(os,"getxattr",None)
    if not callable(list_api) or not callable(get_api):return _native_macos_xattrs(path)
    names=list_api(path,follow_symlinks=False)
    if (len(names)>MAX_XATTR_NAMES or len(set(names))!=len(names)
            or sum(len(os.fsencode(name))+1 for name in names)>MAX_XATTR_NAMES_BYTES):
        raise RuntimeError("Invalid or excessive extended attributes; original retained")
    attributes={};total=0
    for name in sorted(names):
        if name=="com.apple.provenance":continue
        value=get_api(path,name,follow_symlinks=False)
        total+=len(value)
        if len(value)>MAX_XATTR_VALUE_BYTES or total>MAX_XATTR_TOTAL_BYTES:
            raise RuntimeError("Extended attributes exceed the bounded verification limit; original retained")
        attributes[name]={"size":len(value),"sha256":hashlib.sha256(value).hexdigest()}
    return attributes

def _fingerprint(info):
    return (info.st_dev,info.st_ino,info.st_mode,info.st_size,info.st_mtime_ns,info.st_ctime_ns)
def snapshot(source):
    """Deterministic restore metadata plus a local mutation guard; never follow links."""
    source=Path(source).absolute()
    if source.is_symlink():raise ValueError("Select an actual file or folder, not a symlink")
    boundary=source if source.is_dir() else source.parent
    records=[];guards={}
    def visit(path,relative):
        before=path.lstat();kind=stat.S_IFMT(before.st_mode)
        entry={"path":relative,"executable":before.st_mode&0o111}
        if sys.platform=="darwin" and not stat.S_ISLNK(kind):
            # Resource forks and extended attributes may contain user data.
            # Metadata read failures abort verification and retain the original.
            entry["xattrs"]=macos_xattrs(path)
        guards[relative]=_fingerprint(before)
        if stat.S_ISLNK(kind):
            target=os.readlink(path)
            try:path.resolve(strict=False).relative_to(boundary)
            except (ValueError,RuntimeError):raise ValueError("Source contains an escaping or looping symlink") from None
            if os.path.isabs(target):raise ValueError("Absolute source symlinks cannot be restored safely")
            entry.update(type="symlink",target=target,executable=0)
        elif stat.S_ISREG(kind):
            descriptor=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
            with os.fdopen(descriptor,"rb") as stream:
                if _fingerprint(os.fstat(stream.fileno()))!=guards[relative]:raise RuntimeError("Source changed while reading; original retained")
                digest=hashlib.sha256();size=0
                for block in iter(lambda:stream.read(1024*1024),b""):digest.update(block);size+=len(block)
                if _fingerprint(os.fstat(stream.fileno()))!=guards[relative]:raise RuntimeError("Source changed while reading; original retained")
            entry.update(type="file",size=size,sha256=digest.hexdigest())
        elif stat.S_ISDIR(kind):
            entry.update(type="directory")
            for child in sorted(path.iterdir(),key=lambda x:x.name):
                check_name(child.name);visit(child,child.name if relative=="." else relative+"/"+child.name)
        else:raise ValueError("Special devices, sockets and pipes cannot be uploaded")
        if _fingerprint(path.lstat())!=guards[relative]:raise RuntimeError("Source changed while reading; original retained")
        records.append(entry)
    visit(source,".")
    return {"manifest":sorted(records,key=lambda x:x["path"]),"guard":guards}
def unchanged(source,baseline):
    if snapshot(source)!=baseline:raise RuntimeError("Source changed since the verified archive; original retained")
def verify_restored(path,manifest):
    verified=snapshot(path);actual=verified["manifest"]
    # Older library manifests predate xattr recording. Do not fabricate it for
    # those backups, but enforce it whenever the original included metadata.
    expected={x["path"]:x for x in manifest}
    for entry in actual:
        if "xattrs" not in expected.get(entry["path"],{}):entry.pop("xattrs",None)
    if actual!=manifest:raise RuntimeError("Restored content or metadata differs from the source; original retained")
    return verified
def require_space(extra,root=None):
    free=shutil.disk_usage(root or CACHE).free
    # 10 GB is guidance, not an admission threshold. The caller measures its
    # staging requirement; leave a small bounded allowance for filesystem work.
    margin=max(64*1024**2,min(512*1024**2,max(0,extra)//20))
    if extra<0 or free<margin+extra:
        raise RuntimeError("Not enough local space for this operation's verified staging copy. Original and cloud copies were preserved.")

# Darwin copyfile.h: metadata only, AppleDouble serialization, exclusive output,
# and no following source/destination symlinks. No data-fork copy is requested.
COPYFILE_PACK_METADATA=7|(1<<22)|(1<<17)|(1<<18)|(1<<19)
MAX_PACKED_METADATA_BYTES=MAX_XATTR_TOTAL_BYTES+2*1024*1024

def _pack_directory_metadata(source,destination):
    """Use Apple's native AppleDouble format, including ACLs and quarantine."""
    source,destination=Path(source).absolute(),Path(destination).absolute()
    for path in (source,destination):
        if b"\0" in os.fsencode(path) or any(part.is_symlink() for part in (path,*path.parents)):
            raise ValueError("Unsafe directory metadata path")
    before=source.lstat()
    if not stat.S_ISDIR(before.st_mode) or destination.exists():
        raise ValueError("Directory metadata needs a real source and a new private output")
    native=_native_xattr_api().copyfile
    native.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_void_p,ctypes.c_uint32]
    native.restype=ctypes.c_int
    if native(os.fsencode(source),os.fsencode(destination),None,COPYFILE_PACK_METADATA)!=0:
        raise OSError(ctypes.get_errno() or errno.EIO,"Could not preserve directory metadata; original retained")
    if _fingerprint(source.lstat())!=_fingerprint(before):
        raise RuntimeError("Source changed while packing directory metadata; original retained")
    info=destination.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid() or info.st_nlink!=1
            or not 0<info.st_size<=MAX_PACKED_METADATA_BYTES):
        raise RuntimeError("Packed directory metadata is invalid or exceeds its safe limit; original retained")
    destination.chmod(0o600)

def _supplement_root_directory_metadata(source,archive):
    """ditto --keepParent can omit only the root's __MACOSX/._name entry.

    Supplement it before hashing/uploading, so every restore uses the same
    checksum-bound metadata through ordinary ditto extraction. No full app copy
    and no special restore format are needed. Existing archives stay readable.
    """
    member="__MACOSX/._"+source.name
    canonical=lambda name:unicodedata.normalize("NFC",name).casefold()
    with zipfile.ZipFile(archive,"a") as output:
        matches=[entry for entry in output.infolist() if canonical(entry.filename.rstrip("/"))==canonical(member)]
        if matches:
            if (len(matches)!=1 or matches[0].filename!=member
                    or not stat.S_ISREG(matches[0].external_attr>>16)):
                raise ValueError("Duplicate or ambiguous root directory metadata in archive")
            return  # A ditto version that already preserved it needs no duplicate.
        with tempfile.TemporaryDirectory(prefix="gd-root-metadata-",dir=Path(archive).parent) as temporary:
            packed=Path(temporary)/"root.appledouble"
            _pack_directory_metadata(source,packed)
            output.write(packed,member,compress_type=zipfile.ZIP_DEFLATED)

def package(source,archive):
    """Put exactly one named source at ZIP root, preserving Darwin metadata."""
    source=Path(source)
    if source.is_symlink() or not (source.is_file() or source.is_dir()):
        raise ValueError("Select an actual regular file, folder, or app")
    check_name(source.name)
    if unicodedata.normalize("NFC",source.name).casefold()=="__macosx":
        raise ValueError("The selected name conflicts with reserved archive metadata; rename the source first")
    command=["/usr/bin/ditto","-c","-k","--sequesterRsrc"]
    # For a file, --keepParent adds its containing directory to the ZIP. For
    # directories/apps it retains the selected directory itself, as required by
    # zip-root validation and restoration. Both forms preserve AppleDouble.
    if source.is_dir():command.append("--keepParent")
    run([*command,source,archive],timeout=900)
    if source.is_dir() and sys.platform=="darwin":
        _supplement_root_directory_metadata(source,archive)
def stream_metadata_reason(manifest):
    """Raw object/NFS layouts cannot represent preserved macOS xattrs."""
    unknown="The original macOS metadata was not recorded; use a verified local copy."
    if not isinstance(manifest,list) or not manifest:return unknown
    for item in manifest:
        if not isinstance(item,dict):return unknown
        attributes=item.get("xattrs")
        if attributes is None and item.get("type")=="symlink":continue
        if not isinstance(attributes,dict):return unknown
        if any(name!="com.apple.provenance" for name in attributes):
            return "This application needs a verified local copy to preserve its macOS metadata."
    return None
def validate_archive(path,name):
    """Reject traversal, escaping links and writes through archive symlink parents."""
    check_name(name)
    canonical=lambda value:unicodedata.normalize("NFC",value).casefold()
    expected_root=canonical(name)
    if expected_root=="__macosx":raise ValueError("Selected archive root conflicts with reserved metadata")
    with zipfile.ZipFile(path) as archive:
        entries=archive.infolist();names=set();links={}
        if len(entries)>500000:raise ValueError("Archive has too many entries")
        expanded=sum(x.file_size for x in entries)
        require_space(expanded+64*1024**2,Path(path).parent)
        for entry in entries:
            # ditto reads local headers. Validate that they describe the same
            # members as the central directory before trusting its paths.
            with archive.open(entry):
                pass
            normalized=canonical(entry.filename.rstrip("/"))
            parts=normalized.split("/")
            if not normalized or normalized in names or normalized.startswith("/") or "\\" in normalized or any(p in ("",".","..") for p in parts):raise ValueError("Unsafe or duplicate archive path")
            if parts[0] not in (expected_root,"__macosx"):raise ValueError("Archive contains an unexpected root")
            names.add(normalized)
            mode=entry.external_attr>>16
            if stat.S_ISLNK(mode):
                if entry.file_size>4096 or parts[0]!=expected_root:raise ValueError("Unsafe archive symlink")
                target=canonical(archive.read(entry).decode("utf8"))
                if not target or target.startswith("/") or "\\" in target:raise ValueError("Unsafe archive symlink")
                links[normalized]=target
        for path in names:
            parts=path.split("/")
            if any("/".join(parts[:i]) in links for i in range(1,len(parts))):raise ValueError("Archive writes through a symlink")
        for link,target in links.items():
            resolved=[];pending=(posixpath.dirname(link)+"/"+target).split("/");hops=0
            while pending:
                part=pending.pop(0)
                if part in ("", "."):continue
                if part=="..":
                    if len(resolved)<=1:raise ValueError("Archive symlink escapes its bundle")
                    resolved.pop();continue
                resolved.append(part);candidate="/".join(resolved)
                if candidate in links:
                    hops+=1
                    if hops>40:raise ValueError("Archive symlink loop")
                    resolved.pop();pending=links[candidate].split("/")+pending
            if not resolved or resolved[0]!=expected_root:raise ValueError("Archive symlink escapes its bundle")
def upload(source,remote,folder,offload=False,project=None,bucket=None,parent_key=None,encryption=True):
    original=Path(source).expanduser().absolute()
    resolved=original.resolve(strict=True)
    ensure_not_cloud(resolved)
    key=keyfor(remote,pathpart(folder),resolved.name,project,bucket,parent_key)
    with upload_lease(key):return _upload(original,remote,folder,offload,project,bucket,parent_key,encryption)
def _upload(source,remote,folder,offload=False,project=None,bucket=None,parent_key=None,encryption=True):
    original=Path(source).expanduser().absolute()
    src=original.resolve(strict=True)
    ensure_not_cloud(src)
    if not (src.is_file() or src.is_dir()):raise ValueError("Select a regular file, folder, or app")
    if src.is_symlink() or original.is_symlink():raise ValueError("Select an actual file or folder, not a symlink")
    typ=kindof(src)
    if typ=="app" and not (src/"Contents/Info.plist").is_file():raise ValueError("Not a valid macOS .app bundle")
    if offload and is_running(src):raise ValueError("Quit this application before offloading it")
    folder=pathpart(folder);check_remote(remote)
    if type(encryption) is not bool or (not encryption and remote!="redxai"):
        raise ValueError("Unencrypted uploads are available only for Red-XAI MachineNotes")
    context=selected_context(project,bucket,remote,folder)
    redx=redx_config() if remote=="redxai" else None
    if redx and redx["workspaceId"]!=bucket:raise ValueError("Red-XAI workspace changed; refresh the destination")
    key=keyfor(remote,folder,src.name,project,bucket,parent_key)
    if redx:
        client=redx_module().RedXReceiver(redx);client.verified_workers(write=True)
        cloud_items=client.library_snapshot()["items"];items_by_key={item["key"]:item for item in cloud_items}
        if parent_key is not None and (parent_key not in items_by_key or items_by_key[parent_key].get("virtualFolder") is not True):
            raise ValueError("Selected upload folder is unavailable in this MachineNote")
        if key in items_by_key and items_by_key[key].get("parentKey")!=parent_key:
            raise RuntimeError("This item moved to a different folder. Refresh before uploading another version.")
    previous=load().get(key)
    if previous and previous.get("source")!=str(src):raise RuntimeError("A different same-name source already owns this library item. Choose a different cloud folder or source name; existing backups were retained.")
    prepare_cache()
    progress.phase("preparing")
    baseline=snapshot(src)
    zipped=src.is_dir() or bool(baseline["manifest"][0].get("xattrs"))
    extension=".zip" if zipped else (src.suffix if src.suffix else ".bin")
    fname=key+extension
    total_bytes=sum(x.get("size",0) for x in baseline["manifest"])
    require_space(total_bytes*3+64*1024**2)
    with tempfile.TemporaryDirectory(prefix="gd-upload-",dir=CACHE) as tmp:
        archive=Path(tmp)/fname
        progress.phase("archiving",total_bytes=total_bytes)
        if zipped:
            package(src,archive)
        else:shutil.copy2(src,archive)
        unchanged(src,baseline)
        if zipped:validate_archive(archive,src.name)
        original_hash=sha(archive)
        # Each verified revision has an immutable cloud object. A failed new
        # upload cannot overwrite the only backup of an offloaded original.
        fname=key+"-"+original_hash+"-"+uuid.uuid4().hex+extension
        verified=Path(tmp)/("verified-"+fname)
        redx_result=None
        if remote=="redxai":
            origin=device_origin.current_origin(redx["receiverId"],state_dir=SUPPORT/"DeviceOrigins")
            options={"origin":origin,**({"parent_key":parent_key} if parent_key is not None else {})}
            redx_result=redx_module().upload_archive(redx,archive,key,src.name,typ,
                "zip-root" if zipped else "flat",original_hash,baseline["manifest"],encryption=encryption,**options)
            cloud_item={"key":key,"name":src.name,"kind":typ,"workspace":bucket,
                "manifestId":redx_result["manifestId"],"archiveBytes":archive.stat().st_size,
                "archiveSha256":original_hash}
            progress.phase("readback",total_bytes=archive.stat().st_size)
            restored=redx_module().download_archive(redx,cloud_item,verified)
            if restored["manifest"]!=baseline["manifest"]:
                raise RuntimeError("Encrypted cloud metadata read-back differs from the source; original retained")
        else:
            dest=cloud(remote,folder,fname)
            run([RCLONE,"--config",CONFIG,"copyto",archive,dest,"--retries","3"],timeout=2400)
            # Re-download and compare full bytes before offering an offload.
            run([RCLONE,"--config",CONFIG,"copyto",dest,verified,"--retries","3"],timeout=2400)
        if sha(verified)!=original_hash:raise RuntimeError("Cloud read-back did not match uploaded archive; original retained")
        progress.phase("restoring",total_bytes=total_bytes)
        if zipped:
            testdir=Path(tmp)/"restorecheck";testdir.mkdir()
            run(["/usr/bin/ditto","-x","-k",verified,testdir],timeout=900)
            if not (testdir/src.name).exists():raise RuntimeError("Restored archive is missing its item; original retained")
            progress.phase("verifying",total_bytes=total_bytes)
            verify_restored(testdir/src.name,baseline["manifest"])
        else:
            os.chmod(verified,0o600|baseline["manifest"][0]["executable"])
            progress.phase("verifying",total_bytes=total_bytes)
            verify_restored(verified,baseline["manifest"])
        unchanged(src,baseline)
    entry={"name":src.name,"kind":typ,"format":"redxai" if remote=="redxai" else "archive","archiveLayout":"zip-root" if zipped else "flat","remote":remote,"folder":folder,"file":(redx_result["manifestId"]+".png") if remote=="redxai" else fname,"sha256":original_hash,"source":str(src),"offloaded":False,"verified":True,"verifiedAt":time.time(),"manifest":baseline["manifest"],"sizeBytes":total_bytes,**({"redxManifestId":redx_result["manifestId"],"redxGeneration":1,"parentKey":parent_key,"virtualFolder":False,"archiveKey":key,"displayName":previous.get("displayName",src.name) if previous else src.name} if remote=="redxai" else {}),**(context or {})}
    if remote=="redxai":entry.update(origin=redx_result.get("origin"),applicationPlatform=redx_result.get("applicationPlatform"))
    # Raw copy/check validates data bytes, not Darwin resource forks or xattrs.
    # Only metadata-compatible apps receive this optional streaming layout;
    # every app retains its fully verified metadata-preserving archive.
    if typ=="app" and context and total_bytes>=STREAM_MIN_BYTES and remote!="redxai":
        reason=stream_metadata_reason(baseline["manifest"])
        if reason:entry["streamIneligibleReason"]=reason
        else:
            raw_path=folder+"/Streamable/"+key+"-"+original_hash+"/"+src.name
            target=cloud(remote,raw_path)
            run([RCLONE,"--config",CONFIG,"copy",src,target,"--links","--create-empty-src-dirs","--immutable"],timeout=7200)
            run([RCLONE,"--config",CONFIG,"check",src,target,"--links","--download"],timeout=7200)
            unchanged(src,baseline)
            entry["streamPath"]=raw_path;entry["streamVerified"]=True
    if previous:
        entry["previousVersions"]=[*previous.get("previousVersions",[]),{k:v for k,v in previous.items() if k!="previousVersions"}]
    store_revision(key,entry,previous)
    result={"key":key,"verified":True,"project":project,"bucket":bucket,"remote":remote,"folder":folder,"source":str(src),"kind":typ,"name":src.name,"parentKey":parent_key}
    if offload:
        # Full restore has passed. Re-read every source immediately before Finder
        # Trash; a mutation aborts without touching the original. Other writers
        # should remain quiescent during this user-authorized offload.
        unchanged(src,baseline)
        if is_running(src):raise RuntimeError("Application started during upload; original retained")
        try:
            progress.phase("offloading")
            trash(src)
            prior=json.loads(json.dumps(entry))
            entry["offloaded"]=True;entry["trashedAt"]=time.time();store_revision(key,entry,prior)
            reply(message=f"Verified cloud backup of {src.name}; moved original to Trash. Empty Trash to reclaim space.",offloaded=True,**result)
        except Exception as exc:
            reply(message=f"Cloud backup verified. Finder could not confirm moving the original to Trash; inspect it before retrying.",offloaded=False,**result)
    else:
        reply(message=f"Verified cloud copy of {src.name}. Original kept locally.",offloaded=False,**result)
def check_name(name):
    if not isinstance(name,str) or not name or len(name)>255 or name in (".","..") or "/" in name or "\\" in name or any(ord(c)<32 or ord(c)==127 for c in name):raise ValueError("Invalid item name")
def item_path(data):
    if data.get("format")=="raw":return cloud(data["remote"],data["cloudPath"])
    return cloud(data["remote"],data["folder"],data["file"])
def selected_entry(key,project=None,bucket=None,remote="gendragoon"):
    if not re.fullmatch(r"[a-f0-9]{16}(?:[a-f0-9]{2})?",key or ""):raise ValueError("Invalid library key")
    adopt_legacy_context(selected_context(project,bucket,remote))
    data=load().get(key)
    if not data or not in_context(data,selected_context(project,bucket,remote)):raise ValueError("Item is not in the selected cloud library")
    check_name(data.get("name"))
    if data.get("kind","app") not in ("app","folder","file"):raise ValueError("Invalid item kind")
    if project:selected_context(project,bucket,remote,data.get("folder"))
    return data
def cache_record(path,data):
    descriptor,temporary=tempfile.mkstemp(prefix=".cache-manifest-",dir=path)
    destination=safe_path(path/"cache-manifest.json")
    try:
        with os.fdopen(descriptor,"w") as output:
            json.dump(data,output);output.flush();os.fsync(output.fileno())
        safe_path(destination);os.replace(temporary,destination)
    finally:
        if os.path.exists(temporary):os.unlink(temporary)
def _cache_display_destination(key,data):
    name=data.get("displayName") or data["name"];check_name(name)
    destination=CACHE/key/name
    old_name=data.get("cacheName") or data["name"];check_name(old_name)
    old=CACHE/key/old_name
    if old!=destination and old.exists() and not destination.exists():
        if cache_in_use(old):raise RuntimeError("Application or open resources still use this cache; close them before applying the renamed item")
        record=safe_path(old.parent/"cache-manifest.json")
        if not record.is_file():raise RuntimeError("Existing cache needs review before applying the renamed library item")
        verify_restored(old,json.loads(record.read_text()))
        os.replace(old,destination)
        with library_lock():
            entries=_load()
            if key in entries:entries[key]["cacheName"]=name;_save(entries)
    return destination

def cache_in_use(path):
    # The launch helper checks actual executable paths and open resources,
    # including applications nested anywhere below a restored virtual folder.
    import gendragoon_app_launch
    return bool(gendragoon_app_launch.cache_users(path))

def stage_virtual_folder(key,data,open_after,project,bucket,remote,emit=True):
    if remote!="redxai":raise ValueError("Virtual folders require a Red-XAI MachineNote")
    context=selected_context(project,bucket,remote);config=redx_config()
    if config["workspaceId"]!=bucket:raise ValueError("MachineNote changed; refresh before restoring")
    prepare_cache();destination=_cache_display_destination(key,data);safe_path(destination.parent,directory=True)
    if destination.exists() and data.get("cacheTreeRevision")!=data.get("redxTreeRevision"):
        raise RuntimeError("This folder changed in the cloud. Clear its managed cache before restoring the current tree; local changes are retained.")
    if not destination.exists():
        entries={k:v for k,v in load().items() if in_context(v,context) and not v.get("cloudMissing")}
        children={}
        for child_key,item in entries.items():children.setdefault(item.get("parentKey"),[]).append((child_key,item))
        visited=set()
        with tempfile.TemporaryDirectory(prefix="gd-folder-restore-",dir=CACHE) as temporary:
            root=Path(temporary)/(data.get("displayName") or data["name"]);root.mkdir(mode=0o700)
            def materialize(parent_key,target,depth=0):
                if depth>100 or parent_key in visited or len(visited)>1000:raise ValueError("Invalid or overly deep library folder tree")
                visited.add(parent_key);seen_names=set()
                for child_key,item in children.get(parent_key,[]):
                    child_name=item.get("displayName") or item["name"];check_name(child_name)
                    folded=unicodedata.normalize("NFKC",child_name).casefold()
                    if folded in seen_names:raise ValueError("Library folder contains colliding item names")
                    seen_names.add(folded);out=target/child_name
                    if item.get("virtualFolder") is True:
                        out.mkdir(mode=0o700);materialize(child_key,out,depth+1)
                    else:
                        cached=Path(stage_item(child_key,False,project,bucket,remote,emit=False))
                        baseline=snapshot(cached)
                        require_space(sum(entry.get("size",0) for entry in baseline["manifest"])+64*1024**2)
                        run(["/usr/bin/ditto",cached,out],timeout=1800)
                        verify_restored(out,baseline["manifest"]);unchanged(cached,baseline)
                visited.remove(parent_key)
            materialize(key,root)
            current=redx_module().RedXReceiver(config).library_snapshot()
            if current["revision"]!=data.get("redxTreeRevision"):
                raise RuntimeError("Library changed while restoring the folder. Refresh and try again; local files were retained.")
            actual=snapshot(root)["manifest"]
            destination.parent.mkdir(parents=True,exist_ok=True,mode=0o700);safe_path(destination.parent,directory=True)
            if destination.exists():raise RuntimeError("Managed folder cache already exists; retained for review")
            os.replace(root,destination);cache_record(destination.parent,actual)
            with library_lock():
                entries=_load()
                if key in entries:
                    entries[key]["cacheTreeRevision"]=data.get("redxTreeRevision");entries[key]["cacheName"]=destination.name;_save(entries)
    record=safe_path(destination.parent/"cache-manifest.json")
    if not record.is_file():raise RuntimeError("Managed folder cache has no verification record")
    verify_restored(destination,json.loads(record.read_text()))
    if open_after:run(["/usr/bin/open",destination],timeout=35)
    if emit:reply(message="Restored library folder and its nested items into a verified local cache.",localPath=str(destination))
    return str(destination)

def assert_restore_compatible(key,data,project=None,bucket=None,remote="gendragoon"):
    device_origin.ensure_restore_compatible(data)
    if data.get("virtualFolder") is not True:return
    context=selected_context(project,bucket,remote)
    children={}
    for child_key,item in load().items():
        if in_context(item,context) and not item.get("cloudMissing"):children.setdefault(item.get("parentKey"),[]).append((child_key,item))
    pending=[key];visited=set()
    while pending:
        parent=pending.pop()
        if parent in visited or len(visited)>=1000:raise ValueError("Invalid library folder hierarchy.")
        visited.add(parent)
        for child_key,item in children.get(parent,[]):
            device_origin.ensure_restore_compatible(item)
            if item.get("virtualFolder") is True:pending.append(child_key)

def stage_item(key,open_after=False,project=None,bucket=None,remote="gendragoon",emit=True):
    idx=load()
    data=selected_entry(key,project,bucket,remote);name=data["name"]
    assert_restore_compatible(key,data,project,bucket,remote)
    if data.get("virtualFolder") is True:return stage_virtual_folder(key,data,open_after,project,bucket,remote,emit)
    kind=data.get("kind","app")
    prepare_cache();dest=_cache_display_destination(key,data);safe_path(dest.parent,directory=True)
    if dest.is_symlink():raise ValueError("Unsafe linked local cache")
    if not dest.exists():
        expected=sum(x.get("size",0) for x in data.get("manifest",[]))
        require_space(expected*2+64*1024**2)
        with tempfile.TemporaryDirectory(prefix="gd-restore-",dir=CACHE) as tmp:
            temp=Path(tmp)
            if data.get("format")=="raw":
                if kind=="file":
                    p=temp/name
                    run([RCLONE,"--config",CONFIG,"copyto",item_path(data),p],timeout=2400)
                else:
                    p=temp/name;p.mkdir()
                    run([RCLONE,"--config",CONFIG,"copy",item_path(data),p,"--links","--create-empty-src-dirs"],timeout=2400)
            else:
                check_name(data["file"])
                if data.get("format")=="redxai":
                    config=redx_config()
                    if config["workspaceId"]!=bucket:raise RuntimeError("Red-XAI workspace changed; refresh before restoring")
                    item=redx_module().find_item(config,key)
                    archive=temp/(key+".archive")
                    restored=redx_module().download_archive(config,item,archive)
                    root=restored["root"];data["archiveLayout"]=root["archiveLayout"]
                    data["manifest"]=restored["manifest"];data["sha256"]=root["archiveSha256"]
                    data["redxManifestId"]=item["manifestId"];data["redxGeneration"]=item.get("generation",1)
                else:
                    archive=temp/data["file"]
                    run([RCLONE,"--config",CONFIG,"copyto",item_path(data),archive],timeout=2400)
                if sha(archive)!=data.get("sha256"):raise RuntimeError("Downloaded cloud archive failed SHA-256 verification")
                if kind=="file" and data.get("archiveLayout")!="zip-root":
                    p=archive
                    if data.get("manifest"):os.chmod(p,0o600|data["manifest"][0]["executable"])
                else:
                    validate_archive(archive,name)
                    run(["/usr/bin/ditto","-x","-k",archive,temp],timeout=900)
                    p=temp/name
            if not p.exists():raise RuntimeError("Cloud download did not contain expected item")
            if kind=="app" and not (p/"Contents/Info.plist").exists():raise RuntimeError("App bundle missing Info.plist; cloud copy may be damaged")
            if data.get("manifest"):verify_restored(p,data["manifest"])
            actual=snapshot(p)["manifest"]
            safe_path(dest.parent,directory=True);dest.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            os.replace(p,dest)
            cache_record(dest.parent,actual)
            if data.get("format")=="redxai":
                data["verified"]=True;data["verifiedAt"]=time.time();data["cloudMissing"]=False
                with library_lock():
                    entries=_load();data["cacheName"]=dest.name;entries[key]=data;_save(entries)
    snapshot(dest)  # Refuse an escaping symlink even for a previously retained cache.
    record=dest.parent/"cache-manifest.json"
    if record.exists():
        safe_path(record);verify_restored(dest,json.loads(record.read_text()))
    if open_after:
        run(["/usr/bin/open",str(dest)],timeout=35)
        if emit:reply(message=f"Opened local cached {data.get('displayName') or name}; app uses local storage while running.",localPath=str(dest))
    elif emit:reply(message=f"Restored {data.get('displayName') or name} into local cache.",localPath=str(dest))
    return str(dest)
def _remove_verified_cache_item(path,verified):
    """Remove only verified entries, retaining late arrivals at every depth."""
    flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW
    parent=os.open(path.parent,flags)
    guards=verified["guard"]
    entries=verified["manifest"]
    def same_directory(info,relative):
        expected=guards[relative]
        # Removing our children changes directory times/size, but never identity
        # or type. Leaf guards below still compare every mutation field.
        if not stat.S_ISDIR(info.st_mode) or (info.st_dev,info.st_ino,info.st_mode)!=expected[:3]:
            raise RuntimeError("Managed cache directory changed; remaining content retained")
    @contextmanager
    def entry_parent(relative):
        parts=[path.name]+([] if relative=="." else relative.split("/"))
        descriptor=os.dup(parent)
        try:
            for index,part in enumerate(parts[:-1]):
                child=os.open(part,flags,dir_fd=descriptor)
                try:same_directory(os.fstat(child),"." if index==0 else "/".join(parts[1:index+1]))
                except BaseException:os.close(child);raise
                os.close(descriptor);descriptor=child
            yield descriptor,parts[-1]
        finally:os.close(descriptor)
    try:
        for entry in entries:
            if entry["type"]=="directory":continue
            relative=entry["path"]
            with entry_parent(relative) as (descriptor,name):
                current=os.stat(name,dir_fd=descriptor,follow_symlinks=False)
                if _fingerprint(current)!=guards[relative]:
                    raise RuntimeError("Managed cache item changed; remaining content retained")
                os.unlink(name,dir_fd=descriptor)
        directories=sorted((entry for entry in entries if entry["type"]=="directory"),
                           key=lambda entry:0 if entry["path"]=="." else len(entry["path"].split("/")),reverse=True)
        for entry in directories:
            with entry_parent(entry["path"]) as (descriptor,name):
                same_directory(os.stat(name,dir_fd=descriptor,follow_symlinks=False),entry["path"])
                try:os.rmdir(name,dir_fd=descriptor)
                except OSError as error:
                    if error.errno!=errno.ENOTEMPTY:raise
                    raise RuntimeError("Managed cache contains new files; unverified content retained for review") from None
    finally:os.close(parent)
def clear_cache(key,project=None,bucket=None,remote="gendragoon"):
    data=selected_entry(key,project,bucket,remote)
    prepare_cache()
    loc=CACHE/key
    safe_path(loc,directory=True)
    if not loc.exists():return reply(message="No local cached copy to remove")
    cache_name=data.get("cacheName") or data.get("displayName") or data["name"];check_name(cache_name)
    child=loc/cache_name
    if child.is_symlink():raise ValueError("Unsafe linked local cache")
    if cache_in_use(child):raise RuntimeError("Application or open resources still use this cache; managed files were retained")
    if data.get("kind","app")=="app" and is_running(child):raise RuntimeError("Quit the app before removing its local cache")
    # Only delete a dedicated, generated cache folder, never an original user folder.
    if loc.parent.resolve()!=CACHE.resolve():raise RuntimeError("Unsafe cache path")
    record=safe_path(loc/"cache-manifest.json")
    if not record.is_file():raise RuntimeError("Legacy cache has no ownership/integrity record; retained for manual review")
    # The manifest covers the selected item, not new siblings beside it. Never
    # recursively remove user-created files, folders or links with the cache.
    if any(sibling.name not in {cache_name,"cache-manifest.json"} for sibling in loc.iterdir()):
        raise RuntimeError("Managed cache contains unexpected files; retained for review")
    verified=verify_restored(child,json.loads(record.read_text()))
    # Unexpected nested arrivals must survive too; never recursively delete
    # the item after a point-in-time verification of its manifest.
    _remove_verified_cache_item(child,verified)
    record.unlink()
    try:loc.rmdir()
    except OSError as error:
        if error.errno!=errno.ENOTEMPTY:raise
        raise RuntimeError("Application cache removed; unexpected files were retained for review") from None
    reply(message=f"Deleted local cached copy of {data['name']}; cloud copy remains.")
def main():
    p=argparse.ArgumentParser()
    p.add_argument("action",choices=["remotes","list","scan","upload","launch","restore","evict","organize"])
    p.add_argument("--source",default="")
    p.add_argument("--app",default="")
    p.add_argument("--remote",default="gendragoon")
    p.add_argument("--folder")
    p.add_argument("--root")
    p.add_argument("--project")
    p.add_argument("--bucket")
    p.add_argument("--offload",action="store_true")
    p.add_argument("--no-encryption",action="store_true")
    p.add_argument("--key",default="")
    p.add_argument("--operation",choices=["create-folder","rename","move","copy","delete"])
    p.add_argument("--keys-json",default="[]")
    p.add_argument("--name")
    p.add_argument("--parent-key")
    p.add_argument("--expected-revision",type=int)
    p.add_argument("--maintenance-fd",type=int)
    p.add_argument("--performance-stdin",action="store_true")
    a=p.parse_args()
    if a.performance_stdin:performance.configure_from_stdin()
    context=selected_context(a.project,a.bucket,a.remote)
    if context and a.action=="upload" and not a.folder:raise ValueError("A selected bucket upload folder is required")
    if context and a.action=="scan" and not a.root:raise ValueError("A selected bucket scan root is required")
    if a.action=="remotes":return remotes()
    if a.action=="list":return listing(a.project,a.bucket,a.remote)
    with maintenance_lock(a.maintenance_fd):
        if a.action=="scan":scan(a.remote,a.root or DEFAULT_ROOT,a.project,a.bucket)
        elif a.action=="upload":upload(a.source or a.app,a.remote,a.folder or DEFAULT_ROOT+"/"+ARCHIVE_DIR,a.offload,a.project,a.bucket,a.parent_key,encryption=not a.no_encryption)
        elif a.action=="launch":stage_item(a.key,True,a.project,a.bucket,a.remote)
        elif a.action=="restore":stage_item(a.key,False,a.project,a.bucket,a.remote)
        elif a.action=="evict":clear_cache(a.key,a.project,a.bucket,a.remote)
        elif a.action=="organize":organize(a.operation,json.loads(a.keys_json),a.name,a.parent_key,a.expected_revision,a.project,a.bucket,a.remote)
if __name__=="__main__":
    try:main()
    except Exception as e:fail(e)
