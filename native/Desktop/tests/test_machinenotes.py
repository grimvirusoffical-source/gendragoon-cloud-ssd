"""Current desktop protocol, vault interoperability, renewal, and original retention."""
import base64
import concurrent.futures
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import sys
import tempfile
import threading
import queue
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

if __name__=="__main__":unittest.main()
