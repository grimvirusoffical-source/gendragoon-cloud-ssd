"""Owned-host control safety and actual disposable WinFsp handle lifetime gates."""
import contextlib
import io
import http.server
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock,patch

import test_workspace_drives as fixture
platform=fixture.platform
mounts=fixture.mounts

MAPPED_READER=r'''
import hashlib,json,mmap,os,sys
source=open(sys.argv[1],"rb")
view=None
address=None
mapping=None
try:
    if sys.platform=="win32":
        import ctypes,msvcrt
        from ctypes import wintypes
        kernel=ctypes.WinDLL("kernel32",use_last_error=True)
        kernel.CreateFileMappingW.argtypes=[wintypes.HANDLE,ctypes.c_void_p,wintypes.DWORD,wintypes.DWORD,wintypes.DWORD,wintypes.LPCWSTR]
        kernel.CreateFileMappingW.restype=wintypes.HANDLE
        kernel.MapViewOfFile.argtypes=[wintypes.HANDLE,wintypes.DWORD,wintypes.DWORD,wintypes.DWORD,ctypes.c_size_t]
        kernel.MapViewOfFile.restype=ctypes.c_void_p
        kernel.CloseHandle.argtypes=[wintypes.HANDLE]
        kernel.CloseHandle.restype=wintypes.BOOL
        kernel.UnmapViewOfFile.argtypes=[ctypes.c_void_p]
        kernel.UnmapViewOfFile.restype=wintypes.BOOL
        size=os.fstat(source.fileno()).st_size
        if size<=0:raise ValueError("A nonempty fixture is required")
        mapping=kernel.CreateFileMappingW(msvcrt.get_osfhandle(source.fileno()),None,0x02,0,0,None)
        if not mapping:raise ctypes.WinError(ctypes.get_last_error())
        address=kernel.MapViewOfFile(mapping,0x04,0,0,size)
        if not address:raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.CloseHandle(mapping):raise ctypes.WinError(ctypes.get_last_error())
        mapping=None
        source.close()
        backend="win32-view-only";mapping_closed=True
        def read_view():return ctypes.string_at(address,size)
    else:
        view=mmap.mmap(source.fileno(),0,access=mmap.ACCESS_READ)
        source.close()
        backend="python-mmap";mapping_closed=None
        def read_view():return view[:]
    def report_view():
        value=read_view()
        print(json.dumps({"schema":1,"pid":os.getpid(),"originalClosed":source.closed,
            "mappingHandleClosed":mapping_closed,"backend":backend,"size":len(value),
            "sha256":hashlib.sha256(value).hexdigest()}),flush=True)
    report_view()
    while True:
        command=sys.stdin.buffer.readline(17)
        if not command:break
        if command!=b"read\n":raise ValueError("Invalid fixture command")
        report_view()
finally:
    if not source.closed:source.close()
    if mapping and not kernel.CloseHandle(mapping):raise ctypes.WinError(ctypes.get_last_error())
    if address and not kernel.UnmapViewOfFile(address):raise ctypes.WinError(ctypes.get_last_error())
    if view is not None:view.close()
'''

@contextlib.contextmanager
def mapped_reader(path):
    # A page fault in mmap[:] holds CPython's GIL. The DAV server must run in
    # another interpreter, just as it does when a separate user app maps a drive.
    environment={k:v for k,v in os.environ.items() if k in
        ("SystemRoot","SYSTEMROOT","WINDIR","PATH","TEMP","TMP","TMPDIR","LANG","LC_ALL")}
    process=subprocess.Popen([sys.executable,"-I","-B","-u","-c",MAPPED_READER,str(path)],
        stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,env=environment)
    threads=[]
    def reply():
        replies=queue.Queue(maxsize=1)
        thread=threading.Thread(target=lambda:replies.put(process.stdout.readline(4097)),daemon=True);thread.start();threads.append(thread)
        try:raw=replies.get(timeout=20)
        except queue.Empty:raise AssertionError("The independent mapped-file reader did not become ready.")
        if not raw.endswith("\n") or len(raw)>4096:raise AssertionError("The mapped-file reader returned invalid metadata.")
        value=json.loads(raw)
        if (not isinstance(value,dict) or set(value)!={"schema","pid","originalClosed","mappingHandleClosed","backend","size","sha256"}
                or value.get("schema")!=1 or value.get("pid")!=process.pid or value.get("originalClosed") is not True
                or value.get("backend")!=("win32-view-only" if sys.platform=="win32" else "python-mmap")
                or value.get("mappingHandleClosed") is not (True if sys.platform=="win32" else None)):
            raise AssertionError("The mapped-file reader did not retain an independent mapped view.")
        return value
    def reread():
        process.stdin.write("read\n");process.stdin.flush()
        return reply()
    try:
        yield reply(),process,reread
    finally:
        # EOF is the reader's explicit normal-close request. Never terminate or
        # signal a held mapped view to manufacture a successful unmount.
        process.stdin.close()
        try:process.wait(timeout=20)
        except subprocess.TimeoutExpired:raise AssertionError("The mapped-file reader did not close normally.")
        for thread in threads:thread.join(timeout=1)
        process.stdout.close()
        if process.returncode!=0:raise AssertionError("The independent mapped-file reader failed.")

