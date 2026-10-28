"""Explicit portable PE/ELF launch and retained, account-bound process leases.

Catalog origin and filename hints never authorize execution. The current
MachineNotes client supplies a freshly authenticated archive and manifest.
Every preparation is retained, including failures. There is deliberately no
cache eviction or original removal. Explicit Stop requests are broker-owned;
no browser-supplied process IDs or executable paths authorize termination.
"""
from dataclasses import dataclass
import base64
import ctypes
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import stat
import struct
import subprocess
import sys
import time
import uuid

# Source-tree broker runs need the reviewed Windows IPC helper just like staged
# clients. Use only the fixed adjacent Resources directory, never PYTHONPATH
# inherited from a browser or arbitrary caller. Frozen/staged apps keep their
# bundled module resolution unchanged.
_resources = Path(__file__).resolve().parents[1] / "Resources"
if not getattr(sys, "frozen", False) and (_resources / "gendragoon_platform_ipc.py").is_file():
    sys.path.insert(0, str(_resources))
import private_fs as private

SCHEMA="gendragoon.portable-app/v1"
WINDOWS_LAYOUT="v2"
WINDOWS_LAYOUTS=frozenset(("v1","v2"))
HEX=re.compile(r"[a-f0-9]+")
ATOMIC_TEMP=re.compile(r"\.private-[a-f0-9]{32}")
MAX_RECORD=128*1024*1024
FAILURE_STAGES=frozenset(("read-spec","read-lease","validate-spec","verify-payload","binary-header","working-directory","broker-identity","receipt-owner","native-imports","job-create","job-limits","dll-reset","process-create","job-assign","process-resume","receipt-running","job-accounting","main-exit","receipt-main-exit","linux-subreaper","linux-process-create","linux-wait","receipt-complete","broker-create","unreported"))
ERROR_TYPES=frozenset(("ImportError","ModuleNotFoundError","AttributeError","KeyError","PermissionError","OSError","ValueError","PortableAppError","TypeError","RuntimeError","SystemExit","KeyboardInterrupt","error"))

class PortableAppError(ValueError):pass

def _failure(stage,error):
    """Fixed metadata only: never exception text, paths, keys or app output."""
    name=type(error).__name__
    value=dict(stage=stage if stage in FAILURE_STAGES else "unreported",errorType=name if name in ERROR_TYPES else "Exception")
    for field in ("errno","winerror"):
        code=getattr(error,field,None)
        if type(code) is int and 0<=code<=0xffffffff:value[field]=code
    return value

def _launch_failure(lease,child):
    diagnostic=lease.with_name("diagnostic-"+lease.stem.removeprefix("lease-")+".json")
    result={"stage":"unreported"}
    try:
        saved=_read(diagnostic)
        if saved.get("stage") in FAILURE_STAGES:result["stage"]=saved["stage"]
        if saved.get("errorType") in ERROR_TYPES|{"Exception"}:result["errorType"]=saved["errorType"]
        for field in ("errno","winerror"):
            if type(saved.get(field)) is int and 0<=saved[field]<=0xffffffff:result[field]=saved[field]
    except Exception:pass
    try:
        saved=_read(lease);result["leaseState"]=saved["state"] if saved.get("state") in ("pending","running","complete","uncertain","failed-before-start") else "uncertain"
        result["brokerIdentityRecorded"]=bool(saved.get("brokerIdentity"))
    except Exception:result["leaseState"]="uncertain"
    code=child.poll()
    if type(code) is int:result["brokerExitCode"]=code
    error=PortableAppError("Launch could not be confirmed. The cache and process lease were retained; review them before changing accounts or deleting items.")
    error.diagnostic=result
    return error

def host():
    system="windows" if sys.platform=="win32" else "linux" if sys.platform.startswith("linux") else None
    architecture={"amd64":"x86_64","x86_64":"x86_64","aarch64":"arm64","arm64":"arm64","i386":"x86","i686":"x86","x86":"x86"}.get(platform.machine().lower())
    if not system or not architecture:raise PortableAppError("Managed portable launch requires a supported Windows or Linux computer.")
    return system,architecture

def identity(receiver,note,item):
    values=(receiver,note,item.get("key"),item.get("manifestId"),item.get("archiveSha256"))
    if any(not isinstance(value,str) or len(value)!=length or not HEX.fullmatch(value) for value,length in zip(values,(64,32,18,32,64))):
        raise PortableAppError("Refresh the authenticated archive generation before preparing an app.")
    return dict(zip(("receiverId","workspaceId","key","manifestId","archiveSha256"),values))

def generation(value):
    return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(",",":")).encode("ascii")).hexdigest()

def _real(path):
    path=Path(path)
    if not path.is_absolute():raise PortableAppError("Portable app paths must be absolute.")
    for ancestor in (path,*path.parents):
        info=ancestor.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info,"st_file_attributes",0)&0x400:
            raise PortableAppError("Portable app paths cannot contain links or reparse points.")
    return path.lstat()

def _safe_ancestors(path):
    for ancestor in (Path(path),*Path(path).parents):
        try:info=ancestor.lstat()
        except FileNotFoundError:continue
        if stat.S_ISLNK(info.st_mode) or getattr(info,"st_file_attributes",0)&0x400:
            raise PortableAppError("A portable app cache cannot use linked parent folders.")

