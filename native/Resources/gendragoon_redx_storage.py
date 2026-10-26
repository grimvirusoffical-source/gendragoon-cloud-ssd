#!/usr/bin/env python3
"""Encrypted Red-XAI Receiver transport for the native GenDragoon library.

Credentials arrive only through the parent helper's private stdin envelope.
File/folder/app archives use bounded visual red-X barcode chunks encrypted by
the pinned Red-SecretsXAI C++ core. Previously stored compact PNG objects remain
readable. The image carrier transports ciphertext; AEAD authenticates it.
"""
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

import hashlib
import http.client
import math
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import json
from pathlib import Path
import re
import ssl
import struct
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib
import gendragoon_progress as progress
import gendragoon_auth_broker as auth_broker
from gendragoon_transfer_errors import TransferError

RESOURCE = Path(__file__).resolve().parent
DEV_VENDOR = RESOURCE.parent / "vendor" / "Red-SecretsXAI"
if DEV_VENDOR.is_dir():
    import sys
    sys.path.insert(0, str(DEV_VENDOR))

rsx = encode_image = decode_image = decode_storage_image = StorageImageError = None

def _crypto_runtime():
    global rsx, encode_image, decode_image, decode_storage_image, StorageImageError
    if rsx is None:
        from redxai import _librsx as _rsx
        from redsecretsxai import (
            encode_image as _encode_image,
            decode_image as _decode_image,
            decode_storage_image as _decode_storage_image,
            StorageImageError as _StorageImageError,
        )
        rsx = _rsx
        encode_image = _encode_image
        decode_image = _decode_image
        decode_storage_image = _decode_storage_image
        StorageImageError = _StorageImageError
    return rsx, encode_image, decode_image, decode_storage_image, StorageImageError

API = "https://api.red-xai.com"
CHUNK = 64 * 1024
VISUAL_PROFILE = "redx-visual-v3-m3-b3-64k"
VISUAL_PARAMETERS = dict(module=3, bits=3, noise=0, verify=True, chaff=True,
                         skeleton=True, border=True, deterministic=True)
# NumPy image work has a larger raster footprint than the encrypted chunk.
# Keep one raster operation in flight while tier-controlled HTTP runs in parallel.
_IMAGE_WORK = threading.BoundedSemaphore(1)
MAX_PNG = 8 * 1024 * 1024
JSON_LIMIT = 4 * 1024 * 1024
ID = re.compile(r"[a-f0-9]{32}\Z")
KEY = re.compile(r"[a-f0-9]{18}\Z")
RECEIVER = re.compile(r"[a-f0-9]{64}\Z")
TOKEN = re.compile(r"rxca_[A-Za-z0-9_-]{43}\Z")
SECRET = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
LEGACY_ROOT_SCHEMA = "gendragoon.library-manifest/v1"
ROOT_SCHEMA = "gendragoon.library-manifest/v2"
PAGE_SCHEMA = "gendragoon.chunk-page/v1"
INDEX_SCHEMA = "gendragoon.chunk-index/v2"
METADATA_SCHEMA = "gendragoon.metadata-stream/v1"


