#!/usr/bin/env python3
"""Control 2 on every round, a stall told from a noisy host. No Docker: the
verdict and exit-code logic runs on per-round baselines and worst statements
recorded from real runs (percona_snapshot_probe_noisy_host.json).

Per round: a worst statement over 100 ms is a stall when the round's own
baseline is quiet (at or under 50 ms) or when it is over 100 ms plus twice the
baseline; otherwise the round is inconclusive. Any stall exits 3, else any
inconclusive round exits 6, else 0."""

from __future__ import annotations

import json
import pathlib
import types
import unittest

import percona_snapshot_probe as psp
import snapshot_probe as sp

_FIXTURE = json.loads((pathlib.Path(__file__).resolve().parent / "percona_snapshot_probe_noisy_host.json").read_text(encoding="utf-8"))["runs"]

ALL_GREEN = {1: True, 2: True, 3: True, 4: True, 5: True, 6: True}
TENANTS = ("t1", "t2", "t3")
QUIET = dict.fromkeys(TENANTS, 0.02)
FAST = dict.fromkeys(TENANTS, 0.03)
NOISY = dict.fromkeys(TENANTS, 0.2)


def rows(name: str) -> list[dict[str, dict[str, float]]]:
    return _FIXTURE[name]["rounds"]


def readings_of(name: str) -> dict[int, psp.RoundReading]:
    return {number: psp.RoundReading(row["baseline"], row["worst"]) for number, row in enumerate(rows(name), 1)}


def exit_of(name: str, *, edit: dict[int, dict[str, dict[str, float]]] | None = None) -> int:
    """What the probe exits for a recorded run: control 2's verdict, then the exit code."""
    runs = [{**row, **(edit or {}).get(number, {})} for number, row in enumerate(rows(name), 1)]
    latencies = {number: {tenant: [0.004, worst] for tenant, worst in row["worst"].items()} for number, row in enumerate(runs, 1)}
    baselines = {number: dict(row["baseline"]) for number, row in enumerate(runs, 1)}
    verdict = psp.rounds_latency_verdict(latencies, psp.LATENCY_LIMIT_SECONDS, baselines)
    readings = {number: psp.RoundReading(row["baseline"], row["worst"]) for number, row in enumerate(runs, 1)}
    return psp.exit_code({**ALL_GREEN, 2: verdict.passed}, sabotaged=False, rounds=readings)


def scenario_exit(stalls: dict[int, float], baseline: dict[str, float] = QUIET) -> int:
    """A five-round default run on a host with `baseline`, each round fast but
    for the stalls injected as {round: worst statement on t1}."""
    plan = psp.PLANS[None]
    scenario = psp.Scenario()
    for number in range(1, len(plan) + 1):
        psp.record_round_baseline(scenario, number, baseline)
        psp.record_round_latencies(scenario, number, {tenant: [0.004, stalls.get(number, 0.03) if tenant == "t1" else 0.03] for tenant in TENANTS})
    verdict = psp.rounds_latency_verdict(scenario.window_latencies, psp.LATENCY_LIMIT_SECONDS, scenario.round_baselines)
    return psp.exit_code({**ALL_GREEN, 2: verdict.passed}, sabotaged=False, rounds=psp.round_readings(scenario))


def reading(baseline: float, worst: float) -> psp.RoundReading:
    return psp.RoundReading(dict.fromkeys(TENANTS, baseline), dict.fromkeys(TENANTS, worst))


