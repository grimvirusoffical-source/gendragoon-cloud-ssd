import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

RESOURCES = Path(__file__).resolve().parents[1] / "Resources"
sys.path.insert(0, str(RESOURCES))
import gendragoon_redx_pack as pack
import gendragoon_library as library


class Response(io.BytesIO):
    def __init__(self, payload, status=200, headers=None):
        super().__init__(payload)
        self.status = status
        self.headers = headers or {}
    def getheader(self, name):
        return self.headers.get(name)


class PackTests(unittest.TestCase):
    def test_foreign_application_backup_is_refused_before_destination_or_payload_io(self):
        for name in ("App.exe", "App.AppImage", "App.apk", "App.ipa"):
            with self.subTest(name=name), patch.object(pack.sys, "platform", "darwin"), patch.object(pack, "_archive_entry", return_value={"name": name, "kind": "file"}):
                with self.assertRaises(pack.PackError) as error:
                    pack.restore_source(object(), {"path": "fixture", "destination": "/does-not-exist"})
                self.assertEqual(error.exception.code, "application_platform_mismatch")
        with patch.object(pack.sys, "platform", "darwin"), patch.object(pack, "_archive_entry", return_value={"name": "Reports.exe", "kind": "folder"}):
            with self.assertRaises(pack.PackError) as error:
                pack.restore_source(object(), {"path": "fixture"})
            self.assertEqual(error.exception.code, "destination_unsafe")

    def test_origin_transport_and_context_canonicalization(self):
        self.assertEqual(pack.origin("https://EXAMPLE.test:443/"), "https://example.test")
        self.assertEqual(pack.origin("http://127.0.0.1:7777", True), "http://127.0.0.1:7777")
        for value in ("http://127.0.0.1:7777", "http://192.168.1.1", "https://user:secret@example.test", "https://example.test/path", "https://example.test#fragment", "https://example.test?q=1", "https://example.test\n"):
            with self.assertRaises(pack.PackError): pack.origin(value)
        config = {"origin": "https://EXAMPLE.test:443/", "database": "storage", "pack": "gendragoon", "accountId": "a" * 64}
        context = pack.connection_context(config)
        self.assertEqual(context, pack.connection_context({**config, "origin": "https://example.test"}))
        for changed in ({"origin": "https://other.test"}, {"database": "other"}, {"pack": "other"}, {"accountId": "b" * 64}):
            self.assertNotEqual(context, pack.connection_context({**config, **changed}))

    def test_paths_never_escape_pack_or_use_reserved_markers(self):
        self.assertEqual(pack.remote_path("Folder/valid file.dat"), "Folder/valid file.dat")
        for value in ("../x", "/x", "x//y", "x/./y", "x\\y", "x:y", "x\x00", "CON.txt", "LPT1", "x/" + pack.MARKER):
            with self.assertRaises(pack.PackError): pack.remote_path(value)
        for value in ("default", "redxai_accounts", "../db"):
            with self.assertRaises(pack.PackError): pack.database(value)

    def test_failed_checksum_and_existing_destination_keep_original(self):
        data = b"expected"
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve(); target = root / "out.bin"
            class Client(pack.RedXPack):
                def __init__(self): self.base = "/fixture/"
                def stat(self, path): return {"path": path, "name": "a", "is_dir": False, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
                def _request(self, *args, **kwargs):
                    class Connection:
                        def close(self): pass
                    return Connection(), Response(b"corrupt!", headers={"ETag": '"sha256-' + hashlib.sha256(data).hexdigest() + '"'})
            with self.assertRaises(pack.PackError): Client().get("a", target)
            self.assertFalse(target.exists()); self.assertEqual(list(root.iterdir()), [])
            target.write_bytes(b"keep")
            with self.assertRaises(pack.PackError): Client().get("a", target)
            self.assertEqual(target.read_bytes(), b"keep")

    def test_redirect_is_never_accepted_or_reflected(self):
        response = Response(b'{"secret":"do-not-reflect"}', status=302)
        with self.assertRaises(pack.PackError) as caught: pack._check(response, (200,))
        self.assertEqual(caught.exception.code, "redirect_refused")
        self.assertNotIn("do-not-reflect", str(caught.exception))

    def test_pkce_uses_documented_provider_and_s256(self):
        result = pack.connect_begin({"origin": "https://fixture.test", "database": "storage"})
        from urllib.parse import parse_qs, urlsplit
        query = parse_qs(urlsplit(result["url"]).fragment.split("?", 1)[1])
        self.assertEqual(query["provider"], ["gendragoon"])
        self.assertEqual(query["scope"], ["write"])
        self.assertEqual(query["pkce_method"], ["S256"])
        self.assertNotIn(result["pkceVerifier"], result["url"])
        self.assertNotEqual(result["state"], pack.connect_begin({"origin": "https://fixture.test"})["state"])

    def test_archive_context_cannot_read_another_connection_descriptor(self):
        class Client:
            config = {"origin": "https://fixture.test", "database": "storage", "accountId": "a" * 64}
            def get_bytes(self, path): raise AssertionError("must reject before fetching")
        with self.assertRaises(pack.PackError):
            pack._archive_entry(Client(), "GenDragoon/" + "b" * 32 + "/archives/" + "c" * 32 + "/.gendragoon-entry.json")

    @unittest.skipUnless(sys.platform == "darwin", "macOS archive contract")
    def test_changed_source_is_retained_before_any_transport_or_offload(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td).resolve(); source = root / "source.txt"; source.write_text("original")
            class Client:
                def put(self, *args): raise AssertionError("must not upload changed source")
            def mutate(source, archive):
                archive.write_bytes(b"not-published")
                source.write_text("changed while archiving")
            with patch.object(pack, "PackReceiverAdapter"), patch.object(library, "package", side_effect=mutate), patch.object(library, "trash") as trash:
                with self.assertRaises(RuntimeError):
                    pack.upload_source(Client(), {"source": str(source), "path": "", "origin": "https://fixture.test", "database": "storage", "accountId": "a" * 64, "offload": False})
                trash.assert_not_called()
            self.assertEqual(source.read_text(), "changed while archiving")

    def test_operation_fits_below_ten_gib_but_actual_capacity_shortfall_is_refused(self):
        usage = shutil.disk_usage("/")
        with patch.object(library.shutil, "disk_usage", return_value=type(usage)(20 * 1024**3, 19 * 1024**3, 1024**3)):
            library.require_space(10 * 1024**2, Path("/"))
            with self.assertRaises(RuntimeError): library.require_space(1024**3, Path("/"))


if __name__ == "__main__":
    unittest.main()
