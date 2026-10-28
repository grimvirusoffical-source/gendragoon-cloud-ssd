"""Current desktop protocol, vault interoperability, renewal, and original retention."""
import base64
import concurrent.futures
from contextlib import contextmanager
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import stat
import struct
import sys
import tempfile
import threading
import queue
import select
import subprocess
import time
import unittest
import urllib.error
from unittest.mock import patch

DESKTOP=Path(__file__).resolve().parents[1]
NATIVE=DESKTOP.parent
RUNTIME=Path(os.environ.get("GD_DESKTOP_RUNTIME",DESKTOP))
sys.path.insert(0,str(DESKTOP))
if (RUNTIME/"runtime").is_dir():
    sys.path.insert(0,str(RUNTIME));sys.path.insert(0,str(RUNTIME/"runtime"))
for name in ("librsx.so","librsx.dylib","rsx.dll","librsx.dll"):
    library=RUNTIME/"runtime/redxai/_native"/name
    if library.is_file():os.environ["RSX_LIB"]=str(library);break
import redx_session as auth
import portable_vault as vault
import machinenotes_client as client
import private_fs as private
import portable_apps as apps

FIXTURE=json.loads((NATIVE/"Tests/fixtures/portable-vault-v1.json").read_text(encoding="utf-8"))
OWNER=FIXTURE["receiverId"]
NOTE="a"*32
OTHER="b"*32
KEY="c"*18

def token_set(access="A",refresh="R",subject="desktop-test"):
    return dict(access_token="rxca_"+access*43,refresh_token="rxcr_"+refresh*43,expires_in=3600,
        user=dict(sub=subject,email="fixture@example.invalid",email_verified=True))

class MemorySession(auth.RedXSession):
    def __init__(self):
        super().__init__();self.receiver=OWNER;self._access="rxca_"+"T"*43;self._expires=10**20
        self.rows=[];self.revision=0;self.calls=[];self.blobs={}
        self.note=dict(id=NOTE,name="Fixture note",active=True,readOnly=False,quotaBytes=10**12,usedBytes=0,workers=2)
    def request(self,path,method="GET",value=None):
        self.calls.append((path,method,copy.deepcopy(value)))
        if path=="/v1/receivers/me":return dict(id=OWNER,state="ready",workspaces=[self.note],machineNotes=[self.note],usedBytes=0,libraryItems=len(self.rows))
        if path=="/v1/receivers/me/workspaces/"+NOTE+"/library":return dict(revision=self.revision,items=copy.deepcopy(self.rows))
        if path=="/v1/receivers/me/library/operations":return dict(revision=self.revision+1,items=self.rows)
        if path.startswith("/v1/receivers/me/library/") and method=="PUT":
            key=path.rsplit("/",1)[1];item=dict(value,key=key,archiveKey=key,displayName=value["name"],virtualFolder=False)
            self.rows=[i for i in self.rows if i["key"]!=key]+[item];self.revision+=1;return item
        raise AssertionError("unexpected fixture route")

class MemoryReceiver(client.DesktopReceiver):
    def json(self,route,method="GET",value=None,expected=(200,)):
        return self.config["_session"].request(route,method,value)
    def get_png(self,oid):
        try:return self.config["_session"].blobs[oid]
        except KeyError:raise client.storage.RedXStorageError("missing fixture object",404)
    def put_png(self,oid,png):
        blobs=self.config["_session"].blobs
        if oid in blobs and blobs[oid]!=png:raise client.storage.RedXStorageError("immutable fixture conflict",409)
        blobs[oid]=png
        return dict(id=oid,carrierBytes=len(png),carrierSha256=hashlib.sha256(png).hexdigest())

def item(**updates):
    value=dict(key=KEY,workspace=NOTE,name="test.txt",displayName="test.txt",kind="file",virtualFolder=False,
        manifestId="d"*32,archiveSha256="e"*64,archiveBytes=10)
    value.update(updates);return value

class VaultTests(unittest.TestCase):
    def setUp(self):
        try:import cryptography
        except ImportError:
            if os.environ.get("GD_DESKTOP_RUNTIME"):self.fail("Mandatory desktop cryptography dependency missing")
            self.skipTest("Desktop private runtime cryptography dependency required")
    def test_mac_cryptokit_vector_exactly_matches_python_aesgcm(self):
        raw=json.dumps(FIXTURE["envelope"]).encode()
        keys=vault.open_vault(raw,FIXTURE["password"],OWNER)
        self.assertEqual(keys["storageSecret"],FIXTURE["storageSecret"])
        self.assertEqual(keys["keymap"],vault.decoded(FIXTURE["keymap"],100))
        expected=vault.seal_vault(keys,FIXTURE["password"],salt=bytes(range(16)),nonce=bytes(range(16,28)))
        self.assertEqual(json.loads(expected),FIXTURE["envelope"])
    def test_account_password_tamper_and_untrusted_kdf_rejected(self):
        raw=json.dumps(FIXTURE["envelope"]).encode()
        for password,owner in (("wrong password",OWNER),(FIXTURE["password"],"f"*64)):
            with self.assertRaises(vault.VaultError):vault.open_vault(raw,password,owner)
        for iterations in (True,600001,600000.5,10**18):
            value=copy.deepcopy(FIXTURE["envelope"]);value["kdf"]["iterations"]=iterations
            with self.assertRaises(vault.VaultError):vault.open_vault(json.dumps(value).encode(),FIXTURE["password"],OWNER)
    def test_import_never_replaces_different_keymap_and_core_unlocks_readonly(self):
        try:rsx=client.crypto_runtime()
        except vault.VaultError:
            if os.environ.get("GD_DESKTOP_RUNTIME"):self.fail("Mandatory pinned platform codec unavailable")
            self.skipTest("Pinned platform codec unavailable")
        keys=vault.open_vault(json.dumps(FIXTURE["envelope"]).encode(),FIXTURE["password"],OWNER)
        with tempfile.TemporaryDirectory() as td:
            path=vault.install_keymap(keys,Path(td).resolve()/"keys",rsx)
            self.assertEqual(path.read_bytes(),keys["keymap"])
            self.assertEqual(list(path.parent.iterdir()),[path])
            bad=dict(keys,keymap=keys["keymap"][:-1]+bytes([keys["keymap"][-1]^1]))
            with self.assertRaises(vault.VaultError):vault.install_keymap(bad,path.parent,rsx)
            self.assertEqual(path.read_bytes(),keys["keymap"])

class SessionTests(unittest.TestCase):
    def test_browser_approval_pkce_receiver_identity_and_no_disk_credentials(self):
        calls=[];codes=[];opened=[];session=auth.RedXSession()
        def http(origin,path,method="GET",value=None,token=None,transport=None):
            calls.append((origin,path,value,token))
            if path.endswith("/start"):return dict(device_code="D"*43,user_code="ABCDEFGH",verification_uri=auth.ISSUER+"/redxai-connect",interval=2,expires_in=300)
            if path.endswith("/token"):return token_set()
            return dict(id=auth.receiver_id("desktop-test"),state="ready")
        with patch.object(auth,"http_json",side_effect=http),patch.object(auth.time,"sleep"):
            session.login(codes.append,opened.append)
        self.assertEqual(codes,["ABCDEFGH"]);self.assertEqual(opened,[auth.ISSUER+"/redxai-connect"])
        start=calls[0][2];exchange=calls[1][2]
        self.assertEqual(start["code_challenge_method"],"S256")
        self.assertEqual(start["code_challenge"],base64.urlsafe_b64encode(hashlib.sha256(exchange["code_verifier"].encode()).digest()).decode().rstrip("="))
        self.assertEqual(session.receiver,auth.receiver_id("desktop-test"))
        self.assertEqual(calls[2][0],auth.API)
        session.logout()
        with self.assertRaises(auth.SessionError):session.token()
    def test_twenty_concurrent_expired_requests_share_one_refresh(self):
        session=auth.RedXSession();session._apply(token_set());old=session.token()
        count=[];barrier=threading.Barrier(20)
        def http(origin,path,method="GET",value=None,token=None,transport=None):
            self.assertEqual(origin,auth.ISSUER);self.assertTrue(path.endswith("/refresh"));count.append(1);return token_set("B","Q")
        def renew(_):barrier.wait(timeout=10);return session.renew(old)
        with patch.object(auth,"http_json",side_effect=http),concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
            values=list(pool.map(renew,range(20)))
        self.assertEqual(len(count),1);self.assertEqual(set(values),{"rxca_"+"B"*43})
    def test_refresh_cannot_change_account_and_second_401_is_terminal(self):
        session=auth.RedXSession();session._apply(token_set())
        with patch.object(auth,"http_json",return_value=token_set(subject="other")):
            with self.assertRaises(auth.SessionError):session.renew(session.token())
        session=auth.RedXSession();session._apply(token_set());calls=[]
        def http(origin,path,method="GET",value=None,token=None,transport=None):
            calls.append(path)
            if path.endswith("/refresh"):return token_set("B","Q")
            raise auth.SessionError("expired",401)
        with patch.object(auth,"http_json",side_effect=http):
            with self.assertRaises(auth.SessionError):session.request("/v1/receivers/me")
        self.assertEqual(calls.count("/redxai-connect/refresh"),1)
        self.assertEqual(calls.count("/v1/receivers/me"),2)
    def test_integration_session_has_no_teams_or_key_management_authority(self):
        session=auth.IntegrationSession("gdpk_"+"a"*16+"_"+"K"*43)
        for path in ("/v1/receivers/me/dev-teams","/v1/integrations/keys","https://other.invalid/"):
            with self.assertRaises(auth.SessionError):session.request(path)

class ModelTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.session=MemorySession();self.model=client.MachineNotesClient(self.session,Path(self.temp.name).resolve()/"state")
        self.model.refresh_notes()
    def test_inventory_tree_isolation_and_revision_checked_mutation(self):
        self.session.rows=[item()];self.model.refresh_tree();self.model.organize("rename",[KEY],name="New.txt")
        path,method,value=self.session.calls[-1]
        self.assertEqual(value["expectedRevision"],0);self.assertEqual(value["workspace"],NOTE);self.assertEqual(value["keys"],[KEY])
        self.session.rows=[item(workspace=OTHER)]
        with self.assertRaises(auth.SessionError):self.model.refresh_tree()
    def test_portable_prepare_uses_current_authenticated_download_and_never_origin_hints(self):
        raw=bytearray(64);raw[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',raw,16,2,62);struct.pack_into('<Q',raw,24,0x400000)
        metadata=[dict(path='.',type='file',size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),executable=0o100)]
        self.session.rows=[item(name='portable',displayName='portable',applicationPlatform='windows',origin=dict(schema=1,platform='windows',architecture='arm64',deviceId='f'*32))]
        called=[]
        def authenticated_download(config,selected,path,client_factory=None):
            called.append((config,selected,client_factory));private.write_private(path,raw)
            return dict(manifest=metadata,root=dict(archiveLayout='flat'))
        with patch.object(self.model,'config',return_value={'_session':self.session}),patch.object(client.storage,'download_archive',side_effect=authenticated_download),patch.object(apps,'host',return_value=('linux','x86_64')):
            prepared=self.model.prepare_portable_app(KEY,allow_local_copy=True)
        self.assertEqual(prepared.candidates,('.',));self.assertEqual(called[0][2],client.DesktopReceiver)
        self.assertEqual(prepared.payload.read_bytes(),raw);self.assertTrue((prepared.payload.parent/'verified-archive.zip').is_file())
        self.assertEqual(prepared.identity,apps.identity(OWNER,NOTE,self.session.rows[0]))
        with patch.object(self.model.portable_apps,'launch') as launch:
            self.model.selected_note=OTHER
            with self.assertRaises(apps.PortableAppError):self.model.launch_portable_app(prepared,'.',approved=True)
            launch.assert_not_called()
            self.model.selected_note=NOTE;self.session.rows[0]['manifestId']='f'*32
            with self.assertRaises(apps.PortableAppError):self.model.launch_portable_app(prepared,'.',approved=True)
            launch.assert_not_called()
    def test_uncertain_portable_lease_blocks_destructive_model_actions_before_network(self):
        directory=private.private_directory(self.model.portable_apps.root/OWNER/NOTE/('a'*64)/('b'*32)/'control')
        lease_id='f'*32
        private.write_private(directory/('lease-'+lease_id+'.json'),json.dumps(dict(schema=apps.SCHEMA,id=lease_id,state='running',brokerPid=123,brokerIdentity='unverifiable')).encode())
        self.model.revision=0;before=len(self.session.calls)
        with patch.object(apps,'process_identity',return_value=None):
            for operation in ('delete','move','rename'):
                with self.assertRaises(apps.PortableAppError):self.model.organize(operation,[KEY],name='changed')
        self.assertEqual(len(self.session.calls),before);self.assertTrue(directory.is_dir())
    def test_tree_cycles_missing_parents_and_crossnote_selections_rejected(self):
        for values in ([item(parentKey="f"*18)],[item(key="a"*18,kind="folder",virtualFolder=True,parentKey="b"*18),item(key="b"*18,kind="folder",virtualFolder=True,parentKey="a"*18)]):
            self.session.rows=values
            with self.assertRaises(auth.SessionError):self.model.refresh_tree()
        with self.assertRaises(auth.SessionError):self.model.select_note(OTHER)
    def test_pending_jobs_are_private_account_bound_and_have_no_credentials(self):
        source=Path(self.temp.name)/"original.txt";source.write_text("original fixture")
        job=self.model.enqueue_selection(NOTE,None,[str(source)])
        self.assertEqual(self.model.jobs()[0]["id"],job["id"])
        saved=next((self.model.root/"jobs"/OWNER).glob("*.json"));raw=saved.read_text()
        self.assertNotIn(self.session.token(),raw);self.assertNotIn("storageSecret",raw);self.assertEqual(json.loads(raw)["sources"],[str(source)])
        if os.name!="nt":self.assertEqual(saved.stat().st_mode&0o777,0o600)
        with self.assertRaises(auth.SessionError):self.model.enqueue_selection(OTHER,None,[str(source)])
        with self.assertRaises(ValueError):self.model.enqueue_selection(NOTE,None,["relative.txt"])
    def test_failed_job_retains_original_and_sanitized_failure(self):
        source=Path(self.temp.name)/"original.txt";source.write_text("original fixture")
        self.model.enqueue_selection(NOTE,None,[str(source)]);self.model.keys={};self.model.vault_exported=True
        with patch.object(self.model,"upload",side_effect=RuntimeError("PRIVATE-DIAGNOSTIC rxcr_"+"S"*43)):
            with self.assertRaises(RuntimeError):self.model.run_next_job()
        job=self.model.jobs()[0];self.assertEqual(job["state"],"failed");self.assertEqual(job["failure"]["code"],"transfer_failed")
        self.assertNotIn("PRIVATE",json.dumps(job));self.assertNotIn("rxcr_",json.dumps(job));self.assertEqual(source.read_text(),"original fixture")
    def test_partial_queue_retry_skips_only_verified_unchanged_completed_items(self):
        first=Path(self.temp.name)/"first";second=Path(self.temp.name)/"second";first.write_text("first");second.write_text("second")
        self.model.enqueue_selection(NOTE,None,[str(first),str(second)]);self.model.keys={};self.model.vault_exported=True
        original=item()
        calls=[]
        def upload(path,parent):
            calls.append(path.name)
            if path.name=="second":raise RuntimeError("fixture interrupted second source")
            self.session.rows=[original];self.model.items=[original]
            return dict(key=original["key"],manifestId=original["manifestId"],archiveSha256=original["archiveSha256"],verified=True)
        with patch.object(self.model,"upload",side_effect=upload):
            with self.assertRaises(RuntimeError):self.model.run_next_job()
        self.assertEqual(self.model.jobs()[0]["completedSources"],[0]);self.model.retry_jobs()
        with patch.object(self.model,"upload",return_value={"verified":True}) as resumed:
            self.model.run_next_job();self.assertEqual(resumed.call_count,1);self.assertEqual(resumed.call_args.args[0],second)
        self.assertEqual(self.model.jobs()[0]["state"],"completed")
    def test_teams_integration_mode_fails_before_any_request(self):
        self.model.session=auth.IntegrationSession("gdpk_"+"a"*16+"_"+"K"*43)
        with self.assertRaises(auth.SessionError):self.model.teams()

class ArchiveTests(unittest.TestCase):
    def test_portable_zip_manifest_full_tree_and_exclusive_restore(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();source=root/"Selected";source.mkdir();(source/"empty").mkdir();(source/"zero").touch();(source/"unicode-紫.txt").write_bytes(b"verified fixture")
            baseline=client.manifest(source);archive=root/"archive.zip";client.package(source,archive,baseline)
            restored=root/"restored";restored.mkdir();result=client.extract_checked(archive,restored,baseline["manifest"],source.name,"zip-root")
            self.assertEqual((result/"unicode-紫.txt").read_bytes(),b"verified fixture");self.assertTrue((result/"empty").is_dir());self.assertEqual((result/"zero").stat().st_size,0)
            destination=root/"Published";client.publish_exclusive(result,destination)
            other=root/"other";other.mkdir()
            with self.assertRaises((ValueError,OSError)):client.publish_exclusive(other,destination)
            self.assertEqual((destination/"unicode-紫.txt").read_bytes(),b"verified fixture")
    def test_archive_traversal_and_platform_metadata_fail_without_publish(self):
        import zipfile
        record=dict(path=".",type="file",executable=0,size=1,sha256=hashlib.sha256(b"x").hexdigest())
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);archive=root/"bad.zip";out=root/"out";out.mkdir()
            with zipfile.ZipFile(archive,"w") as z:z.writestr("../escape",b"x")
            with self.assertRaises(ValueError):client.extract_checked(archive,out,[record],"file","zip-root")
            self.assertFalse((root/"escape").exists())
            with self.assertRaises(ValueError):client.checked_manifest([dict(record,xattrs={"com.apple.ResourceFork":"AA"})])
            with self.assertRaises(ValueError):client.checked_manifest([dict(record,type="symlink",target="../outside")])

class CompanionDispatchTests(unittest.TestCase):
    def setUp(self):
        try:import tkinter
        except ImportError:self.skipTest("Tkinter standard runtime required")
        import gendragoon_gui as gui
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.app=gui.GenDragoonGUI.__new__(gui.GenDragoonGUI)
        self.app.model=client.MachineNotesClient(MemorySession(),Path(self.temp.name).resolve()/"state");self.app.model.refresh_notes()
        self.app.busy=False;self.app.messages=queue.Queue();self.app.companion_grants=set();self.app.companion_completed={};self.app.root=None
        self.app.drain_queue=lambda:None
        self.app.run=lambda label,work,done,failed=None:done(work())
    def dispatch(self,method,params=None,kind="browser",identifier="a"*32):
        values=[]
        self.app.companion_dispatch(dict(id=identifier,method=method,params=params or {},_clientId="fixture-client",_clientLabel="Fixture extension",_clientKind=kind),values.append)
        self.app.messages.get_nowait()()
        self.assertEqual(len(values),1)
        return values[0]
    def test_native_first_use_approval_metadata_filter_and_request_dedup(self):
        self.app.model.session.note["storageSecret"]="never-visible-test-value"
        with patch("tkinter.messagebox.askyesno",return_value=True) as approved:
            self.assertTrue(self.dispatch("status")["connected"]);self.assertEqual(approved.call_count,0)
            first=self.dispatch("request",dict(path="/v1/receivers/me",method="GET"))
            count=len(self.app.model.session.calls)
            second=self.dispatch("request",dict(path="/v1/receivers/me",method="GET"))
            self.assertEqual(first,second);self.assertEqual(len(self.app.model.session.calls),count);self.assertEqual(approved.call_count,1)
        self.assertNotIn("storageSecret",json.dumps(first));self.assertNotIn("never-visible",json.dumps(first))
    def test_editor_rpc_acceptance_is_durable_before_transfer_and_idempotent(self):
        source=Path(self.temp.name)/"original";source.write_text("retained")
        with patch("tkinter.messagebox.askyesno",return_value=True):
            result=self.dispatch("uploadSelection",dict(workspaceId=NOTE,selectedPaths=[str(source)]),kind="vscode")
            self.assertTrue(result["queued"]);self.assertEqual(self.app.model.jobs()[0]["id"],result["jobId"])
            duplicate=self.dispatch("uploadSelection",dict(workspaceId=NOTE,selectedPaths=[str(source)]),kind="vscode")
            self.assertEqual(result,duplicate);self.assertEqual(len(self.app.model.jobs()),1)
        self.assertEqual(source.read_text(),"retained")
    def test_browser_cannot_supply_paths_or_request_keys_admin_or_blob_data(self):
        with patch("tkinter.messagebox.askyesno",return_value=True):
            denied=self.dispatch("uploadSelection",dict(workspaceId=NOTE,selectedPaths=[str(Path(self.temp.name)/"private")]))
            self.assertFalse(denied["ok"])
            for index,path in enumerate(("/v1/integrations/keys","/v1/receivers/admin/machine-notes","/v1/receivers/me/workspaces/"+NOTE+"/blobs/"+"f"*32)):
                result=self.dispatch("request",dict(path=path,method="GET"),identifier=(str(index+1)*32))
                self.assertFalse(result["ok"])

class ActualCodecTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform=='win32' or sys.platform.startswith('linux'),'Actual matching native app runtime required')
    def test_actual_encrypted_current_machinenotes_portable_native_archive_launch(self):
        try:
            import numpy,PIL,cryptography
            client.crypto_runtime()
        except (ImportError,vault.VaultError):
            if os.environ.get('GD_DESKTOP_RUNTIME'):self.fail('Mandatory pinned runtime dependencies missing')
            self.skipTest('Pinned desktop encryption runtime required')
        with native_fixture_directory(prefix='gd-portable-encrypted-') as td:
            root=Path(td).resolve();binary=compile_portable_fixture(root)
            source=root/'Original portable app';source.mkdir();shutil.copyfile(binary,source/binary.name)
            if os.name!='nt':(source/binary.name).chmod(0o700)
            before=client.manifest(source);session=MemorySession();model=client.MachineNotesClient(session,root/'state');model.refresh_notes()
            model.import_vault(json.dumps(FIXTURE['envelope']).encode(),FIXTURE['password'])
            with patch.object(client,'DesktopReceiver',MemoryReceiver):
                uploaded=model.upload(source);prepared=model.prepare_portable_app(uploaded['key'],allow_local_copy=True)
                self.assertEqual(prepared.records,before['manifest']);self.assertEqual(prepared.candidates,(binary.name,))
            try:
                receipt=launch_native_fixture(lambda:model.launch_portable_app(prepared,binary.name,approved=True))
                wait_fixture(lambda:(prepared.payload/'child-started').exists())
                with self.assertRaises(apps.PortableAppError):model.organize('delete',[uploaded['key']])
                self.assertEqual(client.manifest(source),before)
            finally:finish_native_fixture(model.portable_apps,prepared)
            wait_fixture(lambda:model.portable_apps.leases()[0]['state']=='complete')
            self.assertTrue((prepared.payload.parent/'verified-archive.zip').exists());self.assertTrue((prepared.payload/binary.name).exists());self.assertEqual(client.manifest(source),before)

    def test_real_pinned_core_visual_png_upload_readback_and_renamed_copy_restore(self):
        if os.environ.get("GD_DESKTOP_RUNTIME"):
            self.assertEqual(Path(client.__file__).resolve().parent,RUNTIME.resolve(),"Mandatory tests must exercise the staged desktop client")
        try:
            import numpy,PIL,cryptography
            client.crypto_runtime()
        except (ImportError,vault.VaultError):
            if os.environ.get("GD_DESKTOP_RUNTIME"):self.fail("Mandatory native desktop runtime or image dependencies missing")
            self.skipTest("Pinned native desktop runtime and image dependencies required")
        session=MemorySession()
        with tempfile.TemporaryDirectory(prefix="gd-desktop-codec-測試-📦-") as td:
            root=Path(td).resolve();model=client.MachineNotesClient(session,root/"state");model.refresh_notes()
            model.import_vault(json.dumps(FIXTURE["envelope"]).encode(),FIXTURE["password"])
            source=root/"original-測試-📦.bin";payload=os.urandom(70_000);source.write_bytes(payload)
            with patch.object(client,"DesktopReceiver",MemoryReceiver):
                result=model.upload(source)
                self.assertTrue(result["verified"]);self.assertTrue(result["originalRetained"]);self.assertEqual(source.read_bytes(),payload)
                self.assertGreaterEqual(len(session.blobs),5)
                for png in session.blobs.values():
                    self.assertEqual(png[:8],b"\x89PNG\r\n\x1a\n")
                    offset=8;types=[]
                    while offset<len(png):
                        size=struct.unpack(">I",png[offset:offset+4])[0];types.append(png[offset+4:offset+8]);offset+=size+12
                    self.assertNotIn(b"rxAI",types)
                copied=dict(session.rows[0],key="f"*18,displayName="Renamed copy-測試-📦.bin",archiveKey=session.rows[0]["key"])
                session.rows.append(copied);session.revision+=1
                output=root/"download";output.mkdir();downloaded=model.download(copied["key"],output)
                self.assertTrue(downloaded["verified"]);self.assertEqual((output/"Renamed copy-測試-📦.bin").read_bytes(),payload)
                self.assertEqual(source.read_bytes(),payload)

class PrivateFilesystemTests(unittest.TestCase):
    def test_concurrent_private_directory_creation_and_exclusive_files(self):
        with tempfile.TemporaryDirectory() as td:
            path=Path(td).resolve()/"new-profile/scratch"
            with concurrent.futures.ThreadPoolExecutor(max_workers=20) as pool:
                self.assertEqual(set(pool.map(lambda _:str(private.private_directory(path)),range(40))),{str(path)})
            private.verify(path)
            file=path/"private.json";private.write_private(file,b"generated fixture")
            private.verify(file)
            with self.assertRaises(FileExistsError):private.write_private(file,b"different")
            self.assertEqual(file.read_bytes(),b"generated fixture")
    def test_single_desktop_coordinator_blocks_second_instance(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve()/"profile";first=client.DesktopInstance(root)
            try:
                with self.assertRaises((ValueError,OSError)):client.DesktopInstance(root)
            finally:first.close()
            second=client.DesktopInstance(root);second.close()
    @unittest.skipUnless(sys.platform=="win32","Actual Windows owner SID and private DACL required")
    def test_windows_profile_jobs_keymap_and_generated_cache_have_current_sid_only(self):
        import gendragoon_platform_ipc as ipc
        security=ipc.modules()[-1];sid=security.ConvertSidToStringSid(ipc.user_sid())
        with tempfile.TemporaryDirectory() as td:
            parent=Path(td)
            before=security.GetFileSecurity(str(parent),security.OWNER_SECURITY_INFORMATION|security.DACL_SECURITY_INFORMATION)
            before_text=security.ConvertSecurityDescriptorToStringSecurityDescriptor(before,1,security.OWNER_SECURITY_INFORMATION|security.DACL_SECURITY_INFORMATION)
            root=private.private_directory(parent/"GenDragoon-only")
            for directory in (root/"jobs",root/"keys",root/"cache"):
                private.private_directory(directory);private.write_private(directory/"new.bin",b"private fixture")
            (root/"cache/generated-by-archive.bin").write_bytes(b"restored generated fixture")
            private.protect_generated_tree(root)
            for path in (root,*root.rglob("*")):
                ipc.verify_private(path)
                descriptor=security.GetFileSecurity(str(path),security.OWNER_SECURITY_INFORMATION|security.DACL_SECURITY_INFORMATION)
                self.assertEqual(security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner()),sid)
                acl=descriptor.GetSecurityDescriptorDacl()
                self.assertTrue(all(security.ConvertSidToStringSid(acl.GetAce(i)[-1])==sid for i in range(acl.GetAceCount())))
            after=security.GetFileSecurity(str(parent),security.OWNER_SECURITY_INFORMATION|security.DACL_SECURITY_INFORMATION)
            self.assertEqual(security.ConvertSecurityDescriptorToStringSecurityDescriptor(after,1,security.OWNER_SECURITY_INFORMATION|security.DACL_SECURITY_INFORMATION),before_text)

class CompiledRuntimeTests(unittest.TestCase):
    def test_frozen_sibling_import_redirect_is_scoped_to_codec_tree(self):
        import importlib.util,py_compile
        from codec_loader import install_sourceless_runtime
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);package=root/"redsecretsxai";package.mkdir();source=package/"fixture.py";source.write_text("answer=42\n")
            py_compile.compile(str(source),cfile=str(source.with_suffix(".pyc")),doraise=True);source.unlink()
            install_sourceless_runtime(root)
            spec=importlib.util.spec_from_file_location("_gd_frozen_fixture",source);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
            self.assertEqual(module.answer,42)
            other=root/"unrelated";other.mkdir();missing=other/"fixture.py";shutil.copyfile(source.with_suffix(".pyc"),missing.with_suffix(".pyc"))
            spec=importlib.util.spec_from_file_location("_gd_unrelated_fixture",missing)
            with self.assertRaises(FileNotFoundError):spec.loader.exec_module(importlib.util.module_from_spec(spec))
    def test_public_prebuilt_archives_are_compiled_only_and_hash_pinned(self):
        import zipfile
        index_path=DESKTOP/"runtimes/runtime-index.json"
        if not index_path.is_file():self.skipTest("Prebuilt platform inputs not staged")
        index=json.loads(index_path.read_text())["runtimes"]
        for entry in index.values():
            archive=DESKTOP/"runtimes"/entry["archive"]
            self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(),entry["sha256"])
            with zipfile.ZipFile(archive) as source:
                manifest=json.loads(source.read("manifest.json"))
                self.assertEqual(manifest["pinnedLibrary"],"9235941b431bc1c23c34286b82052f845121592f")
                self.assertEqual(manifest["pythonMajorMinor"],"3.13")
                self.assertEqual(set(source.namelist()),{"manifest.json",*manifest["files"]})
                for name,record in manifest["files"].items():
                    data=source.read(name);self.assertEqual(len(data),record["bytes"]);self.assertEqual(hashlib.sha256(data).hexdigest(),record["sha256"])
                    self.assertFalse(name.endswith(".py"))
                    if name.endswith(".pyc"):self.assertEqual(data[:4],bytes.fromhex("f30d0d0a"))
    @unittest.skipUnless(os.name!="nt","Unix ELF host installation fixture")
    def test_standalone_linux_host_is_copied_exactly_without_shell_argument_rewrite(self):
        path=NATIVE/"Extensions/install_native_host.py"
        spec=importlib.util.spec_from_file_location("gd_elf_installer_fixture",path);installer=importlib.util.module_from_spec(spec);spec.loader.exec_module(installer)
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();binary=root/"GeneratedNativeHost";data=b"\x7fELF"+b"public test-only binary fixture";binary.write_bytes(data);binary.chmod(0o700)
            with patch.dict(os.environ,{"XDG_STATE_HOME":str(root/"state")}):
                result=installer.install(platform="linux",home=root,helper=None,python=None,browser_ids={"chrome":"a"*32},vscode=True,host_executable=binary)
            installed=Path(result["host"]);self.assertEqual(installed.read_bytes(),data);self.assertEqual(installed.stat().st_mode&0o777,0o700)
            self.assertTrue(all(str(root) in p for p in result["manifests"]))

