"""Compile the real native socket channel; exercise Foundation Process fd0 inheritance."""
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

NATIVE=Path(__file__).resolve().parents[1]


@unittest.skipUnless(sys.platform=="darwin" and shutil.which("swiftc"),"macOS Swift runtime required")
class NativeAuthChannelTests(unittest.TestCase):
    def test_foundation_process_inherits_real_bidirectional_socket_and_python_descendant(self):
        with tempfile.TemporaryDirectory(prefix="gd-auth-channel-") as directory:
            root=Path(directory);stub=root/"fixture.swift";program=root/"fixture"
            python_script='''import json,sys,subprocess
sys.path.insert(0,sys.argv[1])
import gendragoon_auth_broker as b
import gendragoon_performance as performance
from unittest.mock import patch
with patch('gendragoon_redx_storage.RedXReceiver.verified_workers',return_value=1):
 performance.configure_from_stdin()
v=json.loads(performance.forwarded_input())
b.client_for(v).authorize()
v=json.loads(performance.forwarded_input())
fd=b.inherited_fds(v)[0]
script="import json,sys;sys.path.insert(0,sys.argv[1]);import gendragoon_auth_broker as b;v=json.loads(sys.stdin.buffer.read());b.attach(v);c=b.client_for(v);c.renew(v['bearerToken']);print(json.dumps({'ok':c.generation==1}))"
for unused in range(2):
 r=subprocess.run([sys.executable,'-B','-c',script,sys.argv[1]],input=json.dumps(v).encode(),capture_output=True,pass_fds=(fd,),timeout=5)
 assert r.returncode==0 and json.loads(r.stdout)['ok']
print('inherited-socket-renewed')
'''
            stub.write_text('''import Foundation
struct GDNativeFailure: Error { let message: String }
@MainActor final class GDRedXAIAuthSession {
 static let shared = GDRedXAIAuthSession()
 func workerRenewalAuthorization(_ value:[String:Any]) throws -> (receiver:String,workspace:String,renew:@Sendable (Bool) async throws -> String) {
  fatalError("Production account authorization is not invoked by this isolated transport fixture")
 }
}
@main struct Fixture {
 static func main() async throws {
  let nonce=String(repeating:"c",count:64),receiver=String(repeating:"b",count:64),workspace=String(repeating:"a",count:32)
  let value:[String:Any] = ["provider":"redxai","cloudApi":"https://api.red-xai.com","storageSecret":String(repeating:"S",count:43),
     "keymapPath":KEYMAP,"receiverId":receiver,"workspaceId":workspace,"bearerToken":"rxca_"+String(repeating:"T",count:43),
     "authBroker":["protocol":1,"fd":0,"nonce":nonce]]
  var payload=try JSONSerialization.data(withJSONObject:value);payload.append(10)
  let channel=try GDWorkerAuthChannel(payload:payload,nonce:nonce,receiver:receiver,workspace:workspace,
      renew:{ _ in "rxca_"+String(repeating:"N",count:43) })
  defer { channel.close() }
  let process=Process();process.executableURL=URL(fileURLWithPath:PYTHON)
  process.arguments=["-B","-c",SCRIPT,RESOURCES]
  let output=Pipe();process.standardOutput=output;process.standardError=FileHandle.standardError
  channel.attach(to:process);try process.run();try channel.start()
  let deadline=Date().addingTimeInterval(15)
  while process.isRunning {
   if Date()>deadline { process.terminate();throw GDNativeFailure(message:"fixture timed out") }
   try await Task.sleep(nanoseconds:10_000_000)
  }
  guard process.terminationStatus==0 else { throw GDNativeFailure(message:"child failed") }
  let result=output.fileHandleForReading.readDataToEndOfFile()
  guard String(decoding:result,as:UTF8.self).contains("inherited-socket-renewed") else {throw GDNativeFailure(message:"missing result")}
  print("PASS Foundation socketpair and nested Python renewal")
 }
}
'''.replace('PYTHON',json.dumps(sys.executable)).replace('SCRIPT',json.dumps(python_script)).replace('RESOURCES',json.dumps(str(NATIVE/"Resources"))).replace('KEYMAP',json.dumps(str(root/"keymap"))))
            result=subprocess.run([shutil.which("swiftc"),"-parse-as-library",str(NATIVE/"Sources/GDWorkerAuthChannel.swift"),str(stub),"-o",str(program)],capture_output=True,text=True,timeout=45)
            self.assertEqual(result.returncode,0,result.stderr)
            result=subprocess.run([str(program)],capture_output=True,text=True,timeout=25)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn("PASS Foundation socketpair",result.stdout)


if __name__=="__main__":unittest.main()