def _inventory_kind(path):
    name=Path(path).name
    if ATOMIC_TEMP.fullmatch(name):return "atomic-temp"
    for kind in ("lease","launch","diagnostic","stop"):
        if re.fullmatch(kind+r"-[a-f0-9]{32}\.json",name):return kind
    return "binding" if name=="binding.json" else "other"

def _inventory_failure(path,error,operation,layout):
    """Fixed, bounded evidence only; never a path or exception message."""
    name=type(error).__name__
    value=dict(stage="inventory-metadata",errorCode="inventory_unverified",entryKind=_inventory_kind(path),
        layout=layout if layout in WINDOWS_LAYOUTS|{"legacy"} else "unlisted",
        operation=operation if operation in ("path-metadata","private-acl","control-identity","fresh-absence") else "unlisted",
        pathUtf16Units=min(32768,len(str(path).encode("utf-16-le",errors="surrogatepass"))//2),
        errorType=name if name in ERROR_TYPES|{"FileNotFoundError"} else "Exception")
    for field in ("errno","winerror"):
        code=getattr(error,field,None)
        if type(code) is int and 0<=code<=0xffffffff:value[field]=code
    value["nativeOperation"]="GetFileSecurity" if len(error.args)>=2 and error.args[1]=="GetFileSecurity" else "unlisted"
    result=PortableAppError("The retained app inventory needs review. Cached files and process leases were retained.")
    result.diagnostic=value
    return result

def _native_missing_security_leaf(error):
    if os.name!="nt":return False
    try:import pywintypes
    except ImportError:return False
    return (type(error) is pywintypes.error and len(error.args)>=2
        and type(error.args[0]) is int and error.args[:2]==(2,"GetFileSecurity"))

def _open_record(path,*,delete=False):
    if os.name=="nt":
        import msvcrt,win32api,win32con,win32file
        # A CRT _wopen reader omits FILE_SHARE_DELETE and can prevent the
        # broker's atomic receipt replacement. Open a non-inherited native
        # read handle with rename sharing; retain all checks below and open
        # the leaf itself rather than following a replacement reparse point.
        handle=win32file.CreateFile(str(path),win32con.GENERIC_READ|(win32con.DELETE if delete else 0),
            win32con.FILE_SHARE_READ|win32con.FILE_SHARE_WRITE|win32con.FILE_SHARE_DELETE,
            None,win32con.OPEN_EXISTING,win32file.FILE_FLAG_OPEN_REPARSE_POINT,None)
        raw=handle.Detach()
        try:fd=msvcrt.open_osfhandle(raw,os.O_RDONLY|os.O_BINARY|os.O_NOINHERIT)
        except BaseException:win32api.CloseHandle(raw);raise
    else:fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
    return fd

def _read(path):
    info=private.verify(path);_real(path)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size>MAX_RECORD:raise PortableAppError("The retained portable app record needs review.")
    fd=_open_record(path)
    with os.fdopen(fd,"rb") as source:
        opened=os.fstat(source.fileno())
        if (opened.st_dev,opened.st_ino)!=(info.st_dev,info.st_ino):
            error=PortableAppError("The portable app record changed while opening it.")
            error.diagnostic=dict(stage="record-open-identity",errorCode="record_identity_changed",errorType="PortableAppError")
            raise error
        return json.load(source)

def _write(path,value):
    _real(path.parent);private.verify(path.parent)
    data=json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=True).encode("ascii")
    if os.name!="nt":
        private.write_private(path,data,replace=path.exists());return
    try:path.lstat()
    except FileNotFoundError:
        private.write_private(path,data);return
    temporary=path.with_name(".private-"+uuid.uuid4().hex)
    # Exclusive private creation includes flush/fsync before publication.
    # A creation failure must not remove a pre-existing colliding leaf.
    private.write_private(temporary,data)
    try:
        _replace_windows_record(temporary,path)
    finally:temporary.unlink(missing_ok=True)  # Only our unpublished temp.

def _replace_windows_record(temporary,path):
    """Publish only an owned receipt, preserving readers of its old bytes."""
    if temporary.parent!=path.parent or not ATOMIC_TEMP.fullmatch(temporary.name):raise PortableAppError("Invalid portable receipt publication.")
    info=private.verify(temporary);_real(temporary)
    target=private.verify(path);_real(path)
    if any(not stat.S_ISREG(row.st_mode) or row.st_nlink!=1 for row in (info,target)):
        raise PortableAppError("The portable receipt publication needs review.")
    fd=_open_record(temporary,delete=True)
    try:
        opened=os.fstat(fd)
        if ((opened.st_dev,opened.st_ino)!=(info.st_dev,info.st_ino) or not stat.S_ISREG(opened.st_mode) or opened.st_nlink!=1):
            raise PortableAppError("The portable receipt changed before publication.")
        import msvcrt
        from ctypes import wintypes
        class RenameInfo(ctypes.Structure):
            _fields_=[("Flags",wintypes.DWORD),("RootDirectory",wintypes.HANDLE),("FileNameLength",wintypes.DWORD),("FileName",wintypes.WCHAR*1)]
        name=str(path).encode("utf-16-le");buffer=ctypes.create_string_buffer(ctypes.sizeof(RenameInfo)+len(name)+2)
        value=RenameInfo.from_buffer(buffer);value.Flags=3;value.RootDirectory=None;value.FileNameLength=len(name)
        ctypes.memmove(ctypes.addressof(buffer)+RenameInfo.FileName.offset,name,len(name))
        kernel=ctypes.WinDLL("kernel32",use_last_error=True)
        kernel.SetFileInformationByHandle.argtypes=[wintypes.HANDLE,ctypes.c_int,ctypes.c_void_p,wintypes.DWORD]
        kernel.SetFileInformationByHandle.restype=wintypes.BOOL
        # FileRenameInfoEx (22), REPLACE_IF_EXISTS | POSIX_SEMANTICS (1 | 2).
        # Legacy MoveFileEx/os.replace cannot replace a held target on Windows.
        # Unsupported filesystems fail closed; never unlink the target first.
        if not kernel.SetFileInformationByHandle(msvcrt.get_osfhandle(fd),22,buffer,len(buffer)):
            raise ctypes.WinError(ctypes.get_last_error())
        private.verify(path);_real(path)
    finally:os.close(fd)

