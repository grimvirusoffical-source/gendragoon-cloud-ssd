"""Mode-selecting transfer adapter. The pinned encrypted transport stays unchanged.

Legacy encrypted archives always use the original Red-SecretsXAI client. Users
must explicitly opt out for each queued new upload; restoring an existing
archive selects its immutable format by checking its authenticated PNG header.
"""
# Signed app resources must remain immutable, even for a bare helper CLI.
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import hashlib
import json
import os
from pathlib import Path
import zlib

import gendragoon_redx_storage as encrypted
import gendragoon_fast_png as fast
from gendragoon_device_origin import validate_origin, application_platform, validate_application_platform
import gendragoon_progress as progress

# Export unchanged Receiver helpers for the existing macOS, desktop and Android clients.
from gendragoon_redx_storage import *  # noqa: F401,F403

def __getattr__(name):
    # Existing platform clients also use private, reviewed storage helpers.
    # Forward them without changing any code in the pinned encrypted module.
    return getattr(encrypted, name)

def _expected_plain_manifest(item):
    # Receiver copy operations create a new library key while retaining the
    # original immutable archive key; they must not require reuploading bytes.
    archive_key = item.get("archiveKey") or item.get("key")
    if not isinstance(archive_key, str) or not encrypted.KEY.fullmatch(archive_key):
        raise encrypted.RedXStorageError("Unencrypted archive identity is invalid")
    return encrypted.object_id(fast.PROFILE + "-root-manifest", item["archiveSha256"], archive_key)

def codec_for_item(client, item):
    manifest_id = item.get("manifestId")
    if not isinstance(manifest_id, str) or not encrypted.ID.fullmatch(manifest_id):
        raise encrypted.RedXStorageError("Cloud library manifest id is invalid")
    carrier = client.get_png(manifest_id)
    if not fast.is_plain_carrier(carrier):
        return encrypted.Codec(client)
    if manifest_id != _expected_plain_manifest(item):
        raise encrypted.RedXStorageError("Unencrypted manifest has an unexpected immutable object identity")
    return PlainCodec(client)

class PlainCodec:
    def __init__(self, client):
        self.client = client

    def __enter__(self):
        return self

    def __exit__(self, *exception):
        return False

    def worker(self, client):
        return PlainCodec(client)

    def seal(self, plain, oid):
        progress.activity("encoding", during=("encoding", "uploading"))
        try:
            return fast.encode(bytes(plain), oid)
        except fast.PlainCarrierError as error:
            raise encrypted.RedXStorageError(str(error)) from error

    def open(self, png, oid):
        try:
            return fast.decode(png, oid)
        except fast.PlainCarrierError as error:
            raise encrypted.RedXStorageError(str(error)) from error

