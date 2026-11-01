"""Private progress snapshots and actual streamed transport; no live account."""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Resources"))
import gendragoon_progress as progress
import gendragoon_redx_storage as storage
from test_redx_transfer_performance import FixtureCodec, FixtureReceiver, config


class UploadProgressTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="gd-private-progress-")
        self.addCleanup(temporary.cleanup)
        self.home = Path(temporary.name).resolve() / "home"
        self.home.mkdir(mode=0o700)
        self.directory = self.home / "Library/Application Support/GenDragoon Cloud SSD/UploadWorkspace/Progress"
        self.directory.mkdir(parents=True, mode=0o700)
        self.path = self.directory / ("a" * 32 + "-" + "b" * 32 + ".json")
        self.reporter = progress._Reporter(self.path, home=self.home)
        self.addCleanup(self.reporter.close)

    def read(self):
        return json.loads(self.path.read_text())

    def test_snapshots_are_atomic_private_typed_and_never_include_input_secrets(self):
        self.reporter.phase("uploading", total_bytes=100, workers=4)
        self.reporter.update(completed_bytes=25, bearerToken="fixture-never-write",
                             keymapPath="fixture-private-path", workers=True, phase={"unsafe": "input"},
                             uploaded_bytes=float("nan"), _force=True)
        value = self.read()
        self.assertEqual(value["completed_bytes"], 25)
        self.assertEqual(value["workers"], 4)
        self.assertEqual(value["phase"], "uploading")
        self.assertEqual(value["uploaded_bytes"], 0)
        self.assertNotIn("fixture", self.path.read_text())
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o600)
        self.assertLess(self.path.stat().st_size, progress.MAX_SNAPSHOT)
        self.assertEqual(list(self.directory.glob(".progress-*")), [])

    def test_outside_path_symlink_hardlink_and_shared_directory_are_refused(self):
        elsewhere = self.home / "do-not-overwrite.json"
        elsewhere.write_text("original")
        for destination in (elsewhere, self.directory / "invalid.json"):
            rejected = progress._Reporter(destination, home=self.home)
            self.addCleanup(rejected.close)
            self.assertIsNone(rejected.fd)
        self.path.symlink_to(elsewhere)
        rejected = progress._Reporter(self.path, home=self.home)
        self.assertIsNone(rejected.fd)
        self.path.unlink()
        os.link(elsewhere, self.path)
        rejected = progress._Reporter(self.path, home=self.home)
        self.assertIsNone(rejected.fd)
        self.path.unlink()
        self.directory.chmod(0o755)
        rejected = progress._Reporter(self.path, home=self.home)
        self.assertIsNone(rejected.fd)
        self.assertEqual(elsewhere.read_text(), "original")

    def test_parallel_counters_have_no_lost_updates_or_partial_json(self):
        self.reporter.phase("uploading", total_bytes=1000, workers=8)
        errors = []
        done = threading.Event()
        def reader():
            while not done.is_set():
                try:
                    value = self.read()
                    if value["completed_bytes"] > value["total_bytes"]:
                        errors.append("invalid bound")
                except Exception as error:
                    errors.append(type(error).__name__)
        observer = threading.Thread(target=reader)
        observer.start()
        try:
            with patch.object(progress, "MIN_INTERVAL", 0), ThreadPoolExecutor(max_workers=8) as executor:
                list(executor.map(lambda _: self.reporter.advance(1, encoded_bytes=1), range(400)))
        finally:
            done.set()
            observer.join(timeout=3)
        self.reporter.update(_force=True)
        self.assertEqual(self.read()["completed_bytes"], 400)
        self.assertEqual(self.read()["encoded_bytes"], 400)
        self.assertEqual(errors, [])

    def test_eta_and_free_network_comparison_use_observed_overlap(self):
        clock = [0.0]
        with patch.object(progress.time, "monotonic", side_effect=lambda: clock[0]):
            self.reporter.phase("uploading", total_bytes=100, workers=2)
            first = self.reporter.network_begin()
            clock[0] = 2
            second = self.reporter.network_begin()
            self.reporter.advance(50)
            self.reporter.network_bytes("upload", 200)
            self.reporter.update(_force=True)
            self.assertAlmostEqual(self.read()["eta_seconds"], 2)
            clock[0] = 4
            self.reporter.network_end(first)
            clock[0] = 6
            self.reporter.network_bytes("download", 400)
            self.reporter.network_end(second)
            value = self.read()
        self.assertAlmostEqual(value["network_elapsed_seconds"], 6)
        self.assertAlmostEqual(value["baseline_network_seconds"], 8)
        self.assertAlmostEqual(value["saved_network_seconds"], 2)
        self.assertAlmostEqual(value["rate_bytes_per_second"], 100)

    def test_http_streaming_counts_real_payload_bytes_and_keeps_content_length(self):
        payload = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 1024
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_PUT(self):
                length = int(self.headers["Content-Length"])
                received.append((self.rfile.read(length), self.headers.get("Transfer-Encoding")))
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"{}")
            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def log_message(self, *arguments):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        client = storage.RedXReceiver(config(self.home))
        self.reporter.phase("uploading", total_bytes=len(payload), workers=2)
        with patch.object(progress, "_get", return_value=self.reporter), \
                patch.object(client, "_url", side_effect=lambda route: "http://127.0.0.1:%s%s" % (server.server_port, route)):
            route = "/v1/receivers/me/workspaces/" + "a" * 32 + "/blobs/" + "c" * 32
            client._request(route, "PUT", payload, {"Content-Length": str(len(payload)), "Content-Type": "image/png"})
            _, _, restored = client._request(route, limit=len(payload))
        self.assertEqual(received, [(payload, None)])
        self.assertEqual(hashlib.sha256(restored).digest(), hashlib.sha256(payload).digest())
        value = self.read()
        self.assertEqual(value["uploaded_bytes"], len(payload))
        self.assertEqual(value["downloaded_bytes"], len(payload))
        self.assertGreater(value["rate_bytes_per_second"], 0)

    def test_archive_progress_tracks_completed_chunks_and_authenticated_retry(self):
        FixtureReceiver.blobs, FixtureReceiver.items = {}, {}
        FixtureReceiver.allowance = 4
        FixtureCodec.seals = 0
        source = self.home / "archive"
        data = bytes(range(256)) * 50 + b"tail"
        source.write_bytes(data)
        args = (config(self.home), source, "c" * 18, "fixture", "file", "flat",
                storage.sha256_bytes(data), [{"path": "fixture", "size": len(data)}])
        with patch.object(progress, "_get", return_value=self.reporter), \
                patch.object(storage, "CHUNK", 2048), patch.object(storage, "RedXReceiver", FixtureReceiver), \
                patch.object(storage, "Codec", FixtureCodec):
            storage.upload_archive(*args)
            self.reporter.update(_force=True)
            value = self.read()
            self.assertEqual(value["phase"], "publishing")
            self.assertEqual(value["completed_bytes"], len(data) * 2)
            self.assertEqual(value["encoded_bytes"], len(data))
            self.assertEqual(value["objects_done"], value["objects_total"])
            previous_seals = FixtureCodec.seals
            storage.upload_archive(*args)
            self.assertEqual(FixtureCodec.seals, previous_seals)
            target = self.home / "restored"
            storage.download_archive(config(self.home), FixtureReceiver.items["c" * 18], target)
            self.reporter.update(_force=True)
        self.assertEqual(target.read_bytes(), data)
        value = self.read()
        self.assertEqual(value["completed_bytes"], len(data))
        self.assertEqual(value["objects_done"], value["objects_total"])
        self.assertEqual(value["workers"], 4)

    def test_streamed_rate_limit_retry_replays_the_identical_full_body(self):
        payload = b"\x89PNG\r\n\x1a\n" + bytes(range(256)) * 400
        received = []
        class Handler(BaseHTTPRequestHandler):
            def do_PUT(self):
                received.append(self.rfile.read(int(self.headers["Content-Length"])))
                if len(received) == 1:
                    self.send_response(429)
                    self.send_header("Retry-After", "0")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.send_header("Content-Length", "2")
                    self.end_headers()
                    self.wfile.write(b"{}")
            def log_message(self, *arguments):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        client = storage.RedXReceiver(config(self.home))
        self.reporter.phase("uploading", workers=2)
        with patch.object(progress, "_get", return_value=self.reporter), \
                patch.object(client, "_url", return_value="http://127.0.0.1:%s/blob" % server.server_port), \
                patch.object(storage.time, "sleep"):
            client._request("/v1/receivers/me/workspaces/" + "a" * 32 + "/blobs/" + "c" * 32,
                            "PUT", payload, {"Content-Length": str(len(payload)), "Content-Type": "image/png"})
        self.assertEqual(received, [payload, payload])
        self.assertEqual(self.read()["uploaded_bytes"], len(payload) * 2)
        self.assertEqual(self.reporter.active, {})

    def test_telemetry_failure_never_changes_the_transfer_result(self):
        with patch.object(progress, "_get", side_effect=OSError("fixture disk failure")):
            self.assertFalse(progress.enabled())
            progress.phase("encoding", total_bytes=100)
            progress.update(completed_bytes=25)
            progress.advance(25)
            progress.network_end(progress.network_begin())


if __name__ == "__main__":
    unittest.main()
