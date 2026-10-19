"""Local TLS fixtures and disposable files only; no external credentials/API."""
import importlib.util
from concurrent.futures import ThreadPoolExecutor
import io
from email.message import Message
import os
from pathlib import Path
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from uuid import UUID

SOURCE = Path(__file__).resolve().parents[1] / "gendragoon.py"
spec = importlib.util.spec_from_file_location("gendragoon_sdk_test", SOURCE)
sdk = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sdk)
KEY = "gdsk_disposable_sdk_fixture"
GOOD, SHORT, REDIRECT, DOWNGRADE, ERROR, JSON_FILE = [str(UUID(int=n)) for n in range(1, 7)]
PAYLOAD = b"fixture cloud bytes\x00\xff"


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.requests.append((self.path, self.headers.get("Authorization")))
        file_id = self.path.split("/")[-2] if self.path.endswith("/download") else ""
        if file_id in {REDIRECT, DOWNGRADE} or self.path == "/redirect":
            location = self.server.http_target if file_id == DOWNGRADE else self.server.https_target
            self.send_response(302)
            self.send_header("Location", location + "/capture")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if file_id == ERROR:
            data, code = b"fixture unavailable", 503
        elif self.path == "/v1/me":
            data, code = b'{"ready":true}', 200
        elif file_id == JSON_FILE:
            data, code = b'{"preserve":"raw bytes"}', 200
        else:
            data, code = PAYLOAD, 200
        self.send_response(code)
        self.send_header("Content-Type", "application/json" if file_id == JSON_FILE or self.path == "/v1/me" else "application/octet-stream")
        self.send_header("Content-Length", str(len(data) + (10 if file_id == SHORT else 0)))
        self.end_headers()
        self.wfile.write(data)
        self.wfile.flush()
        if file_id == SHORT:
            self.close_connection = True
            self.connection.shutdown(socket.SHUT_WR)


class FakeResponse(io.BytesIO):
    def __init__(self, data, length=None, encoding=None):
        super().__init__(data)
        self.headers = Message()
        if length is not None:
            self.headers["Content-Length"] = str(length)
        if encoding is not None:
            self.headers["Content-Encoding"] = encoding


class SDKTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix="gd-sdk-tls-")
        cls.cert, cls.keyfile = [Path(cls.fixture.name) / name for name in ("cert.pem", "key.pem")]
        subprocess.run([
            "openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1",
            "-keyout", str(cls.keyfile), "-out", str(cls.cert), "-subj", "/CN=localhost",
            "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
        ], check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        cls.keyfile.chmod(0o600)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cls.cert, cls.keyfile)
        cls.servers, cls.threads = [], []
        for secure in (True, True, False):
            server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            server.daemon_threads = True
            server.requests = []
            if secure:
                server.socket = context.wrap_socket(server.socket, server_side=True)
            thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
            thread.start()
            cls.servers.append(server)
            cls.threads.append(thread)
        cls.base = f"https://127.0.0.1:{cls.servers[0].server_port}"
        cls.servers[0].https_target = f"https://127.0.0.1:{cls.servers[1].server_port}"
        cls.servers[0].http_target = f"http://127.0.0.1:{cls.servers[2].server_port}"
        cls.trusted = ssl.create_default_context(cafile=str(cls.cert))

    @classmethod
    def tearDownClass(cls):
        for server in cls.servers:
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join(timeout=3)
        cls.fixture.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gd-sdk-download-")
        self.root = Path(self.temporary.name)
        with patch.object(sdk, "TLS_CONTEXT", self.trusted):
            self.client = sdk.GenDragoon(KEY, self.base)

    def tearDown(self):
        self.temporary.cleanup()

    def assertClean(self):
        self.assertEqual(list(self.root.glob(".gendragoon-download-*")), [])

    def fakeDownload(self, response, destination):
        with patch.object(self.client._opener, "open", return_value=response):
            return self.client.download(GOOD, destination)

    def test_tls_status_and_complete_download(self):
        self.assertEqual(self.client.status(), {"ready": True})
        destination = self.root / "download.bin"
        self.assertEqual(self.client.download(GOOD, destination), destination)
        self.assertEqual(destination.read_bytes(), PAYLOAD)
        self.assertEqual(destination.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.servers[0].requests[-1][1], "Bearer " + KEY)
        self.assertClean()

    def test_json_file_is_downloaded_as_raw_bytes(self):
        destination = self.root / "file.json"
        self.client.download(JSON_FILE, destination)
        self.assertEqual(destination.read_bytes(), b'{"preserve":"raw bytes"}')

    def test_untrusted_certificate_is_rejected_without_creating_destination(self):
        client = sdk.GenDragoon(KEY, self.base)
        with self.assertRaises(URLError):
            client.download(GOOD, self.root / "untrusted")
        self.assertFalse((self.root / "untrusted").exists())
        self.assertClean()

    def test_existing_file_or_symlink_is_never_removed_and_no_request_is_sent(self):
        existing = self.root / "existing"
        existing.write_bytes(b"keep original")
        dangling = self.root / "dangling"
        dangling.symlink_to(self.root / "absent")
        for destination in (existing, dangling):
            with patch.object(self.client._opener, "open") as opening:
                with self.assertRaises(FileExistsError):
                    self.client.download(ERROR, destination)
                opening.assert_not_called()
        self.assertEqual(existing.read_bytes(), b"keep original")
        self.assertTrue(dangling.is_symlink())
        self.assertClean()

    def test_truncated_tls_response_rejects_and_removes_only_staging(self):
        destination = self.root / "short"
        with self.assertRaisesRegex(RuntimeError, "Incomplete download"):
            self.client.download(SHORT, destination)
        self.assertFalse(destination.exists())
        self.assertClean()

    def test_redirect_and_downgrade_never_reach_target_or_forward_authorization(self):
        before = [len(server.requests) for server in self.servers[1:]]
        for file_id in (REDIRECT, DOWNGRADE):
            with self.assertRaises(HTTPError):
                self.client.download(file_id, self.root / file_id)
            self.assertFalse((self.root / file_id).exists())
            self.assertClean()
        with self.assertRaisesRegex(RuntimeError, "HTTP 302"):
            self.client._request("GET", "/redirect")
        self.assertEqual([len(server.requests) for server in self.servers[1:]], before)

    def test_http_failure_does_not_publish_and_cleans_staging(self):
        with self.assertRaises(HTTPError):
            self.client.download(ERROR, self.root / "error")
        self.assertFalse((self.root / "error").exists())
        self.assertClean()

    def test_invalid_length_oversized_stream_and_encoded_content_are_rejected(self):
        for response in (FakeResponse(b"x", "invalid"), FakeResponse(b"too long", 1), FakeResponse(b"x", 1, "gzip")):
            with self.assertRaises(RuntimeError):
                self.fakeDownload(response, self.root / "bad")
            self.assertFalse((self.root / "bad").exists())
            self.assertClean()

    def test_duplicate_length_or_encoding_headers_are_rejected(self):
        response = FakeResponse(b"data", 4)
        response.headers["Content-Length"] = "4"
        encoded = FakeResponse(b"data", 4, "identity")
        encoded.headers["Content-Encoding"] = "gzip"
        for malformed in (response, encoded):
            with self.assertRaises(RuntimeError):
                self.fakeDownload(malformed, self.root / "duplicates")
            self.assertFalse((self.root / "duplicates").exists())
            self.assertClean()

    def test_unknown_length_and_zero_length_are_supported(self):
        for name, response, data in (("unknown", FakeResponse(b"unknown"), b"unknown"), ("empty", FakeResponse(b"", 0), b"")):
            destination = self.root / name
            self.fakeDownload(response, destination)
            self.assertEqual(destination.read_bytes(), data)
        self.assertClean()

    def test_concurrent_destination_creation_is_preserved(self):
        destination = self.root / "race"
        response = FakeResponse(b"downloaded", 10)
        real_read = response.read
        def racing_read(size):
            if not destination.exists():
                destination.write_bytes(b"concurrent owner bytes")
            return real_read(size)
        with patch.object(response, "read", side_effect=racing_read):
            with self.assertRaises(FileExistsError):
                self.fakeDownload(response, destination)
        self.assertEqual(destination.read_bytes(), b"concurrent owner bytes")
        self.assertClean()

    def test_simultaneous_downloads_publish_exactly_one_complete_result(self):
        destination = self.root / "simultaneous"
        barrier = threading.Barrier(2)
        def opening(*args, **kwargs):
            barrier.wait(timeout=3)
            return FakeResponse(b"complete winner", 15)
        def download():
            try:
                self.client.download(GOOD, destination)
                return "published"
            except FileExistsError:
                return "existing"
        with patch.object(self.client._opener, "open", side_effect=opening):
            with ThreadPoolExecutor(max_workers=2) as workers:
                results = list(workers.map(lambda _: download(), range(2)))
        self.assertEqual(sorted(results), ["existing", "published"])
        self.assertEqual(destination.read_bytes(), b"complete winner")
        self.assertClean()

    def test_disk_failure_cleans_staging_and_does_not_publish(self):
        destination = self.root / "disk-error"
        with patch.object(sdk.os, "fsync", side_effect=OSError("fixture disk full")):
            with self.assertRaises(OSError):
                self.fakeDownload(FakeResponse(b"data", 4), destination)
        self.assertFalse(destination.exists())
        self.assertClean()

    def test_network_stream_error_preserves_concurrent_destination(self):
        destination = self.root / "network-error"
        response = FakeResponse(b"data", 4)
        def failed_read(size):
            destination.write_bytes(b"concurrent content")
            raise OSError("fixture network reset")
        with patch.object(response, "read", side_effect=failed_read):
            with self.assertRaises(OSError):
                self.fakeDownload(response, destination)
        self.assertEqual(destination.read_bytes(), b"concurrent content")
        self.assertClean()

    def test_endpoint_rejects_http_and_embedded_credentials(self):
        for base in ("http://127.0.0.1", "https://user:password@example.test", "https://example.test/?token=x", "https://example.test/#fragment"):
            with self.assertRaises(ValueError):
                sdk.GenDragoon(KEY, base)

    def test_delete_requires_uuid_and_cannot_substitute_path_or_query(self):
        with patch.object(self.client, "_request", return_value={"deleted": True}) as request:
            self.assertEqual(self.client.delete(UUID(int=1)), {"deleted": True})
            request.assert_called_once_with("DELETE", "/v1/files/" + GOOD)
        for file_id in ("../keys", GOOD + "?admin=true", GOOD + "/other", "", None):
            with patch.object(self.client, "_request") as request:
                with self.assertRaises((ValueError, AttributeError)):
                    self.client.delete(file_id)
                request.assert_not_called()

    def test_http_error_redacts_key_crossing_display_boundary(self):
        for body in ("x" * 990 + KEY + "suffix", KEY * 2 + "x" * (1000 - 2 * len(KEY) - 6) + KEY):
            error = HTTPError(self.base + "/fixture", 503, "fixture", Message(), io.BytesIO(body.encode()))
            with patch.object(self.client._opener, "open", side_effect=error):
                with self.assertRaises(RuntimeError) as raised:
                    self.client.status()
            self.assertNotIn("gdsk_", str(raised.exception))
            self.assertLess(len(str(raised.exception)), 1050)


if __name__ == "__main__":
    unittest.main()
