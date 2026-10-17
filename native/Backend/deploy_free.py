#!/usr/bin/env python3
"""Deploy this checkout's runtime; retain the service's existing secrets and settings."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

BASE = Path(__file__).resolve().parent
RUNTIME_FILES = (
    "free_server.js", "free_performance.js", "billing_bootstrap.js",
    "billing_gateway.js", "billing_v2.js", "catalog.js", "performance.js",
    "gpu_catalog.js", "owner_benefits.js", "api_keys.js", "paid_storage.js",
    "transfer_v3.js", "range_download.js", "package.json", "package-lock.json",
)

def stage_runtime(destination):
    """An explicit allowlist keeps local config, credentials and tests out of builds."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    for name in RUNTIME_FILES:
        source = BASE / name
        if not source.is_file() or source.is_symlink():
            raise RuntimeError("Missing or unsafe runtime source: " + name)
        shutil.copy2(source, destination / name)
    if json.loads((destination / "package.json").read_text())["scripts"]["start"] != "node free_server.js":
        raise RuntimeError("Runtime start command does not match free_server.js")
    for source in (BASE / "mobile").rglob("*"):
        relative = source.relative_to(BASE / "mobile")
        if source.is_symlink() or any(part.startswith(".") for part in relative.parts):
            continue
        if source.is_file():
            target = destination / "mobile" / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    (destination / ".gcloudignore").write_text("node_modules/\n.git/\n*.log\n")
    return sum(1 for source in destination.rglob("*") if source.is_file())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=os.environ.get("STORAGE_PROJECT_ID", "gendragood-ssd"))
    parser.add_argument("--region", default=os.environ.get("GENDRAGOON_REGION", "us-central1"))
    parser.add_argument("--service", default=os.environ.get("GENDRAGOON_SERVICE", "gendragoon-free"))
    parser.add_argument("--service-account", default=os.environ.get("GENDRAGOON_RUNTIME_SERVICE_ACCOUNT"))
    parser.add_argument("--customer-bucket", default=os.environ.get("CUSTOMER_BUCKET"))
    parser.add_argument("--dry-run", action="store_true", help="Validate and stage exact sources without authenticating or deploying")
    options = parser.parse_args()
    for value in (options.project, options.region, options.service):
        if not re.fullmatch(r"[a-z][a-z0-9-]{2,62}", value):
            parser.error("Invalid project, region or service identifier")
    if options.customer_bucket and (options.customer_bucket == "gen-dragoon-ssd" or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", options.customer_bucket)):
        parser.error("Choose the separate private customer bucket; the personal bucket is not permitted")
    candidate = Path.home() / "Library/Application Support/GenDragoon Cloud SSD/Tools/google-cloud-sdk/bin/gcloud"
    gcloud = shutil.which("gcloud") or (str(candidate) if candidate.is_file() else None)
    with tempfile.TemporaryDirectory(prefix="gendragoon-runtime-") as temporary:
        stage = Path(temporary) / "source"
        count = stage_runtime(stage)
        print(f"Validated {count} runtime files from this checkout.", flush=True)
        if options.dry_run:
            print("Deployment was not started. Existing Cloud Run environment and secret references will be retained.")
            return
        if not gcloud:
            raise RuntimeError("Google Cloud CLI is not installed")
        auth = subprocess.run([gcloud, "auth", "application-default", "print-access-token"], capture_output=True, text=True, timeout=40)
        if auth.returncode or not auth.stdout.strip():
            raise RuntimeError("Google application-default credentials are unavailable")
        credential = Path(temporary) / "access-token"
        descriptor = os.open(credential, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            stream.write(auth.stdout.strip())
        command = [gcloud, "--access-token-file", str(credential), "run", "deploy", options.service,
                   "--project", options.project, "--region", options.region, "--source", str(stage), "--quiet"]
        # Update only explicitly supplied values; never clear vault configuration.
        if options.service_account:
            command.extend(["--service-account", options.service_account])
        if options.customer_bucket:
            command.extend(["--update-env-vars", "CUSTOMER_BUCKET=" + options.customer_bucket + ",STORAGE_PROJECT_ID=" + options.project])
        print(f"Deploying {options.service} in {options.project}/{options.region}; retaining existing service configuration.", flush=True)
        result = subprocess.run(command, capture_output=True, text=True, timeout=1800)
        # Provider response bodies can contain configuration; leave them in authenticated build logs.
        print("Deployment " + ("completed." if result.returncode == 0 else "failed; inspect the authenticated Cloud Run build logs."), flush=True)
        raise SystemExit(result.returncode)

if __name__ == "__main__":
    main()
