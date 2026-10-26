"""Account-free private Android origin and real upload-adapter call fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
RESOURCES = ROOT.parents[1] / "Resources"


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


adapter = module("android_origin_adapter", ROOT / "app/src/main/python/gendragoon_android.py")
origin = module("android_shared_origin", RESOURCES / "gendragoon_device_origin.py")


class AndroidOriginTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="gd-android-origin-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.root.chmod(0o700)
        self.modules = patch.dict(sys.modules, {"gendragoon_device_origin": origin})
        self.modules.start()
        self.addCleanup(self.modules.stop)

    def profile(self, receiver="a" * 64):
        directory = self.root / receiver
        directory.mkdir(mode=0o700)
        keymap = directory / "private.keymap"
        keymap.write_bytes(b"public dummy metadata-path fixture")
        keymap.chmod(0o600)
        return {"receiverId": receiver, "workspaceId": "b" * 32, "keymapPath": str(keymap)}

    def test_android_is_explicit_stable_per_account_and_contains_no_hardware_identifier(self):
        first, other = self.profile(), self.profile("c" * 64)
        host_platform = sys.platform
        with patch.object(origin, "current_platform", return_value="linux"), patch.object(origin.platform, "machine", return_value="aarch64"):
            value = adapter.android_origin(first)
            self.assertEqual(value, adapter.android_origin(dict(first, workspaceId="d" * 32)))
            self.assertNotEqual(value["deviceId"], adapter.android_origin(other)["deviceId"])
        self.assertEqual(sys.platform, host_platform)
        self.assertEqual(value["platform"], "android")
        self.assertEqual(value["architecture"], "arm64")
        self.assertEqual(set(value), {"schema", "platform", "architecture", "deviceId"})
        record = Path(first["keymapPath"]).parent / "DeviceOrigins" / (first["receiverId"] + ".json")
        self.assertEqual(record.stat().st_mode & 0o777, 0o600)
        self.assertEqual(set(json.loads(record.read_text())), {"schema", "deviceId"})

    def test_wrong_account_shared_or_linked_profile_is_retained_without_origin_creation(self):
        profile = self.profile()
        keymap = Path(profile["keymapPath"])
        original = keymap.read_bytes()
        for invalid in (dict(profile, receiverId="c" * 64), dict(profile, keymapPath="relative/private.keymap")):
            with self.assertRaises(ValueError):
                adapter.android_origin(invalid)
        keymap.chmod(0o644)
        with self.assertRaises(ValueError):
            adapter.android_origin(profile)
        keymap.chmod(0o600)
        shared = self.root / "shared-keymap"
        os.link(keymap, shared)
        with self.assertRaises(ValueError):
            adapter.android_origin(profile)
        shared.unlink()
        keymap.unlink()
        keymap.symlink_to(self.root / "outside-keymap")
        with self.assertRaises((ValueError, FileNotFoundError)):
            adapter.android_origin(profile)
        keymap.unlink()
        keymap.write_bytes(original)
        keymap.chmod(0o600)
        self.assertFalse((keymap.parent / "DeviceOrigins").exists())
        self.assertEqual(keymap.read_bytes(), original)

    def test_android_publish_never_uses_hardlinks_and_concurrent_creators_agree(self):
        profile = self.profile()
        with patch.object(origin.os, "link", side_effect=PermissionError("Android SELinux denies hardlinks")):
            with ThreadPoolExecutor(max_workers=8) as pool:
                values = list(pool.map(lambda _: adapter.android_origin(profile), range(24)))
        self.assertTrue(all(value == values[0] for value in values))
        directory = Path(profile["keymapPath"]).parent / "DeviceOrigins"
        self.assertEqual(sorted(path.name for path in directory.iterdir()), [".android-origin.lock", profile["receiverId"] + ".json"])
        self.assertEqual((directory / ".android-origin.lock").stat().st_mode & 0o777, 0o600)

    def test_interrupted_publish_retains_existing_records_and_rejects_shared_lock(self):
        profile = self.profile()
        with patch.object(adapter.os, "rename", side_effect=OSError("disposable publication interruption")):
            with self.assertRaises(OSError):
                adapter.android_origin(profile)
        directory = Path(profile["keymapPath"]).parent / "DeviceOrigins"
        self.assertEqual([path.name for path in directory.iterdir()], [".android-origin.lock"])
        expected = adapter.android_origin(profile)
        record = directory / (profile["receiverId"] + ".json")
        original = record.read_bytes()
        with patch.object(adapter.os, "rename", side_effect=AssertionError("existing record must not be replaced")):
            self.assertEqual(adapter.android_origin(profile), expected)
        self.assertEqual(record.read_bytes(), original)
        lock = directory / ".android-origin.lock"
        os.link(lock, directory / "shared-lock")
        with self.assertRaises(ValueError):
            adapter.android_origin(profile)
        self.assertEqual(record.read_bytes(), original)

    def test_upload_adapter_passes_account_origin_and_keeps_verified_source(self):
        with patch.object(sys, "path", [str(RESOURCES), *sys.path]):
            import gendragoon_redx_storage as storage
        profile = self.profile()
        source = self.root / "selected.txt"
        source.write_bytes(b"explicit selected owner fixture")
        cache = self.root / "job"
        uploaded = {}

        class Receiver:
            def __init__(self, _config):
                pass

            def json(self, _route):
                return {"items": [uploaded["item"]]}

        def upload(_config, archive, key, name, kind, layout, _sha, manifest, **options):
            uploaded.update(data=archive.read_bytes(), manifest=manifest, root={"name": name, "archiveLayout": layout},
                            item={"workspace": profile["workspaceId"], "key": key}, origin=options["origin"])
            return {"archiveBytes": archive.stat().st_size}

        def download(_config, _item, target, **_options):
            target.write_bytes(uploaded["data"])
            return {"root": uploaded["root"], "manifest": uploaded["manifest"]}

        with patch.object(adapter, "client_type", return_value=Receiver), patch.object(storage, "upload_archive", side_effect=upload), \
                patch.object(storage, "download_archive", side_effect=download), patch.object(storage, "progress", storage.progress):
            result = json.loads(adapter.upload(json.dumps(profile), str(source), str(cache), None, None))
        self.assertTrue(result["verified"])
        self.assertTrue(result["originalRetained"])
        self.assertEqual(uploaded["origin"], adapter.android_origin(profile))
        self.assertEqual(uploaded["origin"]["platform"], "android")
        self.assertEqual(source.read_bytes(), b"explicit selected owner fixture")


if __name__ == "__main__":
    unittest.main()
