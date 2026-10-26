"""Existing rclone and OS mount primitives. Never installs drivers or grants access."""
import base64
import contextlib
import ctypes
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import subprocess
import sys
import threading
import urllib.request

class PlatformMountError(RuntimeError):pass

STARTUP_REASONS=(
    (rb"cannot find (?:winfsp|fuse)|cannot load (?:winfsp|fuse)|failed to load.{0,80}(?:winfsp|fuse)","fuse_library_unavailable"),
    (rb"(?:cannot|failed to) create.{0,80}(?:winfsp|fuse)|(?:winfsp|fuse).{0,80}(?:initiali[sz]|create).{0,80}(?:fail|error)","fuse_start_failed"),
    (rb"(?:invalid|bad|unsupported).{0,40}(?:security|descriptor)|security descriptor.{0,40}(?:invalid|bad|unsupported)","invalid_security_descriptor"),
    (rb"unknown (?:flag|shorthand flag)|flag provided but not defined","unknown_flag"),
    (rb"unknown option|unrecognized option|unrecognised option|invalid option|unsupported option","invalid_option"),
    (rb"invalid (?:mountpoint|mount point)|mountpoint.{0,80}(?:exists|invalid)|mount point.{0,80}(?:exists|invalid)","invalid_mountpoint"),
    (rb"(?:unknown|invalid).{0,20}duration","invalid_duration"),
    (rb"access is denied|access denied|permission denied","access_denied"),
    (rb"device.{0,40}(?:not ready|not found|unavailable)|driver.{0,40}not.{0,20}(?:running|available|found)","driver_unavailable"),
    (rb"invalid handle|invalid parameter|invalid argument|bad file descriptor","invalid_argument"),
    (rb"mount failed|failed to mount|mount stopped","mount_failed"),
    (rb"address already in use|only one usage of each socket address","address_in_use"),
    (rb"panic:|assertion failed|fatal exception","process_runtime_error"),
    (rb"failed to create file system|couldn't connect|connection refused|deadline exceeded","remote_connect_failed"),
)
STARTUP_FLAGS=(b"config",b"read-only",b"vfs-cache-mode",b"cache-dir",b"dir-cache-time",b"attr-timeout",b"dir-perms",b"file-perms",b"volname",b"timeout",b"rc",b"rc-addr",b"log-level",b"log-format",b"option")

def _startup_reasons(fragment):
    lower=fragment[:8192].lower();reasons=[]
    for expression,code in STARTUP_REASONS:
        if re.search(expression,lower):reasons.append(code)
    if "unknown_flag" in reasons:
        for flag in STARTUP_FLAGS:
            if re.search(rb"--"+re.escape(flag)+rb"(?:[^a-z0-9-]|$)",lower):
                reasons.append("unknown_flag_"+flag.decode("ascii").replace("-","_"))
    if "invalid_option" in reasons and b"filesecurity" in lower:reasons.append("invalid_filesecurity_option")
    return reasons[:8]

def startup_failure(process):
    reader=getattr(process,"_gd_diagnostic_reader",None)
    if reader:reader.join(timeout=.5)
    status=process.poll()
    status=str(status) if type(status) is int and -0x80000000<=status<=0xffffffff else "unknown"
    reasons=getattr(process,"_gd_startup_reasons",[])[:8]
    return PlatformMountError("The filesystem process exited before creating a drive (exit "+status+"; reasons: "+(", ".join(reasons) or "unclassified")+"). Check the existing rclone and filesystem driver installation. No process was forcibly stopped.")