def _binding(parent,expected=None):
    _real(parent);private.verify(parent)
    layout=parent.parent.name
    if layout not in WINDOWS_LAYOUTS:raise PortableAppError("The retained app layout needs review.")
    value=_read(parent/"binding.json")
    raw=value.get("identity",{})
    binding=identity(raw.get("receiverId"),raw.get("workspaceId"),raw)
    if (value!=dict(schema=SCHEMA,layout=layout,identity=binding) or generation(binding)!=parent.name
            or expected is not None and binding!=expected):
        raise PortableAppError("The retained app generation identity needs review.")
    return binding

def _canonical_attempt(name):
    if not re.fullmatch(r"[A-Za-z0-9_-]{22}",name):return False
    raw=base64.urlsafe_b64decode(name+"==")
    return len(raw)==16 and base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")==name

def _new_attempt(parent):
    value=uuid.uuid4()
    name=base64.urlsafe_b64encode(value.bytes).decode("ascii").rstrip("=") if sys.platform=="win32" else value.hex
    directory=parent/name
    try:
        # Never adopt an existing leaf, including a Windows case-fold alias.
        if os.name=="nt":
            modules,*_=private._windows();modules[4].CreateDirectory(str(directory),private._attributes(True))
        else:directory.mkdir(mode=0o700)
    except Exception as error:
        if isinstance(error,FileExistsError) or getattr(error,"winerror",None) in (80,183):
            raise PortableAppError("A retained app attempt already uses that directory. All cached files were retained; prepare again.") from None
        raise
    return private.private_directory(directory)

def _check_working_directory(executable):
    # CreateProcessW still rejects a current directory beyond MAX_PATH, even
    # with longPathAware. Reserve its appended backslash and terminating NUL.
    if sys.platform=="win32" and len(str(executable.parent).encode("utf-16-le"))//2+2>260:
        raise PortableAppError("The selected app folder exceeds the Windows working-directory limit. Its verified cache was retained; choose an app with a shorter folder structure.")

def _digest(path):
    digest=hashlib.sha256()
    with path.open("rb") as source:
        while block:=source.read(1024*1024):digest.update(block)
    return digest.hexdigest()

def binary_kind(path):
    """Inspect executable headers, never a name, suffix, or catalog hint."""
    path=Path(path);info=_real(path)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:return None
    with path.open("rb") as source:
        header=source.read(64)
        if header[:4]==b"\x7fELF":
            if len(header)<52 or header[4] not in (1,2) or header[5]!=1 or header[6]!=1 or header[7] not in (0,3):return None
            endian="<" if header[5]==1 else ">"
            kind,machine=struct.unpack_from(endian+"HH",header,16)
            entry=struct.unpack_from(endian+("Q" if header[4]==2 else "I"),header,24)[0]
            architecture={62:"x86_64",183:"arm64",3:"x86"}.get(machine)
            if kind not in (2,3) or not entry or not architecture:return None
            if (architecture in ("x86_64","arm64"))!=(header[4]==2):return None
            return "linux",architecture
        if header[:2]==b"MZ" and len(header)==64:
            offset=struct.unpack_from("<I",header,60)[0]
            if not 64<=offset<=min(info.st_size-96,16*1024*1024):return None
            source.seek(offset);pe=source.read(128)
            if pe[:4]!=b"PE\0\0" or len(pe)<96:return None
            machine,sections=struct.unpack_from("<HH",pe,4)
            optional,flags=struct.unpack_from("<HH",pe,20)
            architecture={0x8664:"x86_64",0xAA64:"arm64",0x14C:"x86"}.get(machine)
            magic=struct.unpack_from("<H",pe,24)[0];subsystem=struct.unpack_from("<H",pe,92)[0]
            if (not architecture or not 1<=sections<=96 or optional<72 or not flags&2 or flags&(0x2000|0x1000)
                    or magic!=(0x10B if architecture=="x86" else 0x20B) or subsystem not in (2,3)):return None
            return "windows",architecture
    return None

