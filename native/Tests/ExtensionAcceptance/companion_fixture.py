#!/usr/bin/env python3
"""Production private IPC server with explicitly synthetic, account-free dispatch.

This is not the desktop GUI or a Receiver HTTP replacement. It never accepts
account credentials, uploads a file, or contacts a cloud endpoint.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import sys
import threading

sys.dont_write_bytecode = True
NATIVE = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(NATIVE / "Desktop"), str(NATIVE / "Resources")]
from companion_server import CompanionServer
import gendragoon_native_bridge as bridge

WRITABLE, READONLY = "a" * 32, "b" * 32
FILE_LABEL = '<img src=x onerror=alert(1)> café 😀.txt'


def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf8") as output:
        json.dump(value, output, ensure_ascii=False)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--host", type=Path, required=True)
    parser.add_argument("--origin", required=True)
    options = parser.parse_args()
    if not sys.platform.startswith("linux") or os.environ.get("GITHUB_ACTIONS") != "true" or os.environ.get("GD_EXTENSION_ACCEPTANCE_CI") != "1":
        parser.error("Run this fixture only in the dedicated Linux CI workflow")
    root = options.root.absolute()
    runner = Path(os.environ["RUNNER_TEMP"]).resolve()
    if not root.is_relative_to(runner) or root == runner or len(str(root / "socket/rpc.sock")) > 100:
        parser.error("Use a new short private directory beneath RUNNER_TEMP")
    bridge.private_path(root, directory=True)
    if not bridge.CHROME_ORIGIN.fullmatch(options.origin) and options.origin != bridge.FIREFOX_ID:
        parser.error("An exact disposable Chromium origin or the fixed Firefox identity is required")
    if options.host.read_bytes()[:4] != b"\x7fELF":
        parser.error("The fixture requires the actual packaged ELF native host")
    base = root / "state/gendragoon"
    host_dir = base / "NativeMessaging"
    host_dir.mkdir(parents=True, mode=0o700)
    base.chmod(0o700)
    (root / "state").chmod(0o700)
    config = {"schema": 1, "allowedOrigins": [options.origin, bridge.FIREFOX_ID], "vscodeExtensionId": bridge.VSCODE_ID}
    private_json(host_dir / "config.json", config)
    executable = host_dir / "gendragoon-native-host"
    shutil.copyfile(options.host, executable)
    executable.chmod(0o700)
    control = root / "consent.json"
    private_json(control, {"approved": False})
    events = root / "events.jsonl"
    private_json(events, {})
    events.write_text("")
    lock = threading.Lock()
    count = 0

    def dispatch(request, done):
        nonlocal count
        with lock:
            count += 1
            if count > 1000:
                done({"ok": False, "error": {"code": "fixture_limit", "message": "Fixture request limit"}})
                return
            event = {"method": request["method"], "clientKind": request["_clientKind"], "clientId": request["_clientId"]}
            if request["method"] == "request":
                event["path"] = request["params"]["path"]
            with events.open("a", encoding="utf8") as output:
                output.write(json.dumps(event) + "\n")
        if bridge.private_json(control).get("approved") is not True:
            done({"ok": False, "error": {"code": "approval_required", "message": "Approve this disposable CI fixture client first."}})
            return
        method, params = request["method"], request["params"]
        if method == "status":
            value = {"connected": True, "accountLabel": "Disposable CI fixture"}
        elif method == "selectUpload":
            value = {"cancelled": True}  # No native picker or upload is performed.
        elif method == "request" and params.get("method", "GET") == "GET":
            path = params["path"]
            if path == "/v1/receivers/me":
                value = {"workspaces": [{"id": WRITABLE, "name": "Fixture writable note", "active": True, "readOnly": False}, {"id": READONLY, "name": "Fixture read only note", "active": False, "readOnly": True}]}
            elif path in [f"/v1/receivers/me/workspaces/{key}/library" for key in [WRITABLE, READONLY]]:
                value = {"items": [{"name": FILE_LABEL, "archiveBytes": 17}]}
            elif path == "/v1/receivers/me/dev-profile":
                value = {"profile": {"username": "FixtureUser"}}
            elif path == "/v1/receivers/me/dev-community":
                value = {"policy": {"version": "fixture-v1", "title": "Disposable fixture rules",
                    "rules": ["Synthetic account-free acceptance fixture."],
                    "notice": "No real account or community acceptance is performed."},
                    "accepted": False, "serviceOwner": False}
            elif path.startswith("/v1/receivers/me/dev-teams?"):
                value = {"teams": [], "nextCursor": None}
            else:
                done({"ok": False, "error": {"code": "fixture_scope", "message": "Outside disposable metadata fixture"}})
                return
        else:
            done({"ok": False, "error": {"code": "fixture_scope", "message": "This fixture performs no file or team mutations"}})
            return
        done({"ok": True, "result": value})

    stop = threading.Event()
    for kind in [signal.SIGINT, signal.SIGTERM]:
        signal.signal(kind, lambda *_: stop.set())
    server = CompanionServer(dispatch, base=base, socket_directory=root / "socket", timeout=5)
    server.start()
    try:
        print(json.dumps({"ready": True, "syntheticDispatch": True}), flush=True)
        stop.wait()
    finally:
        server.close()


if __name__ == "__main__":
    main()
