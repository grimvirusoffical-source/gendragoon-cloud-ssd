"""Real worker lifetime/transactions with disposable bundles and OS adapters.

Apple services and Darwin process queries are fixtures here. The worker's pipe,
private copied sources, shared lock, parent exit, stage hashes, file replacement,
rollback and observed child-process lifetime are exercised by production code.
"""
from contextlib import ExitStack
import hashlib
import importlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

RESOURCE = Path(__file__).resolve().parents[1] / "Resources"
sys.path.insert(0, str(RESOURCE))
worker = importlib.import_module("gendragoon_update_restart")
worker.load_runtime(RESOURCE)
auto, control = worker.auto, worker.control


def bundle(app, version, build):
    (app / "Contents/MacOS").mkdir(parents=True)
    (app / "Contents/Info.plist").write_bytes(plistlib.dumps({
        "CFBundleIdentifier":auto.BUNDLE_ID,"CFBundleShortVersionString":version,
        "CFBundleVersion":str(build),"CFBundleExecutable":"GenDragoon Cloud SSD"}))
    binary = app / "Contents/MacOS/GenDragoon Cloud SSD"
    binary.write_bytes(b"disposable fixture; never executed")
    binary.chmod(0o755)


class RestartWorkerTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        temporary = self.stack.enter_context(tempfile.TemporaryDirectory(prefix="gd-restart-fixture-"))
        self.home = Path(temporary).resolve()
        self.app = self.home / "Applications" / auto.APP_NAME
        bundle(self.app, "0.17.0", 22)
        self.resources = self.app / "Contents/Resources"
        self.resources.mkdir()
        for name in worker.DEPENDENCIES:
            source = (RESOURCE.parent / "Backend/performance_profiles.json"
                      if name == "gendragoon_performance_profiles.json" else RESOURCE / name)
            shutil.copyfile(source, self.resources / name)
        self.support = self.home / "Library/Application Support/GenDragoon Cloud SSD"
        self.root = self.support / "AutoUpdates"
        for name, value in {"APP":self.app,"ROOT":self.root,"STAGED":self.root/"pending",
                            "STATUS":self.root/"status.json","LOG":self.root/"updater.log","CHANNEL":"stable"}.items():
            self.stack.enter_context(mock.patch.object(auto, name, value))
        self.stack.enter_context(mock.patch.dict(os.environ, {"HOME":str(self.home)}))
        bundle(auto.STAGED / auto.APP_NAME, "0.18.0", 23)
        stage = {"version":"v0.18.0","build":23,"channel":"stable","sha256":"a"*64,
                 "bundleDigest":auto.bundle_digest(auto.STAGED/auto.APP_NAME)}
        (auto.STAGED / "pending.json").write_text(json.dumps(stage))
        (auto.STAGED / "pending.json").chmod(0o600)
        self.identity = control.ProcessIdentity(4001, str(auto.app_executable(self.app)), "fixture start")

    def snapshot(self, pid=4001):
        identity = control.ProcessIdentity(pid, self.identity.executable, self.identity.started)
        with mock.patch.object(worker, "__file__", str(self.resources / "gendragoon_update_restart.py")), \
             mock.patch.object(control, "require_mac"), mock.patch.object(worker, "verify_parent", return_value=identity), \
             mock.patch.object(auto, "validate_app"), mock.patch.object(worker, "ensure_quiet"), \
             mock.patch.object(worker, "primary_mount", return_value=None):
            return worker.retained_request(self.app, pid, "stable")

    def test_private_snapshot_contains_only_fixed_bundled_sources_and_rejects_tampering(self):
        directory, receipt = self.snapshot()
        self.assertEqual(set(receipt["sources"]), set(worker.DEPENDENCIES))
        self.assertEqual(worker.verify_snapshot(directory), receipt)
        self.assertEqual(directory.stat().st_mode & 0o077, 0)
        (directory / "gendragoon_library.py").write_text("changed")
        with self.assertRaisesRegex(RuntimeError, "changed"):
            worker.verify_snapshot(directory)
        self.assertEqual(auto.version_of(self.app), "0.17.0")

    def test_missing_or_linked_worker_dependency_is_rejected(self):
        directory, _ = self.snapshot()
        helper = directory / "gendragoon_performance_profiles.json"
        helper.unlink()
        helper.symlink_to(self.resources / helper.name)
        with self.assertRaisesRegex(RuntimeError, "linked"):
            worker.verify_snapshot(directory)

    def test_dirty_unknown_and_linked_cache_metadata_block(self):
        path = self.support / "Cache/vfsMeta/remote/bucket/item"
        path.parent.mkdir(parents=True)
        for value in ({"Dirty":True}, {}, {"Dirty":"false"}):
            path.write_text(json.dumps(value))
            with self.assertRaisesRegex(RuntimeError, "Unsynced or unknown"):
                worker.ensure_clean_cache(self.support)
        path.write_text('{"Dirty":false}')
        self.assertEqual(worker.ensure_clean_cache(self.support), 1)
        path.unlink();path.symlink_to(self.resources / "gendragoon_library.py")
        with self.assertRaisesRegex(RuntimeError, "linked"):
            worker.ensure_clean_cache(self.support)

    def test_nested_session_dirty_metadata_blocks(self):
        path = self.support / "LaunchSessions" / ("a"*32) / "vfs/vfsMeta/remote/item"
        path.parent.mkdir(parents=True)
        path.write_text('{"Dirty":true}')
        with self.assertRaisesRegex(RuntimeError, "Unsynced or unknown"):
            worker.ensure_clean_cache(self.support)

    def test_real_queued_upload_state_blocks_without_changing_it(self):
        workspace=importlib.import_module("gendragoon_upload_workspace")
        source=self.home/"keep-original.txt";source.write_text("original")
        selected=workspace.selected_source(str(source))
        destination=workspace.destination_record("fixture-project","fixture-bucket","gendragoon")
        state=workspace.fresh_state()
        state["jobs"]=[{"id":"a"*32,"state":"queued","offload":False,"destination":destination,
                        "sources":[selected],"items":[{"source_id":selected["id"],"state":"pending"}]}]
        workspace.validate_state(state)
        path=self.support/"UploadWorkspace/state.json";path.parent.mkdir(parents=True)
        path.write_text(json.dumps(state));path.chmod(0o600)
        before=path.read_bytes()
        with self.assertRaisesRegex(RuntimeError,"queued or running"):worker.ensure_queue_idle(self.support)
        with self.quiet_environment():
            with self.assertRaisesRegex(RuntimeError,"queued or running"):
                worker.ensure_quiet(self.app,parent=self.identity)
        self.assertEqual(path.read_bytes(),before)
        self.assertEqual(source.read_text(),"original")

    def test_open_files_and_active_managed_app_defer_before_any_signal(self):
        for active,opened in ((True,[]),(False,[(888,str(self.support/"Cache/vfs/working"))])):
            with self.subTest(active=active),mock.patch.object(control,"ensure_idle"), \
                 mock.patch.object(control,"processes",return_value=[]), \
                 mock.patch.object(worker.launcher,"sessions",return_value={"active":active}), \
                 mock.patch.object(worker.launcher,"open_files",return_value=opened), \
                 mock.patch.object(worker.os,"kill") as signal_app:
                with self.assertRaises(RuntimeError):worker.ensure_quiet(self.app)
                signal_app.assert_not_called()

    def quiet_environment(self):
        stack = ExitStack()
        for patch in (mock.patch.object(control, "ensure_idle"),
                      mock.patch.object(control, "processes", return_value=[]),
                      mock.patch.object(control, "identify", return_value=self.identity),
                      mock.patch.object(worker.launcher, "sessions", return_value={"active": False}),
                      mock.patch.object(worker.launcher, "open_files", return_value=[])):
            stack.enter_context(patch)
        return stack

    def test_bundle_reader_may_finish_with_exact_parent_but_blocks_after_quit(self):
        before = auto.bundle_digest(self.app)
        opened = [(888, str(auto.app_executable(self.app)))]
        with self.quiet_environment(), \
             mock.patch.object(worker.launcher, "open_files", return_value=opened), \
             mock.patch.object(worker.os, "kill") as signal_process:
            worker.ensure_quiet(self.app, parent=self.identity)
            with self.assertRaisesRegex(RuntimeError, "files are still open"):
                worker.ensure_quiet(self.app)
            signal_process.assert_not_called()
        self.assertEqual(auto.bundle_digest(self.app), before)

    def test_prequit_keeps_cloud_cache_session_helper_and_dirty_guards(self):
        with self.quiet_environment(), mock.patch.object(worker.os, "kill") as signal_process:
            for path in (self.support / "Cache/vfs/working", self.support / "LaunchSessions/working",
                         self.home / "GenDragoon Cloud SSD/cloud-file"):
                with self.subTest(path=path), \
                     mock.patch.object(worker.launcher, "open_files", return_value=[(888, str(path))]):
                    with self.assertRaisesRegex(RuntimeError, "files are still open"):
                        worker.ensure_quiet(self.app, parent=self.identity)
            with mock.patch.object(worker.launcher, "sessions", return_value={"active": True}):
                with self.assertRaisesRegex(RuntimeError, "session or cloud mount"):
                    worker.ensure_quiet(self.app, parent=self.identity)
            with mock.patch.object(control, "processes", return_value=[(888, 1, os.getuid(), "gendragoon_library.py upload")]):
                with self.assertRaisesRegex(RuntimeError, "file operation is active"):
                    worker.ensure_quiet(self.app, parent=self.identity)
            metadata = self.support / "Cache/vfsMeta/remote/dirty"
            metadata.parent.mkdir(parents=True)
            metadata.write_text('{"Dirty":true}')
            with self.assertRaisesRegex(RuntimeError, "Unsynced or unknown"):
                worker.ensure_quiet(self.app, parent=self.identity)
            signal_process.assert_not_called()

    def test_prequit_parent_identity_change_cannot_defer_bundle_guard(self):
        changed = control.ProcessIdentity(self.identity.pid, self.identity.executable, "reused PID")
        with self.quiet_environment(), mock.patch.object(control, "identify", return_value=changed), \
             mock.patch.object(worker.launcher, "open_files") as opened:
            with self.assertRaisesRegex(RuntimeError, "identity changed"):
                worker.ensure_quiet(self.app, parent=self.identity)
            opened.assert_not_called()

    def test_worker_requires_bundle_readers_closed_after_parent_exit_before_install(self):
        directory, receipt = self.snapshot()
        before = auto.bundle_digest(self.app)
        read_fd, write_fd = os.pipe()
        with self.quiet_environment(), \
             mock.patch.object(worker, "load_runtime"), mock.patch.object(control, "require_mac"), \
             mock.patch.object(worker, "verify_parent", return_value=self.identity), \
             mock.patch.object(auto, "validate_app"), mock.patch.object(auto, "app_pids", return_value=[]), \
             mock.patch.object(worker, "quiesce_primary"), mock.patch.object(worker, "wait_for_parent") as waited, \
             mock.patch.object(worker.launcher, "open_files", return_value=[(888, str(auto.app_executable(self.app)))]), \
             mock.patch.object(auto, "install_worker") as install:
            self.assertEqual(worker.run_worker(directory, write_fd), 1)
            waited.assert_called_once()
            install.assert_not_called()
        acknowledgement = json.loads(os.read(read_fd, 8192));os.close(read_fd)
        self.assertEqual(acknowledgement["state"], "scheduled")
        self.assertEqual(json.loads(auto.STATUS.read_text())["state"], "postponed")
        self.assertEqual(auto.bundle_digest(self.app), before)

    def test_changed_stage_fails_worker_before_ack_or_parent_wait(self):
        directory,receipt=self.snapshot()
        (auto.STAGED/auto.APP_NAME/"Contents/MacOS/GenDragoon Cloud SSD").write_bytes(b"changed")
        read_fd,write_fd=os.pipe()
        with mock.patch.object(worker,"load_runtime"),mock.patch.object(control,"require_mac"), \
             mock.patch.object(worker,"verify_parent",return_value=self.identity),mock.patch.object(auto,"validate_app"), \
             mock.patch.object(worker,"wait_for_parent") as wait, mock.patch.object(worker,"quiesce_primary") as quiesce:
            self.assertEqual(worker.run_worker(directory,write_fd),1)
        record=json.loads(os.read(read_fd,4096));os.close(read_fd)
        self.assertEqual(record["state"],"failed")
        wait.assert_not_called();quiesce.assert_not_called()
        self.assertEqual(auto.version_of(self.app),"0.17.0")

    def test_packaging_requires_restart_and_profile_resources(self):
        spec=importlib.util.spec_from_file_location("fixture_package",RESOURCE.parent/"package_macos.py")
        package=importlib.util.module_from_spec(spec);spec.loader.exec_module(package)
        (self.resources/"gendragoon_project_files.py").write_text("fixture required project browser")
        # Model the complete staged bundle, including Teams and the private
        # transfer helpers, before exercising the missing-resource rejection.
        for name in (*package.REQUIRED_RESOURCES, *package.RED_SECRETS_RESOURCES):
            target=self.resources/name
            target.parent.mkdir(parents=True,exist_ok=True)
            if not target.exists():target.write_bytes(b"fixture runtime resource")
        package.require_runtime_resources(self.app)
        (self.resources/"gendragoon_update_restart.py").unlink()
        with self.assertRaisesRegex(RuntimeError,"gendragoon_update_restart.py"):
            package.require_runtime_resources(self.app)

    def test_procargs_parser_stops_at_argc_and_keeps_spaces(self):
        argv = ["/Apps/GenDragoon Cloud SSD.app/rclone", "--config", "/A B/config", "nfsmount"]
        raw = struct.pack("=i",len(argv)) + argv[0].encode() + b"\0\0" + b"\0".join(x.encode() for x in argv) + b"\0SECRET=never decode\xff\0"
        self.assertEqual(worker.parse_process_arguments(raw), argv)
        for bad in (b"", struct.pack("=i",-1)+b"x\0", raw[:8]):
            with self.assertRaises(RuntimeError):worker.parse_process_arguments(bad)

    def test_primary_argv_requires_exact_cache_mount_and_foreground(self):
        executable = self.resources / "rclone"
        mount = self.home / "GenDragoon Cloud SSD"
        args = [str(executable),"--config",str(self.support/"gendragoon-rclone.conf"),"nfsmount",
                "gendragoon:bucket",str(mount),"--cache-dir="+str(self.support/"Cache"),
                "--vfs-cache-mode=full","--vfs-cache-min-free-space=10G","--vfs-write-back=10s"]
        worker.verify_primary_arguments(args,executable,self.support,mount)
        for changed in (args+["--daemon"],args+["--cache-dir=/tmp"],args[:5]+["/another/mount"]+args[6:]):
            with self.assertRaises(RuntimeError):worker.verify_primary_arguments(changed,executable,self.support,mount)

    def test_primary_mount_uses_shared_target_scanner_and_rechecks_identity(self):
        executable = self.resources / "rclone"
        mount = self.home / "GenDragoon Cloud SSD"
        primary = control.ProcessIdentity(4100, str(executable), "verified start")
        arguments = [str(executable), "--config", str(self.support / "gendragoon-rclone.conf"),
                     "nfsmount", "gendragoon:bucket", str(mount), "--cache-dir=" + str(self.support / "Cache"),
                     "--vfs-cache-mode=full", "--vfs-cache-min-free-space=10G", "--vfs-write-back=10s"]
        with mock.patch.object(control, "mounted_volumes", return_value=(("localhost:/", str(mount), "nfs"),)), \
             mock.patch.object(control, "app_pids", return_value=[4100]) as scanner, \
             mock.patch.object(control, "identify", return_value=primary) as identify, \
             mock.patch.object(worker, "process_arguments", return_value=arguments):
            self.assertEqual(worker.primary_mount(self.app), primary)
            scanner.assert_called_once_with(executable)
            identify.assert_called_once_with(4100, executable)
        with mock.patch.object(control, "mounted_volumes", return_value=(("localhost:/", str(mount), "nfs"),)), \
             mock.patch.object(control, "app_pids", side_effect=control.ControlError("inspection_failed")):
            with self.assertRaises(control.ControlError): worker.primary_mount(self.app)

    def test_quiesce_sends_one_normal_signal_after_three_quiet_samples(self):
        primary = control.ProcessIdentity(4100,str(self.resources/"rclone"),"original")
        calls = []
        with mock.patch.object(worker,"primary_mount",return_value=primary), \
             mock.patch.object(worker,"verify_parent",return_value=self.identity), \
             mock.patch.object(worker,"ensure_quiet",side_effect=lambda *a,**kw:calls.append("quiet")), \
             mock.patch.object(control,"identify",return_value=primary), \
             mock.patch.object(control,"wait_for_exit",side_effect=lambda *a,**kw:calls.append("exit")), \
             mock.patch.object(control,"mounted_volumes",return_value=(("disk","/","apfs"),)), \
             mock.patch.object(worker.time,"sleep"), \
             mock.patch.object(worker.os,"kill",side_effect=lambda *args:calls.append(args)):
            worker.quiesce_primary(self.app,4001)
        self.assertEqual(calls,["quiet","quiet","quiet",(4100,signal.SIGTERM),"exit","quiet"])

    def test_quiesce_never_signals_after_busy_probe_or_reused_pid(self):
        primary = control.ProcessIdentity(4100,str(self.resources/"rclone"),"original")
        for failure in ("busy","reused"):
            with self.subTest(failure=failure), mock.patch.object(worker,"primary_mount",return_value=primary), \
                 mock.patch.object(worker,"verify_parent",return_value=self.identity), \
                 mock.patch.object(worker,"ensure_quiet",side_effect=RuntimeError("dirty or open") if failure=="busy" else None), \
                 mock.patch.object(control,"identify",return_value=control.ProcessIdentity(primary.pid,primary.executable,"new start")), \
                 mock.patch.object(worker.time,"sleep"), mock.patch.object(worker.os,"kill") as signal_app:
                with self.assertRaises(RuntimeError):worker.quiesce_primary(self.app,4001)
                signal_app.assert_not_called()

    def test_cancelled_quit_never_waits_for_or_signals_another_pid(self):
        directory,receipt = self.snapshot()
        worker.write_owned(directory/"cancel.json",json.dumps({"request_id":receipt["request_id"],"pid":4001}).encode())
        with mock.patch.object(control,"kernel_path") as probe, mock.patch.object(worker.os,"kill") as signal_app:
            with self.assertRaisesRegex(RuntimeError,"cancelled"):worker.wait_for_parent(directory,receipt)
            probe.assert_not_called();signal_app.assert_not_called()

    def test_parent_pid_reuse_is_recognized_without_signalling(self):
        directory,receipt = self.snapshot()
        with mock.patch.object(control,"kernel_path",return_value=self.identity.executable), \
             mock.patch.object(control,"identify",return_value=control.ProcessIdentity(4001,self.identity.executable,"new start")), \
             mock.patch.object(worker.os,"kill") as signal_app:
            worker.wait_for_parent(directory,receipt,timeout=0)
            signal_app.assert_not_called()

    def test_failed_ack_leaves_app_open_and_writes_cancellation(self):
        directory,receipt = self.snapshot()
        child = mock.Mock()
        child.wait.return_value=1
        with mock.patch.object(worker,"retained_request",return_value=(directory,receipt)), \
             mock.patch.object(worker.subprocess,"Popen",return_value=child), \
             mock.patch.object(worker.select,"select",return_value=([],[],[])):
            with self.assertRaisesRegex(RuntimeError,"did not become ready"):
                worker.schedule(4001,self.app,False,ready_timeout=0)
        self.assertTrue(worker.cancelled(directory,receipt))
        self.assertEqual(auto.version_of(self.app),"0.17.0")
        child.terminate.assert_not_called();child.kill.assert_not_called()

    def test_actual_detached_worker_outlives_parent_and_replaced_bundle(self):
        parent = subprocess.Popen([sys.executable,"-I","-B","-c","import sys; sys.stdin.buffer.read()"],stdin=subprocess.PIPE)
        self.addCleanup(lambda: parent.wait(timeout=5) if parent.poll() is not None else (parent.stdin.close(),parent.wait(timeout=5)))
        directory,receipt = self.snapshot(parent.pid)
        wrapper = self.home / "fixture-python"
        # This adapter is outside the production sources and snapshot. It only
        # substitutes unavailable Darwin/Apple services and a tiny test process.
        wrapper.write_text("#!"+sys.executable+"\n"+CHILD_ADAPTER)
        wrapper.chmod(0o700)
        with mock.patch.object(worker,"retained_request",return_value=(directory,receipt)), \
             mock.patch.object(worker.sys,"executable",str(wrapper)):
            result = worker.schedule(parent.pid,self.app,False,ready_timeout=15)
        self.assertEqual(result["state"],"scheduled")
        self.assertIsNone(parent.poll())
        # The production worker still owns the real shared lock after its
        # scheduler returns and before the original app quits.
        with self.assertRaises(RuntimeError):
            with auto.update_lock(timeout=0):pass
        parent.stdin.close();parent.wait(timeout=5)
        # The OS adapter receives this only after the real parent was reaped.
        # Some CI namespaces cannot expose Darwin-style cross-session ps data.
        (directory/"fixture-parent-exited").write_text("normal exit observed")
        deadline = __import__("time").monotonic()+12
        status = {}
        while __import__("time").monotonic()<deadline:
            status=json.loads(auto.STATUS.read_text()) if auto.STATUS.exists() else {}
            if status.get("state") in ("installed","attention","postponed") and status.get("launchStatus")!="pending":break
            __import__("time").sleep(0.05)
        self.assertEqual(status.get("state"),"installed",status)
        self.assertEqual(status["launchStatus"],"exact_executable_observed")
        self.assertEqual(auto.version_of(self.app),"0.18.0")
        self.assertEqual(auto.version_of(Path(status["backupPath"])),"0.17.0")
        event=json.loads((directory/"fixture-observed.json").read_text())
        self.assertEqual(event["workerPID"],event["sessionID"])
        self.assertEqual(Path(event["librarySource"]).parent,directory)
        self.assertFalse((self.app/"Contents/Resources").exists())
        self.assertEqual(status["launchedProcesses"][0]["pid"],event["launchedPID"])
        self.assertNotEqual(event["launchedPID"],parent.pid)
        self.assertFalse(list(self.home.rglob("*.pyc")))