def verify_payload(payload,records):
    """Recheck the complete restored tree against authenticated manifest bytes."""
    payload=Path(payload);_real(payload);private.verify(payload)
    expected={};folded=set()
    if not isinstance(records,list) or not records:raise PortableAppError("The authenticated app manifest is missing.")
    for row in records:
        relative=row.get("path") if isinstance(row,dict) else None
        if (not isinstance(relative,str) or relative!="." and (not relative or relative.startswith("/") or "\\" in relative or any(p in (".","..","") for p in relative.split("/")))
                or relative in expected or relative.casefold() in folded or row.get("type") not in ("file","directory")):
            raise PortableAppError("The authenticated app manifest contains unsafe paths.")
        expected[relative]=row;folded.add(relative.casefold())
    if "." not in expected:raise PortableAppError("The authenticated app manifest has no root.")
    actual={"."}
    if payload.is_dir():actual.update(path.relative_to(payload).as_posix() for path in payload.rglob("*"))
    if actual!=set(expected):raise PortableAppError("The retained app tree changed. Its cache was retained for review.")
    for relative,row in expected.items():
        path=payload if relative=="." else payload/relative
        info=_real(path);private.verify(path)
        if row["type"]=="directory":
            if not stat.S_ISDIR(info.st_mode):raise PortableAppError("The restored app directory changed.")
        elif (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size!=row.get("size") or _digest(path)!=row.get("sha256")):
            raise PortableAppError("The restored app bytes changed. Its cache was retained for review.")
    return expected

def verify_mounted(payload,records,mount,binding,selected=None):
    """Authenticate the mounted source and selected executable, never clone it."""
    import mount_platform
    if (not isinstance(mount,dict) or mount.get("readOnly") is not True
            or mount.get("payloadMode")!="remote-memory-v1"
            or mount.get("receiverId")!=binding.get("receiverId")
            or mount.get("workspaceId")!=binding.get("workspaceId")
            or mount_platform.mounted(mount) is not True
            or mount_platform.process_matches(mount.get("process")) is not True):
        raise PortableAppError("Mount this workspace with the updated Kamatera client first. No local copy was downloaded.")
    root=Path(mount["mountPath"]);payload=Path(payload)
    if not root.is_absolute() or not payload.is_relative_to(root) or payload==root:
        raise PortableAppError("App path escaped its mounted workspace.")
    _real(payload)
    expected={};folded=set()
    if not isinstance(records,list) or not 1<=len(records)<=100000:raise PortableAppError("Invalid mounted application manifest.")
    for row in records:
        relative=row.get("path") if isinstance(row,dict) else None
        if (not isinstance(relative,str) or relative!="." and (not relative or relative.startswith("/") or "\\" in relative or any(p in (".","..","") for p in relative.split("/")))
                or relative in expected or relative.casefold() in folded or row.get("type") not in ("file","directory")):
            raise PortableAppError("Unsafe mounted application manifest.")
        expected[relative]=row;folded.add(relative.casefold())
    if "." not in expected:raise PortableAppError("Missing mounted application root.")
    if selected is not None:
        row=expected.get(selected)
        if not row or row["type"]!="file":raise PortableAppError("Select an authenticated executable.")
        path=payload if selected=="." else payload/selected
        info=_real(path)
        if not stat.S_ISREG(info.st_mode) or info.st_size!=row.get("size") or _digest(path)!=row.get("sha256"):
            raise PortableAppError("Mounted executable failed verification. Nothing was launched.")
    return expected

@dataclass(frozen=True)
class PreparedApp:
    directory: Path
    payload: Path
    identity: dict
    records: list
    candidates: tuple
    mounted: dict | None = None

def process_identity(pid,*,required=False):
    """PID reuse cannot make an orphaned lease look healthy."""
    try:
        if sys.platform.startswith("linux"):
            raw=Path(f"/proc/{pid}/stat").read_text();fields=raw[raw.rindex(")")+2:].split()
            if fields[0]=="Z":return None
            return Path("/proc/sys/kernel/random/boot_id").read_text().strip()+":"+fields[19]
        if sys.platform=="win32":
            import win32api,win32process,win32event
            handle=win32api.OpenProcess(0x1000|0x100000,False,pid)
            try:
                if win32event.WaitForSingleObject(handle,0)!=258:return None
                return str(win32process.GetProcessTimes(handle)["CreationTime"])
            finally:handle.Close()
    except Exception:
        if required:raise
        return None
    return None

