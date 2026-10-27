"""No real user processes, account credentials, cloud I/O or offloads."""
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, Mock

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
import app_platform
import portable_control as control
import portable_apps as apps


class PlatformTests(unittest.TestCase):
    def test_matched_os_and_installers(self):
        self.assertTrue(app_platform.playable({'name':'Game.exe','kind':'file'},'windows'))
        self.assertFalse(app_platform.playable({'name':'Game.exe','kind':'file'},'linux'))
        self.assertTrue(app_platform.playable({'name':'Game.AppImage','kind':'file'},'linux'))
        self.assertFalse(app_platform.playable({'name':'Game.AppImage','kind':'file'},'windows'))
        for name in ('install.msi','install.deb','install.apk','install.ipa'):
            self.assertFalse(app_platform.playable({'name':name,'kind':'file'},'windows'))
            self.assertFalse(app_platform.playable({'name':name,'kind':'file'},'linux'))
        self.assertFalse(app_platform.playable({'name':'Game.app','kind':'app'},'windows'))
    def test_sessions_are_account_workspace_scoped_and_no_process_paths(self):
        record={'id':'a'*32,'state':'running','path':'/secret/cache','brokerPid':555,
                'identity':{'receiverId':'owner','workspaceId':'note','key':'app'}}
        self.assertEqual(app_platform.public_sessions([record],'other'),[])
        self.assertEqual(app_platform.public_sessions([record],'owner','other'),[])
        self.assertEqual(set(app_platform.public_sessions([record],'owner','note')[0]),{'id','key','workspaceId','state'})


class StopRequestTests(unittest.TestCase):
    def setUp(self):
        self.id='a'*32
        self.record={'id':self.id,'brokerIdentity':'stable','brokerPid':12,'state':'running'}
        self.message={'schema':1,'id':self.id,'brokerIdentity':'stable','mode':'graceful','createdAt':100,'nonce':'b'*32}
        self.reader=Mock(side_effect=lambda _:dict(self.message))
        self.controller=control.StopControl('/private/lease-'+self.id+'.json',self.record,self.reader,lambda pid:'stable',clock=lambda:110)
    def test_requires_exact_live_broker_identity_and_fresh_confirmation(self):
        self.assertEqual(self.controller.poll(),'graceful')
        for field,bad in [('id','x'*32),('brokerIdentity','reused'),('createdAt',-1000),('createdAt',500),('mode','shell'),('nonce','')]:
            previous=self.message[field];self.message[field]=bad
            fresh=control.StopControl('/private/lease-'+self.id+'.json',self.record,self.reader,lambda pid:'stable',clock=lambda:110)
            self.assertIsNone(fresh.poll(),field);self.message[field]=previous
    def test_force_requires_distinct_explicit_message_never_automatic(self):
        self.assertEqual(self.controller.poll(),'graceful')
        self.message.update(mode='force',nonce='c'*32)
        self.assertEqual(self.controller.poll(),'force')
        self.message.update(mode='graceful',nonce='d'*32)
        self.assertEqual(self.controller.poll(),'force')
    def test_missing_request_never_stops(self):
        self.reader.side_effect=FileNotFoundError()
        self.assertIsNone(self.controller.poll())
    def test_reused_pid_is_not_signaled(self):
        current=os.getpid()
        def identity(pid):return 'stable' if pid==current else 'first' if calls.pop() else 'second'
        calls=[False,True]
        self.controller.identity=identity
        with patch.object(control,'linux_descendants',return_value=[44]),patch.object(control.os,'pidfd_open',return_value=55,create=True),patch.object(control.signal,'pidfd_send_signal',create=True) as send,patch.object(control.os,'close'):
            control.stop_linux(self.controller)
            send.assert_not_called()
    def test_only_owned_descendants_get_bound_signals_once_per_mode(self):
        with patch.object(control,'linux_descendants',return_value=[44]),patch.object(control.os,'pidfd_open',return_value=55,create=True),patch.object(control.signal,'pidfd_send_signal',create=True) as send,patch.object(control.os,'close'):
            control.stop_linux(self.controller);control.stop_linux(self.controller)
            self.assertEqual(send.call_count,1)
            self.message.update(mode='force',nonce='e'*32)
            control.stop_linux(self.controller)
            self.assertEqual(send.call_count,2)
    def test_stop_writer_requires_consent_and_known_session(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td).resolve();os.chmod(root,0o700)
            manager=apps.PortableApps(root);record=dict(self.record,path=str(root/('lease-'+self.id+'.json')))
            with patch.object(manager,'leases',return_value=[record]),patch.object(apps,'process_identity',return_value='stable'):
                with self.assertRaises(apps.PortableAppError):manager.request_stop(self.id)
                result=manager.request_stop(self.id,approved=True)
                self.assertTrue(result['requested']);self.assertFalse(result['force'])
                value=apps._read(root/('stop-'+self.id+'.json'))
                self.assertEqual(value['mode'],'graceful')
                with patch.object(apps,'process_identity',return_value='different'):
                    with self.assertRaises(apps.PortableAppError):manager.request_stop(self.id,force=True,approved=True)

if __name__=='__main__':unittest.main()