class HostControlTests(unittest.TestCase):
    def test_mapped_reader_is_independent_preserves_bytes_and_closes_normally(self):
        with tempfile.TemporaryDirectory() as temporary:
            path=Path(temporary)/"mapped-fixture.bin";payload=b"Verified independent mapped bytes"*1024;path.write_bytes(payload)
            with mapped_reader(path) as (value,process,reread):
                self.assertNotEqual(value["pid"],os.getpid());self.assertIsNone(process.poll())
                self.assertEqual(value["size"],len(payload));self.assertEqual(value["sha256"],fixture.hashlib.sha256(payload).hexdigest())
                self.assertEqual(reread(),value);self.assertIsNone(process.poll())
            self.assertEqual(process.returncode,0);self.assertEqual(path.read_bytes(),payload)

    def test_real_control_http_is_local_authenticated_bounded_and_never_redirected(self):
        observed=[];reply={"status":200,"body":b'{"schema":1,"state":"mounted"}'}
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*_):pass
            def do_POST(self):
                self.server.body=self.rfile.read(int(self.headers.get("Content-Length",0)))
                self.do_GET()
            def do_GET(self):
                observed.append((self.path,self.headers.get("Authorization"),self.headers.get("Host")))
                self.send_response(reply["status"])
                if reply["status"]==302:self.send_header("Location","http://untrusted.invalid:54321/secret")
                self.send_header("Content-Length",str(len(reply["body"])));self.end_headers();self.wfile.write(reply["body"])
        server=http.server.ThreadingHTTPServer(("127.0.0.1",0),Handler)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        process=SimpleNamespace(_gd_host_url="http://127.0.0.1:"+str(server.server_port),_gd_host_control="ephemeral-local-only")
        try:
            self.assertEqual(platform.host_request(process,"/v1/status")["state"],"mounted")
            self.assertEqual(observed,[("/v1/status","Bearer ephemeral-local-only","127.0.0.1:"+str(server.server_port))])
            reply.update(body=b'{"schema":1,"status":"trim-requested","requested":1}')
            self.assertEqual(platform.host_request(process,"/v1/cache/trim","POST")["status"],"trim-requested")
            self.assertEqual(server.body,b"{}");self.assertEqual(observed[-1][0],"/v1/cache/trim")
            for method,route in (("GET","/v1/cache/trim"),("POST","/v1/cache/trim/"),("POST","/v1/cache/trim?force=true")):
                with self.assertRaises(platform.PlatformMountError):platform.host_request(process,route,method)
            for status,body in ((409,b"private-error"),(503,b"private-error"),(302,b""),(200,b"x"*4097),(200,b'{"schema":2}')):
                reply.update(status=status,body=body)
                with self.subTest(status=status),self.assertRaises(platform.PlatformMountError) as failure:platform.host_request(process,"/v1/status")
                self.assertNotIn("private-error",str(failure.exception));self.assertNotIn("ephemeral-local-only",str(failure.exception))
            self.assertEqual(len(observed),7)
        finally:server.shutdown();server.server_close();thread.join(timeout=2)

    def test_old_windows_cli_mount_cannot_start_new_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            binary=Path(temporary)/"rclone.exe";binary.write_bytes(b"fixture")
            tools={"rclone":str(binary),"sha256":fixture.hashlib.sha256(binary.read_bytes()).hexdigest()}
            with patch.object(platform,"sys",SimpleNamespace(platform="win32")),patch.object(platform,"trusted_binary",return_value=str(binary)),patch.object(platform.subprocess,"Popen") as spawn:
                with self.assertRaisesRegex(platform.PlatformMountError,"disabled"):
                    platform.start(tools,{"mountPath":"Z:\\","label":"Fixture"},"http://127.0.0.1:12345/","local-only",Path(temporary))
                spawn.assert_not_called()

    def test_ready_requires_exact_process_drive_and_loopback_origin(self):
        security,_,_=fixture.PlatformTests.windows_security_fixture()
        with tempfile.TemporaryDirectory() as temporary:
            binary=Path(temporary)/"GenDragoonMountHost.exe";binary.write_bytes(b"fixture")
            tools={"rclone":str(binary),"sha256":fixture.hashlib.sha256(binary.read_bytes()).hexdigest(),"backend":"owned-host"}
            for change in ({},{"pid":999},{"mountPoint":"Y:"},{"controlURL":"http://evil.invalid:12345"},{"controlURL":"http://127.0.0.1:65536"},{"readOnly":False}):
                ready=dict(schema=1,status="ready",pid=123,mountPoint="Z:",controlURL="http://127.0.0.1:12345",readOnly=True);ready.update(change)
                process=SimpleNamespace(pid=123,stdout=io.BytesIO(json.dumps(ready).encode()+b"\n"),stderr=io.BytesIO())
                with self.subTest(change=change),patch.dict(sys.modules,{"gendragoon_platform_ipc":security}),patch.object(platform,"sys",SimpleNamespace(platform="win32")),patch.object(platform,"trusted_binary",return_value=str(binary)),patch.object(platform.subprocess,"CREATE_NO_WINDOW",0,create=True),patch.object(platform.subprocess,"Popen",return_value=process):
                    platform.start(tools,{"mountPath":"Z:\\","label":"Fixture"},"http://127.0.0.1:12346/","local-only",Path(temporary))
                    for reader in process._gd_diagnostic_readers:reader.join(timeout=1)
                    self.assertEqual(platform.ready(process),not bool(change))

    def test_busy_or_uncertain_host_cannot_enter_legacy_or_kill_paths(self):
        record={"mountPath":"Z:\\","label":"Fixture","tools":{"backend":"owned-host"},"process":{"pid":123}}
        process=MagicMock();process.poll.return_value=None
        with patch.object(platform,"sys",SimpleNamespace(platform="win32")),patch.object(platform,"process_matches",return_value=True),patch.object(platform,"mounted",return_value=True),patch.object(platform,"host_request",side_effect=platform.PlatformMountError("busy")) as request,patch.object(platform,"_windows_dismount") as legacy,patch.object(platform,"_quit") as quit:
            with self.assertRaises(platform.PlatformMountError):platform.unmount(record,process)
            request.assert_called_once_with(process,"/v1/unmount","POST");legacy.assert_not_called();quit.assert_not_called()
            process.terminate.assert_not_called();process.kill.assert_not_called();process.send_signal.assert_not_called()

    def test_new_host_and_legacy_volume_identities_cannot_be_substituted(self):
        record={"mountPath":"Z:\\","label":"Fixture","volumeSerial":123,"tools":{"backend":"owned-host"}}
        with patch.object(platform,"sys",SimpleNamespace(platform="win32")):
            for filesystem in ("FUSE-rclone","NTFS","FUSE-Other"):
                with self.subTest(filesystem=filesystem),patch.object(platform,"_windows_volume",return_value=("Fixture",filesystem,123)):
                    self.assertIsNone(platform.mounted(record))
                    with self.assertRaises(platform.PlatformMountError):platform.capture_mount_identity(record)
            with patch.object(platform,"_windows_volume",return_value=("Fixture","FUSE-GDHost",123)):
                self.assertIs(platform.mounted(record),True);self.assertEqual(platform.capture_mount_identity(record),{"volumeSerial":123})