CHILD_ADAPTER = r'''
import json,os,sys,subprocess,shutil,time
from pathlib import Path
directory=Path(sys.argv[3]).parent
sys.dont_write_bytecode=True
sys.path.insert(0,str(directory))
import gendragoon_update_restart as w
w.load_runtime(directory)
receipt=w.verify_snapshot(directory)
app=Path(receipt['app']);original=receipt['identity']['pid'];launched=[]
executable=app/'Contents/MacOS/GenDragoon Cloud SSD'
def alive(pid):
    if pid==original:return not (directory/'fixture-parent-exited').exists()
    return any(p.pid==pid and p.poll() is None for p in launched)
w.control.kernel_path=lambda pid:str(executable) if pid in [original,*[p.pid for p in launched]] and alive(pid) else None
w.control.kernel_name=lambda pid:executable.name if alive(pid) else None
w.control.processes=lambda:[(pid,0,os.getuid(),'fixture app') for pid in [original,*[p.pid for p in launched]] if alive(pid)]
w.control.identify=lambda pid,path:w.control.ProcessIdentity(pid,str(path),receipt['identity']['started'] if pid==original else 'fixture launch '+str(pid))
w.control.require_mac=lambda:None
w.control.trusted_bundle=lambda path:w.auto.app_executable(path)
w.control.mounted_volumes=lambda:(('disk','/','apfs'),)
w.launcher.sessions=lambda:{'active':False}
w.launcher.open_files=lambda:[]
w.auto.app_pids=lambda app=None:w.control.app_pids(executable)
w.auto.platform.machine=lambda:'arm64'
w.auto.platform.mac_ver=lambda:('14.0',(), '')
w.auto.sufficient_space=lambda *args:None
def command(args,timeout=80):
    if args[0]=='/usr/bin/ditto':shutil.copytree(args[1],args[2]);return ''
    if args[0]=='/usr/bin/lipo':return 'arm64'
    if args[0]=='/usr/bin/codesign' and '-dv' in args:
        return 'Identifier='+w.auto.BUNDLE_ID+'\nTeamIdentifier='+w.auto.TEAM_ID+'\nAuthority=Developer ID Application: Fixture'
    if args[0]=='/usr/bin/open':
        assert args==['/usr/bin/open','-n',str(app)]
        process=subprocess.Popen([sys.executable,'-I','-B','-c','import time;time.sleep(4)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        launched.append(process)
        (directory/'fixture-observed.json').write_text(json.dumps({'workerPID':os.getpid(),'sessionID':os.getsid(0),'launchedPID':process.pid,'librarySource':w.launcher.lib.__file__}))
    return ''
w.auto.subprocess_ok=command
sys.exit(w.main(sys.argv[4:]))
'''


