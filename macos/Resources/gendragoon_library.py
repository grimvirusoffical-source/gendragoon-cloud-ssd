#!/usr/bin/env python3
"""GenDragoon cloud library: verified app/file/folder archives, remote discovery and local staging."""
import argparse, hashlib, json, os, plistlib, re, shutil, subprocess, sys, tempfile
from contextlib import contextmanager
import fcntl, posixpath, stat, time, unicodedata, uuid, zipfile
from pathlib import Path
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
def reply(**v): print(json.dumps(dict(ok=True,**v)),flush=True)
def fail(e): print(json.dumps(dict(ok=False,message=str(e)[-650:])),flush=True);sys.exit(1)
def run(cmd,timeout=1800):
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
    if any(not re.fullmatch(r"[a-f0-9]{18}",k) or not isinstance(v,dict) for k,v in data.items()):raise ValueError("Invalid library entry")
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
def keyfor(remote,folder,name,project=None,bucket=None):
    context=selected_context(project,bucket,remote,folder)
    parts=([project,bucket] if context else [])+[remote,folder,name]
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
    return [dict(key=k,kind=v.get("kind","app"),format=v.get("format","archive"),previousVersionCount=len(v.get("previousVersions",[])),**{a:b for a,b in v.items() if a not in ("kind","format","manifest","previousVersions","previousVersionCount")}) for k,v in sorted(entries.items()) if in_context(v,context)]
def listing(project=None,bucket=None,remote="gendragoon"):
    reply(items=present(load(),selected_context(project,bucket,remote)))
def remotes():remote_list()
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
    if snapshot(path)["manifest"]!=manifest:raise RuntimeError("Restored content or metadata differs from the source; original retained")
def validate_archive(path,name):
    """Reject traversal, escaping links and writes through archive symlink parents."""
    check_name(name)
    canonical=lambda value:unicodedata.normalize("NFC",value).casefold()
    expected_root=canonical(name)
    with zipfile.ZipFile(path) as archive:
        entries=archive.infolist();names=set();links={}
        if len(entries)>500000:raise ValueError("Archive has too many entries")
        for entry in entries:
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
def upload(source,remote,folder,offload=False,project=None,bucket=None):
    original=Path(source).expanduser().absolute()
    resolved=original.resolve(strict=True)
    ensure_not_cloud(resolved)
    key=keyfor(remote,pathpart(folder),resolved.name,project,bucket)
    with upload_lease(key):return _upload(original,remote,folder,offload,project,bucket)
