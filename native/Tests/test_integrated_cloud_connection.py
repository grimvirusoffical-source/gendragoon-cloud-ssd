"""Google project/bucket ownership and transactional selection fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

RESOURCES=Path(__file__).resolve().parents[1]/"Resources"
def module(name,filename):
    spec=importlib.util.spec_from_file_location(name,RESOURCES/filename)
    value=importlib.util.module_from_spec(spec);sys.modules[name]=value;spec.loader.exec_module(value)
    return value
connect=module("connect_fixture","gendragoon_connect.py")
workspace=module("workspace_connection_fixture","gendragoon_upload_workspace.py")


class ConnectionTests(unittest.TestCase):
    def setUp(self):
        self.temporary=tempfile.TemporaryDirectory(prefix="gd-connection-")
        self.home=Path(self.temporary.name);self.home.chmod(0o700)
        self.support=self.home/"Library/Application Support/GenDragoon Cloud SSD"
        self.support.mkdir(parents=True,mode=0o700)
        self.config=self.support/"gendragoon-rclone.conf"
        self.original=b"[existing]\ntype = local\n";self.config.write_bytes(self.original);self.config.chmod(0o600)
        self.rclone=self.home/"rclone";self.rclone.write_text("fixture only; never executed")
        self.workspace=SimpleNamespace(
            read_state=lambda:workspace.read_state(self.home),
            select_destination=lambda project,bucket,remote,prefix,revision:workspace.select_destination(project,bucket,remote,prefix,revision,self.home),
        )
        self.patches=[]
        for name,value in {"SUPPORT":self.support,"APP_RCLONE_CONFIG":self.config,"RCLONE":self.rclone}.items():
            item=patch.object(connect,name,value);item.start();self.patches.append(item)
        for name,value in {"find_executable":"fixture-gcloud","workspace_module":self.workspace}.items():
            item=patch.object(connect,name,return_value=value);item.start();self.patches.append(item)
        self.api=patch.object(connect,"google_json",side_effect=self.google);self.mock_api=self.api.start();self.patches.append(self.api)
        self.command=patch.object(connect,"run",side_effect=self.fake_command);self.mock_command=self.command.start();self.patches.append(self.command)
        self.reply=patch.object(connect,"reply");self.mock_reply=self.reply.start();self.patches.append(self.reply)
        self.bucket_project="123456";self.fail_read=False;self.after_read=None

    def tearDown(self):
        for item in reversed(self.patches):item.stop()
        self.temporary.cleanup()

    def google(self,gcloud,url,body=None):
        if "userinfo" in url:return {"email":"owner@example.com"}
        if "getIamPolicy" in url:
            self.assertEqual(body,{})
            return {"bindings":[{"role":"roles/owner","members":["user:owner@example.com"]}]}
        if "cloudresourcemanager" in url:return {"projectId":"project-one","projectNumber":"123456","lifecycleState":"ACTIVE"}
        return {"name":"bucket-one","projectNumber":self.bucket_project}

    def fake_command(self,args,**kwargs):
        self.assertNotIn("login",args);self.assertNotIn("print-access-token",args)
        self.assertEqual(args[0],str(self.rclone))
        path=Path(args[args.index("--config")+1]);self.assertNotEqual(path,self.config)
        if "listremotes" in args:return subprocess.CompletedProcess(args,0,"existing:\n","")
        if "config" in args:
            previous=path.read_bytes() if path.exists() else b""
            path.write_bytes(previous+b"[gendragoon]\ntype = gcs\nenv_auth = true\nbucket_policy_only = true\n");path.chmod(0o600)
        if "lsf" in args:
            if self.fail_read:raise RuntimeError("read access fixture denied")
            if self.after_read:self.after_read()
        return subprocess.CompletedProcess(args,0,"","")

    def selected(self):return workspace.read_state(self.home)

    def test_valid_connection_commits_same_workspace_after_membership_and_read(self):
        connect.configure("project-one","bucket-one",expected_revision=0)
        state=self.selected()
        self.assertEqual(state["revision"],1)
        self.assertEqual(state["destination"],{"project":"project-one","bucket":"bucket-one","remote":"gendragoon","prefix":"GenDragoon-App-Library"})
        self.assertEqual(self.mock_reply.call_args.kwargs["workspace"],state)
        self.assertEqual(self.mock_reply.call_args.kwargs["context"],state["destination"])
        self.assertEqual(self.mock_api.call_count,4)
        self.assertIn(b"[existing]",self.config.read_bytes())
        self.assertIn(b"env_auth = true",self.config.read_bytes())
        self.assertEqual(self.config.stat().st_mode&0o777,0o600)
        self.assertFalse((self.support/"cloud-selection.json").exists())

    def test_wrong_bucket_project_preserves_config_and_selection(self):
        self.bucket_project="999999"
        before=self.selected()
        with self.assertRaisesRegex(RuntimeError,"does not belong"):connect.configure("project-one","bucket-one")
        self.assertEqual(self.selected(),before);self.assertEqual(self.config.read_bytes(),self.original)
        self.mock_command.assert_not_called()

    def test_missing_project_number_is_not_inferred_from_bucket_access(self):
        with patch.object(connect,"google_json",return_value={"projectId":"project-one"}):
            with self.assertRaisesRegex(RuntimeError,"could not be verified"):connect.configure("project-one","bucket-one")
        self.assertEqual(self.selected()["revision"],0);self.assertEqual(self.config.read_bytes(),self.original)

    def test_failed_readback_never_changes_prior_configuration(self):
        self.fail_read=True
        with self.assertRaisesRegex(RuntimeError,"denied"):connect.configure("project-one","bucket-one")
        self.assertEqual(self.selected()["revision"],0);self.assertEqual(self.config.read_bytes(),self.original)

    def test_early_cas_conflict_precedes_google_calls(self):
        workspace.select_destination("old-project","old-bucket","gendragoon","custom",0,self.home)
        with self.assertRaisesRegex(RuntimeError,"Workspace changed"):connect.configure("project-one","bucket-one",expected_revision=0)
        self.mock_api.assert_not_called();self.mock_command.assert_not_called()
        self.assertEqual(self.config.read_bytes(),self.original)

    def test_late_cas_conflict_does_not_overwrite_config(self):
        self.after_read=lambda:workspace.select_destination("other-project","other-bucket","gendragoon","custom",0,self.home)
        with self.assertRaisesRegex(RuntimeError,"Workspace changed"):connect.configure("project-one","bucket-one",expected_revision=0)
        self.assertEqual(self.selected()["destination"]["project"],"other-project")
        self.assertEqual(self.config.read_bytes(),self.original)

    def test_state_commit_failure_rolls_back_config_without_losing_prior_context(self):
        workspace.select_destination("old-project","old-bucket","gendragoon","kept-prefix",0,self.home)
        before=self.selected()
        with patch.object(self.workspace,"select_destination",side_effect=workspace.WorkspaceError("revision_conflict","fixture conflict")):
            with self.assertRaises(workspace.WorkspaceError):connect.configure("project-one","bucket-one",expected_revision=1)
        self.assertEqual(self.selected(),before);self.assertEqual(self.config.read_bytes(),self.original)

    def test_postrename_directory_fsync_error_retains_config_matching_committed_state(self):
        original_fsync=os.fsync
        failed=[]
        def fail_directory(descriptor):
            if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                failed.append(descriptor)
                raise OSError("directory durability fixture failure after state rename")
            return original_fsync(descriptor)
        with patch.object(workspace.os,"fsync",side_effect=fail_directory):
            with self.assertRaisesRegex(RuntimeError,"durability could not be confirmed"):
                connect.configure("project-one","bucket-one",expected_revision=0)
        self.assertEqual(len(failed),1)
        state=self.selected()
        self.assertEqual(state["revision"],1)
        self.assertEqual(state["destination"],{"project":"project-one","bucket":"bucket-one","remote":"gendragoon","prefix":"GenDragoon-App-Library"})
        self.assertIn(b"env_auth = true",self.config.read_bytes())
        self.assertNotEqual(self.config.read_bytes(),self.original)
        self.assertIn(b"[existing]",self.config.read_bytes())
        self.mock_reply.assert_not_called()  # Visible commit is not confirmed durability.

    def test_unreadable_recovery_state_does_not_blindly_rollback_prepared_config(self):
        before=self.selected()
        with patch.object(self.workspace,"read_state",side_effect=[before,before,OSError("fixture state unavailable")]),patch.object(self.workspace,"select_destination",side_effect=OSError("fixture commit uncertain")):
            with self.assertRaisesRegex(RuntimeError,"persistence is uncertain"):
                connect.configure("project-one","bucket-one",expected_revision=0)
        self.assertEqual(self.selected(),before)
        self.assertIn(b"env_auth = true",self.config.read_bytes())
        self.assertNotEqual(self.config.read_bytes(),self.original)
        self.mock_reply.assert_not_called()

    def test_existing_prefix_is_retained_unless_explicitly_changed(self):
        workspace.select_destination("old-project","old-bucket","gendragoon","keep/me",0,self.home)
        connect.configure("project-one","bucket-one",expected_revision=1)
        self.assertEqual(self.selected()["destination"]["prefix"],"keep/me")

    def test_active_maintenance_lock_denies_before_provider_or_config_mutation(self):
        with connect.maintenance_lock():
            with self.assertRaisesRegex(RuntimeError,"active"):connect.configure("project-one","bucket-one")
        self.mock_api.assert_not_called();self.mock_command.assert_not_called()
        self.assertEqual(self.config.read_bytes(),self.original)

    def test_symlinked_config_is_never_overwritten(self):
        self.config.unlink();target=self.home/"preserve";target.write_bytes(b"private retained fixture");target.chmod(0o600)
        self.config.symlink_to(target)
        with self.assertRaisesRegex(RuntimeError,"linked"):connect.configure("project-one","bucket-one")
        self.assertEqual(target.read_bytes(),b"private retained fixture")
        self.assertEqual(self.selected()["revision"],0)

    def test_selected_remote_is_recreated_as_gcs_not_updated_as_another_backend(self):
        self.original=b"[existing]\ntype = local\n[gendragoon]\ntype = s3\nprovider = Other\n"
        self.config.write_bytes(self.original)
        connect.configure("project-one","bucket-one",expected_revision=0)
        content=self.config.read_text()
        self.assertIn("[existing]",content)
        self.assertNotIn("type = s3",content);self.assertNotIn("provider = Other",content)
        self.assertIn("type = gcs",content)
        creation=[call.args[0] for call in self.mock_command.call_args_list if "config" in call.args[0]]
        self.assertEqual(len(creation),1)
        self.assertIn("create",creation[0]);self.assertIn("google cloud storage",creation[0])

    def test_bucket_outside_an_owned_project_is_rejected(self):
        before=self.selected()
        def foreign(gcloud,url,body=None):
            if "userinfo" in url:return {"email":"owner@example.com"}
            if "getIamPolicy" in url:return {"bindings":[{"role":"roles/viewer","members":["user:owner@example.com"]}]}
            if "cloudresourcemanager" in url:return {"projectId":"project-one","projectNumber":"123456","lifecycleState":"ACTIVE"}
            return {"name":"bucket-one","projectNumber":"123456"}
        with patch.object(connect,"google_json",side_effect=foreign):
            with self.assertRaisesRegex(RuntimeError,"not owned by the signed-in account.*bring-your-own Google Cloud"):connect.configure("project-one","bucket-one")
        self.assertEqual(self.selected(),before);self.assertEqual(self.config.read_bytes(),self.original)
        self.mock_command.assert_not_called()

    def test_project_list_keeps_only_owned_google_cloud_destinations(self):
        def listing(gcloud, url, body=None):
            if "userinfo" in url:
                return {"email": "owner@example.com"}
            if "projects?" in url:
                return {"projects": [
                    {"projectId": "owned-proj", "name": "Owned", "lifecycleState": "ACTIVE"},
                    {"projectId": "shared-proj", "name": "Readable", "lifecycleState": "ACTIVE"},
                ]}
            if "owned-proj" in url and "getIamPolicy" in url:
                return {"bindings": [{"role": "roles/owner", "members": ["user:owner@example.com"]}]}
            if "getIamPolicy" in url:
                return {"bindings": [{"role": "roles/viewer", "members": ["user:owner@example.com"]}]}
            return {}
        with patch.object(connect, "google_json", side_effect=listing):
            connect.projects()
        payload = self.mock_reply.call_args.kwargs
        self.assertEqual([item["id"] for item in payload["projects"]], ["owned-proj"])
        self.assertIn("bring-your-own Google Cloud", payload["message"])

    def test_custom_native_install_uses_adjacent_bundle_rclone(self):
        helper=Path("/Applications/GenDragoon Cloud SSD.app/Contents/Resources/gendragoon_connect.py")
        self.assertEqual(connect.rclone_path(helper),helper.with_name("rclone"))


if __name__=="__main__":unittest.main()
