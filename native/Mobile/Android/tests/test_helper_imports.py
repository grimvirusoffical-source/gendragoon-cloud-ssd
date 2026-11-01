"""Cold-start the actual staged transport without checkout or crypto fallbacks."""
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
GENERATED = ROOT / "app/build/generated"
SCRIPT = """import pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve();sys.path.insert(0,str(root))
import gendragoon_redx_storage as storage
import gendragoon_device_origin as origin
assert pathlib.Path(storage.__file__).parent.resolve()==root
assert pathlib.Path(origin.__file__).parent.resolve()==root
assert storage.application_platform('backup.apk','file')=='android'
assert storage.application_platform('backup.exe','file')=='windows'
print('verified staged transport cold import')
"""


class HelperImportTests(unittest.TestCase):
    def cold_import(self, root):
        return subprocess.run([sys.executable, "-I", "-B", "-c", SCRIPT, str(root)],
                              capture_output=True, text=True, timeout=30)

    def test_generated_transport_and_origin_import_without_source_checkout(self):
        root = GENERATED / "python"
        manifest = json.loads((GENERATED / "runtime-manifest.json").read_text())
        self.assertIn("gendragoon_device_origin.py", manifest["helpers"])
        for name, expected in manifest["helpers"].items():
            self.assertEqual(hashlib.sha256((root / name).read_bytes()).hexdigest(), expected)
        result = self.cold_import(root)
        self.assertEqual(result.returncode, 0, result.stderr[-4096:])
        self.assertEqual(result.stdout.strip(), "verified staged transport cold import")
        self.assertFalse(list(root.rglob("__pycache__")))

    def test_missing_adjacent_origin_cannot_fall_back_to_checkout(self):
        manifest = json.loads((GENERATED / "runtime-manifest.json").read_text())
        with tempfile.TemporaryDirectory(prefix="gd-android-cold-import-") as directory:
            root = Path(directory)
            for name in manifest["helpers"]:
                if name != "gendragoon_device_origin.py":
                    shutil.copyfile(GENERATED / "python" / name, root / name)
            result = self.cold_import(root)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("ModuleNotFoundError: No module named 'gendragoon_device_origin'", result.stderr)
            self.assertFalse(list(root.rglob("__pycache__")))


if __name__ == "__main__":
    unittest.main()
