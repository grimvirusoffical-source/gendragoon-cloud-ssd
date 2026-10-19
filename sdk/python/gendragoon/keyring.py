"""The unlocked master key, held in memory. Python cannot reliably wipe memory; lock() drops the reference."""
from __future__ import annotations

import os
import threading
from typing import Optional

from .client import Client
from .crypto import DEFAULT_SCRYPT, KEY_BYTES, unwrap_master_key, wrap_master_key
from .errors import APIError, LockedError


class Keyring:
    def __init__(self, client: Client):
        self._c = client
        self._mk: Optional[bytes] = None
        self._lock = threading.Lock()

    def __repr__(self) -> str:
        return f"Keyring(unlocked={self.unlocked})"

    @property
    def unlocked(self) -> bool:
        return self._mk is not None

    def lock(self) -> None:
        with self._lock:
            self._mk = None

    def master(self) -> bytes:
        mk = self._mk
        if mk is None:
            raise LockedError()
        return mk

    def unlock(self, passphrase: str) -> None:
        """Reads the binding's key envelope and opens it. Level L2, risk key."""
        self._c.check("crypto.unlock")
        mk = unwrap_master_key(self._c.get_key_envelope(), passphrase)
        with self._lock:
            self._mk = mk

    def create(self, passphrase: str) -> None:
        """Generates a master key and stores its envelope (create-only). Level L3, risk key."""
        self._c.check("keyEnvelope.create")
        mk = os.urandom(KEY_BYTES)
        env = wrap_master_key(mk, passphrase, DEFAULT_SCRYPT, 1)
        try:
            self._c._put_key_envelope("keyEnvelope.create", env, {"If-None-Match": "*"})
        except APIError as e:
            if e.code == "envelope_exists":
                raise APIError(412, "envelope_exists") from None
            raise
        with self._lock:
            self._mk = mk

    def change_passphrase(self, new_passphrase: str) -> None:
        """Re-wraps the master key under a new passphrase (compare-and-swap on the version). Level L3, risk key."""
        self._c.check("keyEnvelope.replace")
        mk = self.master()
        cur = self._c.get_key_envelope()
        env = wrap_master_key(mk, new_passphrase, DEFAULT_SCRYPT, cur["version"] + 1)
        self._c._put_key_envelope("keyEnvelope.replace", env, {"If-Match": f'"{cur["version"]}"'})

    def import_master_key(self, mk: bytes) -> None:
        """Loads a master key handed over by the host (for example the Rotten Apple launcher). Level L2, risk key."""
        self._c.check("crypto.importMasterKey")
        if len(mk) != KEY_BYTES:
            raise ValueError("gendragoon: master key must be 32 bytes")
        with self._lock:
            self._mk = bytes(mk)

    def export_master_key(self) -> bytes:
        """A copy of the raw master key. Level L4, risk key-export: the default gate refuses it."""
        self._c.check("crypto.exportMasterKey")
        return bytes(self.master())
