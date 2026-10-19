"""Encryption formats (sdk/spec/FORMATS.md): AES-256-GCM with keys derived by HKDF-SHA256 from a 32-byte master
key; the master key is stored only wrapped under a passphrase (scrypt or argon2id) in the key envelope."""
from __future__ import annotations

import base64
import hashlib
import hmac
import os
from typing import Callable, Optional

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from .errors import CorruptError, LockedError, WrongPassphraseError

KEY_BYTES = 32
NONCE_BYTES = 12
INFO = "gendragoon-sdk/v1/"
DEFAULT_SCRYPT = {"alg": "scrypt", "N": 1 << 15, "r": 8, "p": 1}
CHUNK_MAGIC, MANIFEST_MAGIC, PLAIN_MANIFEST = b"GDC1", b"GDM1", b"GDM0"


def b64u(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def from_b64u(s: str) -> bytes:
    if not isinstance(s, str) or "=" in s or any(c in s for c in "+/"):
        raise ValueError("not base64url")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def hkdf(ikm: bytes, salt: Optional[bytes], info: str) -> bytes:
    return HKDF(algorithm=hashes.SHA256(), length=32, salt=salt, info=info.encode()).derive(ikm)


def sub_key(ikm: bytes, purpose: str) -> bytes:
    """HKDF-SHA256(ikm, no salt, info = "gendragoon-sdk/v1/" + purpose), 32 bytes."""
    return hkdf(ikm, None, INFO + purpose)


def hmac_sha256(key: bytes, data: bytes) -> bytes:
    return hmac.new(key, data, hashlib.sha256).digest()


def gcm_seal(key: bytes, nonce: bytes, plaintext: bytes, aad: Optional[bytes] = None) -> bytes:
    return AESGCM(key).encrypt(nonce, plaintext, aad)


def gcm_open(key: bytes, nonce: bytes, ciphertext: bytes, aad: Optional[bytes] = None) -> Optional[bytes]:
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, aad)
    except (InvalidTag, ValueError):
        return None


# ---- key envelope ----------------------------------------------------------------------------------------

def validate_envelope(env: object) -> dict:
    bad = ValueError("gendragoon: key envelope is not valid")
    if not isinstance(env, dict) or not isinstance(env.get("version"), int) or env["version"] < 1:
        raise bad
    k = env.get("kdf") or {}
    if k.get("alg") == "scrypt":
        n = k.get("N")
        if not isinstance(n, int) or n < 1 << 14 or n > 1 << 20 or n & (n - 1) or k.get("r") != 8 or not 1 <= (k.get("p") or 0) <= 4:
            raise bad
    elif k.get("alg") == "argon2id":
        if not (19456 <= (k.get("memoryKiB") or 0) <= 1048576 and 1 <= (k.get("iterations") or 0) <= 10 and 1 <= (k.get("parallelism") or 0) <= 4):
            raise bad
    else:
        raise bad
    try:
        salt, iv, wk = from_b64u(env["salt"]), from_b64u(env["iv"]), from_b64u(env["wrappedKey"])
    except (KeyError, ValueError):
        raise bad from None
    if not (16 <= len(salt) <= 64 and 12 <= len(iv) <= 32 and len(wk) >= 32):
        raise bad
    return env


def _derive_kek(passphrase: str, kdf: dict, salt: bytes) -> bytes:
    pw = passphrase.encode()
    if len(pw) < 8:
        raise ValueError("gendragoon: recovery passphrase must be at least 8 characters")
    if kdf["alg"] == "scrypt":
        n, r, p = kdf["N"], kdf["r"], kdf["p"]
        return hashlib.scrypt(pw, salt=salt, n=n, r=r, p=p, dklen=KEY_BYTES, maxmem=256 * n * r + (1 << 20))
    try:
        from cryptography.hazmat.primitives.kdf.argon2 import Argon2id
    except ImportError:  # cryptography < 44
        raise RuntimeError("gendragoon: argon2id envelopes need cryptography 44 or newer") from None
    return Argon2id(salt=salt, length=KEY_BYTES, iterations=kdf["iterations"], lanes=kdf["parallelism"],
                    memory_cost=kdf["memoryKiB"]).derive(pw)


