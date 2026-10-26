#!/usr/bin/env python3
"""GenDragoonSSD safe customer updater. Unauthenticated release source; trusted Developer ID required.
JSON-lines progress, bounded release extraction, strong signer/bundle/version validation,
atomic rollback and background apply only after the parent application exits.
"""

# Bundled helpers are signed resources: imports must never create or update caches.
import os, sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
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
if Path(__file__).absolute().parents[2].name == APP_NAME:
    APP=Path(__file__).absolute().parents[2]
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
MIN_FREE=64*1024**2
CTX=ssl.create_default_context(cafile="/etc/ssl/cert.pem") if Path("/etc/ssl/cert.pem").exists() else ssl.create_default_context()
ZIP_PREFIX="GenDragoon-Cloud-SSD-Mac-"
TAG=re.compile(r"^v([0-9]+)\.([0-9]+)\.([0-9]+)$")
RELEASE_TAG=re.compile(r"^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-(rc|beta)\.([1-9][0-9]*))?$")
CHANNEL="stable"

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
        raise RuntimeError("Update postponed: insufficient local space for the measured update staging and filesystem work.")

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
def build_of(app):
    with (Path(app)/"Contents/Info.plist").open("rb") as stream:info=plistlib.load(stream)
    build=str(info.get("CFBundleVersion","0"))
    if not build.isdecimal():raise RuntimeError("Application build number is invalid")
    return int(build)

def bundle_digest(app):
    """Bind the entire signed stage to the pre-quit handoff, with bounded reads."""
    safe_path(app,directory=True)
    digest=hashlib.sha256();entries=0;total=0
    def fail(error):raise error
    for directory,folders,files in os.walk(app,followlinks=False,onerror=fail):
        folders.sort();files.sort()
        for name in folders+files:
            path=Path(directory)/name;metadata=path.lstat();entries+=1
            if entries>MAX_ENTRIES or not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
                raise RuntimeError("Application contains an unsafe or excessive entry")
            relative=path.relative_to(app).as_posix()
            digest.update(json.dumps([relative,stat.S_IMODE(metadata.st_mode),stat.S_ISDIR(metadata.st_mode)],separators=(",",":")).encode()+b"\0")
            if stat.S_ISREG(metadata.st_mode):
                total+=metadata.st_size
                if total>MAX_UNPACKED:raise RuntimeError("Application exceeds the update size limit")
                fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
                with os.fdopen(fd,"rb") as stream:
                    before=os.fstat(stream.fileno())
                    if (before.st_dev,before.st_ino,before.st_size)!=(metadata.st_dev,metadata.st_ino,metadata.st_size):
                        raise RuntimeError("Application changed during verification")
                    digest.update(str(metadata.st_size).encode()+b"\0")
                    for chunk in iter(lambda:stream.read(1024**2),b""):digest.update(chunk)
                    after=os.fstat(stream.fileno())
                    if (before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_size,after.st_mtime_ns,after.st_ctime_ns):
                        raise RuntimeError("Application changed during verification")
    return digest.hexdigest()

DISTRIBUTION_FILE=Path(__file__).absolute().with_name("gendragoon_distribution.json")
DISTRIBUTIONS=("direct","rotten-apple","mas")

class UpdatesDisabled(RuntimeError):
    """This build is updated by its store, never by itself."""

def distribution():
    """How this copy was distributed: direct (GitHub, self-updating), rotten-apple (the launcher updates it) or mas (Mac App Store, no self-update).
    A Mac App Store receipt always wins. Then the build-time resource file, then the Rotten Apple launcher marker. Unknown values fail safe to no self-update."""
    if (APP/"Contents/_MASReceipt/receipt").exists():return "mas"
    value="direct"
    try:
        loaded=json.loads(DISTRIBUTION_FILE.read_text("utf8")).get("distribution","direct")
        value=loaded if isinstance(loaded,str) else "invalid"
    except FileNotFoundError:pass
    except (OSError,ValueError,AttributeError):value="invalid"
    if value=="direct" and os.environ.get("ROTTEN_APPLE_LAUNCHER")=="1":value="rotten-apple"
    if value not in DISTRIBUTIONS:return "mas"
    return value

