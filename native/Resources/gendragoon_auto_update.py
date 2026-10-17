#!/usr/bin/env python3
"""GenDragoonSSD safe customer updater. Unauthenticated release source; trusted Developer ID required.
JSON-lines progress, bounded release extraction, strong signer/bundle/version validation,
atomic rollback and background apply only after the parent application exits.
"""
import argparse
import ctypes
import fcntl
from contextlib import contextmanager
import platform
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import stat
import ssl
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.request
import urllib.error
import urllib.parse
import zipfile
import uuid

REPO="grimvirusoffical-source/gendragoon-cloud-ssd"
APP_NAME="GenDragoon Cloud SSD.app"
APP=Path.home()/"Applications"/APP_NAME
ROOT=Path.home()/"Library/Application Support/GenDragoon Cloud SSD/AutoUpdates"
STAGED=ROOT/"pending"
STATUS=ROOT/"status.json"
LOG=ROOT/"updater.log"
TEAM_ID="NZPU8H843J"
BUNDLE_ID="app.gendragoon.cloudssd"
MAX_ARCHIVE=2*1024**3
MAX_UNPACKED=5*1024**3
MAX_ENTRIES=40000
AGENT="GenDragoonSSD-Updater/0.16"
MIN_FREE=10*1024**3
CTX=ssl.create_default_context(cafile="/etc/ssl/cert.pem") if Path("/etc/ssl/cert.pem").exists() else ssl.create_default_context()
ZIP_PREFIX="GenDragoon-Cloud-SSD-Mac-"
TAG=re.compile(r"^v([0-9]+)\.([0-9]+)\.([0-9]+)$")

def emit(phase,progress=None,eta=None,message="",downloaded=None,total=None,quiet=False):
    record={"event":phase,"message":message,"timestamp":datetime.datetime.now(datetime.timezone.utc).isoformat()}
    if progress is not None:record["progress"]=max(0,min(100,round(float(progress),2)))
    if eta is not None:record["etaSeconds"]=max(0,int(eta))
    if downloaded is not None:record["downloadedBytes"]=downloaded
    if total is not None:record["totalBytes"]=total
    if not quiet:print(json.dumps(record,separators=(",",":")),flush=True)
    return record

def safe_path(path,directory=None,regular=False):
    """Reject symlinks before touching managed paths, including their parents."""
    path=Path(path).absolute()
    for item in reversed([path,*path.parents]):
        try:metadata=item.lstat()
        except FileNotFoundError:continue
        if stat.S_ISLNK(metadata.st_mode):raise RuntimeError("Unsafe symlinked update path: "+str(item))
        if item!=path and not stat.S_ISDIR(metadata.st_mode):
            raise RuntimeError("Update path parent is not a directory: "+str(item))
        if item==path:
            if directory is True and not stat.S_ISDIR(metadata.st_mode):
                raise RuntimeError("Expected update directory: "+str(path))
            if regular and (not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1
                            or metadata.st_uid!=os.getuid()):
                raise RuntimeError("Unsafe managed update file: "+str(path))
    return path

def safe_root():
    # These checks must precede mkdir/chmod/open, not follow them.
    safe_path(ROOT,directory=True)
    safe_path(APP,directory=True)
    safe_path(STAGED,directory=True)
    for path in (STATUS,LOG,ROOT/"update.lock"):
        safe_path(path,regular=True)
    ROOT.mkdir(parents=True,exist_ok=True,mode=0o700)
    if ROOT.stat().st_uid!=os.getuid():raise RuntimeError("Update directory belongs to another user")
    ROOT.chmod(0o700)