def _upload(source,remote,folder,offload=False,project=None,bucket=None):
    original=Path(source).expanduser().absolute()
    src=original.resolve(strict=True)
    ensure_not_cloud(src)
    if not (src.is_file() or src.is_dir()):raise ValueError("Select a regular file, folder, or app")
    if src.is_symlink() or original.is_symlink():raise ValueError("Select an actual file or folder, not a symlink")
    typ=kindof(src)
    if typ=="app" and not (src/"Contents/Info.plist").is_file():raise ValueError("Not a valid macOS .app bundle")
    if offload and is_running(src):raise ValueError("Quit this application before offloading it")
    folder=pathpart(folder);check_remote(remote)
    context=selected_context(project,bucket,remote,folder)
    key=keyfor(remote,folder,src.name,project,bucket)
    previous=load().get(key)
    if previous and previous.get("source")!=str(src):raise RuntimeError("A different same-name source already owns this library item. Choose a different cloud folder or source name; existing backups were retained.")
    extension=".zip" if src.is_dir() else (src.suffix if src.suffix else ".bin")
    fname=key+extension
    prepare_cache()
    baseline=snapshot(src)
    with tempfile.TemporaryDirectory(prefix="gd-upload-",dir=CACHE) as tmp:
        archive=Path(tmp)/fname
        if src.is_dir():
            run(["/usr/bin/ditto","-c","-k","--sequesterRsrc","--keepParent",src,archive],timeout=900)
        else:shutil.copy2(src,archive)
        unchanged(src,baseline)
        if src.is_dir():validate_archive(archive,src.name)
        original_hash=sha(archive)
        # Each verified revision has an immutable cloud object. A failed new
        # upload cannot overwrite the only backup of an offloaded original.
        fname=key+"-"+original_hash+"-"+uuid.uuid4().hex+extension
        dest=cloud(remote,folder,fname)
        run([RCLONE,"--config",CONFIG,"copyto",archive,dest,"--retries","3"],timeout=2400)
        # Re-download and compare full bytes before offering an offload.
        verified=Path(tmp)/("verified-"+fname)
        run([RCLONE,"--config",CONFIG,"copyto",dest,verified,"--retries","3"],timeout=2400)
        if sha(verified)!=original_hash:raise RuntimeError("Cloud read-back did not match uploaded archive; original retained")
        if src.is_dir():
            testdir=Path(tmp)/"restorecheck";testdir.mkdir()
            run(["/usr/bin/ditto","-x","-k",verified,testdir],timeout=900)
            if not (testdir/src.name).is_dir():raise RuntimeError("Restored archive is missing its folder; original retained")
            verify_restored(testdir/src.name,baseline["manifest"])
        else:
            os.chmod(verified,0o600|baseline["manifest"][0]["executable"])
            verify_restored(verified,baseline["manifest"])
        unchanged(src,baseline)
    entry={"name":src.name,"kind":typ,"format":"archive","remote":remote,"folder":folder,"file":fname,"sha256":original_hash,"source":str(src),"offloaded":False,"verified":True,"verifiedAt":time.time(),"manifest":baseline["manifest"],**(context or {})}
    if previous:
        entry["previousVersions"]=[*previous.get("previousVersions",[]),{k:v for k,v in previous.items() if k!="previousVersions"}]
    store_revision(key,entry,previous)
    result={"key":key,"verified":True,"project":project,"bucket":bucket,"remote":remote,"folder":folder,"source":str(src),"kind":typ,"name":src.name}
    if offload:
        # Full restore has passed. Re-read every source immediately before Finder
        # Trash; a mutation aborts without touching the original. Other writers
        # should remain quiescent during this user-authorized offload.
        unchanged(src,baseline)
        if is_running(src):raise RuntimeError("Application started during upload; original retained")
        try:
            trash(src)
            prior=json.loads(json.dumps(entry))
            entry["offloaded"]=True;entry["trashedAt"]=time.time();store_revision(key,entry,prior)
            reply(message=f"Verified cloud backup of {src.name}; moved original to Trash. Empty Trash to reclaim space.",offloaded=True,**result)
        except Exception as exc:
            reply(message=f"Cloud backup verified. Finder could not confirm moving the original to Trash; inspect it before retrying.",offloaded=False,**result)
    else:
        reply(message=f"Verified cloud copy of {src.name}. Original kept locally.",offloaded=False,**result)
def check_name(name):
    if not name or name in (".","..") or "/" in name or "\\" in name:raise ValueError("Invalid item name")
def item_path(data):
    if data.get("format")=="raw":return cloud(data["remote"],data["cloudPath"])
    return cloud(data["remote"],data["folder"],data["file"])
