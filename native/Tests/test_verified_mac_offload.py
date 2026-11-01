"""Generated files only: cloud verification and recoverable Trash bookkeeping."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"Resources"))
import gendragoon_library as library

class MacOffloadReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="gd-receipt-tests-")
        self.addCleanup(self.temp.cleanup)
        self.home=Path(self.temp.name).resolve();self.home.chmod(0o700)
        self.support=self.home/"support";self.support.mkdir(mode=0o700)
        for name,value in {"HOME":self.home,"SUPPORT":self.support,"INDEX":self.support/"index.json","CACHE":self.support/"cache"}.items():
            p=patch.object(library,name,value);p.start();self.addCleanup(p.stop)
        self.source=self.home/"generated.bin";self.source.write_bytes(b"generated fixture only")
        self.baseline=library.snapshot(self.source);self.key="1"*18
        self.entry={"source":str(self.source),"name":self.source.name,"project":"redxai","bucket":"a"*32,
                    "remote":"redxai","format":"redxai","file":"b"*32+".png","sha256":"c"*64,
                    "redxManifestId":"b"*32,"verified":True,"offloaded":False,"manifest":self.baseline["manifest"]}
        library.store(self.key,self.entry)
        self.moved=self.home/"generated-in-test-trash.bin"
        p=patch.object(library,"is_running",return_value=False);p.start();self.addCleanup(p.stop)
    def move(self,path):Path(path).rename(self.moved)
    def result(self):return library.verified_offload(self.key,self.source,self.entry,self.baseline)
    def receipt(self):
        files=list((self.support/"OffloadReceipts").glob("*.json"));self.assertEqual(len(files),1)
        return json.loads(files[0].read_text())
    def test_catalog_refresh_does_not_turn_successful_move_into_failure(self):
        changed=copy.deepcopy(self.entry);changed.update(redxTreeRevision=17,sizeBytes=123,displayName="New display name")
        library.store(self.key,changed)
        with patch.object(library,"trash",side_effect=self.move):result=self.result()
        self.assertTrue(result["offloaded"]);self.assertTrue(result["offloadRecorded"])
        self.assertFalse(self.source.exists());self.assertEqual(self.moved.read_bytes(),b"generated fixture only")
        saved=library.load()[self.key]
        self.assertEqual(saved["displayName"],"New display name");self.assertEqual(saved["redxTreeRevision"],17)
        self.assertTrue(saved["offloaded"]);self.assertEqual(self.receipt()["state"],"trashed")
    def test_changed_archive_generation_never_authorizes_trash(self):
        library.store(self.key,dict(self.entry,redxManifestId="d"*32))
        with patch.object(library,"trash") as moved,self.assertRaises(RuntimeError):self.result()
        moved.assert_not_called();self.assertTrue(self.source.exists())
    def test_changed_original_never_authorizes_trash(self):
        self.source.write_bytes(b"changed after the verified upload")
        with patch.object(library,"trash") as moved,self.assertRaises(RuntimeError):self.result()
        moved.assert_not_called();self.assertTrue(self.source.exists())
    def test_failed_intent_write_keeps_original(self):
        with patch.object(library,"_offload_receipt",side_effect=OSError("disk fixture")),patch.object(library,"trash") as moved,self.assertRaises(OSError):self.result()
        moved.assert_not_called();self.assertTrue(self.source.exists())
    def test_failed_catalog_write_after_move_does_not_report_failed_offload(self):
        with patch.object(library,"trash",side_effect=self.move),patch.object(library,"_save",side_effect=OSError("disk fixture")):
            result=self.result()
        self.assertTrue(result["offloaded"]);self.assertFalse(result["offloadRecorded"])
        self.assertEqual(self.receipt()["state"],"trashed");self.assertTrue(self.moved.exists())
    def test_trash_rejection_retains_verified_cloud_receipt(self):
        with patch.object(library,"trash",side_effect=PermissionError("fixture")):result=self.result()
        self.assertFalse(result["offloaded"]);self.assertFalse(result["originalMissing"])
        self.assertTrue(self.source.exists());self.assertEqual(self.receipt()["state"],"retained")
    def test_unconfirmed_move_does_not_claim_original_still_present(self):
        def uncertain(path):self.move(path);raise OSError("fixture")
        with patch.object(library,"trash",side_effect=uncertain):result=self.result()
        self.assertFalse(result["offloaded"]);self.assertTrue(result["originalMissing"])
        self.assertEqual(self.receipt()["state"],"unconfirmed")
    def test_no_op_trash_does_not_claim_offload(self):
        with patch.object(library,"trash"):result=self.result()
        self.assertFalse(result["offloaded"]);self.assertTrue(self.source.exists())

if __name__=="__main__":unittest.main()
