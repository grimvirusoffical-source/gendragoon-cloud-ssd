"""Authenticated read-only DAV, isolated note caches and conservative mount status."""
import copy
import hashlib
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from unittest.mock import Mock,patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"Resources"))
import gendragoon_workspace_mount as mounts


class WorkspaceMountTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="gd-mount-fixture-");self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name).resolve();self.home.chmod(0o700)
        self.support=self.home/"Library/Application Support/GenDragoon Cloud SSD";self.support.mkdir(parents=True,mode=0o700)
        self.patches=[]
        for name,value in dict(HOME=self.home,SUPPORT=self.support,CACHE=self.support/"cache",INDEX=self.support/"library.json",CONFIG=self.support/"rclone.conf").items():
            p=patch.object(mounts.lib,name,value);p.start();self.addCleanup(p.stop)
        p=patch.object(mounts,"ROOT",self.support/"WorkspaceMounts");p.start();self.addCleanup(p.stop)
        self.receiver="b"*64;self.workspace="a"*32
        self.config=dict(receiverId=self.receiver,workspaceId=self.workspace)
        self.folder="1"*18;self.file="2"*18;self.backup="3"*18
        self.payload=b"fixture data"
        self.items=[dict(key=self.folder,name="Folder",kind="folder",virtualFolder=True,workspace=self.workspace,parentKey=None),
                    dict(key=self.file,name="report.txt",kind="file",workspace=self.workspace,parentKey=self.folder,manifestId="d"*32,archiveBytes=12,archiveSha256="e"*64),
                    dict(key=self.backup,name="Original",displayName="Backup",kind="folder",workspace=self.workspace,parentKey=None,manifestId="f"*32,archiveBytes=12,archiveSha256="e"*64)]
        entry=dict(type="file",size=len(self.payload),sha256=hashlib.sha256(self.payload).hexdigest())
        self.manifests={self.file:[dict(entry,path=".")],self.backup:[dict(path=".",type="directory"),dict(path="Nested",type="directory"),
            dict(entry,path="Nested/a.txt"),dict(path="Alias",type="symlink",target="Nested"),dict(path="Escape",type="symlink",target="../../outside")]}
        self.local=self.home/"generated";self.local.mkdir()
        (self.local/"report.txt").write_bytes(self.payload);(self.local/"Backup/Nested").mkdir(parents=True)
        (self.local/"Backup/Nested/a.txt").write_bytes(self.payload)
        self.snapshot=lambda:{"revision":7,"items":copy.deepcopy(self.items)}
        self.client=Mock(verified_workers=Mock(return_value=1),library_snapshot=Mock(side_effect=self.snapshot))
        self.authorize=Mock(return_value="opaque-access-never-written")
        self.stage=Mock(side_effect=lambda key,*args,**kwargs:str(self.local/"report.txt" if key==self.file else self.local/"Backup"))
        self.loader=Mock(side_effect=lambda client,item:copy.deepcopy(self.manifests[item["key"]]))
        self.tree=mounts.WorkspaceTree(self.config,self.client,self.authorize,self.stage,self.loader)

    def server(self,tree=None,token="private-loopback-capability"):
        server=mounts.DAVServer(tree or self.tree,token);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(lambda:(server.shutdown(),server.server_close(),thread.join(timeout=2)))
        return "http://127.0.0.1:"+str(server.server_port)

    def request(self,url,method="GET",token="private-loopback-capability",headers=None):
        request=urllib.request.Request(url,method=method,headers={"Authorization":"Bearer "+token,**(headers or {})})
        try:
            with urllib.request.urlopen(request,timeout=5) as response:return response.status,dict(response.headers),response.read()
        except urllib.error.HTTPError as error:
            with error:return error.code,dict(error.headers),error.read()

    def test_listing_is_lazy_and_backup_links_cannot_escape_archive(self):
        self.loader.assert_not_called()
        self.assertEqual(self.tree.resolve(("Folder",))["type"],"directory")
        self.loader.assert_not_called()
        self.assertEqual(self.tree.resolve(("Backup","Alias","a.txt"))["relative"],"Nested/a.txt")
        with self.assertRaises(ValueError):self.tree.resolve(("Backup","Escape"))
        self.stage.assert_not_called()

    def test_authenticated_propfind_range_and_head_use_verified_file(self):
        url=self.server()
        status,headers,data=self.request(url+"/Folder/","PROPFIND",headers={"Depth":"1"})
        self.assertEqual(status,207);self.assertIn(b"report.txt",data);self.stage.assert_not_called()
        status,headers,data=self.request(url+"/Folder/report.txt","HEAD")
        self.assertEqual(status,200);self.assertEqual(int(headers["Content-Length"]),len(self.payload));self.stage.assert_not_called()
        status,headers,data=self.request(url+"/Folder/report.txt",headers={"Range":"bytes=2-6"})
        self.assertEqual(status,206);self.assertEqual(data,self.payload[2:7]);self.stage.assert_called_once()
        self.assertEqual(headers["Content-Range"],"bytes 2-6/12")
        self.assertGreaterEqual(self.authorize.call_count,3)

    def test_every_request_fails_closed_on_native_logout_even_with_cached_plaintext(self):
        url=self.server();self.authorize.side_effect=mounts.broker.BrokerError("native account disconnected")
        for method in ("PROPFIND","GET","HEAD","OPTIONS"):
            with self.subTest(method=method):self.assertEqual(self.request(url+"/Folder/report.txt",method)[0],403)
        self.stage.assert_not_called();self.loader.assert_not_called()

    def test_dav_is_read_only_and_capability_is_not_shared_between_mounts(self):
        first=self.server();second=self.server(token="different-private-capability")
        self.assertNotEqual(first,second)
        self.assertEqual(self.request(second+"/","PROPFIND")[0],401)
        for method in ("PUT","POST","MOVE","COPY","DELETE","MKCOL","PROPPATCH","LOCK"):
            with self.subTest(method=method):self.assertEqual(self.request(first+"/Folder/report.txt",method)[0],405)
        self.stage.assert_not_called();self.loader.assert_not_called()

    def test_deleted_or_replaced_archive_is_not_served_from_retained_cache(self):
        node=self.tree.resolve(("Folder","report.txt"))
        self.items=[item for item in self.items if item["key"]!=self.file]
        with self.assertRaises(FileNotFoundError):
            with self.tree.open_file(node):pass
        self.stage.assert_not_called()

    def test_low_space_failure_and_traversal_never_return_file_contents(self):
        url=self.server();self.stage.side_effect=RuntimeError("Not enough local space for this archive restore")
        status,headers,data=self.request(url+"/Folder/report.txt")
        self.assertEqual(status,507);self.assertNotIn(self.payload,data)
        self.assertEqual(self.request(url+"/%2e%2e/outside")[0],400)

    def record(self,receiver=None,workspace=None):
        root=mounts.context_root(receiver or self.receiver,workspace or self.workspace)
        (root/"mount").mkdir(mode=0o700)
        value=dict(schema=1,receiverId=root.parent.name,workspaceId=root.name,mountPath=str(root/"mount"),name="Fixture note",revision=7,
                   daemonPid=100,daemonIdentity={"pid":100},nativePid=200,nativeIdentity={"pid":200})
        mounts.write_registry(root,value);return root,value

    def test_multiple_account_note_namespaces_and_orphan_status_are_conservative(self):
        first,_=self.record();second,_=self.record(workspace="c"*32);third,_=self.record(receiver="d"*64)
        self.assertEqual(len({str(first),str(second),str(third)}),3)
        with patch.object(mounts.os.path,"ismount",return_value=True),patch.object(mounts.lifecycle,"process_identity",side_effect=lambda pid:{"pid":pid}):
            result=mounts.status();self.assertEqual(len(result["mounts"]),3)
            self.assertTrue(all(record["state"]=="mounted" for record in result["mounts"]))
        with patch.object(mounts.os.path,"ismount",return_value=True),patch.object(mounts.lifecycle,"process_identity",return_value=None):
            self.assertTrue(all(record["state"]=="orphaned" for record in mounts.status()["mounts"]))
        (first/"registry.json").chmod(0o644)
        self.assertTrue(mounts.status()["unknownMounts"])

    def test_linked_registry_and_foreign_note_metadata_are_rejected(self):
        root,record=self.record();target=self.home/"original";target.write_bytes(b"original remains")
        (root/"registry.json").unlink();(root/"registry.json").symlink_to(target)
        with self.assertRaises(OSError):mounts.read_registry(root)
        self.assertEqual(target.read_bytes(),b"original remains")
        self.items[0]["workspace"]="c"*32
        with self.assertRaises(ValueError):mounts.WorkspaceTree(self.config,self.client,self.authorize,self.stage,self.loader)

    def test_unmount_retains_active_reads_resources_and_reused_process_identity(self):
        record={"mountPid":300,"mountIdentity":{"pid":300,"started":"original"}};point=self.home/"owned-mount"
        with patch.object(mounts.lifecycle,"cache_users",return_value=[]),patch.object(mounts.os.path,"ismount",return_value=True), \
                patch.object(mounts.subprocess,"run") as unmount:
            self.tree.active_reads=1
            with self.assertRaises(RuntimeError):mounts.stop_owned_mount(record,self.tree,point)
            self.tree.active_reads=0
            with patch.object(mounts.lifecycle,"cache_users",return_value=[800]):
                with self.assertRaises(RuntimeError):mounts.stop_owned_mount(record,self.tree,point)
            with patch.object(mounts.lifecycle,"process_identity",return_value={"pid":300,"started":"reused"}):
                with self.assertRaises(RuntimeError):mounts.stop_owned_mount(record,self.tree,point)
            unmount.assert_not_called()

    @unittest.skipUnless(sys.platform=="darwin" and os.environ.get("GENDRAGOON_NFS_SMOKE")=="1","explicit isolated macOS NFS smoke required")
    def test_real_nfs_mount_of_authenticated_dav_reads_generated_bytes_and_rejects_writes(self):
        import fcntl
        support=Path.home()/"Library/Application Support/GenDragoon Cloud SSD"
        state=support/"UploadWorkspace/state.json"
        if state.is_file() and json.loads(state.read_bytes()).get("active_job_id") is not None:self.skipTest("A protected upload is active")
        gate=(support/"AutoUpdates/update.lock").open("rb")
        self.addCleanup(gate.close)
        try:fcntl.flock(gate,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:self.skipTest("Protected maintenance is active")
        url=self.server();point=self.home/"nfs-fixture";point.mkdir()
        environment=os.environ.copy();environment.update(RCLONE_WEBDAV_URL=url+"/",RCLONE_WEBDAV_VENDOR="other",RCLONE_WEBDAV_BEARER_TOKEN="private-loopback-capability")
        rclone=os.environ.get("GENDRAGOON_RCLONE","/Applications/GenDragoon Cloud SSD.app/Contents/Resources/rclone")
        process=subprocess.Popen([rclone,"--config","/dev/null","nfsmount",":webdav:",str(point),"--read-only","--vfs-cache-mode=off",
            "--addr=127.0.0.1:0","--nfs-cache-type=memory","--dir-cache-time=0s","--attr-timeout=0s","--dir-perms=0700","--file-perms=0400"],
            stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,env=environment)
        try:
            for unused in range(150):
                if os.path.ismount(point) or process.poll() is not None:break
                time.sleep(.1)
            self.assertTrue(os.path.ismount(point),"The generated DAV fixture did not become an actual NFS mount")
            self.assertEqual((point/"Folder/report.txt").read_bytes(),self.payload)
            with self.assertRaises(OSError):(point/"should-not-write").write_bytes(b"generated fixture")
            self.assertGreater(self.authorize.call_count,0)
        finally:
            if os.path.ismount(point):subprocess.run(["/sbin/umount",str(point)],capture_output=True,timeout=20)
            if os.path.ismount(point):
                self._cleanups=[item for item in self._cleanups if item[0]!=self.temp.cleanup]
                self.temp._finalizer.detach()
                self.fail("Generated fixture remains mounted for safe review: "+str(point))
            for unused in range(30):
                if process.poll() is not None:break
                time.sleep(.1)
            if process.poll() is None:process.terminate()
            process.wait(timeout=5)


if __name__=="__main__":unittest.main()
