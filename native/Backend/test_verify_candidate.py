"""Mock-only verification tests. No ADC, network, cloud writes or deployments."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import queue
import ssl
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import verify_candidate as v

RESOURCE = "projects/gendragood-ssd/locations/us-central1/services/gendragoon-free"
CANDIDATE = "gendragoon-free-00016-new"
CURRENT = "gendragoon-free-00015-old"
BASE = "https://review---gendragoon-free-example.a.run.app"
HIDDEN = "SENSITIVE-LITERAL-MUST-STAY-IN-MEMORY"


def revision(name):
    return {"name": RESOURCE + "/revisions/" + name,
            "conditions": [{"type": "Ready", "state": "CONDITION_SUCCEEDED"}],
            "serviceAccount": "runtime@example-project.iam.gserviceaccount.com",
            "containers": [{"name": "app", "image": "image-for-" + name,
                            "env": [{"name": "CONFIG", "value": HIDDEN},
                                    {"name": "KEY", "valueSource": {"secretKeyRef": {"secret": "private-binding", "version": "latest"}}}]}],
            "volumes": [{"name": "mounted", "secret": {"secret": "private-volume-reference", "items": [{"version": "1", "path": "key"}]}}]}


def service():
    return {"name": RESOURCE, "trafficStatuses": [
        {"revision": RESOURCE + "/revisions/" + CURRENT, "percent": 100},
        {"revision": RESOURCE + "/revisions/" + CANDIDATE, "tag": "review", "uri": BASE},
    ]}


def pricing():
    capacities = ["100GB", "200GB", "300GB", "500GB", "1TB", "2TB", "3TB", "4TB", "5TB", "6TB"]
    return {"currency": "usd", "workspaceFeeMonthlyCents": 500,
            "storage": {name: {"monthlyCents": 640, "yearlyCents": 6400, "bundleMonthlyCents": 799, "bundleYearlyCents": 7990} for name in capacities},
            "performance": {name: {"workers": 2, "monthlyCents": 300, "yearlyCents": 3000} for name in ("lite", "boost", "turbo", "ultra", "max")}}


class FakeHTTP:
    def __init__(self):
        self.calls = []
        self.service_data = service()
        self.candidate = revision(CANDIDATE)
        self.current = revision(CURRENT)
        self.protected_status = 401

    def get(self, url, headers=None, maximum=None):
        self.calls.append((url, dict(headers or {})))
        status, payload = 200, None
        if url == "https://run.googleapis.com/v2/" + RESOURCE:
            payload = self.service_data
        elif url == "https://run.googleapis.com/v2/" + RESOURCE + "/revisions/" + CANDIDATE:
            payload = self.candidate
        elif url == "https://run.googleapis.com/v2/" + RESOURCE + "/revisions/" + CURRENT:
            payload = self.current
        elif url == BASE + "/health?deep=1":
            payload = {"ok": True, "dependencies": "ready"}
        elif url == BASE + "/v3/capabilities":
            payload = {"protocol": 3, "authenticatedStorage": True, "resumableUploads": True, "parallelChunks": True, "rangeDownloads": True}
        elif url == BASE + "/v2/pricing":
            payload = pricing()
        elif url in [BASE + path for path in v.PROTECTED_PATHS]:
            status, payload = self.protected_status, {"error": "Sign in required"}
        else:
            raise AssertionError("Request escaped the fixed allowlist")
        return {"status": status, "payload": copy.deepcopy(payload), "error": None, "elapsedMs": 1.0}


def client(http):
    return v.CandidateClient("gendragood-ssd", "us-central1", "gendragoon-free", "SYNTHETIC-ADC-TOKEN-TEST-ONLY", http)


def fake_load(_base, requests, workers, **_options):
    return v.summarize_load([{"status": 200, "error": None, "elapsedMs": float(index + 1)} for index in range(requests)],
                            requests, workers, requests, 1.0, False)


class CandidateVerificationTests(unittest.TestCase):
    def test_system_ca_is_used_with_full_tls_verification(self):
        context = SimpleNamespace(check_hostname=False, verify_mode=None)
        with patch.object(v.Path, "is_file", return_value=True), patch.object(v.ssl, "create_default_context", return_value=context) as factory:
            self.assertIs(v.verified_context(), context)
        factory.assert_called_once_with(cafile="/etc/ssl/cert.pem")
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)

    def test_candidate_url_rejects_non_https_other_domains_and_embedded_credentials(self):
        for url in ("http://example.run.app", "https://example.run.app.evil.com", "https://user:password@example.run.app",
                    "https://example.run.app/path", "https://example.run.app?token=value", "https://example.run.app/#x",
                    "https://example.run.app:8080", "https://example.com", "https://example.run.app:bad", None):
            with self.subTest(url=url), self.assertRaises(v.VerificationFailure):
                v.safe_candidate_url(url)
        self.assertEqual(v.safe_candidate_url(BASE + "/"), BASE)

    def test_redirects_are_refused(self):
        self.assertIsNone(v.NoRedirect().redirect_request(None, None, 302, "moved", {}, "https://other.run.app"))

    def test_adc_header_only_reaches_google_control_plane(self):
        http = FakeHTTP(); c = client(http)
        c.control(); c.application(BASE, "/v1/me")
        self.assertEqual(http.calls[0][0], "https://run.googleapis.com/v2/" + RESOURCE)
        self.assertIn("Authorization", http.calls[0][1])
        self.assertNotIn("Authorization", http.calls[1][1])
        for path in ("/v2/billing/status", "/billing/stripe-webhook", "/v2/remove-ads/checkout", "/v1/free"):
            with self.assertRaises(v.VerificationFailure):
                c.application(BASE, path)
        self.assertEqual(len(http.calls), 2)

    def test_invalid_revision_cannot_redirect_a_control_plane_read(self):
        http = FakeHTTP(); c = client(http)
        for name in ("../secrets", "https://evil.example", "other-service-00001", "name/with/slash"):
            with self.assertRaises(v.VerificationFailure):
                c.control(name)
        self.assertEqual(http.calls, [])

    def test_configuration_comparison_is_order_independent_and_ignores_expected_image_change(self):
        old, new = revision(CURRENT), revision(CANDIDATE)
        new["containers"][0]["env"].reverse()
        comparison = v.compare_configuration(new, old)
        self.assertTrue(all(comparison.values()))
        self.assertTrue(all(type(value) is bool for value in comparison.values()))
        for protected in (HIDDEN, "private-binding", "private-volume-reference", "runtime@example"):
            self.assertNotIn(protected, json.dumps(comparison))

    def test_changes_to_literals_bindings_or_identity_fail_the_corresponding_comparison(self):
        old = revision(CURRENT)
        changed = revision(CANDIDATE)
        changed["containers"][0]["env"][0]["value"] = "changed"
        self.assertFalse(v.compare_configuration(changed, old)["literalEnvironmentMatches"])
        changed = revision(CANDIDATE)
        changed["volumes"][0]["secret"]["secret"] = "different-secret"
        self.assertFalse(v.compare_configuration(changed, old)["secretBindingsMatch"])
        changed = revision(CANDIDATE)
        changed["serviceAccount"] = "other@example"
        self.assertFalse(v.compare_configuration(changed, old)["serviceIdentityMatches"])

    def test_report_contains_no_configuration_values_or_adc_token(self):
        options = v.parse_options(["--tag", "review"])
        http = FakeHTTP(); report = v.initial_report(options)
        v.verify(options, client(http), report, load_runner=fake_load)
        self.assertTrue(report["passed"])
        self.assertEqual(report["load"]["completed"], 256)
        self.assertEqual(report["load"]["workers"], 16)
        self.assertEqual(report["load"]["p50Ms"], 128.0)
        self.assertEqual(report["load"]["p95Ms"], 244.0)
        for value in (HIDDEN, "SYNTHETIC-ADC-TOKEN-TEST-ONLY", "private-binding", "private-volume-reference", "runtime@example"):
            self.assertNotIn(value, json.dumps(report))
        for url, headers in http.calls:
            if url.startswith(BASE):
                self.assertNotIn("Authorization", headers)
        self.assertNotIn(BASE + "/v2/billing/status", [call[0] for call in http.calls])

    def test_configuration_mismatch_stops_before_application_requests(self):
        options = v.parse_options(["--tag", "review"])
        http = FakeHTTP(); http.candidate["serviceAccount"] = "different@example"
        with self.assertRaisesRegex(v.VerificationFailure, "configuration_differs"):
            v.verify(options, client(http), v.initial_report(options), load_runner=fake_load)
        self.assertTrue(all(url.startswith("https://run.googleapis.com/") for url, _ in http.calls))

    def test_production_traffic_prevents_candidate_load(self):
        options = v.parse_options(["--tag", "review"])
        http = FakeHTTP(); http.service_data["trafficStatuses"][1]["percent"] = 1
        with self.assertRaisesRegex(v.VerificationFailure, "production_traffic"):
            v.verify(options, client(http), v.initial_report(options), load_runner=fake_load)
        self.assertTrue(all(url.startswith("https://run.googleapis.com/") for url, _ in http.calls))

    def test_anonymous_success_or_missing_route_stops_before_load(self):
        options = v.parse_options(["--tag", "review"])
        for status in (200, 404):
            http = FakeHTTP(); http.protected_status = status
            with patch.object(v, "bounded_load", side_effect=AssertionError("Load must not run")), self.assertRaisesRegex(v.VerificationFailure, "anonymous_access"):
                v.verify(options, client(http), v.initial_report(options), load_runner=lambda *_args, **_kwargs: self.fail("Load must not run"))

    def test_load_summary_exposes_failures_and_uncompleted_work(self):
        result = v.summarize_load([{"status": 200, "error": None, "elapsedMs": 1},
                                   {"status": 503, "error": None, "elapsedMs": 20},
                                   {"status": None, "error": "timeout", "elapsedMs": 5000}], 4, 2, 4, 5.1, True)
        self.assertFalse(result["passed"])
        self.assertEqual(result["successful"], 1)
        self.assertEqual(result["uncompleted"], 1)
        self.assertEqual(result["p50Ms"], 20)
        self.assertEqual(result["p95Ms"], 5000)

    def test_load_diagnostics_preserve_path_phase_and_failed_request_order(self):
        records = [
            {"requestIndex": 4, "path": "/health", "status": 200, "error": "timeout", "errorPhase": "response_body",
             "elapsedMs": 5000, "headersMs": 20, "bodyMs": 4980, "bodyBytes": 0, "deadlineExceededBeforeBody": False},
            {"requestIndex": 0, "path": "/health", "status": 200, "error": "timeout", "errorPhase": "request_deadline_before_body",
             "elapsedMs": 5120, "headersMs": 5119, "bodyMs": 1, "bodyBytes": 0, "deadlineExceededBeforeBody": True},
            {"requestIndex": 1, "path": "/v2/pricing", "status": 200, "error": None, "errorPhase": None,
             "elapsedMs": 100, "headersMs": 99, "bodyMs": 1, "bodyBytes": 2559, "deadlineExceededBeforeBody": False},
        ]
        report = v.summarize_load(records, 3, 3, 3, 6, False)
        self.assertFalse(report["passed"])
        self.assertEqual(report["statusCounts"], {"200": 3})
        self.assertEqual(report["successful"], 1)
        self.assertEqual(report["byPath"]["/health"]["deadlineExceededBeforeBody"], 1)
        self.assertEqual(report["byPath"]["/health"]["errorPhaseCounts"], {"response_body": 1, "request_deadline_before_body": 1})
        self.assertEqual(report["byPath"]["/v2/pricing"]["timings"]["bodyMs"]["max"], 1)
        self.assertEqual([sample["requestIndex"] for sample in report["failureSamples"]], [0, 4])

    def test_parser_and_load_budgets_cannot_exceed_requested_limits(self):
        for arguments in (["--requests", "257"], ["--workers", "17"], ["--load-timeout", "61"], ["--request-timeout", "16"]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                v.parse_options(["--tag", "review"] + arguments)
        with patch.object(v.multiprocessing, "get_context", side_effect=AssertionError("No process should start")), self.assertRaises(v.VerificationFailure):
            v.bounded_load(BASE, requests=257)

    def test_report_written_atomically_with_restricted_permissions(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "report.json"
            v.write_report(target, '{"passed":true}')
            self.assertEqual(json.loads(target.read_text()), {"passed": True})
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)

    def test_bounded_body_stops_after_total_read_deadline(self):
        response = SimpleNamespace(read1=lambda _count: b"x", fp=None)
        clock = iter([1.0, 4.0, 6.0])
        with patch.object(v.time, "monotonic", side_effect=lambda: next(clock)), self.assertRaises(TimeoutError):
            v._bounded_body(response, 5.0, 100)

    def test_bounded_body_rejects_oversized_response(self):
        response = SimpleNamespace(read1=lambda _count: b"too-large", fp=None)
        with self.assertRaisesRegex(v.VerificationFailure, "response_size_limit"):
            v._bounded_body(response, v.time.monotonic() + 1, 4)

    def test_late_http_200_headers_still_fail_the_unchanged_request_deadline(self):
        class Response:
            code, length, fp = 200, 78, None
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read1(self, _count):
                raise AssertionError("An exhausted total deadline must prevent body reading")
        opener = SimpleNamespace(open=lambda *_args, **_kwargs: Response())
        with patch.object(v.time, "monotonic", side_effect=[0, 5.12, 5.12, 5.12, 5.12]):
            result = v.ReadOnlyHTTP(timeout=5, opener=opener).get(BASE)
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["error"], "timeout")
        self.assertEqual(result["errorPhase"], "request_deadline_before_body")
        self.assertEqual(result["headersMs"], 5120)
        self.assertEqual(result["bodyMs"], 0)
        self.assertEqual(result["bodyBytes"], 0)
        self.assertEqual(result["declaredBodyBytes"], 78)
        self.assertTrue(result["deadlineExceededBeforeBody"])

    def test_body_timeout_is_distinguished_from_late_headers(self):
        class Response:
            code, length, fp = 200, 78, None
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return False
            def read1(self, _count):
                raise TimeoutError()
        opener = SimpleNamespace(open=lambda *_args, **_kwargs: Response())
        with patch.object(v.time, "monotonic", side_effect=[0, .2, .21, 5.01, 5.02]):
            result = v.ReadOnlyHTTP(timeout=5, opener=opener).get(BASE)
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["error"], "timeout")
        self.assertEqual(result["errorPhase"], "response_body")
        self.assertEqual(result["headersMs"], 200)
        self.assertEqual(result["bodyMs"], 4810)
        self.assertFalse(result["deadlineExceededBeforeBody"])

    def test_global_deadline_is_not_swallowed_by_network_error_handling(self):
        opener = SimpleNamespace(open=lambda *_args, **_kwargs: (_ for _ in ()).throw(v.OverallDeadline("overall_hard_deadline_exceeded")))
        with self.assertRaises(v.OverallDeadline):
            v.ReadOnlyHTTP(opener=opener).get(BASE)

    def test_load_watchdog_terminates_a_stuck_child_without_network(self):
        class FakeEvents:
            def get(self, timeout):
                raise queue.Empty()
            def cancel_join_thread(self):
                pass
            def close(self):
                pass
        class FakeProcess:
            def __init__(self):
                self.alive = False; self.terminated = False
            def start(self):
                self.alive = True
            def is_alive(self):
                return self.alive
            def terminate(self):
                self.alive = False; self.terminated = True
            def join(self, timeout):
                pass
            def kill(self):
                self.alive = False
        process = FakeProcess(); events = FakeEvents()
        context = SimpleNamespace(Queue=lambda: events, Process=lambda **_kwargs: process)
        clock = [0.0]
        def tick():
            clock[0] += 0.25
            return clock[0]
        with patch.object(v.multiprocessing, "get_context", return_value=context), patch.object(v.time, "monotonic", side_effect=tick):
            result = v.bounded_load(BASE, requests=1, workers=1, deadline_seconds=1)
        self.assertTrue(process.terminated)
        self.assertTrue(result["hardDeadlineExceeded"])
        self.assertEqual(result["completed"], 0)
        self.assertFalse(result["passed"])


if __name__ == "__main__":
    unittest.main()
