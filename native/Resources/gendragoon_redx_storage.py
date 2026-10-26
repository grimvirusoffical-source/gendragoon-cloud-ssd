#!/usr/bin/env python3
"""Encrypted Red-XAI Receiver transport for the native GenDragoon library.

Credentials arrive only through the parent helper's private stdin envelope.
File/folder/app archives are split into deterministic 4 MiB plaintext chunks,
encrypted by the pinned Red-SecretsXAI C++ core, wrapped in compact red-X PNG
carriers and stored through the account-owned Receiver.
"""
import hashlib
from collections import deque
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib

os.environ["PYTHONDONTWRITEBYTECODE"] = "1"

RESOURCE = Path(__file__).resolve().parent
DEV_VENDOR = RESOURCE.parent / "vendor" / "Red-SecretsXAI"
if DEV_VENDOR.is_dir():
    import sys
    sys.path.insert(0, str(DEV_VENDOR))

rsx = encode_storage_image = decode_storage_image = StorageImageError = None

def _crypto_runtime():
    global rsx, encode_storage_image, decode_storage_image, StorageImageError
    if rsx is None:
        from redxai import _librsx as _rsx
        from redsecretsxai import (
            encode_storage_image as _encode_storage_image,
            decode_storage_image as _decode_storage_image,
            StorageImageError as _StorageImageError,
        )
        rsx = _rsx
        encode_storage_image = _encode_storage_image
        decode_storage_image = _decode_storage_image
        StorageImageError = _StorageImageError
    return rsx, encode_storage_image, decode_storage_image, StorageImageError

API = "https://api.red-xai.com"
CHUNK = 4 * 1024 * 1024
MAX_PNG = 8 * 1024 * 1024
JSON_LIMIT = 4 * 1024 * 1024
ID = re.compile(r"[a-f0-9]{32}\Z")
KEY = re.compile(r"[a-f0-9]{18}\Z")
RECEIVER = re.compile(r"[a-f0-9]{64}\Z")
TOKEN = re.compile(r"rxca_[A-Za-z0-9_-]{43}\Z")
SECRET = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")
SHA = re.compile(r"[a-f0-9]{64}\Z")
ROOT_SCHEMA = "gendragoon.library-manifest/v1"
PAGE_SCHEMA = "gendragoon.chunk-page/v1"
METADATA_SCHEMA = "gendragoon.metadata-stream/v1"


class RedXStorageError(RuntimeError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        raise RedXStorageError("Red-XAI Receiver redirects are not permitted")


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
            "Authorization": "Bearer " + self.token,
            "Accept": "application/json",
            "Accept-Encoding": "identity",
            "User-Agent": "GenDragoon-Native/0.18",
        }
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(self._url(route), data=data, method=method, headers=request_headers)
        for attempt in range(6):
            try:
                with self.opener.open(request, timeout=90) as response:
                    if response.status not in expected:
                        raise RedXStorageError("Receiver rejected the operation (HTTP %d)" % response.status,
                                               response.status)
                    body = response.read(limit + 1)
                    if len(body) > limit:
                        raise RedXStorageError("Receiver response exceeded its safety limit")
                    return response.status, dict(response.headers), body
            except urllib.error.HTTPError as error:
                code = int(error.code)
                retry_after = error.headers.get("Retry-After") if error.headers else None
                error.close()
                if code == 429 and attempt < 5:
                    try:
                        delay = float(retry_after) if retry_after is not None else .2 * 2 ** attempt
                    except (TypeError, ValueError):
                        delay = .2 * 2 ** attempt
                    time.sleep(min(3.0, max(.2, delay)))
                    continue
                messages = {401: "Red-XAI app session expired or was logged out",
                            404: "Red-XAI cloud item was not found",
                            429: "Red-XAI transfer allowance is busy; retry resumes verified chunks",
                            507: "Red-XAI cloud storage quota is full"}
                raise RedXStorageError(messages.get(code, "Receiver rejected the operation (HTTP %d)" % code), code) from None
            except (urllib.error.URLError, TimeoutError, ssl.SSLError) as error:
                raise RedXStorageError("Red-XAI Receiver is temporarily unreachable; retry resumes verified chunks") from error

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
            raise RedXStorageError("Encrypted cloud chunk exceeds 4 MiB")
        with tempfile.TemporaryDirectory(prefix="gd-rsx-") as td:
            source = Path(td) / "plain"
            encrypted = Path(td) / "sealed"
            source.write_bytes(plain)
            with self._operation_lock:
                rsx.encrypt_file(self._session, str(source), out_path=str(encrypted),
                                 aad=aad(self.client.receiver, self.client.workspace, object_id_value))
            blob = encrypted.read_bytes()
        png = encode_storage_image(blob)
        if len(png) > MAX_PNG or decode_storage_image(png) != blob:
            raise RedXStorageError("Compact encrypted PNG self-verification failed")
        return png

    def open(self, png, object_id_value):
        try:
            blob = decode_storage_image(png)
        except StorageImageError as exc:
            raise RedXStorageError("Encrypted storage PNG is invalid") from exc
        with tempfile.TemporaryDirectory(prefix="gd-rsx-open-") as td:
            sealed = Path(td) / "sealed"
            output = Path(td) / "plain"
            sealed.write_bytes(blob)
            with self._operation_lock:
                rsx.decrypt_file(self._session, str(sealed), out_path=str(output),
                                 aad=aad(self.client.receiver, self.client.workspace, object_id_value))
            return output.read_bytes()


