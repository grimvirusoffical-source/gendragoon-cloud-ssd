#!/usr/bin/env python3
"""Client-reported catalog origin and artifact-OS hints, never launch authority.

Device identifiers are random, private and scoped to one account installation.
They do not contain hostnames, hardware identifiers, usernames or source paths.
This metadata stays outside the immutable encrypted archive manifest.
"""
import json
import os
from pathlib import Path
import platform
import re
import secrets
import stat
import sys
import time

PLATFORMS=frozenset(("macos","windows","linux","android","ios","unknown"))
ARCHITECTURES=frozenset(("arm64","x86_64","x86","arm","unknown"))
APPLICATION_PLATFORMS=PLATFORMS-{"unknown"}
_HEX32=re.compile(r"[a-f0-9]{32}")
_RECEIVER=re.compile(r"[a-f0-9]{64}")

def validate_origin(value):
    if value is None:return None
    if (not isinstance(value,dict) or set(value)!={"schema","platform","architecture","deviceId"}
            or type(value.get("schema")) is not int or value["schema"]!=1
            or not isinstance(value.get("platform"),str) or value["platform"] not in PLATFORMS
            or not isinstance(value.get("architecture"),str) or value["architecture"] not in ARCHITECTURES
            or not isinstance(value.get("deviceId"),str) or not _HEX32.fullmatch(value["deviceId"])):
        raise ValueError("Invalid catalog device origin.")
    return {key:value[key] for key in ("schema","platform","architecture","deviceId")}

def current_platform():
    return {"darwin":"macos","win32":"windows","linux":"linux","android":"android","ios":"ios"}.get(sys.platform,"unknown")

def application_platform(name,kind,declared=None):
    """Extension/kind hints for backup grouping, not proof of binary format."""
    validate_application_platform(declared)
    if kind not in ("app","file"):return None
    inferred=None
    if kind in ("app","file") and isinstance(name,str):
        suffix=Path(name).suffix.lower()
        if suffix in (".exe",".msi",".msix",".appx",".msixbundle",".appxbundle"):inferred="windows"
        elif suffix in (".appimage",".deb",".rpm"):inferred="linux"
        elif suffix==".apk":inferred="android"
        elif suffix==".ipa":inferred="ios"
        elif kind=="app":inferred="macos"
    if inferred is not None and declared is not None and inferred!=declared:
        raise ValueError("Application platform metadata conflicts with the archived artifact name.")
    return inferred or declared

def validate_application_platform(value):
    if value is not None and (not isinstance(value,str) or value not in APPLICATION_PLATFORMS):
        raise ValueError("Invalid catalog application platform.")
    return value

def ensure_restore_compatible(item,*,platform_name=None):
    target=application_platform(item.get("name"),item.get("kind"),item.get("applicationPlatform"))
    if target is not None and target!=(platform_name or current_platform()):
        raise ValueError("This "+target+" application or installer backup requires a matching platform for restoration. Exporting its encrypted backup archive is not available here.")
    return target

def _verify(path,directory=False):
    info=path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info,"st_file_attributes",0)&0x400:
        raise ValueError("Device origin storage cannot use linked paths.")
    if directory and not stat.S_ISDIR(info.st_mode) or not directory and not stat.S_ISREG(info.st_mode):
        raise ValueError("Invalid device origin storage type.")
    if sys.platform=="win32":
        import gendragoon_platform_ipc as ipc
        ipc.verify_private(path)
    elif info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)&0o077:
        raise ValueError("Device origin storage must be private to this user.")
    if not directory and info.st_nlink!=1:raise ValueError("Device origin storage cannot share file links.")
    return info

def _directory(path):
    if not path.is_absolute():raise ValueError("Device origin storage requires an absolute private directory.")
    for ancestor in (path,*path.parents):
        if ancestor.exists() or ancestor.is_symlink():
            info=ancestor.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info,"st_file_attributes",0)&0x400:
                raise ValueError("Device origin storage cannot use linked paths.")
    if not path.exists():
        if not path.parent.exists():_directory(path.parent)
        try:
            if sys.platform=="win32":
                import gendragoon_platform_ipc as ipc
                ipc.create_private_directory(path)
            else:os.mkdir(path,0o700)
        except Exception:
            if not path.exists():raise
    _verify(path,directory=True)

def _read_device(path):
    # A concurrent creator publishes with a private hard link, then removes
    # its temporary name. Never read a still-shared inode or a partial file.
    if sys.platform!="win32":
        for _ in range(20):
            if path.lstat().st_nlink==1:break
            time.sleep(.005)
    info=_verify(path)
    if info.st_size>256:raise ValueError("Invalid device origin record.")
    fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
    with os.fdopen(fd,"rb") as source:
        opened=os.fstat(source.fileno())
        if (opened.st_dev,opened.st_ino)!=(info.st_dev,info.st_ino):raise ValueError("Device origin record changed.")
        value=json.loads(source.read(257))
    if (not isinstance(value,dict) or set(value)!={"schema","deviceId"} or type(value.get("schema")) is not int
            or value["schema"]!=1 or not isinstance(value.get("deviceId"),str) or not _HEX32.fullmatch(value["deviceId"])):
        raise ValueError("Invalid device origin record.")
    return value["deviceId"]

def current_origin(receiver_id,*,state_dir):
    if not isinstance(receiver_id,str) or not _RECEIVER.fullmatch(receiver_id):raise ValueError("A verified account is required for device origin.")
    directory=Path(state_dir);_directory(directory);path=directory/(receiver_id+".json")
    if not path.exists() and not path.is_symlink():
        temporary=directory/(".origin-"+secrets.token_hex(16))
        if sys.platform=="win32":
            import gendragoon_platform_ipc as ipc
            fd=ipc.create_private_file(temporary)
        else:fd=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)
        try:
            with os.fdopen(fd,"wb") as output:
                output.write(json.dumps({"schema":1,"deviceId":secrets.token_hex(16)},separators=(",",":")).encode("ascii"));output.flush();os.fsync(output.fileno())
            try:
                if sys.platform=="win32":os.rename(temporary,path)
                else:os.link(temporary,path,follow_symlinks=False)
            except FileExistsError:pass
        finally:temporary.unlink(missing_ok=True)
    device=_read_device(path)
    system=current_platform()
    machine=platform.machine().lower()
    architecture="arm64" if machine in ("arm64","aarch64") else "x86_64" if machine in ("x86_64","amd64") else "x86" if machine in ("x86","i386","i686") else "arm" if machine.startswith("arm") else "unknown"
    return validate_origin({"schema":1,"platform":system,"architecture":architecture,"deviceId":device})

if __name__=="__main__":
    import argparse
    argparse.ArgumentParser(description=__doc__).parse_args()
