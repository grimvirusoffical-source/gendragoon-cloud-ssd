"""Authenticated real DAV, verified ciphertext restoration and real FUSE when usable."""
import contextlib
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch,MagicMock

DESKTOP=Path(__file__).resolve().parents[1]
RUNTIME=Path(os.environ.get("GD_DESKTOP_RUNTIME",DESKTOP))
sys.path.insert(0,str(DESKTOP))
if (RUNTIME/"runtime").is_dir():sys.path.insert(0,str(RUNTIME));sys.path.insert(0,str(RUNTIME/"runtime"))
for name in ("librsx.so","librsx.dylib","librsx.dll"):
    if (RUNTIME/"runtime/redxai/_native"/name).is_file():os.environ["RSX_LIB"]=str(RUNTIME/"runtime/redxai/_native"/name);break
import machinenotes_client as client
import workspace_mount as mounts
import mount_platform as platform
import private_fs as private
from redx_session import RedXSession,SessionError

FIXTURE=json.loads((DESKTOP.parent/"Tests/fixtures/portable-vault-v1.json").read_text(encoding="utf-8"))
OWNER=FIXTURE["receiverId"];NOTE="a"*32;OTHER="b"*32;KEY="c"*18
REAL_TREE=mounts.WorkspaceTree

class Session(RedXSession):
    def __init__(self):
        super().__init__();self.receiver=OWNER;self._access="rxca_"+"T"*43;self._expires=10**20
        self.rows={NOTE:[],OTHER:[]};self.blobs={};self.revision=0
        self.notes=[dict(id=note,name="Fixture "+note[0],active=True,readOnly=False,workers=2,quotaBytes=10**12,usedBytes=0) for note in self.rows]
    def request(self,path,method="GET",value=None):
        self.token()
        if path=="/v1/receivers/me":return dict(id=self.receiver,state="ready",machineNotes=copy.deepcopy(self.notes),workspaces=copy.deepcopy(self.notes),usedBytes=0,libraryItems=sum(map(len,self.rows.values())))
        prefix="/v1/receivers/me/workspaces/"
        if path.startswith(prefix) and path.endswith("/library"):
            note=path[len(prefix):].split("/")[0]
            if note not in self.rows:raise SessionError("Fixture note denied.",403)
            return dict(revision=self.revision,items=copy.deepcopy(self.rows[note]))
        if path.startswith("/v1/receivers/me/library/") and method=="PUT":
            key=path.rsplit("/",1)[1];note=value["workspace"];item=dict(value,key=key,archiveKey=key,displayName=value["name"],virtualFolder=False)
            self.rows[note]=[i for i in self.rows[note] if i["key"]!=key]+[item];self.revision+=1;return item
        raise AssertionError("Unexpected fixture route")

class Receiver(client.DesktopReceiver):
    def json(self,route,method="GET",value=None,expected=(200,)):return self.config["_session"].request(route,method,value)
    def get_png(self,oid):
        try:return self.config["_session"].blobs[oid]
        except KeyError:raise client.storage.RedXStorageError("Missing fixture object",404)
    def put_png(self,oid,png):
        blobs=self.config["_session"].blobs
        if oid in blobs and blobs[oid]!=png:raise client.storage.RedXStorageError("Immutable fixture conflict",409)
        blobs[oid]=png;return dict(id=oid,carrierBytes=len(png),carrierSha256=hashlib.sha256(png).hexdigest())

def row(note=NOTE,**updates):
    result=dict(key=KEY,workspace=note,name="original.txt",displayName="document.txt",kind="file",virtualFolder=False,manifestId="d"*32,
        archiveBytes=100,archiveSha256="e"*64)
    result.update(updates);return result

def fake_model(root):
    model=client.MachineNotesClient(Session(),root);model.refresh_notes()
    model.keys=dict(receiverId=OWNER,storageSecret="S"*43,keymap=b"dummy private fixture")
    model.keymap=root/"keymap";private.write_private(model.keymap,b"dummy private fixture");model.vault_exported=True
    return model

def fake_tree(model,note,cache):
    payload=("owned note "+note).encode();target=private.private_directory(cache)/"verified-fixture"
    if target.exists():
        private.verify(target)
        if target.read_bytes()!=payload:raise ValueError("The retained fixture cache changed.")
    else:private.write_private(target,payload)
    record=dict(path=".",type="file",size=len(payload),sha256=hashlib.sha256(payload).hexdigest(),executable=0)
    return REAL_TREE(model,note,cache,manifest_loader=lambda *_:{".":record},restorer=lambda _:target)

@contextlib.contextmanager
def serving(tree):
    server=mounts.DAVServer(tree);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    try:yield server
    finally:server.shutdown();server.server_close();thread.join(timeout=2)

def request(server,path="/document.txt",method="GET",headers=None,token=True):
    values={"Authorization":"Bearer "+server.token} if token else {}
    values.update(headers or {})
    req=urllib.request.Request(server.url+path.lstrip("/"),method=method,headers=values)
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(req,timeout=15) as response:return response.status,response.read(),dict(response.headers)
    except urllib.error.HTTPError as error:
        with error:return error.code,error.read(),dict(error.headers)

class DAVTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix="gd-drive-dav-");self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name).resolve();self.model=fake_model(self.root/"model")
        self.model.session.rows[NOTE]=[row()];self.model.session.rows[OTHER]=[row(OTHER)]
        self.tree=fake_tree(self.model,NOTE,self.root/"cache")
    def test_real_http_auth_origin_and_write_denial(self):
        with serving(self.tree) as server:
            self.assertEqual(request(server,token=False)[0],401)
            self.assertEqual(request(server,headers={"Authorization":"Bearer invalid"})[0],401)
            self.assertEqual(request(server,headers={"Origin":"https://untrusted.invalid"})[0],401)
            self.assertEqual(request(server,headers={"Host":"untrusted.invalid"})[0],401)
            for method in ("PUT","POST","MOVE","COPY","DELETE","MKCOL","LOCK","PROPPATCH"):
                self.assertEqual(request(server,method=method)[0],405)
            status,payload,_=request(server)
            self.assertEqual(status,200);self.assertEqual(payload,("owned note "+NOTE).encode())
    def test_real_propfind_ranges_empty_depth_and_traversal_bounds(self):
        with serving(self.tree) as server:
            status,xml,_=request(server,"/",method="PROPFIND",headers={"Depth":"1"})
            self.assertEqual(status,207);self.assertIn(b"/document.txt",xml)
            self.assertEqual(request(server,"/",method="PROPFIND",headers={"Depth":"infinity"})[0],403)
            status,payload,headers=request(server,headers={"Range":"bytes=2-7"})
            self.assertEqual(status,206);self.assertEqual(payload,("owned note "+NOTE).encode()[2:8]);self.assertTrue(headers["Content-Range"].startswith("bytes 2-7/"))
            self.assertEqual(request(server,headers={"Range":"bytes=999999-"})[0],416)
            self.assertEqual(request(server,"/%2e%2e/secret")[0],400)
            self.assertEqual(request(server,"/%5csecret")[0],400)
            self.assertEqual(request(server,"/document.txt?token=unused")[0],400)
            self.assertEqual(request(server,method="HEAD")[1],b"")
    def test_cached_bytes_fail_closed_on_logout_account_change_delete_or_tamper(self):
        with serving(self.tree) as server:
            self.assertEqual(request(server)[0],200)
            Path(self.tree.materialized[next(iter(self.tree.materialized))]).write_bytes(b"x"*len(("owned note "+NOTE).encode()))
            self.assertEqual(request(server)[0],400)
            self.model.session.rows[NOTE]=[]
            self.assertEqual(request(server)[0],404)
            self.model.session.receiver="f"*64
            self.assertEqual(request(server)[0],403)
            self.model.session.logout()
            self.assertEqual(request(server)[0],403)
    def test_two_note_servers_and_tokens_are_isolated(self):
        second=fake_tree(self.model,OTHER,self.root/"second")
        with serving(self.tree) as first,serving(second) as other:
            self.assertEqual(request(first)[1],("owned note "+NOTE).encode())
            self.assertEqual(request(other)[1],("owned note "+OTHER).encode())
            self.assertEqual(request(other,headers={"Authorization":"Bearer "+first.token})[0],401)
            self.assertNotEqual(self.tree.cache,second.cache)
    def test_foreign_or_spoofed_app_backup_is_refused_before_dav_metadata_or_payload_restore(self):
        for updates in ({"name":"Tool.apk","applicationPlatform":"android"},{"name":"Tool.exe","applicationPlatform":"macos"}):
            self.model.session.rows[NOTE]=[row(displayName="renamed-document.txt",**updates)]
            with serving(self.tree) as server:self.assertEqual(request(server,"/renamed-document.txt")[0],400)
            self.assertEqual(self.tree.materialized,{})
    def test_quiescing_and_authenticated_read_activity_protect_unmount(self):
        with self.tree.request():self.assertEqual(self.tree.active,1)
        self.assertEqual(self.tree.active,0)
        self.tree.closing=True
        with serving(self.tree) as server:self.assertEqual(request(server)[0],503)
    def test_virtual_folder_moves_are_reflected_without_changing_archive_identity(self):
        folder=row(key="e"*18,name="Folder",displayName="Folder",kind="folder",virtualFolder=True)
        self.model.session.rows[NOTE]=[folder,row(parentKey=folder["key"])]
        with serving(self.tree) as server:
            self.assertEqual(request(server)[0],404)
            self.assertEqual(request(server,"/Folder/document.txt")[0],200)
            original_identity=mounts.identity(self.model.session.rows[NOTE][1])
            self.model.session.rows[NOTE][1]["parentKey"]=None
            self.assertEqual(request(server,"/Folder/document.txt")[0],404)
            self.assertEqual(request(server)[0],200)
            self.assertEqual(mounts.identity(self.model.session.rows[NOTE][1]),original_identity)

class FakeProcess:
    def __init__(self,pid):self.pid=pid;self.returncode=None
    def poll(self):return self.returncode

class ManagerTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory();self.addCleanup(self.temporary.cleanup);self.root=Path(self.temporary.name).resolve()
        self.model=fake_model(self.root/"profile");self.model.session.rows[NOTE]=[row()];self.model.session.rows[OTHER]=[row(OTHER)]
        self.active=set();self.processes={};self.counter=100
        def start(tools,record,*_):
            self.counter+=1;process=FakeProcess(self.counter);self.processes[record["id"]]=process;self.active.add(record["id"]);return process
        def stop(record,process):self.active.discard(record["id"]);process.returncode=0
        self.patches=[patch.object(mounts,"WorkspaceTree",side_effect=fake_tree),patch.object(platform,"prerequisites",return_value={"rclone":"/fixture/rclone","sha256":"0"*64}),
            patch.object(platform,"mounted",side_effect=lambda r:r["id"] in self.active),patch.object(platform,"start",side_effect=start),
            patch.object(platform,"process_identity",side_effect=lambda pid:dict(pid=pid,start="fixed",exe="rclone",owner="fixture")),
            patch.object(platform,"process_matches",side_effect=lambda value:bool(value and any(p.pid==value["pid"] and p.poll() is None for p in self.processes.values()))),
            patch.object(platform,"unmount",side_effect=stop),patch.object(platform,"capture_mount_identity",return_value={}),patch.object(platform,"unrecorded_mounts",return_value=False)]
        if sys.platform=="win32":self.patches.append(patch.object(platform,"choose_mount_path",side_effect=lambda _:Path(("Z" if not self.active else "Y")+":\\")))
        for value in self.patches:value.start();self.addCleanup(value.stop)
        self.manager=mounts.WorkspaceMountManager(self.model.root)
        def close():
            for key in list(self.manager.live):
                tree=self.manager.live[key][0];deadline=time.monotonic()+2
                while tree.active and time.monotonic()<deadline:time.sleep(.005)
                self.manager.unmount(key)
        self.addCleanup(close)

    def test_confirmed_unmount_clears_dead_pid_before_uncertain_windows_relookup(self):
        record=self.manager.mount(self.model,NOTE);process=self.manager.live[record["id"]][3]
        def lookup(value):
            if value is None:return False
            return None if value["pid"]==process.pid and process.poll() is not None else True
        with patch.object(platform,"process_matches",side_effect=lookup):
            self.manager.unmount(record["id"])
            self.assertEqual(process.poll(),0)
            self.assertIsNone(self.manager.saved[record["id"]]["process"])
            self.assertFalse(self.manager.has_mounts)
            replacement=self.manager.mount(self.model,NOTE)
            self.assertNotEqual(replacement["process"]["pid"],record["process"]["pid"])
            self.assertEqual(replacement["state"],"mounted")
            self.assertTrue(self.manager.has_mounts)
    def test_multiple_mount_identities_and_private_registry_have_no_credentials(self):
        first=self.manager.mount(self.model,NOTE);second=self.manager.mount(self.model,OTHER)
        self.assertNotEqual(first["mountPath"],second["mountPath"]);self.assertEqual(len(self.manager.records),2);self.assertTrue(self.manager.has_mounts)
        raw=b"".join(p.read_bytes() for p in self.manager.root.glob("*/*/registry.json"))
        for secret in (b"rxca_",b"storageSecret",b"Bearer ",b"dummy private fixture",b"S"*43):self.assertNotIn(secret,raw)
        self.manager.unmount(first["id"]);self.assertEqual(len(self.manager.records),1);self.assertTrue(self.manager.has_mounts)
        self.manager.unmount(second["id"]);self.assertFalse(self.manager.has_mounts)
    def test_active_request_and_restart_orphan_cannot_be_forced_away(self):
        record=self.manager.mount(self.model,NOTE);tree=self.manager.live[record["id"]][0];tree.active=1
        with self.assertRaises(mounts.MountError):self.manager.unmount(record["id"])
        self.assertTrue(self.manager.has_mounts);tree.active=0
        restarted=mounts.WorkspaceMountManager(self.model.root)
        self.assertTrue(restarted.has_mounts);self.assertEqual(restarted.records[0]["state"],"orphaned")
        with self.assertRaises(mounts.MountError):restarted.unmount(record["id"])
        self.assertIn(record["id"],self.active)
        with patch.object(platform,"mounted",return_value=False),patch.object(platform,"process_matches",return_value=None):
            with self.assertRaises(mounts.MountError):restarted.unmount(record["id"])
            self.assertTrue(restarted.has_mounts)
    def test_uncertain_registry_blocks_account_actions(self):
        directory=private.private_directory(self.manager.root/OWNER/NOTE)
        private.write_private(directory/"registry.json",b'{"schema":1,"receiverId":"invalid"}')
        self.assertTrue(self.manager.has_mounts);self.assertTrue(self.manager.unknown)
        with self.assertRaises(mounts.MountError):self.manager.mount(self.model,OTHER)
    def test_missing_registry_still_blocks_when_platform_finds_an_unrecorded_drive(self):
        with patch.object(platform,"unrecorded_mounts",return_value=True):
            self.assertTrue(self.manager.has_mounts);self.assertTrue(self.manager.unknown)
            with self.assertRaises(mounts.MountError):self.manager.mount(self.model,NOTE)
    def test_driver_busy_failure_retains_drive_and_reopens_authenticated_reads(self):
        record=self.manager.mount(self.model,NOTE);tree=self.manager.live[record["id"]][0]
        with patch.object(platform,"unmount",side_effect=platform.PlatformMountError("The fixture drive is in use")):
            with self.assertRaises(platform.PlatformMountError):self.manager.unmount(record["id"])
        self.assertTrue(self.manager.has_mounts);self.assertFalse(tree.closing)
        with tree.request():self.assertEqual(tree.active,1)
    def test_exited_helper_stays_visible_until_safe_explicit_cleanup(self):
        record=self.manager.mount(self.model,NOTE)
        self.active.remove(record["id"]);self.processes[record["id"]].returncode=0
        self.assertTrue(self.manager.has_mounts);self.assertEqual(self.manager.records[0]["state"],"orphaned")
        self.manager.unmount(record["id"]);self.assertFalse(self.manager.has_mounts)

    def test_mount_path_failure_creates_no_dav_and_preserves_existing_drive_and_cache(self):
        existing=self.manager.mount(self.model,OTHER);server=self.manager.live[existing["id"]][1]
        cache=private.private_directory(self.manager.root/OWNER/NOTE/"cache")
        sentinel=cache/"retained.txt";private.write_private(sentinel,b"Retained private cache")
        with patch.object(platform,"choose_mount_path",side_effect=platform.PlatformMountError("No fixture drive letter")),patch.object(mounts,"DAVServer") as constructor:
            with self.assertRaises(platform.PlatformMountError):self.manager.mount(self.model,NOTE)
            constructor.assert_not_called()
        self.assertEqual(sentinel.read_bytes(),b"Retained private cache")
        self.assertEqual(request(server)[1],("owned note "+OTHER).encode())
        self.assertEqual(set(self.manager.live),{existing["id"]})

    def test_registry_failure_closes_only_new_dav_before_its_thread_or_child_starts(self):
        existing=self.manager.mount(self.model,OTHER);server=self.manager.live[existing["id"]][1]
        cache=private.private_directory(self.manager.root/OWNER/NOTE/"cache")
        sentinel=cache/"retained.txt";private.write_private(sentinel,b"Retained private cache")
        servers=[];threads=[];real_server=mounts.DAVServer;real_thread=threading.Thread
        def create_server(tree):
            created=real_server(tree);servers.append(created);return created
        def create_thread(*args,**kwargs):
            created=real_thread(*args,**kwargs)
            if getattr(kwargs.get("target"),"__self__",None) in servers:threads.append(created)
            return created
        with patch.object(self.manager,"_save",side_effect=OSError("Fixture registry failure")),patch.object(mounts,"DAVServer",side_effect=create_server),patch.object(threading,"Thread",side_effect=create_thread),patch.object(platform,"start") as starter:
            with self.assertRaises(OSError):self.manager.mount(self.model,NOTE)
            starter.assert_not_called()
        self.assertEqual(len(servers),1);self.assertEqual(servers[0].socket.fileno(),-1)
        self.assertEqual(len(threads),1);self.assertFalse(threads[0].is_alive());self.assertIsNone(threads[0].ident)
        self.assertEqual(sentinel.read_bytes(),b"Retained private cache")
        self.assertEqual(request(server)[1],("owned note "+OTHER).encode())
        self.assertEqual(set(self.manager.live),{existing["id"]})

    def test_early_child_exit_reports_only_fixed_reason_codes_and_closes_new_dav(self):
        process=FakeProcess(777);process.returncode=1;process._gd_startup_reasons=["invalid_option","invalid_filesecurity_option"]
        with patch.object(platform,"start",return_value=process):
            with self.assertRaisesRegex(platform.PlatformMountError,"exit 1; reasons: invalid_option, invalid_filesecurity_option"):
                self.manager.mount(self.model,NOTE)
        self.assertFalse(self.manager.live);self.assertFalse(self.manager.has_mounts)

