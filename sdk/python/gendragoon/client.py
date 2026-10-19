"""Client for one binding of the GenDragoon storage provider API (/provider/v1), authenticated with the
binding's gdpk_ API key. Every call is checked by the gate first (levels: docs/LEVELS.md)."""
from __future__ import annotations

import hashlib
import json
import re
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from .crypto import validate_envelope
from .errors import APIError, ChecksumError
from .gate import Gate, Operation, level_gate
from .operations import OPERATIONS

VERSION = "0.1.0"
API_KEY_RE = re.compile(r"^gdpk_[0-9a-f]{16}_[A-Za-z0-9_-]{43}$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
_OPS = {o.id: o for o in OPERATIONS}


def operation(op_id: str) -> Operation:
    return _OPS[op_id]


@dataclass
class Response:
    status: int
    headers: dict
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body or b"null")

    def etag(self) -> str:
        return self.headers.get("etag", "").strip('"')


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # never follow redirects with a key attached
        return None


_opener = urllib.request.build_opener(_NoRedirect)


class Transport:
    """Shared by every client type: the gate and HTTP."""

    def __init__(self, gate: Optional[Gate] = None, timeout: float = 60.0, user_agent: str = ""):
        self.gate = gate or level_gate()
        self.timeout = timeout
        self.ua = f"gendragoon-sdk-python/{VERSION}" + (f" {user_agent}" if user_agent else "")

    def check(self, op_id: str) -> None:
        """Raises LevelError if the gate refuses the operation."""
        self.gate(operation(op_id))

    def _send(self, method: str, url: str, body: Optional[bytes], headers: dict, authorization: Optional[str]) -> Response:
        h = {"User-Agent": self.ua, **headers}
        if authorization:
            h["Authorization"] = authorization
        req = urllib.request.Request(url, data=body, method=method, headers=h)
        try:
            with _opener.open(req, timeout=self.timeout) as r:
                return Response(r.status, {k.lower(): v for k, v in r.headers.items()}, r.read(64 << 20))
        except urllib.error.HTTPError as e:
            data = e.read(1 << 16)
            code = ""
            try:
                code = str(json.loads(data).get("error") or "")
            except (ValueError, AttributeError):
                pass
            ra = e.headers.get("Retry-After") or "0"
            raise APIError(e.code, code, int(ra) if ra.isdigit() else 0) from None
        except urllib.error.URLError as e:
            raise ConnectionError(f"gendragoon: {method} {url.split('?')[0]}: {e.reason}") from None


@dataclass
class ListItem:
    id: str
    size: int = 0
    generation: Optional[str] = None


@dataclass
class ListPage:
    items: list[ListItem] = field(default_factory=list)
    next: Optional[str] = None


@dataclass
class PutResult:
    created: bool
    generation: str


@dataclass
class Manifest:
    data: bytes
    generation: str


def _need_hex(v: str, what: str) -> None:
    if not HEX64.match(v or ""):
        raise ValueError(f"gendragoon: {what} must be 64 lower-case hex characters")


def _pre(h: dict, if_absent: bool = False, if_generation: str = "") -> dict:
    if if_absent:
        h["If-None-Match"] = "*"
    elif if_generation:
        h["If-Match"] = f'"{if_generation}"'
    return h


