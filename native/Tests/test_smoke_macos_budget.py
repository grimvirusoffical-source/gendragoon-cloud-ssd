"""Deadline regression tests only; no Mac helpers, fixture apps, signals or processes run."""
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import smoke_macos as smoke


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now

    def advance(self, seconds):
        self.now += seconds


class SmokeBudgetTests(unittest.TestCase):
    def test_preparation_and_previous_cases_do_not_steal_the_next_case_budget(self):
        clock, timings, timers = Clock(), {}, []
        budget = smoke.SmokeBudget(timings, clock=clock, timer=timers.append)
        with budget.phase("preparation", smoke.PREPARATION_SECONDS):
            clock.advance(19)
        for name in ("cleanup", "keep", "dirty"):
            clock.advance(.01)
            start = clock()
            with budget.phase("case_" + name, smoke.CASE_SECONDS) as deadline:
                self.assertAlmostEqual(deadline - start, 30)
                clock.advance(29)
            self.assertTrue(timings["case_" + name]["completed"])
            self.assertEqual(timings["case_" + name]["availableSeconds"], 30)
        self.assertGreater(timings["case_dirty"]["startedOffsetSeconds"], 55)
        self.assertLess(clock(), smoke.MAX_SECONDS)

    def test_expired_case_is_not_recorded_as_passed_if_signal_delivery_is_delayed(self):
        clock, timings = Clock(), {}
        budget = smoke.SmokeBudget(timings, clock=clock, timer=lambda _seconds: None)
        with self.assertRaisesRegex(smoke.SmokeDeadline, "case_dirty"):
            with budget.phase("case_dirty", smoke.CASE_SECONDS):
                clock.advance(30.1)
        self.assertFalse(timings["case_dirty"]["completed"])
        self.assertEqual(timings["case_dirty"]["seconds"], 30.1)

    def test_phase_deadline_cannot_extend_the_hard_total_deadline(self):
        clock, timings, timers = Clock(), {}, []
        budget = smoke.SmokeBudget(timings, clock=clock, timer=timers.append)
        clock.advance(119)
        with self.assertRaisesRegex(smoke.SmokeDeadline, "total"):
            with budget.phase("harness_cleanup", smoke.CLEANUP_SECONDS) as deadline:
                self.assertEqual(deadline, 120)
                self.assertEqual(timers[-1], 1)
                clock.advance(1.1)
        self.assertEqual(timings["harness_cleanup"]["availableSeconds"], 1)
        self.assertFalse(timings["harness_cleanup"]["completed"])

    def test_production_style_exception_handlers_cannot_swallow_harness_expiry(self):
        clock = Clock()
        budget = smoke.SmokeBudget({}, clock=clock, timer=lambda _seconds: None)
        with self.assertRaises(smoke.SmokeDeadline):
            try:
                budget.expire()
            except Exception:
                self.fail("An ordinary production error handler swallowed the harness deadline")

    def test_preparation_command_timeout_is_capped_by_remaining_phase_budget(self):
        result = SimpleNamespace(returncode=0, stdout="compiled", stderr="")
        with patch.object(smoke.time, "monotonic", return_value=19), patch.object(smoke.subprocess, "run", return_value=result) as run:
            self.assertEqual(smoke.checked_command(["fixture-compiler"], 20, timeout=15), "compiled")
        self.assertEqual(run.call_args.kwargs["timeout"], 1)
        with patch.object(smoke.time, "monotonic", return_value=21), patch.object(smoke.subprocess, "run") as run:
            with self.assertRaisesRegex(AssertionError, "time budget"):
                smoke.checked_command(["fixture-compiler"], 20, timeout=15)
            run.assert_not_called()

    def test_unobserved_running_case_remains_a_failure_with_its_last_receipt_state(self):
        clock = Clock()
        launcher = SimpleNamespace(read=lambda _identifier: {"state": "running", "pid": 42},
                                   process_identity=lambda _pid: None, TERMINAL={"exited-cleaned", "exited-retained", "failed-retained"})
        process = SimpleNamespace(poll=lambda: None)
        diagnostics = {"ok": False}
        with patch.object(smoke.time, "monotonic", side_effect=clock), patch.object(smoke.time, "sleep", side_effect=clock.advance):
            with self.assertRaisesRegex(AssertionError, "Timed out observing"):
                smoke.observe_and_finish({"id": "fixture"}, launcher, process, .06, diagnostics)
        self.assertEqual(diagnostics["state"], "running")
        self.assertFalse(diagnostics["ok"])


if __name__ == "__main__":
    unittest.main()
