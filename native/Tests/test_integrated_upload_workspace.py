"""Disposable upload-workspace fixtures; no native app, cloud IO, or offload."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock


SCRIPT = Path(__file__).parents[1] / "Resources/gendragoon_upload_workspace.py"
SPEC = importlib.util.spec_from_file_location("tested_upload_workspace", SCRIPT)
workspace = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(workspace)

FIRST = {"project": "project-one", "bucket": "bucket-one", "remote": "gcpone", "prefix": "apps/custom"}
SECOND = {"project": "project-two", "bucket": "bucket-two", "remote": "gcptwo", "prefix": "other"}


class UploadWorkspaceTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="gendragoon-upload-workspace-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.sources = self.root / "sources"
        self.sources.mkdir()

    def source(self, name="source.dmg", data=b"fixture source"):
        path = self.sources / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def select(self, destination=FIRST):
        return workspace.select_destination(**destination,
            expected_revision=workspace.read_state(self.home)["revision"], home=self.home)

    def prepare(self, paths=None, offload=False):
        paths = paths or [self.source()]
        state = self.select()
        state = workspace.add_sources([str(path) for path in paths], state["revision"], self.home)
        return workspace.enqueue(state["revision"], offload, self.home)

    def outcome(self, command, maintenance_fd=None):
        def value(flag):
            return command[command.index(flag) + 1]
        source = Path(value("--source"))
        destination = {"project": value("--project"), "bucket": value("--bucket"),
                       "remote": value("--remote"), "prefix": value("--folder")[len(value("--bucket")) + 1:]}
        return {"ok": True, "verified": True, "key": workspace.library_key(destination, {"name": source.name}),
                "offloaded": "--offload" in command, **{key: destination[key] for key in ("project", "bucket", "remote")},
                "folder": value("--folder"), "source": str(source), "kind": workspace.kindof(source), "name": source.name}

    @contextmanager
    def fake_library(self, callback=None):
        with mock.patch.object(workspace, "helper_path", return_value=Path("/fixture/gendragoon_library.py")), \
                mock.patch.object(workspace, "child_result", side_effect=callback or self.outcome) as child:
            yield child

    def test_destination_and_selection_persist_across_module_reload(self):
        source = self.source()
        state = self.select()
        state = workspace.add_sources([str(source)], state["revision"], self.home)
        spec = importlib.util.spec_from_file_location("fresh_upload_workspace", SCRIPT)
        fresh = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(fresh)
        self.assertEqual(fresh.read_state(self.home), state)
        data = (workspace.support(self.home) / "UploadWorkspace/state.json").read_text()
        self.assertNotIn("credential", data)
        self.assertNotIn("api_key", data)

    def test_app_bundle_is_atomic_and_quick_entries_are_present(self):
        app = self.sources / "Game.app"
        (app / "Contents").mkdir(parents=True)
        (app / "Contents/Info.plist").write_bytes(b"fixture")
        state = workspace.add_sources([str(app)], 0, self.home)
        self.assertEqual(state["sources"][0]["kind"], "app")
        result = workspace.tree(str(app), self.home)
        self.assertTrue(result["tree"]["atomic"])
        self.assertEqual(result["tree"]["children"], [])
        self.assertEqual([node["path"] for node in result["quick_entries"]],
                         ["/Applications", str(self.home / "Applications")])
        with self.assertRaises(workspace.WorkspaceError) as failure:
            workspace.add_sources([str(app / "Contents/Info.plist")], state["revision"], self.home)
        self.assertEqual(failure.exception.code, "atomic_app")

    def test_all_regular_file_extensions_and_complete_folders_are_selectable(self):
        names = ["app.exe", "mobile.apk", "package.ipa", "disk.dmg", "image.AppImage", "data.weird", "README", ".hidden"]
        paths = [self.source(name) for name in names]
        folder = self.sources / "whole-folder"
        (folder / "nested/empty").mkdir(parents=True)
        (folder / "nested/.unknown").write_bytes(b"nested data")
        state = workspace.add_sources([str(path) for path in [*paths, folder]], 0, self.home)
        self.assertEqual({source["name"] for source in state["sources"]}, set(names + [folder.name]))
        self.assertTrue(all(source["kind"] == "file" for source in state["sources"][:-1]))
        self.assertEqual(state["sources"][-1]["kind"], "folder")
        tree = workspace.tree(str(self.sources), self.home)["tree"]["children"]
        self.assertEqual({node["name"] for node in tree}, set(names + [folder.name]))
        self.assertEqual((folder / "nested/.unknown").read_bytes(), b"nested data")

    def test_stale_selection_response_cannot_overwrite_new_destination(self):
        first = self.select()
        second = self.select(SECOND)
        with self.assertRaises(workspace.WorkspaceError) as failure:
            workspace.select_destination(**FIRST, expected_revision=first["revision"], home=self.home)
        self.assertEqual(failure.exception.code, "revision_conflict")
        self.assertEqual(workspace.read_state(self.home), second)

    def test_invalid_project_never_falls_back_or_changes_existing_choice(self):
        state = self.select()
        with self.assertRaises(workspace.WorkspaceError):
            workspace.select_destination("", "bucket-two", "gcptwo", "", state["revision"], self.home)
        self.assertEqual(workspace.read_state(self.home), state)

    def test_queued_job_keeps_original_context_after_explicit_selection_changes(self):
        original = self.source()
        queued, job_id = self.prepare([original])
        frozen = json.loads(json.dumps(queued["jobs"][0]))
        state = self.select(SECOND)
        state = workspace.clear_sources(state["revision"], self.home)
        new_source = self.source("new-other.apk")
        state = workspace.add_sources([str(new_source)], state["revision"], self.home)
        self.assertEqual(state["jobs"][0], frozen)
        with self.fake_library() as child:
            finished, completed = workspace.run_next(self.home)
        self.assertEqual(completed, job_id)
        self.assertEqual(finished["destination"], SECOND)
        self.assertEqual(finished["sources"][0]["path"], str(new_source))
        command = child.call_args.args[0]
        self.assertEqual(command[command.index("--source") + 1], str(original))
        self.assertEqual(command[command.index("--project") + 1], FIRST["project"])
        self.assertEqual(command[command.index("--folder") + 1], "bucket-one/apps/custom")
        self.assertNotIn("gen-dragoon-ssd", command)

    def test_running_application_offload_reason_is_preserved_without_exposing_child_output(self):
        original = self.source()
        state, job_id = self.prepare([original], offload=True)
        result = subprocess.CompletedProcess([], 1,
            json.dumps({"ok": False, "message": "Quit this application before offloading it"}),
            "private diagnostic containing Bearer fixture-never-expose")
        with mock.patch.object(workspace.subprocess, "run", return_value=result):
            with self.assertRaises(workspace.WorkspaceError) as caught:
                workspace.run_next(self.home)
        self.assertEqual(caught.exception.code, "source_in_use")
        self.assertIn("Quit the selected application", caught.exception.message)
        final = workspace.read_state(self.home)
        self.assertEqual(final["jobs"][0]["state"], "failed")
        self.assertIsNone(final["active_job_id"])
        self.assertEqual(final["sources"], state["sources"])
        self.assertEqual(original.read_bytes(), b"fixture source")
        self.assertNotIn("fixture-never-expose", json.dumps(final))
        self.assertIsNone(final["jobs"][0]["items"][0]["offloaded"])

    def test_unknown_child_failures_remain_private_and_do_not_gain_the_guard_allowlist(self):
        for message in ("Bearer private-fixture-token", "Quit this application before offloading it Bearer private-fixture-token"):
            result = subprocess.CompletedProcess([], 1, json.dumps({"ok": False, "message": message}), message)
            with mock.patch.object(workspace.subprocess, "run", return_value=result):
                with self.assertRaises(workspace.WorkspaceError) as caught:
                    workspace.child_result(["python3", "-B", "/fixture/gendragoon_library.py", "upload"])
            self.assertEqual(caught.exception.code, "helper_failed")
            self.assertNotIn("private-fixture-token", caught.exception.message)

    def test_cancel_legacy_queued_upload_preserves_sources_and_other_jobs(self):
        original = self.source()
        queued, job_id = self.prepare([original], offload=True)
        second = self.select(SECOND)
        second, other_id = workspace.enqueue(second["revision"], False, self.home)
        with self.assertRaises(workspace.WorkspaceError) as stale:
            workspace.cancel_job(job_id, queued["revision"], self.home)
        self.assertEqual(stale.exception.code, "revision_conflict")
        result = workspace.cancel_job(job_id, second["revision"], self.home)
        self.assertEqual(original.read_bytes(), b"fixture source")
        self.assertEqual(result["sources"], second["sources"])
        self.assertEqual(result["jobs"][0]["state"], "failed")
        self.assertFalse(result["jobs"][0]["items"][0]["offloaded"])
        self.assertEqual(result["jobs"][1]["id"], other_id)
        self.assertEqual(result["jobs"][1]["state"], "queued")
        with self.fake_library() as child:
            final, completed = workspace.run_next(self.home)
        self.assertEqual(completed, other_id)
        self.assertEqual(final["jobs"][0]["state"], "failed")
        self.assertEqual(child.call_count, 1)
        with self.assertRaises(workspace.WorkspaceError):
            workspace.cancel_job(other_id, final["revision"], self.home)

    def test_source_change_before_enqueue_is_rejected_without_job(self):
        source = self.source()
        state = self.select()
        state = workspace.add_sources([str(source)], state["revision"], self.home)
        source.write_bytes(b"changed after selection")
        with self.assertRaises(workspace.WorkspaceError) as failure:
            workspace.enqueue(state["revision"], True, self.home)
        self.assertEqual(failure.exception.code, "source_changed")
        self.assertEqual(workspace.read_state(self.home)["jobs"], [])
        self.assertTrue(source.exists())

    def test_source_change_before_worker_never_calls_library_or_offloads(self):
        source = self.source()
        self.prepare([source], offload=True)
        source.write_bytes(b"changed while queued")
        with self.fake_library() as child, self.assertRaises(workspace.WorkspaceError) as failure:
            workspace.run_next(self.home)
        self.assertEqual(failure.exception.code, "source_changed")
        child.assert_not_called()
        state = workspace.read_state(self.home)
        self.assertEqual(state["jobs"][0]["state"], "failed")
        self.assertIsNone(state["active_job_id"])
        self.assertEqual(len(state["sources"]), 1)
        self.assertEqual(source.read_bytes(), b"changed while queued")

    def test_nested_folder_changes_are_detected(self):
        folder = self.sources / "Folder"
        (folder / "nested").mkdir(parents=True)
        child = folder / "nested/child.data"
        child.write_bytes(b"before")
        self.prepare([folder])
        child.write_bytes(b"after!")
        # Same-size rewrite: advance mtime so a coarse filesystem clock tick cannot hide it (flaky ~1 in 5 otherwise).
        stamp = child.stat().st_mtime_ns + 2_000_000_000
        os.utime(child, ns=(stamp, stamp))
        with self.fake_library() as helper, self.assertRaises(workspace.WorkspaceError):
            workspace.run_next(self.home)
        helper.assert_not_called()
        self.assertTrue(child.exists())

    def test_same_name_roots_fail_before_any_job_or_offload(self):
        first = self.source("A/report.txt")
        second = self.source("B/report.txt")
        state = self.select()
        state = workspace.add_sources([str(first), str(second)], state["revision"], self.home)
        with self.assertRaises(workspace.WorkspaceError) as failure:
            workspace.enqueue(state["revision"], True, self.home)
        self.assertEqual(failure.exception.code, "name_conflict")
        self.assertEqual(workspace.read_state(self.home)["jobs"], [])
        self.assertTrue(first.exists() and second.exists())

    def test_different_same_name_source_cannot_enter_existing_destination_queue(self):
        first = self.source("A/report.txt")
        queued, _ = self.prepare([first], offload=True)
        state = workspace.clear_sources(queued["revision"], self.home)
        second = self.source("B/report.txt")
        state = workspace.add_sources([str(second)], state["revision"], self.home)
        with self.assertRaises(workspace.WorkspaceError) as failure:
            workspace.enqueue(state["revision"], True, self.home)
        self.assertEqual(failure.exception.code, "name_conflict")
        self.assertEqual(len(workspace.read_state(self.home)["jobs"]), 1)
        self.assertTrue(first.exists() and second.exists())

    def test_sixteen_process_cas_race_has_one_private_atomic_commit(self):
        source = self.source()
        initial = workspace.add_sources([str(source)], 0, self.home)
        gate = self.root / "race-start"
        program = '''
import importlib.util,json,sys,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('race_workspace',sys.argv[1])
w=importlib.util.module_from_spec(spec);spec.loader.exec_module(w)
gate=Path(sys.argv[5]);deadline=time.monotonic()+8
while not gate.exists():
 if time.monotonic()>deadline:raise RuntimeError('fixture barrier timed out')
 time.sleep(.001)
try:
 s=w.select_destination('project-'+sys.argv[4],'bucket-'+sys.argv[4],'gcp'+sys.argv[4],
                        'race',int(sys.argv[3]),Path(sys.argv[2]))
 print(json.dumps({'ok':True,'revision':s['revision']}))
except w.WorkspaceError as e:print(json.dumps({'ok':False,'error':e.code}))
'''
        environment = {"HOME": str(self.home), "PATH": os.defpath, "PYTHONDONTWRITEBYTECODE": "1"}
        processes = [subprocess.Popen([sys.executable, "-c", program, str(SCRIPT), str(self.home),
                                       str(initial["revision"]), str(index), str(gate)], env=environment,
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                     for index in range(16)]
        try:
            gate.touch()
            records = []
            for process in processes:
                output, errors = process.communicate(timeout=10)
                self.assertEqual(process.returncode, 0, errors)
                records.append(json.loads(output))
        finally:
            for process in processes:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=2)
        self.assertEqual(sum(record["ok"] is True for record in records), 1)
        self.assertEqual(sum(record.get("error") == "revision_conflict" for record in records), 15)
        final = workspace.read_state(self.home)
        self.assertEqual(final["revision"], initial["revision"] + 1)
        self.assertEqual(final["sources"], initial["sources"])
        self.assertEqual(final["destination"]["prefix"], "race")
        root = workspace.support(self.home) / "UploadWorkspace"
        self.assertEqual(root.stat().st_mode & 0o777, 0o700)
        self.assertEqual((root / "state.json").stat().st_mode & 0o777, 0o600)
        self.assertEqual((root / "state.lock").stat().st_mode & 0o777, 0o600)
        self.assertEqual(list(root.glob(".state-*")), [])

    def test_overlapping_folder_and_child_are_rejected_before_offload(self):
        child = self.source("Parent/child.file")
        state = self.select()
        state = workspace.add_sources([str(child.parent), str(child)], state["revision"], self.home)
        with self.assertRaises(workspace.WorkspaceError) as failure:
            workspace.enqueue(state["revision"], True, self.home)
        self.assertEqual(failure.exception.code, "overlapping_sources")
        self.assertTrue(child.exists())

    def test_busy_job_blocks_context_and_sources_while_state_polling_remains_available(self):
        queued, job_id = self.prepare()
        entered, release = threading.Event(), threading.Event()
        def blocked(command, maintenance_fd=None):
            entered.set()
            if not release.wait(5):
                raise AssertionError("test worker release timed out")
            return self.outcome(command, maintenance_fd)
        with self.fake_library(blocked), ThreadPoolExecutor(max_workers=2) as pool:
            worker = pool.submit(workspace.run_next, self.home)
            try:
                self.assertTrue(entered.wait(2))
                polled = pool.submit(workspace.read_state, self.home).result(timeout=1)
                self.assertEqual(polled["active_job_id"], job_id)
                for mutation in (
                    lambda: workspace.select_destination(**SECOND, expected_revision=polled["revision"], home=self.home),
                    lambda: workspace.clear_sources(polled["revision"], self.home),
                    lambda: workspace.remove_source(polled["sources"][0]["id"], polled["revision"], self.home),
                ):
                    with self.assertRaises(workspace.WorkspaceError) as failure:
                        mutation()
                    self.assertEqual(failure.exception.code, "busy")
                with self.assertRaises(workspace.WorkspaceError) as failure:
                    workspace.run_next(self.home)
                self.assertEqual(failure.exception.code, "maintenance_busy")
            finally:
                release.set()
            finished, _ = worker.result(timeout=2)
        self.assertEqual(finished["jobs"][0]["state"], "succeeded")

    def test_failed_helper_keeps_job_selection_and_original(self):
        source = self.source()
        self.prepare([source], offload=True)
        with self.fake_library(lambda *args: (_ for _ in ()).throw(workspace.WorkspaceError("helper_failed", "Fixture failure"))), \
                self.assertRaises(workspace.WorkspaceError):
            workspace.run_next(self.home)
        state = workspace.read_state(self.home)
        self.assertEqual(state["jobs"][0]["state"], "failed")
        self.assertEqual(state["jobs"][0]["items"][0]["state"], "failed")
        self.assertIsNone(state["active_job_id"])
        self.assertEqual(len(state["sources"]), 1)
        self.assertTrue(source.exists())

    def test_result_wrong_key_or_project_is_never_success(self):
        for field in ("key", "project"):
            with self.subTest(field=field):
                source = self.source(field + ".data")
                state = workspace.read_state(self.home)
                if state["sources"]:
                    workspace.clear_sources(state["revision"], self.home)
                self.prepare([source])
                def wrong(command, maintenance_fd=None):
                    result = self.outcome(command, maintenance_fd)
                    result[field] = "wrong-value"
                    return result
                with self.fake_library(wrong), self.assertRaises(workspace.WorkspaceError) as failure:
                    workspace.run_next(self.home)
                self.assertEqual(failure.exception.code, "result_mismatch")
                self.assertEqual(workspace.read_state(self.home)["jobs"][-1]["state"], "failed")
                self.assertTrue(source.exists())

    def test_offload_incomplete_is_reported_as_failed(self):
        source = self.source()
        self.prepare([source], offload=True)
        def not_offloaded(command, maintenance_fd=None):
            result = self.outcome(command, maintenance_fd)
            result["offloaded"] = False
            return result
        with self.fake_library(not_offloaded), self.assertRaises(workspace.WorkspaceError) as failure:
            workspace.run_next(self.home)
        self.assertEqual(failure.exception.code, "offload_incomplete")
        self.assertTrue(source.exists())

    def test_strict_helper_json_and_exit_status_are_required(self):
        for returncode, output in ((1, '{"ok":true}'), (0, '{"ok":true}\n{"ok":true}'),
                                   (0, '{"ok":true,"ok":false}'), (0, '{"ok":true,"number":NaN}')):
            with self.subTest(output=output), mock.patch.object(workspace.subprocess, "run",
                    return_value=subprocess.CompletedProcess(["fixture"], returncode, output, "")), \
                    self.assertRaises(workspace.WorkspaceError) as failure:
                workspace.child_result(["fixture"])
            self.assertEqual(failure.exception.code, "helper_failed")

    def test_maintenance_contention_preserves_queued_job(self):
        state, _ = self.prepare()
        with workspace.maintenance_lock(self.home), self.fake_library() as child, \
                self.assertRaises(workspace.WorkspaceError) as failure:
            workspace.run_next(self.home)
        self.assertEqual(failure.exception.code, "maintenance_busy")
        child.assert_not_called()
        self.assertEqual(workspace.read_state(self.home), state)

    def test_state_refresh_recovers_crashed_job_only_after_child_lease_is_free(self):
        source = self.source()
        queued, identifier = self.prepare([source], offload=True)
        with workspace.locked_state(self.home) as (descriptor, state):
            state["jobs"][0]["state"] = "running"
            state["jobs"][0]["items"][0]["state"] = "running"
            state["active_job_id"] = identifier
            workspace.commit(descriptor, state)
        with self.fake_library() as child:
            with workspace.maintenance_lock(self.home):
                active = workspace.observed_state(self.home)
                self.assertEqual(active["active_job_id"], identifier)
                self.assertEqual(active["jobs"][0]["state"], "running")
            recovered = workspace.observed_state(self.home)
        child.assert_not_called()
        self.assertIsNone(recovered["active_job_id"])
        self.assertEqual(recovered["jobs"][0]["state"], "failed")
        self.assertEqual(recovered["jobs"][0]["error"], "worker_interrupted")
        self.assertEqual(len(recovered["sources"]), 1)
        self.assertTrue(source.exists())

    def test_symlink_source_root_is_rejected(self):
        original = self.source()
        link = self.sources / "linked"
        link.symlink_to(original)
        with self.assertRaises(workspace.WorkspaceError):
            workspace.add_sources([str(link)], 0, self.home)
        self.assertEqual(workspace.read_state(self.home)["sources"], [])

    def test_symlink_and_hardlink_state_files_never_change_user_file(self):
        workspace.read_state(self.home)
        statefile = workspace.support(self.home) / "UploadWorkspace/state.json"
        victim = self.root / "victim"
        victim.write_text("private user file")
        victim.chmod(0o600)
        for mode in ("symlink", "hardlink"):
            with self.subTest(mode=mode):
                if mode == "symlink":
                    statefile.symlink_to(victim)
                else:
                    os.link(victim, statefile)
                try:
                    with self.assertRaises(workspace.WorkspaceError):
                        workspace.read_state(self.home)
                    self.assertEqual(victim.read_text(), "private user file")
                finally:
                    statefile.unlink()

    def test_corrupt_state_is_preserved_instead_of_reset_or_fallback(self):
        workspace.read_state(self.home)
        statefile = workspace.support(self.home) / "UploadWorkspace/state.json"
        statefile.write_text('{"revision":0, "destination":')
        statefile.chmod(0o600)
        with self.assertRaises(workspace.WorkspaceError):
            self.select()
        self.assertEqual(statefile.read_text(), '{"revision":0, "destination":')

    def test_cli_process_workflow_persists_verified_destination_queue_and_progress(self):
        bundle = self.root / "fixture-bundle"
        bundle.mkdir()
        copied = bundle / SCRIPT.name
        shutil.copyfile(SCRIPT, copied)
        (bundle / "gendragoon_connect.py").write_text('''
import argparse,json,sys
import gendragoon_upload_workspace as w
p=argparse.ArgumentParser();p.add_argument('action')
for name in ('project','bucket','remote','prefix','expected-revision'):p.add_argument('--'+name,required=True)
a=p.parse_args()
if a.project=='missing-project':print(json.dumps({'ok':False}));sys.exit(1)
s=w.select_destination(a.project,a.bucket,a.remote,a.prefix,int(a.expected_revision))
print(json.dumps({'ok':True,'workspace':s}))
''')
        (bundle / "gendragoon_library.py").write_text('''
import argparse,json,os
from pathlib import Path
import gendragoon_upload_workspace as w
p=argparse.ArgumentParser();p.add_argument('action')
for name in ('source','project','bucket','remote','folder','maintenance-fd'):p.add_argument('--'+name,required=True)
p.add_argument('--offload',action='store_true');a=p.parse_args()
os.fstat(int(a.maintenance_fd))
s=Path(a.source);d={'project':a.project,'bucket':a.bucket,'remote':a.remote,'prefix':a.folder[len(a.bucket)+1:]}
print(json.dumps(dict(ok=True,verified=True,key=w.library_key(d,{'name':s.name}),offloaded=False,
project=a.project,bucket=a.bucket,remote=a.remote,folder=a.folder,source=str(s),kind=w.kindof(s),name=s.name)))
''')
        original_bundle = {path.relative_to(bundle): path.read_bytes() for path in bundle.rglob("*") if path.is_file()}
        # A bare CLI must propagate its own bytecode guard to the real child
        # processes above, whose fixture imports otherwise write into Resources.
        environment = {"HOME": str(self.home), "PATH": os.defpath}
        def cli(*args, expected=0):
            result = subprocess.run([sys.executable, str(copied), *args], env=environment,
                                    text=True, capture_output=True, check=False, timeout=10)
            self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
            return json.loads(result.stdout)
        empty = cli("state")["state"]
        self.assertIsNone(empty["destination"])
        args = ["select-destination", "--expected-revision", "0"]
        for key, value in FIRST.items():
            args.extend(["--" + key, value])
        state = cli(*args)["state"]
        self.assertEqual(cli("state")["state"]["destination"], FIRST)
        bad = args.copy(); bad[bad.index("--project") + 1] = "missing-project"
        bad[bad.index("--expected-revision") + 1] = str(state["revision"])
        self.assertFalse(cli(*bad, expected=1)["ok"])
        self.assertEqual(cli("state")["state"]["destination"], FIRST)
        source = self.source()
        state = cli("add-sources", "--paths-json", json.dumps([str(source)]),
                    "--expected-revision", str(state["revision"]))["state"]
        queued = cli("enqueue", "--offload", "false", "--expected-revision", str(state["revision"]))
        self.assertEqual(queued["state"]["jobs"][0]["state"], "queued")
        finished = cli("run-next")
        self.assertEqual(finished["job_id"], queued["job_id"])
        self.assertEqual(finished["state"]["jobs"][0]["state"], "succeeded")
        self.assertEqual(finished["state"]["jobs"][0]["completed_items"], 1)
        self.assertEqual(finished["state"]["destination"], FIRST)
        self.assertTrue(source.exists())
        self.assertEqual(original_bundle,
            {path.relative_to(bundle): path.read_bytes() for path in bundle.rglob("*") if path.is_file()})
        self.assertFalse(any(path.name == "__pycache__" for path in bundle.rglob("*")))


if __name__ == "__main__":
    unittest.main()