class Client(Transport):
    """One binding. Safe to share between threads."""

    def __init__(self, base: str, api_key: str, *, gate: Optional[Gate] = None, timeout: float = 60.0, user_agent: str = ""):
        super().__init__(gate, timeout, user_agent)
        if not API_KEY_RE.match(api_key or ""):
            raise ValueError("gendragoon: malformed API key")
        self.base = base.rstrip("/")
        self._key = api_key
        self._lock = threading.Lock()

    def __repr__(self) -> str:  # never show the key
        return f"Client({self.base!r})"

    @property
    def api_key(self) -> str:
        with self._lock:
            return self._key

    def request(self, op: str, method: str, path: str, body: Optional[bytes] = None, headers: Optional[dict] = None, auth: bool = True) -> Response:
        self.check(op)
        return self._send(method, self.base + path, body, headers or {}, f"Bearer {self.api_key}" if auth else None)

    def capabilities(self) -> dict:
        return self.request("capabilities", "GET", "/capabilities", auth=False).json()

    def health(self) -> None:
        self.request("health", "GET", "/health")

    def usage(self) -> dict:
        """usedBytes, quotaBytes, objectCount, workspaceId, changeSeq, lastChangeAt."""
        return self.request("usage", "GET", "/usage").json()

    # ---- blobs ----
    def put_blob(self, data: bytes) -> tuple[str, PutResult]:
        """Stores data content-addressed (id = SHA-256) and returns (id, result)."""
        blob_id = hashlib.sha256(data).hexdigest()
        return blob_id, self._put_blob(blob_id, data, "content")

    def put_sealed_blob(self, blob_id: str, data: bytes) -> PutResult:
        """Stores data under an id the caller chose (for example an HMAC of the plaintext)."""
        return self._put_blob(blob_id, data, "sealed")

    def _put_blob(self, blob_id: str, data: bytes, mode: str) -> PutResult:
        _need_hex(blob_id, "blob id")
        r = self.request("blobs.put", "PUT", f"/blobs/{blob_id}", data, {
            "Content-Type": "application/octet-stream", "X-Id-Mode": mode, "X-Content-SHA256": hashlib.sha256(data).hexdigest()})
        return PutResult(r.status == 201, r.etag())

    def get_blob(self, blob_id: str) -> bytes:
        """Reads a blob and verifies its checksum."""
        _need_hex(blob_id, "blob id")
        r = self.request("blobs.get", "GET", f"/blobs/{blob_id}")
        want = r.headers.get("x-content-sha256")
        if want and want != hashlib.sha256(r.body).hexdigest():
            raise ChecksumError()
        return r.body

    def head_blob(self, blob_id: str) -> dict:
        _need_hex(blob_id, "blob id")
        r = self.request("blobs.head", "HEAD", f"/blobs/{blob_id}")
        return {"size": int(r.headers.get("content-length") or 0), "generation": r.etag(), "sha256": r.headers.get("x-content-sha256", "")}

    def delete_blob(self, blob_id: str) -> None:
        """Level L3, risk destructive (a blob can belong to any file of any drive). Deleting a missing blob succeeds."""
        _need_hex(blob_id, "blob id")
        self.request("blobs.delete", "DELETE", f"/blobs/{blob_id}")

    def _list(self, op: str, path: str, cursor: Optional[str], limit: int) -> ListPage:
        q = {k: v for k, v in (("cursor", cursor), ("limit", str(limit) if limit else None)) if v}
        out = self.request(op, "GET", path + ("?" + urllib.parse.urlencode(q) if q else "")).json()
        items = out.get("items")
        if items is None:
            items = [{"id": i} for i in out.get("ids", [])]
        return ListPage([ListItem(i["id"], i.get("size") or 0, i.get("generation")) for i in items], out.get("next"))

    def list_blobs(self, cursor: Optional[str] = None, limit: int = 0) -> ListPage:
        return self._list("blobs.list", "/blobs", cursor, limit)

    def list_manifests(self, cursor: Optional[str] = None, limit: int = 0) -> ListPage:
        return self._list("manifests.list", "/manifests", cursor, limit)

    def _all(self, page: Callable[[Optional[str]], ListPage]) -> list[ListItem]:
        out, cursor = [], None
        while True:
            p = page(cursor)
            out.extend(p.items)
            if not p.next:
                return out
            cursor = p.next

    def all_blobs(self) -> list[ListItem]:
        return self._all(self.list_blobs)

    def all_manifests(self) -> list[ListItem]:
        return self._all(self.list_manifests)

    def has_blobs(self, ids: list[str]) -> list[str]:
        """The subset of ids that exist, in input order."""
        present: list[str] = []
        for i in range(0, len(ids), 1000):
            r = self.request("blobs.batchHas", "POST", "/blobs/batch-has", json.dumps({"ids": ids[i:i + 1000]}).encode(),
                             {"Content-Type": "application/json"})
            present.extend(r.json()["present"])
        return present

    # ---- manifests ----
    def get_manifest(self, key: str) -> Manifest:
        _need_hex(key, "manifest key")
        r = self.request("manifests.get", "GET", f"/manifests/{key}")
        return Manifest(r.body, r.etag())

    def put_manifest(self, key: str, data: bytes, *, if_absent: bool = False, if_generation: str = "") -> PutResult:
        """Losing a compare-and-swap race raises APIError with precondition_failed set."""
        _need_hex(key, "manifest key")
        h = _pre({"Content-Type": "application/octet-stream", "X-Content-SHA256": hashlib.sha256(data).hexdigest()}, if_absent, if_generation)
        r = self.request("manifests.put", "PUT", f"/manifests/{key}", data, h)
        return PutResult(r.status == 201, r.etag())

    def delete_manifest(self, key: str, *, if_generation: str = "") -> None:
        """Level L3, risk destructive (one manifest can be a whole drive)."""
        _need_hex(key, "manifest key")
        self.request("manifests.delete", "DELETE", f"/manifests/{key}", headers=_pre({}, False, if_generation))

    # ---- key envelope ----
    def get_key_envelope(self) -> dict:
        return validate_envelope(self.request("keyEnvelope.get", "GET", "/key-envelope").json())

    def _put_key_envelope(self, op: str, env: dict, pre: dict) -> None:
        validate_envelope(env)
        self.request(op, "PUT", "/key-envelope", json.dumps(env).encode(), {**pre, "Content-Type": "application/json"})

    def rotate_api_key(self) -> str:
        """Replaces the API key (the old one keeps working for ten minutes) and returns the new one to store."""
        k = self.request("apiKey.rotate", "POST", "/connect/rotate").json().get("apiKey", "")
        if not API_KEY_RE.match(k):
            raise RuntimeError("gendragoon: unexpected rotate response")
        with self._lock:
            self._key = k
        return k

    def wipe(self) -> int:
        """Deletes every manifest and blob of this binding. Level L4, risk bulk-destructive: the default gate refuses it."""
        self.check("storage.wipe")
        n = 0
        for kind, items in (("manifests", self.all_manifests()), ("blobs", None)):
            for it in items if items is not None else self.all_blobs():
                self.request("storage.wipe", "DELETE", f"/{kind}/{it.id}")
                n += 1
        return n
