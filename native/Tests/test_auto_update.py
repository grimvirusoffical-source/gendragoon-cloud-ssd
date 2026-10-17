import importlib.util, tempfile, unittest, zipfile, stat, plistlib
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('gd_auto',Path(__file__).resolve().parents[1]/'Resources/gendragoon_auto_update.py');auto=importlib.util.module_from_spec(spec);spec.loader.exec_module(auto)
class AutoUpdateTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name);self.app=self.root/auto.APP_NAME
  self.patches=[patch.object(auto,'ROOT',self.root),patch.object(auto,'APP',self.app),patch.object(auto,'STAGED',self.root/'pending'),patch.object(auto,'STATUS',self.root/'status.json'),patch.object(auto,'sufficient_space',lambda _:None)]
  for p in self.patches:p.start()
 def tearDown(self):
  for p in reversed(self.patches):p.stop()
  self.temp.cleanup()
 def release(self,version,mac=True):
  name=auto.ZIP_PREFIX+version+'.zip';url='https://github.com/'+auto.REPO+'/releases/download/'+version+'/'
  return {'tag_name':version,'draft':False,'prerelease':False,'assets':([{'name':name,'browser_download_url':url+name},{'name':'sha256.txt','browser_download_url':url+'sha256.txt'}]if mac else [])}
 def test_skip_mobile_only_and_prerelease_updates(self):
  newer=self.release('v0.19.0');newer['prerelease']=True
  with patch.object(auto,'installed_version',return_value='0.16.0'),patch.object(auto,'request_json',return_value=[self.release('v0.20.0',False),newer,self.release('v0.17.0')]):self.assertEqual(auto.latest()['version'],'v0.17.0')
 def test_no_downgrade(self):
  with patch.object(auto,'installed_version',return_value='0.16.0'),patch.object(auto,'request_json',return_value=[self.release('v0.15.0')]):self.assertIsNone(auto.latest())
 def test_unexpected_download_host_is_rejected(self):
  r=self.release('v0.17.0');r['assets'][0]['browser_download_url']='https://example.invalid/bad.zip'
  with patch.object(auto,'installed_version',return_value='0.16.0'),patch.object(auto,'request_json',return_value=[r]):self.assertRaises(RuntimeError,auto.latest)
 def test_zip_traversal_and_links_are_rejected(self):
  for name,mode in [('../outside',None),('/outside',None),('GenDragoon Cloud SSD.app/link',stat.S_IFLNK|0o777)]:
   z=self.root/'test.zip'
   with zipfile.ZipFile(z,'w')as f:
    info=zipfile.ZipInfo(name)
    if mode:info.external_attr=mode<<16
    f.writestr(info,'payload')
   self.assertRaises(RuntimeError,auto.validate_zip,z)
 def test_safe_archive_accepted(self):
  z=self.root/'safe.zip'
  with zipfile.ZipFile(z,'w')as f:f.writestr(auto.APP_NAME+'/Contents/Info.plist','plist')
  auto.validate_zip(z)
 def test_concurrent_update_is_locked(self):
  with auto.update_lock():self.assertRaises(RuntimeError,lambda:self.acquire_now())
 def acquire_now(self):
  with auto.update_lock(timeout=0):pass
 def test_wrong_bundle_rejected_before_any_external_process(self):
  (self.app/'Contents').mkdir(parents=True)
  (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'other.app','CFBundleShortVersionString':'0.17.0'}))
  with patch.object(auto,'subprocess_ok',side_effect=AssertionError('must not run')):self.assertRaises(RuntimeError,auto.validate_app,self.app,'v0.17.0')
 def test_gatekeeper_failure_cannot_be_skipped(self):
  (self.app/'Contents').mkdir(parents=True)
  (self.app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':auto.BUNDLE_ID,'CFBundleShortVersionString':'0.17.0','CFBundleExecutable':'App'}))
  (self.app/'Contents/MacOS').mkdir()
  executable=self.app/'Contents/MacOS/App';executable.write_bytes(b'fixture, never executed');executable.chmod(0o755)
  def command(args,**kw):
   if args[0].endswith('spctl'):raise RuntimeError('Not notarized')
   if args[0].endswith('lipo'):return auto.platform.machine()
   if '--verify' in args:self.assertTrue(args[args.index('-R')+1].startswith('=anchor apple generic and identifier '))
   return 'Identifier='+auto.BUNDLE_ID+'\nTeamIdentifier='+auto.TEAM_ID+'\nAuthority=Developer ID Application: Fixture'
  with patch.object(auto,'subprocess_ok',side_effect=command):self.assertRaisesRegex(RuntimeError,'Not notarized',auto.validate_app,self.app,'v0.17.0')
if __name__=='__main__':unittest.main()
