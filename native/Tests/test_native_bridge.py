import io
import json
import os
import socket
import struct
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

RESOURCES = Path(__file__).resolve().parents[1] / "Resources"
sys.path.insert(0, str(RESOURCES))
import gendragoon_native_bridge as bridge

import importlib.util
spec = importlib.util.spec_from_file_location("install_native_host", Path(__file__).resolve().parents[1] / "Extensions/install_native_host.py")
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)


class NativeBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="gd-native-bridge-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.root.chmod(0o700)
        self.client = {"kind": "browser", "id": "chrome-extension://" + "a" * 32 + "/"}
        self.request = {"id": "1" * 32, "method": "status", "params": {}}

    def test_explicit_caller_allowlist_uses_launch_arguments_and_fixed_editor_id(self):
        config = {"schema": 1, "allowedOrigins": [self.client["id"], bridge.FIREFOX_ID], "vscodeExtensionId": bridge.VSCODE_ID}
        self.assertEqual(bridge.caller([self.client["id"].rstrip("/")], config), self.client)
        self.assertEqual(bridge.caller(["/installed/manifest.json", bridge.FIREFOX_ID], config)["id"], bridge.FIREFOX_ID)
        self.assertEqual(bridge.caller([], config, vscode=True), {"kind": "vscode", "id": bridge.VSCODE_ID})
        for args in [[], ["chrome-extension://" + "b" * 32 + "/"], ["*"], [self.client["id"], "--client=vscode"]]:
            with self.subTest(args=args), self.assertRaises(bridge.BridgeError):
                bridge.caller(args, config)
        with self.assertRaises(bridge.BridgeError):
            bridge.caller([], {"schema": 1, "vscodeExtensionId": "arbitrary.editor"}, vscode=True)

    def test_routes_are_metadata_and_teams_only_and_browser_cannot_supply_paths(self):
        def request(route, verb="GET", body=None):
            return {"id": "2" * 32, "method": "request", "params": {"path": route, "method": verb, **({"body": body} if body is not None else {})}}
        allowed = [request("/v1/receivers/me"), request("/v1/receivers/me/workspaces/" + "a" * 32 + "/library"), request("/v1/receivers/teams/" + "a" * 32 + "/messages?limit=50&cursor=abc"), request("/v1/receivers/teams/join", "POST", {"token": "test-one-time-token"})]
        for value in allowed:
            self.assertEqual(bridge.validate_request(value, self.client), value)
        forbidden = [request("/v1/receivers/admin/machinenotes"), request("/v1/receivers/me/workspaces/" + "a" * 32, "DELETE"), request("/v1/receivers/me/workspaces/" + "a" * 32 + "/blobs/" + "b" * 32), request("/v1/receivers/me/library", "PUT", {}), request("/v1/integrations/keys"), request("https://red-xai.com/v1/receivers/me"), request("/v1/receivers/%6de"), request("/v1/receivers/teams/" + "a" * 32 + "/messages?token=secret"), request("/v1/receivers/teams/" + "a" * 32 + "/messages?limit=1&limit=2")]
        for value in forbidden:
            with self.subTest(value=value), self.assertRaises(bridge.BridgeError):
                bridge.validate_request(value, self.client)
        value = {**self.request, "client": {"kind": "vscode", "id": bridge.VSCODE_ID}}
        self.assertNotIn("client", bridge.validate_request(value, self.client))
        value = {"id": "3" * 32, "method": "uploadSelection", "params": {"workspaceId": "a" * 32, "selectedPaths": [str(self.root / "owned.txt")]}}
        with self.assertRaises(bridge.BridgeError):
            bridge.validate_request(value, self.client)
        self.assertEqual(bridge.validate_request(value, {"kind": "vscode"}), value)

    def test_app_controls_accept_only_catalog_ids_never_paths_pids_commands_or_force(self):
        for method in ("appSessions","playApp","stopApp"):
            fields={"workspaceId":"a"*32}
            if method!="appSessions":fields["key"]="b"*18
            request={"id":"c"*32,"method":method,"params":fields}
            self.assertEqual(bridge.validate_request(request,self.client),request)
            for extra,value in (("path","/Applications/Other.app"),("pid",123),("command","example"),("force",True)):
                with self.subTest(method=method,extra=extra),self.assertRaises(bridge.BridgeError):
                    bridge.validate_request({**request,"params":{**fields,extra:value}},self.client)
            with self.assertRaises(bridge.BridgeError):
                bridge.validate_request({**request,"params":{**fields,"workspaceId":"foreign"}},self.client)

    def test_native_framing_handles_fragmentation_and_rejects_unbounded_or_truncated_data(self):
        class Fragmented(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(2, size))
            def write(self, data):
                return super().write(data[:2])
        stream = Fragmented()
        bridge.write_frame(stream, self.request)
        stream.seek(0)
        self.assertEqual(bridge.read_frame(stream), self.request)
        self.assertIsNone(bridge.read_frame(stream))
        for data in [b"\x01", struct.pack("<I", bridge.MAX_FRAME + 1), struct.pack("<I", 2) + b"{", struct.pack("<I", 1) + b"\xff"]:
            with self.subTest(data=data[:4]), self.assertRaises(bridge.BridgeError):
                bridge.read_frame(io.BytesIO(data))

    def test_community_moderation_transport_does_not_expand_storage_or_admin_routes(self):
        team, peer = "a" * 32, "b" * 32
        for verb, path in [("GET", "/v1/receivers/me/dev-community"),
                           ("PUT", "/v1/receivers/me/dev-community"),
                           ("GET", "/v1/receivers/me/dev-reports?limit=20"),
                           ("PATCH", "/v1/receivers/me/dev-reports/" + peer),
                           ("PUT", f"/v1/receivers/teams/{team}/blocks/{peer}"),
                           ("DELETE", f"/v1/receivers/teams/{team}/blocks/{peer}"),
                           ("POST", f"/v1/receivers/teams/{team}/reports"),
                           ("GET", f"/v1/receivers/teams/{team}/reports/{peer}")]:
            value = {"id": "c" * 32, "method": "request", "params": {"method": verb, "path": path}}
            self.assertEqual(bridge.validate_request(value, self.client), value)
        for path in ["/v1/receivers/admin/dev-reports", "/v1/receivers/me/dev-community/keys",
                     f"/v1/receivers/teams/{team}/reports/{peer}/files",
                     "/v1/receivers/me/dev-reports?token=secret", "/v1/receivers/me/dev-reports/../library",
                     "/v1/receivers/me/dev-reports/%61", "/v2/account/deletion"]:
            with self.subTest(path=path), self.assertRaises(bridge.BridgeError):
                bridge.validate_request({"id": "d" * 32, "method": "request", "params": {"method": "GET", "path": path}}, self.client)

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "Unix transport")
    def test_actual_unix_socket_injects_launch_identity_and_returns_verified_response(self):
        endpoint = self.root / "rpc.sock"
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.addCleanup(listener.close)
        listener.bind(str(endpoint))
        endpoint.chmod(0o600)
        listener.listen(1)
        locator = self.root / "endpoint.json"
        locator.write_text(json.dumps({"schema": 1, "protocol": bridge.PROTOCOL, "socketPath": str(endpoint)}))
        locator.chmod(0o600)
        observed = []
        def companion():
            connection, _ = listener.accept()
            with connection, connection.makefile("rwb", buffering=0) as stream:
                observed.append(bridge.read_frame(stream))
                bridge.write_frame(stream, {"id": self.request["id"], "ok": True, "result": {"connected": True}})
        worker = threading.Thread(target=companion)
        worker.start()
        self.assertEqual(bridge.socket_request(self.request, self.client, locator)["result"], {"connected": True})
        worker.join(3)
        self.assertFalse(worker.is_alive())
        self.assertEqual(observed, [{"schema": 1, "client": self.client, "request": self.request}])

    def test_unavailable_companion_returns_structured_failure_without_success(self):
        incoming, outgoing = io.BytesIO(), io.BytesIO()
        bridge.write_frame(incoming, self.request)
        incoming.seek(0)
        bridge.serve(incoming, outgoing, self.client, self.root / "missing.json")
        outgoing.seek(0)
        result = bridge.read_frame(outgoing)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], "companion_unavailable")
        self.assertEqual(result["id"], self.request["id"])

    def test_locator_permissions_and_symlinks_fail_closed(self):
        locator = self.root / "endpoint.json"
        locator.write_text("{}")
        locator.chmod(0o644)
        with self.assertRaises(bridge.BridgeError):
            bridge.private_json(locator)
        locator.chmod(0o600)
        link = self.root / "link.json"
        link.symlink_to(locator)
        with self.assertRaises(bridge.BridgeError):
            bridge.private_json(link)
        self.root.chmod(0o755)
        with self.assertRaises(bridge.BridgeError):
            bridge.private_json(locator)

    def test_installer_writes_exact_origins_distinct_firefox_id_and_private_wrapper(self):
        result = installer.install(platform="darwin", home=self.root, helper=RESOURCES / "gendragoon_native_bridge.py", python=Path(sys.executable).resolve(), browser_ids={"chrome": "a" * 32, "edge": "b" * 32, "opera": "c" * 32}, firefox=True, vscode=True)
        self.assertEqual(len(result["manifests"]), 3, "Opera and Chrome share the documented macOS host path")
        for filename in result["manifests"]:
            value = json.loads(Path(filename).read_text())
            self.assertEqual(value["path"], result["host"])
            self.assertNotIn("*", json.dumps(value))
            if "Mozilla" in filename:
                self.assertEqual(value["allowed_extensions"], [bridge.FIREFOX_ID])
            else:
                self.assertEqual(len(value["allowed_origins"]), 2 if "Google/Chrome" in filename else 1)
        host = Path(result["host"])
        self.assertEqual(host.stat().st_mode & 0o777, 0o700)
        self.assertIn("--vscode-bridge", host.read_text())
        config = json.loads((host.parent / "config.json").read_text())
        self.assertEqual(config["vscodeExtensionId"], bridge.VSCODE_ID)
        with self.assertRaises(ValueError):
            installer.install(platform="linux", home=self.root, helper=RESOURCES / "gendragoon_native_bridge.py", python=Path(sys.executable), browser_ids={"chrome": "*"})
        self.assertTrue(str(installer.base_directory("win32", self.root)).endswith("GenDragoon"))


if __name__ == "__main__":
    unittest.main()
