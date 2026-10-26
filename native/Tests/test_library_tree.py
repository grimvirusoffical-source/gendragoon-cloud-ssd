"""Virtual library organization and verified nested-folder restore fixtures."""
import copy
import hashlib
import json
from pathlib import Path
import shutil
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import test_integrated_library as fixtures
library=fixtures.library

class TreeTests(unittest.TestCase):
    def setUp(self):
        self.fixture=fixtures.LibraryTests(methodName="runTest");self.fixture.setUp();self.addCleanup(self.fixture.tearDown)
        self.note="1"*32;self.parent="a"*18;self.nested="b"*18;self.file="c"*18;self.empty="d"*18
        self.config={"workspaceId":self.note}
        self.snapshot={"revision":8,"items":[
            {"key":self.parent,"name":"Original folder","displayName":"Renamed folder","kind":"folder","virtualFolder":True,"workspace":self.note,"parentKey":None},
            {"key":self.nested,"name":"Nested","kind":"folder","virtualFolder":True,"workspace":self.note,"parentKey":self.parent},
            {"key":self.file,"name":"original.txt","displayName":"renamed.txt","kind":"file","workspace":self.note,"parentKey":self.nested,
             "manifestId":"f"*32,"archiveSha256":hashlib.sha256(b"payload").hexdigest(),"archiveBytes":7},
            {"key":self.empty,"name":"Empty","kind":"folder","virtualFolder":True,"workspace":self.note,"parentKey":self.parent},
        ]}
        self.client=SimpleNamespace(verified_workers=Mock(return_value=1),library_snapshot=Mock(side_effect=lambda:copy.deepcopy(self.snapshot)),organize=Mock())
        self.module=SimpleNamespace(RedXReceiver=Mock(return_value=self.client))
        self.addCleanup(patch.stopall)
        patch.object(library,"redx_config",return_value=self.config).start()
        patch.object(library,"redx_module",return_value=self.module).start()

    def sync(self):
        return library.sync_redx_library("redxai",self.note,"redxai")

    def test_list_keeps_virtual_tree_and_immutable_archive_identity(self):
        self.sync();entries=library.load()
        self.assertTrue(entries[self.parent]["virtualFolder"])
        self.assertEqual(entries[self.file]["name"],"original.txt")
        self.assertEqual(entries[self.file]["displayName"],"renamed.txt")
        self.assertEqual(entries[self.file]["parentKey"],self.nested)
        self.assertEqual(entries[self.file]["redxTreeRevision"],8)
        self.snapshot["items"]=[item for item in self.snapshot["items"] if item["key"]!=self.file]
        self.sync();present=library.present(library.load(),{"project":"redxai","bucket":self.note,"remote":"redxai"})
        self.assertNotIn(self.file,[item["key"] for item in present])
        self.assertTrue(library.load()[self.file]["cloudMissing"])

    def test_organize_rejects_cycles_and_revision_changes_before_mutation(self):
        with self.assertRaisesRegex(ValueError,"itself"):
            library.organize("move",[self.parent],parent_key=self.nested,expected_revision=8,project="redxai",bucket=self.note)
        with self.assertRaisesRegex(RuntimeError,"changed"):
            library.organize("delete",[self.file],expected_revision=7,project="redxai",bucket=self.note)
        with self.assertRaisesRegex(ValueError,"not in"):
            library.organize("delete",["e"*18],expected_revision=8,project="redxai",bucket=self.note)
        self.client.organize.assert_not_called()

    def test_parent_key_domain_preserves_legacy_roots_and_separates_identical_names(self):
        root=library.keyfor("redxai",self.note+"/Library","same.txt","redxai",self.note)
        expected=hashlib.sha256("|".join(["redxai",self.note,"redxai",self.note+"/Library","same.txt"]).encode()).hexdigest()[:18]
        self.assertEqual(root,expected)
        nested=library.keyfor("redxai",self.note+"/Library","same.txt","redxai",self.note,self.parent)
        self.assertNotEqual(root,nested)
        with self.assertRaises(ValueError):library.keyfor("redxai",self.note+"/Library","same.txt","redxai",self.note,"../escape")

    def test_virtual_folder_restores_nested_items_and_empty_directories_then_safely_clears_cache(self):
        self.sync();source=self.fixture.home/"verified-child.txt";source.write_bytes(b"payload")
        original_stage=library.stage_item
        def stage(key,*args,**kwargs):
            if key==self.file:return str(source)
            return original_stage(key,*args,**kwargs)
        def ditto(args,timeout=1800):
            self.assertEqual(str(args[0]),"/usr/bin/ditto");shutil.copy2(args[1],args[2]);return ""
        with patch.object(library,"stage_item",side_effect=stage),patch.object(library,"run",side_effect=ditto):
            original_stage(self.parent,False,"redxai",self.note,"redxai")
        restored=Path(self.fixture.mock_reply.call_args.kwargs["localPath"])
        self.assertEqual(restored.name,"Renamed folder")
        self.assertEqual((restored/"Nested/renamed.txt").read_bytes(),b"payload")
        self.assertTrue((restored/"Empty").is_dir())
        self.assertEqual(library.load()[self.parent]["cacheTreeRevision"],8)
        library.clear_cache(self.parent,"redxai",self.note,"redxai")
        self.assertFalse(restored.exists());self.assertEqual(source.read_bytes(),b"payload")

    def test_virtual_restore_never_publishes_when_tree_changes_during_download(self):
        self.sync();self.client.library_snapshot.side_effect=lambda:{"revision":9,"items":[]}
        source=self.fixture.home/"verified-child.txt";source.write_bytes(b"payload")
        original_stage=library.stage_item
        with patch.object(library,"stage_item",return_value=str(source)),patch.object(library,"run",side_effect=lambda args,**kw:shutil.copy2(args[1],args[2])):
            with self.assertRaisesRegex(RuntimeError,"changed while restoring"):
                original_stage(self.parent,False,"redxai",self.note,"redxai")
        self.assertFalse((library.CACHE/self.parent/"Renamed folder").exists())
        self.assertTrue(source.exists())

    def test_renamed_copy_restores_under_display_name_without_changing_archive_identity(self):
        clone=copy.deepcopy(self.snapshot["items"][2]);clone.update(key="e"*18,archiveKey=self.file,displayName="copied.txt",parentKey=None)
        self.snapshot["items"].append(clone);self.sync()
        original=self.fixture.home/"original.txt";original.write_bytes(b"payload")
        baseline=library.snapshot(original)["manifest"]
        self.module.find_item=Mock(return_value=clone)
        def download(config,item,destination):
            self.assertEqual(item["name"],"original.txt");self.assertEqual(item["manifestId"],"f"*32)
            self.assertEqual(item["archiveKey"],self.file);Path(destination).write_bytes(b"payload")
            return {"root":{"archiveLayout":"flat","archiveSha256":clone["archiveSha256"]},"manifest":baseline}
        self.module.download_archive=Mock(side_effect=download)
        library.stage_item(clone["key"],False,"redxai",self.note,"redxai")
        restored=Path(self.fixture.mock_reply.call_args.kwargs["localPath"])
        self.assertEqual(restored.name,"copied.txt");self.assertEqual(restored.read_bytes(),b"payload")
        self.assertEqual(original.read_bytes(),b"payload")

if __name__=="__main__":unittest.main()