def _put_plain(client, codec, object_id_value, plain):
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
    codecs = deque([codec] + [codec.worker(RedXReceiver(client.config)) for _ in range(workers - 1)])
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
    pages = []
    for page_index in range(0, len(records), page_size):
        group = records[page_index:page_index + page_size]
        value = json.dumps({"schema": PAGE_SCHEMA, "records": group}, separators=(",", ":")).encode()
        oid = object_id(domain, archive_sha, page_index // page_size)
        pages.append(_put_plain(client, codec, oid, value))
    return pages


def _load_pages(client, codec, pages):
    out = []
    for record in pages:
        raw = _get_plain(client, codec, record)
        try:
            value = json.loads(raw)
        except Exception as exc:
            raise RedXStorageError("Encrypted manifest page is invalid") from exc
        if not isinstance(value, dict) or value.get("schema") != PAGE_SCHEMA or not isinstance(value.get("records"), list):
            raise RedXStorageError("Encrypted manifest page is invalid")
        out.extend(value["records"])
    return out


def upload_archive(config, archive, key, name, kind, archive_layout, archive_sha, source_manifest):
    client = RedXReceiver(config)
    workers = client.verified_workers(write=True)
    archive = Path(archive)
    if not archive.is_file() or archive.is_symlink() or sha256_file(archive) != archive_sha:
        raise RedXStorageError("Prepared archive changed before encrypted upload")
    chunks = []
    with Codec(client) as codec, archive.open("rb") as stream:
        def parts():
            for index, plain in enumerate(iter(lambda: stream.read(CHUNK), b"")):
                yield index, plain
        def upload(codec, value):
            index, plain = value
            oid = object_id("archive-chunk", archive_sha, index)
            record = _put_plain(codec.client, codec, oid, plain)
            record["index"] = index
            return record
        allowance = min(workers, max(1, (archive.stat().st_size + CHUNK - 1) // CHUNK))
        for record in _parallel_chunks(client, codec, allowance, parts(), upload):
            chunks.append(record)
        if not chunks:
            raise RedXStorageError("Refusing to upload an empty archive")

        chunk_pages = _json_pages(client, codec, "archive-page", archive_sha, chunks)

        metadata_raw = json.dumps(source_manifest, separators=(",", ":"), ensure_ascii=False).encode()
        metadata_sha = sha256_bytes(metadata_raw)
        compressed = zlib.compress(metadata_raw, 9)
        metadata_parts = []
        for offset in range(0, len(compressed), CHUNK):
            part = compressed[offset:offset + CHUNK]
            oid = object_id("metadata", archive_sha, offset // CHUNK)
            metadata_parts.append(_put_plain(client, codec, oid, part))

        root = {
            "schema": ROOT_SCHEMA,
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
                "parts": metadata_parts,
            },
        }
        root_raw = json.dumps(root, separators=(",", ":"), ensure_ascii=False).encode()
        if len(root_raw) > CHUNK:
            raise RedXStorageError("Encrypted root manifest is too large")
        manifest_id = object_id("root-manifest", archive_sha, key)
        root_record = _put_plain(client, codec, manifest_id, root_raw)
        registered = client.register(key, {
            "name": name,
            "kind": kind,
            "workspace": client.workspace,
            "manifestId": manifest_id,
            "archiveBytes": archive.stat().st_size,
            "archiveSha256": archive_sha,
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
    if (not isinstance(root, dict) or root.get("schema") != ROOT_SCHEMA
            or root.get("name") != item.get("name") or root.get("kind") != item.get("kind")
            or root.get("archiveBytes") != item.get("archiveBytes")
            or root.get("archiveSha256") != item.get("archiveSha256")
            or not isinstance(root.get("chunkPages"), list)
            or not isinstance(root.get("metadata"), dict)):
        raise RedXStorageError("Encrypted library manifest does not match the Receiver index")
    return root, manifest_id


def download_archive(config, item, destination):
    client = RedXReceiver(config)
    workers = client.verified_workers()
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
                output.flush()
                os.fsync(output.fileno())
            if total != root["archiveBytes"] or hasher.hexdigest() != root["archiveSha256"]:
                raise RedXStorageError("Restored archive failed full SHA-256 verification")
            os.replace(temp, destination)
        finally:
            if temp.exists():
                temp.unlink()

        meta = root["metadata"]
        parts = meta.get("parts")
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


def list_items(config):
    client = RedXReceiver(config)
    items = []
    for value in client.library():
        if (not isinstance(value, dict) or not KEY.fullmatch(str(value.get("key") or ""))
                or value.get("kind") not in ("app", "folder", "file")
                or not isinstance(value.get("name"), str)
                or not ID.fullmatch(str(value.get("workspace") or ""))
                or not ID.fullmatch(str(value.get("manifestId") or ""))
                or not SHA.fullmatch(str(value.get("archiveSha256") or ""))):
            raise RedXStorageError("Receiver library contains invalid metadata")
        items.append(value)
    return items


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
