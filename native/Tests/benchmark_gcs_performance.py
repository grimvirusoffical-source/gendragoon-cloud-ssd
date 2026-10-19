#!/usr/bin/env python3
"""Opt-in, bounded real-GCS comparison of the native transfer worker settings.

Uses disposable generated files in a unique validation prefix. It does not mount
anything, change the selected plan, upload user data, or delete user cloud files.
The results measure this network/workload, not a guaranteed plan speed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import random
import re
import shutil
import ssl
import subprocess
import tempfile
import time
import uuid
import urllib.request

RESERVE = 10 * 1024**3
FILES = 24
FILE_BYTES = 512 * 1024
WORKERS = (1, 2, 4, 8, 12, 20, 24)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--execute", action="store_true", required=True)
    p.add_argument("--app", type=Path, required=True)
    p.add_argument("--gcloud", type=Path, required=True)
    p.add_argument("--config", type=Path, required=True)
    p.add_argument("--project", required=True)
    p.add_argument("--bucket", required=True)
    p.add_argument("--remote", required=True)
    p.add_argument("--report", type=Path, required=True)
    a = p.parse_args()
    for value in (a.project, a.bucket, a.remote):
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{1,100}", value):
            raise ValueError("Invalid selected destination")
    rclone = a.app / "Contents/Resources/rclone"
    if a.app.is_symlink() or not rclone.is_file() or a.config.is_symlink():
        raise ValueError("Invalid application or cloud configuration")
    prefix = "GenDragoon-Validation/performance-" + uuid.uuid4().hex
    target = a.remote + ":" + a.bucket + "/" + prefix
    report = {"ok": False, "scope": "real GCS native rclone worker comparison",
              "cloudPrefix": prefix, "workers": list(WORKERS), "fileCountPerTrial": FILES,
              "bytesPerTrial": FILES * FILE_BYTES, "minimumFreeBytes": RESERVE,
              "samples": [], "cloudFixturesRemoved": False, "mountOperations": False,
              "paidCheckoutTested": False, "serverEntitlementVerificationTested": False,
              "commercialApplicationLaunchTested": False,
              "limitation": "One small-file workload on this Mac/network; no universal speed guarantee."}
    a.report.parent.mkdir(parents=True, exist_ok=True)

    def save():
        a.report.write_text(json.dumps(report, indent=2) + "\n")

    def call(command, timeout=45, label="transfer"):
        result = subprocess.run([str(x) for x in command], stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
        if result.returncode:
            raise RuntimeError("Benchmark " + label + " failed (exit " + str(result.returncode) + "); no unverified fixture cleanup attempted")
        return result.stdout.decode("utf8").strip()

    def require_space():
        free = shutil.disk_usage(a.report.parent).free
        if free < RESERVE + FILES * FILE_BYTES * 2:
            raise RuntimeError("Benchmark deferred: the unchanged 10 GiB free-space reserve would be crossed")
        return free

    try:
        require_space()
        call(["/usr/bin/codesign", "--verify", "--deep", "--strict", a.app], 60, "signature verification")
        # Reuse the app's ADC credential and Google's canonical REST fields.
        # gcloud's rendered bucket schema differs from the JSON API schema.
        token = call([a.gcloud, "auth", "application-default", "print-access-token"], label="ADC authentication")
        if not token or any(c.isspace() for c in token):
            raise RuntimeError("Google application-default credentials are unavailable")
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, request, fp, code, message, headers, url):
                raise RuntimeError("Google ownership lookup returned an unexpected redirect")
        def google_object(url):
            request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
            roots = Path("/etc/ssl/cert.pem")
            context = ssl.create_default_context(cafile=str(roots)) if roots.is_file() else ssl.create_default_context()
            with urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=context)).open(request, timeout=15) as response:
                data = response.read(65537)
                if response.status != 200 or len(data) > 65536:
                    raise RuntimeError("Invalid Google ownership response")
            return json.loads(data)
        project = google_object("https://cloudresourcemanager.googleapis.com/v1/projects/" + a.project)
        bucket = google_object("https://storage.googleapis.com/storage/v1/b/" + a.bucket)
        token = ""
        project_number = str(project.get("projectNumber", ""))
        if not (project.get("projectId") == a.project and project.get("lifecycleState") == "ACTIVE"
                and project_number.isdigit() and bucket.get("name") == a.bucket
                and str(bucket.get("projectNumber")) == project_number):
            raise RuntimeError("Selected project does not own the test bucket")
        report["projectBucketOwnershipVerified"] = True
        base = [rclone, "--config", a.config]
        expected = []
        with tempfile.TemporaryDirectory(prefix="gd-performance-", dir=a.report.parent) as directory:
            root = Path(directory)
            source = root / "source"
            source.mkdir(mode=0o700)
            rng = random.Random(20261017)
            hashes = {}
            for i in range(FILES):
                name = f"fixture-{i:03d}.bin"
                data = rng.randbytes(FILE_BYTES)
                (source / name).write_bytes(data)
                hashes[name] = hashlib.sha256(data).hexdigest()
            for workers in WORKERS:
                free = require_space()
                destination = target + "/workers-" + str(workers)
                expected += ["workers-" + str(workers) + "/" + n for n in hashes]
                flags = ["--transfers", str(workers), "--checkers", str(min(8, workers)),
                         "--multi-thread-streams", str(min(8, workers)), "--multi-thread-cutoff", "16M",
                         "--retries", "2", "--low-level-retries", "2"]
                start = time.monotonic()
                call([*base, "copy", source, destination, *flags])
                upload_seconds = time.monotonic() - start
                restored = root / "restored"
                restored.mkdir(mode=0o700)
                start = time.monotonic()
                call([*base, "copy", destination, restored, *flags])
                download_seconds = time.monotonic() - start
                observed = {x.name: hashlib.sha256(x.read_bytes()).hexdigest() for x in restored.iterdir() if x.is_file()}
                if observed != hashes:
                    raise RuntimeError("A downloaded fixture did not match the original SHA-256")
                shutil.rmtree(restored)
                report["samples"].append({"workers": workers, "uploadSeconds": round(upload_seconds, 3),
                    "downloadSeconds": round(download_seconds, 3), "verifiedFiles": FILES,
                    "uploadMiBPerSecond": round(FILES * FILE_BYTES / 1024**2 / upload_seconds, 3),
                    "downloadMiBPerSecond": round(FILES * FILE_BYTES / 1024**2 / download_seconds, 3),
                    "freeBeforeBytes": free})
                save()
                print(json.dumps(report["samples"][-1]), flush=True)
            listed = call([*base, "lsf", target, "--recursive", "--files-only"]).splitlines()
            if sorted(listed) != sorted(expected):
                raise RuntimeError("Unexpected validation content; cleanup stopped")
            names = root / "verified-fixtures.txt"
            names.write_text("\n".join(expected) + "\n")
            call([*base, "delete", target, "--files-from", names, "--transfers", "8"])
            if call([*base, "lsf", target, "--recursive", "--files-only"]):
                raise RuntimeError("Some generated cloud fixtures remain")
            report.update(ok=True, cloudFixturesRemoved=True, verifiedRoundTrips=len(WORKERS) * FILES,
                          logicalTransferredBytes=len(WORKERS) * FILES * FILE_BYTES * 2)
    except Exception as error:
        report["error"] = str(error)[:500]
    save()
    print(json.dumps({"ok": report["ok"], "samples": len(report["samples"]),
                      "cloudFixturesRemoved": report["cloudFixturesRemoved"]}), flush=True)
    return 0 if report["ok"] else 1


if __name__ == "__main__": raise SystemExit(main())