@unittest.skipUnless(sys.platform=="win32","Actual Windows WinFsp driver tests")
class ActualOwnedHostTests(unittest.TestCase):
    def setUp(self):
        if not os.environ.get("GD_TEST_MOUNT_HOST"):
            if os.environ.get("GD_REQUIRE_MOUNT_HOST"):self.fail("The owned mount-host executable is mandatory in this gate")
            self.skipTest("A separately built public mount host is required")
        fixture.ActualArchiveTests.setUp(self)

    def test_real_multiple_note_drives_retain_independent_identity_and_lifetime(self):
        self.model.selected_note=fixture.OTHER
        other=self.root/"other-note.txt";other.write_bytes(b"Only the second MachineNote")
        self.model.upload(other)
        manager=mounts.WorkspaceMountManager(self.model.root);records=[]
        try:
            for note in (fixture.NOTE,fixture.OTHER):records.append(manager.mount(self.model,note,os.environ["GD_TEST_MOUNT_HOST"]))
            first,second=records
            self.assertNotEqual(first["mountPath"],second["mountPath"])
            a,b=(manager.live[record["id"]][3] for record in records)
            self.assertNotEqual(a._gd_host_url,b._gd_host_url);self.assertNotEqual(a._gd_host_control,b._gd_host_control)
            self.assertEqual((Path(first["mountPath"])/self.source.name).read_bytes(),self.payload)
            self.assertEqual((Path(second["mountPath"])/other.name).read_bytes(),b"Only the second MachineNote")
            self.assertFalse((Path(first["mountPath"])/other.name).exists())
            self.assertFalse((Path(second["mountPath"])/self.source.name).exists())
            deadline=time.monotonic()+10
            while True:
                try:manager.unmount(first["id"]);break
                except platform.PlatformMountError:
                    if time.monotonic()>=deadline:raise
                    time.sleep(.05)
            self.assertEqual(a.returncode,0)
            self.assertIs(platform.mounted(second),True)
            self.assertEqual((Path(second["mountPath"])/other.name).read_bytes(),b"Only the second MachineNote")
        finally:
            for record in records:
                if record["id"] not in manager.live:continue
                deadline=time.monotonic()+10
                while True:
                    try:manager.unmount(record["id"]);break
                    except platform.PlatformMountError:
                        if time.monotonic()>=deadline:raise
                        time.sleep(.05)

    def test_real_read_duplicate_mapping_directory_and_admission_race(self):
        import ntsecuritycon,win32api,win32con,win32file
        checks=[];mapped_proof={};native_status={};cleanup={};stage="mount";failed=False
        manager=mounts.WorkspaceMountManager(self.model.root);record=None
        report=Path(os.environ["GD_MOUNT_HOST_REPORT"]) if os.environ.get("GD_MOUNT_HOST_REPORT") else None
        def emit(state):
            if report:report.write_text(json.dumps({"schema":1,"platform":sys.platform,"mount":state,"checks":checks,
                "mappedView":mapped_proof,"stage":stage,"nativeStatus":native_status,"cleanup":cleanup}),encoding="utf-8")
        def capture_status(process):
            value=platform.host_request(process,"/v1/status")
            native_status.clear()
            if value.get("state") in ("mounted","quiescing","unmounted"):native_status["state"]=value["state"]
            if type(value.get("fault")) is bool:native_status["fault"]=value["fault"]
            for key in ("openFiles","openDirectories","pending","inflight","closeFailures"):
                count=value.get(key)
                if type(count) is int and 0<=count<=1000000:native_status[key]=count
            return native_status
        def wait_closed(process):
            # Explicit POST-only native maintenance. A queued invalidation is
            # not a close proof; the unchanged lifetime counters must reach 0.
            trim=platform.host_request(process,"/v1/cache/trim","POST")
            self.assertEqual(trim.get("status"),"trim-requested")
            self.assertIs(type(trim.get("requested")),int);self.assertTrue(0<=trim["requested"]<=1024)
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                state=capture_status(process)
                if not any(state.get(k,-1) for k in ("openFiles","openDirectories","pending","inflight")):return
                time.sleep(.05)
            self.fail("Native handles did not close within the bounded gate at "+stage+": "+json.dumps(native_status,sort_keys=True))
        def busy():
            with self.assertRaises(platform.PlatformMountError):manager.unmount(record["id"])
            self.assertIs(platform.mounted(record),True)
        try:
            record=manager.mount(self.model,fixture.NOTE,os.environ["GD_TEST_MOUNT_HOST"])
            process=manager.live[record["id"]][3];path=Path(record["mountPath"])/self.source.name
            stage="held-read"
            with path.open("rb") as source:
                self.assertEqual(source.read(),self.payload);busy()
            checks.extend(("genuine-encrypted-read","held-read-refused"));stage="held-read-close";wait_closed(process)
            # DuplicateHandle retains the same native file object after the
            # original Python handle closes. Release must wait for native Close.
            stage="duplicate-handle";source=path.open("rb");current=win32api.GetCurrentProcess()
            import msvcrt
            duplicate=win32api.DuplicateHandle(current,msvcrt.get_osfhandle(source.fileno()),current,0,False,win32con.DUPLICATE_SAME_ACCESS)
            source.close()
            try:busy()
            finally:duplicate.Close()
            checks.append("duplicate-handle-refused");stage="duplicate-handle-close";wait_closed(process)
            stage="mapped-view"
            with mapped_reader(path) as (mapped,reader,reread):
                self.assertEqual(mapped["backend"],"win32-view-only")
                self.assertIs(mapped["originalClosed"],True);self.assertIs(mapped["mappingHandleClosed"],True)
                mapped_proof.update({key:mapped[key] for key in ("backend","originalClosed","mappingHandleClosed")})
                self.assertEqual(mapped["size"],len(self.payload));self.assertEqual(mapped["sha256"],fixture.hashlib.sha256(self.payload).hexdigest())
                self.assertIsNone(reader.poll());busy()
                trim=platform.host_request(process,"/v1/cache/trim","POST")
                self.assertEqual(trim.get("status"),"trim-requested")
                self.assertIs(type(trim.get("requested")),int);self.assertTrue(1<=trim["requested"]<=1024)
                self.assertEqual(reread(),mapped);self.assertIsNone(reader.poll());busy()
                mapped_proof["readableAfterTrim"]=True
            self.assertEqual(reader.returncode,0)
            checks.append("mapped-view-refused");stage="mapped-view-close";wait_closed(process)
            stage="directory-handle"
            directory=win32file.CreateFile(record["mountPath"],ntsecuritycon.FILE_READ_ATTRIBUTES|ntsecuritycon.FILE_LIST_DIRECTORY,
                win32con.FILE_SHARE_READ|win32con.FILE_SHARE_WRITE|win32con.FILE_SHARE_DELETE,None,win32con.OPEN_EXISTING,win32con.FILE_FLAG_BACKUP_SEMANTICS,None)
            try:busy()
            finally:directory.Close()
            checks.append("directory-handle-refused");stage="directory-handle-close";wait_closed(process)
            # Concurrent native opens retain every successful handle until the
            # unmount response. An accepted unmount must deny all racing opens.
            stage="concurrent-open";barrier=threading.Barrier(9);release=threading.Event();opened=[];errors=[];lock=threading.Lock()
            def race_open():
                barrier.wait()
                try:
                    value=path.open("rb")
                    with lock:opened.append(value)
                    release.wait(25)
                    value.close()
                except OSError:
                    with lock:errors.append("denied")
            threads=[threading.Thread(target=race_open) for _ in range(8)]
            for thread in threads:thread.start()
            barrier.wait();unmounted=False
            try:
                try:manager.unmount(record["id"]);unmounted=True
                except platform.PlatformMountError:self.assertIs(platform.mounted(record),True)
                if unmounted:self.assertFalse(opened,"No successful racing open may survive an accepted unmount")
            finally:
                release.set()
                for thread in threads:thread.join(timeout=25)
            self.assertFalse(any(thread.is_alive() for thread in threads));self.assertEqual(len(opened)+len(errors),8)
            checks.append("atomic-open-unmount-race")
            stage="normal-unmount"
            if not unmounted:wait_closed(process);manager.unmount(record["id"])
            self.assertFalse(manager.has_mounts);self.assertEqual(process.returncode,0);self.assertEqual(self.source.read_bytes(),self.payload)
            checks.append("normal-unmount");emit("verified")
        except Exception:failed=True;emit("failed");raise
        finally:
            # Cleanup uses the same normal gate. Never kill, signal or force a
            # failed candidate just to make the test or workflow appear green.
            try:
                if record and manager.has_mounts:manager.unmount(record["id"])
            except Exception:
                cleanup["status"]="retained"
                if record and record["id"] in manager.live:
                    try:capture_status(manager.live[record["id"]][3])
                    except Exception:cleanup["nativeStatus"]="unavailable"
                emit("failed")
                if not failed:raise

if __name__=="__main__":unittest.main()
