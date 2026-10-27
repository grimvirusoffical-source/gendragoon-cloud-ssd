"""Execute the shipping Swift policy using cross-platform backup fixtures."""
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "Sources/GDDeviceOrigin.swift"


@unittest.skipUnless(shutil.which("swiftc"), "Swift compiler required")
class PlatformPolicyTests(unittest.TestCase):
    def test_artifact_hints_folders_restore_boundaries_and_private_device_labels(self):
        main = r'''
import Foundation
func check(_ value: Bool) { if !value { fatalError("platform policy failed") } }
for suffix in ["exe", "MSI", "msix", "appx", "msixbundle", "appxbundle"] {
    let hint = GDApplicationPlatform.hint(name: "Résumé (one)." + suffix, kind: "file", declared: nil)
    check(hint == "windows"); check(!GDApplicationPlatform.mayRestoreOnMac(hint))
}
for (name, expected) in [("App.AppImage", "linux"), ("pkg.deb", "linux"), ("pkg.rpm", "linux"), ("App.apk", "android"), ("App.ipa", "ios")] {
    let hint = GDApplicationPlatform.hint(name: name, kind: "file", declared: nil)
    check(hint == expected); check(!GDApplicationPlatform.mayRestoreOnMac(hint))
}
check(GDApplicationPlatform.hint(name: "Legacy", kind: "app", declared: nil) == "macos")
check(GDApplicationPlatform.hint(name: "App.app", kind: "app", declared: nil) == "macos")
for name in ["Reports.exe", "assets.rpm", "App.app"] {
    check(GDApplicationPlatform.hint(name: name, kind: "folder", declared: nil) == nil)
    check(GDApplicationPlatform.hint(name: name, kind: "folder", declared: "windows") == nil)
}
check(GDApplicationPlatform.mayRestoreOnMac("macos"))
for name in ["Report.txt", "macos.exe.txt", "archive.zip", "Photo.png"] {
    let hint = GDApplicationPlatform.hint(name: name, kind: "file", declared: nil)
    check(hint == nil); check(GDApplicationPlatform.mayRestoreOnMac(hint))
}
check(GDApplicationPlatform.hint(name: "App.app", kind: "app", declared: "windows") == "unknown")
check(GDApplicationPlatform.hint(name: "App.exe", kind: "file", declared: "macos") == "unknown")
check(GDApplicationPlatform.hint(name: "App.app", kind: "app", declared: "hostile\nlabel") == "unknown")
check(!GDApplicationPlatform.mayRestoreOnMac("unknown"))
let valid = GDDeviceOrigin(schema: 1, platform: "windows", architecture: "x86_64", deviceId: String(repeating: "a", count: 32))
check(valid.label == "Windows · aaaaaa")
let hostile = GDDeviceOrigin(schema: 9, platform: "private-hostname", architecture: "secret", deviceId: "credential")
check(hostile.platformCode == "unknown"); check(hostile.label == "Unknown device")
let noId = GDDeviceOrigin(schema: 1, platform: "macos", architecture: "arm64", deviceId: "../private")
check(noId.label == "Mac")
print("platform policy verified")
'''
        with tempfile.TemporaryDirectory(prefix="gd-platform-policy-") as folder:
            root = Path(folder)
            (root / "main.swift").write_text(main)
            binary = root / "policy"
            result = subprocess.run(["swiftc", str(SOURCE), str(root / "main.swift"), "-o", str(binary)], capture_output=True, text=True, timeout=60)
            self.assertEqual(result.returncode, 0, result.stderr[-3000:])
            result = subprocess.run([str(binary)], capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr[-1000:])
            self.assertEqual(result.stdout.strip(), "platform policy verified")


if __name__ == "__main__":
    unittest.main()
