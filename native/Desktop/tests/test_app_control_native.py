"""Run only generated portable binaries on the actual target OS; no real app offloads."""
from pathlib import Path
import os
import sys
import tempfile
import time
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))

@unittest.skipUnless(sys.platform=='win32' or sys.platform.startswith('linux'),'Windows/Linux process tree required')
class NativeStopTests(unittest.TestCase):
    def test_force_stops_only_the_selected_managed_app_tree_and_keeps_cloud_cache(self):
        from test_machinenotes import compile_portable_fixture,prepare_native_fixture,wait_fixture,finish_native_fixture
        import portable_apps as apps
        with tempfile.TemporaryDirectory(prefix='gd-explicit-stop-') as td:
            root=Path(td).resolve();binary=compile_portable_fixture(root)
            manager=apps.PortableApps(root/'sessions')
            first=prepare_native_fixture(manager,binary);second=prepare_native_fixture(manager,binary)
            try:
                a=manager.launch(first,binary.name,approved=True)
                b=manager.launch(second,binary.name,approved=True)
                wait_fixture(lambda:(first.payload/'child-heartbeat').exists() and (second.payload/'child-heartbeat').exists())
                manager.request_stop(a['id'],force=True,approved=True)
                wait_fixture(lambda:next(r for r in manager.leases() if r.get('id')==a['id'])['state']=='complete')
                self.assertEqual(next(r for r in manager.leases() if r.get('id')==b['id'])['state'],'running')
                before=(second.payload/'child-heartbeat').read_text();time.sleep(.25)
                self.assertNotEqual(before,(second.payload/'child-heartbeat').read_text())
                self.assertTrue((first.payload/binary.name).exists())
                self.assertTrue(binary.exists())
            finally:
                finish_native_fixture(manager,first)
                finish_native_fixture(manager,second)

if __name__=='__main__':unittest.main()
