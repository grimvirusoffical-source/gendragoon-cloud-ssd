"""Disposable range/cache policy fixtures; no live accounts or applications."""
import copy
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'png_app_cache.py'
spec = importlib.util.spec_from_file_location('png_app_cache_fixture', MODULE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class PNGAppCacheTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gd-range-policy-')
        self.root = Path(self.temp.name).resolve()
        self.size = m.CHUNK_BYTES
        self.raw = [bytes([i]) * self.size for i in range(8)]
        self.calls = []
        self.pngs = {}
        self.plain = {}
        chunks = []
        for i, plain in enumerate(self.raw):
            identifier = format(i + 1, '032x')
            png = b'\x89PNG\r\n\x1a\n' + plain
            self.pngs[identifier] = png
            self.plain[identifier] = plain
            chunks.append({'id': identifier, 'bytes': len(plain),
                           'plainSha256': m.digest(plain), 'pngSha256': m.digest(png),
                           'pngBytes': len(png)})
        self.manifest = {'schema': 'redxai.app-chunks/v1', 'files': [
            {'path': 'Contents/MacOS/Fixture', 'bytes': 8 * self.size, 'chunks': chunks}]}
        self.cache = None

    def make(self, **kwargs):
        def fetch(chunk):
            self.calls.append(chunk['id'])
            return self.pngs[chunk['id']]
        self.cache = m.AppRangeCache(self.manifest, self.root / 'cache', fetch,
                                    lambda chunk, png, directory: self.plain[chunk['id']],
                                    max_bytes=2 * self.size,
                                    free_bytes=kwargs.get('free_bytes', lambda p: 20 * 1024**3))
        return self.cache

    def tearDown(self):
        self.temp.cleanup()

    def test_no_payload_download_on_open(self):
        c = self.make()
        self.assertEqual(self.calls, [])
        self.assertEqual(c.status()['cachedBytes'], 0)
        c.close()
        self.assertFalse(c.root.exists())

    def test_preload_only_first_chunk_not_whole_app(self):
        c = self.make()
        self.assertEqual(c.preload(['Contents/MacOS/Fixture'], self.size), self.size)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(c.status()['logicalAppBytes'], 8 * self.size)
        self.assertEqual(c.status()['cachedBytes'], self.size)

    def test_distant_read_fetches_only_required_chunk(self):
        c = self.make()
        self.assertEqual(c.read('Contents/MacOS/Fixture', 6 * self.size + 7, 20), bytes([6]) * 20)
        self.assertEqual(self.calls, [format(7, '032x')])

    def test_cross_boundary_read(self):
        c = self.make()
        self.assertEqual(c.read('Contents/MacOS/Fixture', self.size - 2, 4), b'\0\0\1\1')
        self.assertEqual(len(self.calls), 2)

    def test_repeat_read_uses_verified_cache(self):
        c = self.make()
        for _ in range(3):
            self.assertEqual(c.read('Contents/MacOS/Fixture', 0, 4), b'\0' * 4)
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(c.status()['cacheHits'], 2)

    def test_lru_never_exceeds_local_budget(self):
        c = self.make()
        for i in range(8):
            self.assertEqual(c.read('Contents/MacOS/Fixture', i * self.size, 1), bytes([i]))
            self.assertLessEqual(c.status()['cachedBytes'], 2 * self.size)
        self.assertEqual(len(list(c.root.iterdir())), 2)
        c.read('Contents/MacOS/Fixture', 0, 1)
        self.assertEqual(len(self.calls), 9)

    def test_space_reserve_checked_before_download(self):
        c = self.make(free_bytes=lambda p: m.MIN_FREE)
        with self.assertRaisesRegex(m.CacheError, '10 GiB'):
            c.read('Contents/MacOS/Fixture', 0, 1)
        self.assertEqual(self.calls, [])

    def test_hash_failure_never_publishes_cache(self):
        c = self.make()
        identifier = format(1, '032x')
        self.pngs[identifier] = self.pngs[identifier][:-1] + b'X'
        with self.assertRaisesRegex(m.CacheError, 'integrity'):
            c.read('Contents/MacOS/Fixture', 0, 1)
        self.assertEqual(c.status()['cachedBytes'], 0)
        self.assertEqual(list(c.root.iterdir()), [])

    def test_decryption_failure_does_not_publish_bytes(self):
        c = self.make()
        def reject(*args):
            raise m.CacheError('authentication rejected')
        c.decode_png = reject
        with self.assertRaisesRegex(m.CacheError, 'authentication'):
            c.read('Contents/MacOS/Fixture', 0, 1)
        self.assertEqual(c.status()['cachedBytes'], 0)
        self.assertEqual(list(c.root.iterdir()), [])

    def test_modified_local_cache_is_retained(self):
        c = self.make()
        c.read('Contents/MacOS/Fixture', 0, 1)
        file = c.root / format(1, '032x')
        file.write_bytes(b'user-modified')
        with self.assertRaisesRegex(m.CacheError, 'retained'):
            c.close()
        self.assertEqual(file.read_bytes(), b'user-modified')

    def test_unknown_files_are_retained(self):
        c = self.make()
        other = c.root / 'user-file.txt'
        other.write_text('never delete')
        with self.assertRaisesRegex(m.CacheError, 'retained'):
            c.close()
        self.assertEqual(other.read_text(), 'never delete')

    def test_traversal_and_index_conflicts_are_rejected(self):
        for path in ['../escape', '/outside', 'a//b', 'a\\b', 'a/../b']:
            data = copy.deepcopy(self.manifest)
            data['files'][0]['path'] = path
            with self.assertRaises(m.CacheError):
                m.validate_manifest(data)
        data = copy.deepcopy(self.manifest)
        data['files'].append(copy.deepcopy(data['files'][0]))
        with self.assertRaises(m.CacheError):
            m.validate_manifest(data)

    def test_existing_directory_is_not_adopted(self):
        (self.root / 'cache').mkdir()
        (self.root / 'cache/user').write_text('preserve')
        with self.assertRaises(FileExistsError):
            self.make()
        self.assertEqual((self.root / 'cache/user').read_text(), 'preserve')

    def test_invalid_read_size_and_preload_budget(self):
        c = self.make()
        for offset, length in [(-1, 4), (0, m.MAX_READ + 1), (0, -1)]:
            with self.assertRaises(m.CacheError):
                c.read('Contents/MacOS/Fixture', offset, length)
        with self.assertRaises(m.CacheError):
            c.preload(['Contents/MacOS/Fixture'], 3 * self.size)
        self.assertEqual(self.calls, [])


if __name__ == '__main__':
    unittest.main()
