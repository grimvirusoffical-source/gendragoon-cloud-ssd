#!/usr/bin/env python3
"""Client for the existing RedX v1 pack API. Credentials are stdin-only.

This is a BYO-hosted byte store, independent of paid Receiver MachineNotes.
It does not add an encryption layer or invoke privileged RedX admin endpoints.
"""
from __future__ import annotations

import base64
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import ssl
import stat
import subprocess
import sys
import tempfile
import uuid
import zipfile
from urllib.parse import quote, urlencode, urlsplit

sys.dont_write_bytecode = True

BLOCK = 1024 * 1024
JSON_LIMIT = 4 * 1024 * 1024
MARKER = ".gendragoon-folder.json"
RESERVED = re.compile(r"^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)", re.I)


class PackError(Exception):
    def __init__(self, code, message=None, status=None):
        self.code, self.message, self.status = code, message or code.replace("_", " "), status
        super().__init__(self.message)


def origin(value, development=False):
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) < 33 for c in value):
        raise PackError("origin_invalid")
    try:
        u = urlsplit(value)
        port = u.port
    except ValueError:
        raise PackError("origin_invalid") from None
    loopback = u.hostname in ("localhost", "127.0.0.1", "::1")
    if (u.scheme != "https" and not (development is True and u.scheme == "http" and loopback)) or not u.hostname or u.username is not None or u.password is not None or u.path not in ("", "/") or u.query or u.fragment or "?" in value or "#" in value:
        raise PackError("origin_invalid", "Use an HTTPS host origin. Plain HTTP requires an explicit local development connection.")
    if not u.hostname.isascii() or "%" in u.hostname or "\\" in u.hostname:
        raise PackError("origin_invalid", "Use the host's canonical ASCII or punycode origin.")
    if ":" in u.hostname:
        try:
            host = "[" + ipaddress.IPv6Address(u.hostname).compressed + "]"
        except ValueError:
            raise PackError("origin_invalid") from None
    elif re.fullmatch(r"[0-9.]+", u.hostname):
        try:
            host = str(ipaddress.IPv4Address(u.hostname))
        except ValueError:
            raise PackError("origin_invalid") from None
    else:
        if not re.fullmatch(r"[a-z0-9.-]+", u.hostname):
            raise PackError("origin_invalid")
        host = u.hostname
    default_port = 443 if u.scheme == "https" else 80
    return u.scheme + "://" + host + (":" + str(port) if port and port != default_port else "")


def database(value):
    if not isinstance(value, str) or not re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,62}", value) or value in ("admin", "default", "redxai_accounts"):
        raise PackError("database_invalid")
    return value


def pack_name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", value):
        raise PackError("pack_invalid")
    return value


def remote_path(value, *, root=False, internal=False):
    if not isinstance(value, str) or len(value.encode("utf-8")) > 4096:
        raise PackError("path_invalid")
    if root and value == "":
        return ""
    parts = value.split("/")
    if any(p in ("", ".", "..") or p.endswith((" ", ".")) or RESERVED.match(p) or "\\" in p or ":" in p or any(ord(c) < 32 or ord(c) == 127 for c in p) for p in parts):
        raise PackError("path_invalid")
    if not internal and MARKER in parts:
        raise PackError("path_reserved")
    return value


def _json(response):
    data = response.read(JSON_LIMIT + 1)
    if len(data) > JSON_LIMIT:
        raise PackError("response_too_large")
    try:
        value = json.loads(data)
    except (ValueError, UnicodeError):
        raise PackError("response_invalid") from None
    if not isinstance(value, dict):
        raise PackError("response_invalid")
    return value


def _check(response, expected):
    if response.status not in expected:
        # Do not reflect remote bodies, headers, URLs or credentials into logs/UI.
        response.read(8192)
        code = {401: "key_invalid", 403: "access_denied", 404: "not_found", 409: "conflict", 413: "file_too_large", 422: "checksum_mismatch", 429: "rate_limited", 402: "host_plan_required"}.get(response.status, "host_request_failed")
        if 300 <= response.status < 400:
            code = "redirect_refused"
        raise PackError(code, status=response.status)


