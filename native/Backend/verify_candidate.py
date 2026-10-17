#!/usr/bin/env python3
"""Read-only Cloud Run candidate verification. No Stripe activation or mutations."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import math
import multiprocessing
import os
from pathlib import Path
import queue
import re
import shutil
import signal
import socket
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

PUBLIC_PATHS = ("/health", "/v3/capabilities", "/v2/pricing")
SMOKE_PATHS = ("/health?deep=1", "/v3/capabilities", "/v2/pricing")
PROTECTED_PATHS = ("/v1/me", "/v1/files", "/v1/keys", "/v2/workspaces", "/v2/account/entitlements")
ALLOWED_APP_PATHS = frozenset(PUBLIC_PATHS + SMOKE_PATHS + PROTECTED_PATHS)
APP_RESPONSE_LIMIT = 131_072
METADATA_RESPONSE_LIMIT = 1_048_576
IDENTIFIER = re.compile(r"[a-z][a-z0-9-]{2,62}\Z")
TAG = re.compile(r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


class VerificationFailure(Exception):
    """Only fixed diagnostic codes may be placed in this exception."""


class OverallDeadline(VerificationFailure):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def verified_context(ca_file=None):
    if ca_file:
        context = ssl.create_default_context(cafile=str(ca_file))
    elif Path("/etc/ssl/cert.pem").is_file():
        # Python.org macOS distributions can lack their own CA installation.
        context = ssl.create_default_context(cafile="/etc/ssl/cert.pem")
    else:
        context = ssl.create_default_context()
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context


def safe_candidate_url(value):
    if not isinstance(value, str):
        raise VerificationFailure("candidate_url_missing")
    try:
        parts = urllib.parse.urlsplit(value)
        valid = (parts.scheme == "https" and parts.username is None and parts.password is None
                 and parts.port in (None, 443) and parts.path in ("", "/")
                 and not parts.query and not parts.fragment and parts.hostname
                 and re.fullmatch(r"[a-z0-9.-]+", parts.hostname)
                 and parts.hostname.endswith(".run.app"))
    except ValueError:
        valid = False
    if not valid:
        raise VerificationFailure("unsafe_candidate_url")
    return value.rstrip("/")


def _bounded_body(response, deadline, maximum, progress=None):
    """read1 returns available bytes, allowing an overall read deadline even for dribbled responses."""
    result = bytearray()
    progress = progress if progress is not None else {}
    progress["bodyBytes"] = 0
    reader = getattr(response, "read1", None)
    if reader is None:
        raise VerificationFailure("unsupported_http_reader")
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError()
        raw = getattr(getattr(response, "fp", None), "raw", None)
        connection = getattr(raw, "_sock", None)
        if connection is not None:
            connection.settimeout(remaining)
        chunk = reader(min(16_384, maximum + 1 - len(result)))
        if not chunk:
            break
        result.extend(chunk)
        progress["bodyBytes"] = len(result)
        if len(result) > maximum:
            raise VerificationFailure("response_size_limit")
    return bytes(result)


class ReadOnlyHTTP:
    def __init__(self, timeout=5.0, ca_file=None, opener=None):
        self.timeout = timeout
        self.opener = opener or urllib.request.build_opener(
            urllib.request.HTTPSHandler(context=verified_context(ca_file)), NoRedirect())

    def get(self, url, headers=None, maximum=APP_RESPONSE_LIMIT):
        start = time.monotonic()
        status, payload, error = None, None, None
        phase, header_at, body_at, decoded_at = "response_headers", None, None, None
        declared_body_bytes, progress, deadline_before_body = None, {"bodyBytes": 0}, False
        try:
            if urllib.parse.urlsplit(url).scheme != "https":
                raise VerificationFailure("https_required")
            request = urllib.request.Request(url, method="GET", headers=headers or {"Accept": "application/json"})
            try:
                response = self.opener.open(request, timeout=self.timeout)
            except urllib.error.HTTPError as failure:
                response = failure
            with response:
                status = response.code
                header_at = time.monotonic()
                content_length = getattr(response, "length", None)
                if type(content_length) is int and content_length >= 0:
                    declared_body_bytes = content_length
                deadline_before_body = header_at >= start + self.timeout
                # urllib's socket timeout is per blocking operation, not a total
                # request deadline. Record late headers before enforcing the
                # unchanged total budget for the body.
                phase = "request_deadline_before_body" if deadline_before_body else "response_body"
                try:
                    raw = _bounded_body(response, start + self.timeout, maximum, progress)
                finally:
                    body_at = time.monotonic()
            phase = "json_decode"
            try:
                payload = json.loads(raw)
            except (ValueError, UnicodeError, RecursionError):
                error = "invalid_json"
            decoded_at = time.monotonic()
        except OverallDeadline:
            raise
        except (TimeoutError, socket.timeout):
            error = "timeout"
        except ssl.SSLError:
            error = "tls_verification_failed"
        except urllib.error.URLError as failure:
            if isinstance(failure.reason, ssl.SSLError):
                error = "tls_verification_failed"
            elif isinstance(failure.reason, (TimeoutError, socket.timeout)):
                error = "timeout"
            else:
                error = "transport_error"
        except VerificationFailure as failure:
            error = failure.args[0]
        except Exception:
            error = "transport_error"
        finished = time.monotonic()
        return {"status": status, "payload": payload, "error": error,
                "elapsedMs": round((finished - start) * 1000, 3), "errorPhase": phase if error else None,
                "headersMs": round((header_at - start) * 1000, 3) if header_at is not None else None,
                "bodyMs": round((body_at - header_at) * 1000, 3) if body_at is not None else None,
                "decodeMs": round((decoded_at - body_at) * 1000, 3) if decoded_at is not None else None,
                "bodyBytes": progress["bodyBytes"], "declaredBodyBytes": declared_body_bytes,
                "deadlineExceededBeforeBody": deadline_before_body}


def existing_adc(gcloud=None):
    bundled = Path.home() / "Library/Application Support/GenDragoon Cloud SSD/Tools/google-cloud-sdk/bin/gcloud"
    executable = gcloud or shutil.which("gcloud") or (str(bundled) if bundled.is_file() else None)
    if not executable:
        raise VerificationFailure("gcloud_unavailable")
    try:
        result = subprocess.run([executable, "auth", "application-default", "print-access-token"],
                                capture_output=True, text=True, timeout=40)
    except OverallDeadline:
        raise
    except Exception:
        raise VerificationFailure("adc_unavailable") from None
    token = result.stdout.strip()
    if result.returncode or not re.fullmatch(r"[A-Za-z0-9._~+/=-]{20,8192}", token):
        raise VerificationFailure("adc_unavailable")
    return token


class CandidateClient:
    """Bearer credentials are used only on the fixed Google control-plane host."""
    def __init__(self, project, region, service, token, http):
        self.resource = f"projects/{project}/locations/{region}/services/{service}"
        self.region, self.service, self.token, self.http = region, service, token, http
        self.control_reads = 0

    def control(self, revision=None):
        resource = self.resource
        if revision is not None:
            if not isinstance(revision, str) or not IDENTIFIER.fullmatch(revision) or not revision.startswith(self.service + "-"):
                raise VerificationFailure("invalid_revision_identifier")
            resource += "/revisions/" + revision
        self.control_reads += 1
        result = self.http.get("https://run.googleapis.com/v2/" + resource,
                               headers={"Accept": "application/json", "Authorization": "Bearer " + self.token},
                               maximum=METADATA_RESPONSE_LIMIT)
        if result["status"] != 200 or result["error"] or not isinstance(result["payload"], dict):
            raise VerificationFailure("control_plane_read_failed")
        return result["payload"]

    def application(self, base, path):
        if path not in ALLOWED_APP_PATHS:
            raise VerificationFailure("application_path_not_read_only_allowlisted")
        return self.http.get(safe_candidate_url(base) + path, headers={"Accept": "application/json"})


def revision_name(reference, service, region):
    if not isinstance(reference, str):
        raise VerificationFailure("unresolved_revision")
    if "/" in reference:
        parts = reference.split("/")
        if len(parts) != 8 or parts[0] != "projects" or parts[2:4] != ["locations", region] or parts[4:7] != ["services", service, "revisions"]:
            raise VerificationFailure("unexpected_revision_resource")
        reference = parts[-1]
    if not IDENTIFIER.fullmatch(reference) or not reference.startswith(service + "-"):
        raise VerificationFailure("invalid_revision_identifier")
    return reference


def traffic_snapshot(service_data, tag, service, region):
    traffic = service_data.get("trafficStatuses")
    if not isinstance(traffic, list) or not traffic:
        raise VerificationFailure("traffic_status_unavailable")
    matches = [entry for entry in traffic if isinstance(entry, dict) and entry.get("tag") == tag]
    if len(matches) != 1:
        raise VerificationFailure("candidate_tag_missing_or_ambiguous")
    target = matches[0]
    candidate = revision_name(target.get("revision"), service, region)
    serving, candidate_percent = set(), 0
    for entry in traffic:
        if not isinstance(entry, dict):
            raise VerificationFailure("traffic_status_invalid")
        percent = entry.get("percent") or 0
        if type(percent) is not int or not 0 <= percent <= 100:
            raise VerificationFailure("traffic_percentage_invalid")
        if percent:
            name = revision_name(entry.get("revision"), service, region)
            serving.add(name)
            if name == candidate:
                candidate_percent += percent
    if not serving or len(serving) > 8:
        raise VerificationFailure("serving_revisions_unresolved_or_exceed_limit")
    return {"revision": candidate, "url": safe_candidate_url(target.get("uri")),
            "productionPercent": candidate_percent, "serving": sorted(serving)}


def ready_revision(data):
    conditions = list(data.get("conditions") or [])
    if isinstance(data.get("terminalCondition"), dict):
        conditions.append(data["terminalCondition"])
    return data.get("reconciling") is not True and any(
        isinstance(item, dict) and item.get("type") == "Ready"
        and (item.get("state") == "CONDITION_SUCCEEDED" or item.get("status") in (True, "True"))
        for item in conditions)


def _configuration(data):
    containers = data.get("containers")
    if not isinstance(containers, list) or not containers:
        raise VerificationFailure("revision_configuration_unavailable")
    literals, bindings = {}, {}
    for index, container in enumerate(containers):
        name = container.get("name") or "container-" + str(index)
        if name in literals:
            raise VerificationFailure("revision_container_ambiguous")
        literals[name], bindings[name] = {}, {}
        for item in container.get("env") or []:
            key = item.get("name")
            if not isinstance(key, str) or key in literals[name] or key in bindings[name]:
                raise VerificationFailure("revision_environment_ambiguous")
            if "valueSource" in item:
                bindings[name][key] = item["valueSource"]
            else:
                literals[name][key] = item.get("value", "")
    secret_volumes = {item.get("name"): item["secret"] for item in data.get("volumes", []) if "secret" in item}
    return {"literals": literals, "bindings": bindings, "secretVolumes": secret_volumes,
            "identity": data.get("serviceAccount"), "containers": len(containers)}


def compare_configuration(candidate, serving):
    left, right = _configuration(candidate), _configuration(serving)
    # Literal values and binding identifiers remain in memory and never enter the report.
    return {
        "literalEnvironmentMatches": left["literals"] == right["literals"],
        "secretBindingsMatch": left["bindings"] == right["bindings"] and left["secretVolumes"] == right["secretVolumes"],
        "serviceIdentityMatches": isinstance(left["identity"], str) and bool(left["identity"]) and left["identity"] == right["identity"],
        "containerCountMatches": left["containers"] == right["containers"],
    }


def smoke_valid(path, result):
    data = result.get("payload")
    if result.get("status") != 200 or result.get("error") or not isinstance(data, dict):
        return False
    if path == "/health?deep=1":
        return data.get("ok") is True and data.get("dependencies") == "ready"
    if path == "/v3/capabilities":
        return data.get("protocol") == 3 and all(data.get(key) is True for key in
                                                ("authenticatedStorage", "resumableUploads", "parallelChunks", "rangeDownloads"))
    storage, performance = data.get("storage"), data.get("performance")
    if not isinstance(storage, dict) or not isinstance(performance, dict) or len(storage) != 10 or len(performance) != 5:
        return False
    fields = ("monthlyCents", "yearlyCents", "bundleMonthlyCents", "bundleYearlyCents")
    return ("6TB" in storage and "max" in performance
            and all(type(plan.get(key)) is int and plan[key] > 0 for plan in storage.values() for key in fields)
            and all(type(plan.get(key)) is int and plan[key] > 0 for plan in performance.values() for key in ("workers", "monthlyCents", "yearlyCents"))
            and type(data.get("workspaceFeeMonthlyCents")) is int and data["workspaceFeeMonthlyCents"] >= 0
            and data.get("currency", "usd") == "usd")


def summarize_load(records, requested, workers, started, elapsed, deadline_exceeded):
    latencies = sorted(record["elapsedMs"] for record in records if type(record.get("elapsedMs")) in (float, int))
    status_counts, error_counts = {}, {}
    for record in records:
        status = str(record.get("status")) if record.get("status") is not None else "no_http_response"
        status_counts[status] = status_counts.get(status, 0) + 1
        if record.get("error"):
            error_counts[record["error"]] = error_counts.get(record["error"], 0) + 1
    success = sum(record.get("status") == 200 and not record.get("error") for record in records)
    def percentile(value):
        return round(latencies[max(0, math.ceil(len(latencies) * value) - 1)], 3) if latencies else None
    report = {"requested": requested, "workers": workers, "observedStarted": max(started, len(records)),
            "completed": len(records), "successful": success, "notSuccessfulOrUncompleted": requested - success,
            "uncompleted": requested - len(records), "statusCounts": status_counts, "errorCounts": error_counts,
            "p50Ms": percentile(0.50), "p95Ms": percentile(0.95),
            "latencyPopulation": "all completed attempts, including HTTP and transport failures",
            "percentileMethod": "nearest-rank", "elapsedSeconds": round(elapsed, 3),
            "hardDeadlineExceeded": deadline_exceeded,
            "passed": len(records) == requested and success == requested and not deadline_exceeded}
    report["transport"] = "urllib HTTPS; fresh connection per request; no retries"
    report["headersTimingIncludes"] = "DNS, TCP/TLS connection setup, request send and response headers"
    report["byPath"] = {}
    for path in PUBLIC_PATHS:
        selected = [record for record in records if record.get("path") == path]
        if not selected:
            continue
        statuses, errors, phases = {}, {}, {}
        for record in selected:
            status = str(record.get("status")) if record.get("status") is not None else "no_http_response"
            statuses[status] = statuses.get(status, 0) + 1
            if record.get("error"):
                code = record["error"]
                errors[code] = errors.get(code, 0) + 1
                phase = record.get("errorPhase") or "unspecified"
                phases[phase] = phases.get(phase, 0) + 1
        timings = {}
        for field in ("elapsedMs", "headersMs", "bodyMs", "decodeMs"):
            values = sorted(record[field] for record in selected if type(record.get(field)) in (float, int))
            if values:
                timings[field] = {"p50": round(values[max(0, math.ceil(len(values) * .5) - 1)], 3),
                                  "p95": round(values[max(0, math.ceil(len(values) * .95) - 1)], 3),
                                  "max": round(values[-1], 3), "samples": len(values)}
        report["byPath"][path] = {"completed": len(selected),
                                  "successful": sum(record.get("status") == 200 and not record.get("error") for record in selected),
                                  "statusCounts": statuses, "errorCounts": errors, "errorPhaseCounts": phases,
                                  "deadlineExceededBeforeBody": sum(record.get("deadlineExceededBeforeBody") is True for record in selected),
                                  "timings": timings}
    failed = sorted((record for record in records if record.get("status") != 200 or record.get("error")),
                    key=lambda record: record.get("requestIndex", requested))
    fields = ("requestIndex", "path", "startedOffsetMs", "status", "error", "errorPhase", "elapsedMs",
              "headersMs", "bodyMs", "decodeMs", "bodyBytes", "declaredBodyBytes", "deadlineExceededBeforeBody")
    report["failureSamples"] = [{key: record[key] for key in fields if key in record} for record in failed[:32]]
    report["failureSamplesOmitted"] = max(0, len(failed) - 32)
    return report


def _load_process(events, base, requests, workers, request_timeout, ca_file):
    # No ADC token or control-plane client is passed into this subprocess.
    try:
        http = ReadOnlyHTTP(request_timeout, ca_file)
        load_start = time.monotonic()
        def request(index):
            events.put(("started", None))
            offset = round((time.monotonic() - load_start) * 1000, 3)
            path = PUBLIC_PATHS[index % len(PUBLIC_PATHS)]
            result = http.get(base + path, headers={"Accept": "application/json"})
            record = {key: value for key, value in result.items() if key != "payload"}
            return {"requestIndex": index, "path": path, "startedOffsetMs": offset, **record}
        with ThreadPoolExecutor(max_workers=workers) as pool:
            futures = [pool.submit(request, index) for index in range(requests)]
            for future in as_completed(futures):
                events.put(("result", future.result()))
        events.put(("done", None))
    except Exception:
        try:
            events.put(("failed", None))
        except Exception:
            pass


def bounded_load(base, requests=256, workers=16, request_timeout=5.0, deadline_seconds=45.0, ca_file=None):
    base = safe_candidate_url(base)
    if not 1 <= requests <= 256 or not 1 <= workers <= 16 or not 0 < request_timeout <= 15 or not 0 < deadline_seconds <= 60:
        raise VerificationFailure("load_budget_invalid")
    context = multiprocessing.get_context("spawn")
    events = context.Queue()
    process = context.Process(target=_load_process, args=(events, base, requests, workers, request_timeout, ca_file))
    start, records, started, done = time.monotonic(), [], 0, False
    process.start()
    try:
        deadline = start + deadline_seconds
        while time.monotonic() < deadline:
            try:
                event, data = events.get(timeout=min(0.2, max(0.001, deadline - time.monotonic())))
            except queue.Empty:
                if not process.is_alive():
                    break
                continue
            if event == "started":
                started += 1
            elif event == "result":
                records.append(data)
            elif event == "done":
                done = True
                break
            elif event == "failed":
                break
    finally:
        if process.is_alive():
            if not done:
                process.terminate()
            process.join(timeout=1)
            if process.is_alive():
                process.kill()
                process.join(timeout=1)
        else:
            process.join(timeout=1)
        events.cancel_join_thread()
        events.close()
    elapsed = time.monotonic() - start
    return summarize_load(records, requests, workers, started, elapsed, not done and elapsed >= deadline_seconds)


def initial_report(options):
    return {"schemaVersion": 1, "passed": False,
            "scope": "tagged candidate; read-only metadata, public endpoints and anonymous rejection checks",
            "limits": {"loadRequests": options.requests, "workers": options.workers,
                       "requestTimeoutSeconds": options.request_timeout, "loadHardDeadlineSeconds": options.load_timeout,
                       "overallHardDeadlineSeconds": options.overall_timeout, "terminationGraceSeconds": 2,
                       "applicationRequestsMaximum": options.requests + len(SMOKE_PATHS) + len(PROTECTED_PATHS),
                       "applicationResponseBytesMaximum": APP_RESPONSE_LIMIT},
            "security": {"tlsCertificateAndHostnameVerification": True, "redirectsAllowed": False,
                         "adcUsedOnlyForCloudRunControlPlane": True, "authorizationSentToApplication": False,
                         "secretManagerPayloadsFetched": False, "configurationValuesPrinted": False},
            "excluded": ["Stripe activation, Checkout and payments", "Authenticated customer data",
                         "Production application traffic", "Writes, deletes, deployment and traffic promotion",
                         "Sustained saturation testing or an independent penetration test"]}


def verify(options, client, report, load_runner=bounded_load):
    service_data = client.control()
    snapshot = traffic_snapshot(service_data, options.tag, options.service, options.region)
    candidate = client.control(snapshot["revision"])
    report["candidate"] = {"tag": options.tag, "revision": snapshot["revision"], "url": snapshot["url"]}
    report["preflight"] = {"ready": ready_revision(candidate), "zeroProductionTraffic": snapshot["productionPercent"] == 0}
    if not all(report["preflight"].values()):
        raise VerificationFailure("candidate_not_ready_or_receives_production_traffic")
    comparisons = [compare_configuration(candidate, client.control(name)) for name in snapshot["serving"]]
    report["configurationComparison"] = {key: all(item[key] for item in comparisons) for key in comparisons[0]}
    if not all(report["configurationComparison"].values()):
        raise VerificationFailure("candidate_configuration_differs_from_serving_revision")
    report["smoke"] = {}
    for path in SMOKE_PATHS:
        result = client.application(snapshot["url"], path)
        report["smoke"][path] = {"status": result["status"], "passed": smoke_valid(path, result), "error": result["error"]}
    if not all(check["passed"] for check in report["smoke"].values()):
        raise VerificationFailure("read_only_smoke_check_failed")
    report["anonymousProtectedGETs"] = {}
    for path in PROTECTED_PATHS:
        result = client.application(snapshot["url"], path)
        # A missing route (404) is not evidence of authentication enforcement.
        report["anonymousProtectedGETs"][path] = {"status": result["status"], "rejected": result["status"] in (401, 403)}
    if not all(item["rejected"] for item in report["anonymousProtectedGETs"].values()):
        raise VerificationFailure("anonymous_access_not_rejected")
    report["load"] = load_runner(snapshot["url"], requests=options.requests, workers=options.workers,
                                 request_timeout=options.request_timeout, deadline_seconds=options.load_timeout, ca_file=options.ca_file)
    after = traffic_snapshot(client.control(), options.tag, options.service, options.region)
    report["postflight"] = {"sameTaggedRevision": after["revision"] == snapshot["revision"],
                           "stillZeroProductionTraffic": after["productionPercent"] == 0}
    report["passed"] = report["load"]["passed"] and all(report["postflight"].values())
    report["controlPlaneGETs"] = client.control_reads
    return report


def parse_options(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default="gendragood-ssd")
    parser.add_argument("--region", default="us-central1")
    parser.add_argument("--service", default="gendragoon-free")
    parser.add_argument("--tag", required=True)
    parser.add_argument("--requests", type=int, default=256)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--request-timeout", type=float, default=5.0)
    parser.add_argument("--load-timeout", type=float, default=45.0)
    parser.add_argument("--overall-timeout", type=int, default=180)
    parser.add_argument("--ca-file")
    parser.add_argument("--report", help="Optional local JSON report path; contains no credentials or configuration values")
    options = parser.parse_args(arguments)
    if any(not IDENTIFIER.fullmatch(value) for value in (options.project, options.region, options.service)) or not TAG.fullmatch(options.tag):
        parser.error("Invalid project, region, service or tag identifier")
    if not 1 <= options.requests <= 256 or not 1 <= options.workers <= 16:
        parser.error("Load is capped at 256 requests and 16 workers")
    if not 0 < options.request_timeout <= 15 or not 0 < options.load_timeout <= 60 or not 30 <= options.overall_timeout <= 300:
        parser.error("Timeouts exceed the bounded verification budget")
    return options


def write_report(path, encoded):
    destination = Path(path).expanduser()
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, staged = tempfile.mkstemp(prefix=".gd-candidate-report-", dir=destination.parent)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(encoded + "\n"); stream.flush(); os.fsync(stream.fileno())
        os.replace(staged, destination)
    finally:
        if os.path.exists(staged):
            os.unlink(staged)


def main(arguments=None):
    options = parse_options(arguments)
    report = initial_report(options)
    if not hasattr(signal, "SIGALRM"):
        report["error"] = "hard_overall_deadline_requires_macos_or_linux"
    else:
        def expired(_signal, _frame):
            raise OverallDeadline("overall_hard_deadline_exceeded")
        previous = signal.signal(signal.SIGALRM, expired)
        signal.setitimer(signal.ITIMER_REAL, options.overall_timeout)
        try:
            http = ReadOnlyHTTP(options.request_timeout, options.ca_file)
            client = CandidateClient(options.project, options.region, options.service, existing_adc(), http)
            verify(options, client, report)
        except VerificationFailure as failure:
            report["error"] = failure.args[0]
        except Exception:
            # No exception bodies, environment data, provider errors, or request headers are printed.
            report["error"] = "verification_runtime_error"
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
    encoded = json.dumps(report, indent=2, sort_keys=True, allow_nan=False)
    if options.report:
        try:
            write_report(options.report, encoded)
        except Exception:
            report["reportSaved"] = False
            report["passed"] = False
            report["error"] = "report_write_failed"
            encoded = json.dumps(report, indent=2, sort_keys=True, allow_nan=False)
    print(encoded)
    return 0 if report["passed"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