class ActualArchiveTests(unittest.TestCase):
    def setUp(self):
        try:client.crypto_runtime()
        except Exception:
            if os.environ.get("GD_DESKTOP_RUNTIME"):raise
            self.skipTest("A pinned native codec runtime is required")
        self.temporary=tempfile.TemporaryDirectory(prefix="gd-drive-verified-測試-");self.addCleanup(self.temporary.cleanup)
        self.root=Path(self.temporary.name).resolve();self.model=client.MachineNotesClient(Session(),self.root/"profile");self.model.refresh_notes()
        self.model.import_vault(json.dumps(FIXTURE["envelope"]).encode(),FIXTURE["password"])
        self.patches=[patch.object(client,"DesktopReceiver",Receiver),patch.object(mounts,"DesktopReceiver",Receiver)]
        for value in self.patches:value.start();self.addCleanup(value.stop)
        self.source=self.root/"proof-測試.txt";self.payload=os.urandom(4096);self.source.write_bytes(self.payload)
        self.model.upload(self.source)
    def test_real_codec_metadata_and_archive_restore_are_used_by_authenticated_dav(self):
        original=self.model.session.rows[NOTE][0]
        self.model.session.rows[NOTE].append(dict(original,key="f"*18,archiveKey=original["key"],displayName="Renamed copy.txt"))
        self.model.session.notes[0].update(active=False,readOnly=True,workers=0)
        tree=mounts.WorkspaceTree(self.model,NOTE,self.root/"drive-cache")
        with serving(tree) as server:
            from urllib.parse import quote
            status,payload,_=request(server,"/"+quote(self.source.name))
            self.assertEqual(status,200);self.assertEqual(payload,self.payload)
            self.assertEqual(request(server,"/Renamed%20copy.txt")[1],self.payload)
            self.assertTrue(tree.materialized);self.assertEqual(self.source.read_bytes(),self.payload)
            self.model.session.rows[NOTE]=[]
            self.assertEqual(request(server,"/"+quote(self.source.name))[0],404)

    def test_nested_backup_folder_files_use_the_verified_archive_manifest(self):
        folder=self.root/"FolderBackup";folder.mkdir();(folder/"inner").mkdir();(folder/"inner/data.txt").write_bytes(b"Nested archive fixture")
        self.model.upload(folder)
        tree=mounts.WorkspaceTree(self.model,NOTE,self.root/"drive-cache")
        with serving(tree) as server:
            self.assertEqual(request(server,"/FolderBackup/",method="PROPFIND")[0],207)
            status,payload,_=request(server,"/FolderBackup/inner/data.txt")
            self.assertEqual(status,200);self.assertEqual(payload,b"Nested archive fixture")
            self.assertEqual((folder/"inner/data.txt").read_bytes(),b"Nested archive fixture")

    @unittest.skipUnless(sys.platform=="win32" or sys.platform.startswith("linux"),"Actual Windows/Linux filesystem driver gate")
    def test_real_drive_read_busy_refusal_and_normal_unmount_when_available(self):
        report=Path(os.environ["GD_MOUNT_REPORT"]) if os.environ.get("GD_MOUNT_REPORT") else None
        def emit(state,reason=None):
            if report:report.write_text(json.dumps({"schema":1,"platform":sys.platform,"mount":state,"reason":reason}),encoding="utf-8")
        helper=os.environ.get("GD_TEST_MOUNT_HOST" if sys.platform=="win32" else "GD_TEST_RCLONE")
        try:platform.prerequisites(helper)
        except platform.PlatformMountError as error:
            emit("prerequisite-unavailable",str(error));self.skipTest(str(error))
        manager=mounts.WorkspaceMountManager(self.model.root);record=None
        try:
            record=manager.mount(self.model,NOTE,helper);self.assertTrue(platform.mounted(record))
            path=Path(record["mountPath"])/self.source.name
            with path.open("rb") as source:
                self.assertEqual(source.read(),self.payload)
                with self.assertRaises(platform.PlatformMountError):manager.unmount(record["id"])
            manager.unmount(record["id"]);self.assertFalse(manager.has_mounts);self.assertEqual(self.source.read_bytes(),self.payload)
            emit("verified", "Real filesystem read, busy refusal and normal unmount passed")
        except Exception:
            emit("failed", "The actual filesystem mount/read/unmount gate failed")
            raise
        finally:
            if record and manager.has_mounts:manager.unmount(record["id"])

