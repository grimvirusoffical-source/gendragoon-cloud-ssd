"""Disposable-source offload guardrails; never touches user files or processes."""
import hashlib
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import verified_offload as offload

class VerifiedOffloadTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='gd-offload-fixture-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.source=self.root/'portable-fixture.bin'
        self.source.write_bytes(b'generated fixture, not user content')
        self.trash=self.root/'test-trash';self.trash.mkdir()
    def snapshot(self,path):
        st=Path(path).stat()
        return (st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns,hashlib.sha256(Path(path).read_bytes()).hexdigest())
    def move(self,path):shutil.move(path,str(self.trash/Path(path).name))
    def test_verified_source_moves_only_after_explicit_opt_in(self):
        before=self.snapshot(self.source)
        with self.assertRaises(offload.OffloadError):
            offload.trash_verified(self.source,before,self.snapshot,trash=self.move,process_check=lambda _:[])
        self.assertTrue(self.source.exists())
        result=offload.trash_verified(self.source,before,self.snapshot,approved=True,trash=self.move,process_check=lambda _:[])
        self.assertTrue(result['offloaded']);self.assertFalse(result['originalRetained'])
        self.assertEqual((self.trash/self.source.name).read_bytes(),b'generated fixture, not user content')
    def test_changed_original_is_not_trashed(self):
        before=self.snapshot(self.source);self.source.write_bytes(b'new unsaved app content')
        with self.assertRaises(offload.OffloadError):
            offload.trash_verified(self.source,before,self.snapshot,approved=True,trash=self.move,process_check=lambda _:[])
        self.assertEqual(self.source.read_bytes(),b'new unsaved app content');self.assertEqual(list(self.trash.iterdir()),[])
    def test_restarted_app_prevents_offload(self):
        with self.assertRaises(offload.OffloadError):
            offload.trash_verified(self.source,self.snapshot(self.source),self.snapshot,approved=True,trash=self.move,process_check=lambda _:[object()])
        self.assertTrue(self.source.exists())
    def test_unavailable_trash_never_falls_back_to_deletion(self):
        def refused(_):raise PermissionError('fixture Trash unavailable')
        with self.assertRaisesRegex(offload.OffloadError,'Original retained'):
            offload.trash_verified(self.source,self.snapshot(self.source),self.snapshot,approved=True,trash=refused,process_check=lambda _:[])
        self.assertTrue(self.source.exists());self.assertEqual(list(self.trash.iterdir()),[])
    def test_fake_trash_success_is_not_accepted(self):
        with self.assertRaises(offload.OffloadError):
            offload.trash_verified(self.source,self.snapshot(self.source),self.snapshot,approved=True,trash=lambda _:None,process_check=lambda _:[])
        self.assertTrue(self.source.exists())
    def test_home_roots_and_interpreter_are_protected(self):
        for path in (Path.home(),Path(self.root.anchor),Path(sys.executable)):
            with self.subTest(path=path),self.assertRaises(offload.OffloadError):offload.checked_source(path)

@unittest.skipUnless(sys.platform.startswith('linux'),'actual freedesktop Trash test on Linux only')
class NativeTrashTests(unittest.TestCase):
    def test_disposable_original_is_in_os_trash_and_readable(self):
        from send2trash import send2trash
        with tempfile.TemporaryDirectory(prefix='gd-native-trash-') as td:
            root=Path(td).resolve();data=root/'xdg';data.mkdir(mode=0o700);source=root/'generated-only.txt';source.write_bytes(b'test-only content')
            with patch.dict(os.environ,{'XDG_DATA_HOME':str(data)}):
                # send2trash reads XDG configuration at import time. Use a child
                # interpreter to prove this install's actual OS Trash operation.
                import subprocess
                done=subprocess.run([sys.executable,'-B','-c','from send2trash import send2trash; import sys; send2trash(sys.argv[1])',str(source)],capture_output=True,text=True,timeout=20)
            self.assertEqual(done.returncode,0,done.stderr)
            self.assertFalse(source.exists())
            copies=list((data/'Trash/files').glob('generated-only*'))
            self.assertEqual(len(copies),1);self.assertEqual(copies[0].read_bytes(),b'test-only content')

if __name__=='__main__':unittest.main()