@contextmanager
def update_lock(timeout=180):
    safe_root()
    path=ROOT/"update.lock"
    descriptor=os.open(path,os.O_CREAT|os.O_RDWR|getattr(os,"O_NOFOLLOW",0),0o600)
    started=time.monotonic()
    try:
        metadata=os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_uid!=os.getuid():
            raise RuntimeError("Unsafe update lock file")
        while True:
            try:fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB);break
            except BlockingIOError:
                if time.monotonic()-started>timeout:raise RuntimeError("Another update operation is still working; retrying on the next check.")
                time.sleep(0.25)
        yield
    finally:
        fcntl.flock(descriptor,fcntl.LOCK_UN);os.close(descriptor)

def sufficient_space(extra,location=None):
    if shutil.disk_usage(ROOT if location is None else location).free<MIN_FREE+extra:
        raise RuntimeError("Update postponed to preserve 10 GiB of free local storage.")

def write_status(status,**kwargs):
    safe_root()
    record={"state":status,"updatedAt":time.time(),**kwargs}
    descriptor,name=tempfile.mkstemp(prefix="status-",suffix=".tmp",dir=ROOT)
    tmp=Path(name)
    try:
        with os.fdopen(descriptor,"w",encoding="utf8") as fp:
            fp.write(json.dumps(record)+"\n")
            fp.flush();os.fsync(fp.fileno())
        safe_path(STATUS,regular=True)
        os.replace(tmp,STATUS)
    finally:
        if tmp.exists():tmp.unlink()

def version_of(app):
    p=app/"Contents/Info.plist"
    safe_path(p)
    with p.open("rb") as f:info=plistlib.load(f)
    if not isinstance(info,dict) or info.get("CFBundleIdentifier")!=BUNDLE_ID:
        raise RuntimeError("Installed application identity mismatch")
    return str(info.get("CFBundleShortVersionString",""))
def installed_version():
    return version_of(APP)
def parse_tag(t):
    m=TAG.fullmatch(t)
    if not m:raise RuntimeError("Unrecognized release version")
    return tuple(map(int,m.groups()))

def require_https(url):
    try:
        parsed=urllib.parse.urlsplit(url)
        if (parsed.scheme!="https" or not parsed.hostname or parsed.username is not None
            or parsed.password is not None or "\\" in url
            or any(ord(char)<=32 or ord(char)==127 for char in url)):
            raise ValueError("HTTPS URL required")
        parsed.port  # Reject malformed/out-of-range ports before opening a connection.
    except (TypeError,ValueError) as exc:
        raise RuntimeError("Update transport requires HTTPS URLs without user information") from exc
    return url

class HTTPSOnlyRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        require_https(newurl)
        return super().redirect_request(req,fp,code,msg,headers,newurl)

def open_https(request,timeout):
    require_https(request.full_url)
    opener=urllib.request.build_opener(urllib.request.HTTPSHandler(context=CTX),HTTPSOnlyRedirect())
    return opener.open(request,timeout=timeout)

def request_json(url):
    req=urllib.request.Request(url,headers={"User-Agent":AGENT,"Accept":"application/vnd.github+json"})
    with open_https(req,timeout=25) as r:
        return json.load(r)
def latest():
    releases=request_json("https://api.github.com/repos/"+REPO+"/releases?per_page=30")
    entries=sorted((x for x in releases if not x.get("draft") and not x.get("prerelease")
             and TAG.fullmatch(str(x.get("tag_name","")))),
             key=lambda x:parse_tag(x["tag_name"]),reverse=True)
    for r in entries:
        tag=r["tag_name"]
        if parse_tag(tag)<=parse_tag("v"+installed_version()):return None
        filename=ZIP_PREFIX+tag+".zip"
        assets={a.get("name"):a.get("browser_download_url") for a in r.get("assets",[])}
        # A release for a different platform must not break Mac update checks.
        if filename not in assets or "sha256.txt" not in assets:continue
        for name in (filename,"sha256.txt"):
            if not str(assets[name]).startswith("https://github.com/"+REPO+"/releases/download/"+tag+"/"):
                raise RuntimeError("Unexpected update asset host")
        return {"version":tag,"filename":filename,"assets":assets}
    return None