class PortableApps:
    def __init__(self,root):self.root=Path(root).absolute()
    def _parent(self,binding):
        if sys.platform=="win32":return self.root/WINDOWS_LAYOUT/generation(binding)
        return self.root/binding["receiverId"]/binding["workspaceId"]/generation(binding)
    def prepare(self,binding,restore):
        binding=identity(binding.get("receiverId"),binding.get("workspaceId"),binding)
        host();self.assert_safe("prepare another app",uncertain_only=True)
        _safe_ancestors(self.root)
        parent=self._parent(binding)
        if sys.platform=="win32":
            # New Windows copies use one full binding hash instead of the
            # deeply nested legacy account/note/hash path. Never adopt or
            # rewrite an existing generation missing its immutable identity.
            try:_real(parent)
            except FileNotFoundError:
                private.private_directory(parent)
                private.write_private(parent/"binding.json",json.dumps(dict(schema=SCHEMA,layout=WINDOWS_LAYOUT,identity=binding),sort_keys=True,separators=(",",":")).encode("ascii"))
            _binding(parent,binding)
        else:private.private_directory(parent)
        _real(parent)
        directory=_new_attempt(parent)
        content=private.private_directory(directory/"content");private.private_directory(directory/"control")
        # Each preparation re-authenticates the cloud archive through the
        # current downloader. Old verified, failed, and changed copies remain.
        payload,records=restore(content)
        payload=Path(payload)
        if payload.parent!=content:raise PortableAppError("The verified restore escaped its private cache.")
        private.protect_generated_tree(directory);verify_payload(payload,records)
        candidates=[]
        for row in records:
            if row["type"]!="file":continue
            path=payload if row["path"]=="." else payload/row["path"]
            if binary_kind(path)==host():candidates.append(row["path"])
        if not candidates:raise PortableAppError("This archive has no verified native executable matching this computer. Choose a recognized portable native app; scripts and installation packages are unsupported.")
        return PreparedApp(directory,payload,dict(binding),records,tuple(sorted(candidates)))
    def prepare_mounted(self,binding,payload,records,mount):
        binding=identity(binding.get("receiverId"),binding.get("workspaceId"),binding)
        host();self.assert_safe("prepare another app",uncertain_only=True)
        expected=verify_mounted(payload,records,mount,binding)
        candidates=[]
        for relative,row in expected.items():
            if row["type"]!="file":continue
            path=Path(payload) if relative=="." else Path(payload)/relative
            if sys.platform!="win32" and not row.get("executable",0):continue
            if sys.platform=="win32" and path.suffix.lower()!=".exe":continue
            if binary_kind(path)==host():candidates.append(relative)
            if len(candidates)>=256:break
        if not candidates:raise PortableAppError("No matching portable executable was found on the mounted workspace.")
        _safe_ancestors(self.root);parent=self._parent(binding)
        if sys.platform=="win32":
            if not parent.exists():
                private.private_directory(parent)
                private.write_private(parent/"binding.json",json.dumps(dict(schema=SCHEMA,layout=WINDOWS_LAYOUT,identity=binding),sort_keys=True,separators=(",",":")).encode("ascii"))
            _binding(parent,binding)
        else:private.private_directory(parent)
        directory=_new_attempt(parent)
        private.private_directory(directory/"content");private.private_directory(directory/"control")
        return PreparedApp(directory,Path(payload),binding,records,tuple(sorted(candidates)),dict(mount))
    def leases(self):
        try:self.root.lstat()
        except FileNotFoundError:return []
        _real(self.root);private.verify(self.root);result=[]
        # Path.glob suppresses directory scan errors on Python 3.13. Explicit
        # traversal must fail closed if any reserved cache level is unreadable.
        visited=0
        def children(directory,atomic=False,layout="unlisted"):
            nonlocal visited
            original_control=None
            if atomic:
                try:
                    original_control=_real(directory);verified=private.verify(directory)
                    if (original_control.st_dev,original_control.st_ino)!=(verified.st_dev,verified.st_ino):
                        raise PortableAppError("The control directory changed during inspection.")
                except Exception as error:raise _inventory_failure(directory,error,"control-identity",layout) from None
            for child in directory.iterdir():
                visited+=1
                if visited>100000:raise PortableAppError("The retained app inventory needs review.")
                operation="path-metadata"
                try:
                    info=_real(child);operation="private-acl";private.verify(child)
                except Exception as error:
                    # A known atomic-write leaf can be renamed between the
                    # enumeration and metadata read. It still blocks guards;
                    # it never becomes evidence that a lease completed.
                    if (not atomic or not ATOMIC_TEMP.fullmatch(child.name)
                            or not (isinstance(error,FileNotFoundError) or _native_missing_security_leaf(error))):
                        raise _inventory_failure(child,error,operation,layout) from None
                    try:
                        current=_real(directory);verified=private.verify(directory)
                        if any((row.st_dev,row.st_ino)!=(original_control.st_dev,original_control.st_ino) for row in (current,verified)):
                            raise PortableAppError("The control directory changed during inspection.")
                    except Exception as recheck:raise _inventory_failure(directory,recheck,"control-identity",layout) from None
                    try:child.lstat()
                    except FileNotFoundError:pass
                    except Exception as recheck:raise _inventory_failure(child,recheck,"fresh-absence",layout) from None
                    else:raise _inventory_failure(child,error,"fresh-absence",layout) from None
                    info=None
                yield child,info
        def reserved(child,info,width):
            if not stat.S_ISDIR(info.st_mode) or len(child.name)!=width or not HEX.fullmatch(child.name):
                raise PortableAppError("The retained app inventory contains an unexpected path.")
            return child
        directories=[]
        for account,info in children(self.root):
            if account.name in WINDOWS_LAYOUTS:
                if not stat.S_ISDIR(info.st_mode):raise PortableAppError("The retained app inventory contains an unexpected path.")
                for parent,info in children(account):
                    reserved(parent,info,64);binding=_binding(parent)
                    for attempt,info in children(parent):
                        if attempt.name=="binding.json":continue
                        if account.name=="v1":reserved(attempt,info,32)
                        elif not stat.S_ISDIR(info.st_mode) or not _canonical_attempt(attempt.name):
                            raise PortableAppError("The retained app attempt name needs review.")
                        directories.append((attempt,binding,account.name))
                continue
            # Keep every legacy account/note/generation/attempt tree visible,
            # including copies prepared before the compact Windows layout.
            following=[reserved(account,info,64)]
            for width in (32,64,32):
                following=[reserved(child,info,width) for directory in following for child,info in children(directory)]
            directories.extend((directory,None,"legacy") for directory in following)
        paths=[];unsettled=[]
        for directory,binding,layout in directories:
            for child,info in children(directory):
                if child.name not in ("content","control") or not stat.S_ISDIR(info.st_mode):
                    raise PortableAppError("The retained app attempt inventory needs review.")
            control=directory/"control";_real(control);private.verify(control)
            for child,info in children(control,atomic=True,layout=layout):
                if ATOMIC_TEMP.fullmatch(child.name):
                    if info is not None and (not stat.S_ISREG(info.st_mode) or info.st_nlink!=1):
                        raise PortableAppError("The retained app control inventory needs review.")
                    unsettled.append(dict(state="uncertain",path=str(child)));continue
                if not stat.S_ISREG(info.st_mode) or not re.fullmatch(r"(?:lease|launch|diagnostic|stop)-[a-f0-9]{32}\.json",child.name):
                    raise PortableAppError("The retained app control inventory needs review.")
                if child.name.startswith("lease-"):paths.append((child,binding))
        # Authority records are siblings of content; app-owned similarly named
        # files inside a restored payload can never be interpreted as leases.
        for path,binding in paths:
            try:
                value=_read(path)
                if (value.get("schema")!=SCHEMA or value.get("state") not in ("pending","running","complete","failed-before-start","uncertain")
                        or value.get("id")!=path.stem.removeprefix("lease-")
                        or not isinstance(value.get("id"),str) or len(value["id"])!=32 or not HEX.fullmatch(value["id"])
                        or "mainExitCode" in value and (type(value["mainExitCode"]) is not int or not -255<=value["mainExitCode"]<=0xffffffff)
                        or value.get("state")=="complete" and "mainExitCode" not in value
                        or binding is not None and value.get("identity")!=binding):
                    raise PortableAppError("Invalid portable lease")
                state=value["state"]
                if state in ("pending","running"):
                    pid=value.get("brokerPid");start=value.get("brokerIdentity")
                    if type(pid) is not int or not start or process_identity(pid)!=start:state="uncertain"
                result.append(dict(value,state=state,path=str(path)))
            except Exception:result.append(dict(state="uncertain",path=str(path)))
        return result+unsettled
    def assert_safe(self,action,*,uncertain_only=False):
        blocked={"uncertain"} if uncertain_only else {"pending","running","uncertain"}
        try:unsafe=any(row["state"] in blocked for row in self.leases())
        except Exception:unsafe=True
        if unsafe:
            raise PortableAppError("Close every launched portable app and its children before you "+action+". An uncertain process lease needs review; all cached files and this account are retained.")
    def request_stop(self,identifier,*,force=False,approved=False):
        if approved is not True or type(force) is not bool:
            raise PortableAppError("Explicit approval is required to stop an application.")
        if not isinstance(identifier,str) or not re.fullmatch(r"[a-f0-9]{32}",identifier):
            raise PortableAppError("Choose a verified running application session.")
        matches=[value for value in self.leases() if value.get("id")==identifier]
        if len(matches)!=1 or matches[0]["state"]!="running":
            raise PortableAppError("The application is no longer running or its process identity is uncertain.")
        value=matches[0]
        if process_identity(value.get("brokerPid"))!=value.get("brokerIdentity"):
            raise PortableAppError("The application broker changed; no process was signaled.")
        path=Path(value["path"]).with_name("stop-"+identifier+".json")
        _write(path,dict(schema=1,id=identifier,brokerIdentity=value["brokerIdentity"],
            mode="force" if force else "graceful",createdAt=time.time(),nonce=uuid.uuid4().hex))
        return dict(id=identifier,requested=True,force=force,state="stop-requested")
    def launch(self,prepared,selected,*,approved=False):
        if approved is not True:raise PortableAppError("Explicit local approval is required to launch a portable app.")
        self.assert_safe("launch another app",uncertain_only=True)
        if selected not in prepared.candidates:raise PortableAppError("Select one verified executable from this archive.")
        expected_parent=self._parent(prepared.identity)
        if prepared.directory.parent!=expected_parent:raise PortableAppError("The launch belongs to a different account or archive generation.")
        if sys.platform=="win32":_binding(expected_parent,prepared.identity)
        if prepared.mounted:verify_mounted(prepared.payload,prepared.records,prepared.mounted,prepared.identity,selected)
        else:verify_payload(prepared.payload,prepared.records)
        executable=prepared.payload if selected=="." else prepared.payload/selected
        if binary_kind(executable)!=host():raise PortableAppError("The selected bytes are not a matching native executable.")
        _check_working_directory(executable)
        control=prepared.directory/"control";_real(control);private.verify(control)
        launch_id=uuid.uuid4().hex;lease=control/("lease-"+launch_id+".json");spec=control/("launch-"+launch_id+".json")
        record=dict(schema=SCHEMA,id=launch_id,state="pending",identity=prepared.identity,createdAt=time.time(),cacheRetained=not bool(prepared.mounted),payloadStorage="kamatera" if prepared.mounted else "explicit-local")
        _write(lease,record)
        _write(spec,dict(schema=SCHEMA,lease=str(lease),payload=str(prepared.payload),records=prepared.records,selected=selected,identity=prepared.identity,mounted=prepared.mounted))
        command=_broker_command(spec)
        options=dict(stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,env=_environment())
        if sys.platform=="win32":options["creationflags"]=subprocess.DETACHED_PROCESS|subprocess.CREATE_NEW_PROCESS_GROUP
        else:options["start_new_session"]=True
        try:child=subprocess.Popen(command,**options)
        except Exception:
            _write(lease,dict(record,state="failed-before-start"));raise PortableAppError("The app broker could not start. Cached files were retained.") from None
        # Popen is never terminated on timeout or on GUI shutdown. The detached
        # broker owns the process tree and persists its terminal receipt.
        deadline=time.monotonic()+10
        while time.monotonic()<deadline:
            try:value=_read(lease)
            except PortableAppError as error:
                if getattr(error,"diagnostic",None)!=dict(stage="record-open-identity",errorCode="record_identity_changed",errorType="PortableAppError"):raise
                # A broker can atomically publish its receipt between stat
                # and open. Discard that mismatched handle; the next bounded
                # poll must pass every original check on a freshly opened one.
                time.sleep(.025);continue
            if value["state"] in ("running","complete"):return value
            if value["state"] in ("failed-before-start","uncertain"):break
            if child.poll() is not None:break
            time.sleep(.025)
        raise _launch_failure(lease,child)

