"""Run real child processes through the production Swift helper on macOS.

Only the surrounding app UI is omitted. Runtime lookup, detached-task process
completion, private file capture, stdin, deadlines and result validation are
compiled directly from GDNativeWorkspace.swift into a disposable app bundle.
"""
from pathlib import Path
import plistlib
import subprocess
import sys
import tempfile
import unittest

NATIVE = Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform == "darwin", "Actual Foundation process runner requires macOS")
class NativeHelperTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="gendragoon-native-helper-")
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name).resolve()
        contents = cls.root / "HelperRegression.app/Contents"
        resources = contents / "Resources"
        resources.mkdir(parents=True)
        (contents / "MacOS").mkdir()
        cls.binary = contents / "MacOS/HelperRegression"
        (contents / "Info.plist").write_bytes(plistlib.dumps({
            "CFBundleIdentifier": "app.gendragoon.native-helper-regression",
            "CFBundleExecutable": cls.binary.name, "CFBundlePackageType": "APPL",
        }))
        (resources / "gendragoon_python").symlink_to(Path(sys.executable).resolve())
        (resources / "fixture_helper.py").write_text(HELPER)
        (resources / "gendragoon_byo_vault.py").write_text(HELPER)
        production = (NATIVE / "Sources/GDNativeWorkspace.swift").read_text()
        # Extract unchanged production declarations; no Process or runtime facade.
        production = production[production.index("enum GDRuntime {"):
                                production.index("@MainActor private final class GDNativeUploadSignal:")]
        source = cls.root / "HelperRegression.swift"
        source.write_text("import Foundation\nimport Darwin\n" + production + AUTH_FACADE + HARNESS)
        compiled = subprocess.run(["/usr/bin/xcrun", "swiftc", "-parse-as-library", str(source), str(NATIVE / "Sources/GDWorkerAuthChannel.swift"),
                                   "-o", str(cls.binary)], capture_output=True, text=True, timeout=60)
        if compiled.returncode:
            raise AssertionError("Actual Swift helper fixture did not compile:\n" + compiled.stderr[-8000:])

    def run_case(self, name):
        evidence = self.root / name
        evidence.mkdir()
        result = subprocess.run([str(self.binary), name, str(evidence)], capture_output=True,
                                text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout.strip(), name + " passed")
        self.assertFalse(list((self.binary.parent.parent / "Resources").rglob("*.pyc")))

    def test_parallel_quick_helpers_complete_with_private_stdin_and_separate_stderr(self):
        self.run_case("completion")

    def test_nonzero_exit_and_false_ok_cannot_report_success(self):
        self.run_case("failure")

    def test_timeout_returns_and_normally_terminates_owned_helper(self):
        self.run_case("timeout")

    def test_caller_cancellation_does_not_abandon_helper_or_clear_busy_early(self):
        self.run_case("cancellation")

    def test_durable_byo_keymap_import_outlives_a_read_deadline_without_a_signal(self):
        self.run_case("durable-byo-import")


AUTH_FACADE = r'''
@MainActor final class GDRedXAIAuthSession {
    static let shared = GDRedXAIAuthSession()
    func workerRenewalAuthorization(_ value:[String:Any]) throws -> (receiver:String,workspace:String,renew:@Sendable (Bool) async throws -> String) {
        fatalError("No production account is used by the helper lifecycle fixture")
    }
}
'''

HELPER = r'''
import json
import os
from pathlib import Path
import signal
import sys
import time

mode = sys.argv[1]
data = sys.stdin.buffer.read()
if mode in ("timeout", "delayed", "install-keymap"):
    root = Path(sys.argv[2])
    def terminated(signum, frame):
        # Publish a complete receipt: existence must not race write_text's
        # create-then-write window on a fast observer such as the CI runner.
        marker = root / "terminated.tmp"
        marker.write_text("SIGTERM")
        marker.replace(root / "terminated")
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, terminated)
    (root / "started").write_text(str(os.getpid()))
    if mode == "timeout":
        time.sleep(10)
    else:
        deadline = time.monotonic() + 8
        while not (root / "release").exists():
            if time.monotonic() >= deadline:
                raise SystemExit(9)
            time.sleep(0.01)
    (root / "completed").write_text("finished")
print('{"ok": false, "error": "stderr must stay separate"}', file=sys.stderr)
print(json.dumps({"ok": mode != "rejected", "inputBytes": len(data), "message": "fixture rejected"}))
sys.exit(7 if mode == "nonzero" else 0)
'''