class PreviewChannelTests(unittest.TestCase):
    def test_preview_is_opt_in_and_uses_base_version_archive(self):
        tag="v0.18.0-rc.2";base="v0.18.0";filename=auto.ZIP_PREFIX+base+".zip"
        url="https://github.com/"+auto.REPO+"/releases/download/"+tag+"/"
        release={"tag_name":tag,"draft":False,"prerelease":True,"assets":[
            {"name":name,"browser_download_url":url+name} for name in (filename,"sha256.txt","package-status.json")]}
        package={"version":"0.18.0","build":"24","candidate":True,"automaticUpdateEligible":False,
                 "gatekeeperAccepted":True,"stapledTicketValidated":True}
        def fetch(url):return package if url.endswith("package-status.json") else [release]
        with mock.patch.object(auto,"request_json",side_effect=fetch),mock.patch.object(auto,"installed_version",return_value="0.18.0"), \
             mock.patch.object(auto,"build_of",return_value=23):
            with mock.patch.object(auto,"CHANNEL","stable"):self.assertIsNone(auto.latest())
            with mock.patch.object(auto,"CHANNEL","preview"):
                result=auto.latest()
                self.assertEqual(result["version"],base);self.assertEqual(result["releaseTag"],tag)
                self.assertEqual(result["filename"],filename);self.assertEqual(result["build"],24)
            package["stapledTicketValidated"]=False
            with mock.patch.object(auto,"CHANNEL","preview"),self.assertRaises(RuntimeError):auto.latest()


if __name__=="__main__":unittest.main()