def self_update_allowed():return distribution()=="direct"

def require_self_update():
    if not self_update_allowed():raise UpdatesDisabled("Updates are handled by the "+distribution()+" distribution. This build never updates itself.")

def configure(app=None,channel="stable"):
    global APP,CHANNEL
    if channel not in ("stable","preview"):raise RuntimeError("Unknown update channel")
    if app is not None:
        app=Path(app)
        if not app.is_absolute() or app.name!=APP_NAME:raise RuntimeError("An absolute installed application path is required")
        APP=safe_path(app,directory=True)
    CHANNEL=channel

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
        data=r.read(2*1024**2+1)
        if len(data)>2*1024**2:raise RuntimeError("Release metadata exceeds its size limit")
        return json.loads(data)
def latest():
    releases=request_json("https://api.github.com/repos/"+REPO+"/releases?per_page=30")
    if not isinstance(releases,list):raise RuntimeError("Invalid release listing")
    entries=sorted((x for x in releases if isinstance(x,dict) and not x.get("draft")
             and (CHANNEL=="preview" or not x.get("prerelease"))
             and RELEASE_TAG.fullmatch(str(x.get("tag_name","")))
             and (CHANNEL=="preview" or TAG.fullmatch(str(x.get("tag_name",""))))),
             key=lambda x:tuple(map(int,RELEASE_TAG.fullmatch(x["tag_name"]).groups()[:3]))+
                 ((0 if x.get("prerelease") else 1),int(RELEASE_TAG.fullmatch(x["tag_name"]).group(5) or 0)),reverse=True)
    for r in entries:
        tag=r["tag_name"]
        version="v"+".".join(RELEASE_TAG.fullmatch(tag).groups()[:3])
        installed=parse_tag("v"+installed_version())
        if parse_tag(version)<installed:continue
        filename=ZIP_PREFIX+version+".zip"
        assets={a.get("name"):a.get("browser_download_url") for a in r.get("assets",[])}
        # A release for a different platform must not break Mac update checks.
        if filename not in assets or "sha256.txt" not in assets:continue
        for name in (filename,"sha256.txt",*( ("package-status.json",) if "package-status.json" in assets else () )):
            if not str(assets[name]).startswith("https://github.com/"+REPO+"/releases/download/"+tag+"/"):
                raise RuntimeError("Unexpected update asset host")
        build=None
        if "package-status.json" in assets:
            package=request_json(assets["package-status.json"])
            if (not isinstance(package,dict) or package.get("version")!=version[1:]
                or not str(package.get("build","")).isdecimal()
                or package.get("gatekeeperAccepted") is not True or package.get("stapledTicketValidated") is not True):
                raise RuntimeError("Release package metadata is incomplete")
            if CHANNEL=="stable" and package.get("automaticUpdateEligible") is not True:continue
            build=int(package["build"])
        elif r.get("prerelease"):
            continue  # Explicit previews still need complete Apple-trusted package metadata.
        if parse_tag(version)==installed and (build is None or build<=build_of(APP)):continue
        return {"version":version,"releaseTag":tag,"build":build,"channel":CHANNEL,"filename":filename,"assets":assets}
    return None

def check():
    require_self_update()
    release=latest()
    if not release:
        emit("up_to_date",progress=100,message="No newer eligible "+CHANNEL+" release is published.")
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
    # Do not auto-replace an installed app using only an online notarization
    # lookup; the release app must carry its own valid stapled ticket.
    subprocess_ok(["/usr/bin/xcrun","stapler","validate",str(app)],timeout=70)
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
        if meta.get("channel","stable")!=CHANNEL:return None
        current=parse_tag("v"+installed_version());target=parse_tag(meta["version"])
        if target<current or (target==current and int(meta.get("build",0))<=build_of(APP)):return None
        validate_app(STAGED/APP_NAME,meta["version"])
        if meta.get("build") is not None and build_of(STAGED/APP_NAME)!=int(meta["build"]):
            raise RuntimeError("Staged application build mismatch")
        if meta.get("bundleDigest") and bundle_digest(STAGED/APP_NAME)!=meta["bundleDigest"]:
            raise RuntimeError("Staged application changed after download verification")
        return meta
    except Exception:
        if strict:raise
        return None