def upload_archive(config, archive, key, name, kind, archive_layout, archive_sha,
                   source_manifest, parent_key=None, client_factory=None, origin=None,
                   *, encryption=True):
    if type(encryption) is not bool:
        raise encrypted.RedXStorageError("Select an explicit encryption option")
    if encryption:
        return encrypted.upload_archive(
            config, archive, key, name, kind, archive_layout, archive_sha,
            source_manifest, parent_key, client_factory, origin)
    origin = validate_origin(origin)
    platform = application_platform(name, kind)
    client = (client_factory or encrypted.RedXReceiver)(config)
    workers = client.verified_workers(write=True)
    # Prevent attempts against an older live Receiver that only accepts
    # Red-SecretsXAI carriers. A preflight failure cannot write cloud objects.
    if callable(getattr(client, "json", None)):
        capabilities = client.json("/v1/receivers/me")
        if (capabilities.get("id") != client.receiver
                or fast.PROFILE not in capabilities.get("supportedStorageFormats", [])):
            raise encrypted.RedXStorageError(
                "The Red-XAI Receiver has not activated fast unencrypted storage. "
                "Keep encryption enabled until the Receiver upgrade is live.")
    archive = Path(archive)
    if not archive.is_file() or archive.is_symlink():
        raise encrypted.RedXStorageError("Prepared archive changed before upload")
    archive_bytes = archive.stat().st_size
    if not archive_bytes or encrypted.sha256_file(archive) != archive_sha:
        raise encrypted.RedXStorageError("Prepared archive changed before upload")
    # The fast format has its own object-id namespace; encrypted objects cannot
    # collide with cleartext objects even if an archive has the same SHA-256.
    profile = fast.PROFILE
    progress.phase("uploading", total_bytes=archive_bytes * 2, workers=workers,
                   objects_done=0, objects_total=(archive_bytes + fast.MAX_PAYLOAD - 1) // fast.MAX_PAYLOAD)
    chunks = []
    with PlainCodec(client) as codec, archive.open("rb") as stream:
        def parts():
            for index, plain in enumerate(iter(lambda: stream.read(fast.MAX_PAYLOAD), b"")):
                yield index, plain
        def upload(worker, value):
            index, plain = value
            oid = encrypted.object_id(profile + "-archive-chunk", archive_sha, index)
            reused = True
            def encoded_part(count):
                nonlocal reused
                reused = False
                progress.advance(count, encoded_bytes=count)
            record = encrypted._put_plain(worker.client, worker, oid, plain, on_encoded=encoded_part)
            if reused:
                progress.advance(len(plain))
            progress.advance(len(plain), objects_done=1)
            record["index"] = index
            return record
        allowance = min(workers, max(1, (archive_bytes + fast.MAX_PAYLOAD - 1) // fast.MAX_PAYLOAD))
        chunks.extend(encrypted._parallel_chunks(client, codec, allowance, parts(), upload))
        if not chunks:
            raise encrypted.RedXStorageError("Refusing empty archive")
        progress.update(phase="publishing")
        pages = encrypted._json_pages(client, codec, profile + "-archive-page", archive_sha, chunks)
        metadata_raw = json.dumps(source_manifest, separators=(",", ":"), ensure_ascii=False).encode()
        metadata_sha = encrypted.sha256_bytes(metadata_raw)
        compressed = zlib.compress(metadata_raw, 9)
        metadata_parts = []
        for offset in range(0, len(compressed), encrypted.CHUNK):
            part = compressed[offset:offset + encrypted.CHUNK]
            oid = encrypted.object_id(profile + "-metadata", archive_sha, metadata_sha, offset // encrypted.CHUNK)
            metadata_parts.append(encrypted._put_plain(client, codec, oid, part))
        metadata_pages = encrypted._json_pages(client, codec, profile + "-metadata-page", archive_sha, metadata_parts)
        root = {
            "schema": encrypted.ROOT_SCHEMA, "storageProfile": profile, "encryptionMode": "off",
            "chunkBytes": fast.MAX_PAYLOAD,
            "key": key, "name": name, "kind": kind, "archiveLayout": archive_layout,
            "archiveBytes": archive_bytes, "archiveSha256": archive_sha,
            "chunkCount": len(chunks), "chunkPages": pages,
            "metadata": {
                "schema": encrypted.METADATA_SCHEMA, "encoding": "zlib-json",
                "jsonBytes": len(metadata_raw), "jsonSha256": metadata_sha,
                "partPages": metadata_pages,
            },
        }
        root_raw = json.dumps(root, separators=(",", ":"), ensure_ascii=False).encode()
        if len(root_raw) > encrypted.CHUNK:
            raise encrypted.RedXStorageError("Plain archive index too large")
        manifest_id = encrypted.object_id(profile + "-root-manifest", archive_sha, key)
        root_record = encrypted._put_plain(client, codec, manifest_id, root_raw)
        catalog = {
            "name": name, "kind": kind, "workspace": client.workspace,
            "manifestId": manifest_id, "archiveBytes": archive_bytes,
            "archiveSha256": archive_sha, "parentKey": parent_key,
            "applicationPlatform": platform,
        }
        if origin is not None:
            catalog["origin"] = origin
        registered = client.register(key, catalog)
        if registered.get("manifestId") != manifest_id or registered.get("name") != name:
            raise encrypted.RedXStorageError("Receiver library registration mismatch")
        actual_origin = validate_origin(registered.get("origin"))
        actual_platform = validate_application_platform(registered.get("applicationPlatform"))
        return {"manifestId": manifest_id, "rootRecord": root_record, "chunks": len(chunks),
                "encrypted": False, "origin": actual_origin,
                "applicationPlatform": actual_platform,
                "archiveBytes": archive_bytes, "archiveSha256": archive_sha}

def download_archive(config, item, destination, client_factory=None):
    """Do not use the encryption secret to restore a consciously unencrypted item.

    Existing encrypted PNGs delegate to the original decryptor, byte for byte.
    A forged or damaged marker can never silently fall back to a different codec:
    plaintext decoding is strict and aborts before publishing the local archive.
    """
    manifest_id = item.get("manifestId")
    if not isinstance(manifest_id, str) or encrypted.ID.fullmatch(manifest_id) is None:
        raise encrypted.RedXStorageError("Cloud library manifest id is invalid")
    client = (client_factory or encrypted.RedXReceiver)(config)
    carrier = client.get_png(manifest_id)
    if not fast.is_plain_carrier(carrier):
        return encrypted.download_archive(config, item, destination, client_factory=client_factory)
    if manifest_id != _expected_plain_manifest(item):
        raise encrypted.RedXStorageError("Unencrypted manifest has an unexpected immutable object identity")
    workers = client.verified_workers()
    target = Path(destination)
    if target.exists() or target.is_symlink():
        raise encrypted.RedXStorageError("Restore target already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    progress.phase("readback", total_bytes=item.get("archiveBytes", 0), workers=workers)
    with PlainCodec(client) as codec:
        plain = codec.open(carrier, manifest_id)
        try:
            root = json.loads(plain)
        except (ValueError, TypeError) as error:
            raise encrypted.RedXStorageError("Unencrypted root index is invalid") from error
        if (not isinstance(root, dict)
                or root.get("schema") != encrypted.ROOT_SCHEMA
                or root.get("storageProfile") != fast.PROFILE
                or root.get("encryptionMode") != "off"
                or any(root.get(field) != item.get(field) for field in
                       ("name", "kind", "archiveBytes", "archiveSha256"))
                or not isinstance(root.get("chunkPages"), list)
                or not isinstance(root.get("metadata"), dict)):
            raise encrypted.RedXStorageError("Unencrypted root index does not match Receiver library")
        chunks = encrypted._load_pages(client, codec, root["chunkPages"])
        if len(chunks) != root.get("chunkCount") or any(
                not isinstance(row, dict) or row.get("index") != idx
                for idx, row in enumerate(chunks)):
            raise encrypted.RedXStorageError("Unencrypted archive chunk index is invalid")
        meta = root["metadata"]
        parts = encrypted._load_pages(client, codec, meta.get("partPages"))
        if meta.get("schema") != encrypted.METADATA_SCHEMA or meta.get("encoding") != "zlib-json":
            raise encrypted.RedXStorageError("Unencrypted archive metadata is invalid")
        if not isinstance(parts, list) or len(parts) > 8192:
            raise encrypted.RedXStorageError("Unencrypted archive metadata has too many chunks")
        compressed_chunks = []
        compressed_size = 0
        for record in parts:
            data = encrypted._get_plain(client, codec, record)
            compressed_size += len(data)
            if compressed_size > 256 * 1024 * 1024:
                raise encrypted.RedXStorageError("Unencrypted archive metadata exceeds its limit")
            compressed_chunks.append(data)
        compressed = b"".join(compressed_chunks)
        expected = meta.get("jsonBytes")
        if type(expected) is not int or not 0 < expected <= 256 * 1024 * 1024:
            raise encrypted.RedXStorageError("Unencrypted metadata exceeds its safe limit")
        decoder = zlib.decompressobj()
        try:
            raw = decoder.decompress(compressed, expected + 1)
            if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                raise encrypted.RedXStorageError("Unencrypted metadata compression is invalid")
        except zlib.error as error:
            raise encrypted.RedXStorageError("Unencrypted metadata decompression failed") from error
        if len(raw) != expected or encrypted.sha256_bytes(raw) != meta.get("jsonSha256"):
            raise encrypted.RedXStorageError("Unencrypted metadata failed SHA-256 verification")
        try:
            manifest = json.loads(raw)
        except (ValueError, TypeError) as error:
            raise encrypted.RedXStorageError("Unencrypted source manifest is invalid") from error
        if not isinstance(manifest, list):
            raise encrypted.RedXStorageError("Unencrypted source manifest is invalid")
        hasher = hashlib.sha256()
        total = 0
        partial = target.with_name("." + target.name + ".partial")
        try:
            with partial.open("xb") as output:
                for plain in encrypted._parallel_chunks(
                        client, codec, min(workers, max(1, len(chunks))), chunks,
                        lambda worker, row: encrypted._get_plain(worker.client, worker, row)):
                    output.write(plain)
                    hasher.update(plain)
                    total += len(plain)
                    progress.advance(len(plain), objects_done=1)
                output.flush()
                os.fsync(output.fileno())
            if total != root["archiveBytes"] or hasher.hexdigest() != root["archiveSha256"]:
                raise encrypted.RedXStorageError("Unencrypted archive failed SHA-256 readback")
            protect = getattr(client, "protect_download", None)
            if protect is not None:
                protect(partial)
            os.replace(partial, target)
        finally:
            if partial.exists():
                partial.unlink()
        return {"root": root, "manifest": manifest, "archive": str(target)}


def read_archive_manifest(config, item, client_factory=None):
    """Read an authenticated source manifest *without* downloading its app bytes.

    Offloaded apps and a new device may have no local size manifest. Fetching
    only the root and metadata pages permits a conservative cache-budget check
    before downloading anything large. Both legacy Red-SecretsXAI and opt-out
    plaintext carriers use their original immutable, authenticated identity.
    """
    client = (client_factory or encrypted.RedXReceiver)(config)
    client.verified_workers()
    manifest_id = item.get("manifestId")
    if not isinstance(manifest_id, str) or not encrypted.ID.fullmatch(manifest_id):
        raise encrypted.RedXStorageError("Invalid cloud manifest id")
    carrier = client.get_png(manifest_id)
    plain_mode = fast.is_plain_carrier(carrier)
    if plain_mode and manifest_id != _expected_plain_manifest(item):
        raise encrypted.RedXStorageError("Unencrypted cloud manifest identity mismatch")

    def metadata(codec, root):
        detail = root.get("metadata")
        if not isinstance(detail, dict) or detail.get("schema") != encrypted.METADATA_SCHEMA or detail.get("encoding") != "zlib-json":
            raise encrypted.RedXStorageError("Cloud app metadata index is invalid")
        references = detail.get("partPages")
        parts = encrypted._load_pages(client, codec, references) if references is not None else detail.get("parts")
        if not isinstance(parts, list) or len(parts) > 8192:
            raise encrypted.RedXStorageError("Cloud app metadata parts are invalid")
        expected = detail.get("jsonBytes")
        if type(expected) is not int or not 1 <= expected <= 256 * 1024 * 1024:
            raise encrypted.RedXStorageError("Cloud app metadata size exceeds its limit")
        compressed = bytearray()
        for record in parts:
            compressed.extend(encrypted._get_plain(client, codec, record))
            if len(compressed) > 256 * 1024 * 1024:
                raise encrypted.RedXStorageError("Cloud app compressed metadata exceeds its limit")
        decoder = zlib.decompressobj()
        try:
            raw = decoder.decompress(bytes(compressed), expected + 1)
            if not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
                raise encrypted.RedXStorageError("Cloud app metadata compression is invalid")
        except zlib.error as error:
            raise encrypted.RedXStorageError("Cloud app metadata decompression failed") from error
        if len(raw) != expected or encrypted.sha256_bytes(raw) != detail.get("jsonSha256"):
            raise encrypted.RedXStorageError("Cloud app metadata SHA-256 failed")
        try:
            manifest = json.loads(raw)
        except (ValueError, TypeError) as error:
            raise encrypted.RedXStorageError("Cloud app source manifest is invalid") from error
        if not isinstance(manifest, list) or not 1 <= len(manifest) <= 1000000 or any(
                not isinstance(part, dict) or not isinstance(part.get("path"), str)
                for part in manifest):
            raise encrypted.RedXStorageError("Cloud app source manifest is invalid")
        return {"root": root, "manifest": manifest}

    if plain_mode:
        with PlainCodec(client) as codec:
            try:
                root = json.loads(codec.open(carrier, manifest_id))
            except (ValueError, TypeError) as error:
                raise encrypted.RedXStorageError("Unencrypted cloud root index is invalid") from error
            if (not isinstance(root, dict) or root.get("schema") != encrypted.ROOT_SCHEMA
                    or root.get("storageProfile") != fast.PROFILE
                    or root.get("encryptionMode") != "off"
                    or any(root.get(name) != item.get(name) for name in
                           ("name", "kind", "archiveBytes", "archiveSha256"))
                    or not isinstance(root.get("chunkPages"), list)):
                raise encrypted.RedXStorageError("Unencrypted cloud root does not match library")
            return metadata(codec, root)
    with encrypted.Codec(client) as codec:
        root, _ = encrypted._root_for_item(client, codec, item)
        return metadata(codec, root)


if __name__ == "__main__":
    # Production clients import this module as a library; expose only help as
    # a standalone signed helper. No cloud request or file content is touched.
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    parser.print_help()
