"""The exact Red-XAI LLC ownership copy appears on every native surface."""
import json
from pathlib import Path
import plistlib
import unittest

ROOT = Path(__file__).resolve().parents[2]
COPY = "Gendragoon is developed and maintained by Red-XAI LLC. Red-XAI LLC is wholly owned by GRIM-VIRUS, an independent recording artist who leads development under the alias MainDirectory. © Red-XAI LLC. All rights reserved."


class AboutOwnershipTests(unittest.TestCase):
    def read(self, rel):
        return (ROOT / rel).read_text(encoding="utf-8")

    def test_copy_on_every_surface(self):
        for rel in ["README.md", "macos/AboutSection.swift", "native/Desktop/gendragoon_desktop.py",
                    "native/Mobile/Android/app/src/main/java/app/gendragoon/cloudssd/mobile/About.java",
                    "native/Mobile/iOS/Sources/SupportContact.swift",
                    "native/Backend/mobile/index.html", "native/Backend/mobile/support.html"]:
            with self.subTest(rel=rel):
                self.assertIn(COPY, self.read(rel))

    def test_surfaces_render_the_copy(self):
        self.assertIn("About.OWNERSHIP", self.read("native/Mobile/Android/app/src/main/java/app/gendragoon/cloudssd/mobile/MainActivity.java"))
        self.assertIn("Text(AboutCopy.ownership)", self.read("native/Mobile/iOS/Sources/UIPreview.swift"))

    def test_copyright_metadata(self):
        with open(ROOT / "native/Mobile/iOS/Info.plist", "rb") as handle:
            self.assertEqual(plistlib.load(handle)["NSHumanReadableCopyright"], "© Red-XAI LLC")
        self.assertIn("'NSHumanReadableCopyright':'© Red-XAI LLC'", self.read("native/Mobile/iOS/create_project.py"))
        self.assertEqual(json.loads(self.read("native/Backend/package.json"))["author"], "Red-XAI LLC")


if __name__ == "__main__":
    unittest.main()