def check():
    release=latest()
    if not release:
        emit("up_to_date",progress=100,message="No newer eligible stable release is published.")
    else:
        emit("available",progress=0,message=release["version"]+" available.")
    return release

def download(url,path,max_bytes,stage_start,stage_span,quiet):
    req=urllib.request.Request(url,headers={"User-Agent":AGENT})
    with open_https(req,timeout=100) as resp, path.open("wb") as fp:
        length=resp.headers.get("Content-Length")
        total=int(length) if length and length.isdecimal() else None
        if total is not None and total>max_bytes:raise RuntimeError("Update exceeds the maximum download size")
        sufficient_space((total or 128*1024**2)+128*1024**2)
        start=time.monotonic()
        transferred=0
        samples=[]
        while True:
            buf=resp.read(512*1024)
            if not buf:break
            transferred+=len(buf)
            if transferred>max_bytes:raise RuntimeError("Update exceeds allowed size")
            sufficient_space(len(buf)+64*1024**2)
            fp.write(buf)
            elapsed=max(time.monotonic()-start,0.01)
            samples.append((time.monotonic(),transferred))
            samples=samples[-16:]
            window=max(samples[-1][0]-samples[0][0],0.01)
            speed=(samples[-1][1]-samples[0][1])/window if len(samples)>1 else transferred/elapsed
            eta=int((total-transferred)/speed) if total and speed>1 and transferred<=total else None
            percent=stage_start+(stage_span*transferred/total) if total else stage_start
            emit("downloading",percent,eta,
                 "Downloading signed update: "+str(round(transferred/(1024**2),1))+" MiB",
                 transferred,total,quiet=quiet)
    if total is not None and transferred!=total:raise RuntimeError("Download size mismatch")

def validate_zip(path):
    with zipfile.ZipFile(path,"r") as z:
        infos=z.infolist()
        if not infos or len(infos)>MAX_ENTRIES:raise RuntimeError("Release archive has too many files")
        unpacked=sum(x.file_size for x in infos)
        if unpacked>MAX_UNPACKED:raise RuntimeError("Release expands beyond the safety limit")
        sufficient_space(unpacked+128*1024**2)
        names={}
        for entry in infos:
            name=entry.filename
            trimmed=name[:-1] if entry.is_dir() else name
            normalized=unicodedata.normalize("NFC",trimmed).casefold()
            pieces=trimmed.split("/")
            if normalized in names:raise RuntimeError("Release contains duplicate archive paths")
            names[normalized]=entry.is_dir()
            if (name.startswith(("/","~")) or "\\" in name or ":" in name
                or any(piece in ("",".","..") for piece in pieces)
                or any(ord(char)<32 or ord(char)==127 for char in name)):
                raise RuntimeError("Release contains an unsafe archive path")
            # Reject embedded symlinks rather than trust a malicious ZIP layout.
            perms=(entry.external_attr>>16)
            if stat.S_IFMT(perms)==stat.S_IFLNK:raise RuntimeError("Release contains unexpected symlinks")
            if stat.S_IFMT(perms) not in (0,stat.S_IFREG,stat.S_IFDIR):
                raise RuntimeError("Release contains unexpected special files")
            if entry.flag_bits&1:raise RuntimeError("Encrypted release entries are unsupported")
        for name in names:
            pieces=name.split("/")
            if any("/".join(pieces[:i]) in names and not names["/".join(pieces[:i])]
                   for i in range(1,len(pieces))):
                raise RuntimeError("Release contains conflicting archive paths")

def subprocess_ok(cmd,timeout=80):
    r=subprocess.run(cmd,capture_output=True,text=True,timeout=timeout)
    if r.returncode:raise RuntimeError("Trusted update validation failed: "+str((r.stderr or r.stdout).strip()[:280]))
    return (r.stdout+"\n"+r.stderr).strip()

