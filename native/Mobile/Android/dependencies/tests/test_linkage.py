import importlib.util
import ast
import configparser
import os
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_linkage', ROOT/'prepare_linkage.py')
linkage = importlib.util.module_from_spec(spec)
spec.loader.exec_module(linkage)


class LinkageTests(unittest.TestCase):
    def test_complete_android_flags_and_python_search_directory_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'libpython3.13.so').touch()
            flags = '-Wl,--no-undefined -Wl,-z,max-page-size=16384 -lm -L' + str(root)
            with patch.dict(os.environ, {'LDFLAGS':flags}):
                linkage.prepare(root/'cross.ini')
            parser = configparser.ConfigParser()
            parser.read(root/'cross.ini')
            value = {name: ast.literal_eval(raw) for name, raw in parser['built-in options'].items()}
            self.assertEqual(value['c_link_args'], value['cpp_link_args'])
            for flag in flags.split():
                self.assertIn(flag, value['c_link_args'])
            self.assertIn('-lpython3.13', value['c_link_args'])
            self.assertLess(value['c_link_args'].index('-Wl,--no-as-needed'), value['c_link_args'].index('-lpython3.13'))

    def test_missing_official_flags_never_silently_downgrade_link_safety(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {'LDFLAGS':'-Wl,-z,max-page-size=16384'}):
            with self.assertRaisesRegex(RuntimeError, 'safety'):
                linkage.prepare(Path(directory)/'cross.ini')

    def test_needed_parser_reads_actual_dynamic_dependency_and_rejects_truncation(self):
        data = bytearray(1024)
        data[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<Q', data, 32, 64)
        struct.pack_into('<HH', data, 54, 56, 2)
        struct.pack_into('<IIQQQQQQ', data, 64, 1, 4, 0, 0x1000, 0, 1024, 1024, 16384)
        struct.pack_into('<IIQQQQQQ', data, 120, 2, 4, 256, 0x1100, 0, 64, 64, 8)
        strings = b'\0libpython3.13.so\0'
        data[512:512+len(strings)] = strings
        for index, row in enumerate([(5, 0x1200), (10, len(strings)), (1, 1), (0, 0)]):
            struct.pack_into('<qQ', data, 256+index*16, *row)
        self.assertEqual(linkage.needed_libraries(data), ['libpython3.13.so'])
        with self.assertRaises(RuntimeError):
            linkage.needed_libraries(data[:400])


if __name__ == '__main__':
    unittest.main()
