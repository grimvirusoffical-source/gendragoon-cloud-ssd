import importlib.util
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1] / "Extensions"
spec = importlib.util.spec_from_file_location("package_extensions", ROOT / "package_extensions.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


class ExtensionPackageTests(unittest.TestCase):
    def test_packages_include_local_assets_real_entrypoints_source_and_valid_vsix_metadata(self):
        with tempfile.TemporaryDirectory(prefix="gd-extension-package-") as temporary:
            output = Path(temporary) / "artifacts"
            files = packager.package_all(output)
            self.assertEqual(len(files), 6)
            self.assertEqual(len((output / "SHA256SUMS").read_text().splitlines()), 6)
            for browser in ("chrome", "edge", "firefox", "opera"):
                with zipfile.ZipFile(output / f"gendragoon-{browser}-{packager.VERSION}.zip") as archive:
                    names = set(archive.namelist())
                    self.assertTrue({"manifest.json", "dashboard.js", "rpc.js", "native-client.js", "teams/index.html", "teams/dev-peer.js", "teams/teams-adapter.js", "icons/128.png", "PRIVACY.md"} <= names)
                    self.assertFalse(any("__pycache__" in name or name.endswith(".pyc") or name.startswith("/") or "../" in name for name in names))
                    self.assertEqual(json.loads(archive.read("manifest.json"))["permissions"], ["nativeMessaging"])
                    self.assertIn(b'<script src="teams-adapter.js">', archive.read("teams/index.html"))
                    self.assertTrue(archive.read("icons/128.png").startswith(b"\x89PNG"))
            with zipfile.ZipFile(output / f"gendragoon-{packager.VERSION}.vsix") as archive:
                names = set(archive.namelist())
                self.assertTrue({"[Content_Types].xml", "extension.vsixmanifest", "extension/package.json", "extension/vscode/extension.cjs", "extension/vscode/native-client.cjs", "extension/shared/rpc.js", "extension/teams/teams-adapter.js"} <= names)
                manifest = ElementTree.fromstring(archive.read("extension.vsixmanifest"))
                identity = manifest.find("{*}Metadata/{*}Identity")
                self.assertEqual(identity.attrib["Id"], "redxai.gendragoon")
                package = json.loads(archive.read("extension/package.json"))
                self.assertIn("extension/" + package["main"].removeprefix("./"), names)
                self.assertEqual(package["extensionKind"], ["ui"])
            with zipfile.ZipFile(output / f"gendragoon-extension-source-{packager.VERSION}.zip") as archive:
                self.assertIn("native/Resources/gendragoon_native_bridge.py", archive.namelist())
                self.assertIn("native/Extensions/install_native_host.py", archive.namelist())
            with self.assertRaises(ValueError):
                packager.package_all(output)


if __name__ == "__main__":
    unittest.main()