def _broker_command(spec):
    if getattr(sys,"frozen",False):return [sys.executable,"--portable-broker",str(spec)]
    return [sys.executable,"-B",str(Path(__file__).resolve()),"--broker",str(spec)]

def _environment():
    # Desktop account tokens and keys are never included in the spec or env.
    allowed={"PATH","HOME","USER","LOGNAME","SHELL","LANG","LANGUAGE","TZ","TMPDIR","TMP","TEMP","SYSTEMROOT","WINDIR","COMSPEC","USERPROFILE","LOCALAPPDATA","APPDATA","PROGRAMDATA","HOMEDRIVE","HOMEPATH","DISPLAY","WAYLAND_DISPLAY","XAUTHORITY","DBUS_SESSION_BUS_ADDRESS","XDG_RUNTIME_DIR","XDG_CONFIG_HOME","XDG_DATA_HOME","XDG_STATE_HOME","XDG_CURRENT_DESKTOP","DESKTOP_SESSION"}
    environment={key:value for key,value in os.environ.items() if key.upper() in allowed or key.startswith("LC_")}
    bundled=getattr(sys,"_MEIPASS",None)
    if bundled:
        root=os.path.normcase(os.path.abspath(bundled))
        for key in tuple(environment):
            if key.upper()!="PATH":continue
            kept=[]
            for entry in environment[key].split(os.pathsep):
                candidate=os.path.normcase(os.path.abspath(entry.strip('"')))
                try:inside=os.path.commonpath((root,candidate))==root
                except ValueError:inside=False
                if not inside:kept.append(entry)
            environment[key]=os.pathsep.join(kept)
    return environment