def validate_app(app,version):
    safe_path(app,directory=True)
    if app.is_symlink() or not app.is_dir():raise RuntimeError("Release app missing")
    for parent,folders,files in os.walk(app,followlinks=False):
        if any((Path(parent)/name).is_symlink() for name in folders+files):
            raise RuntimeError("Release contains unexpected symlinks")
    with (app/"Contents/Info.plist").open("rb") as f:
        info=plistlib.load(f)
    if info.get("CFBundleIdentifier")!=BUNDLE_ID:raise RuntimeError("Release bundle identity mismatch")
    if info.get("CFBundleShortVersionString")!=version.lstrip("v"):raise RuntimeError("Release version mismatch")
    name=info.get("CFBundleExecutable","")
    if not isinstance(name,str) or not name or name in (".","..") or "/" in name or "\\" in name:
        raise RuntimeError("Release executable name is invalid")
    requirement='anchor apple generic and identifier "'+BUNDLE_ID+'" and certificate leaf[subject.OU] = "'+TEAM_ID+'" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists'
    subprocess_ok(["/usr/bin/codesign","--verify","--deep","--strict","--verbose=2","-R","="+requirement,str(app)],timeout=100)
    minimum=info.get("LSMinimumSystemVersion")
    if minimum:
        required=tuple(int(x) for x in str(minimum).split("."))
        actual=tuple(int(x) for x in platform.mac_ver()[0].split("."))
        if actual<required:raise RuntimeError("This update requires a newer macOS version.")
    executable=app/"Contents/MacOS"/name
    if not executable.is_file() or not os.access(executable,os.X_OK):
        raise RuntimeError("Release executable missing or not executable")
    architectures=subprocess_ok(["/usr/bin/lipo","-archs",str(executable)]).split()
    if platform.machine() not in architectures:raise RuntimeError("This update does not support this Mac architecture.")
    signature=subprocess_ok(["/usr/bin/codesign","-dv","--verbose=4",str(app)])
    if (not re.search(r"(?m)^TeamIdentifier="+re.escape(TEAM_ID)+r"$",signature)
        or not re.search(r"(?m)^Identifier="+re.escape(BUNDLE_ID)+r"$",signature)
        or not re.search(r"(?m)^Authority=Developer ID Application:",signature)
        or "Signature=adhoc" in signature):
        raise RuntimeError("Release lacks the required Apple Developer ID team signature")
    # Gatekeeper assessment blocks unnotarized or untrusted app builds.
    subprocess_ok(["/usr/sbin/spctl","--assess","--type","execute","--verbose",str(app)],timeout=70)
    return True

def staged_valid(strict=False):
    try:
        safe_root()
        if not STAGED.exists():return None
        pending=STAGED/"pending.json"
        safe_path(pending,regular=True)
        if pending.stat().st_size>131072:raise RuntimeError("Staged update metadata is too large")
        meta=json.loads((STAGED/"pending.json").read_text())
        if not isinstance(meta,dict) or not TAG.fullmatch(str(meta.get("version",""))):
            raise RuntimeError("Staged update version is invalid")
        if not re.fullmatch(r"[a-fA-F0-9]{64}",str(meta.get("sha256",""))):
            raise RuntimeError("Staged update checksum metadata is invalid")
        if parse_tag(meta["version"])<=parse_tag("v"+installed_version()):return None
        validate_app(STAGED/APP_NAME,meta["version"])
        return meta
    except Exception:
        if strict:raise
        return None

