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
    "billing_gateway.js", "billing_v2.js", "projects.js", "workspace_policy.js", "locked_write.js", "catalog.js", "performance.js", "performance_profiles.json",
    "gpu_catalog.js", "owner_benefits.js", "api_keys.js", "paid_storage.js",
    "transfer_v3.js", "range_download.js", "account_delete.js", "key_envelope.js", "storage_urls.js", "package.json", "package-lock.json",
    # Loaded by free_server.js / billing_v2.js / transfer_v3.js / account_delete.js at start or during deletion jobs.
    # provider_v1.js is shipped because account deletion calls it; its routes stay off unless PROVIDER_V1_ENABLED=true.
    "login_gate.js", "redx_app_auth.js", "v2_errors.js", "teams.js", "teams_account.js", "team_storage.js", "provider_v1.js", "provider_blobstore.js",
    "support_email.js",
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
    # Account sign-up modules and the Terms of Service text (accounts/, legal/). Tests stay out.
    for folder in ("accounts", "legal"):
        for source in (BASE / folder).rglob("*"):
            relative = source.relative_to(BASE)
            if source.is_symlink() or not source.is_file() or source.name.endswith(".test.js") or any(part.startswith(".") for part in relative.parts):
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    (destination / ".gcloudignore").write_text("node_modules/\n.git/\n*.log\n")
    return sum(1 for source in destination.rglob("*") if source.is_file())

def parse_options(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", default=os.environ.get("STORAGE_PROJECT_ID", "gendragood-ssd"))
    parser.add_argument("--region", default=os.environ.get("GENDRAGOON_REGION", "us-central1"))
    parser.add_argument("--service", default=os.environ.get("GENDRAGOON_SERVICE", "gendragoon-free"))
    parser.add_argument("--service-account", default=os.environ.get("GENDRAGOON_RUNTIME_SERVICE_ACCOUNT"))
    parser.add_argument("--customer-bucket", default=os.environ.get("CUSTOMER_BUCKET"))
    parser.add_argument("--no-traffic", action="store_true", help="Create a candidate revision without sending production traffic to it")
    parser.add_argument("--tag", help="Candidate URL tag; requires --no-traffic and must be a new, unique tag")
    parser.add_argument("--dry-run", action="store_true", help="Validate and stage exact sources without authenticating or deploying")
    options = parser.parse_args(arguments)
    for value in (options.project, options.region, options.service):
        if not re.fullmatch(r"[a-z][a-z0-9-]{2,62}", value):
            parser.error("Invalid project, region or service identifier")
    if options.customer_bucket and (options.customer_bucket == "gen-dragoon-ssd" or not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]", options.customer_bucket)):
        parser.error("Choose the separate private customer bucket; the personal bucket is not permitted")
    if options.tag:
        if not re.fullmatch(r"[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?", options.tag):
            parser.error("Candidate tag must be 1–63 lowercase letters, digits or hyphens, start with a letter, and end with a letter or digit")
        if not options.no_traffic:
            parser.error("--tag requires --no-traffic; review a candidate before promoting its revision")
    return options


def deployment_command(gcloud, credential, stage, options):
    command = [gcloud, "--access-token-file", str(credential), "run", "deploy", options.service,
               "--project", options.project, "--region", options.region, "--source", str(stage), "--quiet"]
    if options.no_traffic:
        command.append("--no-traffic")
    if options.tag:
        command.extend(["--tag", options.tag])
    # Update only explicitly supplied values; never clear vault configuration.
    if options.service_account:
        command.extend(["--service-account", options.service_account])
    # Cloud Run sets K_SERVICE and does not set NODE_ENV. The support gate is
    # always on when K_SERVICE is set. NODE_ENV=production covers every other host.
    env_vars = ["NODE_ENV=production"]
    if options.customer_bucket:
        env_vars.append("CUSTOMER_BUCKET=" + options.customer_bucket)
        env_vars.append("STORAGE_PROJECT_ID=" + options.project)
    command.extend(["--update-env-vars", ",".join(env_vars)])
    return command


def ensure_new_tag(gcloud, credential, options):
    """Refuse to repoint an existing tag URL while creating a candidate."""
    if not options.tag:
        return
    command = [gcloud, "--access-token-file", str(credential), "run", "services", "describe", options.service,
               "--project", options.project, "--region", options.region, "--format=json(status.traffic)"]
    result = subprocess.run(command, capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise RuntimeError("Cannot verify candidate tag uniqueness on the existing Cloud Run service; deployment was not started")
    try:
        traffic = json.loads(result.stdout).get("status", {}).get("traffic", [])
        if not isinstance(traffic, list):
            raise ValueError("Unexpected traffic response")
    except (ValueError, AttributeError):
        raise RuntimeError("Invalid Cloud Run traffic response; deployment was not started") from None
    if any(target.get("tag") == options.tag for target in traffic):
        raise RuntimeError("Candidate tag already exists; choose a new tag so the existing URL remains unchanged")


def main(arguments=None):
    options = parse_options(arguments)
    candidate = Path.home() / "Library/Application Support/GenDragoon Cloud SSD/Tools/google-cloud-sdk/bin/gcloud"
    gcloud = shutil.which("gcloud") or (str(candidate) if candidate.is_file() else None)
    with tempfile.TemporaryDirectory(prefix="gendragoon-runtime-") as temporary:
        stage = Path(temporary) / "source"
        count = stage_runtime(stage)
        print(f"Validated {count} runtime files from this checkout.", flush=True)
        if options.no_traffic:
            print("Candidate mode: 0% production traffic" + ("; tag " + options.tag if options.tag else "") + ".", flush=True)
            print("The candidate retains access to the existing runtime data and secrets; no-traffic is not data isolation.", flush=True)
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
        ensure_new_tag(gcloud, credential, options)
        command = deployment_command(gcloud, credential, stage, options)
        print(f"Deploying {options.service} in {options.project}/{options.region}; retaining existing service configuration.", flush=True)
        result = subprocess.run(command, capture_output=True, text=True, timeout=1800)
        # Provider response bodies can contain configuration; leave them in authenticated build logs.
        print("Deployment " + ("completed." if result.returncode == 0 else "failed; inspect the authenticated Cloud Run build logs."), flush=True)
        raise SystemExit(result.returncode)

if __name__ == "__main__":
    main()
