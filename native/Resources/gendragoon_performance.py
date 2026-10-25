#!/usr/bin/env python3
"""Bounded native tuning from a freshly authenticated workspace response.

Credentials enter through a private stdin pipe, are never persisted, and are
only sent to the HTTPS endpoint sealed into the application. A failed lookup
falls back to Basic. Local tuning never grants storage or billing access.
"""
import os
import sys
sys.dont_write_bytecode = True
os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
import json
from pathlib import Path
import re
import ssl
import urllib.error
import urllib.parse
import urllib.request

RESOURCE = Path(__file__).resolve().parent
INPUT_LIMIT = 32 * 1024
RESPONSE_LIMIT = 64 * 1024
WORKSPACE = re.compile(r"(?:free|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\Z")
REDX_WORKSPACE = re.compile(r"[a-f0-9]{32}\Z")
REDX_RECEIVER = re.compile(r"[a-f0-9]{64}\Z")
REDX_ACCESS = re.compile(r"rxca_[A-Za-z0-9_-]{43}\Z")
REDX_SECRET = re.compile(r"[A-Za-z0-9_-]{32,128}\Z")
_input = None
_active = None


def registry():
    path = RESOURCE / "gendragoon_performance_profiles.json"
    if not path.is_file() and RESOURCE.name == "Resources" and RESOURCE.parent.name == "native":
        path = RESOURCE.parent / "Backend/performance_profiles.json"
    value = json.loads(path.read_text())
    if value.get("version") != 1 or value.get("minimumFreeGiB") != 10:
        raise ValueError("Unsupported performance profile registry")
    return value


def for_workers(workers=1, constrained=False):
    if type(workers) is not int or not 1 <= workers <= 24:
        raise ValueError("Invalid verified worker allowance")
    selected = max((p for p in registry()["profiles"] if p["minimumWorkers"] <= workers),
                   key=lambda p: p["minimumWorkers"])
    profile = dict(selected, version=1, workers=workers, minimumFreeGiB=10,
                   constrained=bool(constrained), verified=False)
    if constrained:
        profile.update(workers=1, preloadMiB=0, preloadWorkers=1, streamReaders=1,
                       readChunkMiB=1, readAheadMiB=0)
    return profile


def current():
    return dict(_active) if _active is not None else for_workers()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        raise ValueError("Performance endpoint redirects are not permitted")


def tls_context():
    # Framework Python does not always discover macOS's root certificate file.
    # Use the OS trust bundle while retaining hostname and chain verification.
    system_roots = Path("/etc/ssl/cert.pem")
    return ssl.create_default_context(cafile=str(system_roots)) if system_roots.is_file() else ssl.create_default_context()


def endpoint():
    value = json.loads((RESOURCE / "gendragoon_free_api.json").read_text())["endpoint"]
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")
            or parsed.port not in (None, 443)):
        raise ValueError("Invalid sealed performance endpoint")
    return value.rstrip("/")


def configure_from_stdin(stream=None):
    global _active, _input
    _active, _input = for_workers(), None
    # The bounded read also rejects huge or newline-injected Authorization values.
    stream = stream or sys.stdin.buffer
    raw = stream.read(INPUT_LIMIT + 1)
    try:
        if len(raw) > INPUT_LIMIT:
            raise ValueError("Performance request too large")
        value = json.loads(raw)
        if value.get("provider") == "redxai":
            workspace=value.get("workspaceId");token=value.get("bearerToken")
            constrained=value.get("constrained",False);receiver=value.get("receiverId");workers=value.get("workers")
            secret=value.get("storageSecret");keymap=value.get("keymapPath");api=value.get("cloudApi")
            if (not isinstance(workspace,str) or not REDX_WORKSPACE.fullmatch(workspace)
                    or not isinstance(token,str) or not REDX_ACCESS.fullmatch(token)
                    or not isinstance(receiver,str) or not REDX_RECEIVER.fullmatch(receiver)
                    or not isinstance(secret,str) or not REDX_SECRET.fullmatch(secret)
                    or not isinstance(keymap,str) or not Path(keymap).is_absolute() or "\x00" in keymap
                    or api != "https://api.red-xai.com" or type(constrained) is not bool
                    or type(workers) is not int or not 1 <= workers <= 24):
                raise ValueError("Invalid Red-XAI private worker input")
            _input=json.dumps(value,separators=(",", ":")).encode()
            _active=for_workers(workers,constrained)
            _active.update(verified=True,workspaceId=workspace,source="redxai-receiver")
            return current()
        workspace = value.get("workspaceId")
        token = value.get("bearerToken")
        constrained = value.get("constrained", False)
        if (not isinstance(workspace, str) or not WORKSPACE.fullmatch(workspace)
                or not isinstance(token, str) or not 20 <= len(token) <= 16 * 1024
                or any(ord(c) < 33 or ord(c) > 126 for c in token)
                or type(constrained) is not bool):
            raise ValueError("Invalid performance authorization request")
        _active = for_workers(constrained=constrained)
        _input = json.dumps(value, separators=(",", ":")).encode()
        request = urllib.request.Request(endpoint() + "/v3/cloud/" + workspace + "/config",
            headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
        with urllib.request.build_opener(NoRedirect(), urllib.request.HTTPSHandler(context=tls_context())).open(request, timeout=8) as response:
            data = response.read(RESPONSE_LIMIT + 1)
            if response.status != 200 or len(data) > RESPONSE_LIMIT:
                raise ValueError("Invalid performance response")
        result = json.loads(data)
        if result.get("workspaceId") != workspace or result.get("protocol") != 3:
            raise ValueError("Performance response is for a different workspace")
        _active = for_workers(result["transfer"]["workers"], constrained)
        _active.update(verified=True, workspaceId=workspace, source="authenticated-workspace")
        # Forwarded only through stdin to a same-bundle upload child. No token in a receipt.
    except Exception:
        _active.update(verified=False, source="basic-fallback",
                       message="Basic performance is active; reconnect to verify the selected project's plan.")
    return current()


def forwarded_input():
    return _input


def private_payload():
    return json.loads(_input) if _input is not None else None


def rclone_arguments(profile=None):
    p = profile or current()
    workers = p["workers"]
    if type(workers) is not int or not 1 <= workers <= 24:
        raise ValueError("Invalid transfer allowance")
    return ["--transfers", str(workers), "--checkers", str(min(8, workers)),
            "--multi-thread-streams", str(min(8, workers)), "--multi-thread-cutoff", "16M"]


def stream_arguments(profile=None):
    p = profile or current()
    return ["--vfs-cache-max-size=" + str(p["cacheGiB"]) + "G",
            "--vfs-cache-min-free-space=10G", "--vfs-cache-max-age=1h",
            "--buffer-size=1M", "--vfs-read-ahead=" + str(p["readAheadMiB"]) + "M",
            "--vfs-read-chunk-size=" + str(p["readChunkMiB"]) + "M",
            "--vfs-read-chunk-size-limit=" + str(p["readChunkMiB"]) + "M",
            "--vfs-read-chunk-streams=" + str(p["streamReaders"])]


def preload_arguments(profile=None):
    p = profile or current()
    args = ["--budget-mb", str(max(1, p["preloadMiB"])),
            "--seconds", str(p["preloadSeconds"]), "--workers", str(p["preloadWorkers"])]
    if p["constrained"]:
        args.append("--constrained")
    return args


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="GenDragoon verified performance policy, imported by native helpers.")
    parser.parse_args()
    parser.print_help()