def _file_info(value, expected=None):
    if not isinstance(value, dict) or not isinstance(value.get("path"), str) or not isinstance(value.get("name"), str) or type(value.get("is_dir")) is not bool or type(value.get("size")) is not int or value["size"] < 0:
        raise PackError("response_invalid")
    remote_path(value["path"], root=True, internal=True)
    if expected is not None and value["path"] != expected:
        raise PackError("response_path_mismatch")
    if not value["is_dir"] and not re.fullmatch(r"[a-f0-9]{64}", value.get("sha256", "")):
        raise PackError("response_invalid")
    # Only return documented fields. Never surface arbitrary host strings.
    return {k: value[k] for k in ("path", "name", "is_dir", "size", "sha256", "chunk_size", "encrypted") if k in value}


class RedXPack:
    def __init__(self, config):
        self.config = config
        self.origin = origin(config.get("origin"), config.get("development", False))
        self.database = database(config.get("database"))
        self.pack = pack_name(config.get("pack", "gendragoon"))
        self.key = config.get("key")
        if not isinstance(self.key, str) or not 8 <= len(self.key) <= 512 or not re.fullmatch(r"[A-Za-z0-9_-]+", self.key):
            raise PackError("key_invalid")
        self.base = "/v1/db/" + quote(self.database, safe="") + "/pack/" + quote(self.pack, safe="") + "/"

    def _connection(self):
        u = urlsplit(self.origin)
        if u.scheme == "https":
            return http.client.HTTPSConnection(u.hostname, u.port, timeout=60, context=ssl.create_default_context())
        return http.client.HTTPConnection(u.hostname, u.port, timeout=60)

    def _request(self, method, route, payload=None, headers=None):
        connection = self._connection()
        try:
            try:
                connection.request(method, route, body=payload, headers={"Authorization": "Bearer " + self.key, "Accept": "application/json", **(headers or {})})
            except (BrokenPipeError, ConnectionResetError):
                # A server may refuse auth/quota before consuming a large body.
                # Preserve its safe HTTP status if it already sent the response.
                return connection, connection.getresponse()
            return connection, connection.getresponse()
        except BaseException:
            connection.close()
            raise

    def _route(self, verb, path="", *, internal=False):
        p = remote_path(path, root=verb == "ls", internal=internal)
        return self.base + verb + ("/" + quote(p, safe="/") if p else "")

    def stat(self, path, *, internal=False):
        conn, response = self._request("GET", self._route("stat", path, internal=internal))
        try:
            _check(response, (200,))
            return _file_info(_json(response), path)
        finally:
            conn.close()

    def list(self, path=""):
        conn, response = self._request("GET", self._route("ls", path))
        try:
            _check(response, (200,))
            data = _json(response)
            if data.get("pack") != self.pack or data.get("folder", "") != path or not isinstance(data.get("entries"), list) or len(data["entries"]) > 10000:
                raise PackError("response_invalid")
            entries = []
            for raw in data["entries"]:
                item = _file_info(raw)
                parent, _, name = item["path"].rpartition("/")
                if parent != path or item["name"] != name:
                    raise PackError("response_path_mismatch")
                if name != MARKER:
                    entries.append(item)
            return {"path": path, "entries": sorted(entries, key=lambda e: (not e["is_dir"], e["name"].casefold()))}
        finally:
            conn.close()

    def tree(self, path="", *, max_entries=10000, max_depth=32):
        root = remote_path(path, root=True)
        pending, entries = [(root, 0)], []
        while pending:
            folder, depth = pending.pop()
            for entry in self.list(folder)["entries"]:
                entries.append(entry)
                if len(entries) > max_entries:
                    raise PackError("tree_limit", "This folder exceeds the bounded tree limit. Open a smaller folder.")
                if entry["is_dir"]:
                    if depth >= max_depth:
                        raise PackError("tree_depth_limit")
                    pending.append((entry["path"], depth + 1))
        return {"path": root, "entries": entries}

    def put_bytes(self, path, data, *, internal=False):
        want = hashlib.sha256(data).hexdigest()
        conn, response = self._request("PUT", self._route("file", path, internal=internal), data, {"X-Redx-SHA256": want, "Content-Type": "application/octet-stream"})
        try:
            _check(response, (201,))
            info = _file_info(_json(response), path)
            self._verify_put(info, len(data), want)
            return info
        finally:
            conn.close()

    @staticmethod
    def _verify_put(info, size, digest):
        if info.get("encrypted"):
            raise PackError("encrypted_pack_unsupported", "The host applied its own encryption policy. This client cannot compare the host ciphertext hash to the plaintext hash.")
        if info["size"] != size or info.get("sha256") != digest or info["is_dir"]:
            raise PackError("checksum_mismatch")

    def put(self, path, source):
        remote_path(path)
        source = Path(source)
        fd = os.open(source, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            before = os.fstat(stream.fileno())
            if not stat.S_ISREG(before.st_mode):
                raise PackError("regular_file_required", "Archive a complete app or folder before transferring it as one pack file.")
            want = hashlib.file_digest(stream, "sha256").hexdigest()
            stream.seek(0)
            conn = self._connection()
            try:
                conn.putrequest("PUT", self._route("file", path))
                for name, value in {"Authorization": "Bearer " + self.key, "Content-Type": "application/octet-stream", "Content-Length": str(before.st_size), "X-Redx-SHA256": want}.items():
                    conn.putheader(name, value)
                conn.endheaders()
                sent = 0
                try:
                    while sent < before.st_size:
                        block = stream.read(min(BLOCK, before.st_size - sent))
                        if not block:
                            raise PackError("source_changed")
                        conn.send(block)
                        sent += len(block)
                except (BrokenPipeError, ConnectionResetError):
                    response = conn.getresponse()
                    _check(response, (201,))
                    raise PackError("transfer_failed")
                response = conn.getresponse()
                _check(response, (201,))
                info = _file_info(_json(response), path)
                self._verify_put(info, before.st_size, want)
                after = os.fstat(stream.fileno())
                if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                    raise PackError("source_changed")
                return info
            finally:
                conn.close()

    def get(self, path, destination):
        info = self.stat(path)
        if info["is_dir"]:
            raise PackError("regular_file_required")
        if info.get("encrypted"):
            raise PackError("encrypted_pack_unsupported")
        target = Path(destination).expanduser().absolute()
        parent = target.parent
        if str(parent.resolve(strict=True)) != str(parent) or target.name in ("", ".", "..") or target.exists() or target.is_symlink():
            raise PackError("destination_unsafe", "Choose a new file in an existing folder. Existing files are preserved.")
        import gendragoon_library as library
        library.require_space(info["size"], parent)
        fd, temporary = tempfile.mkstemp(prefix=".gendragoon-pack-", dir=parent)
        conn = None
        try:
            conn, response = self._request("GET", self._route("file", path))
            _check(response, (200,))
            if response.getheader("X-Redx-Encrypted") or response.getheader("ETag") != '"sha256-' + info["sha256"] + '"':
                raise PackError("response_changed")
            digest, size = hashlib.sha256(), 0
            with os.fdopen(fd, "wb") as stream:
                fd = None
                while True:
                    block = response.read(BLOCK)
                    if not block:
                        break
                    size += len(block)
                    if size > info["size"]:
                        raise PackError("checksum_mismatch")
                    digest.update(block)
                    stream.write(block)
                stream.flush()
                os.fsync(stream.fileno())
            if size != info["size"] or digest.hexdigest() != info["sha256"]:
                raise PackError("checksum_mismatch")
            os.link(temporary, target, follow_symlinks=False)  # exclusive publish; never overwrite
            return {**info, "destination": str(target), "verified": True}
        finally:
            if fd is not None:
                os.close(fd)
            if conn:
                conn.close()
            os.unlink(temporary)

    def get_bytes(self, path, limit=JSON_LIMIT):
        info = self.stat(path)
        if info["is_dir"] or info["size"] > limit or info.get("encrypted"):
            raise PackError("metadata_unsupported")
        conn, response = self._request("GET", self._route("file", path))
        try:
            _check(response, (200,))
            data = response.read(limit + 1)
            if len(data) != info["size"] or hashlib.sha256(data).hexdigest() != info["sha256"]:
                raise PackError("checksum_mismatch")
            return data
        finally:
            conn.close()

    def mkdir(self, path):
        folder = remote_path(path)
        # RedX has no REST mkdir. A real, hidden marker file preserves an empty folder.
        marker = folder + "/" + MARKER
        self.put_bytes(marker, b'{"schema":1,"kind":"gendragoon-empty-folder"}\n', internal=True)
        return {"path": folder, "is_dir": True, "marker": True}

    def delete(self, path):
        info = self.stat(path)
        if info["is_dir"]:
            raise PackError("folder_delete_unsupported", "RedX supports deleting individual pack files. Recursive folder deletion requires explicit file selection.")
        conn, response = self._request("DELETE", self._route("file", path))
        try:
            _check(response, (200,))
            data = _json(response)
            if data.get("ok") is not True:
                raise PackError("response_invalid")
            return {"path": path, "deleted": True, "chunksRetainedUntilHostGC": True}
        finally:
            conn.close()


ARCHIVE_ENTRY = ".gendragoon-entry.json"


def connection_context(config):
    base = origin(config.get("origin"), config.get("development", False))
    db, pack = database(config.get("database")), pack_name(config.get("pack", "gendragoon"))
    account = config.get("accountId")
    if not isinstance(account, str) or not re.fullmatch(r"[a-f0-9]{64}", account):
        raise PackError("account_context_invalid")
    receiver = hashlib.sha256(json.dumps(["gendragoon-byo-receiver/v1", base, db, pack, account], separators=(",", ":")).encode()).hexdigest()
    workspace = hashlib.sha256(("gendragoon-byo-workspace/v1:" + receiver).encode()).hexdigest()[:32]
    return {"receiverId": receiver, "workspaceId": workspace}


def archive_namespace(config):
    return "GenDragoon/" + connection_context(config)["workspaceId"] + "/archives"


class PackReceiverAdapter:
    """Only the transport changes. Existing Codec, AAD and manifests are reused."""
    def __init__(self, config):
        from gendragoon_redx_storage import SECRET, RedXStorageError
        self.config = config
        self.pack_client = RedXPack(config)
        context = connection_context(config)
        self.receiver, self.workspace = context["receiverId"], context["workspaceId"]
        self.secret = config.get("storageSecret")
        if not isinstance(self.secret, str) or not SECRET.fullmatch(self.secret):
            raise PackError("storage_secret_required")
        keymap = config.get("keymapPath")
        if not isinstance(keymap, str) or not Path(keymap).is_absolute() or "\0" in keymap:
            raise PackError("keymap_required")
        self.keymap = Path(keymap)
        # Keep the app's encryption keymap private and outside any selected source.
        root = Path.home() / "Library/Application Support/GenDragoon Cloud SSD/BYOKeymaps"
        if self.keymap != root / (self.receiver + ".rsxkeymap"):
            raise PackError("keymap_context_invalid")
        for parent in (root, *root.parents):
            if parent.is_symlink():
                raise PackError("keymap_unsafe")
            if parent.exists() and (parent == Path.home() or Path.home() in parent.parents):
                info = parent.stat()
                if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
                    raise PackError("keymap_unsafe")
            if parent == Path.home():
                break
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if root.stat().st_uid != os.getuid() or root.stat().st_mode & 0o077:
            raise PackError("keymap_unsafe")
        if self.keymap.is_symlink():
            raise PackError("keymap_unsafe")
        if self.keymap.exists():
            info = self.keymap.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_mode & 0o077:
                raise PackError("keymap_unsafe")

    def verified_workers(self, write=False):
        # Free BYO hosting is a separate serial profile, never a paid-tier grant.
        return 1

    def _path(self, oid):
        if not isinstance(oid, str) or not re.fullmatch(r"[a-f0-9]{32}", oid):
            raise PackError("object_id_invalid")
        transport = self.config.get("archiveSessionId")
        if not isinstance(transport, str) or not re.fullmatch(r"[a-f0-9]{32}", transport):
            raise PackError("archive_context_invalid")
        # RedX pack PUT is mutable and has no CAS. A unique upload namespace
        # prevents concurrent devices from overwriting another archive's nonce.
        return "GenDragoon/" + self.workspace + "/blobs/" + transport + "/" + oid + ".png"

    def get_png(self, oid):
        from gendragoon_redx_storage import MAX_PNG, RedXStorageError
        try:
            data = self.pack_client.get_bytes(self._path(oid), MAX_PNG)
            if data[:8] != b"\x89PNG\r\n\x1a\n":
                raise PackError("png_invalid")
            return data
        except PackError as error:
            raise RedXStorageError(error.message, error.status) from None

    def put_png(self, oid, png):
        from gendragoon_redx_storage import MAX_PNG, RedXStorageError
        if not 8 <= len(png) <= MAX_PNG or png[:8] != b"\x89PNG\r\n\x1a\n":
            raise PackError("png_invalid")
        try:
            # Object IDs are immutable by convention. Reuse first authenticates a
            # committed carrier. Concurrent sessions share the same local lease.
            self.pack_client.put_bytes(self._path(oid), png)
            return {"id": oid, "carrierBytes": len(png), "carrierSha256": hashlib.sha256(png).hexdigest()}
        except PackError as error:
            raise RedXStorageError(error.message, error.status) from None

    def register(self, key, item):
        # Publishing remains in upload_source after a full restore check. The
        # transport's registration acknowledgement contains no plaintext bytes.
        if item.get("workspace") != self.workspace:
            raise PackError("archive_context_invalid")
        return item


def _archive_entry(client, path):
    namespace = archive_namespace(client.config)
    if not isinstance(path, str) or not re.fullmatch(re.escape(namespace) + r"/[a-f0-9]{32}/\.gendragoon-entry\.json", path):
        raise PackError("archive_entry_invalid")
    try:
        value = json.loads(client.get_bytes(path))
    except (ValueError, UnicodeError):
        raise PackError("archive_entry_invalid") from None
    import gendragoon_library as library
    if (not isinstance(value, dict) or value.get("schema") != "gendragoon-byo-archive/v2" or value.get("encrypted") is not True
            or value.get("kind") not in ("app", "file", "folder") or value.get("archiveLayout") != "zip-root"
            or type(value.get("archiveBytes")) is not int or value["archiveBytes"] < 1
            or not re.fullmatch(r"[a-f0-9]{64}", value.get("archiveSha256", ""))
            or not re.fullmatch(r"[a-f0-9]{18}", value.get("key", ""))
            or not re.fullmatch(r"[a-f0-9]{32}", value.get("manifestId", ""))
            or not re.fullmatch(r"[a-f0-9]{32}", value.get("transportId", ""))
            or value.get("workspace") != connection_context(client.config)["workspaceId"]):
        raise PackError("archive_entry_invalid")
    library.check_name(value.get("name"))
    return value


def _restore_checked(library, archive, directory, entry):
    library.validate_archive(archive, entry["name"])
    library.run(["/usr/bin/ditto", "-x", "-k", archive, directory], timeout=900)
    restored = directory / entry["name"]
    if not restored.exists() or restored.is_symlink():
        raise PackError("restore_invalid")
    library.verify_restored(restored, entry["manifest"])
    return restored


def upload_source(client, config):
    """Verified macOS archive; no source removal without explicit offload:true."""
    if sys.platform != "darwin":
        raise PackError("macos_archive_required")
    PackReceiverAdapter(config)  # Fail before archiving if the private context is unavailable.
    import gendragoon_library as library
    source_value = config.get("source")
    if not isinstance(source_value, str) or not source_value:
        raise PackError("source_invalid")
    original = Path(source_value).expanduser().absolute()
    source = original.resolve(strict=True)
    if any(p.is_symlink() for p in (original, *original.parents)):
        raise PackError("source_linked")
    library.ensure_not_cloud(source)
    kind = library.kindof(source)
    if kind == "app" and not (source / "Contents/Info.plist").is_file():
        raise PackError("app_invalid")
    offload = config.get("offload", False)
    if type(offload) is not bool:
        raise PackError("offload_invalid")
    if offload and library.is_running(source):
        raise PackError("source_running", "Quit this application before offloading it.")
    baseline = library.snapshot(source)
    total = sum(v.get("size", 0) for v in baseline["manifest"])
    # The user-chosen path is a logical destination label, never a host filesystem path.
    logical = remote_path(config.get("path", ""), root=True)
    transaction = uuid.uuid4().hex
    entry_dir = archive_namespace(config) + "/" + transaction
    entry_path = entry_dir + "/" + ARCHIVE_ENTRY
    with tempfile.TemporaryDirectory(prefix="gendragoon-byo-") as temporary:
        temporary = Path(temporary).resolve(strict=True)
        library.require_space(total * 3 + 64 * 1024 ** 2, temporary)
        archive = temporary / "archive.zip"
        library.package(source, archive)
        library.unchanged(source, baseline)
        library.validate_archive(archive, source.name)
        digest = library.sha(archive)
        from gendragoon_redx_storage import upload_archive, download_archive
        context = connection_context(config)
        archive_key = hashlib.sha256(transaction.encode()).hexdigest()[:18]
        transfer_config = {**config, "archiveSessionId": transaction}
        uploaded = upload_archive(transfer_config, archive, archive_key, source.name, kind, "zip-root", digest,
                                  baseline["manifest"], client_factory=PackReceiverAdapter)
        entry = {"schema": "gendragoon-byo-archive/v2", "name": source.name, "kind": kind,
                 "archiveLayout": "zip-root", "archiveBytes": archive.stat().st_size,
                 "archiveSha256": digest, "manifestId": uploaded["manifestId"], "key": archive_key,
                 "workspace": context["workspaceId"], "transportId": transaction, "logicalParent": logical,
                 "encrypted": True, "storageLocation": "external-redx-pack"}
        verified = temporary / "readback.zip"
        decrypted = download_archive(transfer_config, entry, verified, client_factory=PackReceiverAdapter)
        if decrypted["manifest"] != baseline["manifest"]:
            raise PackError("metadata_mismatch")
        if library.sha(verified) != digest:
            raise PackError("checksum_mismatch")
        restore = temporary / "restore"
        restore.mkdir(mode=0o700)
        _restore_checked(library, verified, restore, {**entry, "manifest": decrypted["manifest"]})
        library.unchanged(source, baseline)
        # Publish discovery only after remote byte readback and complete metadata restore.
        metadata = json.dumps(entry, separators=(",", ":"), ensure_ascii=False).encode()
        client.put_bytes(entry_path, metadata)
        if client.get_bytes(entry_path) != metadata:
            raise PackError("checksum_mismatch")
        library.unchanged(source, baseline)
        offloaded = False
        if offload:
            if library.is_running(source):
                raise PackError("source_running", "The application started during verification. The original was retained.")
            library.unchanged(source, baseline)
            library.trash(source)
            offloaded = not source.exists()
    return {"entry": entry, "path": entry_path, "verified": True, "offloaded": offloaded, "encrypted": True}


def _publish_exclusive(source, target):
    if sys.platform != "darwin":
        raise PackError("macos_archive_required")
    import ctypes
    # Darwin's atomic no-replace rename prevents a race overwriting a new destination.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renamex_np
    rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(os.fsencode(source), os.fsencode(target), 0x00000004) != 0:  # RENAME_EXCL
        raise PackError("destination_unsafe", "The destination could not be created without replacing an existing item.")


def restore_source(client, config):
    if sys.platform != "darwin":
        raise PackError("macos_archive_required")
    import gendragoon_library as library
    entry = _archive_entry(client, config.get("path"))
    import gendragoon_device_origin as device_origin
    try:
        device_origin.ensure_restore_compatible(entry)
    except ValueError as error:
        raise PackError("application_platform_mismatch", "This application or installer backup requires its matching original platform for restoration.") from error
    destination = config.get("destination")
    if not isinstance(destination, str) or not destination:
        raise PackError("destination_unsafe")
    parent = Path(destination).expanduser().absolute()
    if str(parent.resolve(strict=True)) != str(parent) or not parent.is_dir():
        raise PackError("destination_unsafe")
    target = parent / entry["name"]
    if target.exists() or target.is_symlink():
        raise PackError("destination_unsafe", "An item with this name already exists. It was preserved.")
    from gendragoon_redx_storage import download_archive
    # Extracted byte counts are authenticated inside the encrypted manifest;
    # reserve conservatively before download, then verify exact total below.
    library.require_space(entry["archiveBytes"] * 3 + 64 * 1024 ** 2, parent)
    with tempfile.TemporaryDirectory(prefix=".gendragoon-restore-", dir=parent) as temporary:
        temporary = Path(temporary)
        archive = temporary / "archive.zip"
        decrypted = download_archive({**config, "archiveSessionId": entry["transportId"]}, entry, archive, client_factory=PackReceiverAdapter)
        if library.sha(archive) != entry["archiveSha256"] or archive.stat().st_size != entry["archiveBytes"]:
            raise PackError("checksum_mismatch")
        manifest = decrypted["manifest"]
        total = sum(v.get("size", 0) for v in manifest)
        library.require_space(total + 64 * 1024 ** 2, parent)
        restore = temporary / "restored"
        restore.mkdir(mode=0o700)
        restored = _restore_checked(library, archive, restore, {**entry, "manifest": manifest})
        _publish_exclusive(restored, target)
    return {"destination": str(target), "kind": entry["kind"], "verified": True, "encrypted": True}


def archives(client):
    try:
        folders = client.list(archive_namespace(client.config))["entries"]
    except PackError as error:
        if error.status == 404:
            return {"entries": []}
        raise
    if len(folders) > 1000:
        raise PackError("archive_list_limit")
    result = []
    for folder in folders:
        if not folder["is_dir"] or not re.fullmatch(r"[a-f0-9]{32}", folder["name"]):
            continue
        path = folder["path"] + "/" + ARCHIVE_ENTRY
        try:
            entry = _archive_entry(client, path)
        except PackError as error:
            if error.status == 404:
                continue  # Unpublished interrupted upload: preserve bytes, don't claim a backup.
            raise
        result.append({**{k: v for k, v in entry.items() if k != "manifest"}, "path": path, "format": "gendragoon-byo-archive"})
    return {"entries": result}


def connect_begin(config):
    base = origin(config.get("origin"), config.get("development", False))
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    db = database(config.get("database", "gendragoon"))
    params = {"v": "1", "provider": "gendragoon", "state": state, "pkce_challenge": challenge, "pkce_method": "S256", "workspace": db, "scope": "write", "callback": "gendragoon://redx-callback"}
    return {"url": base + "/#/connect?" + urlencode(params), "state": state, "pkceVerifier": verifier, "origin": base, "database": db}


def connect_exchange(config):
    # No admin credential is requested or accepted by this exchange.
    base = origin(config.get("origin"), config.get("development", False))
    state, verifier, code = config.get("state"), config.get("pkceVerifier"), config.get("code")
    if not isinstance(state, str) or not re.fullmatch(r"[A-Za-z0-9_-]{22,128}", state) or not isinstance(verifier, str) or not re.fullmatch(r"[A-Za-z0-9._~-]{43,128}", verifier) or not isinstance(code, str) or not re.fullmatch(r"RX-[A-Z0-9-]{5,64}", code):
        raise PackError("connect_input_invalid")
    u = urlsplit(base)
    connection = http.client.HTTPSConnection(u.hostname, u.port, timeout=60, context=ssl.create_default_context()) if u.scheme == "https" else http.client.HTTPConnection(u.hostname, u.port, timeout=60)
    try:
        payload = json.dumps({"code": code, "state": state, "pkce_verifier": verifier, "device_label": "GenDragoon Cloud SSD"}).encode()
        connection.request("POST", "/v1/connect/exchange", payload, {"Content-Type": "application/json"})
        response = connection.getresponse()
        _check(response, (200,))
        data = _json(response)
        db = database(data.get("workspace", {}).get("db"))
        key = data.get("key")
        if data.get("api") != "v1" or not isinstance(key, str) or not re.fullmatch(r"rx_live_[A-Za-z0-9]+", key) or data.get("scope") not in ("read", "write"):
            raise PackError("response_invalid")
        # This action is the sole intentional creation-only secret response.
        return {"origin": base, "database": db, "pack": pack_name(config.get("pack", "gendragoon")), "key": key, "keyId": data.get("key_id"), "connectionId": data.get("connection_id"), "scope": data["scope"], "prefix": data.get("prefix", ""), "warning": "Save the key in Keychain now. It is shown only once."}
    finally:
        connection.close()


def run(action, config):
    if action == "context":
        context = connection_context(config)
        return {**context, "keymapPath": str(Path.home() / "Library/Application Support/GenDragoon Cloud SSD/BYOKeymaps" / (context["receiverId"] + ".rsxkeymap"))}
    if action == "connect-begin":
        return connect_begin(config)
    if action == "connect-exchange":
        return connect_exchange(config)
    client = RedXPack(config)
    path = config.get("path", "")
    if action == "probe":
        conn, response = client._request("GET", "/v1/ui/whoami")
        try:
            _check(response, (200,))
            principal = _json(response)
            if principal.get("host_admin") is not False or principal.get("scope") not in ("read", "write") or principal.get("db") != client.database:
                raise PackError("scoped_database_key_required", "Use a read or write key scoped to this database. GenDragoon does not need a host administrator key.")
        finally:
            conn.close()
        try:
            result = client.list(path)
            return {"reachable": True, "authorized": True, "packExists": True, "scope": principal["scope"], **result}
        except PackError as error:
            if error.status != 404:
                raise
            return {"reachable": True, "authorized": True, "packExists": False, "scope": principal["scope"], "path": path, "entries": [], "verificationRequired": True}
    if action == "upload-source":
        import gendragoon_library as library
        with library.maintenance_lock():
            return upload_source(client, config)
    if action == "restore-source":
        import gendragoon_library as library
        with library.maintenance_lock():
            return restore_source(client, config)
    if action == "archives":
        return archives(client)
    if action == "list":
        return client.list(path)
    if action == "tree":
        return client.tree(path)
    if action == "put":
        return {"file": client.put(path, config.get("source", "")), "verified": True}
    if action == "get":
        return {"file": client.get(path, config.get("destination", ""))}
    if action == "mkdir":
        return {"folder": client.mkdir(path)}
    if action == "delete":
        return client.delete(path)
    if action == "revoke":
        conn, response = client._request("POST", "/v1/connect/revoke", b"", {"Content-Type": "application/json"})
        try:
            _check(response, (200,))
            data = _json(response)
            if data.get("revoked") is not True:
                raise PackError("response_invalid")
            return {"revoked": True, "externalDataDeleted": False}
        finally:
            conn.close()
    raise PackError("action_invalid")


def main():
    try:
        if sys.argv[1:] in (["--help"], ["-h"]):
            print("usage: gendragoon_redx_pack.py ACTION\nGenDragoon RedX BYO pack client. Actions: context, probe, list, tree, archives, put, get, mkdir, delete, upload-source, restore-source, connect-begin, connect-exchange, revoke. Private connection JSON arrives only on stdin.")
            return 0
        if len(sys.argv) != 2:
            raise PackError("action_invalid")
        payload = sys.stdin.buffer.read(32769)
        if len(payload) > 32768:
            raise PackError("input_too_large")
        config = json.loads(payload)
        if not isinstance(config, dict):
            raise PackError("input_invalid")
        result = {"ok": True, "action": sys.argv[1], **run(sys.argv[1], config)}
        print(json.dumps(result, separators=(",", ":"), allow_nan=False))
        return 0
    except PackError as error:
        result = {"ok": False, "error": error.code, "message": error.message}
        if error.status:
            result["status"] = error.status
    except (OSError, http.client.HTTPException, ssl.SSLError):
        result = {"ok": False, "error": "transfer_failed", "message": "The transfer did not finish. The source and any existing destination were preserved."}
    except (ValueError, TypeError, KeyError):
        result = {"ok": False, "error": "input_invalid", "message": "The request or host response was invalid."}
    except (RuntimeError, subprocess.SubprocessError, zipfile.BadZipFile):
        result = {"ok": False, "error": "verification_failed", "message": "The backup or restored metadata did not verify. The source was retained."}
    except ImportError:
        result = {"ok": False, "error": "runtime_unavailable", "message": "The bundled encryption or image runtime is unavailable. Repair the app installation before transferring encrypted backups."}
    print(json.dumps(result, separators=(",", ":")))
    return 1




if __name__ == "__main__":
    raise SystemExit(main())
