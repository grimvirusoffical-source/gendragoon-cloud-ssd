"""Disposable GenDragoon device identities and unchanged Red-SecretsXAI receipts."""
from pathlib import Path
import base64
import hashlib
import json
import os
import plistlib
import sys
import tempfile
import types
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'Resources'))
import gendragoon_signed_device as devices
OWNER='a'*64
RAW='12345678-9abc-def0-1234-56789abcdef0'

class DeviceIdentityTests(unittest.TestCase):
    def test_mac_uses_platform_uuid_but_exposes_only_account_scoped_digest(self):
        response=types.SimpleNamespace(stdout=plistlib.dumps([{'IOPlatformUUID':RAW}]))
        call=lambda *a,**k:response
        first=devices.fingerprint(OWNER,system='darwin',run=call)
        second=devices.fingerprint(OWNER,system='darwin',run=call)
        other=devices.fingerprint('b'*64,system='darwin',run=call)
        self.assertEqual(first,second)
        self.assertNotEqual(first['deviceFingerprint'],other['deviceFingerprint'])
        self.assertFalse(first['immutable'])
        self.assertNotIn(RAW,json.dumps(first));self.assertNotIn(RAW.replace('-',''),json.dumps(first))
        self.assertEqual(first['platform'],'macos')
    def test_windows_uses_fixed_noninteractive_cim_not_client_command(self):
        calls=[]
        def run(args,**kwargs):calls.append(args);return types.SimpleNamespace(stdout=RAW.encode())
        r=devices.fingerprint(OWNER,system='win32',run=run)
        self.assertEqual(r['platform'],'windows')
        self.assertIn('-NoProfile',calls[0]);self.assertIn('Win32_ComputerSystemProduct',calls[0][-1])
    def test_linux_dmi_and_machine_id_fallback_are_both_explicit(self):
        raw=RAW.replace('-','')
        r=devices.fingerprint(OWNER,system='linux',read=lambda _:raw)
        self.assertEqual(r['source'],'DMI-product-UUID')
        def read(path):
            if path.startswith('/sys/'):raise PermissionError()
            return raw
        r=devices.fingerprint(OWNER,system='linux',read=read)
        self.assertEqual(r['source'],'machine-id')
    def test_invalid_identity_never_becomes_random_registration(self):
        for value in ('', '0'*32,'f'*32,'bad', '../id'):
            with self.subTest(value=value), self.assertRaises(ValueError):devices.normalized_id(value)
        with self.assertRaises(ValueError):devices.fingerprint('other',system='linux',read=lambda _:RAW)
        with self.assertRaises(ValueError):devices.collect_id(system='unsupported')

@unittest.skipUnless(os.environ.get('GDG_TEST_ACTUAL_CRYPTO')=='1','explicit packaged crypto fixture required')
class RealReceiptTests(unittest.TestCase):
    def test_original_codec_authenticates_receipt_and_wrong_workspace_is_rejected(self):
        import gendragoon_redx_storage as storage
        with tempfile.TemporaryDirectory(prefix='gdg-receipt-fixture-',dir='/private/tmp' if sys.platform=='darwin' else None) as td:
            root=Path(td).resolve()
            config={'provider':'redxai','cloudApi':storage.API,'receiverId':OWNER,'workspaceId':'b'*32,
                    'bearerToken':'rxca_'+'X'*43,'storageSecret':'a'*64,'keymapPath':str(root/'keymap')}
            with patch.object(devices,'collect_id',return_value=(RAW.replace('-',''),'macos','fixture')):
                result=devices.prepare_receipt(config)
            raw=base64.b64decode(result['qr']['png'])
            self.assertEqual(hashlib.sha256(raw).hexdigest(),result['qr']['sha256'])
            self.assertNotIn(RAW,json.dumps(result))
            with storage.Codec(storage.RedXReceiver(config)) as codec:
                opened=json.loads(codec.open(raw,result['qr']['objectId']))
            self.assertEqual(opened['schema'],'GDGSigned/v1')
            self.assertEqual(opened['deviceFingerprint'],result['deviceFingerprint'])
            self.assertNotIn('bearerToken',opened);self.assertNotIn('storageSecret',opened)
            with storage.Codec(storage.RedXReceiver(dict(config,workspaceId='c'*32))) as codec:
                with self.assertRaises(Exception):codec.open(raw,result['qr']['objectId'])
            print('Actual encrypted receipt bytes:',len(raw))

if __name__=='__main__':unittest.main()