def prepare(quiet=False):
    safe_root()
    old=staged_valid()
    if old:
        emit("ready",progress=99,message="Verified update staged. Installs when the app closes.",quiet=quiet)
        return old
    rel=latest()
    if not rel:
        emit("up_to_date",progress=100,message="No newer trusted release is published.",quiet=quiet)
        return None
    emit("checking",progress=0,message="Found "+rel["version"]+".",quiet=quiet)
    with tempfile.TemporaryDirectory(prefix="gd-fetch-",dir=ROOT) as temp:
        td=Path(temp)
        checksums=td/"sha256.txt";archive=td/rel["filename"]
        download(rel["assets"]["sha256.txt"],checksums,131072,0,2,quiet)
        expected=None
        for line in checksums.read_text(encoding="utf8").splitlines():
            m=re.fullmatch(r"([A-Fa-f0-9]{64})\s+\*?(.+)",line.strip())
            if m and m.group(2)==rel["filename"]:expected=m.group(1).lower()
        if not expected:raise RuntimeError("Checksum entry missing for this release")
        download(rel["assets"][rel["filename"]],archive,MAX_ARCHIVE,2,78,quiet)
        emit("verifying",80,None,"Verifying SHA-256 checksum.",quiet=quiet)
        hasher=hashlib.sha256()
        with archive.open("rb") as fp:
            for chunk in iter(lambda:fp.read(1024**2),b""):hasher.update(chunk)
        if hasher.hexdigest()!=expected:raise RuntimeError("Downloaded update checksum failed")
        validate_zip(archive)
        emit("extracting",86,None,"Safely unpacking the Mac application.",quiet=quiet)
        unpack=td/"extracted";unpack.mkdir()
        subprocess_ok(["/usr/bin/ditto","-x","-k",str(archive),str(unpack)],timeout=170)
        candidate=unpack/APP_NAME
        emit("signature",94,None,"Verifying Developer ID signature and Apple trust.",quiet=quiet)
        validate_app(candidate,rel["version"])
        ready=Path(tempfile.mkdtemp(prefix="gd-ready-",dir=ROOT))
        retained=None
        try:
            os.replace(candidate,ready/APP_NAME)
            (ready/"pending.json").write_text(json.dumps({"version":rel["version"],"sha256":expected})+"\n")
            os.chmod(ready/"pending.json",0o600)
            safe_path(STAGED,directory=True)
            if STAGED.exists():
                # Retain an older/invalid managed stage instead of deleting an
                # unknown directory tree or overwriting a user's recovery files.
                retained=ROOT/("pending-retained-"+uuid.uuid4().hex)
                os.replace(STAGED,retained)
            try:os.replace(ready,STAGED)
            except Exception:
                if retained is not None:os.replace(retained,STAGED)
                raise
        finally:
            if ready.exists():shutil.rmtree(ready)
    write_status("ready",version=rel["version"])
    emit("ready",99,None,"Verified update ready. Installation begins safely when app closes.",quiet=quiet)
    return {"version":rel["version"]}

def active_mount():
    # Do not interrupt an active mount/transfer or replace a running rclone binary.
    try:
        import gendragoon_app_launch
        if gendragoon_app_launch.sessions().get("active"):return True
        out=subprocess.check_output(["/sbin/mount"],text=True,timeout=8)
        mount=Path.home()/"GenDragoon Cloud SSD"
        if os.path.ismount(mount):return True
        for line in out.splitlines():
            match=re.match(r"^(.*?) on (.*?) \(.*\)$",line)
            if not match:continue
            source,target=(re.sub(r"\\([0-7]{3})",lambda m:chr(int(m.group(1),8)),value)
                           for value in match.groups())
            if target==str(mount) or "gendragoon" in source.casefold() or "gendragoon" in target.casefold():return True
        return False
    except Exception:return True

def wait_for_exit(pid):
    if pid<0:raise RuntimeError("Parent process ID cannot be negative")
    if not pid:return
    for i in range(110):
        try:os.kill(pid,0)
        except ProcessLookupError:return
        time.sleep(1)
    raise RuntimeError("App did not exit in time; update postponed")

def app_executable(app=None):
    app=APP if app is None else Path(app)
    safe_path(app,directory=True)
    info_path=app/"Contents/Info.plist"
    safe_path(info_path)
    with info_path.open("rb") as fp:info=plistlib.load(fp)
    name=info.get("CFBundleExecutable","")
    if (info.get("CFBundleIdentifier")!=BUNDLE_ID or not isinstance(name,str)
        or not name or name in (".","..") or "/" in name or "\\" in name):
        raise RuntimeError("Cannot identify the installed app executable")
    executable=app/"Contents/MacOS"/name
    safe_path(executable)
    if not executable.is_file():raise RuntimeError("Installed app executable missing")
    return executable

