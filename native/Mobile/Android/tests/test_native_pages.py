import importlib.util
import io
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('native_pages',ROOT/'check_native_pages.py');pages=importlib.util.module_from_spec(spec);spec.loader.exec_module(pages)


def elf(machine=62,align=16384,offset=0,address=0):
    value=bytearray(120);value[:6]=b'\x7fELF\x02\x01';struct.pack_into('<H',value,18,machine);struct.pack_into('<Q',value,32,64);struct.pack_into('<HH',value,54,56,1);struct.pack_into('<IIQQQQQQ',value,64,1,5,offset,address,0,0,0,align);return bytes(value)

def archive(files):
    value=io.BytesIO()
    with zipfile.ZipFile(value,'w')as out:
        for name,content in files.items():out.writestr(name,content)
    return value.getvalue()

class PagesTests(unittest.TestCase):
    def test_nested_chaquopy_dependency_is_checked_even_when_our_two_native_libraries_pass(self):
        with tempfile.TemporaryDirectory()as directory:
            apk=Path(directory)/'fixture.apk';apk.write_bytes(archive({'lib/arm64-v8a/librsx.so':elf(183),'lib/x86_64/librsx.so':elf(),'assets/chaquopy/requirements-x86_64.imy':archive({'chaquopy/lib/libgfortran.so.3':elf(align=4096)})}))
            report=pages.audit(apk);self.assertEqual(len(report['libraries']),3);self.assertFalse(report['compatible16KiB']);self.assertIn('requirements-x86_64.imy',report['libraries'][2]['path'])
    def test_congruence_and_truncated_program_headers_are_rejected(self):
        self.assertTrue(pages.inspect_elf(elf())['aligned16KiB']);self.assertFalse(pages.inspect_elf(elf(offset=4096))['aligned16KiB'])
        with self.assertRaises(ValueError):pages.inspect_elf(elf()[:70])
    def test_missing_architecture_cannot_pass_an_empty_or_partial_audit(self):
        with tempfile.TemporaryDirectory()as directory:
            apk=Path(directory)/'fixture.apk';apk.write_bytes(archive({'lib/x86_64/librsx.so':elf()}))
            with self.assertRaises(ValueError):pages.audit(apk)

if __name__=='__main__':unittest.main()
