"""Real loopback Unix/named-pipe companion transport, without a GUI/account."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

DESKTOP=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(DESKTOP))
sys.path.insert(0,str(DESKTOP.parent/'Resources'))
from companion_server import CompanionServer
import gendragoon_native_bridge as bridge


class CompanionServerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='gd-native-ipc-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.base=self.root/'base';config=self.base/'NativeMessaging'
        self.config=config/'config.json'
        encoded=json.dumps({'schema':1,'allowedOrigins':[bridge.FIREFOX_ID],'vscodeExtensionId':bridge.VSCODE_ID})
        if sys.platform=='win32':
            from gendragoon_platform_ipc import create_private_directory,create_private_file
            create_private_directory(config)
            with os.fdopen(create_private_file(self.config),'w') as output:output.write(encoded)
        else:
            config.mkdir(mode=0o700,parents=True);self.base.chmod(0o700)
            self.config.write_text(encoded);self.config.chmod(0o600)
        self.seen=[]
        def dispatch(request,done):
            self.seen.append(request)
            done({'ok':True,'result':{'connected':False,'received':request['method']}})
        self.server=CompanionServer(dispatch,base=self.base,socket_directory=self.root/'socket',timeout=2)
        self.server.start();self.addCleanup(self.server.close)

    def request(self,method='status',params=None,client=None):
        return bridge.socket_request({'id':os.urandom(16).hex(),'method':method,'params':params or {}},
            client or {'kind':'browser','id':bridge.FIREFOX_ID},self.server.locator)

    def test_real_transport_bounds_calls_and_injects_validated_local_identity(self):
        self.assertTrue(self.request()['ok'])
        self.assertEqual(self.seen[0]['_clientId'],bridge.FIREFOX_ID)
        self.assertEqual(self.seen[0]['_clientKind'],'browser')
        with ThreadPoolExecutor(max_workers=6) as executor:
            values=list(executor.map(lambda _:self.request(),range(36)))
        self.assertTrue(all(value['ok'] for value in values))

    def test_unlisted_clients_and_storage_actions_never_reach_gui(self):
        for method,params,client in [
            ('status',{}, {'kind':'browser','id':'chrome-extension://'+'a'*32+'/'}),
            ('request',{'path':'/v1/receivers/me/blobs','method':'DELETE'},None),
            ('uploadSelection',{'workspaceId':'b'*32,'selectedPaths':[str(self.root/'source')]},None),
            ('request',{'path':'/v1/integrations/keys','method':'GET'},None),
        ]:
            response=self.request(method,params,client)
            self.assertFalse(response['ok'])
        self.assertEqual(self.seen,[])

    def test_vscode_selection_is_data_and_metadata_proxy_has_no_file_contents(self):
        value=self.request('uploadSelection',{'workspaceId':'b'*32,'selectedPaths':[str(self.root/'source with spaces.txt')]},
            {'kind':'vscode','id':bridge.VSCODE_ID})
        self.assertTrue(value['ok'])
        self.assertEqual(self.seen[-1]['params']['selectedPaths'],[str(self.root/'source with spaces.txt')])
        response=self.request('request',{'path':'/v1/receivers/me/dev-teams?limit=50','method':'GET'})
        self.assertTrue(response['ok'])

    def test_another_listener_cannot_replace_a_live_endpoint(self):
        other=CompanionServer(lambda *_:None,base=self.base,socket_directory=self.root/'socket')
        with self.assertRaises((OSError,bridge.BridgeError)):other.start()
        self.assertTrue(self.request()['ok'])


@unittest.skipUnless(sys.platform=='win32','Windows ACL and named-pipe runtime')
class WindowsSecurityTests(unittest.TestCase):
    def test_public_acl_is_rejected_and_private_acl_is_verified(self):
        from gendragoon_platform_ipc import create_private_file,verify_private,modules
        *_,security=modules()
        with tempfile.TemporaryDirectory() as td:
            path=Path(td)/'private.json'
            with os.fdopen(create_private_file(path),'w') as output:output.write('{}')
            verify_private(path)
            descriptor=security.GetFileSecurity(str(path),security.DACL_SECURITY_INFORMATION)
            acl=descriptor.GetSecurityDescriptorDacl()
            everyone=security.ConvertStringSidToSid('S-1-1-0')
            acl.AddAccessAllowedAce(security.ACL_REVISION,0x120089,everyone)
            security.SetNamedSecurityInfo(str(path),security.SE_FILE_OBJECT,security.DACL_SECURITY_INFORMATION,None,None,acl,None)
            with self.assertRaises(OSError):verify_private(path)


if __name__=='__main__':unittest.main()
