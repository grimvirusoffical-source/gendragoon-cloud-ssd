"""Actual sourceless imports and pre-archive validation; no user app changes."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

NATIVE = Path(__file__).resolve().parents[1]


def tool(name):
    spec = importlib.util.spec_from_file_location("macos_runtime_" + name, NATIVE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CompiledMacRuntimeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        candidates = [sys.executable, "/Library/Frameworks/Python.framework/Versions/3.13/bin/python3"]
        cls.python = None
        for candidate in candidates:
            if not Path(candidate).is_file():
                continue
            result = subprocess.run([candidate, "-B", "-c", "import sys;print(sys.version_info[:2]==(3,13))"],
                                    capture_output=True, text=True, check=True)
            if result.stdout.strip() == "True":
                cls.python = candidate
                break
        if cls.python is None:
            raise unittest.SkipTest("The actual sourceless runtime requires Python 3.13")

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="gd-compiled-mac-")
        self.addCleanup(temporary.cleanup)
        self.app = Path(temporary.name).resolve() / "Fixture.app"
        self.resources = self.app / "Contents/Resources"
        self.resources.mkdir(parents=True)
        self.build, self.package = tool("build_macos"), tool("package_macos")
        for name in self.package.PRIVATE_PYC_RESOURCES:
            source = self.resources / Path(name).with_suffix(".py")
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text("VALUE = 'compiled codec fixture'\n")
        # Exercise the unchanged vendor's dynamic .py-sibling import shape.
        (self.resources / "redsecretsxai/__init__.py").write_text('''
from pathlib import Path
import importlib.util
def sibling():
    spec=importlib.util.spec_from_file_location('fixture_glyphs',Path(__file__).parent/'glyphs.py')
    module=importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.VALUE
''')
        shutil.copy2(NATIVE / "Resources/gendragoon_codec_loader.py", self.resources)
        native = self.resources / "redxai/_native"
        native.mkdir()
        (native / "librsx.dylib").write_bytes(b"fixture, not an actual native library")
        (self.resources / "gendragoon_python_runtime.json").write_text(json.dumps({
            "schema": 1, "pythonMajorMinor": "3.13", "architecture": "arm64",
            "dependencies": {"numpy": "2.5.4", "Pillow": "13.0.0"}}))
        self.build.compile_private_modules(self.python, self.resources)

    def test_actual_adjacent_bytecode_import_and_dynamic_sibling_without_cache_writes(self):
        before = {str(p.relative_to(self.resources)): p.read_bytes()
                  for p in self.resources.rglob("*") if p.is_file()}
        environment = os.environ.copy()
        environment.pop("PYTHONPYCACHEPREFIX", None)
        environment["PYTHONPATH"] = str(self.resources)
        result = subprocess.run([self.python, "-B", "-c", "import redxai,redsecretsxai;"
                                 "assert redxai.VALUE=='compiled codec fixture';"
                                 "assert redsecretsxai.sibling()=='compiled codec fixture';"
                                 "print(redxai.__file__,redsecretsxai.__file__)"],
                                env=environment, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("__init__.pyc", result.stdout)
        self.assertFalse(list((self.resources / "redxai").rglob("*.py")))
        self.assertFalse(list((self.resources / "redsecretsxai").rglob("*.py")))
        self.assertEqual(before, {str(p.relative_to(self.resources)): p.read_bytes()
                                 for p in self.resources.rglob("*") if p.is_file()})
        self.package.validate_compiled_runtime(self.resources)
        self.package.reject_python_caches(self.app)

    def test_corrupted_bytecode_wrong_interpreter_and_manifest_drift_rejected(self):
        target = self.resources / "redxai/_librsx.pyc"
        original = target.read_bytes()
        for modified in (b"bad!" + original[4:], original[:-1] + bytes([original[-1] ^ 1])):
            target.write_bytes(modified)
            with self.assertRaisesRegex(RuntimeError, "bytecode or digest"):
                self.package.validate_compiled_runtime(self.resources)
        target.write_bytes(original)
        metadata = self.resources / "gendragoon_python_runtime.json"
        record = json.loads(metadata.read_text())
        for field, value in (("pythonMajorMinor", "3.15"), ("sourceIncluded", True), ("compiledModules", {})):
            metadata.write_text(json.dumps({**record, field: value}))
            with self.assertRaises(RuntimeError):
                self.package.validate_compiled_runtime(self.resources)
        metadata.write_text(json.dumps(record))
        self.package.validate_compiled_runtime(self.resources)

    def test_source_leak_link_and_extra_bytecode_fail_before_external_packaging(self):
        for name in ("glyphs.py", "glyphs.pyi", "unexpected.pyc"):
            extra = self.resources / "redsecretsxai" / name
            extra.write_bytes(b"must not be published")
            with patch.object(self.package.sys, "platform", "darwin"), \
                 patch.object(self.package.subprocess, "run") as external:
                with self.assertRaises(RuntimeError):
                    self.package.package(self.app, self.app.parent / "output", candidate=True)
                external.assert_not_called()
            extra.unlink()
        target = self.resources / "redsecretsxai/glyphs.pyc"
        data = target.read_bytes()
        target.unlink()
        target.symlink_to(self.resources / "redxai/_librsx.pyc")
        with self.assertRaisesRegex(RuntimeError, "Linked compiled"):
            self.package.validate_compiled_runtime(self.resources)
        target.unlink()
        target.write_bytes(data)

    def test_code_filenames_are_relative_and_not_developer_paths(self):
        for name in self.package.PRIVATE_PYC_RESOURCES:
            code = (self.resources / name).read_bytes()
            self.assertNotIn(str(self.app.parent).encode(), code)
            self.assertNotIn(str(NATIVE).encode(), code)


if __name__ == "__main__":
    unittest.main()
