"""Tests for the opt-in unencrypted carrier; the vendor crypto module is untouched."""
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Resources"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import gendragoon_fast_png as png
import gendragoon_storage_mode as mode
import gendragoon_redx_storage as legacy
from test_redx_transfer_performance import FixtureReceiver, config


class FastCarrierTests(unittest.TestCase):
    def test_all_supported_boundary_sizes_roundtrip_without_vendor(self):
        for count in (1, 2, 47, 4096, 65535, 65536, 1048576):
            with self.subTest(size=count):
                plain = os.urandom(count)
                result = png.encode(plain, "a" * 32)
                self.assertLess(len(result), png.MAX_PNG_SIZE)
                self.assertTrue(png.is_plain_carrier(result))
                self.assertEqual(png.decode(result, "a" * 32), plain)

    def test_tamper_and_identity_mismatch_fail_closed(self):
        carrier = png.encode(os.urandom(1048576), "a" * 32)
        for candidate in (carrier[:-1], carrier + b"padding",
                          carrier[:85] + bytes([carrier[85] ^ 1]) + carrier[86:]):
            with self.subTest(length=len(candidate)):
                with self.assertRaises(png.PlainCarrierError):
                    png.decode(candidate, "a" * 32)
        with self.assertRaisesRegex(png.PlainCarrierError, "identity"):
            png.decode(carrier, "b" * 32)
        with self.assertRaises(png.PlainCarrierError):
            png.encode(b"", "a" * 32)
        with self.assertRaises(png.PlainCarrierError):
            png.encode(b"x" * 1048577, "a" * 32)

    def test_legacy_encrypted_upload_still_uses_original_vendor_path(self):
        with patch.object(mode.encrypted, "upload_archive", return_value={"legacy": True}) as called:
            args = ({"stub": True}, "/tmp/source", "a"*18, "file", "file", "flat", "b"*64, [])
            self.assertEqual(mode.upload_archive(*args), {"legacy": True})
            called.assert_called_once_with(*args, None, None, None)

    def test_legacy_encrypted_download_still_uses_original_vendor_path(self):
        with patch.object(mode.encrypted, "download_archive", return_value={"legacy": True}) as called:
            class Receiver:
                def get_png(self, manifest_id):
                    return b"\x89PNG\r\n\x1a\n" + bytes(64)
            item = {"manifestId": "a" * 32}
            self.assertEqual(mode.download_archive({}, item, "/tmp/never-create",
                client_factory=lambda _: Receiver()), {"legacy": True})
            called.assert_called_once_with({}, item, "/tmp/never-create", client_factory=unittest.mock.ANY)

    def test_unencrypted_upload_requires_advertised_receiver_support(self):
        with tempfile.TemporaryDirectory() as temp:
            cfg = config(temp)
            source = Path(temp) / "blocked.archive"
            source.write_bytes(b"never upload to an old Receiver")
            class UnsupportedReceiver(FixtureReceiver):
                def json(self, route):
                    self.json_route = route
                    return {"id": self.receiver, "supportedStorageFormats": ["redsecretsxai-png-v1"]}
            receiver = UnsupportedReceiver(cfg)
            UnsupportedReceiver.blobs = {}
            with self.assertRaisesRegex(legacy.RedXStorageError, "not activated"):
                mode.upload_archive(
                    cfg, source, "a"*18, "blocked.archive", "file", "flat",
                    hashlib.sha256(source.read_bytes()).hexdigest(), [],
                    client_factory=lambda config: receiver, encryption=False)
            self.assertEqual(receiver.json_route, "/v1/receivers/me")
            self.assertFalse(UnsupportedReceiver.blobs)

    def test_full_restore_resume_integrity_and_no_encryption_calls(self):
        with tempfile.TemporaryDirectory() as temp:
            cfg = config(temp)
            FixtureReceiver.blobs = {}
            FixtureReceiver.items = {}
            FixtureReceiver.writes = 0
            FixtureReceiver.allowance = 4
            source = Path(temp)/"sample.archive"
            data = os.urandom(1024 * 1024 * 2 + 9)
            source.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            args = (cfg, source, "c"*18, "sample.archive", "file", "flat", digest,
                    [{"path": "sample.archive", "size": len(data)}])
            with patch.object(mode.encrypted, "Codec", side_effect=AssertionError("Vendor was called")):
                first = mode.upload_archive(*args, encryption=False, client_factory=FixtureReceiver)
                before = FixtureReceiver.writes
                again = mode.upload_archive(*args, encryption=False, client_factory=FixtureReceiver)
                self.assertEqual(again, first)
                self.assertEqual(FixtureReceiver.writes, before, "Verified objects must be reused")
                record = FixtureReceiver.items["c"*18]
                self.assertEqual(record["manifestId"], first["manifestId"])
                self.assertEqual(first["encrypted"], False)
                self.assertTrue(png.is_plain_carrier(FixtureReceiver.blobs[first["manifestId"]]))
                restored = Path(temp)/"restored.archive"
                result = mode.download_archive(cfg, record, restored, client_factory=FixtureReceiver)
                self.assertEqual(restored.read_bytes(), data)
                self.assertEqual(result["manifest"], args[-1])
                self.assertEqual(len(result["root"]["chunkPages"]) > 0, True)
                # Corrupted archive chunks cannot overwrite a successful local restore.
                broken = next(value for key, value in FixtureReceiver.blobs.items()
                              if key not in (first["manifestId"],))
                key = next(key for key, value in FixtureReceiver.blobs.items() if value is broken)
                FixtureReceiver.blobs[key] = broken[:60] + b"\x00" + broken[61:]
                another = Path(temp)/"tampered.archive"
                with self.assertRaises(legacy.RedXStorageError):
                    mode.download_archive(cfg, record, another, client_factory=FixtureReceiver)
                self.assertFalse(another.exists())

    def test_manifest_identity_cannot_be_rebound_as_another_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            cfg = config(temp)
            FixtureReceiver.blobs = {}
            FixtureReceiver.items = {}
            FixtureReceiver.allowance = 1
            source = Path(temp)/"content"
            data = os.urandom(2048)
            source.write_bytes(data)
            item = mode.upload_archive(
                cfg, source, "a"*18, "content", "file", "flat",
                hashlib.sha256(data).hexdigest(), [{"path": "content", "size": len(data)}],
                client_factory=FixtureReceiver, encryption=False)
            changed = dict(FixtureReceiver.items["a"*18], key="b"*18)
            with self.assertRaisesRegex(legacy.RedXStorageError, "immutable object identity"):
                mode.download_archive(cfg, changed, Path(temp)/"bad", client_factory=FixtureReceiver)


if __name__ == "__main__":
    unittest.main()