class RecordedRunsTests(unittest.TestCase):
    def test_a_host_that_degraded_after_round_1_is_inconclusive(self) -> None:
        self.assertEqual(exit_of("degraded_after_round_1"), psp.EXIT_HOST_TOO_NOISY)

    def test_the_same_run_with_a_quiet_round_1_baseline_is_a_stall(self) -> None:
        """The fixture's assumption decides its result, and this pins how."""
        self.assertEqual(exit_of("degraded_after_round_1", edit={1: {"baseline": QUIET, "worst": rows("degraded_after_round_1")[0]["worst"]}}), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_a_quiet_and_fast_run_passes(self) -> None:
        self.assertEqual(exit_of("quiet_fast"), psp.EXIT_PASSED)

    def test_a_recorded_stall_on_a_quiet_host_is_inadequate(self) -> None:
        self.assertEqual(exit_of("quiet_real_stall"), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_the_older_slow_runner_runs_are_inconclusive(self) -> None:
        self.assertEqual(exit_of("noisy_all_rounds"), psp.EXIT_HOST_TOO_NOISY)
        self.assertEqual(exit_of("noisy_all_rounds_second"), psp.EXIT_HOST_TOO_NOISY)

    def test_the_inconclusive_message_names_the_rounds_and_never_says_inadequate(self) -> None:
        message = psp.outcome_message(psp.EXIT_HOST_TOO_NOISY, "", readings_of("degraded_after_round_1"))
        self.assertIn("host too noisy: inconclusive", message)
        self.assertNotIn("INADEQUATE", message.upper())
        self.assertIn("round 5", message)
        self.assertNotIn("round 4", message)
        self.assertIn("382.5 ms", message)


class EveryRoundTests(unittest.TestCase):
    """A stall in any one round, long or short, on a quiet host exits 3."""

    def test_a_30_second_stall_in_any_one_round_exits_3(self) -> None:
        for number in range(1, len(psp.PLANS[None]) + 1):
            self.assertEqual(scenario_exit({number: 30.0}), psp.EXIT_CANDIDATE_INADEQUATE, f"round {number}")

    def test_the_default_plan_has_a_long_round_and_short_ones(self) -> None:
        plan = psp.PLANS[None]
        self.assertTrue(plan[0].long_round)
        self.assertTrue(any(not spec.long_round for spec in plan))

    def test_a_quiet_fast_run_exits_0(self) -> None:
        self.assertEqual(scenario_exit({}), psp.EXIT_PASSED)

    def test_a_stall_is_never_outvoted_by_the_other_rounds(self) -> None:
        self.assertEqual(scenario_exit({3: 0.2}), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_a_stall_beats_an_inconclusive_round(self) -> None:
        outcomes = {**ALL_GREEN, 2: False}
        rounds = {1: reading(0.2, 0.3), 2: reading(0.02, 0.3), 3: reading(0.2, 0.3)}
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=rounds), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_an_inconclusive_round_beside_clean_ones_is_inconclusive_not_a_pass(self) -> None:
        outcomes = {**ALL_GREEN, 2: False}
        rounds = {1: reading(0.02, 0.03), 2: reading(0.2, 0.3), 3: reading(0.02, 0.03)}
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=rounds), psp.EXIT_HOST_TOO_NOISY)

    def test_the_ruling_per_round(self) -> None:
        classify = psp.classify_round
        self.assertEqual(classify(reading(0.02, 0.03)), psp.ROUND_OK)
        self.assertEqual(classify(reading(0.02, 0.101)), psp.ROUND_STALL)
        self.assertEqual(classify(reading(psp.HOST_BASELINE_BOUND_SECONDS, 0.101)), psp.ROUND_STALL)
        self.assertEqual(classify(reading(0.051, 0.101)), psp.ROUND_INCONCLUSIVE)
        edge = psp.LATENCY_LIMIT_SECONDS + psp.HOST_NOISE_FACTOR * 0.2
        self.assertEqual(classify(reading(0.2, edge - 0.001)), psp.ROUND_INCONCLUSIVE)
        self.assertEqual(classify(reading(0.2, edge + 0.001)), psp.ROUND_STALL)
        self.assertEqual(classify(reading(0.2, 0.05)), psp.ROUND_OK)

    def test_a_quiet_tenant_that_stalls_beside_a_noisy_one_is_a_stall(self) -> None:
        mixed = psp.RoundReading({"t1": 0.02, "t2": 0.2, "t3": 0.2}, {"t1": 0.3, "t2": 0.3, "t3": 0.3})
        self.assertEqual(psp.classify_round(mixed), psp.ROUND_STALL)

    def test_each_rounds_own_baseline_is_kept_by_round(self) -> None:
        scenario = psp.Scenario()
        psp.record_round_baseline(scenario, 1, {"t1": 0.02, "t2": 0.03, "t3": 0.02})
        psp.record_round_baseline(scenario, 2, {"t1": 0.30, "t2": 0.30, "t3": 0.30})
        self.assertEqual(scenario.round_baselines[1], {"t1": 0.02, "t2": 0.03, "t3": 0.02})
        self.assertEqual(scenario.round_baselines[2], {"t1": 0.30, "t2": 0.30, "t3": 0.30})


class Control2Tests(unittest.TestCase):
    """control_2 itself, on a recorded scenario: every round, baselines printed."""

    @staticmethod
    def _control_2(stalls: dict[int, float]) -> sp.ControlResult:
        scenario = psp.Scenario()
        for number in range(1, len(psp.PLANS[None]) + 1):
            psp.record_round_baseline(scenario, number, {"t1": 0.011 * number, "t2": 0.02, "t3": 0.02})
            psp.record_round_latencies(scenario, number, {tenant: [0.004, stalls.get(number, 0.03) if tenant == "t1" else 0.03] for tenant in TENANTS})
        return psp.control_2(types.SimpleNamespace(failure=None, scenario=scenario))  # type: ignore[arg-type]

    def test_a_stall_in_a_short_round_fails_the_control(self) -> None:
        for number in range(1, len(psp.PLANS[None]) + 1):
            self.assertFalse(self._control_2({number: 30.0}).verdict.passed, f"round {number}")
        self.assertTrue(self._control_2({}).verdict.passed)

    def test_each_rounds_baseline_is_printed_per_tenant(self) -> None:
        lines = [line for line in self._control_2({}).numbers if line.startswith("round ")]
        self.assertEqual(len(lines), len(psp.PLANS[None]))
        self.assertIn("baseline before this round's first dump t1 22.0 ms, t2 20.0 ms, t3 20.0 ms", lines[1])