def app_pids(app=None):
    """Match kernel-reported executable paths; names/arguments are insufficient."""
    wanted=str(app_executable(app).resolve())
    if platform.system()!="Darwin":raise RuntimeError("Native process inspection requires macOS")
    output=subprocess_ok(["/bin/ps","-axo","pid="],timeout=10)
    library=ctypes.CDLL("/usr/lib/libproc.dylib",use_errno=True)
    process_path=library.proc_pidpath
    process_path.argtypes=[ctypes.c_int,ctypes.c_void_p,ctypes.c_uint32]
    process_path.restype=ctypes.c_int
    matches=[]
    for line in output.splitlines():
        if not line.strip().isdecimal():continue
        pid=int(line.strip())
        buffer=ctypes.create_string_buffer(4096)
        if process_path(pid,buffer,len(buffer))>0 and os.path.realpath(os.fsdecode(buffer.value))==wanted:
            matches.append(pid)
    return matches

def launch_app(app=None,timeout=20):
    app=APP if app is None else Path(app)
    subprocess_ok(["/usr/bin/open","-n",str(app)],timeout=15)
    deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        found=app_pids(app)
        if found:
            time.sleep(1)
            stable=sorted(set(found).intersection(app_pids(app)))
            if stable:return stable
        time.sleep(0.25)
    raise RuntimeError("Updated app launch was not observed at its exact executable path")

def stop_failed_launch(app):
    """Rollback never kills a process or interrupts an active cloud mount."""
    if active_mount():raise RuntimeError("Cloud mount active; rollback postponed with backup retained")
    if not app_pids(app):return
    quoted='"'+str(app).replace("\\","\\\\").replace('"','\\"')+'"'
    subprocess_ok(["/usr/bin/osascript","-e","tell application "+quoted+" to quit"],timeout=15)
    deadline=time.monotonic()+30
    while app_pids(app):
        if time.monotonic()>=deadline:raise RuntimeError("Updated app would not quit; backup retained")
        time.sleep(0.25)
    if active_mount():raise RuntimeError("Cloud mount active after quit; backup retained")

