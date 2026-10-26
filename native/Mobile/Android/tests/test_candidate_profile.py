import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('candidate_profile', ROOT/'dependencies/candidate_profile.py')
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)


class CandidateTrustTests(unittest.TestCase):
    def fixture(self):
        record = next(row for row in candidate.lock() if row['source']['kind'] == 'bundled')
        return ROOT/'dependencies'/record['source']['path'], record

    def test_pinned_aligned_candidate_and_license_record_are_valid(self):
        path, record = self.fixture()
        self.assertEqual(candidate.validate_wheel(path, record)['libraries'], 1)

    def test_changed_binary_rejected_by_explicit_outer_pin(self):
        path, record = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/path.name
            data = path.read_bytes()
            target.write_bytes(data[:-1]+bytes([data[-1]^1]))
            with self.assertRaisesRegex(RuntimeError, 'SHA-256'):
                candidate.validate_wheel(target, record)

    def test_even_rehashed_outer_archive_requires_correct_internal_record(self):
        path, record = self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory)/path.name
            with zipfile.ZipFile(path) as source, zipfile.ZipFile(target, 'w') as changed:
                for info in source.infolist():
                    data = source.read(info)
                    if 'licenses/' in info.filename and not info.is_dir():
                        data += b'changed'
                    changed.writestr(info, data)
            outer = {**record, 'bytes':target.stat().st_size, 'sha256':hashlib.sha256(target.read_bytes()).hexdigest()}
            with self.assertRaisesRegex(RuntimeError, 'RECORD mismatch'):
                candidate.validate_wheel(target, outer)

    def test_extra_unreviewed_wheel_never_enters_offline_resolution(self):
        with tempfile.TemporaryDirectory() as directory:
            (Path(directory)/'unreviewed.whl').write_bytes(b'anything')
            with self.assertRaisesRegex(RuntimeError, 'exactly the eight'):
                candidate.validate(directory)


if __name__ == '__main__':
    unittest.main()
