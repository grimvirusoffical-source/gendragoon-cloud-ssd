"""Exercise the actual Swift listener with disposable paths and no account/UI."""
import json
import os
from pathlib import Path
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
STUBS = r'''
import AppKit
import Foundation
import SwiftUI
struct GDNativeFailure: LocalizedError { let message:String; var errorDescription:String? {message} }
enum GDNativeMessage { static func safe(_ value:String)->String {value} }
struct UploadDestination {let project:String;let bucket:String;let remote:String;let prefix:String}
struct Note {let id:String;let displayName:String;let remote:String;let prefix:String}
struct Project {let buckets:[Note]}
@MainActor final class GDRedXAIAuthSession {
 static let shared=GDRedXAIAuthSession(); let linked=false; let receiverID=String(repeating:"a",count:64)
 let uploadProjects:[Project]=[]
 func serviceRequest(path:String,method:String,json:[String:Any]?) async throws->[String:Any] {throw GDNativeFailure(message:"No network calls are permitted in this fixture.")}
}
@MainActor final class Upload {
 func enqueueCompanion(_ urls:[URL],destination:UploadDestination) async throws->String {throw GDNativeFailure(message:"No uploads are permitted in this fixture.")}
}
@MainActor final class GDNativeWorkspace {
 static let shared=GDNativeWorkspace();let upload=Upload()
 func start() async{};func refreshCloudChoices() async{}
}
final class GDUpdateActivity {static let shared=GDUpdateActivity();func canStart()->Bool{true}}
@main struct Probe {
 @MainActor static func main() async throws {
  if CommandLine.arguments.count == 4 && CommandLine.arguments[1] == "check-route" {
   print(GDCompanion.allowedRoute(CommandLine.arguments[2],method:CommandLine.arguments[3]) ? "allowed" : "denied")
   return
  }
  let model=GDCompanion(baseURL:URL(fileURLWithPath:CommandLine.arguments[1]),socketDirectoryURL:URL(fileURLWithPath:CommandLine.arguments[2]))
  model.start()
  FileHandle.standardOutput.write(Data((model.status+"\n").utf8))
  while true {try await Task.sleep(nanoseconds:100_000_000)}
 }
}
'''


@unittest.skipUnless(sys.platform == "darwin" and shutil.which("xcrun"), "actual Swift macOS IPC")
class CompanionIPC(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="gd-companion-test-", dir="/private/tmp")
        cls.root = Path(cls.temp.name).resolve()
        stub = cls.root / "Probe.swift"
        stub.write_text(STUBS)
        cls.binary = cls.root / "Probe"
        sdk = Path("/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk")
        args = ["xcrun", "swiftc", "-parse-as-library", "-framework", "SwiftUI", "-framework", "AppKit"]
        if sdk.exists():
            args += ["-sdk", str(sdk)]
        built = subprocess.run(args + [str(ROOT / "Sources/GDCompanion.swift"), str(stub), "-o", str(cls.binary)], capture_output=True, text=True, timeout=120)
        if built.returncode:
            raise AssertionError(built.stderr)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.directory = self.root / os.urandom(4).hex()
        self.directory.mkdir(mode=0o700)
        self.base = self.directory / "base"
        config = self.base / "NativeMessaging"
        config.mkdir(mode=0o700, parents=True)
        self.base.chmod(0o700)
        p = config / "config.json"
        p.write_text(json.dumps({"schema": 1, "allowedOrigins": ["gendragoon@redxai.local"], "vscodeExtensionId": "redxai.gendragoon"}))
        p.chmod(0o600)
        self.process = subprocess.Popen([str(self.binary), str(self.base), str(self.directory / "socket")], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop)
        locator = self.base / "Companion/endpoint.json"
        deadline = time.monotonic() + 8
        while not locator.exists() and time.monotonic() < deadline and self.process.poll() is None:
            time.sleep(0.02)
        if not locator.exists():
            self.process.terminate()
            out, err = self.process.communicate(timeout=5)
            self.fail((out + err).decode())
        self.socket = json.loads(locator.read_text())["socketPath"]
        self.assertEqual(locator.stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(self.socket).stat().st_mode & 0o777, 0o600)

    def stop(self):
        if self.process.poll() is None:
            self.process.terminate()
        self.process.communicate(timeout=5)

    def request(self, method="status", params=None, client=None):
        value = {"schema": 1, "client": client or {"kind": "browser", "id": "gendragoon@redxai.local"}, "request": {"id": "a" * 32, "method": method, "params": params or {}}}
        payload = json.dumps(value).encode()
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(5)
            conn.connect(self.socket)
            # Deliberately split header/payload to exercise exact frame reads.
            frame = struct.pack("<I", len(payload)) + payload
            conn.sendall(frame[:2]); conn.sendall(frame[2:9]); conn.sendall(frame[9:])
            stream = conn.makefile("rb")
            length = struct.unpack("<I", stream.read(4))[0]
            self.assertLessEqual(length, 256 * 1024)
            return json.loads(stream.read(length))

    def test_actual_listener_status_and_unconnected_fail_closed(self):
        response = self.request()
        self.assertTrue(response["ok"])
        self.assertFalse(response["result"]["connected"])
        denied = self.request("request", {"path": "/v1/receivers/me", "method": "GET"})
        self.assertEqual(denied["error"]["code"], "approval_required")

    def test_exact_installed_caller_and_frame_boundaries(self):
        response = self.request(client={"kind": "browser", "id": "chrome-extension://" + "b" * 32 + "/"})
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "request_denied")
        with socket.socket(socket.AF_UNIX) as conn:
            conn.settimeout(3); conn.connect(self.socket)
            conn.sendall(struct.pack("<I", 256 * 1024 + 1))
            self.assertEqual(conn.recv(1), b"")
        self.assertTrue(self.request()["ok"])

    def test_concurrent_status_requests_remain_bounded_and_valid(self):
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(lambda _: self.request(), range(48)))
        self.assertTrue(all(r["ok"] for r in results))

    def test_actual_swift_moderation_route_policy_remains_scoped(self):
        team, peer = "a" * 32, "b" * 32
        allowed = [("GET", "/v1/receivers/me/dev-community"), ("PUT", "/v1/receivers/me/dev-community"),
                   ("GET", "/v1/receivers/me/dev-reports?limit=20"),
                   ("PATCH", "/v1/receivers/me/dev-reports/" + peer),
                   ("PUT", f"/v1/receivers/teams/{team}/blocks/{peer}"),
                   ("POST", f"/v1/receivers/teams/{team}/reports")]
        denied = [("GET", "/v1/receivers/admin/dev-reports"), ("GET", "/v1/integrations/keys"),
                  ("DELETE", "/v2/account/deletion"), ("GET", "/v1/receivers/me/dev-reports?token=secret"),
                  ("GET", "/v1/receivers/me/dev-reports/../library"),
                  ("GET", f"/v1/receivers/teams/{team}/reports/{peer}/files"),
                  ("GET", "/v1/receivers/me/dev-reports/%61")]
        for expected, cases in (("allowed", allowed), ("denied", denied)):
            for method, path in cases:
                with self.subTest(method=method, path=path):
                    result = subprocess.run([str(self.binary), "check-route", path, method],
                                            capture_output=True, text=True, timeout=10, check=True)
                    self.assertEqual(result.stdout.strip(), expected)


if __name__ == "__main__":
    unittest.main()
