import json
from pathlib import Path
import subprocess
import sys
import unittest

MAS = Path(__file__).parents[1] / "MAS"
sys.path.insert(0, str(MAS))
import build_mas  # noqa: E402


class MasConfig(unittest.TestCase):
    def test_config_validates(self):
        self.assertEqual(build_mas.validate(), [])

    def test_app_is_sandboxed_without_broad_file_access(self):
        ent = build_mas.load_entitlements("GenDragoon-MAS.entitlements", "ABCDE12345")
        self.assertTrue(ent["com.apple.security.app-sandbox"])
        self.assertTrue(ent["com.apple.security.network.client"])
        self.assertEqual(ent["com.apple.application-identifier"], "ABCDE12345.app.gendragoon.cloudssd")
        self.assertNotIn("com.apple.security.files.all", ent)

    def test_helpers_inherit_the_sandbox(self):
        for name in build_mas.HELPERS.values():
            ent = build_mas.load_entitlements(name)
            self.assertTrue(ent["com.apple.security.inherit"])

    def test_plan_cli_runs_anywhere_and_changes_nothing(self):
        out = subprocess.run([sys.executable, str(MAS / "build_mas.py"), "--plan"], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout)["plan"]["distributionResource"], {"distribution": "mas"})

    def test_real_build_refuses_without_macos_or_identities(self):
        out = subprocess.run([sys.executable, str(MAS / "build_mas.py"), "--base-app", "/nope", "--output", "/tmp/nope-mas"], capture_output=True, text=True)
        self.assertNotEqual(out.returncode, 0)


if __name__ == "__main__":
    unittest.main()
