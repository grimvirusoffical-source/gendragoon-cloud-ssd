"""Real interpreter regressions for immutable signed resources; no Mac/cloud calls."""
import hashlib
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


def load_tool(name):
    spec = importlib.util.spec_from_file_location("bytecode_fixture_" + name, NATIVE / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def snapshot(root):
    result = {}
    for path in root.rglob("*"):
        if path.is_symlink():
            result[str(path.relative_to(root))] = ("link", os.readlink(path))
        elif path.is_file():
            result[str(path.relative_to(root))] = ("file", hashlib.sha256(path.read_bytes()).hexdigest(),
                                                    path.stat().st_mtime_ns)
        else:
            result[str(path.relative_to(root))] = ("directory",)
    return result


class SignedResourceBytecodeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gd-bytecode-fixture-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.app = self.root / "Fixture.app"
        self.resources = self.app / "Contents/Resources"
        self.resources.mkdir(parents=True)
        for source in (NATIVE / "Resources").glob("*.py"):
            shutil.copy2(source, self.resources / source.name)
        # Explicitly remove inherited suppression so each real interpreter must
        # rely on the entrypoint under test; never alter the process HOME.
        self.environment = os.environ.copy()
        for variable in ("PYTHONDONTWRITEBYTECODE", "PYTHONPYCACHEPREFIX", "PYTHONPATH"):
            self.environment.pop(variable, None)

    def python(self, *arguments):
        return subprocess.run([sys.executable, *map(str, arguments)], env=self.environment,
                              stdin=subprocess.DEVNULL, capture_output=True, text=True,
                              timeout=15, check=False)

    def test_every_bare_helper_cli_keeps_resources_unchanged(self):
        before = snapshot(self.resources)
        for helper in sorted(self.resources.glob("*.py")):
            with self.subTest(helper=helper.name):
                # app_launch's real top-level import loads gendragoon_library.
                result = self.python(helper, "--help")
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                self.assertIn("usage:", result.stdout)
                self.assertEqual(snapshot(self.resources), before)

    def test_actual_launch_import_does_not_replace_an_inherited_stale_cache(self):
        cached = Path(importlib.util.cache_from_source(str(self.resources / "gendragoon_library.py")))
        cached.parent.mkdir()
        cached.write_bytes(b"invalid stale bytecode from an older interpreter/build")
        before = snapshot(self.resources)
        result = self.python(self.resources / "gendragoon_app_launch.py", "--help")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(snapshot(self.resources), before)

    def test_smoke_helper_imports_keep_clean_and_stale_resources_unchanged(self):
        smoke = self.root / "smoke_macos.py"
        shutil.copy2(NATIVE / "Tests/smoke_macos.py", smoke)
        fixture = self.root / "private-home"
        fixture.mkdir(mode=0o700)
        program = """
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('smoke_fixture', sys.argv[1])
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
library, launcher = smoke.helper_modules(Path(sys.argv[2]), Path(sys.argv[3]))
# Exercise the same adjacent-workspace import used by real destination checks.
spec = importlib.util.spec_from_file_location('connect_fixture', Path(sys.argv[2]) / 'gendragoon_connect.py')
connect = importlib.util.module_from_spec(spec)
spec.loader.exec_module(connect)
workspace = connect.workspace_module()
print(json.dumps({'library': str(Path(library.__file__).parent),
                  'launcher': str(Path(launcher.__file__).parent),
                  'workspace': str(Path(workspace.__file__).parent),
                  'bytecodeDisabled': sys.dont_write_bytecode}))
"""
        for stale in (False, True):
            with self.subTest(stale=stale):
                if stale:
                    cached = Path(importlib.util.cache_from_source(str(self.resources / "gendragoon_library.py")))
                    cached.parent.mkdir()
                    cached.write_bytes(b"stale cache must remain unchanged")
                before = snapshot(self.resources)
                result = self.python("-c", program, smoke, self.resources, fixture)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                response = json.loads(result.stdout)
                self.assertTrue(response.pop("bytecodeDisabled"))
                self.assertEqual(set(response.values()), {str(self.resources)})
                self.assertEqual(snapshot(self.resources), before)

    def test_multiprocessing_preloader_cli_fails_safely_without_cache_writes(self):
        before = snapshot(self.resources)
        # Invalid storage is rejected by the actual spawned worker, before any
        # app reads. Its JSON result proves spawn reached production validation.
        result = self.python(self.resources / "gendragoon_preload.py", "--app",
                             self.root / "Unmanaged.app", "--seconds", "0.1")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        response = json.loads(result.stdout)
        self.assertFalse(response["ok"])
        self.assertEqual(response["message"], "Preload path is outside managed application storage")
        self.assertEqual(snapshot(self.resources), before)

    def test_build_prunes_only_the_staged_copy_and_never_follows_cache_links(self):
        build = load_tool("build_macos")
        inherited = self.resources / "__pycache__"
        inherited.mkdir()
        (inherited / "old.pyc").write_bytes(b"old bytecode")
        (self.resources / "legacy.pyo").write_bytes(b"old optimized bytecode")
        outside = self.root / "unrelated-cache"
        outside.mkdir()
        (outside / "keep.pyc").write_bytes(b"unrelated data")
        links = self.resources / "linked-cache"
        links.mkdir()
        (links / "__pycache__").symlink_to(outside, target_is_directory=True)
        (self.resources / "external-directory").symlink_to(outside, target_is_directory=True)
        before, untouched = snapshot(self.app), snapshot(outside)
        staged = self.root / "Staged.app"
        shutil.copytree(self.app, staged, symlinks=True)
        build.remove_python_caches(staged)
        self.assertEqual(snapshot(self.app), before)
        self.assertEqual(snapshot(outside), untouched)
        self.assertEqual((staged / "Contents/Resources/gendragoon_library.py").read_bytes(),
                         (self.resources / "gendragoon_library.py").read_bytes())
        self.assertTrue((staged / "Contents/Resources/external-directory").is_symlink())
        self.assertFalse((staged / "Contents/Resources/linked-cache/__pycache__").is_symlink())
        load_tool("package_macos").reject_python_caches(staged)
        alias = self.root / "Alias.app"
        alias.symlink_to(self.app, target_is_directory=True)
        with self.assertRaisesRegex(RuntimeError, "real staged app"):
            build.remove_python_caches(alias)
        self.assertEqual(snapshot(self.app), before)

    def test_packaging_refuses_cache_artifacts_before_any_external_command(self):
        package = load_tool("package_macos")
        for name in ("__pycache__", "legacy.pyc", "legacy.pyo"):
            path = self.resources / name
            if name == "__pycache__":
                path.mkdir()
            else:
                path.write_bytes(b"bytecode")
            before = snapshot(self.resources)
            for candidate in (False, True):
                with self.subTest(name=name, candidate=candidate), \
                     patch.object(package.sys, "platform", "darwin"), \
                     patch.object(package.subprocess, "run") as external:
                    with self.assertRaisesRegex(RuntimeError, "Python cache artifact"):
                        package.package(self.app, self.root / "release", candidate=candidate)
                    external.assert_not_called()
                    self.assertEqual(snapshot(self.resources), before)
            path.rmdir() if path.is_dir() else path.unlink()


if __name__ == "__main__":
    unittest.main()
