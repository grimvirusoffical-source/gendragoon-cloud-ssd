"""Compile the production Swift activity gate/delegate with headless UI facades.

This runs on macOS. It exercises the real locking/state code, including the
different ordinary-quit and acknowledged-update decisions, without quitting or
signalling the user's installed application.
"""
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

NATIVE = Path(__file__).resolve().parents[1]


class UpdateActivityTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "darwin", "Swift/AppKit target requires the Mac validation runner")
    def test_actual_activity_and_acknowledged_quit_gates(self):
        updater = (NATIVE / "Sources/GenDragoonAutoUpdate.swift").read_text()
        activity = updater[updater.index("final class GDUpdateActivity:"):updater.index("@MainActor final class GDUpdateCoordinator:")]
        app = (NATIVE / "Sources/GenDragoonApp.swift").read_text()
        delegate = app[app.index("@MainActor final class GDAppLifetime:"):app.index("\n@main",app.index("@MainActor final class GDAppLifetime:"))]
        login = (NATIVE / "Sources/GenDragoonStartupRoot.swift").read_text()
        handler = login[login.index("        out.fileHandleForReading.readabilityHandler ="):login.index("        task.terminationHandler=")]
        eof_probe = """
@MainActor final class LoginEOFProbe {
    var ingested=false
    func ingest(_ part:String) { ingested=true }
    func connect(_ out:Pipe) {
""" + handler + "\n    }\n}\n"
        with tempfile.TemporaryDirectory(prefix="gendragoon-update-activity-") as temporary:
            root = Path(temporary).resolve()
            source = root / "ActivitySmoke.swift"
            binary = root / "activity-smoke"
            source.write_text(FACADES + activity + delegate + eof_probe + ASSERTIONS)
            compiled = subprocess.run(["/usr/bin/xcrun","swiftc","-parse-as-library",str(source),"-o",str(binary)],
                                      capture_output=True,text=True,timeout=60)
            self.assertEqual(compiled.returncode,0,compiled.stderr[-8000:])
            result = subprocess.run([str(binary)],capture_output=True,text=True,timeout=10)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn("update activity and ordinary-quit gates passed",result.stdout)


FACADES = '''
import Foundation
protocol ObservableObject: AnyObject {}
@propertyWrapper struct Published<Value> { var wrappedValue: Value }
protocol NSApplicationDelegate {}
final class NSApplication { enum TerminateReply { case terminateNow, terminateCancel } }
final class NSAlert {
    var messageText=""; var informativeText=""
    func addButton(withTitle: String) {}
    func runModal() {}
}
@MainActor final class GDUpdateCoordinator {
    static let shared=GDUpdateCoordinator()
    var requestsTermination=false
    func prepareForTermination() {}
}
'''

ASSERTIONS = '''
@main struct ActivitySmoke {
    @MainActor static func main() {
        let gate=GDUpdateActivity.shared, cloud=NSObject(), transfer=NSObject(), managed=NSObject()
        let updater=GDUpdateCoordinator.shared, delegate=GDAppLifetime(), app=NSApplication()
        gate.set(cloud,key:"mounted",active:true)
        precondition(gate.hasActiveOperations)
        precondition(gate.isBusy)
        precondition(!gate.isBusyForUpdate())
        precondition(gate.canStart())
        precondition(!gate.beginMaintenance(owner:updater))
        precondition(delegate.applicationShouldTerminate(app) == .terminateCancel)
        precondition(gate.beginUpdateMaintenance(owner:updater))
        precondition(!gate.canStart(excluding:transfer))
        precondition(!gate.isBusyForUpdate(excluding:updater))
        updater.requestsTermination=true
        precondition(delegate.applicationShouldTerminate(app) == .terminateNow)
        gate.set(transfer,key:"upload",active:true)
        precondition(delegate.applicationShouldTerminate(app) == .terminateCancel)
        gate.set(transfer,key:"upload",active:false)
        gate.set(managed,key:"runningApps",active:true)
        precondition(gate.isBusyForUpdate(excluding:updater))
        precondition(delegate.applicationShouldTerminate(app) == .terminateCancel)
        gate.endMaintenance(owner:updater)
        precondition(!gate.beginUpdateMaintenance(owner:updater))
        gate.set(managed,key:"runningApps",active:false)
        updater.requestsTermination=false
        precondition(delegate.applicationShouldTerminate(app) == .terminateCancel)
        gate.set(cloud,key:"mounted",active:false)
        precondition(delegate.applicationShouldTerminate(app) == .terminateNow)
        gate.set(cloud,key:"workspaceMounts",active:true)
        precondition(gate.canStart(),"An existing independent workspace mount must permit another ordinary operation")
        precondition(gate.isBusyForUpdate(),"An independent workspace mount cannot be quiesced as the primary mount")
        precondition(!gate.beginUpdateMaintenance(owner:updater))
        precondition(delegate.applicationShouldTerminate(app) == .terminateCancel)
        gate.set(cloud,key:"workspaceMounts",active:false)
        // Maintenance prevents new polling without interrupting an existing
        // reader. Both real leases must drain before the worker can begin.
        let first=gate.beginBackgroundInspection()!,second=gate.beginBackgroundInspection()!
        precondition(gate.hasBackgroundInspections)
        precondition(!gate.beginMaintenance(owner:updater))
        precondition(gate.beginUpdateMaintenance(owner:updater))
        precondition(gate.beginBackgroundInspection()==nil)
        gate.endBackgroundInspection(first)
        gate.endBackgroundInspection(first)
        precondition(gate.hasBackgroundInspections)
        precondition(!gate.canStart(excluding:transfer))
        gate.endBackgroundInspection(second)
        precondition(!gate.hasBackgroundInspections)
        precondition(gate.beginBackgroundInspection()==nil)
        gate.endMaintenance(owner:updater)
        let resumed=gate.beginBackgroundInspection()!
        gate.endBackgroundInspection(resumed)
        // Execute the production login closure with real EOF on a local pipe.
        let output=Pipe(),login=LoginEOFProbe()
        login.connect(output)
        let handler=output.fileHandleForReading.readabilityHandler!
        output.fileHandleForWriting.closeFile()
        handler(output.fileHandleForReading)
        precondition(output.fileHandleForReading.readabilityHandler==nil)
        precondition(!login.ingested)
        output.fileHandleForReading.closeFile()
        print("update activity and ordinary-quit gates passed")
    }
}
'''


if __name__=="__main__":unittest.main()