def trusted_binary(path):
    path=Path(path).absolute()
    if path.is_symlink() or not path.is_file():raise PlatformMountError("Choose the real installed rclone executable, without a link or wrapper.")
    info=path.stat()
    if info.st_size>256*1024*1024:raise PlatformMountError("The selected executable exceeds its limit.")
    with path.open("rb") as source:header=source.read(4)
    if sys.platform=="win32":
        if header[:2]!=b"MZ":raise PlatformMountError("Choose the installed Windows rclone.exe, not a script.")
        from gendragoon_platform_ipc import modules,user_sid
        security=modules()[-1];descriptor=security.GetFileSecurity(str(path),security.OWNER_SECURITY_INFORMATION|security.DACL_SECURITY_INFORMATION)
        trusted={security.ConvertSidToStringSid(user_sid()),"S-1-5-18","S-1-5-32-544"}
        if security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner()) not in trusted:raise PlatformMountError("The executable belongs to another Windows account.")
        acl=descriptor.GetSecurityDescriptorDacl()
        if acl is None:raise PlatformMountError("The executable has an unsafe Windows ACL.")
        for index in range(acl.GetAceCount()):
            ace=acl.GetAce(index)
            if ace[0][0] in (1,6,10,12):continue
            if ace[0][0] not in (0,5,9,11):raise PlatformMountError("The executable has an unsupported Windows ACL.")
            if security.ConvertSidToStringSid(ace[-1]) not in trusted and ace[1]&0x500D0116:
                raise PlatformMountError("Another Windows account can modify the selected executable.")
    elif header!=b"\x7fELF" or info.st_uid not in (0,os.getuid()) or info.st_mode&0o022 or not os.access(path,os.X_OK):
        raise PlatformMountError("Choose a trusted native executable owned by this user or the system, without group/public write access.")
    return str(path.resolve())

def prerequisites(rclone=None):
    if sys.platform!="win32" and not sys.platform.startswith("linux"):
        raise PlatformMountError("Desktop drives require Windows with WinFsp or Linux with FUSE.")
    found=rclone or shutil.which("rclone")
    if not found:raise PlatformMountError("Select an existing trusted rclone executable. GenDragoon does not install rclone or filesystem drivers.")
    binary=trusted_binary(found)
    try:result=subprocess.run([binary,"version"],stdin=subprocess.DEVNULL,capture_output=True,timeout=10)
    except (OSError,subprocess.TimeoutExpired):raise PlatformMountError("The selected executable could not run. Choose trusted rclone for this platform and architecture.") from None
    version=re.match(rb"rclone v(\d+)\.(\d+)\.(\d+)(?:[-.\w]*)?(?:\r?\n|$)",result.stdout)
    if result.returncode or not version or tuple(map(int,version.groups()))<(1,65,0):
        raise PlatformMountError("Use an existing rclone version 1.65 or newer.")
    tools={"rclone":binary,"sha256":hashlib.sha256(Path(binary).read_bytes()).hexdigest()}
    if sys.platform=="win32":
        import winreg
        locations=[]
        for view in (winreg.KEY_WOW64_32KEY,winreg.KEY_WOW64_64KEY):
            try:
                with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,r"SOFTWARE\WinFsp",0,winreg.KEY_READ|view) as key:
                    locations.append(Path(winreg.QueryValueEx(key,"InstallDir")[0])/"bin/winfsp-x64.dll")
            except OSError:pass
        for name in ("ProgramFiles(x86)","ProgramFiles"):
            if os.environ.get(name):locations.append(Path(os.environ[name])/"WinFsp/bin/winfsp-x64.dll")
        trusted=False
        for path in locations:
            if path.is_file() and not path.is_symlink():trusted_binary(path);trusted=True;break
        if not trusted:
            raise PlatformMountError("Windows drives need an existing WinFsp installation. Install it separately, then reopen GenDragoon. No driver was installed or changed.")
    else:
        fuse=Path("/dev/fuse")
        if not fuse.exists() or not stat.S_ISCHR(fuse.stat().st_mode):raise PlatformMountError("Linux FUSE is unavailable: /dev/fuse is missing. Enable FUSE separately; no permissions were changed.")
        try:descriptor=os.open(fuse,os.O_RDWR|getattr(os,"O_CLOEXEC",0));os.close(descriptor)
        except OSError:raise PlatformMountError("This user cannot use /dev/fuse. Enable normal FUSE access separately; GenDragoon does not change kernel permissions.") from None
        helper=shutil.which("fusermount3") or shutil.which("fusermount")
        if not helper:raise PlatformMountError("Linux drives require an existing fusermount3 or fusermount helper.")
        tools["unmount"]=trusted_binary(helper)
    return tools

def volume_label(owner,note):return "GenDragoon-"+owner[:8]+"-"+note[:8]

def choose_mount_path(root):
    if sys.platform=="win32":
        drives=ctypes.windll.kernel32.GetLogicalDrives()
        for letter in reversed("DEFGHIJKLMNOPQRSTUVWXYZ"):
            if not drives&(1<<(ord(letter)-65)):return Path(letter+":\\")
        raise PlatformMountError("No unused drive letter is available.")
    from private_fs import private_directory
    mount=private_directory(Path(root)/"mount")
    if any(mount.iterdir()):raise PlatformMountError("The generated mount directory contains unexpected files and was retained.")
    return mount

