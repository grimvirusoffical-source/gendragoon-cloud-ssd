import base64
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('asset_adapter',ROOT/'app/src/main/python/gendragoon_android.py');adapter=importlib.util.module_from_spec(spec);spec.loader.exec_module(adapter)

class CompiledAssetsTests(unittest.TestCase):
    def archive(self):return (ROOT/'app/build/generated/cryptoAssets/gendragoon-crypto/compiled-python.zip').read_bytes()
    def test_all_frozen_bytecode_is_extracted_as_private_verified_data_without_source(self):
        raw=self.archive()
        with tempfile.TemporaryDirectory()as directory:
            root=adapter.compiled_modules(base64.b64encode(raw).decode(),directory)
            self.assertEqual(len(list(root.rglob('*.pyc'))),31);self.assertFalse(list(root.rglob('*.py')))
            self.assertEqual((root/'redxai/_librsx.pyc').stat().st_mode&0o777,0o600)
            self.assertEqual(adapter.compiled_modules(base64.b64encode(raw).decode(),directory),root)
            (root/'redxai/_librsx.pyc').write_bytes(b'corruption')
            with self.assertRaisesRegex(RuntimeError,'differs'):adapter.compiled_modules(base64.b64encode(raw).decode(),directory)
    def test_corrupt_asset_member_is_rejected_before_installation(self):
        with zipfile.ZipFile(io.BytesIO(self.archive()))as original:
            files={name:original.read(name)for name in original.namelist()}
        files['redxai/_librsx.pyc']=files['redxai/_librsx.pyc'][:-1]+b'\0';bad=io.BytesIO()
        with zipfile.ZipFile(bad,'w')as archive:
            for name,data in files.items():archive.writestr(name,data)
        with tempfile.TemporaryDirectory()as directory:
            with self.assertRaisesRegex(RuntimeError,'integrity'):adapter.compiled_modules(base64.b64encode(bad.getvalue()).decode(),directory)
            self.assertEqual(list(Path(directory).iterdir()),[])

if __name__=='__main__':unittest.main()