class RedXStorageError(TransferError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        raise RedXStorageError("Red-XAI Receiver redirects are not permitted")


class _ProgressBody:
    """A repeatable HTTP body; count a block after the socket write returns.

    Content-Length remains explicit, so urllib does not switch to chunked HTTP.
    A fresh iterator on each 429 retry preserves exactly the original bytes.
    """
    def __init__(self, data):
        self.data = data

    def __iter__(self):
        for offset in range(0, len(self.data), 64 * 1024):
            part = self.data[offset:offset + 64 * 1024]
            yield part
            progress.network_bytes("upload", len(part))


@lru_cache(maxsize=1)
def tls_context():
    roots = Path("/etc/ssl/cert.pem")
    return ssl.create_default_context(cafile=str(roots)) if roots.is_file() else ssl.create_default_context()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as stream:
        for part in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def validate_config(value):
    if (not isinstance(value, dict) or value.get("provider") != "redxai"
            or value.get("cloudApi") != API
            or not isinstance(value.get("workspaceId"), str) or not ID.fullmatch(value["workspaceId"])
            or not isinstance(value.get("bearerToken"), str) or not TOKEN.fullmatch(value["bearerToken"])
            or not isinstance(value.get("receiverId"), str) or not RECEIVER.fullmatch(value["receiverId"])
            or not isinstance(value.get("storageSecret"), str) or not SECRET.fullmatch(value["storageSecret"])
            or not isinstance(value.get("keymapPath"), str) or not Path(value["keymapPath"]).is_absolute()
            or "\0" in value["keymapPath"] or type(value.get("constrained", False)) is not bool):
        raise RedXStorageError("Invalid private Red-XAI worker configuration")
    return value


def object_id(domain, *parts):
    h = hashlib.sha256()
    h.update(("gendragoon/" + domain + "/v1").encode())
    for part in parts:
        h.update(b"\0")
        h.update(str(part).encode())
    return h.hexdigest()[:32]


def aad(receiver, workspace, object_id_value):
    if not RECEIVER.fullmatch(receiver) or not ID.fullmatch(workspace) or not ID.fullmatch(object_id_value):
        raise RedXStorageError("Invalid encrypted object context")
    return json.dumps({
        "context": "gendragoon-cloud-object/v1",
        "receiver": receiver,
        "workspace": workspace,
        "object": object_id_value,
    }, separators=(",", ":")).encode()


class RedXReceiver:
    def __init__(self, config):
        self.config = validate_config(config)
        self.workspace = config["workspaceId"]
        self.receiver = config["receiverId"]
        self.token = config["bearerToken"]
        self.auth = auth_broker.client_for(config)
        self.secret = config["storageSecret"]
        self.keymap = Path(config["keymapPath"]).absolute()
        self.keymap.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            self.keymap.parent.chmod(0o700)
        except OSError:
            pass
        self.opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=tls_context()))

    def _url(self, route):
        if not route.startswith("/") or "\\" in route or ".." in route or "?" in route or "#" in route:
            raise RedXStorageError("Invalid Receiver path")
        return API + route

    def _request(self, route, method="GET", data=None, headers=None, limit=JSON_LIMIT, expected=(200,)):
        request_headers = {
            "Accept": "application/json",
            "Accept-Encoding": "identity",
            "User-Agent": "GenDragoon-Native/0.18",
        }
        if headers:
            request_headers.update(headers)
        tracked = progress.enabled() and "/blobs/" in route and method in ("GET", "PUT")
        body = _ProgressBody(data) if tracked and method == "PUT" and isinstance(data, bytes) else data
        retryable = method == "GET" or method == "PUT" and bool(re.fullmatch(
            r"/v1/receivers/me/workspaces/[a-f0-9]{32}/(?:blobs|objects)/[a-f0-9]{32}", route))
        renewed = False
        for attempt in range(6):
            token = self.auth.token() if self.auth else self.token
            request_headers["Authorization"] = "Bearer " + token
            request = urllib.request.Request(self._url(route), data=body, method=method, headers=request_headers)
            network_token = progress.network_begin() if tracked else None
            try:
                with self.opener.open(request, timeout=90) as response:
                    if response.status not in expected:
                        raise RedXStorageError("Receiver rejected the operation (HTTP %d)" % response.status,
                                               response.status)
                    if tracked and method == "GET":
                        parts, received = [], 0
                        while received <= limit:
                            part = response.read(min(64 * 1024, limit + 1 - received))
                            if not part:
                                break
                            parts.append(part)
                            received += len(part)
                            progress.network_bytes("download", len(part))
                        raw = b"".join(parts)
                    else:
                        raw = response.read(limit + 1)
                    if len(raw) > limit:
                        raise RedXStorageError("Receiver response exceeded its safety limit")
                    return response.status, dict(response.headers), raw
            except urllib.error.HTTPError as error:
                code = int(error.code)
                retry_after = error.headers.get("Retry-After") if error.headers else None
                error.close()
                if code == 401 and self.auth and not renewed and attempt < 5:
                    if network_token is not None:
                        progress.network_end(network_token); network_token = None
                    try:
                        self.auth.renew(token)
                    except auth_broker.BrokerError:
                        raise RedXStorageError("Native session renewal failed",401,"session_renewal_failed") from None
                    renewed = True
                    continue
                if (code == 429 or retryable and code in (408,425,500,502,503,504)) and attempt < 5:
                    if network_token is not None:
                        progress.network_end(network_token)
                        network_token = None
                    try:
                        delay = float(retry_after) if retry_after is not None else .2 * 2 ** attempt
                    except (TypeError, ValueError):
                        delay = .2 * 2 ** attempt
                    if not math.isfinite(delay):delay = .2 * 2 ** attempt
                    time.sleep(min(3.0, max(.2, delay)))
                    continue
                messages = {401: "Red-XAI app session expired or was logged out",
                            404: "Red-XAI cloud item was not found",
                            429: "Red-XAI transfer allowance is busy; retry resumes verified chunks",
                            507: "Red-XAI cloud storage quota is full"}
                raise RedXStorageError(messages.get(code, "Receiver rejected the operation (HTTP %d)" % code), code) from None
            except (urllib.error.URLError, TimeoutError, OSError, http.client.HTTPException) as error:
                reason = error.reason if isinstance(error, urllib.error.URLError) else error
                certificate_failure = isinstance(reason, ssl.SSLCertVerificationError)
                if retryable and not certificate_failure and attempt < 5:
                    if network_token is not None:
                        progress.network_end(network_token); network_token = None
                    time.sleep(min(3.0,.2 * 2 ** attempt))
                    continue
                raise RedXStorageError("Red-XAI Receiver is temporarily unreachable; retry resumes verified chunks",
                                       code="transport_unavailable") from None
            finally:
                if network_token is not None:
                    progress.network_end(network_token)

    def json(self, route, method="GET", value=None, expected=(200,)):
        data = None if value is None else json.dumps(value, separators=(",", ":")).encode()
        headers = {"Content-Type": "application/json"} if data is not None else {}
        _, _, raw = self._request(route, method, data, headers, JSON_LIMIT, expected)
        try:
            result = json.loads(raw)
        except Exception as exc:
            raise RedXStorageError("Receiver returned invalid JSON") from exc
        if not isinstance(result, dict):
            raise RedXStorageError("Receiver returned invalid JSON")
        return result

    def put_png(self, object_id_value, png):
        if not ID.fullmatch(object_id_value) or not (8 <= len(png) <= MAX_PNG) or png[:8] != b"\x89PNG\r\n\x1a\n":
            raise RedXStorageError("Invalid encrypted PNG object")
        digest = sha256_bytes(png)
        route = "/v1/receivers/me/workspaces/%s/blobs/%s" % (self.workspace, object_id_value)
        result = self._request(route, "PUT", png, {
            "Content-Type": "image/png",
            "Content-Length": str(len(png)),
            "X-Content-SHA256": digest,
        }, JSON_LIMIT, (200, 201))
        try:
            body = json.loads(result[2])
        except Exception as exc:
            raise RedXStorageError("Receiver upload response was invalid") from exc
        if body.get("id") != object_id_value or body.get("status") != "ready":
            raise RedXStorageError("Receiver did not confirm the encrypted object")
        return {"id": object_id_value, "carrierBytes": len(png), "carrierSha256": digest}

    def verified_workers(self, write=False):
        """Read current account-owned entitlements; stdin never grants workers."""
        result = self.json("/v1/receivers/me")
        workspaces = result.get("workspaces")
        if (result.get("id") != self.receiver or result.get("state") != "ready"
                or not isinstance(workspaces, list)):
            raise RedXStorageError("Receiver performance response is invalid")
        matches = [w for w in workspaces if isinstance(w, dict) and w.get("id") == self.workspace]
        if len(matches) != 1:
            raise RedXStorageError("Selected Red-XAI workspace is unavailable")
        workspace = matches[0]
        workers, quota = workspace.get("workers"), workspace.get("quotaBytes")
        active, read_only = workspace.get("active"), workspace.get("readOnly")
        if (type(workers) is not int or not 0 <= workers <= 24 or type(quota) is not int or quota < 0
                or type(active) is not bool or type(read_only) is not bool
                or active and not read_only and (workers < 1 or quota < 1)):
            raise RedXStorageError("Receiver workspace entitlement is invalid")
        writable = active and not read_only and quota > 0 and workers > 0
        if write and not writable:
            raise RedXStorageError("Select an active storage subscription before uploading")
        # Lapsed workspaces retain single-worker recovery of already stored data.
        return workers if writable and not self.config.get("constrained", False) else 1

    def get_png(self, object_id_value):
        if not ID.fullmatch(object_id_value):
            raise RedXStorageError("Invalid encrypted object id")
        route = "/v1/receivers/me/workspaces/%s/blobs/%s" % (self.workspace, object_id_value)
        _, headers, data = self._request(route, "GET", None, None, MAX_PNG, (200,))
        declared = headers.get("Content-Length") or headers.get("content-length")
        digest = headers.get("X-Content-Sha256") or headers.get("x-content-sha256")
        if (declared is None or int(declared) != len(data) or not isinstance(digest, str)
                or not SHA.fullmatch(digest) or sha256_bytes(data) != digest
                or data[:8] != b"\x89PNG\r\n\x1a\n"):
            raise RedXStorageError("Downloaded encrypted PNG failed integrity")
        return data

    def delete_blob(self, object_id_value):
        route = "/v1/receivers/me/workspaces/%s/blobs/%s" % (self.workspace, object_id_value)
        return self.json(route, "DELETE", expected=(200,))

    def library(self):
        result = self.json("/v1/receivers/me/library")
        items = result.get("items")
        if not isinstance(items, list):
            raise RedXStorageError("Receiver library response was invalid")
        return items

    def library_snapshot(self):
        result = self.json("/v1/receivers/me/workspaces/%s/library" % self.workspace)
        if (type(result.get("revision")) is not int or result["revision"] < 0
                or not isinstance(result.get("items"), list)):
            raise RedXStorageError("Receiver library snapshot is invalid")
        _validate_library_items(result["items"])
        if any(item["workspace"] != self.workspace for item in result["items"]):
            raise RedXStorageError("Receiver library snapshot belongs to another MachineNote")
        return result

    def organize(self, operation, keys, parent_key=None, name=None, expected_revision=None):
        self.verified_workers(write=True)
        value = {"workspace": self.workspace, "operation": operation, "keys": keys,
                 "parentKey": parent_key, "expectedRevision": expected_revision}
        if name is not None:
            value["name"] = name
        try:
            result = self.json("/v1/receivers/me/library/operations", "POST", value)
            if type(result.get("revision")) is not int or not isinstance(result.get("items"), list):
                raise RedXStorageError("Receiver library operation response is invalid")
            _validate_library_items(result["items"])
            if any(item["workspace"] != self.workspace for item in result["items"]):
                raise RedXStorageError("Receiver library operation belongs to another MachineNote")
            return result
        except RedXStorageError as error:
            if error.status == 409:
                raise RedXStorageError("Library changed or the destination has a conflicting item. Refresh the folder and try again.", 409) from None
            raise

    def register(self, key, item):
        if not KEY.fullmatch(key):
            raise RedXStorageError("Invalid library key")
        return self.json("/v1/receivers/me/library/" + key, "PUT", item, (200,))

    def remove_library(self, key):
        if not KEY.fullmatch(key):
            raise RedXStorageError("Invalid library key")
        return self.json("/v1/receivers/me/library/" + key, "DELETE", expected=(200,))