def install_worker(pid=0,quiet=True,relaunch=False):
    safe_root()
    meta=staged_valid(strict=True)
    if not meta:return emit("up_to_date",100,None,"No verified newer update staged.",quiet=quiet)
    if active_mount():
        write_status("postponed",version=meta["version"],reason="active_mount")
        return emit("postponed",99,None,"Active cloud mount detected. Update postponed until safely unmounted.",quiet=quiet)
    wait_for_exit(pid)
    # --pid=0 is not permission to replace an app which is actually running.
    if app_pids():
        write_status("postponed",version=meta["version"],reason="app_running")
        return emit("postponed",99,None,"App still running. Update postponed until it exits.",quiet=quiet)
    if active_mount():
        write_status("postponed",version=meta["version"],reason="active_mount")
        return emit("postponed",99,None,"Cloud mount became active. Update postponed.",quiet=quiet)
    if not APP.exists():raise RuntimeError("Installed application missing")
    safe_path(APP.parent,directory=True)
    candidate_bytes=sum((Path(parent)/name).stat().st_size
                        for parent,folders,files in os.walk(STAGED/APP_NAME) for name in files)
    sufficient_space(candidate_bytes+128*1024**2,APP.parent)
    # A private same-volume candidate and backup avoid cross-filesystem renames.
    # ditto preserves the signed bundle; no signed resource is rewritten.
    with tempfile.TemporaryDirectory(prefix=".gendragoon-update-",dir=APP.parent) as work:
        work=Path(work)
        candidate=work/APP_NAME
        subprocess_ok(["/usr/bin/ditto",str(STAGED/APP_NAME),str(candidate)],timeout=170)
        validate_app(candidate,meta["version"])
        safe_root()
        if staged_valid(strict=True)!=meta:raise RuntimeError("Staged update changed during installation")
        if active_mount() or app_pids():
            write_status("postponed",version=meta["version"],reason="app_or_mount_became_active")
            return emit("postponed",99,None,"App or cloud mount became active. Update postponed.",quiet=quiet)
        backup=APP.parent/("GenDragoon Cloud SSD.previous-"+uuid.uuid4().hex+".app")
        safe_path(backup,directory=True)
        installed=False
        launched=[]
        try:
            os.replace(APP,backup)
            os.replace(candidate,APP)
            installed=True
            validate_app(APP,meta["version"])
            write_status("installed",version=meta["version"],backupPath=str(backup),
                         launchStatus="pending" if relaunch else "not_requested")
            if relaunch:launched=launch_app(APP)
            write_status("installed",version=meta["version"],backupPath=str(backup),
                         launchStatus="exact_executable_observed" if launched else "not_requested",
                         functionalReadiness="not_tested")
        except Exception as failure:
            try:
                if installed:
                    stop_failed_launch(APP)
                    os.replace(APP,work/"failed-update.app")
                if backup.exists():os.replace(backup,APP)
            except Exception as rollback_failure:
                raise RuntimeError("Update failed; rollback needs attention. Keep backup "+str(backup)
                                   +". "+str(rollback_failure)) from failure
            # A restored app may remain stopped; never claim a successful restart.
            raise RuntimeError("Update failed; previous application restored. "+str(failure)) from failure
    message="Updated to "+meta["version"]+"."
    if launched:message+=" Relaunch observed at the app's exact executable path."
    return emit("installed",100,None,message,quiet=quiet)

def log_quiet(function):
    safe_root()
    try:return function()
    except Exception as e:
        try:
            write_status("error",error=str(e)[:220])
            safe_path(LOG,regular=True)
            descriptor=os.open(LOG,os.O_CREAT|os.O_APPEND|os.O_WRONLY|getattr(os,"O_NOFOLLOW",0),0o600)
            with os.fdopen(descriptor,"a",encoding="utf8") as fp:
                metadata=os.fstat(fp.fileno())
                if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink!=1 or metadata.st_uid!=os.getuid():
                    raise RuntimeError("Unsafe updater log file")
                fp.write(datetime.datetime.now(datetime.timezone.utc).isoformat()+" "+str(e)[:240]+"\n")
        except Exception:
            # Failure to log must not mask the original update failure.
            pass
        raise

def main(argv=None):
    ap=argparse.ArgumentParser()
    ap.add_argument("action",choices=["check","prepare","auto-on-exit","install-worker","status"])
    ap.add_argument("--pid",type=int,default=0)
    relaunch=ap.add_mutually_exclusive_group()
    relaunch.add_argument("--relaunch",dest="relaunch",action="store_true")
    relaunch.add_argument("--no-relaunch",dest="relaunch",action="store_false")
    ap.set_defaults(relaunch=None)
    args=ap.parse_args(argv)
    if args.pid<0:ap.error("--pid must be zero or a positive process ID")
    try:
        if args.action=="status":
            safe_root()
            print(STATUS.read_text() if STATUS.exists() else '{"state":"idle"}')
        elif args.action=="check":check()
        elif args.action=="prepare":
            with update_lock():prepare()
        elif args.action=="install-worker":
            with update_lock():log_quiet(lambda:install_worker(args.pid,quiet=True,relaunch=bool(args.relaunch)))
        else:
            wait_for_exit(args.pid)
            with update_lock():log_quiet(lambda:(prepare(quiet=True),install_worker(quiet=True,relaunch=args.relaunch is not False)))
        return 0
    except Exception as exc:
        emit("error",None,None,str(exc)[:250])
        return 1
if __name__=="__main__":sys.exit(main())