def valid_mount_path(record,root):
    path=record.get("mountPath", "")
    return bool(re.fullmatch(r"[D-Z]:\\",path)) if sys.platform=="win32" else path==str(Path(root)/"mount")

def _windows_volume(path):
    kernel=ctypes.WinDLL("kernel32",use_last_error=True)
    kind=kernel.GetDriveTypeW(ctypes.c_wchar_p(path))
    if kind==1:return False
    name=ctypes.create_unicode_buffer(256);fs=ctypes.create_unicode_buffer(256);serial=ctypes.c_uint32()
    if not kernel.GetVolumeInformationW(ctypes.c_wchar_p(path),name,256,ctypes.byref(serial),None,None,fs,256):return None
    return name.value,fs.value,serial.value

def capture_mount_identity(record):
    if sys.platform=="win32":
        actual=_windows_volume(record["mountPath"])
        if not isinstance(actual,tuple) or actual[0]!=record["label"] or actual[1].casefold()!="rclone":raise PlatformMountError("The new Windows volume identity could not be confirmed.")
        return {"volumeSerial":actual[2]}
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        fields=line.split();position=fields.index("-")
        decoded=re.sub(r"\\([0-7]{3})",lambda m:chr(int(m[1],8)),fields[4])
        if decoded==record["mountPath"] and fields[position+1]=="fuse.rclone":return {"mountId":fields[0]}
    raise PlatformMountError("The new FUSE mount identity could not be confirmed.")

def mounted(record):
    path=record["mountPath"]
    if sys.platform=="win32":
        actual=_windows_volume(path)
        if actual is False:return False
        if actual is None:return None
        return True if actual[0]==record["label"] and actual[1].casefold()=="rclone" and record.get("volumeSerial",actual[2])==actual[2] else None
    if not os.path.ismount(path):return False
    try:
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            fields=line.split();position=fields.index("-")
            decoded=re.sub(r"\\([0-7]{3})",lambda m:chr(int(m[1],8)),fields[4])
            if decoded==path:return True if fields[position+1]=="fuse.rclone" and record.get("mountId",fields[0])==fields[0] else None
    except (OSError,ValueError):pass
    return None

def unrecorded_mounts(root,known):
    """Detect real leftover drives even if their private registry is missing."""
    if sys.platform=="win32":
        drives=ctypes.windll.kernel32.GetLogicalDrives()
        for letter in "DEFGHIJKLMNOPQRSTUVWXYZ":
            if not drives&(1<<(ord(letter)-65)):continue
            path=letter+":\\";actual=_windows_volume(path)
            if isinstance(actual,tuple) and actual[0].startswith("GenDragoon-") and actual[1].casefold()=="rclone" and path not in known:return True
        return False
    if not sys.platform.startswith("linux"):return False
    try:
        for line in Path("/proc/self/mountinfo").read_text().splitlines():
            fields=line.split();decoded=re.sub(r"\\([0-7]{3})",lambda m:chr(int(m[1],8)),fields[4])
            if Path(decoded).is_relative_to(root) and decoded not in known:return True
    except (OSError,ValueError):return True
    return False

def process_identity(pid):
    if type(pid) is not int or pid<1:raise ProcessLookupError()
    if sys.platform=="win32":
        import win32api,win32process
        from gendragoon_platform_ipc import modules,user_sid
        security=modules()[-1];handle=win32api.OpenProcess(0x1000,False,pid)
        try:
            token=security.OpenProcessToken(handle,0x0008)
            try:owner=security.ConvertSidToStringSid(security.GetTokenInformation(token,security.TokenUser)[0])
            finally:token.Close()
            if owner!=security.ConvertSidToStringSid(user_sid()):raise ProcessLookupError()
            kernel=ctypes.WinDLL("kernel32",use_last_error=True);function=kernel.QueryFullProcessImageNameW
            function.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_wchar_p,ctypes.POINTER(ctypes.c_uint32)]
            value=ctypes.create_unicode_buffer(32768);size=ctypes.c_uint32(len(value))
            if not function(int(handle),0,value,ctypes.byref(size)):raise OSError("The drive process identity could not be verified.")
            return dict(pid=pid,start=str(win32process.GetProcessTimes(handle)["CreationTime"]),exe=value.value,owner=owner)
        finally:handle.Close()
    directory=Path("/proc")/str(pid);info=directory.stat()
    if info.st_uid!=os.getuid():raise ProcessLookupError()
    raw=(directory/"stat").read_text();fields=raw[raw.rindex(")")+2:].split()
    return dict(pid=pid,start=fields[19],exe=os.readlink(directory/"exe"),owner=info.st_uid)

