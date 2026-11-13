#!/usr/bin/env python3
"""Control 2 is judged on three timed windows, each with a fresh dump: the
candidate is inadequate only when two or more exceed the 100 ms limit, and one
over is a pass with a warning naming it. No Docker. The 100 ms limit itself is
test_percona_host_noise.py's and test_percona_snapshot_probe.py's."""

from __future__ import annotations

import unittest

import percona_snapshot_probe as psp

QUIET = {"t1": 0.02, "t2": 0.02, "t3": 0.02}
HEALTHY = {"t1": [0.004, 0.031], "t2": [0.005, 0.03], "t3": [0.006, 0.03]}
STALLED = {"t1": [0.004, 10.1], "t2": [0.005, 9.9], "t3": [0.006, 10.0]}
ALL_GREEN = {1: True, 2: True, 3: True, 4: True, 5: True, 6: True}


def windows(*rounds: dict[str, list[float]]) -> dict[int, dict[str, list[float]]]:
    return {number: samples for number, samples in enumerate(rounds, 1)}


class ThreeWindowTests(unittest.TestCase):
    def test_the_default_plan_has_three_long_windows(self) -> None:
        plan = psp.PLANS[None]
        self.assertEqual(psp.LATENCY_WINDOWS, 3)
        self.assertEqual(sum(spec.long_round for spec in plan), psp.LATENCY_WINDOWS)
        self.assertEqual(psp.WINDOWS_TO_FAIL, 2)
        self.assertTrue(all(spec.long_transaction for spec in plan if spec.long_round))

    def test_the_candidate_limit_is_unchanged(self) -> None:
        self.assertEqual(psp.LATENCY_LIMIT_SECONDS, 0.100)

    def test_three_healthy_windows_pass_with_no_warning(self) -> None:
        w = windows(HEALTHY, HEALTHY, HEALTHY)
        self.assertTrue(psp.windowed_latency_verdict(w, psp.LATENCY_LIMIT_SECONDS, QUIET).passed)
        self.assertEqual(psp.window_warnings(w, psp.LATENCY_LIMIT_SECONDS), [])


