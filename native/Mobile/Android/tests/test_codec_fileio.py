import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('android_fileio', ROOT/'app/src/main/python/gendragoon_android_codec.py')
codec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codec)


class DelegatedCore:
    """Protocol-free spy: these tests verify I/O, never pretend to test crypto."""
    def _pack_file_payload(self, name, plain):
        return plain
    def _unpack_file_payload(self, payload):
        return 'ignored-owner-name', payload
    def seal(self, session, payload, aad):
        return payload
    def open_(self, session, sealed, aad):
        return sealed


class FileIOTests(unittest.TestCase):
    def test_private_exclusive_output_and_exact_chunk_metadata_bounds(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            core = DelegatedCore()
            api = codec.FileAPI(core)
            original = core.seal
            for count in (1, 16384, 65536):
                source, sealed, restored = [root/(name+str(count)) for name in ('source', 'sealed', 'restored')]
                source.write_bytes(b'a'*count)
                api.encrypt_file(None, source, out_path=sealed, aad=b'metadata-or-chunk')
                api.decrypt_file(None, sealed, out_path=restored, aad=b'metadata-or-chunk')
                self.assertEqual(restored.read_bytes(), source.read_bytes())
                self.assertEqual(sealed.stat().st_mode & 0o777, 0o600)
                self.assertEqual(restored.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    api.decrypt_file(None, sealed, out_path=restored)
                self.assertEqual(restored.read_bytes(), source.read_bytes())
            self.assertEqual(core.seal, original)

    def test_failed_native_encryption_and_authentication_never_create_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'source'
            source.write_bytes(b'public dummy bytes')
            core = DelegatedCore()
            api = codec.FileAPI(core)
            for method, operation in [('seal', api.encrypt_file), ('open_', api.decrypt_file)]:
                with patch.object(core, method, side_effect=ValueError('native operation rejected')):
                    with self.assertRaisesRegex(ValueError, 'native operation'):
                        operation(None, source, out_path=root/'output', aad=b'wrong-authentication')
                self.assertFalse((root/'output').exists())

    def test_oversized_or_linked_input_is_rejected_before_native_call(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'source'
            source.write_bytes(b'x'*(codec.CHUNK+1))
            api = codec.FileAPI(DelegatedCore())
            with patch.object(api.core, 'seal') as seal:
                with self.assertRaises(ValueError):
                    api.encrypt_file(None, source, out_path=root/'output')
                seal.assert_not_called()
            link = root/'link'
            link.symlink_to(source)
            with self.assertRaises(OSError):
                api.encrypt_file(None, link, out_path=root/'output')
            self.assertFalse((root/'output').exists())

    def test_write_failure_removes_only_new_output_and_prior_files_survive(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output = root/'output'
            with patch.object(codec.os, 'fsync', side_effect=OSError('simulated disk error')):
                with self.assertRaises(OSError):
                    codec.write_exclusive(output, b'verified bytes')
            self.assertFalse(output.exists())
            output.write_bytes(b'original')
            with self.assertRaises(FileExistsError):
                codec.write_exclusive(output, b'replacement')
            self.assertEqual(output.read_bytes(), b'original')

    def test_legacy_read_is_bounded_but_new_writes_remain_64k(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root/'legacy'
            source.write_bytes(b'x'*(2*1024*1024))
            api = codec.FileAPI(DelegatedCore())
            api.decrypt_file(None, source, out_path=root/'restored')
            self.assertEqual((root/'restored').stat().st_size, 2*1024*1024)
            with self.assertRaises(ValueError):
                api.encrypt_file(None, source, out_path=root/'new-upload')
            self.assertFalse((root/'new-upload').exists())
            with source.open('wb') as output:
                output.truncate(codec.MAX_LEGACY_READ+1)
            with patch.object(api.core, 'open_') as authenticated_open:
                with self.assertRaises(ValueError):
                    api.decrypt_file(None, source, out_path=root/'oversized')
                authenticated_open.assert_not_called()
            self.assertFalse((root/'oversized').exists())


if __name__ == '__main__':
    unittest.main()
