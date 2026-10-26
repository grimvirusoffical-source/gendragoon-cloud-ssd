"""Current MachineNotes desktop model and encrypted archive transport.

The GUI and companion IPC both call this model. No credential is written to a
token file, command argument, browser page, log, or plaintext export.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import stat
import sys
import tempfile
import time
import threading
import functools
import unicodedata
import uuid
import zipfile
import private_fs as private
from codec_loader import install_sourceless_runtime

from redx_session import RedXSession, IntegrationSession, SessionError, API
import portable_vault as vault
from gendragoon_desktop import safe_path

RESOURCE=Path(__file__).resolve().parent/"runtime"
if not RESOURCE.is_dir():RESOURCE=Path(__file__).resolve().parent.parent/"Resources"
sys.path.insert(0,str(RESOURCE))
install_sourceless_runtime(RESOURCE)
import gendragoon_redx_storage as storage
import gendragoon_auth_broker as broker

MAX_ENTRIES=1_000_000
MARGIN=64*1024*1024
TRANSFER_LOCK=threading.RLock()

class TransferProgress:
    """Real phase/archive counters and streamed carrier bytes; memory only."""
    def __init__(self):
        self.lock=threading.RLock();self.state=dict(phase="preparing",completed_bytes=0,total_bytes=0,uploaded_bytes=0,downloaded_bytes=0)
    def enabled(self):return True
    def snapshot(self):
        with self.lock:return dict(self.state)
    def phase(self,name,total_bytes=0,completed_bytes=0,workers=None,**fields):
        with self.lock:
            self.state.update(phase=name,total_bytes=total_bytes,completed_bytes=completed_bytes)
            if workers is not None:self.state["workers"]=workers
            self.update(**fields)
    def update(self,**fields):
        with self.lock:
            for key,value in fields.items():
                if key=="phase" and value in ("preparing","archiving","encoding","uploading","publishing","readback","decoding","restoring","verifying","complete"):
                    self.state[key]=value
                elif key in ("completed_bytes","total_bytes","workers","objects_done","objects_total") and type(value) in (int,float) and 0<=value<=2**53-1:self.state[key]=value
    def advance(self,count,**increments):
        with self.lock:
            self.state["completed_bytes"]+=count
            for key,value in increments.items():
                if key in ("objects_done",) and type(value) is int and value>=0:self.state[key]=self.state.get(key,0)+value
    def activity(self,name,during):
        with self.lock:
            if self.state["phase"] in during:self.state["phase"]=name
    def network_begin(self):return object()
    def network_end(self,token):pass
    def network_bytes(self,direction,count):
        if direction in ("upload","download") and type(count) is int and count>=0:
            with self.lock:self.state["uploaded_bytes" if direction=="upload" else "downloaded_bytes"]+=count

def transfer_progress(function):
    @functools.wraps(function)
    def wrapped(self,*args,**kwargs):
        with TRANSFER_LOCK:
            previous=storage.progress;self.progress=TransferProgress();storage.progress=self.progress
            try:
                value=function(self,*args,**kwargs);self.progress.phase("complete");return value
            finally:storage.progress=previous
    return wrapped

def state_root():
    if os.name=="nt":return Path(os.environ.get("LOCALAPPDATA",Path.home()/"AppData/Local"))/"GenDragoon/MachineNotes"
    return Path(os.environ.get("XDG_DATA_HOME",Path.home()/".local/share"))/"gendragoon/machinenotes"

class DesktopInstance:
    """One writer coordinator per user, including while the companion is disabled."""
    def __init__(self,root=None):
        directory=private.private_directory(Path(root or state_root()).absolute())
        if directory.resolve()!=directory or directory.is_symlink():raise ValueError("The desktop profile directory is linked.")
        path=directory/"desktop.lock"
        try:fd=private.create_file(path)
        except FileExistsError:
            private.verify(path);fd=os.open(path,os.O_RDWR|getattr(os,"O_NOFOLLOW",0))
        try:
            info=os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or os.name!="nt" and (info.st_uid!=os.getuid() or info.st_mode&0o077):
                raise ValueError("The desktop profile lock is unsafe.")
            if os.name=="nt":
                import msvcrt
                if info.st_size<1:os.write(fd,b"0")
                os.lseek(fd,0,0);msvcrt.locking(fd,msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except Exception:
            os.close(fd);raise ValueError("GenDragoon is already open, or its private profile needs review.") from None
        self.fd=fd
    def close(self):
        if self.fd is not None:os.close(self.fd);self.fd=None

def crypto_runtime():
    if sys.platform=="win32" and ctypes.windll.kernel32.GetACP()!=65001:
        raise vault.VaultError("Open GenDragoon using its verified UTF-8 desktop launcher. This Python process cannot safely open Unicode encryption paths.")
    vendor=Path(__file__).resolve().parent.parent/"vendor/Red-SecretsXAI"
    if vendor.is_dir():sys.path.insert(0,str(vendor))
    try:
        from redxai import _librsx as rsx
        if not rsx.available():raise RuntimeError()
        return rsx
    except Exception:raise vault.VaultError("The pinned encryption runtime is missing. Run the GenDragoon desktop runtime installer.") from None

class SessionAuth:
    def __init__(self,session):self.session=session
    def token(self):return self.session.token()
    def renew(self,failed):
        try:return self.session.renew(failed)
        except SessionError:raise broker.BrokerError("Desktop session renewal failed") from None

class DesktopReceiver(storage.RedXReceiver):
    def __init__(self,config):
        # This explicit adapter also accepts revocable scoped integration keys;
        # the native stdin credential validator remains restricted to app sessions.
        session=config.get("_session")
        if not isinstance(session,(RedXSession,IntegrationSession)):
            raise SessionError("Connect an authenticated desktop session.")
        token=session.token()
        if (config.get("cloudApi")!=API or config.get("provider")!="redxai"
                or not storage.ID.fullmatch(config.get("workspaceId", ""))
                or not storage.RECEIVER.fullmatch(config.get("receiverId", ""))
                or config["receiverId"]!=session.receiver
                or not storage.SECRET.fullmatch(config.get("storageSecret", ""))
                or not Path(config.get("keymapPath", "")).is_absolute()):
            raise SessionError("The encrypted storage context failed validation.")
        self.config=config;self.workspace=config["workspaceId"];self.receiver=config["receiverId"]
        self.secret=config["storageSecret"];self.keymap=Path(config["keymapPath"])
        self.token=token;self.auth=None if session.integration_mode else SessionAuth(session)
        self.opener=storage.urllib.request.build_opener(storage.NoRedirect(),storage.urllib.request.HTTPSHandler(context=storage.tls_context()))
    def temporary_directory(self,prefix="scratch-"):
        return private.temporary_directory(self.keymap.parent.parent/"scratch",prefix)
    def protect_download(self,path):
        private.protect_generated_tree(Path(path).parent)

def manifest(source):
    source=Path(source).absolute()
    if any(p.is_symlink() for p in (source,*source.parents)) or not source.exists():
        raise ValueError("Choose an existing real file or folder, without linked parent folders.")
    records=[];folded=set();guards={}
    pending=[(source,".")]
    while pending:
        path,relative=pending.pop();info=path.lstat()
        if getattr(info,"st_file_attributes",0)&0x400 or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise ValueError("Linked, special, and platform application files must be archived on their original platform.")
        logical=source.name if relative=="." else source.name+"/"+relative
        safe_path(logical)
        folded_name=unicodedata.normalize("NFC",logical).casefold()
        if folded_name in folded or len(records)>=MAX_ENTRIES:raise ValueError("Duplicate portable names or too many files.")
        folded.add(folded_name)
        fingerprint=(info.st_dev,info.st_ino,info.st_size,info.st_mtime_ns,info.st_ctime_ns,info.st_mode)
        guards[relative]=fingerprint
        entry={"path":relative,"type":"directory" if path.is_dir() else "file","executable":info.st_mode&0o111}
        if path.is_dir():pending.extend((p,p.name if relative=="." else relative+"/"+p.name) for p in sorted(path.iterdir(),reverse=True))
        else:
            entry.update(size=info.st_size,sha256=storage.sha256_file(path))
        after=path.lstat()
        if (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns,after.st_mode)!=fingerprint:
            raise ValueError("The source changed while reading. The original was retained.")
        records.append(entry)
    return {"manifest":sorted(records,key=lambda x:x["path"]),"guard":guards}

def require_space(path,amount):
    if shutil.disk_usage(path).free<amount+MARGIN:raise ValueError("There is not enough local space for this verified transfer and its working margin.")

def package(source,archive,baseline):
    with zipfile.ZipFile(archive,"x",compression=zipfile.ZIP_STORED,allowZip64=True) as output:
        for record in baseline["manifest"]:
            relative=record["path"];path=source if relative=="." else source/relative
            name=source.name if relative=="." else source.name+"/"+relative
            output.write(path,name+("/" if record["type"]=="directory" else ""))
    if manifest(source)!=baseline:raise ValueError("The source changed while archiving. The original was retained.")

def checked_manifest(records):
    if not isinstance(records,list) or not 1<=len(records)<=MAX_ENTRIES:raise ValueError("The encrypted file manifest is invalid.")
    result={};folded=set()
    for record in records:
        if not isinstance(record,dict) or not isinstance(record.get("path"),str):raise ValueError("The encrypted file manifest is invalid.")
        path=record["path"]
        if path!=".":safe_path(path)
        if record.get("type") not in ("file","directory") or record.get("xattrs"):
            raise ValueError("Restore this backup on its original platform to preserve links or macOS metadata.")
        if type(record.get("executable")) is not int or record["executable"]&~0o111:
            raise ValueError("The encrypted file mode is invalid.")
        if record["type"]=="file" and (type(record.get("size")) is not int or record["size"]<0 or not storage.SHA.fullmatch(record.get("sha256", ""))):
            raise ValueError("The encrypted file integrity metadata is invalid.")
        fold=unicodedata.normalize("NFC",path).casefold()
        if path in result or fold in folded:raise ValueError("The encrypted file manifest contains duplicate portable paths.")
        result[path]=record;folded.add(fold)
    if "." not in result:raise ValueError("The encrypted file manifest has no root.")
    for path in result:
        if path==".":continue
        parent=path.rpartition("/")[0] or "."
        if result.get(parent,{}).get("type")!="directory":raise ValueError("The encrypted file manifest has an invalid parent.")
    return result

def extract_checked(archive,root,records,name,layout):
    expected=checked_manifest(records);safe_path(name)
    if "/" in name:raise ValueError("The archive root name is unsafe.")
    total=sum(r.get("size",0) for r in expected.values());require_space(root,total)
    destination=root/name
    if layout=="flat":
        if set(expected)!={"."} or expected["."]["type"]!="file":raise ValueError("The flat archive metadata is invalid.")
        shutil.copyfile(archive,destination)
    elif layout=="zip-root":
        with zipfile.ZipFile(archive) as source:
            seen=set();members=[]
            for info in source.infolist():
                path=info.filename.rstrip("/");safe_path(path)
                if path!=name and not path.startswith(name+"/"):raise ValueError("The archive contains an unexpected root.")
                relative="." if path==name else path[len(name)+1:]
                record=expected.get(relative);mode=info.external_attr>>16
                if (relative in seen or record is None or stat.S_IFMT(mode) not in (0,stat.S_IFREG,stat.S_IFDIR)
                        or info.flag_bits&1 or info.is_dir()!=(record["type"]=="directory")
                        or info.file_size!=record.get("size",0)):
                    raise ValueError("The archive entries do not match the encrypted manifest.")
                seen.add(relative);members.append((info,relative,record))
            if seen!=set(expected):raise ValueError("The archive is missing encrypted manifest entries.")
            for info,relative,record in sorted(members,key=lambda x:(x[1].count("/"),x[1])):
                target=destination if relative=="." else destination/relative
                if record["type"]=="directory":target.mkdir(mode=0o700,parents=True,exist_ok=True)
                else:
                    target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
                    digest=hashlib.sha256();written=0
                    with source.open(info) as inp,target.open("xb") as out:
                        while part:=inp.read(1024*1024):
                            written+=len(part)
                            if written>record["size"]:raise ValueError("The archive expanded beyond its verified size.")
                            digest.update(part);out.write(part)
                    if written!=record["size"] or digest.hexdigest()!=record["sha256"]:raise ValueError("The restored file failed SHA-256 verification.")
    else:raise ValueError("The encrypted archive layout is unsupported.")
    for relative,record in expected.items():
        target=destination if relative=="." else destination/relative
        if record["type"]=="file":
            if target.stat().st_size!=record["size"] or storage.sha256_file(target)!=record["sha256"]:
                raise ValueError("The restored file failed SHA-256 verification.")
            if os.name!="nt":target.chmod(0o600|(record["executable"]&0o100))
        elif os.name!="nt":target.chmod(0o700)
    return destination

def publish_exclusive(source,target):
    """Atomic no-replace on each supported desktop filesystem API."""
    source,target=Path(source),Path(target)
    if os.name=="nt":os.rename(source,target);return
    libc=ctypes.CDLL(None,use_errno=True)
    if sys.platform.startswith("linux") and hasattr(libc,"renameat2"):
        fn=libc.renameat2;fn.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];fn.restype=ctypes.c_int
        code=fn(-100,os.fsencode(source),-100,os.fsencode(target),1)
    elif sys.platform=="darwin":
        fn=libc.renamex_np;fn.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_uint];fn.restype=ctypes.c_int
        code=fn(os.fsencode(source),os.fsencode(target),4)
    else:raise ValueError("This system lacks the required no-replace restore API.")
    if code:raise ValueError("The restore destination exists or could not be created safely.")

class MachineNotesClient:
    def __init__(self,session=None,root=None):
        self.session=session or RedXSession();self.root=Path(root or state_root()).absolute()
        self.notes=[];self.selected_note=None;self.selected_parent=None;self.items=[];self.revision=None
        self.keys=None;self.keymap=None;self.vault_exported=False
        self.progress=None
    def refresh_notes(self):
        value=self.session.request("/v1/receivers/me")
        notes=value.get("machineNotes",value.get("workspaces"))
        if (not storage.RECEIVER.fullmatch(value.get("id", "")) or value.get("state")!="ready" or not isinstance(notes,list)
                or any(not isinstance(n,dict) or not storage.ID.fullmatch(n.get("id", "")) for n in notes)
                or len({n["id"] for n in notes})!=len(notes)):
            raise SessionError("The authenticated MachineNotes inventory failed validation.")
        if self.session.receiver is not None and self.session.receiver!=value["id"]:raise SessionError("The account identity changed.")
        self.session.receiver=value["id"];self.notes=notes
        if self.session.integration_mode and len(notes)!=1:raise SessionError("The integration key did not return exactly its bound MachineNote.")
        if self.selected_note not in {n["id"] for n in notes}:self.selected_note=notes[0]["id"] if notes else None;self.selected_parent=None
        return notes
    def select_note(self,note):
        if note not in {n["id"] for n in self.notes}:raise SessionError("Choose a MachineNote owned by this session.")
        self.selected_note=note;self.selected_parent=None;return self.refresh_tree()
    def refresh_tree(self):
        if not self.selected_note:raise SessionError("Choose a MachineNote first.")
        value=self.session.request("/v1/receivers/me/workspaces/"+self.selected_note+"/library")
        if type(value.get("revision")) is not int or value["revision"]<0 or not isinstance(value.get("items"),list):
            raise SessionError("The library snapshot failed validation.")
        storage._validate_library_items(value["items"])
        if any(i.get("workspace")!=self.selected_note for i in value["items"]):raise SessionError("The library belongs to another MachineNote.")
        lookup={i["key"]:i for i in value["items"]}
        for item in lookup.values():
            seen={item["key"]};parent=item.get("parentKey")
            while parent is not None:
                if parent in seen or lookup.get(parent,{}).get("virtualFolder") is not True:
                    raise SessionError("The library folder hierarchy failed validation.")
                seen.add(parent);parent=lookup[parent].get("parentKey")
        self.items=value["items"];self.revision=value["revision"]
        return value
    def organize(self,operation,keys=(),name=None,parent=None):
        if self.revision is None:raise SessionError("Refresh the library before changing it.")
        if operation not in ("create-folder","rename","move","copy","delete") or len(keys)>100:raise ValueError("Unsupported library action.")
        if any(not storage.KEY.fullmatch(k or "") for k in keys) or parent is not None and not storage.KEY.fullmatch(parent):raise ValueError("Invalid library selection.")
        value=dict(workspace=self.selected_note,operation=operation,keys=list(keys),parentKey=parent,expectedRevision=self.revision)
        if name is not None:value["name"]=name
        try:result=self.session.request("/v1/receivers/me/library/operations","POST",value)
        except SessionError:
            self.refresh_tree();raise
        if not isinstance(result.get("items"),list):raise SessionError("The library operation response failed validation.")
        storage._validate_library_items(result["items"])
        if type(result.get("revision")) is not int or any(i["workspace"]!=self.selected_note for i in result.get("items",[])):
            raise SessionError("The library operation response failed validation.")
        self.items=result["items"];self.revision=result["revision"];return result
    def import_vault(self,envelope,password):
        if not self.session.receiver:raise SessionError("Connect the intended account first.")
        keys=vault.open_vault(envelope,password,self.session.receiver)
        if self.keys is not None and (self.keys["storageSecret"]!=keys["storageSecret"] or self.keys["keymap"]!=keys["keymap"]):
            raise vault.VaultError("This session already has different keys. They will not be replaced.")
        path=vault.install_keymap(keys,self.root/"keys",crypto_runtime())
        self.keys=keys;self.keymap=path;self.vault_exported=True
    def initialize_empty_vault(self):
        if self.session.integration_mode:raise vault.VaultError("Initialize new storage keys using a full Red-XAI account session.")
        value=self.session.request("/v1/receivers/me")
        if self.keys or value.get("id")!=self.session.receiver or type(value.get("usedBytes")) is not int or value["usedBytes"]!=0 or type(value.get("libraryItems")) is not int or value["libraryItems"]!=0:
            raise vault.VaultError("Existing encrypted storage requires its original portable vault.")
        directory=private.private_directory(self.root/"keys")
        path=directory/(self.session.receiver+".keymap")
        if path.exists() or path.is_symlink():raise vault.VaultError("A keymap already exists. Import its original portable vault.")
        secret=secrets.token_urlsafe(32)
        rsx=crypto_runtime()
        with private.temporary_directory(self.root/"scratch",prefix="initialize-") as td:
            candidate=Path(td)/"new.keymap"
            with rsx.session_open(secret,str(candidate)):pass
            data=candidate.read_bytes();vault.validate_keymap(data)
        keys=dict(receiverId=self.session.receiver,storageSecret=secret,keymap=data)
        path=vault.install_keymap(keys,directory,rsx)
        self.keys=keys;self.keymap=path;self.vault_exported=False
    def export_vault(self,password):
        if self.keys is None:raise vault.VaultError("Import or initialize storage keys first.")
        data=vault.seal_vault(self.keys,password)
        return data
    def config(self):
        if self.keys is None or self.keymap is None or self.keys["receiverId"]!=self.session.receiver:
            raise vault.VaultError("Import this account's portable vault before encrypted transfers.")
        if self.selected_note not in {n["id"] for n in self.notes}:raise SessionError("Choose a current MachineNote.")
        return dict(provider="redxai",cloudApi=API,workspaceId=self.selected_note,receiverId=self.session.receiver,
            storageSecret=self.keys["storageSecret"],keymapPath=str(self.keymap),constrained=False,_session=self.session)
    @transfer_progress
    def upload(self,source,parent=None):
        if not self.vault_exported:raise vault.VaultError("Export your new portable vault before uploading. This is the only recovery copy of its storage key.")
        source=Path(source).absolute();safe_path(source.name)
        if source.name.lower().endswith(".app"):raise ValueError("Use the macOS client to preserve application bundle metadata.")
        baseline=manifest(source);total=sum(r.get("size",0) for r in baseline["manifest"])
        config=self.config();client=DesktopReceiver(config);client.verified_workers(write=True)
        tree=self.refresh_tree();lookup={i["key"]:i for i in tree["items"]}
        if parent is not None and lookup.get(parent,{}).get("virtualFolder") is not True:raise ValueError("Choose an existing virtual folder.")
        if any(i.get("parentKey")==parent and unicodedata.normalize("NFC",i.get("displayName",i["name"])).casefold()==unicodedata.normalize("NFC",source.name).casefold() for i in tree["items"]):
            raise ValueError("An item with that name already exists in this folder.")
        private.private_directory(self.root);require_space(self.root,total*3)
        key=hashlib.sha256(json.dumps(["gendragoon-desktop-library/v1",self.session.receiver,self.selected_note,parent,source.name],ensure_ascii=False,separators=(",",":")).encode()).hexdigest()[:18]
        with private.temporary_directory(self.root,prefix="transfer-") as td:
            directory=Path(td);archive=directory/"archive.zip";self.progress.phase("archiving",total_bytes=total);package(source,archive,baseline)
            digest=storage.sha256_file(archive)
            result=storage.upload_archive(config,archive,key,source.name,"folder" if source.is_dir() else "file","zip-root",digest,
                baseline["manifest"],parent_key=parent,client_factory=DesktopReceiver)
            item=dict(key=key,name=source.name,kind="folder" if source.is_dir() else "file",workspace=self.selected_note,
                manifestId=result["manifestId"],archiveBytes=result["archiveBytes"],archiveSha256=digest)
            readback=directory/"readback.zip";verified=storage.download_archive(config,item,readback,client_factory=DesktopReceiver)
            if verified["manifest"]!=baseline["manifest"]:raise ValueError("Encrypted readback metadata differs from the source. Original retained.")
            restored=private.private_directory(directory/"restore")
            self.progress.phase("verifying",total_bytes=total);extract_checked(readback,restored,verified["manifest"],source.name,"zip-root");self.progress.advance(total)
            if manifest(source)!=baseline:raise ValueError("The source changed during transfer. Original retained.")
        self.refresh_tree();return dict(verified=True,originalRetained=True,key=key,parentKey=parent,
            manifestId=result["manifestId"],archiveSha256=digest)
    @transfer_progress
    def download(self,key,destination):
        config=self.config();tree=self.refresh_tree();items={i["key"]:i for i in tree["items"]}
        if key not in items:raise SessionError("Refresh the library selection.")
        destination=Path(destination).absolute()
        if any(p.is_symlink() for p in (destination,*destination.parents)) or not destination.is_dir():raise ValueError("Choose an existing real destination folder.")
        root_name=items[key].get("displayName",items[key]["name"]);safe_path(root_name)
        if "/" in root_name:raise ValueError("The selected item name is unsafe.")
        # Only the new staging leaf is made private; the chosen destination
        # directory and all existing user files keep their current permissions.
        staging_path=destination/(".gendragoon-restore-"+uuid.uuid4().hex)
        private.private_directory(staging_path)
        try:
            td=str(staging_path)
            staging=Path(td);seen=set()
            def restore(item,output,name):
                safe_path(name)
                if "/" in name or item["key"] in seen:raise ValueError("The library contains an unsafe folder cycle.")
                seen.add(item["key"])
                if item.get("virtualFolder") is True:
                    result=private.private_directory(output/name)
                    for child in items.values():
                        if child.get("parentKey")==item["key"]:restore(child,result,child.get("displayName",child["name"]))
                    return result
                if item.get("kind")=="app":raise ValueError("Restore macOS applications with the macOS client.")
                require_space(staging,item.get("archiveBytes",0)*2)
                archive=staging/(uuid.uuid4().hex+".zip")
                result=storage.download_archive(config,item,archive,client_factory=DesktopReceiver)
                scratch=private.private_directory(staging/uuid.uuid4().hex)
                total=sum(r.get("size",0) for r in result["manifest"]);self.progress.phase("restoring",total_bytes=total)
                checked=extract_checked(archive,scratch,result["manifest"],item["name"],result["root"]["archiveLayout"]);self.progress.advance(total)
                private.protect_generated_tree(scratch)
                target=output/name
                publish_exclusive(checked,target);archive.unlink();scratch.rmdir();return target
            restored=restore(items[key],staging,root_name)
            private.protect_generated_tree(staging)
            target=destination/root_name;publish_exclusive(restored,target)
        finally:shutil.rmtree(staging_path)
        return dict(verified=True,path=str(target))
    def teams(self,cursor=None):
        if self.session.integration_mode:raise SessionError("Teams requires browser account approval; integration keys have no team access.",403)
        return self.session.request("/v1/receivers/me/dev-teams"+("?cursor="+self._cursor(cursor) if cursor else ""))
    @staticmethod
    def _cursor(cursor):
        import re
        if not isinstance(cursor,str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,300}",cursor):raise ValueError("Invalid page cursor.")
        return cursor
    def team_request(self,path,method="GET",value=None):
        if self.session.integration_mode:raise SessionError("Teams requires browser account approval.",403)
        if not path.startswith(("/v1/receivers/me/dev-","/v1/receivers/me/workspaces/","/v1/receivers/teams/")):
            raise ValueError("Unsupported Teams request.")
        return self.session.request(path,method,value)

    def enqueue_selection(self,note,parent,paths):
        if note not in {n["id"] for n in self.notes} or not self.session.receiver:
            raise SessionError("Choose a MachineNote owned by this session.")
        if parent is not None and not storage.KEY.fullmatch(parent):raise ValueError("Invalid destination folder.")
        if not isinstance(paths,list) or not 1<=len(paths)<=100 or any(not isinstance(p,str) or not Path(p).is_absolute() for p in paths):
            raise ValueError("Select at most 100 actual local paths.")
        job={"schema":1,"id":uuid.uuid4().hex,"receiverId":self.session.receiver,"workspaceId":note,"parentKey":parent,
            "sources":list(dict.fromkeys(paths)),"state":"queued","createdAt":int(time.time()),"attempts":0}
        directory=private.private_directory(self.root/"jobs"/self.session.receiver)
        if directory.resolve()!=directory or directory.is_symlink():raise ValueError("The private upload queue is linked.")
        path=directory/(job["id"]+".json")
        fd=private.create_file(path)
        with os.fdopen(fd,"w",encoding="utf8") as out:json.dump(job,out,ensure_ascii=False);out.flush();os.fsync(out.fileno())
        self._sync_jobs(directory)
        return job
    @staticmethod
    def _sync_jobs(directory):
        if os.name!="nt":
            fd=os.open(directory,os.O_RDONLY|getattr(os,"O_DIRECTORY",0))
            try:os.fsync(fd)
            finally:os.close(fd)
    def jobs(self):
        if not self.session.receiver:return []
        directory=self.root/"jobs"/self.session.receiver
        if not directory.exists():return []
        if directory.resolve()!=directory:raise ValueError("The private upload queue is linked.")
        result=[]
        for path in sorted(directory.glob("*.json")):
            private.verify(path)
            info=path.lstat()
            if not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_nlink!=1 or info.st_size>1024*1024 or os.name!="nt" and info.st_mode&0o077:
                raise ValueError("The private upload queue contains an unsafe record.")
            job=json.loads(path.read_text(encoding="utf8"))
            if (not isinstance(job,dict) or job.get("schema")!=1 or job.get("receiverId")!=self.session.receiver
                    or not storage.ID.fullmatch(job.get("id", "")) or path.stem!=job["id"]
                    or not storage.ID.fullmatch(job.get("workspaceId", "")) or job.get("state") not in ("queued","running","failed","completed")
                    or not isinstance(job.get("sources"),list) or not 1<=len(job["sources"])<=100
                    or any(not isinstance(p,str) or not Path(p).is_absolute() for p in job["sources"])
                    or job.get("parentKey") is not None and not storage.KEY.fullmatch(str(job["parentKey"]))):
                raise ValueError("A saved upload job failed validation.")
            result.append(job)
        return sorted(result,key=lambda j:j["createdAt"])
    def _save_job(self,job):
        directory=self.root/"jobs"/self.session.receiver
        if job["receiverId"]!=self.session.receiver or not storage.ID.fullmatch(job["id"]):raise ValueError("The queued account changed.")
        temp=directory/(".job-"+uuid.uuid4().hex);fd=private.create_file(temp)
        try:
            with os.fdopen(fd,"w",encoding="utf8") as out:json.dump(job,out,ensure_ascii=False);out.flush();os.fsync(out.fileno())
            os.replace(temp,directory/(job["id"]+".json"))
            self._sync_jobs(directory)
        finally:Path(temp).unlink(missing_ok=True)
    def retry_jobs(self):
        for job in self.jobs():
            if job["state"] in ("failed","running"):job["state"]="queued";job.pop("failure",None);self._save_job(job)
    def run_next_job(self):
        queued=next((j for j in self.jobs() if j["state"]=="queued"),None)
        if queued is None:return None
        if not self.vault_exported or self.keys is None:raise vault.VaultError("Import your account's vault before resuming queued uploads.")
        old_note=self.selected_note;queued["state"]="running";queued["attempts"]=queued.get("attempts",0)+1;self._save_job(queued)
        try:
            self.select_note(queued["workspaceId"])
            completed=queued.setdefault("completedSources",[]);results=queued.setdefault("results",[])
            if not isinstance(completed,list) or len(set(completed))!=len(completed) or any(type(i) is not int or not 0<=i<len(queued["sources"]) for i in completed) or len(results)!=len(completed):
                raise ValueError("The queued upload completion record is invalid.")
            for index,path in enumerate(queued["sources"]):
                if index in completed:
                    recorded=results[completed.index(index)]
                    item=next((i for i in self.items if i["key"]==recorded.get("key")),None)
                    if item is None or item.get("manifestId")!=recorded.get("manifestId") or item.get("archiveSha256")!=recorded.get("archiveSha256"):
                        raise ValueError("A previously completed queued item changed. Its newer library version was preserved.")
                    continue
                results.append(self.upload(Path(path),queued["parentKey"]));completed.append(index);self._save_job(queued)
            queued["state"]="completed";queued["completedAt"]=int(time.time());self._save_job(queued)
            return queued
        except Exception:
            queued["state"]="failed";queued["failure"]={"code":"transfer_failed","at":int(time.time())};self._save_job(queued)
            raise
        finally:self.selected_note=old_note;self.items=[];self.revision=None
