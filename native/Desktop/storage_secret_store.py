"""OS-protected GenDragoon storage-secret persistence for Windows/Linux.

The account-bound keymap remains in GenDragoon's private local data directory.
Only the 32-byte storage secret is stored here. Windows uses current-user DPAPI;
Linux uses Secret Service and refuses plaintext persistence.
"""
import ctypes
import ctypes.wintypes
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

RECEIVER=re.compile(r"^[a-f0-9]{64}$")
SECRET=re.compile(r"^[A-Za-z0-9_-]{43}$")
LINUX_ATTRS=("redxai-app","gendragoon","purpose","storage-secret")

class StorageSecretError(RuntimeError):pass

def _check(receiver,secret=None):
    if not isinstance(receiver,str) or not RECEIVER.fullmatch(receiver):
        raise StorageSecretError("Invalid GenDragoon account identity.")
    if secret is not None and (not isinstance(secret,str) or not SECRET.fullmatch(secret)):
        raise StorageSecretError("Invalid GenDragoon storage secret.")

if sys.platform=="win32":
    class DATA_BLOB(ctypes.Structure):
        _fields_=[("cbData",ctypes.wintypes.DWORD),("pbData",ctypes.POINTER(ctypes.c_ubyte))]
    _crypt=ctypes.WinDLL("crypt32",use_last_error=True)
    _kernel=ctypes.WinDLL("kernel32",use_last_error=True)
    _crypt.CryptProtectData.argtypes=[ctypes.POINTER(DATA_BLOB),ctypes.wintypes.LPCWSTR,ctypes.POINTER(DATA_BLOB),ctypes.c_void_p,ctypes.c_void_p,ctypes.wintypes.DWORD,ctypes.POINTER(DATA_BLOB)]
    _crypt.CryptProtectData.restype=ctypes.wintypes.BOOL
    _crypt.CryptUnprotectData.argtypes=[ctypes.POINTER(DATA_BLOB),ctypes.POINTER(ctypes.wintypes.LPWSTR),ctypes.POINTER(DATA_BLOB),ctypes.c_void_p,ctypes.c_void_p,ctypes.wintypes.DWORD,ctypes.POINTER(DATA_BLOB)]
    _crypt.CryptUnprotectData.restype=ctypes.wintypes.BOOL
    _kernel.LocalFree.argtypes=[ctypes.c_void_p];_kernel.LocalFree.restype=ctypes.c_void_p

    def _root():
        base=os.environ.get("LOCALAPPDATA")
        if not base:raise StorageSecretError("Windows local application data is unavailable.")
        return Path(base)/"GenDragoon"/"MachineNotes"/"SecureVault"

    def _path(receiver):
        _check(receiver);return _root()/(receiver+".dpapi")

    def _blob(data):
        buf=(ctypes.c_ubyte*len(data)).from_buffer_copy(data)
        return DATA_BLOB(len(data),buf),buf

    def _protect(data):
        source,_=_blob(data);output=DATA_BLOB()
        if not _crypt.CryptProtectData(ctypes.byref(source),"GenDragoon storage secret",None,None,None,0x01,ctypes.byref(output)):
            raise StorageSecretError("Windows could not protect the GenDragoon storage secret.")
        try:return ctypes.string_at(output.pbData,output.cbData)
        finally:_kernel.LocalFree(output.pbData)

    def _unprotect(data):
        source,_=_blob(data);output=DATA_BLOB();description=ctypes.wintypes.LPWSTR()
        if not _crypt.CryptUnprotectData(ctypes.byref(source),ctypes.byref(description),None,None,None,0x01,ctypes.byref(output)):
            raise StorageSecretError("Windows could not unlock the GenDragoon storage secret.")
        try:return ctypes.string_at(output.pbData,output.cbData)
        finally:
            if description:_kernel.LocalFree(description)
            _kernel.LocalFree(output.pbData)

    def save(receiver,secret):
        _check(receiver,secret);path=_path(receiver);path.parent.mkdir(parents=True,exist_ok=True)
        try:path.parent.chmod(0o700)
        except OSError:pass
        temporary=path.with_name("."+path.name+".tmp")
        with open(temporary,"xb") as out:
            out.write(_protect(secret.encode("ascii")));out.flush();os.fsync(out.fileno())
        os.replace(temporary,path)
        return True

    def load(receiver):
        path=_path(receiver)
        if not path.is_file() or path.is_symlink():return None
        try:
            if path.stat().st_size>16384:return None
            value=_unprotect(path.read_bytes()).decode("ascii")
        except (OSError,UnicodeError,StorageSecretError):return None
        return value if SECRET.fullmatch(value) else None

    def clear(receiver):
        path=_path(receiver)
        try:
            if path.is_symlink():raise StorageSecretError("Storage-secret path needs review.")
            path.unlink()
        except FileNotFoundError:pass

    def available():return True

elif sys.platform.startswith("linux"):
    def _tool():return shutil.which("secret-tool")
    def _args(receiver):
        _check(receiver);return [*LINUX_ATTRS,"receiver",receiver]

    def save(receiver,secret):
        _check(receiver,secret);tool=_tool()
        if not tool:raise StorageSecretError("Linux Secret Service is unavailable.")
        result=subprocess.run([tool,"store","--label=GenDragoon storage secret",*_args(receiver)],
            input=secret+"\n",text=True,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
        if result.returncode:raise StorageSecretError("Linux Secret Service could not save the GenDragoon storage secret.")
        return True

    def load(receiver):
        tool=_tool()
        if not tool:return None
        result=subprocess.run([tool,"lookup",*_args(receiver)],capture_output=True,text=True,timeout=20)
        value=result.stdout.strip() if result.returncode==0 else ""
        return value if SECRET.fullmatch(value) else None

    def clear(receiver):
        tool=_tool()
        if tool:subprocess.run([tool,"clear",*_args(receiver)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)

    def available():return bool(_tool())
else:
    def save(receiver,secret):raise StorageSecretError("Secure storage is unavailable on this platform.")
    def load(receiver):return None
    def clear(receiver):return None
    def available():return False