def process_matches(identity):
    if not isinstance(identity,dict) or set(identity)!={"pid","start","exe","owner"}:return False
    try:return process_identity(identity["pid"])==identity
    except (ProcessLookupError,FileNotFoundError):return False
    except Exception:return None

def _windows_file_security():
    """WinFsp must not add metadata permissions for other local accounts."""
    try:
        from gendragoon_platform_ipc import modules,user_sid
        security=modules()[-1];owner=security.ConvertSidToStringSid(user_sid())
        # Normal local/domain users and Azure AD users. Service, group,
        # application and alias SIDs are deliberately unsupported here.
        if not isinstance(owner,str) or not re.fullmatch(r"S-1-(?:5-21|12-1)(?:-(?:0|[1-9][0-9]{0,9})){4}",owner):raise ValueError()
        if any(int(part)>0xffffffff for part in owner.split("-")[4:]):raise ValueError()
        sddl="O:"+owner+"G:"+owner+"D:P(A;;FRFX;;;"+owner+")"
        descriptor=security.ConvertStringSecurityDescriptorToSecurityDescriptor(sddl,1)
        acl=descriptor.GetSecurityDescriptorDacl();ace=acl.GetAce(0) if acl is not None and acl.GetAceCount()==1 else None
        if (security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner())!=owner
                or not descriptor.GetSecurityDescriptorControl()[0]&0x1000
                or ace is None or ace[0]!=(0,0) or ace[1]!=0x1200a9
                or security.ConvertSidToStringSid(ace[-1])!=owner):raise ValueError()
        return "FileSecurity="+sddl
    except Exception:
        raise PlatformMountError("The current Windows user's private drive permissions could not be verified. No filesystem process was started.") from None

def start(tools,record,url,token,cache):
    if trusted_binary(tools["rclone"])!=tools["rclone"] or hashlib.sha256(Path(tools["rclone"]).read_bytes()).hexdigest()!=tools["sha256"]:
        raise PlatformMountError("The selected rclone executable changed. Select and verify it again.")
    allowed={"PATH","SYSTEMROOT","WINDIR","TEMP","TMP","HOME","USER","LOGNAME","LANG","LC_ALL","LOCALAPPDATA","APPDATA","USERPROFILE","PROGRAMFILES","PROGRAMFILES(X86)","PROGRAMW6432"}
    environment={k:v for k,v in os.environ.items() if k.upper() in allowed}
    password=secrets.token_urlsafe(32)
    environment.update(RCLONE_WEBDAV_URL=url,RCLONE_WEBDAV_VENDOR="other",RCLONE_WEBDAV_BEARER_TOKEN=token,
        RCLONE_RC_USER="GenDragoon",RCLONE_RC_PASS=password)
    args=[tools["rclone"],"--config",os.devnull,"mount",":webdav:",record["mountPath"],"--read-only","--vfs-cache-mode=off",
        "--cache-dir",str(cache),"--dir-cache-time=0s","--attr-timeout=0s","--dir-perms=0500","--file-perms=0400",
        "--volname",record["label"],"--timeout=0","--rc","--rc-addr=127.0.0.1:0","--log-level=NOTICE","--log-format="]
    if sys.platform=="win32":args.extend(("--option",_windows_file_security()))
    flags={"creationflags":subprocess.CREATE_NO_WINDOW} if sys.platform=="win32" else {"start_new_session":True}
    process=subprocess.Popen(args,env=environment,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,**flags)
    process._gd_rc_password=password;process._gd_rc_url=None;process._gd_startup_reasons=[]
    def drain():
        for line in iter(lambda:process.stderr.readline(8192),b""):
            match=re.search(rb"Serving remote control on (http://127\.0\.0\.1:[0-9]+/)",line)
            if match:process._gd_rc_url=match[1].decode("ascii")
            for code in _startup_reasons(line):
                if code not in process._gd_startup_reasons and len(process._gd_startup_reasons)<8:process._gd_startup_reasons.append(code)
        process.stderr.close()
    process._gd_diagnostic_reader=threading.Thread(target=drain,daemon=True);process._gd_diagnostic_reader.start()
    return process

