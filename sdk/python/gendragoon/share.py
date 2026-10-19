"""Sharing one file with a recipient (ECDH P-256 + HKDF-SHA256 + AES-256-GCM, sdk/spec/FORMATS.md), and the
read-only keys a recipient uses to fetch the chunks."""
from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Optional

from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat

from .client import API_KEY_RE, Client
from .crypto import NONCE_BYTES, b64u, from_b64u, gcm_open, gcm_seal, hkdf
from .drive import Drive, read_entry
from .errors import APIError, CorruptError

PREFIX = "gdid1_"
ALG = "ECDH-P256+HKDF-SHA256+A256GCM"
AAD = b"gd-share-v1"


def _pub_bytes(pk: ec.EllipticCurvePublicKey) -> bytes:
    return pk.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)


class Identity:
    """A recipient key pair (P-256)."""

    def __init__(self, priv: ec.EllipticCurvePrivateKey):
        self._priv = priv
        self._pub = _pub_bytes(priv.public_key())

    def __repr__(self) -> str:
        return f"Identity({self.public!r})"

    @classmethod
    def create(cls, c: Client) -> "Identity":
        """Level L2, risk key (local)."""
        c.check("share.createIdentity")
        return cls(ec.generate_private_key(ec.SECP256R1()))

    @classmethod
    def from_private(cls, b: bytes) -> "Identity":
        """From private_bytes(): the 32-byte scalar followed by the 65-byte uncompressed public point."""
        if len(b) != 97:
            raise ValueError("gendragoon: identity must be 97 bytes")
        ident = cls(ec.derive_private_key(int.from_bytes(b[:32], "big"), ec.SECP256R1()))
        if ident._pub != b[32:]:
            raise ValueError("gendragoon: identity public key does not match")
        return ident

    def private_bytes(self) -> bytes:
        """Keep it secret."""
        return self._priv.private_numbers().private_value.to_bytes(32, "big") + self._pub

    @property
    def public(self) -> str:
        """The shareable recipient id."""
        return PREFIX + b64u(self._pub)

    def _shared(self, epk: bytes) -> bytes:
        return self._priv.exchange(ec.ECDH(), ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), epk))


def _tag(rpk: bytes) -> str:
    return b64u(hashlib.sha256(rpk).digest()[:8])


def _parse_recipient(rid: str) -> bytes:
    if not rid.startswith(PREFIX):
        raise ValueError("gendragoon: not a recipient id")
    raw = from_b64u(rid[len(PREFIX):])
    ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), raw)
    return raw


def seal_share(rpk: bytes, payload: bytes, eph: Optional[Identity] = None, nonce: Optional[bytes] = None) -> dict:
    eph = eph or Identity(ec.generate_private_key(ec.SECP256R1()))
    nonce = nonce or os.urandom(NONCE_BYTES)
    shared = eph._shared(rpk)
    key = hkdf(shared, eph._pub + rpk, "gendragoon-sdk/v1/share")
    return {"v": 1, "alg": ALG, "recipient": _tag(rpk), "epk": b64u(eph._pub), "nonce": b64u(nonce), "ct": b64u(gcm_seal(key, nonce, payload, AAD))}


def export_share(c: Client, d: Drive, path: str, recipient: str) -> dict:
    """Encrypts one file of an encrypted drive to a recipient. Level L3, risk sharing."""
    c.check("share.export")
    if not d.encrypted:
        raise ValueError("gendragoon: plain drives have nothing to share; give the reader access to the binding instead")
    rpk = _parse_recipient(recipient)
    e = d.load()[0]["files"].get(path)
    if e is None:
        raise APIError(404, "not_found")
    entry = {"size": e["size"], "mtime": e["mtime"], "sha256": e["sha256"], "chunks": e["chunks"], **({"key": e["key"]} if e.get("key") else {})}
    return seal_share(rpk, json.dumps({"v": 1, "path": path, "entry": entry}, separators=(",", ":")).encode())


def open_share_envelope(ident: Identity, s: dict) -> dict:
    """Decrypts a share with the recipient's identity (no network). Returns {"v", "path", "entry"}."""
    if s.get("v") != 1 or s.get("alg") != ALG:
        raise ValueError("gendragoon: unsupported share")
    if s.get("recipient") != _tag(ident._pub):
        raise ValueError("gendragoon: this share is addressed to someone else")
    try:
        epk, nonce, ct = from_b64u(s["epk"]), from_b64u(s["nonce"]), from_b64u(s["ct"])
        shared = ident._shared(epk)
    except (KeyError, ValueError):
        raise CorruptError() from None
    pt = gcm_open(hkdf(shared, epk + ident._pub, "gendragoon-sdk/v1/share"), nonce, ct, AAD)
    if pt is None:
        raise CorruptError()
    try:
        f = json.loads(pt)
    except ValueError:
        raise CorruptError() from None
    if not isinstance(f, dict) or f.get("v") != 1 or not isinstance(f.get("entry", {}).get("chunks"), list):
        raise CorruptError()
    return f


def open_share(c: Client, ident: Identity, s: dict) -> tuple[dict, bytes]:
    """Decrypts a share and downloads the file (read access to the sender's binding). Level L2, risk read."""
    c.check("share.open")
    f = open_share_envelope(ident, s)
    return f, read_entry(c, f["entry"])


def create_read_key(c: Client, label: str, ttl_days: int = 30) -> dict:
    """Mints a read-only key for this binding (1 to 90 days). It cannot write, mint keys or read the key envelope.
    Level L3, risk sharing."""
    k = c.request("share.createReadKey", "POST", "/keys", json.dumps({"label": label, "ttlDays": ttl_days}).encode(),
                  {"Content-Type": "application/json"}).json()
    if not API_KEY_RE.match(k.get("apiKey", "")):
        raise RuntimeError("gendragoon: unexpected key response")
    return k


def list_read_keys(c: Client) -> list[dict]:
    """This binding's read-only keys (never their secrets). Level L2, risk read."""
    return c.request("share.listReadKeys", "GET", "/keys").json()["keys"]


def revoke_read_key(c: Client, key_id: str) -> None:
    """Revokes a read-only key at once. Level L3, risk sharing."""
    if not re.fullmatch(r"[0-9a-f]{16}", key_id):
        raise ValueError("gendragoon: malformed key id")
    c.request("share.revokeReadKey", "DELETE", f"/keys/{key_id}")
