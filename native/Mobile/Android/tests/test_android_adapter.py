import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("android_adapter",ROOT/"app/src/main/python/gendragoon_android.py")
adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)


class AdapterTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix="gd-android-adapter-");self.addCleanup(self.temp.cleanup);self.root=Path(self.temp.name)
    def test_folder_archive_is_deterministic_and_retains_empty_files_and_unicode(self):
        source=self.root/"Research 🔐";source.mkdir();(source/"empty").write_bytes(b"");(source/"nested").mkdir();(source/"nested/data.bin").write_bytes(bytes(range(256))*4)
        first,second=self.root/"first.zip",self.root/"second.zip";manifest,layout,kind=adapter.prepare(source,first);adapter.prepare(source,second)
        self.assertEqual((layout,kind),("zip-root","folder"));self.assertEqual(first.read_bytes(),second.read_bytes());self.assertEqual([r["path"] for r in manifest],[".","empty","nested","nested/data.bin"])
        adapter.verify_archive(first,{"archiveLayout":layout,"name":source.name},manifest)
        with zipfile.ZipFile(first)as archive:self.assertIn(source.name+"/empty",archive.namelist())
    def test_empty_file_uses_nonempty_zip_envelope_and_plain_file_roundtrip_verifies(self):
        source=self.root/"empty.txt";source.write_bytes(b"");archive=self.root/"empty.archive";manifest,layout,kind=adapter.prepare(source,archive);self.assertEqual((layout,kind),("zip-root","file"));self.assertGreater(archive.stat().st_size,0);adapter.verify_archive(archive,{"archiveLayout":layout,"name":source.name},manifest)
        source.write_bytes(b"verified original");manifest,layout,kind=adapter.prepare(source,archive);self.assertEqual(layout,"flat");adapter.verify_archive(archive,{"archiveLayout":layout},manifest);archive.write_bytes(b"tampered");self.assertRaises(RuntimeError,adapter.verify_archive,archive,{"archiveLayout":layout},manifest)
    def test_links_unsafe_zip_members_and_authentic_manifest_mismatch_fail_closed(self):
        original=self.root/"original";original.write_bytes(b"private owner source");link=self.root/"link";link.symlink_to(original);self.assertRaises(ValueError,adapter.snapshot,link)
        archive=self.root/"bad.zip"
        with zipfile.ZipFile(archive,"w")as output:output.writestr("../escape",b"unsafe")
        self.assertRaises(RuntimeError,adapter.verify_archive,archive,{"archiveLayout":"zip-root","name":"folder"},[]);self.assertFalse((self.root.parent/"escape").exists())
        self.assertRaises(ValueError,adapter.checked_name,"../x")
    def test_progress_counts_actual_events_concurrently_without_names_or_credentials(self):
        class Callback:
            def __init__(self):self.values=[]
            def report(self,value):self.values.append(json.loads(value))
        callback=Callback();progress=adapter.Progress(callback);progress.phase("uploading",total_bytes=400,workers=4)
        def part():
            for _ in range(100):progress.advance(1,objects_done=1)
        threads=[threading.Thread(target=part)for _ in range(4)]
        for thread in threads:thread.start()
        for thread in threads:thread.join()
        self.assertEqual(progress.state["completed_bytes"],400);self.assertEqual(progress.state["objects_done"],400);progress.phase("complete",total_bytes=400,completed_bytes=400);self.assertEqual(progress.state["completed_bytes"],400)
        encoded=json.dumps(callback.values);self.assertNotIn("bearer",encoded);self.assertNotIn("keymap",encoded);self.assertNotIn(str(self.root),encoded)


if __name__=="__main__":unittest.main()