class StallInjectionSabotageTests(unittest.TestCase):
    """A stall injected into the windows: every round, one round, two rounds."""

    def test_a_stall_on_every_round_fails_and_exits_three(self) -> None:
        verdict = psp.windowed_latency_verdict(windows(STALLED, STALLED, STALLED), psp.LATENCY_LIMIT_SECONDS, QUIET)
        self.assertFalse(verdict.passed)
        self.assertIn("exceeds the 100.0 ms limit", verdict.reason)
        self.assertEqual(
            psp.exit_code({**ALL_GREEN, 2: verdict.passed}, sabotaged=False, baseline=QUIET, worst={"t1": 10.1, "t2": 9.9, "t3": 10.0}),
            psp.EXIT_CANDIDATE_INADEQUATE,
        )

    def test_a_stall_on_one_round_only_passes_and_warns_naming_it(self) -> None:
        for bad in (1, 2, 3):
            rounds = [HEALTHY, HEALTHY, HEALTHY]
            rounds[bad - 1] = STALLED
            w = windows(*rounds)
            verdict = psp.windowed_latency_verdict(w, psp.LATENCY_LIMIT_SECONDS, QUIET)
            self.assertTrue(verdict.passed, bad)
            warnings = psp.window_warnings(w, psp.LATENCY_LIMIT_SECONDS)
            self.assertEqual(len(warnings), 1, bad)
            self.assertIn(f"round {bad}", warnings[0])
            self.assertIn("WARNING", warnings[0])
            self.assertIn("1 of 3", warnings[0])
            self.assertEqual(psp.exit_code({**ALL_GREEN, 2: verdict.passed}, sabotaged=False, baseline=QUIET, worst={"t1": 10.1}), psp.EXIT_PASSED)

    def test_a_stall_on_two_rounds_fails(self) -> None:
        for good in (1, 2, 3):
            rounds = [STALLED, STALLED, STALLED]
            rounds[good - 1] = HEALTHY
            verdict = psp.windowed_latency_verdict(windows(*rounds), psp.LATENCY_LIMIT_SECONDS, QUIET)
            self.assertFalse(verdict.passed, good)

    def test_the_two_of_three_rule_is_what_decides_it(self) -> None:
        """Dropping the rule (one over fails, or only all three fail) turns a
        case above red: this is the test that goes red when the rule is dropped."""
        one = windows(STALLED, HEALTHY, HEALTHY)
        two = windows(STALLED, STALLED, HEALTHY)
        self.assertTrue(psp.windowed_latency_verdict(one, psp.LATENCY_LIMIT_SECONDS, QUIET).passed)
        self.assertFalse(psp.windowed_latency_verdict(two, psp.LATENCY_LIMIT_SECONDS, QUIET).passed)

    def test_a_sabotage_plan_with_one_window_still_goes_red_on_one(self) -> None:
        self.assertFalse(psp.windowed_latency_verdict(windows(STALLED), psp.LATENCY_LIMIT_SECONDS, None).passed)
        self.assertTrue(psp.windowed_latency_verdict(windows(HEALTHY), psp.LATENCY_LIMIT_SECONDS, None).passed)

    def test_a_window_nobody_measured_fails_the_control_outright(self) -> None:
        self.assertFalse(psp.windowed_latency_verdict(windows(HEALTHY, HEALTHY, {"t1": [0.004], "t2": []}), psp.LATENCY_LIMIT_SECONDS, QUIET).passed)
        self.assertFalse(psp.windowed_latency_verdict({}, psp.LATENCY_LIMIT_SECONDS, QUIET).passed)

    def test_a_noisy_host_failure_is_still_named_and_still_inconclusive(self) -> None:
        noisy = {"t1": 0.2, "t2": 0.2, "t3": 0.2}
        slow = {"t1": [0.004, 0.41], "t2": [0.004, 0.42], "t3": [0.004, 0.41]}
        verdict = psp.windowed_latency_verdict(windows(slow, slow, slow), psp.LATENCY_LIMIT_SECONDS, noisy)
        self.assertFalse(verdict.passed)
        self.assertIn("host's own commit latency", verdict.reason)
        self.assertEqual(
            psp.exit_code({**ALL_GREEN, 2: False}, sabotaged=False, baseline=noisy, worst={"t1": 0.41, "t2": 0.42, "t3": 0.41}), psp.EXIT_HOST_TOO_NOISY
        )


class RecordedWindowsTests(unittest.TestCase):
    def test_each_round_is_a_window_and_only_long_rounds_are_judged(self) -> None:
        scenario = psp.Scenario()
        psp.record_round_latencies(scenario, 1, True, {"t1": [0.01], "t2": [0.01], "t3": [0.01]})
        psp.record_round_latencies(scenario, 2, False, {"t1": [9.0], "t2": [9.0], "t3": [9.0]})
        psp.record_round_latencies(scenario, 3, True, {"t1": [0.02], "t2": [0.02], "t3": [0.02]})
        self.assertEqual(sorted(psp.judged_windows(scenario)), [1, 3])
        self.assertEqual(scenario.latencies["t1"], [0.01, 9.0, 0.02])

    def test_a_plan_with_no_long_round_judges_every_round(self) -> None:
        scenario = psp.Scenario()
        psp.record_round_latencies(scenario, 1, False, {"t1": [0.01], "t2": [0.01], "t3": [0.01]})
        self.assertEqual(sorted(psp.judged_windows(scenario)), [1])

    def test_a_stall_recorded_on_every_long_round_fails_one_recorded_on_one_does_not(self) -> None:
        every, one = psp.Scenario(), psp.Scenario()
        for number in (1, 2, 3):
            psp.record_round_latencies(every, number, True, {t: [0.01, 10.0] for t in psp.TENANTS})
            psp.record_round_latencies(one, number, True, {t: [0.01, 10.0 if number == 2 else 0.02] for t in psp.TENANTS})
        self.assertFalse(psp.windowed_latency_verdict(psp.judged_windows(every), psp.LATENCY_LIMIT_SECONDS, QUIET).passed)
        self.assertTrue(psp.windowed_latency_verdict(psp.judged_windows(one), psp.LATENCY_LIMIT_SECONDS, QUIET).passed)


if __name__ == "__main__":
    unittest.main()