def prepare(quiet=False):
    require_self_update()
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
        if rel.get("build") is not None and build_of(candidate)!=int(rel["build"]):
            raise RuntimeError("Release build does not match its package metadata")
        metadata={"version":rel["version"],"releaseTag":rel.get("releaseTag",rel["version"]),
                  "build":build_of(candidate),"channel":CHANNEL,"sha256":expected,"bundleDigest":bundle_digest(candidate)}
        ready=Path(tempfile.mkdtemp(prefix="gd-ready-",dir=ROOT))
        retained=None
        try:
            os.replace(candidate,ready/APP_NAME)
            (ready/"pending.json").write_text(json.dumps(metadata)+"\n")
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
    write_status("ready",version=rel["version"],build=metadata["build"],channel=CHANNEL)
    emit("ready",99,None,"Verified update ready. Installation begins safely when app closes.",quiet=quiet)
    return metadata

def active_mount():
    # Do not interrupt an active mount/transfer or replace a running rclone binary.
    try:
        import gendragoon_app_launch
        if gendragoon_app_launch.sessions().get("active"):return True
        # Reuse the adjacent signed helper's owned, read-only Darwin snapshot.
        # Import failure or an unreadable table retains the existing fail-closed gate.
        from gendragoon_app_control import mounted_volumes
        mount=Path.home()/"GenDragoon Cloud SSD"
        expected=unicodedata.normalize("NFC",os.path.normpath(str(mount))).casefold()
        for source,target,_ in mounted_volumes():
            actual=unicodedata.normalize("NFC",os.path.normpath(target)).casefold()
            if actual==expected or "gendragoon" in source.casefold() or "gendragoon" in target.casefold():return True
        return False
    except Exception:return True

def wait_for_exit(pid):
    if pid<0:raise RuntimeError("Parent process ID cannot be negative")
    if not pid:return
    from gendragoon_app_control import identify,wait_for_exit as verified_exit
    verified_exit(identify(pid,app_executable()))

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
    """Narrow kernel names, then require exact path, UID and process identity."""
    if platform.system()!="Darwin":raise RuntimeError("Native process inspection requires macOS")
    import gendragoon_app_control as control
    return control.app_pids(app_executable(app).resolve())

def launch_app(app=None,timeout=20):
    app=APP if app is None else Path(app)
    if app_pids(app):raise RuntimeError("Application is already running; duplicate launch refused")
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

def process_records(app,pids):
    from gendragoon_app_control import identify
    records=[]
    for pid in pids:
        identity=identify(pid,app_executable(app))
        records.append({"pid":identity.pid,"uid":os.getuid(),"executable":identity.executable,"started":identity.started})
    return records

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

