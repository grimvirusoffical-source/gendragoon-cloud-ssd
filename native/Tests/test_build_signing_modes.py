"""build_macos.py signing modes for the Rotten Apple package (no Mac, no codesign calls)."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

NATIVE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("build_macos_modes", NATIVE / "build_macos.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class SigningModes(unittest.TestCase):
    def test_developer_id_keeps_hardened_runtime_and_timestamp(self):
        cmd = build.sign_commands(build.IDENTITY)
        self.assertIn("--options", cmd)
        self.assertEqual(cmd[cmd.index("--options") + 1], "runtime")
        self.assertIn("--timestamp", cmd)
        self.assertEqual(cmd[-1], build.IDENTITY)

    def test_adhoc_has_no_runtime_or_timestamp(self):
        cmd = build.sign_commands("-")
        self.assertEqual(cmd, ["/usr/bin/codesign", "--force", "--sign", "-"])

    def test_distribution_marker_written_before_signing(self):
        with tempfile.TemporaryDirectory() as d:
            res = Path(d)
            build.write_distribution(res, "rotten-apple")
            self.assertEqual(json.loads((res / "gendragoon_distribution.json").read_text()), {"distribution": "rotten-apple"})
            build.write_distribution(res, None)  # None leaves it alone
            self.assertTrue((res / "gendragoon_distribution.json").exists())
            with self.assertRaises(RuntimeError):
                build.write_distribution(res, "github")

    def test_marker_values_match_the_app(self):
        updater = (NATIVE / "Resources/gendragoon_auto_update.py").read_text()
        self.assertIn('DISTRIBUTIONS=("direct","rotten-apple","mas")', updater)
        self.assertEqual(build.DISTRIBUTIONS, ("direct", "rotten-apple", "mas"))


if __name__ == "__main__":
    unittest.main()