class SabotageTests(unittest.TestCase):
    def test_the_global_lock_sabotage_stays_red(self) -> None:
        self.assertEqual(sum(spec.long_round for spec in psp.PLANS["global-lock"]), 1)
        self.assertEqual(psp.SABOTAGE_TARGETS["global-lock"], (2, 3))
        recorded = rows("quiet_real_stall")[0]
        latencies = {1: {tenant: [0.004, worst] for tenant, worst in recorded["worst"].items()}}
        verdict = psp.rounds_latency_verdict(latencies, psp.LATENCY_LIMIT_SECONDS, {1: recorded["baseline"]})
        self.assertFalse(verdict.passed)
        self.assertIn("exceeds the 100.0 ms limit", verdict.reason)
        readings = {1: psp.RoundReading(recorded["baseline"], recorded["worst"])}
        self.assertEqual(psp.exit_code({2: False, 3: False}, sabotaged=True, rounds=readings), psp.EXIT_RED)
        self.assertEqual(psp.exit_code({2: True, 3: True}, sabotaged=True, rounds=readings), psp.EXIT_SABOTAGE_NOT_DETECTED)

    def test_a_sabotage_run_on_a_noisy_host_keeps_its_codes(self) -> None:
        degraded = readings_of("degraded_after_round_1")
        self.assertEqual(psp.exit_code({2: False, 3: False}, sabotaged=True, rounds=degraded), psp.EXIT_RED)
        self.assertEqual(psp.exit_code({2: True}, sabotaged=True, rounds=degraded), psp.EXIT_SABOTAGE_NOT_DETECTED)

    def test_another_failed_control_is_still_inadequate_on_a_noisy_host(self) -> None:
        for control in (1, 3, 4, 5):
            outcomes = {**ALL_GREEN, 2: False, control: False}
            self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=readings_of("degraded_after_round_1")), psp.EXIT_CANDIDATE_INADEQUATE, control)

    def test_no_reading_or_a_blind_round_is_never_excused(self) -> None:
        outcomes = {**ALL_GREEN, 2: False}
        degraded = readings_of("degraded_after_round_1")
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=None), psp.EXIT_CANDIDATE_INADEQUATE)
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds={}), psp.EXIT_CANDIDATE_INADEQUATE)
        blind = {**degraded, 3: psp.RoundReading(degraded[3].baseline, {"t1": 0.5})}
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=blind), psp.EXIT_CANDIDATE_INADEQUATE)
        self.assertFalse(psp.rounds_latency_verdict({1: {"t1": [0.004], "t2": []}}, psp.LATENCY_LIMIT_SECONDS, None).passed)
        self.assertFalse(psp.rounds_latency_verdict({}, psp.LATENCY_LIMIT_SECONDS, None).passed)

    def test_a_failing_finding_and_a_pass_are_not_hidden(self) -> None:
        self.assertEqual(psp.exit_code({**ALL_GREEN, 6: False}, sabotaged=False, rounds=readings_of("degraded_after_round_1")), psp.EXIT_FINDING_NOT_RECORDED)
        self.assertEqual(psp.exit_code(ALL_GREEN, sabotaged=False, rounds=readings_of("degraded_after_round_1")), psp.EXIT_PASSED)


class LimitAndExitTests(unittest.TestCase):
    def test_the_candidate_threshold_is_unchanged(self) -> None:
        self.assertEqual(psp.LATENCY_LIMIT_SECONDS, 0.100)
        self.assertEqual(sp.WRITER_LIMIT_SECONDS, 0.100)

    def test_the_inconclusive_exit_is_distinct(self) -> None:
        codes = {psp.EXIT_PASSED, psp.EXIT_RED, psp.EXIT_SABOTAGE_NOT_DETECTED, psp.EXIT_CANDIDATE_INADEQUATE, psp.EXIT_FINDING_NOT_RECORDED, psp.EXIT_REFUSED, 64}
        self.assertNotIn(psp.EXIT_HOST_TOO_NOISY, codes)

    def test_the_bound_sits_between_the_quiet_runs_and_the_noisy_ones(self) -> None:
        quiet = max(max(row["baseline"].values()) for run in ("quiet_fast", "quiet_real_stall") for row in rows(run))
        noisy = min(min(row["baseline"].values()) for row in rows("noisy_all_rounds_second"))
        self.assertGreater(psp.HOST_BASELINE_BOUND_SECONDS, quiet)
        self.assertLess(psp.HOST_BASELINE_BOUND_SECONDS, noisy)
        self.assertLess(psp.HOST_BASELINE_BOUND_SECONDS, psp.LATENCY_LIMIT_SECONDS)

    def test_every_round_is_judged_the_whole_run_over(self) -> None:
        """Issue 1708: every write under 100 ms for the whole run. No round, and no
        number of rounds, outvotes a stall: there is no windows-to-fail rule."""
        self.assertFalse(hasattr(psp, "WINDOWS_TO_FAIL"))
        self.assertFalse(hasattr(psp, "LATENCY_WINDOWS"))


if __name__ == "__main__":
    unittest.main()
