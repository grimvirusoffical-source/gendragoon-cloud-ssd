"""Disposable fixtures for vendor scope, archive bounds and staged rollback."""
import importlib.util
import hashlib
import io
import os
from pathlib import Path
import plistlib
import struct
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("vendor_refresh", Path(__file__).resolve().parents[1]/"update_vendor_macos.py")
vendor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vendor)


class VendorRefreshTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def bundle(self, parent=None, content=b"original"):
        parent = parent or self.root/"stage"
        parent.mkdir(exist_ok=True)
        app = parent/vendor.NAME
        for directory in ("Resources", "MacOS", "_CodeSignature"):
            (app/"Contents"/directory).mkdir(parents=True)
        (app/"Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": vendor.BUNDLE_ID, "CFBundleExecutable": "GenDragoon Cloud SSD"}))
        for relative in ("Resources/gendragoon_node", "MacOS/GenDragoon Cloud SSD", "_CodeSignature/CodeResources"):
            (app/"Contents"/relative).write_bytes(content)
        return app

    @staticmethod
    def executable(cpu=0x0100000c):
        return struct.pack("<8I", 0xfeedfacf, cpu, 0, 2, 1, 8, 0, 0)+b"\0"*8

    def archive(self, entries=None):
        path = self.root/(str(len(list(self.root.glob("*.gz"))))+".tar.gz")
        prefix = f"node-v{vendor.VERSION}-darwin-arm64/"
        entries = entries or [(prefix+"bin/node", self.executable(), None), (prefix+"LICENSE", b"Node license", None)]
        with tarfile.open(path, "w:gz") as archive:
            for name, data, kind in entries:
                item = tarfile.TarInfo(name)
                item.size = len(data)
                if kind:
                    item.type = kind
                    item.linkname = "../../outside"
                archive.addfile(item, io.BytesIO(data))
        return path

    def extract(self, archive):
        destination = self.root/"extracted"
        destination.mkdir()
        return vendor.extract_selected(archive, destination)

    def test_only_exact_node_and_license_are_extracted(self):
        prefix = f"node-v{vendor.VERSION}-darwin-arm64/"
        source = self.archive([(prefix+"bin/node", self.executable(), None), (prefix+"LICENSE", b"License", None),
                               ("../../outside", b"unselected", None), (prefix+"bin/npm", b"", tarfile.SYMTYPE)])
        node, license_file = self.extract(source)
        self.assertEqual(node.read_bytes(), self.executable())
        self.assertEqual(license_file.read_bytes(), b"License")
        self.assertEqual({p.name for p in node.parent.iterdir()}, {"node", "LICENSE"})
        self.assertFalse((self.root.parent/"outside").exists())

    def test_selected_link_is_rejected(self):
        prefix = f"node-v{vendor.VERSION}-darwin-arm64/"
        source = self.archive([(prefix+"bin/node", b"", tarfile.SYMTYPE)])
        with self.assertRaisesRegex(ValueError, "Invalid"):
            self.extract(source)

    def test_duplicate_target_is_rejected(self):
        prefix = f"node-v{vendor.VERSION}-darwin-arm64/"
        entry = (prefix+"bin/node", self.executable(), None)
        with self.assertRaisesRegex(ValueError, "duplicate"):
            self.extract(self.archive([entry, entry]))

    def test_missing_exact_license_is_rejected(self):
        prefix = f"node-v{vendor.VERSION}-darwin-arm64/"
        with self.assertRaisesRegex(ValueError, "exact official"):
            self.extract(self.archive([(prefix+"bin/node", self.executable(), None), (prefix+"../LICENSE", b"wrong", None)]))

    def test_binary_and_expansion_limits(self):
        with patch.object(vendor, "MAX_NODE", 16), self.assertRaisesRegex(ValueError, "Invalid"):
            self.extract(self.archive())
        with patch.object(vendor, "MAX_UNPACKED", 10):
            reader = vendor.LimitedReader(io.BytesIO(b"x"*100))
            with self.assertRaisesRegex(ValueError, "expanded-size"):
                reader.read(100)

    def test_foreign_and_truncated_macho_rejected(self):
        for data in (self.executable(0x01000007), b"MZ", b"#!/bin/sh\n", struct.pack("<8I", 0xfeedfacf, 0x0100000c, 0, 2, 1, 9000, 0, 0)):
            with self.subTest(data=data[:8]):
                file = self.root/"wrong-node"
                file.write_bytes(data)
                with self.assertRaises(ValueError):
                    vendor.macho_arm64(file)

    def test_staged_identity_and_installed_path_guards(self):
        app = self.bundle()
        self.assertEqual(vendor.staged_path(app), (app.stat().st_dev, app.stat().st_ino))
        installed = self.bundle(self.root/"Applications")
        with self.assertRaisesRegex(ValueError, "Installed"):
            vendor.staged_path(installed)
        (app/"Contents/Info.plist").write_bytes(plistlib.dumps({"CFBundleIdentifier": "wrong"}))
        with self.assertRaisesRegex(ValueError, "identity"):
            vendor.staged_path(app)

    def test_bundle_symlinks_and_shared_hardlinks_rejected(self):
        app = self.bundle()
        outside = self.root/"outside"; outside.write_bytes(b"keep")
        link = app/"Contents/Resources/alias"
        link.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "Unsafe"):
            vendor.staged_path(app)
        link.unlink(); os.link(outside, link)
        with self.assertRaisesRegex(ValueError, "hard-linked"):
            vendor.staged_path(app)
        self.assertEqual(outside.read_bytes(), b"keep")

    def test_running_or_uninspectable_bundle_is_retained(self):
        from types import SimpleNamespace
        for result in (SimpleNamespace(returncode=0, stdout=b"p123\nn/some/file\n", stderr=b""),
                       SimpleNamespace(returncode=1, stdout=b"", stderr=b"permission denied")):
            with patch.object(vendor, "run", return_value=result), self.assertRaises(RuntimeError):
                vendor.stopped(self.root/vendor.NAME)

    def test_no_redirect_downgrade(self):
        with self.assertRaisesRegex(ValueError, "must not redirect"):
            vendor.NoRedirect().redirect_request(None, None, None, None, None, None)

    def test_codesign_receives_inline_requirement_as_one_argument(self):
        from types import SimpleNamespace
        calls = []
        def command(arguments, **kwargs):
            calls.append(arguments)
            return SimpleNamespace(stdout=b"", stderr=("Identifier=node\nTeamIdentifier=" + vendor.TEAM
                + "\nAuthority=" + vendor.IDENTITY + "\nCDHash=" + "a"*40 + "\n").encode())
        with patch.object(vendor, "run", side_effect=command):
            result = vendor.signature(self.root/"node with spaces", deep=True)
        verification = calls[0]
        self.assertEqual(verification[verification.index("-R")+1],
                         '=anchor apple generic and certificate leaf[subject.OU] = "NZPU8H843J"')
        self.assertIn("--strict", verification)
        self.assertIn("--deep", verification)
        self.assertEqual(verification[-1], self.root/"node with spaces")
        self.assertEqual(result["TeamIdentifier"], vendor.TEAM)

    class DownloadResponse(io.BytesIO):
        status = 200
        headers = {}

        def geturl(self):
            return vendor.ARCHIVE_URL

    def test_pinned_download_digest_and_system_tls_ca(self):
        from types import SimpleNamespace
        body = b"disposable vendor archive fixture"
        for corrupted in (False, True):
            destination = self.root/("download-bad" if corrupted else "download-good")
            response = self.DownloadResponse(body+(b"modified" if corrupted else b""))
            with patch.object(vendor.ssl, "create_default_context") as tls, patch.object(vendor.urllib.request, "build_opener", return_value=SimpleNamespace(open=lambda *args, **kwargs: response)), patch.object(vendor, "ARCHIVE_SHA256", hashlib.sha256(body).hexdigest()):
                if corrupted:
                    with self.assertRaisesRegex(ValueError, "pinned SHA-256"):
                        vendor.download(destination)
                else:
                    vendor.download(destination)
                    self.assertEqual(destination.read_bytes(), body)
                tls.assert_called_once_with(cafile="/etc/ssl/cert.pem")

    def test_download_limit_without_content_length(self):
        from types import SimpleNamespace
        response = self.DownloadResponse(b"x"*20)
        with patch.object(vendor.ssl, "create_default_context"), patch.object(vendor.urllib.request, "build_opener", return_value=SimpleNamespace(open=lambda *args, **kwargs: response)), patch.object(vendor, "MAX_DOWNLOAD", 10), self.assertRaisesRegex(ValueError, "download limit"):
            vendor.download(self.root/"oversized")

    def test_final_signature_failure_restores_previous_staged_bundle(self):
        original = self.bundle()
        work = self.root/"work"; work.mkdir()
        candidate = self.bundle(work, b"replacement")
        identity = vendor.staged_path(original)
        with patch.object(vendor, "signature", side_effect=[{"CDHash": "original"}, RuntimeError("final signature failure")]), patch.object(vendor, "stopped"):
            with self.assertRaisesRegex(RuntimeError, "final signature failure"):
                vendor.replace_staged(original, candidate, work, (identity, {"CDHash": "original"}))
        self.assertEqual((original/"Contents/Resources/gendragoon_node").read_bytes(), b"original")
        self.assertEqual((work/"failed.app/Contents/Resources/gendragoon_node").read_bytes(), b"replacement")
        self.assertFalse((work/"previous.app").exists())

    def test_changed_original_cannot_be_replaced(self):
        original = self.bundle()
        work = self.root/"work"; work.mkdir()
        candidate = self.bundle(work, b"replacement")
        with patch.object(vendor, "signature", return_value={"CDHash": "changed"}), self.assertRaisesRegex(ValueError, "changed"):
            vendor.replace_staged(original, candidate, work, (vendor.staged_path(original), {"CDHash": "original"}))
        self.assertEqual((original/"Contents/Resources/gendragoon_node").read_bytes(), b"original")
        self.assertTrue(candidate.exists())


if __name__ == "__main__":
    unittest.main()
