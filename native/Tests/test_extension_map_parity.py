"""The Mac sort map and the mobile copy are the same document."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
MAC = ROOT / "native/Resources/extension-map.json"
MOBILE = ROOT / "native/Backend/mobile/extension-map.json"


class ExtensionMapParityTests(unittest.TestCase):
    def test_mac_sort_map_matches_the_core_document(self):
        mac = json.loads(MAC.read_text())
        mobile = json.loads(MOBILE.resolve().read_text())
        self.assertEqual(mac, mobile)
        self.assertEqual(mac["extensions"]["archives"], mobile["extensions"]["archives"])