def install_worker(pid=0,quiet=True,relaunch=False,expected_stage=None,safety_check=None,original_digest=None,request_id=None):
    require_self_update()
    safe_root()
    meta=staged_valid(strict=True)
    if not meta:return emit("up_to_date",100,None,"No verified newer update staged.",quiet=quiet)
    if expected_stage is not None and meta!=expected_stage:raise RuntimeError("Staged update differs from the acknowledged restart request")
    if safety_check is not None:safety_check()
    if original_digest is not None and bundle_digest(APP)!=original_digest:
        raise RuntimeError("Installed application changed after the restart was acknowledged")
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
    previous_version=version_of(APP);previous_build=build_of(APP)
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
        if expected_stage is not None and bundle_digest(candidate)!=expected_stage["bundleDigest"]:
            raise RuntimeError("Copied update differs from the verified stage")
        if safety_check is not None:safety_check()
        if original_digest is not None and bundle_digest(APP)!=original_digest:
            raise RuntimeError("Installed application changed during update copying")
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
                         build=meta.get("build"),request_id=request_id,channel=CHANNEL,
                         launchStatus="pending" if relaunch else "not_requested")
            if relaunch:launched=launch_app(APP)
            records=process_records(APP,launched) if launched else []
            write_status("installed",version=meta["version"],backupPath=str(backup),
                         build=build_of(APP),request_id=request_id,channel=CHANNEL,launchedProcesses=records,
                         launchStatus="exact_executable_observed" if launched else "not_requested",
                         functionalReadiness="not_tested")
        except Exception as failure:
            failed_copy=None
            try:
                if installed:
                    stop_failed_launch(APP)
                    if safety_check is not None:safety_check()
                    failed_copy=APP.parent/("GenDragoon Cloud SSD.failed-"+uuid.uuid4().hex+".app")
                    safe_path(failed_copy,directory=True)
                    os.replace(APP,failed_copy)
                if backup.exists():os.replace(backup,APP)
                validate_app(APP,"v"+previous_version)
                if original_digest is not None and bundle_digest(APP)!=original_digest:
                    raise RuntimeError("Restored application differs from the original verified bundle")
                restored=[]
                if relaunch:
                    if safety_check is not None:safety_check()
                    restored=process_records(APP,launch_app(APP))
                write_status("rolled_back",version="v"+previous_version,build=previous_build,
                             request_id=request_id,failedVersion=meta["version"],failedCopyPath=str(failed_copy) if failed_copy else None,
                             launchStatus="exact_executable_observed" if restored else "not_requested",launchedProcesses=restored,
                             functionalReadiness="not_tested",error=str(failure)[:220])
            except Exception as rollback_failure:
                write_status("attention",version=meta["version"],request_id=request_id,backupPath=str(backup),
                             failedCopyPath=str(failed_copy) if failed_copy else None,launchStatus="unconfirmed",
                             error="The update did not complete and automatic recovery needs attention.")
                raise RuntimeError("Update failed; rollback needs attention. Keep backup "+str(backup)
                                   +". "+str(rollback_failure)) from failure
            return emit("rolled_back",100,None,"Update failed. The previous verified app was restored"+
                        (" and its relaunched process was observed." if restored else "."),quiet=quiet)
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
    ap.add_argument("action",choices=["check","prepare","auto-on-exit","install-worker","schedule-restart","cancel-restart","status"])
    ap.add_argument("--pid",type=int,default=0)
    ap.add_argument("--app",type=Path)
    ap.add_argument("--channel",choices=["stable","preview"],default="stable")
    ap.add_argument("--ui-busy",choices=["true","false"],default="true")
    ap.add_argument("--request-id")
    relaunch=ap.add_mutually_exclusive_group()
    relaunch.add_argument("--relaunch",dest="relaunch",action="store_true")
    relaunch.add_argument("--no-relaunch",dest="relaunch",action="store_false")
    ap.set_defaults(relaunch=None)
    args=ap.parse_args(argv)
    if args.pid<0:ap.error("--pid must be zero or a positive process ID")
    try:
        configure(args.app,args.channel)
        if args.action!="status" and not self_update_allowed():
            # Store builds: succeed quietly so the host shows a managed/hidden update UI, never an error.
            emit("disabled",message="Updates are handled by the "+distribution()+" distribution.")
            return 0
        if args.action=="status":
            safe_root()
            print(STATUS.read_text() if STATUS.exists() else '{"state":"idle"}')
        elif args.action=="check":check()
        elif args.action=="prepare":
            with update_lock():prepare()
        elif args.action in ("schedule-restart","cancel-restart"):
            import gendragoon_update_restart as restart
            result=(restart.schedule(args.pid,APP,args.ui_busy=="true",CHANNEL)
                    if args.action=="schedule-restart" else restart.cancel(args.request_id,args.pid,APP))
            print(json.dumps(result,separators=(",",":")),flush=True)
        else:
            # These old entry points started work after the caller had already
            # quit. They cannot safely acknowledge a living, verified parent.
            raise RuntimeError("This updater requires schedule-restart while the app is still running; no update was installed.")
        return 0
    except Exception as exc:
        emit("error",None,None,str(exc)[:250])
        return 1
if __name__=="__main__":sys.exit(main())