def broker(spec_path):
    """Detached owner of one app tree; terminate only on an approved Stop request."""
    spec_path=Path(spec_path).absolute();record=None;lease=None;started=False;stage="read-spec"
    launch_id=spec_path.stem.removeprefix("launch-")
    if spec_path.parent.name!="control" or spec_path.name!="launch-"+launch_id+".json" or len(launch_id)!=32 or not HEX.fullmatch(launch_id):return 1
    diagnostic=spec_path.with_name("diagnostic-"+launch_id+".json")
    def mark(value):
        nonlocal stage
        stage=value
    try:
        spec=_read(spec_path);lease=Path(spec["lease"])
        if lease.parent!=spec_path.parent or lease.name!="lease-"+launch_id+".json":raise PortableAppError("Invalid launch receipt.")
        mark("read-lease");record=_read(lease);mark("validate-spec")
        if spec.get("schema")!=SCHEMA or record.get("schema")!=SCHEMA or record.get("state")!="pending":raise PortableAppError("Invalid launch specification.")
        payload=Path(spec["payload"])
        if spec_path.parent.name!="control" or spec["identity"]!=record["identity"]:raise PortableAppError("Launch identity changed.")
        mounted=spec.get("mounted")
        if not mounted and payload.parent!=spec_path.parent.parent/"content":raise PortableAppError("Launch cache identity changed.")
        parent=spec_path.parent.parent.parent
        if parent.parent.name in WINDOWS_LAYOUTS:_binding(parent,spec["identity"])
        mark("verify-payload");selected=spec["selected"]
        expected=verify_mounted(payload,spec["records"],mounted,spec["identity"],selected) if mounted else verify_payload(payload,spec["records"])
        if selected not in expected or expected[selected]["type"]!="file":raise PortableAppError("Select a verified executable.")
        executable=payload if selected=="." else payload/selected
        mark("binary-header")
        if binary_kind(executable)!=host():raise PortableAppError("Executable format or architecture changed.")
        mark("working-directory");_check_working_directory(executable)
        mark("broker-identity");record.update(brokerPid=os.getpid(),brokerIdentity=process_identity(os.getpid(),required=True))
        if not record["brokerIdentity"]:raise PortableAppError("The app broker identity could not be verified.")
        # Publish ownership before any executable can run; a crash at any later
        # instruction leaves a conservative uncertain lease.
        mark("receipt-owner");_write(lease,record)
        def running(pid):
            nonlocal started
            started=True;record.update(state="running",appPid=pid);mark("receipt-running");_write(lease,record)
        def possible_start():
            nonlocal started
            started=True
        def exited(code):
            record.update(mainExitCode=code,mainExitedAt=time.time());mark("receipt-main-exit");_write(lease,record)
        from portable_control import StopControl
        control=StopControl(lease,record,_read,process_identity)
        if sys.platform.startswith("linux"):_linux_tree(executable,running,possible_start,exited,mark,control,mounted=bool(mounted))
        elif sys.platform=="win32":_windows_tree(executable,running,possible_start,exited,mark,control)
        else:raise PortableAppError("Unsupported portable app platform.")
        record.update(state="complete",completedAt=time.time());mark("receipt-complete");_write(lease,record)
        return 0
    except BaseException as error:
        # Even interruption does not send a signal or terminate a job. A
        # receipt after a possibly-started launch must remain uncertain.
        failure=_failure(stage,error)
        # A fresh private diagnostic leaf remains writable even if Windows
        # refuses replacement of a lease opened by the GUI's read-only poll.
        try:_write(diagnostic,failure)
        except Exception:pass
        if record is not None:
            record.update(state="uncertain" if started else "failed-before-start",updatedAt=time.time(),failure=failure)
            try:_write(lease,record)
            except Exception:pass
        return 1