class Codec:
    def __init__(self, client):
        self.client = client
        self._manager = None
        self._session = None
        self._operation_lock = threading.Lock()

    def __enter__(self):
        _crypto_runtime()
        self._manager = rsx.session_open(self.client.secret, str(self.client.keymap))
        self._session = self._manager.__enter__()
        return self

    def __exit__(self, *exc):
        if self._manager is not None:
            with self._operation_lock:
                self._manager.__exit__(*exc)
                self._manager = None
                self._session = None

    def worker(self, client):
        # A worker borrows the already unlocked session. C++ operations are
        # serialized, avoiding undocumented native thread safety and repeated
        # memory-hard key derivation; HTTP transfers and PNG work run in parallel.
        if self._session is None:
            raise RedXStorageError("Encrypted transfer session is not initialized")
        worker = Codec(client)
        worker._session = self._session
        worker._operation_lock = self._operation_lock
        return worker

    def seal(self, plain, object_id_value):
        plain = bytes(plain)
        if not plain or len(plain) > CHUNK:
            raise RedXStorageError("Encrypted visual cloud chunk exceeds 64 KiB")
        progress.activity("encoding", during=("encoding", "uploading"))
        factory = getattr(self.client, "temporary_directory", tempfile.TemporaryDirectory)
        with factory(prefix="gd-rsx-") as td:
            source = Path(td) / "plain"
            encrypted = Path(td) / "sealed"
            source.write_bytes(plain)
            with self._operation_lock:
                rsx.encrypt_file(self._session, str(source), out_path=str(encrypted),
                                 aad=aad(self.client.receiver, self.client.workspace, object_id_value))
            blob = encrypted.read_bytes()
        try:
            with _IMAGE_WORK:
                png = encode_image(blob, **VISUAL_PARAMETERS)
        except ValueError as error:
            raise RedXStorageError("Red-X visual barcode encoding failed") from error
        if len(png) < 24 or len(png) > MAX_PNG or png[:8] != b"\x89PNG\r\n\x1a\n":
            raise RedXStorageError("Red-X visual barcode exceeds the Receiver transport limit")
        width, height = struct.unpack(">II", png[16:24])
        if width * height > 4_000_000:
            raise RedXStorageError("Red-X visual barcode exceeds the Receiver raster limit")
        return png

    def open(self, png, object_id_value):
        try:
            blob = decode_storage_image(png)
        except StorageImageError:
            try:
                with _IMAGE_WORK:
                    blob = decode_image(png)
            except ValueError as exc:
                raise RedXStorageError("Encrypted visual barcode is invalid") from exc
        factory = getattr(self.client, "temporary_directory", tempfile.TemporaryDirectory)
        with factory(prefix="gd-rsx-open-") as td:
            sealed = Path(td) / "sealed"
            output = Path(td) / "plain"
            sealed.write_bytes(blob)
            with self._operation_lock:
                rsx.decrypt_file(self._session, str(sealed), out_path=str(output),
                                 aad=aad(self.client.receiver, self.client.workspace, object_id_value))
            return output.read_bytes()


