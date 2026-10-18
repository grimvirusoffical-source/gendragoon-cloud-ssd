"""Casey QA probes for the b47aac0 install_worker -> Red-XAI apply_and_report hand-off.

Reuses the AutoUpdateTests fixture (fake Mac tools, disposable bundles). Passing tests pin
correct behaviour; expectedFailure tests reproduce findings in runs/mac-pr3-b47aac0.md.
"""
import json
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "Resources"))
import test_integrated_auto_update as base  # noqa: E402
import redxai_updater  # noqa: E402

updater = base.updater


class InstallWorkerExitCodes(base.AutoUpdateTests):
    def run_worker(self):
        self.stage()
        opened = []

        def commands(arguments, timeout=80):
            if arguments[0] == "/usr/bin/open":
                opened.append((self.app / "Contents/marker").read_text())
            return self.commands(arguments, timeout)
        with self.mac(commands):
            outcome = updater.install_worker(relaunch=True)
        return outcome, json.loads(self.status.read_text()), opened

    def test_bad_signature_after_swap_leaves_no_half_install(self):
        self.stage()

        def fail_after_swap(arguments, timeout=80):
            if (arguments[0] == "/usr/bin/codesign" and "--verify" in arguments and arguments[-1] == str(self.app)
                    and (self.app / "Contents/marker").read_text() == "new-good"):
                raise RuntimeError("post-install trust failure")
            return self.commands(arguments, timeout)
        with self.mac(fail_after_swap), mock.patch.object(redxai_updater, "apply_and_report",
                                                         wraps=redxai_updater.apply_and_report) as applied:
            self.assertEqual(updater.install_worker(relaunch=True)["event"], "rolled_back")
        applied.assert_called_once()
        self.assert_original()
        self.assertFalse([p for p in self.app.parent.iterdir() if ".previous-" in p.name])

    @unittest.expectedFailure
    def test_unknown_exit_code_is_not_reported_as_a_relaunched_rollback(self):
        # Finding U1: any code other than 0 and 2 becomes "rolled_back" and nothing reopens.
        with mock.patch.object(redxai_updater, "apply_and_report", return_value=3):
            outcome, status, opened = self.run_worker()
        self.assertTrue(status["state"] == "attention" or opened == ["original-good"], (status["state"], opened))

    @unittest.expectedFailure
    def test_nothing_changed_value_error_still_reopens_the_untouched_app(self):
        # Finding U1: apply_and_report maps a precondition ValueError to 1 ("restored and relaunched"),
        # but nothing was relaunched, so the idle auto-restart leaves the app closed.
        with mock.patch.object(redxai_updater, "apply_ready_update",
                               side_effect=ValueError("The installed app was not found; nothing was changed")):
            outcome, status, opened = self.run_worker()
        self.assertEqual(opened, ["original-good"])


def load_tests(loader, tests, pattern):
    """Run only the QA probes, not the inherited AutoUpdateTests a second time."""
    own = [name for name in vars(InstallWorkerExitCodes) if name.startswith("test_")]
    return unittest.TestSuite(InstallWorkerExitCodes(name) for name in sorted(own))


if __name__ == "__main__":
    unittest.main()
