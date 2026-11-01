import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import storage_secret_store as store

RECEIVER="a"*64
SECRET="A"*43

class StorageSecretStoreTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform=="win32","Actual Windows DPAPI required")
    def test_windows_dpapi_roundtrip_and_no_plaintext(self):
        with tempfile.TemporaryDirectory() as td, patch.dict(os.environ,{"LOCALAPPDATA":td}):
            self.assertTrue(store.save(RECEIVER,SECRET))
            path=Path(td)/"GenDragoon"/"MachineNotes"/"SecureVault"/(RECEIVER+".dpapi")
            self.assertTrue(path.is_file())
            self.assertNotIn(SECRET.encode(),path.read_bytes())
            self.assertEqual(store.load(RECEIVER),SECRET)
            store.clear(RECEIVER)
            self.assertIsNone(store.load(RECEIVER))

    def test_invalid_identity_and_secret_rejected(self):
        with self.assertRaises(store.StorageSecretError):store.save("bad",SECRET)
        with self.assertRaises(store.StorageSecretError):store.save(RECEIVER,"short")

    @unittest.skipUnless(sys.platform.startswith("linux"),"Linux-only plaintext-fallback guard")
    def test_linux_without_secret_service_refuses_persistence(self):
        with patch.object(store.shutil,"which",return_value=None):
            self.assertFalse(store.available())
            with self.assertRaises(store.StorageSecretError):store.save(RECEIVER,SECRET)
            self.assertIsNone(store.load(RECEIVER))

if __name__=="__main__":unittest.main()
