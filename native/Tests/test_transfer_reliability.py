"""Real private socket IPC, concurrent expiry and immutable retry fixtures."""
from concurrent.futures import ThreadPoolExecutor
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
from unittest.mock import Mock, patch

RESOURCES=Path(__file__).resolve().parents[1]/"Resources"
sys.path.insert(0,str(RESOURCES))
import gendragoon_auth_broker as broker
import gendragoon_redx_storage as storage
import gendragoon_upload_workspace as workspace
import gendragoon_transfer_errors as errors
import test_integrated_upload_workspace as fixtures


class Response(io.BytesIO):
    status=200
    headers={}


class TransferReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.config=dict(provider="redxai",cloudApi=storage.API,workspaceId="a"*32,receiverId="b"*64,
                         bearerToken="rxca_"+"T"*43,storageSecret="S"*43,keymapPath=self.temp.name+"/keymap")

    def channel(self, reply=None):
        parent,child=socket.socketpair();nonce=os.urandom(32).hex()
        self.config["authBroker"]={"protocol":1,"fd":child.fileno(),"nonce":nonce}
        broker.attach(self.config);client=broker.client_for(self.config)
        child.close();calls=[]
        def serve():
            try:
                with parent.makefile("rb") as stream:
                    while True:
                        raw=stream.readline(4097)
                        if not raw:break
                        value=json.loads(raw);calls.append(value)
                        generation=len(calls)
                        result=reply(value,generation) if reply else dict(ok=True,receiverId=self.config["receiverId"],
                            workspaceId=self.config["workspaceId"],generation=generation,bearerToken="rxca_"+str(generation)*43)
                        parent.sendall(json.dumps(result).encode()+b"\n")
            except OSError:pass
        thread=threading.Thread(target=serve,daemon=True);thread.start()
        def close():
            client.socket.close()
            try:parent.shutdown(socket.SHUT_RDWR)
            except OSError:pass
            parent.close();thread.join(timeout=2)
            broker._clients.pop(nonce,None)
        self.addCleanup(close)
        return calls

    @staticmethod
    def unauthorized(request):
        return urllib.error.HTTPError(request.full_url,401,"unauthorized",{},None)

    def test_twenty_concurrent_401s_share_one_native_renewal_and_context(self):
        calls=self.channel();barrier=threading.Barrier(20);requests=[];lock=threading.Lock()
        def open_request(request,timeout):
            token=request.get_header("Authorization")
            with lock:requests.append(token)
            if token.endswith("T"*43):
                barrier.wait(timeout=5);raise self.unauthorized(request)
            return Response(b'{"ok":true}')
        clients=[storage.RedXReceiver(self.config) for _ in range(20)]
        for client in clients:client.opener=Mock(open=open_request)
        with ThreadPoolExecutor(max_workers=20) as pool:
            results=list(pool.map(lambda client:client.json("/v1/receivers/me"),clients))
        self.assertTrue(all(r["ok"] for r in results));self.assertEqual(len(calls),1)
        self.assertEqual(calls[0]["workspaceId"],self.config["workspaceId"])
        self.assertEqual(len(requests),40)

    def test_second_expiry_in_same_long_job_renews_again(self):
        calls=self.channel();client=storage.RedXReceiver(self.config);accepted=["1"]
        def open_request(request,timeout):
            if not request.get_header("Authorization").endswith(accepted[0]*43):raise self.unauthorized(request)
            return Response(b'{}')
        client.opener=Mock(open=open_request)
        client.json("/v1/receivers/me");accepted[0]="2";client.json("/v1/receivers/me")
        self.assertEqual(len(calls),2);self.assertEqual([r["generation"] for r in calls],[0,1])

    def test_renewal_rejects_changed_account_or_note_and_is_bounded(self):
        calls=self.channel(lambda request,generation:{"ok":True,"receiverId":"c"*64,
            "workspaceId":self.config["workspaceId"],"generation":generation,"bearerToken":"rxca_"+"SECRET"*7+"X"})
        client=storage.RedXReceiver(self.config)
        client.opener=Mock(open=Mock(side_effect=lambda request,timeout:(_ for _ in ()).throw(self.unauthorized(request))))
        with self.assertRaises(storage.RedXStorageError) as failure:client.json("/v1/receivers/me")
        self.assertEqual(failure.exception.failure_code,"session_renewal_failed");self.assertEqual(len(calls),1)
        self.assertNotIn("SECRET",str(failure.exception))
        with self.assertRaises(broker.BrokerError):broker.client_for(dict(self.config,workspaceId="c"*32))

    def test_401_after_one_renewal_is_terminal(self):
        calls=self.channel();client=storage.RedXReceiver(self.config)
        client.opener=Mock(open=Mock(side_effect=lambda request,timeout:(_ for _ in ()).throw(self.unauthorized(request))))
        with self.assertRaises(storage.RedXStorageError) as failure:client.json("/v1/receivers/me")
        self.assertEqual(failure.exception.status,401);self.assertEqual(len(calls),1)
        self.assertEqual(client.opener.open.call_count,2)

    def test_per_request_authorization_denies_native_logout_without_disclosing_data(self):
        calls=self.channel(lambda request,generation:{"ok":False,"error":"session_renewal_denied"})
        with self.assertRaises(broker.BrokerError):broker.client_for(self.config).authorize()
        self.assertEqual(calls[0]["operation"],"authorize")

    def test_lost_put_response_retries_identical_immutable_chunk(self):
        client=storage.RedXReceiver(self.config);bodies=[]
        def open_request(request,timeout):
            bodies.append(request.data)
            if len(bodies)==1:raise urllib.error.URLError(ConnectionResetError("fixture lost response"))
            return Response(b'{"id":"ok"}')
        client.opener=Mock(open=open_request)
        route="/v1/receivers/me/workspaces/"+"a"*32+"/blobs/"+"d"*32
        with patch.object(storage.time,"sleep"):
            client._request(route,"PUT",b"same encrypted bytes")
        self.assertEqual(bodies,[b"same encrypted bytes"]*2)

    def test_transient_retries_stop_after_six_and_metadata_writes_do_not_replay(self):
        client=storage.RedXReceiver(self.config)
        client.opener=Mock(open=Mock(side_effect=urllib.error.URLError("fixture disconnected")))
        with patch.object(storage.time,"sleep"):
            with self.assertRaises(storage.RedXStorageError) as failure:client.json("/v1/receivers/me")
        self.assertEqual(client.opener.open.call_count,6);self.assertEqual(failure.exception.failure_code,"transport_unavailable")
        client.opener.open.reset_mock()
        with self.assertRaises(storage.RedXStorageError):client.json("/v1/receivers/me/library/operations","POST",{})
        self.assertEqual(client.opener.open.call_count,1)

    def test_broker_fd_survives_real_nested_helper_stdin_replacement(self):
        calls=self.channel();fd=broker.inherited_fds(self.config)[0]
        script="import json,sys;sys.path.insert(0,sys.argv[1]);import gendragoon_auth_broker as b;v=json.loads(sys.stdin.buffer.read());b.attach(v);c=b.client_for(v);c.renew(v['bearerToken']);print(json.dumps({'ok':c.generation==1}))"
        result=subprocess.run([sys.executable,"-B","-c",script,str(RESOURCES)],input=json.dumps(self.config).encode(),
                              pass_fds=(fd,),capture_output=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr.decode());self.assertTrue(json.loads(result.stdout)["ok"])
        self.assertEqual(len(calls),1)

    def test_nested_helper_preserves_already_renewed_generation(self):
        calls=self.channel();client=broker.client_for(self.config);client.renew(self.config["bearerToken"])
        forwarded=broker.attach(dict(self.config));fd=broker.inherited_fds(forwarded)[0]
        self.assertEqual(forwarded["authBroker"]["generation"],1)
        script="import json,sys;sys.path.insert(0,sys.argv[1]);import gendragoon_auth_broker as b;v=json.loads(sys.stdin.buffer.read());b.attach(v);c=b.client_for(v);c.renew(v['bearerToken']);print(json.dumps({'generation':c.generation}))"
        result=subprocess.run([sys.executable,"-B","-c",script,str(RESOURCES)],input=json.dumps(forwarded).encode(),
                              pass_fds=(fd,),capture_output=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr.decode());self.assertEqual(json.loads(result.stdout)["generation"],2)
        self.assertEqual([r["generation"] for r in calls],[0,1])

    def test_503_retries_safe_reads_but_not_registration_and_tls_is_not_retried(self):
        client=storage.RedXReceiver(self.config)
        def busy(request,timeout):raise urllib.error.HTTPError(request.full_url,503,"unavailable",{},None)
        client.opener=Mock(open=Mock(side_effect=busy))
        with patch.object(storage.time,"sleep"):
            with self.assertRaises(storage.RedXStorageError) as failure:client.json("/v1/receivers/me")
        self.assertEqual(client.opener.open.call_count,6);self.assertEqual(failure.exception.status,503)
        client.opener.open.reset_mock()
        with self.assertRaises(storage.RedXStorageError):client.json("/v1/receivers/me/library/"+"f"*18,"PUT",{})
        self.assertEqual(client.opener.open.call_count,1)
        import ssl
        client.opener=Mock(open=Mock(side_effect=urllib.error.URLError(ssl.SSLCertVerificationError("fixture certificate rejected"))))
        with self.assertRaises(storage.RedXStorageError):client.json("/v1/receivers/me")
        self.assertEqual(client.opener.open.call_count,1)

    def test_allowlisted_child_failure_is_durable_without_arbitrary_output(self):
        fixture=fixtures.UploadWorkspaceTests(methodName="runTest");fixture.setUp();self.addCleanup(fixture.doCleanups)
        state,job_id=fixture.prepare()
        result=subprocess.CompletedProcess([],1,json.dumps({"ok":False,"message":"rxca_SECRET arbitrary user content",
            "failure":{"code":"transport_unavailable","status":503,"token":"rxca_SECRET"}}),"secret stderr")
        def child(command,maintenance_fd=None):
            with patch.object(workspace.subprocess,"run",return_value=result):return workspace.child_result(command,maintenance_fd)
        # Use this module's workspace consistently while borrowing disposable paths.
        with patch.object(workspace,"child_result",side_effect=workspace.WorkspaceError("transport_unavailable",
             errors.MESSAGES["transport_unavailable"],failure={"code":"transport_unavailable","status":503})):
            with self.assertRaises(workspace.WorkspaceError):workspace.run_next(fixture.home)
        saved=workspace.read_state(fixture.home)["jobs"][-1]
        self.assertEqual(saved["failure"]["code"],"transport_unavailable");self.assertEqual(saved["failure"]["status"],503)
        self.assertIn(saved["failure"]["phase"],workspace.PROGRESS_PHASES)
        self.assertNotIn("SECRET",json.dumps(saved))
        with patch.object(workspace.subprocess,"run",return_value=result):
            with self.assertRaises(workspace.WorkspaceError) as failure:workspace.child_result([sys.executable,"-B","fixture.py"])
        self.assertEqual(failure.exception.code,"transport_unavailable");self.assertNotIn("SECRET",str(failure.exception))


if __name__=="__main__":unittest.main()