class PlatformTests(unittest.TestCase):
    @staticmethod
    def windows_security_fixture(sid="S-1-5-21-123-456-789-1001"):
        descriptor=MagicMock();acl=descriptor.GetSecurityDescriptorDacl.return_value
        acl.GetAceCount.return_value=1;acl.GetAce.return_value=((0,0),0x1200a9,sid)
        descriptor.GetSecurityDescriptorOwner.return_value=sid;descriptor.GetSecurityDescriptorControl.return_value=(0x1004,1)
        security=MagicMock();security.ConvertSidToStringSid.side_effect=lambda value:value
        security.ConvertStringSecurityDescriptorToSecurityDescriptor.return_value=descriptor
        return SimpleNamespace(modules=lambda:(security,),user_sid=lambda:sid),security,descriptor

    def test_script_and_missing_tool_cannot_start_a_filesystem_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            script=Path(temporary)/"rclone";script.write_bytes(b"#!/bin/sh\nexit 0\n")
            with self.assertRaises(platform.PlatformMountError):platform.trusted_binary(script)
        with patch.object(platform,"sys",SimpleNamespace(platform="linux")),patch.object(platform.shutil,"which",return_value=None),patch.object(platform.subprocess,"Popen") as start:
            with self.assertRaises(platform.PlatformMountError):platform.prerequisites()
            start.assert_not_called()
    def test_rclone_gets_only_ephemeral_local_credentials_without_cloud_context(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary=Path(temporary)/"rclone";binary.write_bytes(b"native fixture")
            process=SimpleNamespace(stderr=io.BytesIO(b"NOTICE: Serving remote control on http://127.0.0.1:43123/\n"))
            tools={"rclone":str(binary),"sha256":hashlib.sha256(binary.read_bytes()).hexdigest()}
            with patch.object(platform,"sys",SimpleNamespace(platform="linux")),patch.object(platform,"trusted_binary",return_value=str(binary)),patch.object(platform.subprocess,"Popen",return_value=process) as start,patch.dict(os.environ,{"RX_ACCESS_TOKEN":"private-fixture","RCLONE_CONFIG_OLD":"private-fixture"}):
                platform.start(tools,{"mountPath":"/fixture/mount","label":"Fixture"},"http://127.0.0.1:43124/","local-dav-token",Path(temporary)/"cache")
            args=start.call_args.args[0];environment=start.call_args.kwargs["env"]
            self.assertIn("--read-only",args);self.assertIn("--vfs-cache-mode=off",args);self.assertNotIn("--allow-other",args)
            self.assertNotIn("local-dav-token",repr(args));self.assertNotIn("private-fixture",repr(environment));self.assertNotIn("RX_ACCESS_TOKEN",environment)
            self.assertEqual(environment["RCLONE_WEBDAV_BEARER_TOKEN"],"local-dav-token")
            self.assertNotEqual(environment["RCLONE_RC_PASS"],environment["RCLONE_WEBDAV_BEARER_TOKEN"])

    def test_windows_owned_host_receives_exact_protected_current_user_read_execute_descriptor(self):
        fixture,security,descriptor=self.windows_security_fixture();sid=fixture.user_sid()
        expected="FileSecurity=O:"+sid+"G:"+sid+"D:P(A;;FRFX;;;"+sid+")"
        with tempfile.TemporaryDirectory() as temporary:
            binary=Path(temporary)/"rclone.exe";binary.write_bytes(b"native fixture")
            tools={"rclone":str(binary),"sha256":hashlib.sha256(binary.read_bytes()).hexdigest(),"backend":"owned-host"}
            process=SimpleNamespace(stderr=io.BytesIO())
            with patch.dict(sys.modules,{"gendragoon_platform_ipc":fixture}),patch.object(platform,"sys",SimpleNamespace(platform="win32")),patch.object(platform,"trusted_binary",return_value=str(binary)),patch.object(platform.subprocess,"CREATE_NO_WINDOW",0,create=True),patch.object(platform.subprocess,"Popen",return_value=process) as start:
                platform.start(tools,{"mountPath":"Z:\\","label":"Fixture"},"http://127.0.0.1:43124/","local-only",Path(temporary)/"cache")
            args=start.call_args.args[0];environment=start.call_args.kwargs["env"]
            self.assertEqual(args,[str(binary),"--mount-point","Z:","--volume-label","Fixture"])
            self.assertEqual(environment["GD_MOUNT_FILE_SECURITY"],expected.removeprefix("FileSecurity="))
            self.assertEqual(environment["GD_MOUNT_DAV_TOKEN"],"local-only")
            self.assertNotEqual(environment["GD_MOUNT_CONTROL_TOKEN"],environment["GD_MOUNT_DAV_TOKEN"])
            self.assertNotIn("RCLONE_RC_PASS",environment);self.assertNotIn("local-only",repr(args))
            security.ConvertStringSecurityDescriptorToSecurityDescriptor.assert_called_once_with(expected.removeprefix("FileSecurity="),1)
            self.assertEqual(descriptor.GetSecurityDescriptorDacl().GetAce(0)[-1],sid)
            for broad in (";;;WD)",";;;AU)",";;;BA)",";;;SY)"):self.assertNotIn(broad,expected)

    def test_windows_unknown_sid_or_broadened_descriptor_fails_before_process_creation(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary=Path(temporary)/"rclone.exe";binary.write_bytes(b"native fixture")
            tools={"rclone":str(binary),"sha256":hashlib.sha256(binary.read_bytes()).hexdigest(),"backend":"owned-host"}
            with patch.object(platform,"sys",SimpleNamespace(platform="win32")),patch.object(platform,"trusted_binary",return_value=str(binary)),patch.object(platform.subprocess,"Popen") as start:
                for sid in ("S-1-1-0","S-1-5-18","S-1-5-32-544","S-1-5-80-1","S-1-5-21-1-2-3-4294967296","S-1-5-21-1-2-3-1001)(A;;FA;;;WD)"):
                    fixture,_,_=self.windows_security_fixture(sid)
                    with self.subTest(sid=sid),patch.dict(sys.modules,{"gendragoon_platform_ipc":fixture}):
                        with self.assertRaises(platform.PlatformMountError):platform.start(tools,{"mountPath":"Z:\\","label":"Fixture"},"http://127.0.0.1:43124/","local-only",Path(temporary)/"cache")
                for mode in ("extra-ace","wrong-owner","unprotected","write-access"):
                    fixture,_,descriptor=self.windows_security_fixture()
                    if mode=="extra-ace":descriptor.GetSecurityDescriptorDacl().GetAceCount.return_value=2
                    elif mode=="wrong-owner":descriptor.GetSecurityDescriptorOwner.return_value="S-1-5-32-544"
                    elif mode=="unprotected":descriptor.GetSecurityDescriptorControl.return_value=(4,1)
                    else:descriptor.GetSecurityDescriptorDacl().GetAce.return_value=((0,0),0x1f01ff,fixture.user_sid())
                    with self.subTest(mode=mode),patch.dict(sys.modules,{"gendragoon_platform_ipc":fixture}):
                        with self.assertRaises(platform.PlatformMountError):platform.start(tools,{"mountPath":"Z:\\","label":"Fixture"},"http://127.0.0.1:43124/","local-only",Path(temporary)/"cache")
                start.assert_not_called()

    @unittest.skipUnless(sys.platform=="win32","Actual Windows SID and security descriptor parser")
    def test_real_windows_descriptor_has_only_current_user_and_read_execute_rights(self):
        from gendragoon_platform_ipc import modules,user_sid
        security=modules()[-1];sid=security.ConvertSidToStringSid(user_sid())
        option=platform._windows_file_security()
        descriptor=security.ConvertStringSecurityDescriptorToSecurityDescriptor(option.removeprefix("FileSecurity="),1)
        self.assertEqual(security.ConvertSidToStringSid(descriptor.GetSecurityDescriptorOwner()),sid)
        self.assertTrue(descriptor.GetSecurityDescriptorControl()[0]&0x1000)
        acl=descriptor.GetSecurityDescriptorDacl();self.assertEqual(acl.GetAceCount(),1)
        ace=acl.GetAce(0);self.assertEqual(ace[0],(0,0));self.assertEqual(ace[1],0x1200a9)
        self.assertEqual(security.ConvertSidToStringSid(ace[-1]),sid)

    def test_startup_diagnostics_are_bounded_fixed_codes_without_stderr_secrets(self):
        taint=b"private-token https://private.example/path /private/customer/file C:\\Customer\\private.txt "
        stderr=(taint+b" unknown flag: --timeout\n"+taint+b" Invalid security descriptor; Cannot create WinFsp-FUSE file system\n"+b"x"*20000+b"\n")
        with tempfile.TemporaryDirectory() as temporary:
            binary=Path(temporary)/"rclone";binary.write_bytes(b"native fixture")
            process=SimpleNamespace(stderr=io.BytesIO(stderr),poll=lambda:2)
            tools={"rclone":str(binary),"sha256":hashlib.sha256(binary.read_bytes()).hexdigest()}
            with patch.object(platform,"sys",SimpleNamespace(platform="linux")),patch.object(platform,"trusted_binary",return_value=str(binary)),patch.object(platform.subprocess,"Popen",return_value=process):
                platform.start(tools,{"mountPath":"/fixture/mount","label":"Fixture"},"http://127.0.0.1:43124/","local-dav-token",Path(temporary)/"cache")
            message=str(platform.startup_failure(process))
            for expected in ("exit 2","unknown_flag_timeout","invalid_security_descriptor","fuse_start_failed"):self.assertIn(expected,message)
            for secret in ("private-token","private.example","Customer","customer","private.txt","local-dav-token","/private/"):self.assertNotIn(secret,message)
            self.assertLessEqual(len(process._gd_startup_reasons),8);self.assertLess(len(message),1024)
            self.assertEqual(platform._startup_reasons(b"unknown vendor text with "+taint),[])
            self.assertIn("invalid_mountpoint",platform._startup_reasons(b"Cannot create WinFsp-FUSE file system: invalid mount point"))

    def test_native_utf16_stdout_is_classified_without_recording_raw_words_or_paths(self):
        text="WinFsp cannot create filesystem: invalid argument for secretCustomer https://secret.example/s privateToken C:\\secretCustomer\\file.txt"
        with tempfile.TemporaryDirectory() as temporary:
            binary=Path(temporary)/"rclone";binary.write_bytes(b"native fixture")
            process=SimpleNamespace(stdout=io.BytesIO(text.encode("utf-16-le")),stderr=io.BytesIO(),poll=lambda:1)
            tools={"rclone":str(binary),"sha256":hashlib.sha256(binary.read_bytes()).hexdigest()}
            with patch.object(platform,"sys",SimpleNamespace(platform="linux")),patch.object(platform,"trusted_binary",return_value=str(binary)),patch.object(platform.subprocess,"Popen",return_value=process):
                platform.start(tools,{"mountPath":"/fixture/mount","label":"Fixture"},"http://127.0.0.1:43124/","local-only",Path(temporary)/"cache")
            message=str(platform.startup_failure(process))
            self.assertIn("invalid_argument",message);self.assertIn("technical words:",message)
            self.assertEqual(process._gd_output_sizes["stdout"],len(text.encode("utf-16-le")));self.assertEqual(process._gd_output_sizes["stderr"],0)
            self.assertLessEqual(len(process._gd_startup_words),24)
            for word in process._gd_startup_words:self.assertIn(word.encode(),platform.STARTUP_WORDS)
            for secret in ("secretCustomer","secret.example","privateToken","http","C:\\", ".txt"):self.assertNotIn(secret,message)
    def test_kernel_busy_or_changed_process_identity_never_stops_a_helper(self):
        record={"mountPath":"/fixture/mount","tools":{"unmount":"/fixture/fusermount"},"process":{"pid":1}}
        process=MagicMock()
        with patch.object(platform,"process_matches",return_value=False),patch.object(platform.subprocess,"run") as command,patch.object(platform,"_quit") as quit:
            with self.assertRaises(platform.PlatformMountError):platform.unmount(record,process)
            command.assert_not_called();quit.assert_not_called()
        with patch.object(platform,"sys",SimpleNamespace(platform="linux")),patch.object(platform,"process_matches",return_value=True),patch.object(platform,"mounted",return_value=True),patch.object(platform,"trusted_binary",return_value="/fixture/fusermount"),patch.object(platform.subprocess,"run",return_value=SimpleNamespace(returncode=1)) as command,patch.object(platform,"_quit") as quit:
            with self.assertRaises(platform.PlatformMountError):platform.unmount(record,process)
            self.assertEqual(command.call_args.args[0],["/fixture/fusermount","-u","/fixture/mount"]);quit.assert_not_called()
        process.send_signal.assert_not_called();process.terminate.assert_not_called();process.kill.assert_not_called()
    def test_windows_volume_identity_and_exclusive_lock_guard_every_dismount(self):
        events=[];kernel=MagicMock();kernel.CreateFileW.return_value=42
        def query(handle,name,size,serial,*rest):name.value="Fixture";serial._obj.value=123;rest[-2].value="FUSE-rclone";events.append("identity");return 1
        def control(handle,code,*_):events.append(code);return 1
        kernel.GetVolumeInformationByHandleW.side_effect=query;kernel.DeviceIoControl.side_effect=control;kernel.CloseHandle.side_effect=lambda _:events.append("close")
        record={"mountPath":"Z:\\","label":"Fixture","volumeSerial":123}
        with patch.object(platform.ctypes,"WinDLL",create=True,return_value=kernel):
            with platform._windows_dismount(record):events.append("held-through-shutdown")
            self.assertEqual(events,["identity",0x90018,0x90020,"held-through-shutdown",0x9001C,"close"])
            events.clear();record["volumeSerial"]=999
            with self.assertRaises(platform.PlatformMountError):
                with platform._windows_dismount(record):self.fail("A different volume must not be dismounted")
            self.assertEqual(events,["identity","close"])
            events.clear();record["volumeSerial"]=123
            kernel.DeviceIoControl.side_effect=lambda handle,code,*_:events.append(code) or 0
            with self.assertRaises(platform.PlatformMountError):
                with platform._windows_dismount(record):self.fail("A busy volume must not be dismounted")
            self.assertEqual(events,["identity",0x90018,"close"])

    def test_windows_actual_winfsp_type_is_required_for_identity_and_orphan_detection(self):
        label="GenDragoon-12345678-abcdefgh";record={"mountPath":"Z:\\","label":label,"volumeSerial":123}
        kernel=SimpleNamespace(GetLogicalDrives=lambda:1<<25)
        with patch.object(platform,"sys",SimpleNamespace(platform="win32")),patch.object(platform.ctypes,"windll",SimpleNamespace(kernel32=kernel),create=True):
            with patch.object(platform,"_windows_volume",return_value=(label,"FUSE-rclone",123)):
                self.assertIs(platform.mounted(record),True);self.assertEqual(platform.capture_mount_identity(record),{"volumeSerial":123})
                self.assertTrue(platform.unrecorded_mounts(Path("/fixture"),set()))
                self.assertFalse(platform.unrecorded_mounts(Path("/fixture"),{"Z:\\"}))
            for filesystem in ("rclone","FUSE-other","NTFS"):
                with self.subTest(filesystem=filesystem),patch.object(platform,"_windows_volume",return_value=(label,filesystem,123)):
                    self.assertIsNone(platform.mounted(record))
                    with self.assertRaises(platform.PlatformMountError):platform.capture_mount_identity(record)
            with patch.object(platform,"_windows_volume",return_value=(label,"FUSE-rclone",999)):
                self.assertIsNone(platform.mounted(record))

class GUIAccountGuards(unittest.TestCase):
    def test_mounted_or_uncertain_drive_blocks_switch_logout_and_quit(self):
        from gendragoon_gui import GenDragoonGUI
        app=GenDragoonGUI.__new__(GenDragoonGUI);app.busy=False;app.mounts=SimpleNamespace(has_mounts=True)
        app.root=MagicMock();app.model=MagicMock();app.executor=MagicMock();app.instance=MagicMock()
        with patch("tkinter.messagebox.showwarning") as warning:
            self.assertFalse(app.can_switch());app.disconnect();app.close()
            self.assertEqual(warning.call_count,3)
        app.model.session.logout.assert_not_called();app.executor.shutdown.assert_not_called();app.root.destroy.assert_not_called()

if __name__=="__main__":unittest.main()
