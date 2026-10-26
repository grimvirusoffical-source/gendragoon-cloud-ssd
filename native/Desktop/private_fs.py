"""GenDragoon-owned private filesystem leaves, including explicit Windows SID ACLs."""
from contextlib import contextmanager
import os
from pathlib import Path
import shutil
import stat
import threading
import uuid

_directory_lock=threading.RLock()

def _windows():
    from gendragoon_platform_ipc import modules, user_sid, secure_file, verify_private, security_attributes
    return modules(),user_sid,secure_file,verify_private,security_attributes

def _attributes(directory=False):
    modules,sid,*_= _windows()
    types,*_,security=modules
    owner=security.ConvertSidToStringSid(sid())
    descriptor=security.ConvertStringSecurityDescriptorToSecurityDescriptor(
        "O:"+owner+"D:P(A;"+("OICI" if directory else "")+";GA;;;"+owner+")",1)
    attributes=types.SECURITY_ATTRIBUTES();attributes.SECURITY_DESCRIPTOR=descriptor
    return attributes

def private_directory(path):
    # ACL normalization changes the descriptor size. Keep its owner check,
    # update and verification together so another worker cannot race the
    # two-call GetFileSecurity buffer allocation inside pywin32.
    with _directory_lock:return _private_directory(path)

def _private_directory(path):
    path=Path(path).absolute()
    if path.is_symlink() or path.exists() and getattr(path.lstat(),"st_file_attributes",0)&0x400:
        raise ValueError("A private GenDragoon directory cannot be linked.")
    if not path.exists():
        if not path.parent.exists():private_directory(path.parent)
        if os.name=="nt":
            modules,*_= _windows();file=modules[4]
            try:file.CreateDirectory(str(path),_attributes(True))
            except Exception as error:
                if getattr(error,"winerror",error.args[0] if error.args else None) not in (80,183):raise
        else:path.mkdir(mode=0o700,exist_ok=True)
    if not path.is_dir():raise ValueError("The private GenDragoon directory has an invalid type.")
    if os.name=="nt":
        modules,sid,secure,verify,_=_windows();security=modules[-1]
        # Existing leaves must already belong to this exact user. Do not take
        # ownership of another account's files or weaken the shared verifier.
        secure(path)
        descriptor=_attributes(True).SECURITY_DESCRIPTOR
        security.SetNamedSecurityInfo(str(path),security.SE_FILE_OBJECT,
            security.DACL_SECURITY_INFORMATION|security.PROTECTED_DACL_SECURITY_INFORMATION,
            None,None,descriptor.GetSecurityDescriptorDacl(),None)
        verify(path)
    else:
        info=path.stat()
        if info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError("The GenDragoon directory is not private to this user.")
    return path

def create_file(path):
    path=Path(path)
    if os.name=="nt":
        import msvcrt
        modules,*_= _windows();_,_,con,_,file,_,_=modules
        try:
            handle=file.CreateFile(str(path),con.GENERIC_READ|con.GENERIC_WRITE,con.FILE_SHARE_READ|con.FILE_SHARE_WRITE,
                _attributes(),con.CREATE_NEW,con.FILE_ATTRIBUTE_NORMAL,None)
        except Exception as error:
            if getattr(error,"winerror",error.args[0] if error.args else None) in (80,183):raise FileExistsError(str(path)) from None
            raise
        return msvcrt.open_osfhandle(handle.Detach(),os.O_RDWR|os.O_BINARY)
    return os.open(path,os.O_RDWR|os.O_CREAT|os.O_EXCL|getattr(os,"O_NOFOLLOW",0),0o600)

def verify(path):
    path=Path(path);info=path.lstat()
    if path.is_symlink() or getattr(info,"st_file_attributes",0)&0x400 or not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
        raise ValueError("A private GenDragoon path is linked or has an invalid type.")
    if os.name=="nt":_windows()[3](path)
    elif info.st_uid!=os.getuid() or info.st_mode&0o077:raise ValueError("A GenDragoon path is not private to this user.")
    return info

def write_private(path,data,replace=False):
    path=Path(path);private_directory(path.parent)
    temporary=path.with_name(".private-"+uuid.uuid4().hex) if replace else path
    fd=create_file(temporary)
    try:
        with os.fdopen(fd,"wb") as output:output.write(data);output.flush();os.fsync(output.fileno())
        verify(temporary)
        if replace:
            if path.exists() or path.is_symlink():verify(path)
            os.replace(temporary,path)
    finally:
        if replace:temporary.unlink(missing_ok=True)

def protect_generated_tree(root):
    """For a freshly created, private restore/scratch root owned by this process.

    C++/ZIP APIs create child files without SECURITY_ATTRIBUTES. Their inherited
    ACL is already private; normalize their owner before retaining/publishing.
    Existing user-selected originals and destination parents never enter here.
    """
    root=Path(root);verify(root)
    for path in (root,*root.rglob("*")):
        info=path.lstat()
        if path.is_symlink() or getattr(info,"st_file_attributes",0)&0x400:raise ValueError("Generated restore content contains a linked path.")
        if os.name=="nt":
            modules,sid,_,check,_=_windows();security=modules[-1];descriptor=_attributes(path.is_dir()).SECURITY_DESCRIPTOR
            security.SetNamedSecurityInfo(str(path),security.SE_FILE_OBJECT,
                security.OWNER_SECURITY_INFORMATION|security.DACL_SECURITY_INFORMATION|security.PROTECTED_DACL_SECURITY_INFORMATION,
                sid(),None,descriptor.GetSecurityDescriptorDacl(),None)
            check(path)
        else:path.chmod(0o700 if path.is_dir() else 0o600|(info.st_mode&0o100))

@contextmanager
def temporary_directory(parent,prefix="scratch-"):
    parent=private_directory(parent)
    path=private_directory(parent/(prefix+uuid.uuid4().hex));identity=path.stat()
    try:yield str(path)
    finally:
        if path.exists() and not path.is_symlink() and (path.stat().st_dev,path.stat().st_ino)==(identity.st_dev,identity.st_ino):shutil.rmtree(path)