def _quit(process):
    url=getattr(process,"_gd_rc_url",None);password=getattr(process,"_gd_rc_password",None)
    if not url or not password:raise PlatformMountError("The private drive control channel is unavailable; the filesystem process was retained.")
    authorization=base64.b64encode(("GenDragoon:"+password).encode()).decode()
    request=urllib.request.Request(url+"core/quit",data=b'{"exitCode":0}',method="POST",headers={"Authorization":"Basic "+authorization,"Content-Type":"application/json"})
    try:
        from redx_session import NoRedirect
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect())
        with opener.open(request,timeout=3) as response:response.read(4096)
    except OSError:
        try:process.wait(timeout=3)
        except subprocess.TimeoutExpired:raise PlatformMountError("The filesystem process did not confirm normal shutdown.") from None

@contextlib.contextmanager
def _windows_dismount(record):
    path=record["mountPath"]
    kernel=ctypes.WinDLL("kernel32",use_last_error=True)
    kernel.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p]
    kernel.CreateFileW.restype=ctypes.c_void_p;kernel.CloseHandle.argtypes=[ctypes.c_void_p]
    kernel.DeviceIoControl.argtypes=[ctypes.c_void_p,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.POINTER(ctypes.c_uint32),ctypes.c_void_p]
    handle=kernel.CreateFileW("\\\\.\\"+path[:2],0x80000000,3,None,3,0,None)
    if handle==ctypes.c_void_p(-1).value:raise PlatformMountError("Windows could not exclusively open the drive. Close files and retry; no process was stopped.")
    locked=False;result=ctypes.c_uint32()
    try:
        query=kernel.GetVolumeInformationByHandleW
        query.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_uint32,ctypes.POINTER(ctypes.c_uint32),ctypes.c_void_p,ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_uint32]
        name=ctypes.create_unicode_buffer(256);filesystem=ctypes.create_unicode_buffer(256);serial=ctypes.c_uint32()
        if (not query(handle,name,256,ctypes.byref(serial),None,None,filesystem,256) or name.value!=record["label"]
                or filesystem.value.casefold()!="rclone" or record.get("volumeSerial")!=serial.value):
            raise PlatformMountError("The opened volume is not the recorded GenDragoon drive. No dismount was attempted.")
        if not kernel.DeviceIoControl(handle,0x90018,None,0,None,0,ctypes.byref(result),None):
            raise PlatformMountError("Windows could not lock this drive exclusively. Close open files and retry. Unsupported WinFsp controls require a normal OS unmount; the session remains protected.")
        locked=True
        if not kernel.DeviceIoControl(handle,0x90020,None,0,None,0,ctypes.byref(result),None):
            raise PlatformMountError("WinFsp did not confirm normal volume dismount. The filesystem process was retained.")
        # Keep the exclusive lock until rclone exits. Releasing it earlier lets
        # another process remount/open the volume between the check and shutdown.
        yield
    finally:
        if locked:kernel.DeviceIoControl(handle,0x9001C,None,0,None,0,ctypes.byref(result),None)
        kernel.CloseHandle(handle)

def unmount(record,process):
    if not process_matches(record.get("process")):raise PlatformMountError("The filesystem process identity changed; it was retained.")
    actual=mounted(record)
    if actual is None:raise PlatformMountError("The mounted volume identity is uncertain; it was retained for review.")
    if actual:
        if sys.platform=="win32":
            with _windows_dismount(record):
                if process.poll() is None:_quit(process)
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:raise PlatformMountError("The locked filesystem process did not finish normal shutdown; the session was retained.") from None
        else:
            helper=trusted_binary(record["tools"]["unmount"])
            result=subprocess.run([helper,"-u",record["mountPath"]],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15)
            if result.returncode:raise PlatformMountError("The drive is in use. Close files and file-manager windows, then retry. No forced unmount was attempted.")
    if process.poll() is None:
        try:process.wait(timeout=2)
        except subprocess.TimeoutExpired:_quit(process)
    try:process.wait(timeout=10)
    except subprocess.TimeoutExpired:raise PlatformMountError("The filesystem process is still active and was retained.") from None