def selected_entry(key,project=None,bucket=None,remote="gendragoon"):
    if not re.fullmatch(r"[a-f0-9]{18}",key or ""):raise ValueError("Invalid library key")
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
def stage_item(key,open_after=False,project=None,bucket=None,remote="gendragoon"):
    idx=load()
    data=selected_entry(key,project,bucket,remote);name=data["name"]
    kind=data.get("kind","app")
    dest=CACHE/key/name
    prepare_cache();safe_path(dest.parent,directory=True)
    if dest.is_symlink():raise ValueError("Unsafe linked local cache")
    if not dest.exists():
        with tempfile.TemporaryDirectory(prefix="gd-restore-",dir=CACHE) as tmp:
            temp=Path(tmp)
            if data.get("format")=="raw":
                if kind=="file":
                    p=temp/name
                    run([RCLONE,"--config",CONFIG,"copyto",item_path(data),p],timeout=2400)
                else:
                    p=temp/name;p.mkdir()
                    run([RCLONE,"--config",CONFIG,"copy",item_path(data),p,"--create-empty-src-dirs"],timeout=2400)
            else:
                check_name(data["file"])
                archive=temp/data["file"]
                run([RCLONE,"--config",CONFIG,"copyto",item_path(data),archive],timeout=2400)
                if sha(archive)!=data.get("sha256"):raise RuntimeError("Downloaded cloud archive failed SHA-256 verification")
                if kind=="file":
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
    snapshot(dest)  # Refuse an escaping symlink even for a previously retained cache.
    if open_after:
        run(["/usr/bin/open",str(dest)],timeout=35)
        reply(message=f"Opened local cached {name}; app uses local storage while running.",localPath=str(dest))
    else:reply(message=f"Restored {name} into local cache.",localPath=str(dest))
def clear_cache(key,project=None,bucket=None,remote="gendragoon"):
    data=selected_entry(key,project,bucket,remote)
    prepare_cache()
    loc=CACHE/key
    safe_path(loc,directory=True)
    if not loc.exists():return reply(message="No local cached copy to remove")
    child=loc/data["name"]
    if child.is_symlink():raise ValueError("Unsafe linked local cache")
    if data.get("kind","app")=="app" and is_running(child):raise RuntimeError("Quit the app before removing its local cache")
    # Only delete a dedicated, generated cache folder, never an original user folder.
    if loc.parent.resolve()!=CACHE.resolve():raise RuntimeError("Unsafe cache path")
    record=safe_path(loc/"cache-manifest.json")
    if not record.is_file():raise RuntimeError("Legacy cache has no ownership/integrity record; retained for manual review")
    verify_restored(child,json.loads(record.read_text()))
    shutil.rmtree(loc)
    reply(message=f"Deleted local cached copy of {data['name']}; cloud copy remains.")
def main():
    p=argparse.ArgumentParser()
    p.add_argument("action",choices=["remotes","list","scan","upload","launch","restore","evict"])
    p.add_argument("--source",default="")
    p.add_argument("--app",default="")
    p.add_argument("--remote",default="gendragoon")
    p.add_argument("--folder")
    p.add_argument("--root")
    p.add_argument("--project")
    p.add_argument("--bucket")
    p.add_argument("--offload",action="store_true")
    p.add_argument("--key",default="")
    p.add_argument("--maintenance-fd",type=int)
    a=p.parse_args()
    context=selected_context(a.project,a.bucket,a.remote)
    if context and a.action=="upload" and not a.folder:raise ValueError("A selected bucket upload folder is required")
    if context and a.action=="scan" and not a.root:raise ValueError("A selected bucket scan root is required")
    if a.action=="remotes":return remotes()
    if a.action=="list":return listing(a.project,a.bucket,a.remote)
    with maintenance_lock(a.maintenance_fd):
        if a.action=="scan":scan(a.remote,a.root or DEFAULT_ROOT,a.project,a.bucket)
        elif a.action=="upload":upload(a.source or a.app,a.remote,a.folder or DEFAULT_ROOT+"/"+ARCHIVE_DIR,a.offload,a.project,a.bucket)
        elif a.action=="launch":stage_item(a.key,True,a.project,a.bucket,a.remote)
        elif a.action=="restore":stage_item(a.key,False,a.project,a.bucket,a.remote)
        elif a.action=="evict":clear_cache(a.key,a.project,a.bucket,a.remote)
if __name__=="__main__":
    try:main()
    except Exception as e:fail(e)
