"""Tier wiring and credential-boundary tests; no cloud calls or disk operations."""
import importlib.util
import io
import json
import ssl
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

RESOURCE = Path(__file__).resolve().parents[1] / "Resources"
sys.path.insert(0, str(RESOURCE))
import gendragoon_performance as perf


class Response:
    status = 200
    def __init__(self, value): self.value = value
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, size): return json.dumps(self.value).encode()[:size]


class PerformanceTests(unittest.TestCase):
    def tearDown(self):
        perf._active = None
        perf._input = None

    def request(self, **updates):
        return io.BytesIO(json.dumps({"workspaceId": "free", "bearerToken": "test-only-token-" * 4,
                                    "constrained": False, **updates}).encode())

    def test_shared_registry_has_bounded_monotonic_tuning_for_every_allowance(self):
        profiles = [perf.for_workers(w) for w in range(1, 25)]
        for key in ("preloadMiB", "preloadWorkers", "streamReaders", "readAheadMiB", "cacheGiB"):
            self.assertEqual([p[key] for p in profiles], sorted(p[key] for p in profiles))
        for p in profiles:
            self.assertEqual(p["minimumFreeGiB"], 10)
            self.assertLessEqual(p["preloadMiB"], 256)
            self.assertLessEqual(p["preloadSeconds"], 1.2)
            self.assertLessEqual(p["preloadWorkers"], min(8, p["workers"]))
            self.assertLessEqual(p["streamReaders"], min(8, p["workers"]))
            self.assertIn("--vfs-cache-min-free-space=10G", perf.stream_arguments(p))
        for invalid in (0, 25, -1, 8.0, True, "20"):
            with self.assertRaises(ValueError): perf.for_workers(invalid)

    def test_data_saver_preserves_tier_but_reduces_real_work(self):
        p = perf.for_workers(20, constrained=True)
        self.assertEqual(p["name"], "Max")
        self.assertEqual((p["workers"], p["preloadMiB"], p["readAheadMiB"]), (1, 0, 0))
        self.assertIn("--constrained", perf.preload_arguments(p))
        self.assertEqual(perf.rclone_arguments(p)[1], "1")

    def test_large_app_warms_more_without_more_workers_or_unbounded_cache(self):
        p = perf.for_workers(20)
        def options(size):
            args = perf.preload_arguments(p, app_bytes=size)
            return {args[i]: args[i+1] for i in range(0, len(args), 2)}
        small, medium, large = [options(n) for n in (10*1024**2, 512*1024**2, 2*1024**3)]
        self.assertLess(int(small['--budget-mb']), int(medium['--budget-mb']))
        self.assertLess(int(medium['--budget-mb']), int(large['--budget-mb']))
        self.assertLessEqual(int(large['--budget-mb']), 512)
        self.assertLessEqual(float(large['--seconds']), 8)
        self.assertEqual(large['--workers'], small['--workers'])
        for invalid in (True, '99999999999', None, -1):
            self.assertEqual(options(invalid), small)
        self.assertIn('--constrained', perf.preload_arguments(perf.for_workers(20, True), app_bytes=99*1024**3))

    def test_server_allowance_not_client_tier_drives_native_policy(self):
        response = Response({"protocol": 3, "workspaceId": "free", "transfer": {"workers": 4}})
        with patch.object(perf.urllib.request, "build_opener") as opener:
            opener.return_value.open.return_value = response
            p = perf.configure_from_stdin(self.request(workers=24, tier="max"))
        self.assertEqual(p["workers"], 4)
        self.assertEqual(p["preloadMiB"], 32)
        self.assertTrue(p["verified"])
        args = opener.return_value.open.call_args
        request = args.args[0]
        self.assertTrue(request.full_url.endswith("/v3/cloud/free/config"))
        self.assertNotIn("token", request.full_url)
        self.assertEqual(args.kwargs["timeout"], 8)
        self.assertNotIn("bearerToken", json.dumps(p))

    def test_wrong_workspace_protocol_and_invalid_worker_fall_back_to_basic(self):
        for response in ({"protocol": 3, "workspaceId": "other", "transfer": {"workers": 24}},
                         {"protocol": 2, "workspaceId": "free", "transfer": {"workers": 24}},
                         {"protocol": 3, "workspaceId": "free", "transfer": {"workers": 999}}):
            with self.subTest(response=response), patch.object(perf.urllib.request, "build_opener") as opener:
                opener.return_value.open.return_value = Response(response)
                p = perf.configure_from_stdin(self.request())
            self.assertFalse(p["verified"])
            self.assertEqual(p["workers"], 1)

    def test_invalid_requests_never_send_credentials(self):
        bad = (self.request(workspaceId="../../other"), self.request(bearerToken="x\nX-Evil:yes"),
               self.request(constrained="false"), io.BytesIO(b"x" * (perf.INPUT_LIMIT + 1)))
        with patch.object(perf.urllib.request, "build_opener") as opener:
            for stream in bad:
                self.assertFalse(perf.configure_from_stdin(stream)["verified"])
                self.assertIsNone(perf.forwarded_input())
            opener.assert_not_called()

    def test_offline_fallback_does_not_forget_data_saver(self):
        with patch.object(perf.urllib.request, "build_opener") as opener:
            opener.return_value.open.side_effect = OSError("offline")
            p = perf.configure_from_stdin(self.request(constrained=True))
        self.assertEqual(p["preloadMiB"], 0)
        self.assertEqual(json.loads(perf.forwarded_input())["constrained"], True)
        self.assertNotIn("test-only-token", json.dumps(p))

    def test_redirects_cannot_forward_authorization(self):
        with self.assertRaises(ValueError):
            perf.NoRedirect().redirect_request(None, None, 302, "redirect", {}, "https://other.invalid")

    def test_system_certificate_context_still_requires_chain_and_hostname_verification(self):
        context = perf.tls_context()
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(context.check_hostname)
        self.assertGreater(len(context.get_ca_certs()), 0)


if __name__ == "__main__": unittest.main()
