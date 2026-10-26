"""Receiver-authorized concurrency, ordered restoration and resumable chunks."""
import io
import json
import os
import struct
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import zlib
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Resources"))
import gendragoon_redx_storage as storage
import gendragoon_performance as performance


def config(directory, **updates):
    return dict(provider="redxai", cloudApi=storage.API, workspaceId="a" * 32,
                receiverId="b" * 64, bearerToken="rxca_" + "T" * 43,
                storageSecret="S" * 43, keymapPath=str(Path(directory) / "keymap"),
                workers=20, **updates)


def entitlement(value, workers=2, **updates):
    return {"id": value["receiverId"], "state": "ready", "workspaces": [dict(
        id=value["workspaceId"], active=True, readOnly=False,
        quotaBytes=100_000_000_000, workers=workers, **updates)]}


class FixtureCodec:
    created = []
    seals = 0
    lock = threading.Lock()

    def __init__(self, client):
        self.client = client
        self.owner = None

    def __enter__(self):
        self.created.append(threading.current_thread().name)
        return self

    def __exit__(self, *exc):
        return False

    def worker(self, client):
        return FixtureCodec(client).__enter__()

    def seal(self, plain, oid):
        with self.lock:
            type(self).seals += 1
            nonce = type(self).seals.to_bytes(8, "big")
        return nonce + bytes.fromhex(oid) + plain

    def open(self, png, oid):
        if png[8:24] != bytes.fromhex(oid):
            raise storage.RedXStorageError("Fixture associated context mismatch")
        return png[24:]


class FixtureReceiver:
    blobs = {}
    items = {}
    allowance = 1
    writes = 0

    def __init__(self, value):
        self.config = value
        self.workspace = value["workspaceId"]
        self.receiver = value["receiverId"]
        self.secret = value["storageSecret"]
        self.keymap = Path(value["keymapPath"])

    def verified_workers(self, write=False):
        return self.allowance

    def get_png(self, oid):
        if oid not in self.blobs:
            raise storage.RedXStorageError("Fixture missing", 404)
        # Completion order varies deliberately; archive order must not.
        time.sleep(.001 * (int(oid[-1], 16) % 3))
        return self.blobs[oid]

    def put_png(self, oid, png):
        if oid in self.blobs and self.blobs[oid] != png:
            raise storage.RedXStorageError("Fixture immutable conflict", 409)
        self.blobs[oid] = png
        type(self).writes += 1
        return {"id": oid, "carrierBytes": len(png), "carrierSha256": storage.sha256_bytes(png)}

    def register(self, key, item):
        self.items[key] = dict(item, key=key)
        return self.items[key]


class RedXPerformanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="gd-redx-performance-")
        self.addCleanup(self.directory.cleanup)
        self.config = config(self.directory.name)
        FixtureCodec.created = []
        FixtureCodec.seals = 0
        FixtureReceiver.blobs = {}
        FixtureReceiver.items = {}
        FixtureReceiver.writes = 0
        performance._active = None
        performance._input = None

    def test_authenticated_receiver_limits_override_untrusted_stdin_and_fail_closed(self):
        client = storage.RedXReceiver(self.config)
        with patch.object(client, "json", return_value=entitlement(self.config, 2)) as request:
            self.assertEqual(client.verified_workers(write=True), 2)
            request.assert_called_once_with("/v1/receivers/me")
        for workers in (True, 25, -1, "20"):
            with self.subTest(workers=workers), patch.object(client, "json", return_value=entitlement(self.config, workers)):
                with self.assertRaises(storage.RedXStorageError):
                    client.verified_workers()
        wrong = entitlement(self.config)
        wrong["id"] = "c" * 64
        with patch.object(client, "json", return_value=wrong):
            with self.assertRaises(storage.RedXStorageError):
                client.verified_workers()

    def test_lapsed_workspace_only_permits_single_worker_recovery_and_constrained_is_one(self):
        client = storage.RedXReceiver(self.config)
        response = entitlement(self.config, 0)
        response["workspaces"][0].update(active=False, readOnly=True, quotaBytes=0)
        with patch.object(client, "json", return_value=response):
            self.assertEqual(client.verified_workers(), 1)
            with self.assertRaisesRegex(storage.RedXStorageError, "active storage"):
                client.verified_workers(write=True)
        client = storage.RedXReceiver(dict(self.config, constrained=True))
        with patch.object(client, "json", return_value=entitlement(self.config, 20)):
            self.assertEqual(client.verified_workers(write=True), 1)

    def test_native_performance_queries_receiver_and_offline_cannot_claim_paid_workers(self):
        with patch.object(storage.RedXReceiver, "json", return_value=entitlement(self.config, 4)):
            result = performance.configure_from_stdin(io.BytesIO(json.dumps(self.config).encode()))
        self.assertTrue(result["verified"])
        self.assertEqual(result["workers"], 4)
        self.assertNotIn(self.config["bearerToken"], json.dumps(result))
        with patch.object(storage.RedXReceiver, "json", side_effect=storage.RedXStorageError("offline")):
            result = performance.configure_from_stdin(io.BytesIO(json.dumps(self.config).encode()))
        self.assertFalse(result["verified"])
        self.assertEqual(result["workers"], 1)
        self.assertEqual(performance.private_payload()["workspaceId"], self.config["workspaceId"])

    def test_every_tier_runs_actual_bounded_parallel_work_with_independent_clients(self):
        for workers in (1, 2, 4, 8, 12, 20):
            with self.subTest(workers=workers):
                FixtureCodec.created = []
                client = FixtureReceiver(self.config)
                active = 0
                maximum = 0
                lock = threading.Lock()
                barrier = threading.Barrier(workers)
                supplied = []
                def values():
                    for index in range(workers * 2):
                        supplied.append(index)
                        yield index
                def operation(codec, index):
                    nonlocal active, maximum
                    with lock:
                        if codec.owner is None:
                            codec.owner = threading.get_ident()
                        self.assertEqual(codec.owner, threading.get_ident())
                        active += 1
                        maximum = max(maximum, active)
                    barrier.wait(timeout=5)
                    time.sleep(.001 * (workers - index % workers))
                    with lock:
                        active -= 1
                    return index
                with patch.object(storage, "Codec", FixtureCodec), patch.object(storage, "RedXReceiver", FixtureReceiver):
                    with FixtureCodec(client) as codec:
                        results = storage._parallel_chunks(client, codec, workers, values(), operation)
                        self.assertEqual(next(results), 0)
                        self.assertEqual(len(supplied), workers)
                        self.assertEqual([0, *results], list(range(workers * 2)))
                self.assertEqual(maximum, workers)
                self.assertEqual(FixtureCodec.created, [threading.current_thread().name] * workers)

    def test_keymap_unlocks_once_and_native_session_calls_are_serialized(self):
        runtime = unittest.mock.MagicMock()
        runtime.session_open.return_value.__enter__.return_value = object()
        active = 0
        maximum = 0
        lock = threading.Lock()
        def native_copy(session, source, out_path, aad):
            nonlocal active, maximum
            with lock:
                active += 1
                maximum = max(maximum, active)
            time.sleep(.001)
            Path(out_path).write_bytes(Path(source).read_bytes())
            with lock:
                active -= 1
        runtime.encrypt_file.side_effect = native_copy
        runtime.decrypt_file.side_effect = native_copy
        client = storage.RedXReceiver(self.config)
        def roundtrip(codec, index):
            oid = storage.object_id("lock-fixture", index)
            plain = ("fixture-%s" % index).encode()
            self.assertEqual(codec.open(codec.seal(plain, oid), oid), plain)
            return index
        with patch.object(storage, "_crypto_runtime"), patch.object(storage, "rsx", runtime), \
                patch.object(storage, "encode_image", side_effect=lambda b, **k: b"\x89PNG\r\n\x1a\n" + bytes(8) + struct.pack(">II", 1, 1) + b), \
                patch.object(storage, "decode_storage_image", side_effect=lambda b: b[24:]):
            with storage.Codec(client) as codec:
                self.assertEqual(list(storage._parallel_chunks(client, codec, 20, range(40), roundtrip)), list(range(40)))
        self.assertEqual(runtime.session_open.call_count, 1)
        self.assertEqual(maximum, 1)

    def test_parallel_upload_restore_and_retry_reuse_authenticated_immutable_carriers(self):
        for workers in (1, 2, 4, 8, 12, 20):
            with self.subTest(workers=workers):
                FixtureReceiver.allowance = workers
                FixtureReceiver.blobs = {}
                FixtureReceiver.items = {}
                FixtureReceiver.writes = 0
                data = bytes(range(256)) * (workers + 1) + b"tail"
                source = Path(self.directory.name) / ("archive-%s" % workers)
                source.write_bytes(data)
                key = "c" * 18
                source_manifest = [{"path": "file", "size": len(data)}]
                with patch.object(storage, "CHUNK", 2048), patch.object(storage, "Codec", FixtureCodec), patch.object(storage, "RedXReceiver", FixtureReceiver):
                    # Use >workers chunks, including an incomplete final chunk.
                    data = data * 9
                    source.write_bytes(data)
                    arguments = (self.config, source, key, "file", "file", "flat", storage.sha256_bytes(data), source_manifest)
                    result = storage.upload_archive(*arguments)
                    count = FixtureReceiver.writes
                    repeated = storage.upload_archive(*arguments)
                    self.assertEqual(FixtureReceiver.writes, count)
                    self.assertEqual(result, repeated)
                    target = Path(self.directory.name) / ("restored-%s" % workers)
                    restored = storage.download_archive(self.config, FixtureReceiver.items[key], target)
                    self.assertEqual(target.read_bytes(), data)
                    self.assertEqual(restored["manifest"], source_manifest)
                    oid = storage.object_id(storage.VISUAL_PROFILE + "-archive-chunk", storage.sha256_bytes(data), 0)
                    FixtureReceiver.blobs[oid] += b"changed"
                    with self.assertRaisesRegex(storage.RedXStorageError, "does not match"):
                        storage.upload_archive(*arguments)

    def test_rate_limit_retry_is_bounded_and_preserves_the_same_request_body(self):
        client = storage.RedXReceiver(self.config)
        response = unittest.mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.headers = {}
        response.read.return_value = b'{}'
        error = lambda: urllib.error.HTTPError(storage.API, 429, "Busy", {"Retry-After": "1"}, None)
        with patch.object(client.opener, "open", side_effect=[error(), error(), response]) as request, patch.object(storage.time, "sleep") as sleep:
            client._request("/v1/receivers/me", "PUT", b"identical-body")
            self.assertEqual(request.call_count, 3)
            self.assertEqual([c.args[0].data for c in request.call_args_list], [b"identical-body"] * 3)
            self.assertEqual(sleep.call_count, 2)
        def busy(*args, **kwargs):
            raise error()
        with patch.object(client.opener, "open", side_effect=busy) as request, patch.object(storage.time, "sleep"):
            with self.assertRaises(storage.RedXStorageError) as caught:
                client._request("/v1/receivers/me")
            self.assertEqual(caught.exception.status, 429)
            self.assertEqual(request.call_count, 6)

    @unittest.skipUnless(os.environ.get("GD_RED_XAI_REAL_CRYPTO_TEST") == "1", "requires built librsx and Pillow")
    def test_real_twenty_worker_encryption_and_authenticated_restore(self):
        client = storage.RedXReceiver(self.config)
        values = [(index, os.urandom(1024)) for index in range(40)]
        def roundtrip(codec, value):
            index, plain = value
            oid = storage.object_id("parallel-crypto-fixture", index)
            png = codec.seal(plain, oid)
            self.assertEqual(codec.open(png, oid), plain)
            return index
        with storage.Codec(client) as codec:
            self.assertEqual(list(storage._parallel_chunks(client, codec, 20, values, roundtrip)), list(range(40)))

    def test_manifest_indexes_stay_bounded_and_large_archives_preserve_record_order(self):
        client = FixtureReceiver(self.config)
        records = [{"index": i, "id": "%032x" % i, "plainBytes": 64,
                    "plainSha256": "a" * 64, "carrierSha256": "b" * 64} for i in range(1000)]
        with patch.object(storage, "CHUNK", 2048), FixtureCodec(client) as codec:
            pages = storage._json_pages(client, codec, "hierarchy-fixture", "c" * 64, records)
            self.assertLessEqual(len(json.dumps(pages, separators=(",", ":")).encode()), 512)
            self.assertEqual(storage._load_pages(client, codec, pages), records)
            for oid, png in FixtureReceiver.blobs.items():
                self.assertLessEqual(len(codec.open(png, oid)), 2048)

    def test_legacy_v1_manifest_and_flat_metadata_parts_still_restore(self):
        client = FixtureReceiver(self.config)
        plain = b"preexisting archive bytes"
        manifest = [{"path": "old-file", "size": len(plain)}]
        with FixtureCodec(client) as codec:
            record = storage._put_plain(client, codec, "1" * 32, plain)
            record["index"] = 0
            page = storage._put_plain(client, codec, "2" * 32,
                json.dumps({"schema": storage.PAGE_SCHEMA, "records": [record]}).encode())
            raw = json.dumps(manifest).encode()
            part = storage._put_plain(client, codec, "3" * 32, zlib.compress(raw))
            root = {"schema": storage.LEGACY_ROOT_SCHEMA, "name": "old-file", "kind": "file",
                "archiveBytes": len(plain), "archiveSha256": storage.sha256_bytes(plain),
                "chunkCount": 1, "chunkPages": [page], "metadata": {"schema": storage.METADATA_SCHEMA,
                    "encoding": "zlib-json", "jsonBytes": len(raw), "jsonSha256": storage.sha256_bytes(raw), "parts": [part]}}
            storage._put_plain(client, codec, "4" * 32, json.dumps(root).encode())
        item = dict(name="old-file", kind="file", manifestId="4" * 32,
            archiveBytes=len(plain), archiveSha256=storage.sha256_bytes(plain))
        target = Path(self.directory.name) / "old-restored"
        with patch.object(storage, "RedXReceiver", FixtureReceiver), patch.object(storage, "Codec", FixtureCodec):
            restored = storage.download_archive(self.config, item, target)
        self.assertEqual(target.read_bytes(), plain)
        self.assertEqual(restored["manifest"], manifest)

    @unittest.skipUnless(os.environ.get("GD_RED_XAI_REAL_CRYPTO_TEST") == "1", "requires built librsx, NumPy and Pillow")
    def test_genuine_visual_barcode_upload_restore_and_legacy_compact_readback(self):
        from redsecretsxai import encode_storage_image
        data = os.urandom(storage.CHUNK + 123)
        source = Path(self.directory.name) / "visual-source"
        source.write_bytes(data)
        key = "c" * 18
        source_manifest = [{"path": "visual-source", "size": len(data)}]
        FixtureReceiver.allowance = 4
        with patch.object(storage, "RedXReceiver", FixtureReceiver):
            result = storage.upload_archive(self.config, source, key, "visual-source", "file", "flat",
                storage.sha256_bytes(data), source_manifest)
            self.assertEqual(result["chunks"], 2)
            for png in FixtureReceiver.blobs.values():
                self.assertLessEqual(len(png), storage.MAX_PNG)
                self.assertLessEqual(struct.unpack(">I", png[16:20])[0] * struct.unpack(">I", png[20:24])[0], 4_000_000)
                offset, kinds = 8, []
                while offset < len(png):
                    length = struct.unpack(">I", png[offset:offset + 4])[0]
                    kinds.append(png[offset + 4:offset + 8])
                    offset += length + 12
                # The ciphertext is recovered from actual RGB pixels. There is
                # no rxAI ancillary metadata chunk carrying a hidden payload.
                self.assertEqual(kinds, [b"IHDR", b"IDAT", b"IEND"])
                self.assertTrue(storage.decode_image(png).startswith(b"RSX3"))
            target = Path(self.directory.name) / "visual-restored"
            restored = storage.download_archive(self.config, FixtureReceiver.items[key], target)
            self.assertEqual(target.read_bytes(), data)
            self.assertEqual(restored["manifest"], source_manifest)
            # Rewrap exactly the same authenticated ciphertext in the old
            # compact format and verify compatibility without changing its AAD.
            client = FixtureReceiver(self.config)
            with storage.Codec(client) as codec:
                oid = storage.object_id("legacy-fixture", "old-compact")
                plain = b"preexisting encrypted compact object"
                visual = codec.seal(plain, oid)
                compact = encode_storage_image(storage.decode_image(visual))
                self.assertEqual(codec.open(compact, oid), plain)
                with self.assertRaises(Exception):
                    codec.open(compact, "f" * 32)


if __name__ == "__main__":
    unittest.main()
