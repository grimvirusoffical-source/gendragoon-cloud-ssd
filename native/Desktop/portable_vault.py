"""Portable storage vault v1, shared with the Mac CryptoKit and Android JCE clients.

Only encrypted storage keys are persisted. Account credentials never enter this format.
"""
import base64
import hashlib
import json
import os
import re
from pathlib import Path
import stat
import private_fs as private

SCHEMA = "gendragoon.portable-vault/v1"
PAYLOAD = "gendragoon.vault-keys/v1"
ENVELOPE_LIMIT = 16 * 1024 * 1024
PAYLOAD_LIMIT = 12 * 1024 * 1024
KEYMAP_LIMIT = 8 * 1024 * 1024

class VaultError(ValueError):
    pass

def encoded(value):
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")

def decoded(value, limit):
    if not isinstance(value,str) or not re.fullmatch(r"[A-Za-z0-9_-]+",value) or len(value)>(limit*4+2)//3:
        raise VaultError("The portable vault failed validation.")
    try:data=base64.urlsafe_b64decode(value+"="*(-len(value)%4))
    except Exception:raise VaultError("The portable vault failed validation.") from None
    if len(data)>limit or encoded(data)!=value:raise VaultError("The portable vault failed validation.")
    return data

def validate_keymap(data):
    if (not isinstance(data,bytes) or len(data)<11 or data[:4]!=b"KXAI"
            or len(data)!={1:75,2:87,3:95}.get(data[4])):
        raise VaultError("The keymap is unsupported or bound to another device.")
    t,p,m=data[5],data[6],int.from_bytes(data[7:11],"big")
    if not (1<=t<=10 and 1<=p<=16 and 8*p<=m<=256*1024):
        raise VaultError("The portable keymap exceeds the supported memory or time cost.")

def _password(value):
    if not isinstance(value,str) or len(value)<12 or len(value.encode("utf8"))>1024:
        raise VaultError("Use a passphrase with at least 12 characters and at most 1024 UTF-8 bytes.")
    return value.encode("utf8")

def _keys(value,receiver):
    if (not isinstance(value,dict) or set(value)!={"schema","receiverId","storageSecret","keymap"}
            or value["schema"]!=PAYLOAD or value["receiverId"]!=receiver
            or not isinstance(value["storageSecret"],str) or not re.fullmatch(r"[A-Za-z0-9_-]{32,128}",value["storageSecret"])):
        raise VaultError("The portable vault keys failed validation.")
    data=decoded(value["keymap"],KEYMAP_LIMIT);validate_keymap(data)
    return dict(receiverId=receiver,storageSecret=value["storageSecret"],keymap=data)

def _aes():
    try:from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    except ImportError:raise VaultError("Install the GenDragoon desktop runtime dependencies before importing a vault.") from None
    return AESGCM

def open_vault(envelope,password,receiver):
    if not isinstance(envelope,bytes) or len(envelope)>ENVELOPE_LIMIT or not re.fullmatch(r"[a-f0-9]{64}",receiver or ""):
        raise VaultError("The portable vault is invalid or too large.")
    try:value=json.loads(envelope)
    except Exception:raise VaultError("The portable vault is invalid.") from None
    if (not isinstance(value,dict) or set(value)!={"schema","receiverId","kdf","cipher","ciphertext"}
            or value["schema"]!=SCHEMA or value["receiverId"]!=receiver):
        raise VaultError("Connect the same account that exported this portable vault.")
    kdf,cipher=value["kdf"],value["cipher"]
    if (not isinstance(kdf,dict) or set(kdf)!={"name","iterations","salt"} or kdf["name"]!="PBKDF2-HMAC-SHA256"
            or type(kdf["iterations"]) is not int or kdf["iterations"]!=600000
            or not isinstance(cipher,dict) or set(cipher)!={"name","nonce"} or cipher["name"]!="AES-256-GCM"):
        raise VaultError("The portable vault encryption format is unsupported.")
    salt,nonce,encrypted=decoded(kdf["salt"],16),decoded(cipher["nonce"],12),decoded(value["ciphertext"],PAYLOAD_LIMIT+16)
    if len(salt)!=16 or len(nonce)!=12 or len(encrypted)<=16:raise VaultError("The portable vault failed validation.")
    key=hashlib.pbkdf2_hmac("sha256",_password(password),salt,600000,32)
    try:raw=_aes()(key).decrypt(nonce,encrypted,(SCHEMA+"\0"+receiver).encode("utf8"))
    except VaultError:raise
    except Exception:raise VaultError("The passphrase is incorrect or the portable vault was changed.") from None
    if len(raw)>PAYLOAD_LIMIT:raise VaultError("The portable vault payload is too large.")
    try:return _keys(json.loads(raw),receiver)
    except VaultError:raise
    except Exception:raise VaultError("The portable vault keys failed validation.") from None

def seal_vault(keys,password,*,salt=None,nonce=None):
    receiver=keys.get("receiverId")
    if not re.fullmatch(r"[a-f0-9]{64}",receiver or ""):raise VaultError("Invalid vault account.")
    value={"schema":PAYLOAD,"receiverId":receiver,"storageSecret":keys.get("storageSecret"),"keymap":encoded(keys["keymap"])}
    _keys(value,receiver)
    salt=os.urandom(16) if salt is None else salt;nonce=os.urandom(12) if nonce is None else nonce
    if len(salt)!=16 or len(nonce)!=12:raise VaultError("Invalid vault entropy.")
    raw=json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(",",":")).encode("utf8")
    key=hashlib.pbkdf2_hmac("sha256",_password(password),salt,600000,32)
    encrypted=_aes()(key).encrypt(nonce,raw,(SCHEMA+"\0"+receiver).encode("utf8"))
    return json.dumps({"schema":SCHEMA,"receiverId":receiver,"kdf":{"name":"PBKDF2-HMAC-SHA256","iterations":600000,"salt":encoded(salt)},
        "cipher":{"name":"AES-256-GCM","nonce":encoded(nonce)},"ciphertext":encoded(encrypted)},sort_keys=True,separators=(",",":")).encode("utf8")

def install_keymap(keys,directory,rsx):
    """Persist only encrypted KXAI bytes, never replace a different keymap."""
    data=keys["keymap"];validate_keymap(data)
    directory=Path(directory).absolute()
    private.private_directory(directory)
    if directory.is_symlink() or directory.resolve()!=directory:
        raise VaultError("The private key directory is linked.")
    if os.name!="nt" and directory.stat().st_mode&0o077:
        raise VaultError("The private key directory permissions are unsafe.")
    path=directory/(keys["receiverId"]+".keymap")
    created=False
    try:
        fd=private.create_file(path)
        created=True
        with os.fdopen(fd,"wb") as out:out.write(data);out.flush();os.fsync(out.fileno())
    except FileExistsError:
        private.verify(path)
        info=path.lstat()
        if (not stat.S_ISREG(info.st_mode) or path.is_symlink() or info.st_nlink!=1
                or os.name!="nt" and (info.st_uid!=os.getuid() or info.st_mode&0o077) or path.read_bytes()!=data):
            raise VaultError("This device already has a different or unsafe keymap. It will not be replaced.") from None
    try:
        with rsx.session_open_readonly(keys["storageSecret"],str(path))[0]:pass
        if path.read_bytes()!=data:raise VaultError("The keymap changed during validation.")
        private.verify(path)
        return path
    except Exception:
        if created and path.is_file() and not path.is_symlink() and path.read_bytes()==data:path.unlink()
        raise VaultError("The encrypted keymap could not be unlocked. Existing keys were preserved.") from None