class PortableAppFormatTests(unittest.TestCase):
    def test_missing_atomic_temp_requires_fresh_absence_and_retains_uncertainty(self):
        for absent in (True,False):
            with self.subTest(absent=absent),tempfile.TemporaryDirectory() as td,patch.object(apps,'host',return_value=('linux','x86_64')):
                manager,prepared,_,_=self._handshake_fixture(td);control=prepared.directory/'control';lease_id='c'*32
                record=dict(schema=apps.SCHEMA,id=lease_id,state='uncertain',identity=prepared.identity)
                lease=control/('lease-'+lease_id+'.json');apps._write(lease,record);before=lease.read_bytes()
                temporary=control/('.private-'+('d'*32));private.write_private(temporary,b'{}');verify=private.verify
                def vanished(path):
                    if Path(path)==temporary:
                        if absent:temporary.unlink()
                        raise FileNotFoundError('private fixture text must never be logged')
                    return verify(path)
                with patch.object(private,'verify',vanished):
                    if absent:
                        rows=manager.leases();self.assertTrue(any(row['path']==str(temporary) and row['state']=='uncertain' for row in rows))
                    else:
                        with self.assertRaises(apps.PortableAppError) as caught:manager.leases()
                        diagnostic=caught.exception.diagnostic
                        self.assertEqual(diagnostic['entryKind'],'atomic-temp');self.assertEqual(diagnostic['operation'],'fresh-absence')
                        self.assertNotIn(str(Path(td)),json.dumps(diagnostic));self.assertNotIn('private fixture text',json.dumps(diagnostic))
                    for uncertain_only in (False,True):
                        with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
                self.assertEqual(lease.read_bytes(),before)
    @unittest.skipUnless(sys.platform=='win32','Actual Windows native ACL lookup/publication race required')
    def test_windows_native_security_disappearance_keeps_atomic_uncertainty_and_final_bytes(self):
        import pywintypes
        with tempfile.TemporaryDirectory(prefix='gd-native-acl-race-') as td,patch.object(apps,'host',return_value=('linux','x86_64')):
            manager,prepared,_,_=self._handshake_fixture(td);control=prepared.directory/'control';lease_id='c'*32
            old=dict(schema=apps.SCHEMA,id=lease_id,state='uncertain',identity=prepared.identity,publication=1)
            new=dict(old,publication=2);lease=control/('lease-'+lease_id+'.json');apps._write(lease,old)
            temporary=control/('.private-'+('d'*32));private.write_private(temporary,json.dumps(new).encode())
            security=private._windows()[0][-1];native=security.GetFileSecurity
            ready=threading.Event();release=threading.Event();rows=[];errors=[];observed=[]
            def lookup(path,flags):
                if threading.current_thread() is reader and Path(path)==temporary:
                    ready.set()
                    if not release.wait(10):raise AssertionError('Generated native ACL reader was not released')
                    try:return native(path,flags)
                    except pywintypes.error as error:observed.append((type(error),error.args[:2]));raise
                return native(path,flags)
            def scan():
                try:rows.extend(manager.leases())
                except BaseException as error:errors.append(type(error).__name__)
            reader=threading.Thread(target=scan)
            with patch.object(security,'GetFileSecurity',lookup):
                reader.start()
                try:
                    self.assertTrue(ready.wait(5));apps._replace_windows_record(temporary,lease)
                finally:release.set();reader.join(5)
            self.assertFalse(reader.is_alive());self.assertEqual(errors,[])
            self.assertEqual(observed,[(pywintypes.error,(2,'GetFileSecurity'))])
            self.assertFalse(temporary.exists());self.assertEqual(apps._read(lease),new)
            self.assertTrue(any(row['path']==str(temporary) and row['state']=='uncertain' for row in rows))
            for uncertain_only in (False,True):
                with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
    @unittest.skipUnless(sys.platform=='win32','Actual Windows native exception provenance and private ACLs required')
    def test_windows_atomic_missing_allowlist_rejects_present_final_and_security_failures(self):
        import pywintypes
        for fault in ('present-temp','final-record','lookalike-name','wrong-type','wrong-api','code-3','code-5','unsafe-acl','hardlink'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory(prefix='gd-acl-negative-') as td,patch.object(apps,'host',return_value=('linux','x86_64')):
                manager,prepared,_,_=self._handshake_fixture(td);control=prepared.directory/'control';lease_id='c'*32
                record=dict(schema=apps.SCHEMA,id=lease_id,state='uncertain',identity=prepared.identity)
                lease=control/('lease-'+lease_id+'.json');apps._write(lease,record);before=lease.read_bytes()
                target=lease if fault=='final-record' else control/('.private-'+('X'*32 if fault=='lookalike-name' else 'd'*32))
                if target!=lease:private.write_private(target,b'{}')
                modules,sid,*_=private._windows();security=modules[-1];native=security.GetFileSecurity
                if fault=='hardlink':os.link(target,Path(td)/'owned-hardlink')
                if fault=='unsafe-acl':
                    acl=security.ACL();acl.AddAccessAllowedAceEx(security.ACL_REVISION,0,0x1f01ff,sid())
                    acl.AddAccessAllowedAceEx(security.ACL_REVISION,0,0x120089,security.CreateWellKnownSid(security.WinWorldSid,None))
                    security.SetNamedSecurityInfo(str(target),security.SE_FILE_OBJECT,
                        security.DACL_SECURITY_INFORMATION|security.PROTECTED_DACL_SECURITY_INFORMATION,None,None,acl,None)
                def denied(path,flags):
                    if Path(path)==target:
                        if fault in ('present-temp','final-record','lookalike-name'):return native(str(Path(td)/'absent-native-fixture'),flags)
                        if fault=='wrong-type':raise PermissionError(2,'GetFileSecurity','private fixture text')
                        if fault in ('code-3','code-5'):raise pywintypes.error(int(fault[-1]),'GetFileSecurity','private fixture text')
                        if fault=='wrong-api':raise pywintypes.error(2,'UnlistedFixtureAPI','private fixture text')
                    return native(path,flags)
                with patch.object(security,'GetFileSecurity',denied):
                    with self.assertRaises(apps.PortableAppError) as caught:manager.leases()
                    diagnostic=getattr(caught.exception,'diagnostic',{})
                    self.assertNotIn(str(Path(td)),json.dumps(diagnostic));self.assertNotIn('private fixture text',json.dumps(diagnostic))
                    if fault in ('wrong-type','wrong-api','code-3','code-5'):self.assertEqual(diagnostic['operation'],'private-acl')
                    for uncertain_only in (False,True):
                        with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
                self.assertEqual(lease.read_bytes(),before);self.assertTrue(target.exists())
    def _handshake_fixture(self,directory):
        manager=apps.PortableApps(Path(directory).resolve()/'cache');binding=apps.identity(OWNER,NOTE,item())
        raw=bytearray(64);raw[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',raw,16,2,62);struct.pack_into('<Q',raw,24,0x400000)
        records=[dict(path='.',type='file',size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),executable=0o100)]
        def restore(content):
            payload=content/'generated-fixture';private.write_private(payload,raw);return payload,records
        class PendingBroker:
            def poll(self):return None
        return manager,manager.prepare(binding,restore),bytes(raw),PendingBroker()
    def test_launch_handshake_discards_changed_identity_then_reads_fresh_verified_receipt(self):
        with tempfile.TemporaryDirectory() as td,patch.object(apps,'host',return_value=('linux','x86_64')):
            manager,prepared,raw,broker=self._handshake_fixture(td);original=apps._open_record;opened=[];replaced=[]
            def changed(path,**options):
                if Path(path).name.startswith('lease-'):
                    opened.append(Path(path))
                    if not replaced:
                        record=json.loads(Path(path).read_bytes());record.update(state='running',publication=2)
                        apps._write(Path(path),record);replaced.append(Path(path))
                return original(path,**options)
            with patch.object(apps,'_open_record',changed),patch.object(apps.subprocess,'Popen',return_value=broker),patch.object(apps.time,'sleep') as pause:
                receipt=manager.launch(prepared,'.',approved=True)
            self.assertEqual(len(replaced),1);self.assertEqual(len(opened),2);pause.assert_called_once_with(.025)
            self.assertEqual(receipt['state'],'running');self.assertEqual(receipt['publication'],2)
            self.assertEqual(apps._read(replaced[0]),receipt);self.assertEqual(prepared.payload.read_bytes(),raw)
    def test_launch_handshake_never_retries_unrecognized_corrupt_or_unsafe_records(self):
        for fault in ('unrecognized-code','extra-diagnostic-field','corrupt-json','hardlinked-record'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as td,patch.object(apps,'host',return_value=('linux','x86_64')):
                manager,prepared,raw,broker=self._handshake_fixture(td);original=apps._read;reads=[];leases=[]
                diagnostic=dict(stage='record-open-identity',errorCode='record_identity_changed',errorType='PortableAppError')
                if fault=='unrecognized-code':diagnostic['errorCode']='unrecognized_fixture'
                elif fault=='extra-diagnostic-field':diagnostic['extra']='fixture'
                unknown=apps.PortableAppError('Unrecognized fixture error');unknown.diagnostic=diagnostic
                def started(command,**options):
                    spec=json.loads(Path(command[-1]).read_bytes());lease=Path(spec['lease']);leases.append(lease)
                    if fault=='corrupt-json':private.write_private(lease,b'{',replace=True)
                    elif fault=='hardlinked-record':os.link(lease,lease.with_name('generated-hardlink'))
                    return broker
                def read(path):
                    if Path(path).name.startswith('lease-'):
                        reads.append(Path(path))
                        if fault in ('unrecognized-code','extra-diagnostic-field'):raise unknown
                    return original(path)
                expected=json.JSONDecodeError if fault=='corrupt-json' else apps.PortableAppError
                with patch.object(apps,'_read',read),patch.object(apps.subprocess,'Popen',started),patch.object(apps.time,'sleep') as pause:
                    with self.assertRaises(expected) as caught:manager.launch(prepared,'.',approved=True)
                if fault in ('unrecognized-code','extra-diagnostic-field'):self.assertIs(caught.exception,unknown)
                self.assertEqual(len(reads),1);pause.assert_not_called();self.assertTrue(leases[0].exists())
                self.assertEqual(prepared.payload.read_bytes(),raw)
                for uncertain_only in (False,True):
                    with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
    def test_launch_handshake_persistent_identity_churn_reaches_deadline_and_retains_uncertainty(self):
        with tempfile.TemporaryDirectory() as td,patch.object(apps,'host',return_value=('linux','x86_64')):
            manager,prepared,raw,broker=self._handshake_fixture(td);original=apps._open_record;opened=[]
            def changed(path,**options):
                if Path(path).name.startswith('lease-'):
                    opened.append(Path(path));record=json.loads(Path(path).read_bytes());record['publication']=len(opened)
                    apps._write(Path(path),record)
                return original(path,**options)
            with patch.object(apps,'_open_record',changed),patch.object(apps.subprocess,'Popen',return_value=broker),patch.object(apps.time,'monotonic',side_effect=range(12)),patch.object(apps.time,'sleep') as pause:
                with self.assertRaises(apps.PortableAppError) as caught:manager.launch(prepared,'.',approved=True)
            self.assertEqual(caught.exception.diagnostic['leaseState'],'uncertain');self.assertGreaterEqual(len(opened),2);self.assertLessEqual(len(opened),10)
            self.assertGreaterEqual(pause.call_count,1);self.assertLessEqual(pause.call_count,10)
            self.assertEqual(len(set(opened)),1);self.assertEqual(apps._read(opened[0])['state'],'pending')
            self.assertEqual(prepared.payload.read_bytes(),raw);self.assertTrue(opened[0].exists())
            for uncertain_only in (False,True):
                with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
    def test_record_identity_mismatch_retains_rejection_and_only_fixed_diagnostics(self):
        with tempfile.TemporaryDirectory() as td:
            root=private.private_directory(Path(td).resolve()/'control');record=root/'lease-fixture.json';apps._write(record,dict(generation='old fixture'))
            original=apps._open_record
            def changed(path,**options):
                if Path(path)==record:apps._write(record,dict(generation='new fixture'))
                return original(path,**options)
            with patch.object(apps,'_open_record',changed):
                with self.assertRaises(apps.PortableAppError) as caught:apps._read(record)
            self.assertEqual(caught.exception.diagnostic,dict(stage='record-open-identity',errorCode='record_identity_changed',errorType='PortableAppError'))
            self.assertNotIn(str(root),json.dumps(caught.exception.diagnostic));self.assertEqual(apps._read(record),dict(generation='new fixture'))
    @unittest.skipUnless(sys.platform=='win32','Actual Windows retained-record sharing behavior required')
    def test_windows_held_receipt_reader_allows_atomic_replace_and_preserves_old_and_new_bytes(self):
        with tempfile.TemporaryDirectory(prefix='gd-json-reader-') as td:
            root=private.private_directory(Path(td).resolve()/'control');lease=root/'lease-fixture.json'
            old=dict(generation='old disposable JSON',number=1);new=dict(generation='new disposable JSON',number=2)
            apps._write(lease,old)
            # Reproduce the actual CRT denial first, using only generated JSON.
            fd=os.open(lease,os.O_RDONLY|os.O_BINARY|os.O_NOINHERIT)
            try:
                with self.assertRaises(PermissionError):private.write_private(lease,json.dumps(new).encode(),replace=True)
            finally:os.close(fd)
            self.assertEqual(apps._read(lease),old)
            ready=threading.Event();release=threading.Event();result=[];errors=[];inheritable=[];load=apps.json.load
            def stalled(source):
                inheritable.append(os.get_inheritable(source.fileno()));ready.set()
                if not release.wait(10):raise AssertionError('Fixture reader release timed out')
                return load(source)
            def read():
                try:result.append(apps._read(lease))
                except BaseException as error:errors.append(type(error).__name__)
            with patch.object(apps.json,'load',stalled):
                reader=threading.Thread(target=read);reader.start()
                try:
                    self.assertTrue(ready.wait(5));apps._write(lease,new)
                    with lease.open('rb') as source:self.assertEqual(load(source),new)
                finally:release.set();reader.join(5)
            self.assertFalse(reader.is_alive());self.assertEqual(errors,[]);self.assertEqual(inheritable,[False])
            self.assertEqual(result,[old]);self.assertEqual(apps._read(lease),new);private.verify(lease)
    def test_stalled_atomic_receipt_writer_keeps_status_readable_and_both_guards_blocked(self):
        with tempfile.TemporaryDirectory() as td:
            manager=apps.PortableApps(Path(td).resolve()/'cache');binding=apps.identity(OWNER,NOTE,item())
            control=private.private_directory(manager.root/OWNER/NOTE/apps.generation(binding)/('b'*32)/'control');lease_id='c'*32
            lease=control/('lease-'+lease_id+'.json');record=dict(schema=apps.SCHEMA,id=lease_id,state='running',identity=binding,brokerPid=123,brokerIdentity='fixture-live')
            apps._write(lease,record);ready=threading.Event();release=threading.Event();errors=[];temporary=[]
            publisher=apps if os.name=='nt' else private.os;method='_replace_windows_record' if os.name=='nt' else 'replace';replace=getattr(publisher,method)
            def stalled(source,destination):
                if Path(destination)==lease:
                    temporary.append(Path(source));ready.set()
                    if not release.wait(5):raise AssertionError('Fixture writer release timed out')
                return replace(source,destination)
            def write():
                try:apps._write(lease,dict(record,state='complete',mainExitCode=7))
                except BaseException as error:errors.append(type(error).__name__)
            with patch.object(publisher,method,stalled),patch.object(apps,'process_identity',return_value='fixture-live'):
                writer=threading.Thread(target=write);writer.start()
                try:
                    self.assertTrue(ready.wait(3));self.assertTrue(temporary[0].exists());private.verify(temporary[0])
                    rows=manager.leases();self.assertEqual(rows[0]['state'],'running');self.assertTrue(any(row['state']=='uncertain' for row in rows))
                    for uncertain_only in (False,True):
                        with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
                    # Complete the real stalled publication after enumeration,
                    # then let the actual metadata lookup observe its absence.
                    real=apps._real;reader=threading.current_thread()
                    def vanished(path):
                        if threading.current_thread() is reader and Path(path)==temporary[0]:
                            release.set();writer.join(3)
                            self.assertFalse(writer.is_alive());self.assertEqual(errors,[])
                        return real(path)
                    with patch.object(apps,'_real',vanished):
                        rows=manager.leases();self.assertEqual(rows[0]['state'],'complete')
                        self.assertTrue(any(row['state']=='uncertain' and row['path']==str(temporary[0]) for row in rows))
                finally:release.set();writer.join(3)
            self.assertFalse(writer.is_alive());self.assertEqual(errors,[])
            self.assertEqual(manager.leases()[0]['state'],'complete');self.assertFalse(temporary[0].exists());manager.assert_safe('change accounts')
    def test_private_fixed_diagnostic_survives_unreplaceable_lease_without_raw_error_text(self):
        with tempfile.TemporaryDirectory() as td:
            manager=apps.PortableApps(Path(td).resolve()/'cache');binding=apps.identity(OWNER,NOTE,item())
            raw=bytearray(64);raw[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',raw,16,2,62);struct.pack_into('<Q',raw,24,0x400000)
            records=[dict(path='.',type='file',size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),executable=0o100)]
            def restore(directory):
                path=directory/'portable';private.write_private(path,raw);return path,records
            with patch.object(apps,'host',return_value=('linux','x86_64')):prepared=manager.prepare(binding,restore)
            control=prepared.directory/'control';launch_id='c'*32;lease=control/('lease-'+launch_id+'.json');spec=control/('launch-'+launch_id+'.json')
            apps._write(lease,dict(schema=apps.SCHEMA,id=launch_id,state='pending',identity=binding))
            apps._write(spec,dict(schema=apps.SCHEMA,lease=str(lease),payload=str(prepared.payload),records=records,selected='.',identity=binding))
            original=apps._write
            def locked(path,value):
                if path==lease:
                    error=PermissionError(13,'DO_NOT_LOG_RAW_ERROR rxca_'+'Q'*43);error.winerror=32;raise error
                return original(path,value)
            with patch.object(apps,'host',return_value=('linux','x86_64')),patch.object(apps,'process_identity',return_value='fixture-identity'),patch.object(apps,'_write',side_effect=locked):
                self.assertEqual(apps.broker(spec),1)
            diagnostic=apps._read(control/('diagnostic-'+launch_id+'.json'))
            self.assertEqual(diagnostic,dict(stage='receipt-owner',errorType='PermissionError',errno=13,winerror=32))
            self.assertNotIn('DO_NOT_LOG',json.dumps(diagnostic));self.assertNotIn('rxca_',json.dumps(diagnostic))
            child=type('Child',(),{'poll':lambda self:1})()
            failure=apps._launch_failure(lease,child)
            self.assertEqual(failure.diagnostic['winerror'],32);self.assertEqual(failure.diagnostic['brokerExitCode'],1)
            self.assertNotIn('winerror',str(failure),'Product error copy stays separate from CI diagnostics')
            with self.assertRaises(apps.PortableAppError):manager.assert_safe('change accounts')
    def test_fixed_diagnostic_does_not_accept_untrusted_stage_or_exception_values(self):
        error=ValueError('private path and raw details');error.errno='private';error.winerror=True
        self.assertEqual(apps._failure('untrusted private stage',error),dict(stage='unreported',errorType='ValueError'))
    def test_external_environment_excludes_bundle_paths_and_runtime_or_account_secrets(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();bundle=root/'bundle';outside=root/'system-bin'
            environment={'PATH':os.pathsep.join((str(bundle),str(bundle/'dlls'),str(outside))),'LD_LIBRARY_PATH':str(bundle),'LD_LIBRARY_PATH_ORIG':'private-test-value','GD_TOKEN':'not-a-real-token','RSX_LIB':'private-test-path','HOME':str(root)}
            with patch.dict(os.environ,environment,clear=True),patch.object(apps.sys,'_MEIPASS',str(bundle),create=True):
                actual=apps._environment()
            self.assertEqual(actual,{'PATH':str(outside),'HOME':str(root)})
    def test_ui_reports_nonzero_main_exit_separately_from_child_completion(self):
        from gendragoon_gui import GenDragoonGUI
        class Status:
            def set(self,value):self.value=value
        app=GenDragoonGUI.__new__(GenDragoonGUI);app.status=Status();app.portable_lease_state=None
        app.show_portable_status(dict(state='running',mainExitCode=7))
        self.assertIn('exited with code 7',app.status.value);self.assertIn('children are still tracked',app.status.value)
        app.show_portable_status(dict(state='complete',mainExitCode=7))
        self.assertIn('exited with code 7',app.status.value);self.assertIn('every tracked child has exited',app.status.value)
    def test_unreadable_lease_directory_blocks_both_guard_modes(self):
        with tempfile.TemporaryDirectory() as td:
            manager=apps.PortableApps(Path(td).resolve()/'cache')
            control=private.private_directory(manager.root/OWNER/NOTE/('a'*64)/('b'*32)/'control');original=Path.iterdir
            def denied(path):
                if path==control:raise PermissionError('generated fixture scan is inaccessible')
                return original(path)
            with patch.object(Path,'iterdir',denied):
                for uncertain_only in (False,True):
                    with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
    @unittest.skipIf(os.name=='nt','Portable symlink rejection is also checked by the Windows reparse verifier')
    def test_linked_cache_parent_is_rejected_before_creating_any_content(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();outside=root/'outside';outside.mkdir();link=root/'linked';link.symlink_to(outside,target_is_directory=True)
            manager=apps.PortableApps(link/'cache')
            with patch.object(apps,'host',return_value=('linux','x86_64')):
                with self.assertRaises(apps.PortableAppError):manager.prepare(apps.identity(OWNER,NOTE,item()),lambda directory:self.fail('Linked cache must fail before restore'))
            self.assertEqual(list(outside.iterdir()),[])
    def test_binary_magic_architecture_and_dll_script_installer_rejection(self):
        with tempfile.TemporaryDirectory() as td:
            root=private.private_directory(Path(td).resolve()/'cache');binary=root/'misleading.exe'
            elf=bytearray(64);elf[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',elf,16,2,62);struct.pack_into('<Q',elf,24,0x400000)
            private.write_private(binary,elf)
            self.assertEqual(apps.binary_kind(binary),('linux','x86_64'))
            elf[7]=9;binary.write_bytes(elf);self.assertIsNone(apps.binary_kind(binary),'FreeBSD is not Linux')
            elf[7]=0;elf[5]=2;binary.write_bytes(elf);self.assertIsNone(apps.binary_kind(binary),'Big-endian x86_64 is not a matching host binary')
            elf[5]=1
            struct.pack_into('<H',elf,18,183);binary.write_bytes(elf);self.assertEqual(apps.binary_kind(binary),('linux','arm64'))
            for raw in (b'#!/bin/sh\nexit 0\n',b'PK\x03\x04installer.msix',b'\xd0\xcf\x11\xe0installer.msi',b'MZtruncated'):
                binary.write_bytes(raw);self.assertIsNone(apps.binary_kind(binary))
            pe=bytearray(256);pe[:2]=b'MZ';struct.pack_into('<I',pe,60,64);pe[64:68]=b'PE\0\0';struct.pack_into('<HH',pe,68,0x8664,1);struct.pack_into('<HH',pe,84,112,2);struct.pack_into('<H',pe,88,0x20b);struct.pack_into('<H',pe,156,3)
            binary.write_bytes(pe);self.assertEqual(apps.binary_kind(binary),('windows','x86_64'))
            struct.pack_into('<H',pe,86,0x2002);binary.write_bytes(pe);self.assertIsNone(apps.binary_kind(binary),'DLL is not a selected executable')
    def test_cache_generation_binding_full_tree_tamper_and_explicit_selection(self):
        with tempfile.TemporaryDirectory() as td:
            manager=apps.PortableApps(Path(td).resolve()/'apps');binding=apps.identity(OWNER,NOTE,item())
            raw=bytearray(64);raw[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',raw,16,2,62);struct.pack_into('<Q',raw,24,0x400000)
            records=[dict(path='.',type='file',size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),executable=0o100)]
            def restore(directory):
                path=directory/'portable';private.write_private(path,raw);return path,records
            with patch.object(apps,'host',return_value=('linux','x86_64')):
                prepared=manager.prepare(binding,restore)
                if sys.platform=='win32':self.assertEqual(apps._binding(prepared.directory.parent),binding)
                else:self.assertIn(OWNER,str(prepared.directory));self.assertIn(NOTE,str(prepared.directory))
                self.assertIn(apps.generation(binding),str(prepared.directory))
                for selected,approved in (('.',False),('../escape',True)):
                    with self.assertRaises(apps.PortableAppError):manager.launch(prepared,selected,approved=approved)
                prepared.payload.write_bytes(b'changed')
                with self.assertRaises(apps.PortableAppError):manager.launch(prepared,'.',approved=True)
                self.assertTrue(prepared.payload.exists())
                other=apps.identity('f'*64,NOTE,item());second=manager.prepare(other,restore)
                self.assertNotEqual(prepared.directory.parent,second.directory.parent)
                replacement=manager.prepare(dict(binding,archiveSha256='f'*64),restore)
                self.assertNotEqual(prepared.directory.parent,replacement.directory.parent)
                self.assertTrue(prepared.payload.exists());self.assertTrue(second.payload.exists())
    def test_compact_windows_generation_has_immutable_full_binding_and_separate_generations(self):
        with tempfile.TemporaryDirectory() as td:
            manager=apps.PortableApps(Path(td).resolve()/'cache');binding=apps.identity(OWNER,NOTE,item())
            raw=bytearray(64);raw[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',raw,16,2,62);struct.pack_into('<Q',raw,24,0x400000)
            records=[dict(path='.',type='file',size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),executable=0o100)]
            def restore(directory):
                path=directory/'portable';private.write_private(path,raw);return path,records
            with patch.object(apps.sys,'platform','win32'),patch.object(apps,'host',return_value=('linux','x86_64')):
                value=apps.uuid.UUID('00112233445546778899aabbccddeeff')
                with patch.object(apps.uuid,'uuid4',return_value=value):first=manager.prepare(binding,restore)
                self.assertEqual(len(first.directory.name),22);self.assertEqual(base64.urlsafe_b64decode(first.directory.name+'=='),value.bytes)
                self.assertTrue(apps._canonical_attempt(first.directory.name))
                record=first.directory.parent/'binding.json';before=record.read_bytes()
                self.assertEqual(first.directory.parent,manager.root/apps.WINDOWS_LAYOUT/apps.generation(binding))
                self.assertEqual(apps._read(record),dict(schema=apps.SCHEMA,layout=apps.WINDOWS_LAYOUT,identity=binding))
                second=manager.prepare(binding,restore)
                self.assertEqual(first.directory.parent,second.directory.parent);self.assertNotEqual(first.directory,second.directory)
                self.assertEqual(record.read_bytes(),before)
                for field in binding:
                    changed=dict(binding);changed[field]='f'*len(binding[field])
                    other=manager.prepare(changed,restore)
                    self.assertNotEqual(first.directory.parent,other.directory.parent,field)
                    self.assertEqual(apps._binding(other.directory.parent),changed)
                # A pre-upgrade uncertain lease remains authoritative beside
                # new compact generations on every platform's inventory scan.
                control=private.private_directory(manager.root/OWNER/NOTE/apps.generation(binding)/('b'*32)/'control');lease_id='c'*32
                legacy=control/('lease-'+lease_id+'.json');apps._write(legacy,dict(schema=apps.SCHEMA,id=lease_id,state='uncertain',identity=binding))
                for uncertain_only in (False,True):
                    with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
                with self.assertRaises(apps.PortableAppError):manager.prepare(binding,lambda _:self.fail('Legacy uncertainty must stop restore'))
                with self.assertRaises(apps.PortableAppError):manager.launch(first,'.',approved=True)
                self.assertTrue(legacy.exists())
                self.assertTrue(first.payload.exists());self.assertTrue(second.payload.exists())
    def test_windows_attempt_creation_never_adopts_existing_or_case_colliding_uuid_cache(self):
        first=apps.uuid.UUID('00112233445546778899aabbccddeeff')
        folded=apps.uuid.UUID(bytes=bytes([104])+first.bytes[1:])
        names=[base64.urlsafe_b64encode(value.bytes).decode().rstrip('=') for value in (first,folded)]
        self.assertNotEqual(names[0],names[1]);self.assertEqual(names[0].casefold(),names[1].casefold())
        for other in ((first,folded) if os.name=='nt' else (first,)):
            with self.subTest(case_alias=other!=first),tempfile.TemporaryDirectory() as td:
                manager=apps.PortableApps(Path(td).resolve()/'cache');binding=apps.identity(OWNER,NOTE,item())
                raw=bytearray(64);raw[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',raw,16,2,62);struct.pack_into('<Q',raw,24,0x400000)
                def restore(directory):
                    payload=directory/'portable';private.write_private(payload,raw)
                    return payload,[dict(path='.',type='file',size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),executable=0o100)]
                with patch.object(apps.sys,'platform','win32'),patch.object(apps,'host',return_value=('linux','x86_64')):
                    with patch.object(apps.uuid,'uuid4',return_value=first):prepared=manager.prepare(binding,restore)
                    before=(prepared.directory.parent/'binding.json').read_bytes()
                    with patch.object(apps.uuid,'uuid4',return_value=other):
                        with self.assertRaisesRegex(apps.PortableAppError,'retained'):manager.prepare(binding,lambda _:self.fail('An existing attempt must never be restored over'))
                    self.assertEqual(prepared.payload.read_bytes(),raw);self.assertEqual((prepared.directory.parent/'binding.json').read_bytes(),before)
    def test_legacy_v1_and_v2_uncertain_leases_independently_block_all_new_layout_actions(self):
        for layout in ('legacy','v1','v2'):
            with self.subTest(layout=layout),tempfile.TemporaryDirectory() as td:
                manager=apps.PortableApps(Path(td).resolve()/'cache');binding=apps.identity(OWNER,NOTE,item())
                raw=bytearray(64);raw[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',raw,16,2,62);struct.pack_into('<Q',raw,24,0x400000)
                def restore(directory):
                    payload=directory/'portable';private.write_private(payload,raw)
                    return payload,[dict(path='.',type='file',size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),executable=0o100)]
                with patch.object(apps.sys,'platform','win32'),patch.object(apps,'host',return_value=('linux','x86_64')):
                    prepared=manager.prepare(binding,restore)
                    if layout=='legacy':attempt=manager.root/OWNER/NOTE/apps.generation(binding)/('b'*32)
                    elif layout=='v1':
                        parent=private.private_directory(manager.root/'v1'/apps.generation(binding));attempt=parent/('b'*32)
                        apps._write(parent/'binding.json',dict(schema=apps.SCHEMA,layout='v1',identity=binding))
                    else:attempt=prepared.directory
                    control=private.private_directory(attempt/'control');retained=control/('lease-'+('c'*32)+'.json')
                    apps._write(retained,dict(schema=apps.SCHEMA,id='c'*32,state='uncertain',identity=binding))
                    before=retained.read_bytes()
                    for uncertain_only in (False,True):
                        with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
                    with self.assertRaises(apps.PortableAppError):manager.prepare(binding,lambda _:self.fail('An old uncertain lease must stop restore'))
                    with self.assertRaises(apps.PortableAppError):manager.launch(prepared,'.',approved=True)
                    self.assertEqual(retained.read_bytes(),before);self.assertEqual(prepared.payload.read_bytes(),raw)
    def test_v1_v2_binding_and_attempt_names_are_strict_and_malformed_records_are_never_adopted(self):
        canonical=base64.urlsafe_b64encode(apps.uuid.UUID('00112233445546778899aabbccddeeff').bytes).decode().rstrip('=')
        for layout in ('v1','v2'):
            for fault in ('missing-binding','wrong-layout-binding','unknown-layout','wrong-attempt-width','noncanonical-attempt','unreadable-generation'):
                with self.subTest(layout=layout,fault=fault),tempfile.TemporaryDirectory() as td:
                    manager=apps.PortableApps(Path(td).resolve()/'cache');binding=apps.identity(OWNER,NOTE,item())
                    parent=private.private_directory(manager.root/('v3' if fault=='unknown-layout' else layout)/apps.generation(binding));record=parent/'binding.json'
                    if fault!='missing-binding':apps._write(record,dict(schema=apps.SCHEMA,layout=('v2' if layout=='v1' else 'v1') if fault=='wrong-layout-binding' else layout,identity=binding))
                    name='b'*32 if layout=='v1' else canonical
                    if fault=='wrong-attempt-width':name=canonical if layout=='v1' else 'b'*32
                    elif fault=='noncanonical-attempt':name='B'*32 if layout=='v1' else canonical[:-1]+'B'
                    control=private.private_directory(parent/name/'control')
                    apps._write(control/('lease-'+('c'*32)+'.json'),dict(schema=apps.SCHEMA,id='c'*32,state='failed-before-start',identity=binding))
                    before=record.read_bytes() if record.exists() else None;original=Path.iterdir
                    def scan(path):
                        if fault=='unreadable-generation' and path==parent:raise PermissionError('fixture generation scan denied')
                        return original(path)
                    with patch.object(apps.sys,'platform','win32'),patch.object(apps,'host',return_value=('linux','x86_64')),patch.object(Path,'iterdir',scan):
                        for uncertain_only in (False,True):
                            with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
                        with self.assertRaises(apps.PortableAppError):manager.prepare(binding,lambda _:self.fail('A malformed layout must never be adopted'))
                    self.assertEqual(record.read_bytes() if record.exists() else None,before);self.assertTrue(control.exists())
    def test_compact_windows_binding_and_reserved_inventory_fail_closed_without_replacing_cache(self):
        for fault in ('missing-binding','changed-binding','unexpected-generation-entry','unexpected-attempt-entry','unreadable-generation'):
            with self.subTest(fault=fault),tempfile.TemporaryDirectory() as td:
                manager=apps.PortableApps(Path(td).resolve()/'cache');binding=apps.identity(OWNER,NOTE,item())
                raw=bytearray(64);raw[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',raw,16,2,62);struct.pack_into('<Q',raw,24,0x400000)
                def restore(directory):
                    path=directory/'portable';private.write_private(path,raw)
                    return path,[dict(path='.',type='file',size=len(raw),sha256=hashlib.sha256(raw).hexdigest(),executable=0o100)]
                with patch.object(apps.sys,'platform','win32'),patch.object(apps,'host',return_value=('linux','x86_64')):
                    prepared=manager.prepare(binding,restore);parent=prepared.directory.parent;record=parent/'binding.json'
                    if fault=='missing-binding':record.unlink()
                    elif fault=='changed-binding':
                        changed=dict(binding,workspaceId='f'*32)
                        apps._write(record,dict(schema=apps.SCHEMA,layout=apps.WINDOWS_LAYOUT,identity=changed))
                    elif fault=='unexpected-generation-entry':private.write_private(parent/'unexpected',b'fixture only')
                    elif fault=='unexpected-attempt-entry':private.write_private(prepared.directory/'unexpected',b'fixture only')
                    original=Path.iterdir
                    def scan(path):
                        if fault=='unreadable-generation' and path==parent:raise PermissionError('generated fixture inaccessible')
                        return original(path)
                    with patch.object(Path,'iterdir',scan),patch.object(apps.subprocess,'Popen',side_effect=AssertionError('No broker may start')):
                        for uncertain_only in (False,True):
                            with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
                        with self.assertRaises(apps.PortableAppError):manager.prepare(binding,lambda _:self.fail('Invalid generation must not be adopted'))
                        with self.assertRaises(apps.PortableAppError):manager.launch(prepared,'.',approved=True)
                    self.assertEqual(prepared.payload.read_bytes(),raw)
    def test_windows_working_directory_limit_counts_utf16_and_rejects_before_creating_a_lease(self):
        with tempfile.TemporaryDirectory() as td:
            manager=apps.PortableApps(Path(td).resolve()/'cache');binding=apps.identity(OWNER,NOTE,item())
            raw=bytearray(64);raw[:7]=b'\x7fELF\x02\x01\x01';struct.pack_into('<HH',raw,16,2,62);struct.pack_into('<Q',raw,24,0x400000)
            def restore(directory):
                payload=private.private_directory(directory/'deep portable app')
                for _ in range(5):payload=private.private_directory(payload/('nested-'+('x'*25)))
                binary=payload/'portable';private.write_private(binary,raw)
                root=directory/'deep portable app'
                return root,client.manifest(root)['manifest']
            with patch.object(apps.sys,'platform','win32'),patch.object(apps,'host',return_value=('linux','x86_64')):
                prepared=manager.prepare(binding,restore);selected=prepared.candidates[0]
                with patch.object(apps.subprocess,'Popen',side_effect=AssertionError('Long cwd must fail before a broker starts')):
                    with self.assertRaisesRegex(apps.PortableAppError,'working-directory limit'):manager.launch(prepared,selected,approved=True)
                self.assertEqual(manager.leases(),[]);self.assertTrue((prepared.payload/selected).exists())
                self.assertEqual(list((prepared.directory/'control').iterdir()),[])
                # A non-BMP character occupies two Windows WCHAR units.
                with self.assertRaisesRegex(apps.PortableAppError,'working-directory limit'):apps._check_working_directory(Path('/')/('📦'*130)/'fixture.exe')

NATIVE_PORTABLE_SOURCE=r'''
#ifdef _WIN32
#include <windows.h>
#else
#include <unistd.h>
#include <sys/types.h>
#endif
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static void pause_fixture(void) {
#ifdef _WIN32
Sleep(50);
#else
usleep(50000);
#endif
}
static void child_fixture(void) {
  FILE *f=fopen("child-started","wb");
  if(f){
#ifdef _WIN32
    fprintf(f,"%lu",(unsigned long)GetCurrentProcessId());
#else
    fprintf(f,"%ld",(long)getpid());
#endif
    fclose(f);
  }
#ifdef _WIN32
  wchar_t directory[32768];DWORD count=GetDllDirectoryW(32768,directory);
  f=fopen("child-dll-directory","wb");if(f){fprintf(f,"%lu",(unsigned long)count);fclose(f);}
#else
  f=fopen("child-ld-library-path","wb");if(f){const char *value=getenv("LD_LIBRARY_PATH");fputs(value?value:"",f);fclose(f);}
#endif
  for(int i=0;i<300;i++) {
    f=fopen("child-heartbeat","wb");if(f){fprintf(f,"%d",i);fclose(f);}
    f=fopen("release-child","rb");if(f){fclose(f);break;}pause_fixture();
  }
  f=fopen("child-finished","wb");if(f){fputs("finished",f);fclose(f);}
  f=fopen("hold-after-finished","rb");
  if(f){
    fclose(f);
    for(int i=0;i<300;i++) {
      f=fopen("release-finished-child","rb");if(f){fclose(f);break;}pause_fixture();
    }
  }
}
int main(int argc,char **argv) {
  if(argc>1 && !strcmp(argv[1],"--child")){child_fixture();return 0;}
#ifdef _WIN32
  char executable[32768],command[32800];GetModuleFileNameA(NULL,executable,sizeof(executable));snprintf(command,sizeof(command),"\"%s\" --child",executable);
  STARTUPINFOA startup={0};PROCESS_INFORMATION process={0};startup.cb=sizeof(startup);
  if(!CreateProcessA(executable,command,NULL,NULL,FALSE,CREATE_NEW_PROCESS_GROUP|DETACHED_PROCESS,NULL,NULL,&startup,&process)) {
    DWORD error=GetLastError();FILE *f=fopen("e","wb");
    if(f){fprintf(f,"%lu",(unsigned long)error);fclose(f);}return 2;
  }
  CloseHandle(process.hThread);CloseHandle(process.hProcess);
#else
  pid_t child=fork();if(child<0)return 2;
  if(child==0){setsid();pid_t grandchild=fork();if(grandchild<0)_exit(3);if(grandchild>0)_exit(0);child_fixture();_exit(0);}
#endif
  return 7; /* Deliberately distinguish main exit from child-tree completion. */
}
'''

def compile_portable_fixture(directory):
    """Compile only our disposable native program on the actual target OS."""
    source=Path(directory)/'fixture.c';source.write_text(NATIVE_PORTABLE_SOURCE)
    binary=Path(directory)/('fixture.exe' if sys.platform=='win32' else 'fixture')
    candidates=[shutil.which(name) for name in ('gcc','clang','cc')]
    if sys.platform=='win32':candidates.extend(str(path) for path in (Path('C:/mingw64/bin/gcc.exe'),Path('C:/ProgramData/chocolatey/bin/gcc.exe')) if path.is_file())
    errors=[]
    for compiler in dict.fromkeys(value for value in candidates if value):
        result=subprocess.run([compiler,'-O0',str(source),'-o',str(binary)],capture_output=True,text=True,timeout=60)
        if result.returncode==0:
            if apps.binary_kind(binary)!=apps.host():raise AssertionError('Fixture compiler did not generate a matching native executable')
            return binary
        errors.append(result.stderr[-1000:])
    raise AssertionError('An actual native C compiler is required for the portable process-tree tests: '+'; '.join(errors))

def wait_fixture(predicate,seconds=8):
    deadline=time.monotonic()+seconds
    while time.monotonic()<deadline:
        try:ready=predicate()
        except Exception as error:
            diagnostic=getattr(error,'diagnostic',None)
            if isinstance(diagnostic,dict) and diagnostic.get('stage')=='inventory-metadata':
                raise AssertionError('Disposable inventory diagnostics: '+json.dumps(fixture_error(error),sort_keys=True)) from None
            raise
        if ready:return
        time.sleep(.025)
    raise AssertionError('Disposable portable app condition was not confirmed')

def launch_native_fixture(action):
    try:return action()
    except apps.PortableAppError as error:
        raise AssertionError('Native broker fixed diagnostics: '+json.dumps(getattr(error,'diagnostic',{'stage':'unreported'}),sort_keys=True)) from None

def fixture_error(error):
    name=type(error).__name__;value=dict(errorType=name if name in apps.ERROR_TYPES|{'AssertionError','FileNotFoundError'} else 'Exception')
    for field in ('errno','winerror'):
        code=getattr(error,field,None)
        if type(code) is int and 0<=code<=0xffffffff:value[field]=code
    supplied=getattr(error,'diagnostic',{})
    if isinstance(supplied,dict) and supplied.get('stage')=='inventory-metadata':
        value['stage']='inventory-metadata'
        allowed={'entryKind':{'atomic-temp','lease','launch','diagnostic','binding','other'},'layout':{'legacy','v1','v2','unlisted'},
            'operation':{'path-metadata','private-acl','control-identity','fresh-absence','unlisted'},'nativeOperation':{'GetFileSecurity','unlisted'}}
        for field,choices in allowed.items():
            entry=supplied.get(field);value[field]=entry if type(entry) is str and entry in choices else 'unlisted'
        for field in ('pathUtf16Units','errno','winerror'):
            code=supplied.get(field)
            if type(code) is int and 0<=code<=(32768 if field=='pathUtf16Units' else 0xffffffff):value[field]=code
    return value

_NATIVE_FIXTURE_FAILED=False

@contextmanager
def native_fixture_directory(prefix='gd-native-app-'):
    """A failed fixture retains files instead of deleting a possibly-live app."""
    global _NATIVE_FIXTURE_FAILED
    directory=tempfile.TemporaryDirectory(prefix=prefix,delete=False)
    try:yield directory.name
    except BaseException:
        _NATIVE_FIXTURE_FAILED=True
        raise
    else:directory.cleanup()

def capture_fixture_process(pid,executable,expected_identity=None):
    """Hold only query/synchronize access to this exact generated process."""
    if type(pid) is not int or pid<=1:raise AssertionError('Invalid generated process identity')
    handle=None
    try:
        if sys.platform=='win32':
            import ctypes,win32api,win32event,win32process
            from ctypes import wintypes
            handle=win32api.OpenProcess(0x1000|0x100000,False,pid)
            kernel=ctypes.WinDLL('kernel32',use_last_error=True)
            kernel.QueryFullProcessImageNameW.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.LPWSTR,ctypes.POINTER(wintypes.DWORD)]
            kernel.QueryFullProcessImageNameW.restype=wintypes.BOOL
            buffer=ctypes.create_unicode_buffer(32768);size=wintypes.DWORD(len(buffer))
            if not kernel.QueryFullProcessImageNameW(int(handle),0,buffer,ctypes.byref(size)):raise ctypes.WinError(ctypes.get_last_error())
            actual=buffer.value;identity=str(win32process.GetProcessTimes(handle)['CreationTime'])
            if win32event.WaitForSingleObject(handle,0)!=258:raise AssertionError('Generated process was not running at capture')
        elif sys.platform.startswith('linux'):
            handle=os.pidfd_open(pid,0);identity=apps.process_identity(pid,required=True)
            actual=os.readlink('/proc/'+str(pid)+'/exe')
            if select.select([handle],[],[],0)[0]:raise AssertionError('Generated process was not running at capture')
        else:raise AssertionError('An actual Windows/Linux process is required')
        if (not identity or os.path.normcase(os.path.abspath(actual))!=os.path.normcase(os.path.abspath(executable))
                or expected_identity is not None and identity!=expected_identity
                or apps.process_identity(pid,required=True)!=identity):
            raise AssertionError('Generated process image or start identity did not match')
        return dict(pid=pid,identity=identity,handle=handle,windows=sys.platform=='win32',confirmedExited=False)
    except BaseException as error:
        if handle is not None:
            if sys.platform=='win32':handle.Close()
            else:os.close(handle)
        raise AssertionError('Disposable process capture diagnostics: '+json.dumps(fixture_error(error),sort_keys=True)) from None

def capture_fixture_child(prepared,name):
    raw=(prepared.payload/'child-started').read_bytes()
    if not re.fullmatch(rb'[0-9]{1,10}',raw):raise AssertionError('Generated child identity marker was invalid')
    return capture_fixture_process(int(raw),prepared.payload/name)

def fixture_process_exited(process):
    if process['confirmedExited']:return True
    if process['windows']:
        import win32event
        state=win32event.WaitForSingleObject(process['handle'],0)
        if state not in (0,258):raise AssertionError('Generated process exit could not be observed')
        exited=state==0
    else:exited=bool(select.select([process['handle']],[],[],0)[0])
    if exited:process['confirmedExited']=True
    return exited

def finish_native_fixture(manager,prepared,*,owned_child=None,owned_broker=None):
    """Release only the generated child, even when launch confirmation fails."""
    (prepared.payload/'release-child').write_text('release only this generated fixture')
    latest=[];inspection=None
    def finished():
        nonlocal latest,inspection
        try:
            rows=[row for row in manager.leases() if Path(row['path']).parent==prepared.directory/'control'];latest=rows
            exited=all(fixture_process_exited(process) for process in (owned_child,owned_broker) if process is not None)
            if not rows:return exited and not (prepared.payload/'child-started').exists() and not any((prepared.directory/'control').iterdir())
            if all(row['state'] in ('complete','failed-before-start') for row in rows):return exited
            if owned_child is None or owned_broker is None or not exited or not (prepared.payload/'child-finished').exists():return False
            leases=[row for row in rows if apps._inventory_kind(row['path'])=='lease']
            residues=[row for row in rows if apps._inventory_kind(row['path'])=='atomic-temp']
            return (bool(leases) and len(leases)+len(residues)==len(rows)
                and all(row['state']=='uncertain' and row.get('brokerPid')==owned_broker['pid']
                    and row.get('brokerIdentity')==owned_broker['identity'] for row in leases)
                and all(row['state']=='uncertain' for row in residues))
        except Exception as error:inspection=fixture_error(error);return False
    try:
        wait_fixture(finished,seconds=20);time.sleep(.15)
    except AssertionError:
        kinds={};states={}
        for row in latest:
            kind=apps._inventory_kind(row.get('path',''));state=row.get('state') if row.get('state') in ('pending','running','complete','failed-before-start','uncertain') else 'unlisted'
            kinds[kind]=min(100000,kinds.get(kind,0)+1);states[state]=min(100000,states.get(state,0)+1)
        process_state={}
        for label,process in (('child',owned_child),('broker',owned_broker)):
            process_state[label+'Known']=process is not None
            try:process_state[label+'Exited']=fixture_process_exited(process) if process is not None else False
            except Exception:process_state[label+'Exited']=False
        details=dict(stage='fixture-cleanup',rowKindCounts=kinds,rowStateCounts=states,
            childStarted=(prepared.payload/'child-started').exists(),childFinished=(prepared.payload/'child-finished').exists(),**process_state)
        if inspection is not None:details['inventoryFailure']=inspection
        raise AssertionError('Disposable cleanup diagnostics: '+json.dumps(details,sort_keys=True)) from None
    finally:
        for process in (owned_child,owned_broker):
            if process is not None and process['confirmedExited']:
                if process['windows']:process['handle'].Close()
                else:os.close(process['handle'])

def prepare_native_fixture(manager,binary):
    binding=apps.identity(OWNER,NOTE,item())
    def restore(directory):
        payload=private.private_directory(directory/'Disposable portable app');target=payload/binary.name;shutil.copyfile(binary,target)
        if os.name!='nt':target.chmod(0o700)
        private.protect_generated_tree(directory)
        return payload,client.manifest(payload)['manifest']
    return manager.prepare(binding,restore)

@unittest.skipUnless(sys.platform=='win32' or sys.platform.startswith('linux'),'Actual Windows/Linux process-tree lifecycle required')
class PortableAppLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture=tempfile.TemporaryDirectory(prefix='gd-native-portable-fixture-',delete=False);cls.binary=compile_portable_fixture(Path(cls.fixture.name).resolve())
    @classmethod
    def tearDownClass(cls):
        if not _NATIVE_FIXTURE_FAILED:cls.fixture.cleanup()
    @unittest.skipUnless(sys.platform=='win32','Actual Windows old/new working-directory length and native launch required')
    def test_windows_compact_cwd_native_launch_and_legacy_uncertainty_barrier(self):
        with native_fixture_directory(prefix='gd-app-cwd-') as td:
            manager=apps.PortableApps(Path(td).resolve()/'cache');prepared=prepare_native_fixture(manager,self.binary)
            binding=prepared.identity
            legacy=private.private_directory(manager.root/binding['receiverId']/binding['workspaceId']/apps.generation(binding)/('b'*32))
            legacy_payload=private.private_directory(legacy/'content'/'Disposable portable app')
            control=private.private_directory(legacy/'control');lease_id='c'*32
            lease=control/('lease-'+lease_id+'.json')
            # This is a terminal receipt for our own never-started legacy
            # fixture, not authority to clear an existing uncertain launch.
            apps._write(lease,dict(schema=apps.SCHEMA,id=lease_id,state='failed-before-start',identity=binding))
            v1_parent=private.private_directory(manager.root/'v1'/apps.generation(binding))
            apps._write(v1_parent/'binding.json',dict(schema=apps.SCHEMA,layout='v1',identity=binding))
            v1_attempt=private.private_directory(v1_parent/('d'*32));v1_payload=private.private_directory(v1_attempt/'content'/'Disposable portable app')
            v1_control=private.private_directory(v1_attempt/'control');apps._write(v1_control/('lease-'+('e'*32)+'.json'),dict(schema=apps.SCHEMA,id='e'*32,state='failed-before-start',identity=binding))
            old_units=len(str(legacy_payload).encode('utf-16-le'))//2
            new_units=len(str(prepared.payload).encode('utf-16-le'))//2
            v1_units=len(str(v1_payload).encode('utf-16-le'))//2
            print('Disposable Windows cwd UTF16 units: '+json.dumps(dict(legacy=old_units,v1=v1_units,compact=new_units),sort_keys=True),flush=True)
            self.assertEqual(v1_units-new_units,10);self.assertLessEqual(len(str(prepared.payload/self.binary.name).encode('utf-16-le'))//2,259)
            self.assertGreaterEqual(old_units,260);self.assertLessEqual(new_units,258)
            try:
                receipt=launch_native_fixture(lambda:manager.launch(prepared,self.binary.name,approved=True))
                wait_fixture(lambda:(prepared.payload/'child-started').exists())
                wait_fixture(lambda:any(row.get('id')==receipt['id'] and row.get('mainExitCode')==7 for row in manager.leases()))
                with self.assertRaises(apps.PortableAppError):manager.assert_safe('change accounts')
            finally:finish_native_fixture(manager,prepared)
            wait_fixture(lambda:any(row.get('id')==receipt['id'] and row['state']=='complete' for row in manager.leases()))
            # Add an independent historical unknown process after proving the
            # new launch. No missing PID can erase the old account barrier.
            apps._write(lease,dict(schema=apps.SCHEMA,id=lease_id,state='uncertain',identity=binding))
            for uncertain_only in (False,True):
                with self.assertRaises(apps.PortableAppError):manager.assert_safe('change protected state',uncertain_only=uncertain_only)
            with self.assertRaises(apps.PortableAppError):prepare_native_fixture(manager,self.binary)
            with self.assertRaises(apps.PortableAppError):manager.launch(prepared,self.binary.name,approved=True)
            self.assertTrue(lease.exists());self.assertTrue(legacy_payload.exists());self.assertTrue(v1_payload.exists());self.assertTrue((prepared.payload/self.binary.name).exists());self.assertTrue(self.binary.exists())
    def test_detached_grandchild_keeps_lease_after_parent_exit_and_all_cache_is_retained(self):
        with native_fixture_directory(prefix='gd-app-lease-') as td:
            manager=apps.PortableApps(Path(td).resolve()/'cache');prepared=prepare_native_fixture(manager,self.binary)
            try:
                receipt=launch_native_fixture(lambda:manager.launch(prepared,self.binary.name,approved=True))
                wait_fixture(lambda:(prepared.payload/'child-started').exists())
                wait_fixture(lambda:manager.leases()[0].get('mainExitCode')==7)
                self.assertEqual(manager.leases()[0]['state'],'running')
                self.assertEqual(manager.leases()[0]['mainExitCode'],7)
                with self.assertRaises(apps.PortableAppError):manager.assert_safe('change accounts')
                self.assertTrue(prepared.payload.exists())
            finally:finish_native_fixture(manager,prepared)
            wait_fixture(lambda:manager.leases()[0]['state']=='complete')
            self.assertEqual(manager.leases()[0]['mainExitCode'],7)
            manager.assert_safe('change accounts');self.assertTrue((prepared.payload/'child-finished').exists());self.assertTrue((prepared.payload/self.binary.name).exists());self.assertTrue(self.binary.exists())
            self.assertNotIn('storageSecret',json.dumps(manager.leases()));self.assertNotIn('rxca_',json.dumps(manager.leases()))
    def test_broker_failure_does_not_kill_app_children_and_uncertainty_blocks_changes(self):
        self._broker_failure_case()
    @unittest.skipUnless(sys.platform=='win32','Actual Windows orphaned atomic receipt and owned process exit required')
    def test_windows_broker_failure_atomic_residue_waits_for_owned_child_exit(self):
        self._broker_failure_case(residue=True)
    def _broker_failure_case(self,*,residue=False):
        with native_fixture_directory(prefix='gd-app-orphan-') as td:
            manager=apps.PortableApps(Path(td).resolve()/'cache');prepared=prepare_native_fixture(manager,self.binary)
            owned_child=owned_broker=None;retained=None;preserved={}
            try:
                receipt=launch_native_fixture(lambda:manager.launch(prepared,self.binary.name,approved=True))
                wait_fixture(lambda:(prepared.payload/'child-heartbeat').exists())
                owned_child=capture_fixture_child(prepared,self.binary.name)
                owned_broker=capture_fixture_process(receipt['brokerPid'],Path(sys.executable).resolve(),receipt['brokerIdentity'])
                # Only the broker created by this disposable fixture is stopped.
                import signal
                self.assertEqual(apps.process_identity(receipt['brokerPid'],required=True),owned_broker['identity'])
                os.kill(receipt['brokerPid'],signal.SIGTERM if sys.platform=='win32' else signal.SIGKILL)
                wait_fixture(lambda:fixture_process_exited(owned_broker))
                wait_fixture(lambda:manager.leases()[0]['state']=='uncertain')
                if residue:
                    # Deterministically model the owned atomic leaf a stopped
                    # broker may retain. This does not identify the CI incident.
                    control=prepared.directory/'control';lease=control/('lease-'+receipt['id']+'.json')
                    def retained_inventory():
                        rows=manager.leases();kinds={}
                        for row in rows:
                            kind=apps._inventory_kind(row['path']);kinds[kind]=kinds.get(kind,0)+1
                        details='Disposable residue inventory counts: '+json.dumps(dict(rowCount=len(rows),rowKindCounts=kinds),sort_keys=True)
                        self.assertEqual(len({row['path'] for row in rows}),len(rows),details)
                        self.assertTrue(all(Path(row['path']).parent==control and row['state']=='uncertain'
                            and apps._inventory_kind(row['path']) in ('lease','atomic-temp') for row in rows),details)
                        leases=[row for row in rows if apps._inventory_kind(row['path'])=='lease']
                        self.assertEqual(len(leases),1,details);current=leases[0]
                        self.assertTrue(Path(current['path'])==lease and current.get('id')==receipt['id']
                            and current.get('identity')==prepared.identity and current.get('brokerPid')==owned_broker['pid']
                            and current.get('brokerIdentity')==owned_broker['identity'],'Disposable residue lease binding changed')
                        return {Path(row['path']):row for row in rows}
                    prior=retained_inventory()
                    for path in prior:
                        raw=path.read_bytes();preserved[path]=(raw,hashlib.sha256(raw).hexdigest())
                    retained=control/('.private-'+apps.uuid.uuid4().hex)
                    private.write_private(retained,b'{"fixture":"interrupted publication"}')
                    (prepared.payload/'hold-after-finished').write_text('Only this generated fixture waits after its marker')
                    self.assertTrue(set(retained_inventory())==set(prior)|{retained},'Disposable residue inventory changed beyond the generated leaf')
                    raw=retained.read_bytes();preserved[retained]=(raw,hashlib.sha256(raw).hexdigest())
                before=(prepared.payload/'child-heartbeat').read_text();time.sleep(.2)
                self.assertNotEqual((prepared.payload/'child-heartbeat').read_text(),before,'The broker failure must leave the native child running')
                for uncertain_only in (False,True):
                    with self.assertRaises(apps.PortableAppError):manager.assert_safe('delete library items',uncertain_only=uncertain_only)
                self.assertTrue(prepared.payload.exists())
            finally:
                if residue and retained is not None and owned_child is not None and owned_broker is not None:
                    failures=[];finished=threading.Event()
                    def clean():
                        try:finish_native_fixture(manager,prepared,owned_child=owned_child,owned_broker=owned_broker)
                        except BaseException as error:failures.append(error)
                        finally:finished.set()
                    cleaner=threading.Thread(target=clean);cleaner.start()
                    try:
                        wait_fixture(lambda:(prepared.payload/'child-finished').exists())
                        self.assertFalse(fixture_process_exited(owned_child),'The marker precedes the generated child exit')
                        self.assertFalse(finished.is_set(),'The marker must not allow cleanup of an executing child')
                    finally:
                        (prepared.payload/'release-finished-child').write_text('Release only this generated post-marker wait')
                        cleaner.join(25)
                    self.assertFalse(cleaner.is_alive(),'Owned child exit must be established before fixture cleanup')
                    if failures:raise failures[0]
                else:finish_native_fixture(manager,prepared,owned_child=owned_child,owned_broker=owned_broker)
            self.assertTrue(owned_child['confirmedExited']);self.assertTrue(owned_broker['confirmedExited'])
            self.assertTrue((prepared.payload/'child-finished').exists())
            self.assertEqual(manager.leases()[0]['state'],'uncertain','Broker failure cannot be auto-cleared by a missing PID')
            if residue:
                self.assertTrue(set(retained_inventory())==set(preserved),'Disposable residue inventory paths changed after owned process exit')
                for path,(original,digest) in preserved.items():
                    raw=path.read_bytes()
                    self.assertTrue(raw==original and hashlib.sha256(raw).hexdigest()==digest,'Disposable residue control bytes changed')
            for uncertain_only in (False,True):
                with self.assertRaises(apps.PortableAppError):manager.assert_safe('delete library items',uncertain_only=uncertain_only)
            self.assertTrue((prepared.payload/self.binary.name).exists());self.assertTrue(self.binary.exists())

if __name__=="__main__":unittest.main()
