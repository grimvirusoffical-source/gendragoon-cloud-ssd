import hashlib, importlib.util, json, os, plistlib, tempfile, time, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('gd_preload',Path(__file__).resolve().parents[1]/'Resources/gendragoon_preload.py')
preload=importlib.util.module_from_spec(spec);spec.loader.exec_module(preload)
class PreloadTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name).resolve()
        self.app=self.root/'Example.app';contents=self.app/'Contents'
        (contents/'MacOS').mkdir(parents=True);(contents/'Resources').mkdir()
        (contents/'Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'Example'}))
        (contents/'MacOS/Example').write_bytes(b'x'*(3*1024*1024))
        (contents/'Resources/huge.pak').write_bytes(b'y'*(2*1024*1024))
        self.usage=type('Usage',(),{'free':100*1024**3})()
    def tearDown(self):self.temp.cleanup()
    def test_startup_executable_before_large_assets(self):
        files=preload.candidates(self.app)
        self.assertEqual(files[0].name,'Info.plist')
        self.assertLess(files.index(self.app/'Contents/MacOS/Example'),files.index(self.app/'Contents/Resources/huge.pak'))
    def test_budget_is_shared_across_workers_and_does_not_modify_content(self):
        before={p:hashlib.sha256(p.read_bytes()).hexdigest() for p in self.app.rglob('*') if p.is_file()}
        with patch.object(preload.shutil,'disk_usage',return_value=self.usage):
            result=preload.warm(self.app,mb=1,limit=5,workers=4)
        self.assertTrue(result['ok']);self.assertLessEqual(result['bytesWarmed'],1024**2);self.assertGreater(result['filesWarmed'],1)
        self.assertEqual(before,{p:hashlib.sha256(p.read_bytes()).hexdigest() for p in before})
    def test_plan_contains_nonoverlapping_ranges_and_exact_budget(self):
        tasks=preload.plan(self.app,512*1024,time.monotonic()+3)
        self.assertLessEqual(sum(n for _,_,n in tasks),512*1024)
        offsets={}
        for path,start,size in tasks:
            for oldstart,oldend in offsets.get(path,[]):self.assertTrue(start>=oldend or start+size<=oldstart)
            offsets.setdefault(path,[]).append((start,start+size))
    def test_internal_framework_links_are_supported_but_external_links_excluded(self):
        framework=self.app/'Contents/Frameworks/Kit.framework';(framework/'Versions/A').mkdir(parents=True)
        (framework/'Versions/A/Kit').write_bytes(b'framework')
        (framework/'Kit').symlink_to('Versions/A/Kit')
        outside=self.root/'outside-private-file';outside.write_bytes(b'not for preloading')
        (self.app/'Contents/Resources/escape').symlink_to(outside)
        files=preload.candidates(self.app)
        self.assertIn(framework/'Versions/A/Kit',files);self.assertNotIn(outside,files)
    def test_data_saver_does_not_read_files(self):
        with patch.object(preload,'candidates',side_effect=AssertionError('must not scan')):
            result=preload.warm(self.app,constrained=True)
        self.assertEqual(result['bytesWarmed'],0);self.assertEqual(result['skipped'],'data-saver')
    def test_low_disk_does_not_read_files(self):
        low=type('Usage',(),{'free':preload.MIN_FREE})()
        with patch.object(preload.shutil,'disk_usage',return_value=low),patch.object(preload,'candidates',side_effect=AssertionError('must not scan')):
            result=preload.warm(self.app)
        self.assertEqual(result['skipped'],'low-disk-space')
    def test_expired_planning_deadline_returns_no_work(self):
        self.assertEqual(preload.plan(self.app,1024,time.monotonic()-1),[])

    def test_large_budget_extends_executable_reads_but_stays_bounded(self):
        executable=self.app/'Contents/MacOS/Example'
        with executable.open('wb') as handle:handle.truncate(160*1024*1024)
        jobs=preload.plan(self.app,256*1024*1024,time.monotonic()+5)
        warmed=sum(n for p,_,n in jobs if p==executable)
        self.assertGreater(warmed,16*1024*1024)
        self.assertLessEqual(warmed,64*1024*1024)
        self.assertLessEqual(sum(n for _,_,n in jobs),256*1024*1024)

    def test_larger_warm_requires_its_actual_cache_budget_before_reading(self):
        low=type('Usage',(),{'free':preload.MIN_FREE+512*1024**2-1})()
        with patch.object(preload.shutil,'disk_usage',return_value=low),patch.object(preload,'candidates',side_effect=AssertionError('must not read')):
            self.assertEqual(preload.warm(self.app,mb=512)['skipped'],'low-disk-space')
    def test_escaping_registered_cloud_path_is_rejected(self):
        library=self.root/'library.json';library.write_text(json.dumps({'evil':{'format':'raw','remote':'gendragoon','cloudPath':'gen-dragoon-ssd/../escape.app'}}))
        mount=self.root/'mount';mount.mkdir()
        with patch.object(preload,'LIB',library),patch.object(preload,'MOUNT',mount),patch.object(preload.os.path,'ismount',return_value=True):
            with self.assertRaises(ValueError):preload.bundle('evil')
if __name__=='__main__':unittest.main()
