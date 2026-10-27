import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('runtime_sync',ROOT/'sync_runtime.py')
sync=importlib.util.module_from_spec(spec);spec.loader.exec_module(sync)
COMMIT='9235941b431bc1c23c34286b82052f845121592f'

class RuntimeBundleTests(unittest.TestCase):
    def test_exact_public_runtime_verifies_both_architectures_without_private_checkout(self):
        with tempfile.TemporaryDirectory(prefix='gd-runtime-') as directory:
            manifest=sync.unpack_runtime(sync.PACKAGED_RUNTIME,sync.PACKAGED_RUNTIME_SHA256,COMMIT,Path(directory))
            self.assertEqual(manifest['abis'],['arm64-v8a','x86_64'])
            self.assertEqual(len(manifest['files']),37)
            self.assertFalse(list(Path(directory).rglob('*.py')))
    def test_corrupt_pin_and_different_vendor_commit_are_refused(self):
        with tempfile.TemporaryDirectory(prefix='gd-runtime-') as directory:
            target=Path(directory)/'output'
            with self.assertRaises(RuntimeError):sync.unpack_runtime(sync.PACKAGED_RUNTIME,'0'*64,COMMIT,target)
            with self.assertRaises(RuntimeError):sync.unpack_runtime(sync.PACKAGED_RUNTIME,sync.PACKAGED_RUNTIME_SHA256,'0'*40,target)
            self.assertFalse(target.exists())
    def test_a_rehashed_archive_with_private_source_is_still_refused(self):
        with tempfile.TemporaryDirectory(prefix='gd-runtime-') as directory:
            bad=Path(directory)/'forbidden.zip';data=b'private-source-is-forbidden\n'
            with zipfile.ZipFile(sync.PACKAGED_RUNTIME) as original:
                manifest=json.loads(original.read('manifest.json'))
                manifest['files']['python/redxai/leak.py']={'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
                with zipfile.ZipFile(bad,'w') as archive:
                    for name in original.namelist():
                        if name!='manifest.json':archive.writestr(name,original.read(name))
                    archive.writestr('python/redxai/leak.py',data);archive.writestr('manifest.json',json.dumps(manifest))
            with self.assertRaisesRegex(RuntimeError,'Source files'):sync.unpack_runtime(bad,hashlib.sha256(bad.read_bytes()).hexdigest(),COMMIT,Path(directory)/'output')

if __name__=='__main__':unittest.main()