def wrap_master_key(mk: bytes, passphrase: str, kdf: dict = DEFAULT_SCRYPT, version: int = 1,
                    rnd: Callable[[int], bytes] = os.urandom) -> dict:
    if len(mk) != KEY_BYTES:
        raise ValueError("gendragoon: master key must be 32 bytes")
    salt, iv = rnd(16), rnd(NONCE_BYTES)
    kek = _derive_kek(passphrase, kdf, salt)
    env = {"version": version, "kdf": dict(kdf), "salt": b64u(salt), "iv": b64u(iv), "wrappedKey": b64u(gcm_seal(kek, iv, mk))}
    return validate_envelope(env)


def unwrap_master_key(env: dict, passphrase: str) -> bytes:
    validate_envelope(env)
    kek = _derive_kek(passphrase, env["kdf"], from_b64u(env["salt"]))
    mk = gcm_open(kek, from_b64u(env["iv"]), from_b64u(env["wrappedKey"]))
    if mk is None or len(mk) != KEY_BYTES:
        raise WrongPassphraseError()
    return mk


# ---- sealed objects --------------------------------------------------------------------------------------

def seal_chunk(file_key: bytes, plaintext: bytes, nonce: Optional[bytes] = None) -> tuple[str, bytes]:
    """Encrypts one chunk; returns (blob id, stored bytes). The id is an HMAC of the plaintext under the file's id key."""
    nonce = nonce or os.urandom(NONCE_BYTES)
    raw_id = hmac_sha256(sub_key(file_key, "chunk-id"), plaintext)
    ct = gcm_seal(sub_key(file_key, "chunk-enc"), nonce, plaintext, CHUNK_MAGIC + raw_id)
    return raw_id.hex(), CHUNK_MAGIC + nonce + ct


def open_chunk(file_key: bytes, blob_id: str, blob: bytes) -> bytes:
    try:
        raw_id = bytes.fromhex(blob_id)
    except ValueError:
        raise CorruptError() from None
    if len(raw_id) != 32 or len(blob) < 4 + NONCE_BYTES + 16 or blob[:4] != CHUNK_MAGIC:
        raise CorruptError()
    pt = gcm_open(sub_key(file_key, "chunk-enc"), blob[4:16], blob[16:], CHUNK_MAGIC + raw_id)
    if pt is None or not hmac.compare_digest(hmac_sha256(sub_key(file_key, "chunk-id"), pt), raw_id):
        raise CorruptError()
    return pt


def drive_manifest_key(mk: Optional[bytes], name: str) -> str:
    if mk is None:
        return hashlib.sha256((INFO + "drive:" + name).encode()).hexdigest()
    return hmac_sha256(sub_key(mk, "manifest-name"), ("drive:" + name).encode()).hex()


def seal_manifest(mk: Optional[bytes], key: str, plaintext: bytes, nonce: Optional[bytes] = None) -> bytes:
    if mk is None:
        return PLAIN_MANIFEST + plaintext
    nonce = nonce or os.urandom(NONCE_BYTES)
    return MANIFEST_MAGIC + nonce + gcm_seal(sub_key(mk, "manifest-enc"), nonce, plaintext, MANIFEST_MAGIC + bytes.fromhex(key))


def open_manifest(mk: Optional[bytes], key: str, data: bytes) -> bytes:
    if data[:4] == PLAIN_MANIFEST:
        return data[4:]
    if len(data) < 4 + NONCE_BYTES + 16 or data[:4] != MANIFEST_MAGIC:
        raise CorruptError()
    if mk is None:
        raise LockedError()
    pt = gcm_open(sub_key(mk, "manifest-enc"), data[4:16], data[16:], MANIFEST_MAGIC + bytes.fromhex(key))
    if pt is None:
        raise CorruptError()
    return pt
