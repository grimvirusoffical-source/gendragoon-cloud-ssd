"""Compact encrypted uploads use unchanged RSX3 protection and old-reader format."""
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

NATIVE=Path(__file__).resolve().parents[1]
sys.path[:0]=[str(NATIVE/'Resources'),str(NATIVE/'Tests')]
import gendragoon_storage_mode as mode
import gendragoon_redx_storage as storage
from test_redx_transfer_performance import FixtureReceiver,config

class ModePolicyTests(unittest.TestCase):
    def test_defaults_and_explicit_modes(self):
        self.assertEqual(mode.normalize_mode(), 'standard')
        self.assertEqual(mode.normalize_mode(False), 'off')
        self.assertEqual(mode.normalize_mode(encryption_mode='fast'), 'fast')
        for value in ('weak','',True,[],{}):
            with self.subTest(value=value), self.assertRaises(storage.RedXStorageError):
                mode.normalize_mode(encryption_mode=value)
        with self.assertRaises(storage.RedXStorageError):mode.normalize_mode(False,'fast')

    def test_original_mode_never_changes_cipher_adapter(self):
        args=({},'/unused','a'*18,'file','file','flat','b'*64,[])
        with patch.object(storage,'upload_archive',return_value={'legacy':True}) as original:
            self.assertEqual(mode.upload_archive(*args,encryption_mode='standard'),{'legacy':True})
            original.assert_called_once_with(*args,None,None,None)

@unittest.skipUnless(os.environ.get('GENDRAGOON_TEST_RSX_LIB'),'explicit disposable native crypto test runtime required')
class ActualCompactEncryptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        os.environ['RSX_LIB']=os.environ['GENDRAGOON_TEST_RSX_LIB']
        runtime=os.environ.get('GENDRAGOON_TEST_RSX_PYTHON')
        if runtime:sys.path.insert(0,runtime)
        storage._crypto_runtime()

    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='gd-compact-test-')
        self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve()
        self.cfg=config(self.root)
        FixtureReceiver.blobs={};FixtureReceiver.items={};FixtureReceiver.writes=0
        FixtureReceiver.allowance=2

    def test_fast_upload_reads_with_old_codec_reuses_ciphertext_and_rejects_wrong_workspace(self):
        source=self.root/'archive';data=os.urandom(1024*1024+17);source.write_bytes(data)
        digest=hashlib.sha256(data).hexdigest();manifest=[{'path':'.','size':len(data),'sha256':digest}]
        args=(self.cfg,source,'c'*18,'archive','file','flat',digest,manifest)
        result=mode.upload_archive(*args,encryption_mode='fast',client_factory=FixtureReceiver)
        self.assertTrue(result['encrypted']);self.assertEqual(result['encryptionMode'],'fast')
        writes=FixtureReceiver.writes
        again=mode.upload_archive(*args,encryption_mode='fast',client_factory=FixtureReceiver)
        self.assertEqual(result,again);self.assertEqual(writes,FixtureReceiver.writes)
        item=FixtureReceiver.items['c'*18];target=self.root/'restored'
        # Use the unchanged legacy entrypoint: compact objects require no switch.
        restored=storage.download_archive(self.cfg,item,target,client_factory=FixtureReceiver)
        self.assertEqual(target.read_bytes(),data);self.assertEqual(restored['manifest'],manifest)
        self.assertEqual(restored['root']['storageProfile'],mode.COMPACT_PROFILE)
        wrong=FixtureReceiver(dict(self.cfg,workspaceId='d'*32))
        with storage.Codec(wrong) as codec:
            with self.assertRaises(Exception):codec.open(FixtureReceiver.blobs[item['manifestId']],item['manifestId'])
        # A wrong-AAD rejection must not kill or corrupt the native process.
        with storage.Codec(FixtureReceiver(self.cfg)) as codec:
            self.assertTrue(codec.open(FixtureReceiver.blobs[item['manifestId']],item['manifestId']).startswith(b'{'))

    def test_old_file_ciphertext_opens_and_repeated_final_auth_errors_do_not_crash(self):
        receiver=FixtureReceiver(self.cfg);oid='d'*32;data=b'fixture data without user content'
        from redsecretsxai import encode_storage_image
        with storage.Codec(receiver) as codec:
            source=self.root/'plain';source.write_bytes(data);sealed=self.root/'sealed'
            storage.rsx.encrypt_file(codec._session,str(source),out_path=str(sealed),
                aad=storage.aad(receiver.receiver,receiver.workspace,oid))
            blob=sealed.read_bytes();png=encode_storage_image(blob)
            self.assertEqual(codec.open(png,oid),data)
            for _ in range(3):
                for invalid in (encode_storage_image(blob[:-1]),encode_storage_image(blob[:-1]+bytes([blob[-1]^1]))):
                    with self.assertRaises(Exception):codec.open(invalid,oid)
                with self.assertRaises(Exception):codec.open(png,'e'*32)
                self.assertEqual(codec.open(png,oid),data)

if __name__=='__main__':unittest.main()