HARNESS = r'''
@MainActor final class HelperBusyProbe {
    private(set) var busy=false
    func run(_ arguments:[String], timeout:TimeInterval=4, input:Data?=nil) async throws -> [String:Any] {
        precondition(!busy)
        busy=true
        defer {busy=false}
        return try await GDNativeHelper.invoke("fixture_helper",arguments:arguments,timeout:timeout,standardInput:input)
    }
}
func awaitFile(_ path:URL) async throws {
    let deadline=Date().addingTimeInterval(4)
    while !FileManager.default.fileExists(atPath:path.path) {
        precondition(Date()<deadline,"Fixture process did not reach its expected state")
        try await Task.sleep(nanoseconds:10_000_000)
    }
}
@main struct HelperRegression {
    @MainActor static func main() async throws {
        let name=CommandLine.arguments[1],root=URL(fileURLWithPath:CommandLine.arguments[2])
        switch name {
        case "completion":
            try await withThrowingTaskGroup(of:Void.self) {group in
                for _ in 0..<8 {
                    group.addTask {
                        let probe=await HelperBusyProbe()
                        let result=try await probe.run(["success"],input:Data(repeating:65,count:8192))
                        precondition(result["inputBytes"] as? Int == 8192)
                        let busy=await probe.busy;precondition(!busy)
                    }
                }
                try await group.waitForAll()
            }
        case "failure":
            let probe=HelperBusyProbe()
            for mode in ["nonzero","rejected"] {
                do {_ = try await probe.run([mode]);fatalError("Invalid helper result succeeded")}
                catch is GDNativeFailure {}
                precondition(!probe.busy)
            }
        case "timeout":
            let probe=HelperBusyProbe(),began=Date()
            do {_ = try await probe.run(["timeout",root.path],timeout:0.8);fatalError("Helper exceeded its deadline")}
            catch let error as GDNativeFailure {precondition(error.message.contains("timed out"))}
            precondition(!probe.busy && Date().timeIntervalSince(began)<4)
            try await awaitFile(root.appendingPathComponent("terminated"))
            let observedSignal=try String(contentsOf:root.appendingPathComponent("terminated"))
            precondition(observedSignal == "SIGTERM")
            let pid=Int32(try String(contentsOf:root.appendingPathComponent("started")))!
            let deadline=Date().addingTimeInterval(4)
            while kill(pid,0)==0 {
                precondition(Date()<deadline,"Timed-out helper did not exit")
                try await Task.sleep(nanoseconds:10_000_000)
            }
            precondition(errno==ESRCH)
            precondition(!FileManager.default.fileExists(atPath:root.appendingPathComponent("completed").path))
        case "cancellation":
            // Cancelling a caller must not advertise idle while its detached
            // helper is still working. The existing operation completes safely.
            let probe=HelperBusyProbe()
            let caller=Task {try await probe.run(["delayed",root.path])}
            try await awaitFile(root.appendingPathComponent("started"))
            caller.cancel()
            precondition(probe.busy)
            try Data().write(to:root.appendingPathComponent("release"))
            _ = try await caller.value
            precondition(!probe.busy)
            precondition(FileManager.default.fileExists(atPath:root.appendingPathComponent("completed").path))
        case "durable-byo-import":
            let writer=Task { try await GDNativeHelper.invoke("gendragoon_byo_vault",
                arguments:["install-keymap",root.path],timeout:0.1) }
            try await awaitFile(root.appendingPathComponent("started"))
            try await Task.sleep(nanoseconds:300_000_000)
            precondition(!FileManager.default.fileExists(atPath:root.appendingPathComponent("terminated").path))
            try Data().write(to:root.appendingPathComponent("release"))
            _ = try await writer.value
            precondition(FileManager.default.fileExists(atPath:root.appendingPathComponent("completed").path))
        default:fatalError("Unknown helper regression")
        }
        print(name+" passed")
    }
}
'''


if __name__ == "__main__":
    unittest.main()
