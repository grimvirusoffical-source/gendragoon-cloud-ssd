"""Secure trusted Quick Login refresh storage for Windows/Linux GenDragoon.

Windows uses current-user DPAPI. Linux uses the desktop Secret Service through
secret-tool. No plaintext refresh token is written to disk. Metadata contains
only non-secret account/trust information needed to locate and validate the
saved session.
"""
import base64
import ctypes
import ctypes.wintypes
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

REFRESH=re.compile(r"rxcr_[A-Za-z0-9_-]{43}\Z")
SUBJECT=re.compile(r"[^\x00-\x20]{1,200}\Z")
TARGET="Red-XAI/GenDragoon/QuickLogin"
LINUX_ATTRS=("redxai-app","gendragoon","purpose","quick-login")

class QuickLoginStoreError(RuntimeError):pass

def _root():
    if sys.platform=="win32":
        base=os.environ.get("LOCALAPPDATA")
        if not base:raise QuickLoginStoreError("Windows local application data is unavailable.")
        return Path(base)/"Red-XAI"/"QuickLogin"
    base=os.environ.get("XDG_STATE_HOME")
    return Path(base) if base else Path.home()/".local"/"state"/"red-xai"

def _metadata_path():return _root()/"gendragoon.json"

def _metadata(value):
    subject=value.get("subject")
    if not isinstance(subject,str) or not SUBJECT.fullmatch(subject):
        raise QuickLoginStoreError("The trusted account identity is invalid.")
    return {
        "schema":1,
        "subject":subject,
        "email":value.get("email") if isinstance(value.get("email"),str) and len(value["email"])<=254 else None,
        "trustMode":value.get("trustMode") if isinstance(value.get("trustMode"),str) and len(value["trustMode"])<=32 else None,
        "trustedUntilMs":value.get("trustedUntilMs") if isinstance(value.get("trustedUntilMs"),int) else None,
    }

def _write_metadata(value):
    path=_metadata_path();path.parent.mkdir(parents=True,exist_ok=True)
    try:path.parent.chmod(0o700)
    except OSError:pass
    raw=json.dumps(_metadata(value),separators=(",",":")).encode()
    temporary=path.with_name("."+path.name+".tmp")
    with open(temporary,"xb") as out:
        try:os.chmod(temporary,0o600)
        except OSError:pass
        out.write(raw);out.flush();os.fsync(out.fileno())
    os.replace(temporary,path)
    try:path.chmod(0o600)
    except OSError:pass

def _read_metadata():
    path=_metadata_path()
    if not path.is_file():return None
    try:
        if path.is_symlink() or path.stat().st_size>8192:return None
        value=json.loads(path.read_text(encoding="utf-8"))
    except (OSError,ValueError,UnicodeError):return None
    try:return _metadata(value)
    except QuickLoginStoreError:return None

def _remove_metadata():
    path=_metadata_path()
    try:
        if path.is_symlink():raise QuickLoginStoreError("Trusted-session metadata path needs review.")
        path.unlink()
    except FileNotFoundError:pass

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

    def _blob(data):
        buf=(ctypes.c_ubyte*len(data)).from_buffer_copy(data)
        return DATA_BLOB(len(data),buf),buf

    def _protect(data):
        source,_=_blob(data);output=DATA_BLOB()
        if not _crypt.CryptProtectData(ctypes.byref(source),"Red-XAI GenDragoon Quick Login",None,None,None,0x01,ctypes.byref(output)):
            raise QuickLoginStoreError("Windows could not protect the trusted session.")
        try:return ctypes.string_at(output.pbData,output.cbData)
        finally:_kernel.LocalFree(output.pbData)

    def _unprotect(data):
        source,_=_blob(data);output=DATA_BLOB();description=ctypes.wintypes.LPWSTR()
        if not _crypt.CryptUnprotectData(ctypes.byref(source),ctypes.byref(description),None,None,None,0x01,ctypes.byref(output)):
            raise QuickLoginStoreError("Windows could not unlock the trusted session.")
        try:return ctypes.string_at(output.pbData,output.cbData)
        finally:
            if description:_kernel.LocalFree(description)
            _kernel.LocalFree(output.pbData)

    def _secret_path():return _root()/"gendragoon.dpapi"

    def _save_secret(refresh):
        path=_secret_path();path.parent.mkdir(parents=True,exist_ok=True)
        temporary=path.with_name("."+path.name+".tmp")
        protected=_protect(refresh.encode("ascii"))
        with open(temporary,"xb") as out:
            out.write(protected);out.flush();os.fsync(out.fileno())
        os.replace(temporary,path)

    def _load_secret():
        path=_secret_path()
        if not path.is_file() or path.is_symlink():return None
        try:
            if path.stat().st_size>16384:return None
            value=_unprotect(path.read_bytes()).decode("ascii")
        except (OSError,UnicodeError,QuickLoginStoreError):return None
        return value if REFRESH.fullmatch(value) else None

    def _clear_secret():
        path=_secret_path()
        try:
            if path.is_symlink():raise QuickLoginStoreError("Trusted-session credential path needs review.")
            path.unlink()
        except FileNotFoundError:pass
else:
    def _secret_tool():
        return shutil.which("secret-tool") if sys.platform.startswith("linux") else None

    def _save_secret(refresh):
        executable=_secret_tool()
        if not executable:raise QuickLoginStoreError("Linux Secret Service is unavailable.")
        command=[executable,"store","--label=Red-XAI GenDragoon",*LINUX_ATTRS]
        result=subprocess.run(command,input=refresh+"\n",text=True,stdin=subprocess.PIPE,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
        if result.returncode:raise QuickLoginStoreError("Linux Secret Service could not save the trusted session.")

    def _load_secret():
        executable=_secret_tool()
        if not executable:return None
        result=subprocess.run([executable,"lookup",*LINUX_ATTRS],capture_output=True,text=True,timeout=20)
        value=result.stdout.strip() if result.returncode==0 else ""
        return value if REFRESH.fullmatch(value) else None

    def _clear_secret():
        executable=_secret_tool()
        if executable:
            subprocess.run([executable,"clear",*LINUX_ATTRS],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)

def persistence_available():
    return sys.platform=="win32" or sys.platform.startswith("linux") and bool(_secret_tool())

def save(refresh,subject,email=None,trust_mode=None,trusted_until_ms=None):
    if not isinstance(refresh,str) or not REFRESH.fullmatch(refresh):
        raise QuickLoginStoreError("The trusted refresh credential is invalid.")
    value={"subject":subject,"email":email,"trustMode":trust_mode,"trustedUntilMs":trusted_until_ms}
    _metadata(value)
    _save_secret(refresh)
    try:_write_metadata(value)
    except Exception:
        try:_clear_secret()
        finally:raise
    return True

def load():
    meta=_read_metadata()
    if not meta:return None
    secret=_load_secret()
    if not secret:return None
    return {**meta,"refresh":secret}

def clear():
    try:_clear_secret()
    finally:_remove_metadata()
