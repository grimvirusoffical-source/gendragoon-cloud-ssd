"""Bounded integration/security tests; all data is generated in temporary folders."""
import concurrent.futures
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
import uuid
import warnings
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gd_desktop", ROOT/"gendragoon_desktop.py")
gd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gd)


class PackageTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root/"Selection"
        self.source.mkdir()
        (self.source/"empty-folder").mkdir()
        (self.source/"empty-file").write_bytes(b"")
        (self.source/"musique-紫.txt").write_text("GenDragoon source data", encoding="utf-8")

    def tearDown(self): self.temp.cleanup()

    def package(self):
        archive = self.root/(str(uuid.uuid4())+".zip")
        manifest = gd.make_package(self.source, archive)
        return archive, manifest

    def rewrite(self, archive, transform):
        result = self.root/(str(uuid.uuid4())+".zip")
        with zipfile.ZipFile(archive) as source, zipfile.ZipFile(result, "w") as output:
            for member in source.infolist():
                value = transform(member.filename, source.read(member))
                output.writestr(member, value)
        return result

    def test_full_folder_roundtrip_empty_entries_and_unicode(self):
        archive, manifest = self.package()
        result = gd.extract_package(archive, self.root/"restore")
        self.assertEqual(manifest, result)
        self.assertEqual(gd.snapshot(self.source), gd.snapshot(self.root/"restore/Selection"))

    def test_zero_byte_file_can_be_packaged(self):
        file = self.root/"zero"; file.touch()
        archive = self.root/"zero.zip"
        gd.make_package(file, archive)
        gd.extract_package(archive, self.root/"restored-zero")
        self.assertEqual((self.root/"restored-zero/zero").read_bytes(), b"")

    def test_cloud_and_entry_sha256_corruption_are_rejected(self):
        archive, manifest = self.package()
        corrupt = self.rewrite(archive, lambda name, value: value.replace(b"GenDragoon", b"XXXXXXXXXX") if name.endswith(".txt") else value)
        with self.assertRaisesRegex(ValueError, "SHA-256"):
            gd.extract_package(corrupt, self.root/"bad")
        self.assertFalse((self.root/"bad").exists())

    def test_zip_traversal_absolute_ads_and_reserved_names(self):
        for name in ("../escape", "/escape", "C:/escape", "folder\\escape", "x/./y", "x//y", "NUL", "x:stream", "x. ", "x/COM1.txt", "a\0b"):
            with self.subTest(name=name), self.assertRaises(ValueError): gd.safe_path(name)
        archive, _ = self.package()
        for name in ("../escape", "/escape", "Selection/../../outside"):
            modified = self.root/(str(uuid.uuid4())+".zip"); shutil.copyfile(archive, modified)
            with zipfile.ZipFile(modified, "a") as output: output.writestr(name, b"bad")
            with self.assertRaises(ValueError): gd.extract_package(modified, self.root/"escape-output")
        self.assertFalse((self.root.parent/"escape").exists())

    def test_symbolic_and_special_archive_entries_rejected(self):
        archive, _ = self.package()
        with zipfile.ZipFile(archive, "a") as z:
            entry = zipfile.ZipInfo("Selection/escape"); entry.create_system=3; entry.external_attr=(stat.S_IFLNK|0o777)<<16
            z.writestr(entry, "../../outside")
        with self.assertRaises(ValueError): gd.inspect_package(archive)

    def test_case_duplicate_entries_rejected(self):
        archive, _ = self.package()
        with zipfile.ZipFile(archive, "a") as z: z.writestr("selection/EMPTY-FILE", b"")
        with self.assertRaises(ValueError): gd.inspect_package(archive)

    def test_size_and_entry_limits_are_bounded(self):
        archive, _ = self.package()
        with self.assertRaisesRegex(ValueError, "size"): gd.inspect_package(archive, max_bytes=1)
        with patch.object(gd, "MAX_ENTRIES", 1), self.assertRaises(ValueError): gd.snapshot(self.source)

    def test_source_changes_during_packaging_retain_original(self):
        original = gd.snapshot
        calls = 0
        def changing(path):
            nonlocal calls
            calls += 1
            if calls == 2: (self.source/"changed").write_text("new")
            return original(path)
        archive = self.root/"changed.zip"
        with patch.object(gd, "snapshot", side_effect=changing), self.assertRaisesRegex(ValueError, "original changed"):
            gd.make_package(self.source, archive)
        self.assertTrue(self.source.exists()); self.assertFalse(archive.exists())

    def test_existing_restore_destination_not_overwritten(self):
        archive, _ = self.package()
        destination = self.root/"existing"; destination.mkdir(); (destination/"precious").write_text("keep")
        with self.assertRaises(ValueError): gd.extract_package(archive, destination)
        self.assertEqual((destination/"precious").read_text(), "keep")

    @unittest.skipIf(sys.platform == "win32", "Requires Unix symbolic links")
    def test_symlink_source_never_followed(self):
        (self.source/"external").symlink_to(self.root/"outside")
        with self.assertRaises(ValueError): gd.snapshot(self.source)

    def test_native_executable_detection_blocks_scripts(self):
        script=self.root/"app"; script.write_text("#!/bin/sh\necho unsafe shell script\n")
        with self.assertRaises(ValueError): gd.executable_platform(script)

    def test_foreign_platform_package_cannot_launch(self):
        # Parse a PE machine header without executing it.
        app=self.root/"foreign.exe"; head=bytearray(88); head[:2]=b"MZ"; struct.pack_into("<I",head,60,64);head[64:68]=b"PE\0\0";struct.pack_into("<H",head,68,0x8664);app.write_bytes(head)
        self.assertEqual(gd.executable_platform(app), ("windows", "x86_64"))
        archive=self.root/"app.zip";gd.make_package(app,archive,application="foreign.exe")
        cache=gd.ManagedCache(self.root/"cache");key=str(uuid.uuid4());cache.stage(archive,key,"free")
        with patch.object(gd, "native_platform", return_value=("linux", "arm64")), self.assertRaises(ValueError): cache.launch(key)
        self.assertTrue(cache.entry(key).exists())

    def test_cache_ownership_and_active_lease_guards(self):
        archive,_=self.package();cache=gd.ManagedCache(self.root/"cache");key=str(uuid.uuid4());cache.stage(archive,key,"free")
        cache.verify(key);(cache.entry(key)/".lease").write_text("running")
        with self.assertRaises(ValueError): cache.evict(key)
        (cache.entry(key)/".lease").unlink();self.assertTrue(cache.evict(key))
        unrelated=self.root/"unrelated";unrelated.mkdir();(unrelated/"original").touch()
        with self.assertRaises(ValueError):gd.ManagedCache(unrelated)

    def test_cache_tampering_requires_fresh_verified_restore(self):
        archive,_=self.package();cache=gd.ManagedCache(self.root/"cache");key=str(uuid.uuid4());cache.stage(archive,key,"free")
        (cache.entry(key)/"Selection/empty-file").write_bytes(b"unexpected")
        with self.assertRaises(ValueError):cache.verify(key)

    def staged_cache(self):
        archive, _ = self.package()
        cache = gd.ManagedCache(self.root/"cache")
        key = str(uuid.uuid4())
        cache.stage(archive, key, "free")
        return cache, key, cache.entry(key)

    def test_evict_retains_changed_payload_before_deleting_any_files(self):
        cache, key, entry = self.staged_cache()
        changed = entry/"Selection/empty-file"
        changed.write_text("new application settings", encoding="utf-8")
        before = gd.snapshot(entry)
        with self.assertRaisesRegex(ValueError, "changed"):
            cache.evict(key)
        self.assertEqual(gd.snapshot(entry), before)
        self.assertEqual(changed.read_text(encoding="utf-8"), "new application settings")

    def test_evict_retains_unexpected_siblings_before_deleting_any_files(self):
        for kind in ("file", "folder"):
            with self.subTest(kind=kind):
                cache, key, entry = self.staged_cache()
                extra = entry/"user-notes"
                if kind == "folder":
                    extra.mkdir(); (extra/"keep.txt").write_text("keep")
                else:
                    extra.write_text("keep")
                before = gd.snapshot(entry)
                with self.assertRaisesRegex(ValueError, "Unexpected cache content"):
                    cache.evict(key)
                self.assertEqual(gd.snapshot(entry), before)

    def test_evict_retains_new_nested_content_before_deleting_any_files(self):
        cache, key, entry = self.staged_cache()
        (entry/"Selection/empty-folder/user-notes.txt").write_text("keep")
        before = gd.snapshot(entry)
        with self.assertRaisesRegex(ValueError, "changed"):
            cache.evict(key)
        self.assertEqual(gd.snapshot(entry), before)

    def test_evict_preserves_sibling_created_during_leaf_cleanup(self):
        cache, key, entry = self.staged_cache()
        extra = entry/"user-notes.txt"
        original = gd.remove_cache_file
        def arriving(path, *args):
            extra.write_text("arrived after verification")
            return original(path, *args)
        with patch.object(gd, "remove_cache_file", side_effect=arriving):
            with self.assertRaisesRegex(ValueError, "retained"):
                cache.evict(key)
        self.assertEqual(extra.read_text(), "arrived after verification")
        self.assertTrue((entry/".gendragoon-entry").is_file())
        self.assertFalse((entry/".lease").exists())

    def test_evict_preserves_nested_file_created_during_leaf_cleanup(self):
        cache, key, entry = self.staged_cache()
        extra = entry/"Selection/empty-folder/user-notes.txt"
        original = gd.remove_cache_file
        def arriving(path, *args):
            extra.write_text("arrived after verification")
            return original(path, *args)
        with patch.object(gd, "remove_cache_file", side_effect=arriving):
            with self.assertRaisesRegex(ValueError, "retained"):
                cache.evict(key)
        self.assertEqual(extra.read_text(), "arrived after verification")
        self.assertTrue((entry/".gendragoon-entry").is_file())

    def test_evict_rechecks_existing_file_before_unlink(self):
        cache, key, entry = self.staged_cache()
        original = gd.remove_cache_file
        changed = []
        def changing(path, *args):
            path.write_text("new user content")
            changed.append(path)
            return original(path, *args)
        with patch.object(gd, "remove_cache_file", side_effect=changing):
            with self.assertRaisesRegex(ValueError, "changed"):
                cache.evict(key)
        self.assertEqual(len(changed), 1)
        self.assertEqual(changed[0].read_text(), "new user content")
        self.assertTrue((entry/".gendragoon-entry").is_file())

    def test_evict_rejects_hardlinked_leaf(self):
        cache, key, entry = self.staged_cache()
        leaf = entry/"Selection/empty-file"
        outside = self.root/"outside-link"
        os.link(leaf, outside)
        before = gd.snapshot(entry)
        with self.assertRaisesRegex(ValueError, "linked node"):
            cache.evict(key)
        self.assertEqual(gd.snapshot(entry), before)
        self.assertTrue(outside.is_file())

    def test_evict_preserves_replaced_directory(self):
        cache, key, entry = self.staged_cache()
        original = gd.remove_cache_file
        saved = self.root/"saved-payload"
        replacement = entry/"Selection"
        first = True
        def replacing(path, *args):
            nonlocal first
            if first:
                first = False
                replacement.rename(saved)
                replacement.mkdir()
                (replacement/"empty-file").write_text("new user content")
            return original(path, *args)
        with patch.object(gd, "remove_cache_file", side_effect=replacing):
            with self.assertRaisesRegex(ValueError, "changed"):
                cache.evict(key)
        self.assertEqual((replacement/"empty-file").read_text(), "new user content")
        self.assertTrue((saved/"empty-file").is_file())

    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("cc"), "Linux C compiler required for changed-data lifecycle fixture")
    def test_native_launch_reports_retained_changed_application_data(self):
        app_dir = self.root/"PortableApp"; app_dir.mkdir()
        code = self.root/"writes-data.c"; executable = app_dir/"app"
        code.write_text('#include <stdio.h>\nint main(void){FILE *f=fopen("settings.txt","w");if(!f)return 1;fputs("user preferences",f);return fclose(f);}\n')
        subprocess.run([shutil.which("cc"), str(code), "-o", str(executable)], check=True, capture_output=True)
        (app_dir/"settings.txt").write_text("defaults")
        archive = self.root/"writes-data.zip"; gd.make_package(app_dir, archive, application="app")
        cache = gd.ManagedCache(self.root/"cache"); key = str(uuid.uuid4()); cache.stage(archive, key, "free")
        with contextlib.redirect_stdout(io.StringIO()):
            result = cache.launch(key)
        self.assertEqual(result["exitCode"], 0)
        self.assertFalse(result["cacheRemoved"])
        self.assertTrue(result["cloudRetained"])
        self.assertIn("changed", result["cacheRetainedReason"])
        self.assertEqual((cache.entry(key)/"PortableApp/settings.txt").read_text(), "user preferences")
        self.assertEqual((app_dir/"settings.txt").read_text(), "defaults")
        self.assertTrue(archive.is_file())

    @unittest.skipIf(sys.platform == "win32", "Requires a Linux ELF executable")
    def test_native_launch_waits_then_evicts_only_managed_cache(self):
        app=self.root/"true";shutil.copy2("/bin/true",app);archive=self.root/"native.zip";gd.make_package(app,archive,application="true")
        cache=gd.ManagedCache(self.root/"cache");key=str(uuid.uuid4());cache.stage(archive,key,"free")
        with contextlib.redirect_stdout(io.StringIO()): result=cache.launch(key)
        self.assertEqual(result,{"exitCode":0,"cacheRemoved":True,"cloudRetained":True})
        self.assertFalse(cache.entry(key).exists());self.assertTrue(app.exists());self.assertTrue(archive.exists())

    @unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("cc"), "Linux C compiler required for helper-process fixture")
    def test_child_process_outlives_launcher_and_blocks_early_cleanup(self):
        code=self.root/"helper.c";app=self.root/"helper"
        code.write_text('#include <unistd.h>\nint main(void){if(fork()==0){usleep(600000);_exit(0);}return 0;}\n')
        subprocess.run([shutil.which("cc"),str(code),"-o",str(app)],check=True,capture_output=True)
        archive=self.root/"helper.zip";gd.make_package(app,archive,application="helper")
        cache=gd.ManagedCache(self.root/"cache");key=str(uuid.uuid4());cache.stage(archive,key,"free")
        started=time.monotonic()
        with contextlib.redirect_stdout(io.StringIO()):result=cache.launch(key)
        self.assertGreaterEqual(time.monotonic()-started,0.5);self.assertTrue(result["cacheRemoved"])

    @unittest.skipUnless(sys.platform == "win32", "Windows Job Object integration runs on the Windows CI runner")
    def test_windows_native_job_launch_and_cache_eviction(self):
        # A copied Windows system utility is a native bounded fixture, with no arguments or network use.
        system=Path(os.environ["SystemRoot"])/"System32/where.exe"
        app=self.root/"where.exe";shutil.copy2(system,app)
        archive=self.root/"windows-app.zip";gd.make_package(app,archive,application="where.exe")
        cache=gd.ManagedCache(self.root/"cache");key=str(uuid.uuid4());cache.stage(archive,key,"free")
        with contextlib.redirect_stdout(io.StringIO()):result=cache.launch(key)
        self.assertIsInstance(result["exitCode"],int);self.assertTrue(result["cacheRemoved"])
        self.assertTrue(app.is_file());self.assertTrue(archive.is_file())

    def test_preload_budget_is_enforced(self):
        file=self.root/"large.bin";file.write_bytes(b"x"*(3*1024*1024))
        self.assertEqual(gd.preload(file,budget=4096),4096)

    def test_parallel_folder_stress_bound(self):
        for i in range(250): (self.source/(f"part-{i:04d}.bin")).write_bytes(bytes([i%256])*1024)
        archive,manifest=self.package()
        def restore(index):
            target=self.root/f"restore-{index}";gd.extract_package(archive,target);return gd.snapshot(target/"Selection")==manifest["entries"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool: self.assertTrue(all(pool.map(restore,range(8))))


class ProtocolTests(unittest.TestCase):
    """Exercise the actual Node transfer router with in-memory GCS/Firestore."""
    @classmethod
    def setUpClass(cls):
        backend=ROOT.parent/"Backend"
        if not shutil.which("node") or not (backend/"node_modules/express").exists():
            raise unittest.SkipTest("Install native/Backend dependencies for real v3 protocol integration tests")
        script="const {fixture}=require('./test_helpers/transfer_fixture');const f=fixture();f.server.once('listening',()=>console.log(f.server.address().port));process.on('SIGTERM',()=>f.close().then(()=>process.exit(0)));"
        cls.server=subprocess.Popen([shutil.which("node"),"-e",script],cwd=backend,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        line=cls.server.stdout.readline().strip()
        if not line.isdigit():
            _,error=cls.server.communicate(timeout=5)
            raise RuntimeError("The real v3 fixture could not start: "+error[:500])
        cls.port=int(line)

    @classmethod
    def tearDownClass(cls):
        cls.server.terminate()
        try:cls.server.wait(timeout=10)
        except subprocess.TimeoutExpired:cls.server.kill();cls.server.wait(timeout=5)
        cls.server.stdout.close();cls.server.stderr.close()

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)
        self.client=gd.CloudClient("good")
        port=self.port
        class LocalFixtureTransport:
            def open(self,request,timeout=90):
                self_test_url=request.full_url.replace(gd.ORIGIN,"http://127.0.0.1:"+str(port),1)
                local=urllib.request.Request(self_test_url,data=request.data,method=request.method,headers=dict(request.header_items()))
                return urllib.request.urlopen(local,timeout=timeout)
        self.client.transport=LocalFixtureTransport()

    def tearDown(self):self.temp.cleanup()

    def test_v3_upload_readback_and_verified_restore(self):
        source=self.root/"files";source.mkdir();(source/"empty").touch();(source/"content.bin").write_bytes(os.urandom(gd.CHUNK+701))
        archive=self.root/"files.zip";manifest=gd.make_package(source,archive)
        with contextlib.redirect_stdout(io.StringIO()):item=self.client.upload(archive,"free",self.root/"checkpoint.json")
        downloaded=self.client.download(item,"free",self.root/"cloud-readback.zip")
        self.assertEqual(gd.digest(archive),gd.digest(downloaded))
        gd.extract_package(downloaded,self.root/"restore")
        self.assertEqual(gd.snapshot(self.root/"restore/files"),manifest["entries"])
        self.assertIn(item["id"],[x["id"] for x in self.client.files("free")])
        self.assertFalse((self.root/"checkpoint.json").exists())

    def test_bad_readback_digest_removes_partial_not_original(self):
        source=self.root/"data";source.write_bytes(b"original")
        with contextlib.redirect_stdout(io.StringIO()):item=self.client.upload(source,"free",self.root/"checkpoint.json")
        item["sha256"]="0"*64
        with self.assertRaisesRegex(ValueError,"SHA-256"):self.client.download(item,"free",self.root/"bad")
        self.assertFalse((self.root/"bad").exists());self.assertEqual(source.read_bytes(),b"original")

    def test_unauthenticated_requests_fail_without_source_changes(self):
        self.client.token="invalid";source=self.root/"original";source.write_bytes(b"keep")
        with self.assertRaisesRegex(ValueError,"HTTP 401"):self.client.upload(source,"free",self.root/"checkpoint.json")
        self.assertEqual(source.read_bytes(),b"keep")

    def test_credentials_never_accepted_in_redirect(self):
        with self.assertRaisesRegex(ValueError,"redirect"):
            gd.NoRedirect().redirect_request(None,None,None,None,None,None)


if __name__ == "__main__":unittest.main(verbosity=2)