def _put_plain(client, codec, object_id_value, plain, on_encoded=None):
    # Encryption has random nonces. Re-encrypting an interrupted deterministic
    # object id would conflict with the immutable stored carrier, so authenticate
    # and compare any committed chunk before deciding to reuse it.
    def reuse():
        png = client.get_png(object_id_value)
        restored = codec.open(png, object_id_value)
        if len(restored) != len(plain) or sha256_bytes(restored) != sha256_bytes(plain):
            raise RedXStorageError("Existing encrypted chunk does not match this archive")
        return {"id": object_id_value, "carrierBytes": len(png), "carrierSha256": sha256_bytes(png),
                "plainBytes": len(plain), "plainSha256": sha256_bytes(plain)}
    try:
        return reuse()
    except RedXStorageError as error:
        if error.status != 404:
            raise
    png = codec.seal(plain, object_id_value)
    if on_encoded is not None:
        on_encoded(len(plain))
    progress.activity("uploading", during=("encoding", "uploading"))
    try:
        record = client.put_png(object_id_value, png)
    except RedXStorageError as error:
        if error.status != 409:
            raise
        return reuse()
    record.update(plainBytes=len(plain), plainSha256=sha256_bytes(plain))
    return record


def _get_plain(client, codec, record):
    object_id_value = record.get("id")
    if not ID.fullmatch(str(object_id_value or "")):
        raise RedXStorageError("Manifest contains an invalid object id")
    png = client.get_png(object_id_value)
    if record.get("carrierSha256") and sha256_bytes(png) != record["carrierSha256"]:
        raise RedXStorageError("Encrypted carrier changed")
    progress.activity("decoding", during=("readback", "decoding"))
    plain = codec.open(png, object_id_value)
    if record.get("plainBytes") != len(plain) or record.get("plainSha256") != sha256_bytes(plain):
        raise RedXStorageError("Decrypted chunk failed manifest integrity")
    return plain