def _linux_tree(executable,running,possible_start,exited,mark,control=None,*,mounted=False):
    import signal
    mark("linux-subreaper");libc=ctypes.CDLL(None,use_errno=True)
    if libc.prctl(36,1,0,0,0)!=0:raise PortableAppError("Linux process-tree tracking is unavailable.")
    # Parent/GUI terminal closure must not propagate a hangup to this broker.
    signal.signal(signal.SIGHUP,signal.SIG_IGN)
    if not mounted:executable.chmod(0o700)
    elif not os.access(executable,os.X_OK):raise PortableAppError("Mounted executable permission is unavailable. No local copy was created.")
    possible_start()
    mark("linux-process-create");process=subprocess.Popen([str(executable)],cwd=str(executable.parent),env=_environment(),stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,close_fds=True,start_new_session=True)
    # Mark the tree possibly started before any receipt write can fail.
    running(process.pid)
    while True:
        try:
            mark("linux-wait")
            if control is not None:
                from portable_control import stop_linux
                stop_linux(control)
            pid,status=os.waitpid(-1,os.WNOHANG)
            if pid==0:time.sleep(.05);continue
            if pid==process.pid:
                process.returncode=os.waitstatus_to_exitcode(status);exited(process.returncode)
        except InterruptedError:continue
        except ChildProcessError:break

def _windows_tree(executable,running,possible_start,exited,mark,control=None):
    mark("native-imports")
    import win32api,win32con,win32event,win32job,win32process
    # The pinned pywin32 WCHAR* wrapper requires a Unicode name, including
    # an empty string for an unnamed Job; it rejects Python None as TypeError.
    mark("job-create");job=win32job.CreateJobObject(None,"")
    process=thread=None;resumed=False
    try:
        mark("job-limits");limits=win32job.QueryInformationJobObject(job,win32job.JobObjectExtendedLimitInformation)
        # No kill-on-close, breakaway, process-count, memory, or time limit.
        if limits["BasicLimitInformation"]["LimitFlags"]!=0:raise PortableAppError("Unexpected process Job limits.")
        # PyInstaller sets a process-wide DLL directory inherited by children;
        # environment filtering alone cannot undo it. All broker extensions
        # above are already imported. Reset only this dedicated broker before
        # the external app starts; the GUI keeps its own runtime intact.
        mark("dll-reset");kernel=ctypes.WinDLL("kernel32",use_last_error=True)
        kernel.SetDllDirectoryW.argtypes=[ctypes.c_wchar_p];kernel.SetDllDirectoryW.restype=ctypes.c_int
        if not kernel.SetDllDirectoryW(None):raise PortableAppError("The external app DLL search directory could not be reset safely.")
        startup=win32process.STARTUPINFO()
        mark("process-create");process,thread,pid,_=win32process.CreateProcess(str(executable),subprocess.list2cmdline([str(executable)]),None,None,False,win32con.CREATE_SUSPENDED|win32con.CREATE_NEW_PROCESS_GROUP|win32con.CREATE_UNICODE_ENVIRONMENT,_environment(),str(executable.parent),startup)
        # Assignment occurs before the first application instruction. If this
        # fails the never-executed suspended fixture can safely be discarded.
        mark("job-assign");win32job.AssignProcessToJobObject(job,process)
        possible_start();resumed=True;mark("process-resume");win32process.ResumeThread(thread);running(pid)
        main_exited=False
        while True:
            mark("job-accounting")
            if control is not None:
                from portable_control import stop_windows
                stop_windows(control,job)
            if not win32job.QueryInformationJobObject(job,win32job.JobObjectBasicAccountingInformation)["ActiveProcesses"]:break
            if not main_exited and win32event.WaitForSingleObject(process,0)==win32con.WAIT_OBJECT_0:
                main_exited=True;mark("main-exit");exited(win32process.GetExitCodeProcess(process))
            time.sleep(.05)
        if not main_exited:exited(win32process.GetExitCodeProcess(process))
    finally:
        if process is not None and not resumed:
            # This path owns only a suspended process that never executed.
            win32api.TerminateProcess(process,1)
        if thread is not None:thread.Close()
        if process is not None:process.Close()
        job.Close()

if __name__=="__main__":
    if len(sys.argv)!=3 or sys.argv[1]!="--broker":raise SystemExit(2)
    raise SystemExit(broker(sys.argv[2]))
