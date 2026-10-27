"""Opt-in test against unchanged Red-SecretsXAI C++ crypto and PNG library.

Uses disposable tiny fixture files, not an installed app or live user account.
Run with REDX_REAL_CODEC_TEST=1 and a trusted RSX_LIB/Python environment.
"""
import importlib.util
import json
import os
from pathlib import Path
import secrets
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'png_range_real', Path(__file__).resolve().parents[1] / 'png_app_cache.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


@unittest.skipUnless(os.environ.get('REDX_REAL_CODEC_TEST') == '1', 'requires the actual Red-SecretsXAI runtime')
class RealPNGRangeCacheTest(unittest.TestCase):
    def test_selective_read_authenticates_real_png_without_prefetching_unrequested_file(self):
        from redxai import _librsx as rsx
        from redsecretsxai import encode_image
        with tempfile.TemporaryDirectory(prefix='gd-real-cache-') as directory:
            root = Path(directory).resolve()
            password = secrets.token_hex(24)
            receiver, workspace = secrets.token_hex(32), secrets.token_hex(16)
            keymap = root / 'fixture-keymap'
            objects, original, records = {}, {}, []
            # Default library settings; no adapter or cryptographic changes.
            with rsx.session_open(password, str(keymap)) as session:
                for name in ['Contents/MacOS/Fixture', 'Contents/Resources/FixtureData']:
                    identifier = secrets.token_hex(16)
                    plain = secrets.token_bytes(128)
                    source, sealed = root / (identifier + '.plain'), root / (identifier + '.sealed')
                    source.write_bytes(plain)
                    aad = json.dumps(['red-xai-receiver/png/v1', receiver, workspace, identifier], separators=(',', ':')).encode()
                    rsx.encrypt_file(session, str(source), out_path=str(sealed), aad=aad)
                    png = encode_image(sealed.read_bytes(), verify=True)
                    self.assertLessEqual(len(png), m.MAX_PNG)
                    objects[identifier] = png
                    original[name] = plain
                    records.append({'path': name, 'bytes': len(plain), 'chunks': [{
                        'id': identifier, 'bytes': len(plain), 'plainSha256': m.digest(plain),
                        'pngSha256': m.digest(png), 'pngBytes': len(png)}]})
            keymap.chmod(0o600)
            requested = []
            def fetch(chunk):
                requested.append(chunk['id'])
                return objects[chunk['id']]
            decoder = m.RedSecretsDecoder(password, str(keymap), receiver, workspace)
            cache = m.AppRangeCache({'schema': 'redxai.app-chunks/v1', 'files': records},
                                    root / 'cache', fetch, decoder)
            try:
                self.assertEqual(requested, [])
                self.assertEqual(cache.read(records[0]['path'], 0, 17), original[records[0]['path']][:17])
                self.assertEqual(requested, [records[0]['chunks'][0]['id']])
                self.assertEqual(cache.read(records[0]['path'], 11, 29), original[records[0]['path']][11:40])
                self.assertEqual(len(requested), 1)
                self.assertEqual(cache.read(records[1]['path'], 0, 128), original[records[1]['path']])
                self.assertEqual(len(requested), 2)
            finally:
                cache.close()
                decoder.close()
            self.assertFalse((root / 'cache').exists())
            # Wrong authenticated workspace context must never publish plaintext.
            wrong = m.RedSecretsDecoder(password, str(keymap), receiver, secrets.token_hex(16))
            other = m.AppRangeCache({'schema': 'redxai.app-chunks/v1', 'files': records},
                                    root / 'wrong-context', fetch, wrong)
            try:
                with self.assertRaises(Exception):
                    other.read(records[0]['path'], 0, 17)
                self.assertEqual(other.status()['cachedBytes'], 0)
                self.assertEqual(list(other.root.iterdir()), [])
            finally:
                other.close()
                wrong.close()


if __name__ == '__main__':
    unittest.main()