def _parallel_chunks(client, codec, workers, values, operation):
    """At most `workers` chunks in flight; consume results in archive order.

    Unlock the keymap once before starting threads. Each thread owns an HTTP
    opener and codec wrapper; native crypto calls share the session's lock.
    """
    if workers == 1:
        for value in values:
            yield operation(codec, value)
        return
    codecs = deque([codec] + [codec.worker(type(client)(client.config)) for _ in range(workers - 1)])
    local = threading.local()
    assignment = threading.Lock()
    def initialize():
        with assignment:
            local.codec = codecs.popleft()
    def perform(value):
        return operation(local.codec, value)
    with ThreadPoolExecutor(max_workers=workers, initializer=initialize) as executor:
        pending = deque()
        values = iter(values)
        try:
            for _ in range(workers):
                value = next(values, None)
                if value is None:
                    break
                pending.append(executor.submit(perform, value))
            while pending:
                yield pending.popleft().result()
                value = next(values, None)
                if value is not None:
                    pending.append(executor.submit(perform, value))
        finally:
            for future in pending:
                future.cancel()


def _json_pages(client, codec, domain, archive_sha, records, page_size=512):
    def write_groups(values, schema, key, level):
        pages, group = [], []
        def raw(items):
            return json.dumps({"schema": schema, key: items}, separators=(",", ":")).encode()
        def publish(items):
            value = raw(items)
            oid = object_id(domain, VISUAL_PROFILE, archive_sha, level, len(pages), sha256_bytes(value))
            pages.append(_put_plain(client, codec, oid, value))
        for record in values:
            if group and (len(group) >= page_size or len(raw(group + [record])) > CHUNK):
                publish(group)
                group = []
            group.append(record)
            if len(raw(group)) > CHUNK:
                raise RedXStorageError("Encrypted manifest record exceeds its barcode limit")
        if group:
            publish(group)
        return pages
    pages = write_groups(records, PAGE_SCHEMA, "records", 0)
    # Each root index gets at most one quarter of its barcode's capacity, leaving
    # room for metadata and future fields even for very large archive manifests.
    level = 1
    while len(json.dumps(pages, separators=(",", ":")).encode()) > CHUNK // 4:
        pages = write_groups(pages, INDEX_SCHEMA, "pages", level)
        level += 1
        if level > 8:
            raise RedXStorageError("Encrypted manifest index exceeds its safety limit")
    return pages


def _load_pages(client, codec, pages, _depth=0, _seen=None):
    if _depth > 8 or not isinstance(pages, list):
        raise RedXStorageError("Encrypted manifest index is invalid")
    seen = set() if _seen is None else _seen
    out = []
    for record in pages:
        if not isinstance(record, dict) or record.get("id") in seen:
            raise RedXStorageError("Encrypted manifest index repeats a page")
        seen.add(record.get("id"))
        raw = _get_plain(client, codec, record)
        try:
            value = json.loads(raw)
        except Exception as exc:
            raise RedXStorageError("Encrypted manifest page is invalid") from exc
        if isinstance(value, dict) and value.get("schema") == INDEX_SCHEMA:
            out.extend(_load_pages(client, codec, value.get("pages"), _depth + 1, seen))
            continue
        if not isinstance(value, dict) or value.get("schema") != PAGE_SCHEMA or not isinstance(value.get("records"), list):
            raise RedXStorageError("Encrypted manifest page is invalid")
        out.extend(value["records"])
    return out


def upload_archive(config, archive, key, name, kind, archive_layout, archive_sha, source_manifest, parent_key=None, client_factory=None):
    client = (client_factory or RedXReceiver)(config)
    workers = client.verified_workers(write=True)
    archive = Path(archive)
    if not archive.is_file() or archive.is_symlink():
        raise RedXStorageError("Prepared archive changed before encrypted upload")
    archive_bytes = archive.stat().st_size
    progress.phase("uploading", total_bytes=archive_bytes * 2, workers=workers,
                   objects_done=0, objects_total=(archive_bytes + CHUNK - 1) // CHUNK)
    if sha256_file(archive) != archive_sha:
        raise RedXStorageError("Prepared archive changed before encrypted upload")
    chunks = []
    with Codec(client) as codec, archive.open("rb") as stream:
        def parts():
            for index, plain in enumerate(iter(lambda: stream.read(CHUNK), b"")):
                yield index, plain
        def upload(codec, value):
            index, plain = value
            oid = object_id(VISUAL_PROFILE + "-archive-chunk", archive_sha, index)
            encoded = False
            def encoded_part(count):
                nonlocal encoded
                encoded = True
                progress.advance(count, encoded_bytes=count)
            record = _put_plain(codec.client, codec, oid, plain, on_encoded=encoded_part)
            if not encoded:
                # A verified immutable chunk reuses completed encoding work.
                progress.advance(len(plain))
            progress.advance(len(plain), objects_done=1)
            record["index"] = index
            return record
        allowance = min(workers, max(1, (archive.stat().st_size + CHUNK - 1) // CHUNK))
        for record in _parallel_chunks(client, codec, allowance, parts(), upload):
            chunks.append(record)
        if not chunks:
            raise RedXStorageError("Refusing to upload an empty archive")

        progress.update(phase="publishing")
        chunk_pages = _json_pages(client, codec, VISUAL_PROFILE + "-archive-page", archive_sha, chunks)

        metadata_raw = json.dumps(source_manifest, separators=(",", ":"), ensure_ascii=False).encode()
        metadata_sha = sha256_bytes(metadata_raw)
        compressed = zlib.compress(metadata_raw, 9)
        metadata_parts = []
        for offset in range(0, len(compressed), CHUNK):
            part = compressed[offset:offset + CHUNK]
            oid = object_id(VISUAL_PROFILE + "-metadata", archive_sha, metadata_sha, offset // CHUNK)
            metadata_parts.append(_put_plain(client, codec, oid, part))
        metadata_pages = _json_pages(client, codec, VISUAL_PROFILE + "-metadata-page", archive_sha, metadata_parts)

        root = {
            "schema": ROOT_SCHEMA,
            "storageProfile": VISUAL_PROFILE,
            "chunkBytes": CHUNK,
            "key": key,
            "name": name,
            "kind": kind,
            "archiveLayout": archive_layout,
            "archiveBytes": archive.stat().st_size,
            "archiveSha256": archive_sha,
            "chunkCount": len(chunks),
            "chunkPages": chunk_pages,
            "metadata": {
                "schema": METADATA_SCHEMA,
                "encoding": "zlib-json",
                "jsonBytes": len(metadata_raw),
                "jsonSha256": metadata_sha,
                "partPages": metadata_pages,
            },
        }
        root_raw = json.dumps(root, separators=(",", ":"), ensure_ascii=False).encode()
        if len(root_raw) > CHUNK:
            raise RedXStorageError("Encrypted root manifest is too large")
        manifest_id = object_id(VISUAL_PROFILE + "-root-manifest", archive_sha, key)
        root_record = _put_plain(client, codec, manifest_id, root_raw)
        registered = client.register(key, {
            "name": name,
            "kind": kind,
            "workspace": client.workspace,
            "manifestId": manifest_id,
            "archiveBytes": archive.stat().st_size,
            "archiveSha256": archive_sha,
            "parentKey": parent_key,
        })
        if registered.get("manifestId") != manifest_id or registered.get("name") != name:
            raise RedXStorageError("Receiver library registration mismatch")
        return {"manifestId": manifest_id, "rootRecord": root_record, "chunks": len(chunks),
                "archiveBytes": archive.stat().st_size, "archiveSha256": archive_sha}


def _root_for_item(client, codec, item):
    manifest_id = item.get("manifestId")
    if not ID.fullmatch(str(manifest_id or "")):
        raise RedXStorageError("Cloud library manifest id is invalid")
    png = client.get_png(manifest_id)
    root_raw = codec.open(png, manifest_id)
    try:
        root = json.loads(root_raw)
    except Exception as exc:
        raise RedXStorageError("Encrypted library manifest is invalid") from exc
    if (not isinstance(root, dict) or root.get("schema") not in (ROOT_SCHEMA, LEGACY_ROOT_SCHEMA)
            or root.get("name") != item.get("name") or root.get("kind") != item.get("kind")
            or root.get("archiveBytes") != item.get("archiveBytes")
            or root.get("archiveSha256") != item.get("archiveSha256")
            or not isinstance(root.get("chunkPages"), list)
            or not isinstance(root.get("metadata"), dict)):
        raise RedXStorageError("Encrypted library manifest does not match the Receiver index")
    return root, manifest_id


def download_archive(config, item, destination, client_factory=None):
    client = (client_factory or RedXReceiver)(config)
    workers = client.verified_workers()
    expected_bytes = item.get("archiveBytes")
    progress.phase("readback", total_bytes=expected_bytes if type(expected_bytes) is int and expected_bytes > 0 else 0,
                   workers=workers, objects_done=0, objects_total=0)
    destination = Path(destination)
    if destination.exists() or destination.is_symlink():
        raise RedXStorageError("Restore target already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with Codec(client) as codec:
        root, _ = _root_for_item(client, codec, item)
        chunks = _load_pages(client, codec, root["chunkPages"])
        if len(chunks) != root.get("chunkCount"):
            raise RedXStorageError("Encrypted archive chunk count mismatch")
        if any(not isinstance(record, dict) or record.get("index") != index for index, record in enumerate(chunks)):
            raise RedXStorageError("Encrypted archive chunk order is invalid")
        progress.update(objects_total=len(chunks))
        hasher = hashlib.sha256()
        total = 0
        temp = destination.with_name("." + destination.name + ".partial")
        try:
            with temp.open("xb") as output:
                allowance = min(workers, max(1, len(chunks)))
                for plain in _parallel_chunks(client, codec, allowance, chunks,
                        lambda worker, record: _get_plain(worker.client, worker, record)):
                    output.write(plain)
                    hasher.update(plain)
                    total += len(plain)
                    progress.advance(len(plain), objects_done=1)
                output.flush()
                os.fsync(output.fileno())
            if total != root["archiveBytes"] or hasher.hexdigest() != root["archiveSha256"]:
                raise RedXStorageError("Restored archive failed full SHA-256 verification")
            protect = getattr(client, "protect_download", None)
            if protect is not None:
                protect(temp)
            os.replace(temp, destination)
        finally:
            if temp.exists():
                temp.unlink()

        meta = root["metadata"]
        parts = (_load_pages(client, codec, meta["partPages"]) if "partPages" in meta else meta.get("parts"))
        if meta.get("schema") != METADATA_SCHEMA or meta.get("encoding") != "zlib-json" or not isinstance(parts, list):
            raise RedXStorageError("Encrypted metadata manifest is invalid")
        compressed = b"".join(_get_plain(client, codec, record) for record in parts)
        try:
            raw = zlib.decompress(compressed)
        except zlib.error as exc:
            raise RedXStorageError("Encrypted metadata manifest could not be decompressed") from exc
        if len(raw) != meta.get("jsonBytes") or sha256_bytes(raw) != meta.get("jsonSha256"):
            raise RedXStorageError("Encrypted metadata manifest failed integrity")
        try:
            manifest = json.loads(raw)
        except Exception as exc:
            raise RedXStorageError("Encrypted metadata manifest is invalid") from exc
        if not isinstance(manifest, list):
            raise RedXStorageError("Encrypted metadata manifest is invalid")
        return {"root": root, "manifest": manifest, "archive": str(destination)}


def _validate_library_items(values):
    items = []
    seen = set()
    for value in values:
        if (not isinstance(value, dict) or not KEY.fullmatch(str(value.get("key") or ""))
                or value.get("kind") not in ("app", "folder", "file")
                or not isinstance(value.get("name"), str)
                or value.get("parentKey") is not None and not KEY.fullmatch(str(value["parentKey"]))
                or value.get("archiveKey") is not None and not KEY.fullmatch(str(value["archiveKey"]))
                or not ID.fullmatch(str(value.get("workspace") or ""))
                or (value.get("virtualFolder") is True and value.get("kind") != "folder")
                or (value.get("virtualFolder") is not True and
                    (not ID.fullmatch(str(value.get("manifestId") or ""))
                     or not SHA.fullmatch(str(value.get("archiveSha256") or ""))))):
            raise RedXStorageError("Receiver library contains invalid metadata")
        if value["key"] in seen:
            raise RedXStorageError("Receiver library repeats an item")
        seen.add(value["key"])
        items.append(value)
    return items


def list_items(config):
    return _validate_library_items(RedXReceiver(config).library())


def find_item(config, key):
    if not KEY.fullmatch(key or ""):
        raise RedXStorageError("Invalid library key")
    for item in list_items(config):
        if item.get("key") == key:
            return item
    raise RedXStorageError("Red-XAI cloud item was not found")


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="GenDragoon encrypted Red-XAI Receiver transport; invoked by the native library worker.")
    parser.parse_args()
    parser.print_help()
