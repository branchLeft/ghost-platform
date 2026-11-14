#!/usr/bin/env python3
"""Control 2 on every round, a stall told from a noisy host by where it fell. No
Docker: the verdict and exit-code logic runs on slow writes and dump windows,
some recorded from real runs (percona_snapshot_probe_noisy_host.json), some laid
out here.

A write over 100 ms is the candidate's only when it overlaps its own tenant's
snapshot window (20 ms of margin either side) and was not a spike on every
tenant at once; or when slow writes recur inside their tenants' windows in two
or more passes. A write over 100 ms outside every window, or a spike on every
tenant at once, is the host's: the round is inconclusive. Any attributed stall
exits 3, else any inconclusive round exits 6, else 0."""

from __future__ import annotations

import json
import pathlib
import types
import unittest
from collections.abc import Mapping, Sequence
from unittest import mock

import percona_snapshot_probe as psp
import snapshot_probe as sp

_FIXTURE = json.loads((pathlib.Path(__file__).resolve().parent / "percona_snapshot_probe_noisy_host.json").read_text(encoding="utf-8"))["runs"]

ALL_GREEN = {1: True, 2: True, 3: True, 4: True, 5: True, 6: True}
TENANTS = ("t1", "t2", "t3")
QUIET = dict.fromkeys(TENANTS, 0.02)
# A short round: one pass, each tenant dumped in turn. The long round has three.
SHORT = {"t1": (2.0, 5.0), "t2": (5.0, 8.0), "t3": (8.0, 11.0)}


def windows(passes: int = 1) -> dict[str, list[psp.DumpWindow]]:
    return {tenant: [psp.DumpWindow(n, start + 12 * (n - 1), end + 12 * (n - 1)) for n in range(1, passes + 1)] for tenant, (start, end) in SHORT.items()}


def slow(**writes: Sequence[tuple[float, float]]) -> dict[str, list[psp.SlowWrite]]:
    """slow(t1=[(start, latency)], ...): the writes a round recorded."""
    return {tenant: [psp.SlowWrite(start, latency) for start, latency in writes.get(tenant, ())] for tenant in TENANTS}


def make_round(
    written: Mapping[str, Sequence[psp.SlowWrite]], *, baseline: Mapping[str, float] = QUIET, passes: int = 1
) -> psp.RoundReading:
    worst = {tenant: max([0.03, *(write.latency for write in written.get(tenant, ()))]) for tenant in TENANTS}
    return psp.RoundReading(dict(baseline), worst, written, windows(passes))


def quiet_round() -> psp.RoundReading:
    return make_round(slow())


def exit_of(rounds: Mapping[int, psp.RoundReading]) -> int:
    """What the probe exits for these rounds: control 2's verdict, then the exit code."""
    latencies = {number: {tenant: [0.004, worst] for tenant, worst in reading.worst.items()} for number, reading in rounds.items()}
    baselines = {number: dict(reading.baseline) for number, reading in rounds.items()}
    verdict = psp.rounds_latency_verdict(latencies, psp.LATENCY_LIMIT_SECONDS, baselines)
    return psp.exit_code({**ALL_GREEN, 2: verdict.passed}, sabotaged=False, rounds=rounds)


def run_of(*rounds: psp.RoundReading) -> dict[int, psp.RoundReading]:
    """Five rounds, the given ones first and quiet ones after."""
    return {number: (rounds[number - 1] if number <= len(rounds) else quiet_round()) for number in range(1, 6)}


def recorded(name: str) -> dict[int, psp.RoundReading]:
    return {
        number: psp.RoundReading(
            row["baseline"],
            row["worst"],
            {tenant: [psp.SlowWrite(*write) for write in writes] for tenant, writes in row["slow"].items()},
            {tenant: [psp.DumpWindow(*span) for span in spans] for tenant, spans in row["windows"].items()},
        )
        for number, row in enumerate(_FIXTURE[name]["rounds"], 1)
    }


class AttributionTests(unittest.TestCase):
    """The four cases the rule is for."""

    def test_a_slow_write_inside_the_tenants_own_snapshot_window_is_a_stall(self) -> None:
        inside = make_round(slow(t1=[(3.0, 0.150)]))
        self.assertEqual(psp.classify_round(inside), psp.ROUND_STALL)
        self.assertEqual(exit_of(run_of(inside)), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_a_simultaneous_spike_on_every_tenant_outside_any_window_is_inconclusive(self) -> None:
        spike = make_round(slow(t1=[(0.5, 0.204)], t2=[(0.5, 0.202)], t3=[(0.5, 0.203)]))
        self.assertEqual(psp.classify_round(spike), psp.ROUND_INCONCLUSIVE)
        self.assertEqual(exit_of(run_of(spike)), psp.EXIT_HOST_TOO_NOISY)

    def test_a_quiet_run_passes(self) -> None:
        self.assertEqual(exit_of(run_of()), psp.EXIT_PASSED)

    def test_dropping_the_overlap_check_turns_the_spike_into_a_stall(self) -> None:
        """Sabotage: with the overlap check gone every slow write is inside some
        window, and the spike outside every window exits 3."""
        spike = run_of(make_round(slow(t1=[(0.5, 0.204)], t2=[(0.5, 0.202)], t3=[(0.5, 0.203)])))
        self.assertEqual(exit_of(spike), psp.EXIT_HOST_TOO_NOISY)
        with mock.patch.object(psp, "_own_window", lambda write, spans: psp.DumpWindow(1, 0.0, 0.0)):
            self.assertEqual(exit_of(spike), psp.EXIT_CANDIDATE_INADEQUATE)
        with mock.patch.object(psp, "_reaches", lambda *args: True):
            self.assertEqual(exit_of(spike), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_the_overlap_check_still_sees_the_stall_it_exists_for(self) -> None:
        inside = run_of(make_round(slow(t1=[(3.0, 0.150)])))
        with mock.patch.object(psp, "_reaches", lambda *args: False):
            self.assertEqual(exit_of(inside), psp.EXIT_HOST_TOO_NOISY)
        self.assertEqual(exit_of(inside), psp.EXIT_CANDIDATE_INADEQUATE)


class WhereItFellTests(unittest.TestCase):
    def test_a_write_in_the_margin_of_the_window_overlaps_it(self) -> None:
        for start in (1.981, 5.019):
            with self.subTest(start=start):
                self.assertEqual(psp.classify_round(make_round(slow(t1=[(start, 0.002 + 0.1)]))), psp.ROUND_STALL)

    def test_a_write_that_ended_before_the_margin_does_not(self) -> None:
        self.assertEqual(psp.classify_round(make_round(slow(t1=[(1.0, 0.150)]))), psp.ROUND_INCONCLUSIVE)
        self.assertEqual(psp.classify_round(make_round(slow(t1=[(5.2, 0.150)]))), psp.ROUND_INCONCLUSIVE)

    def test_a_write_that_started_before_the_window_and_ran_into_it_overlaps_it(self) -> None:
        self.assertEqual(psp.classify_round(make_round(slow(t1=[(1.0, 1.5)]))), psp.ROUND_STALL)

    def test_another_tenants_window_is_not_this_tenants(self) -> None:
        """t1 is slow while t2 is being dumped: t1's own snapshot is not running."""
        self.assertEqual(psp.classify_round(make_round(slow(t1=[(6.0, 0.150)]))), psp.ROUND_INCONCLUSIVE)

    def test_one_tenant_slow_at_its_own_window_beside_quiet_ones_is_a_stall(self) -> None:
        self.assertEqual(psp.classify_round(make_round(slow(t2=[(6.0, 0.150)]))), psp.ROUND_STALL)

    def test_a_spike_on_every_tenant_at_once_that_overlaps_one_window_is_the_hosts(self) -> None:
        """t1 is in its window; t2 and t3 are not being dumped and spike with it."""
        spike = make_round(slow(t1=[(3.0, 0.204)], t2=[(3.0, 0.202)], t3=[(3.01, 0.203)]))
        self.assertEqual(psp.classify_round(spike), psp.ROUND_INCONCLUSIVE)

    def test_a_spike_that_a_tenant_not_dumped_did_not_share_is_a_stall(self) -> None:
        spike = make_round(slow(t1=[(3.0, 0.204)], t2=[(3.0, 0.202)], t3=[(0.5, 0.203)]))
        self.assertEqual(psp.classify_round(spike), psp.ROUND_STALL)

    def test_the_spike_has_to_be_the_same_size(self) -> None:
        """A global lock under a long reader: the dumped tenant waits a minute and
        the others a fraction of it. Nothing like a runner that froze."""
        lock = make_round(slow(t1=[(2.1, 59.9)], t2=[(2.2, 0.326)], t3=[(2.3, 0.328)]))
        self.assertEqual(psp.classify_round(lock), psp.ROUND_STALL)

    def test_a_spike_on_another_tenant_inside_its_own_window_is_not_a_shared_one(self) -> None:
        both = make_round(slow(t1=[(3.0, 0.204)], t2=[(5.5, 0.202)], t3=[(3.0, 0.203)]))
        self.assertEqual(psp.classify_round(both), psp.ROUND_STALL)

    def test_a_write_over_the_limit_with_nothing_recorded_for_it_is_blind(self) -> None:
        blind = psp.RoundReading(QUIET, {"t1": 0.5, "t2": 0.03, "t3": 0.03}, slow(), windows())
        self.assertEqual(psp.classify_round(blind), psp.ROUND_STALL)
        no_windows = psp.RoundReading(QUIET, {"t1": 0.5, "t2": 0.03, "t3": 0.03}, slow(t1=[(0.5, 0.5)]), {})
        self.assertEqual(psp.classify_round(no_windows), psp.ROUND_STALL)

    def test_writes_under_the_limit_never_fail_a_round(self) -> None:
        self.assertEqual(psp.classify_round(make_round(slow(t1=[(3.0, 0.099), (6.0, 0.099)]))), psp.ROUND_OK)


class RecurrenceTests(unittest.TestCase):
    def test_slow_writes_in_windows_in_two_passes_are_a_stall_beside_a_noise_spike(self) -> None:
        """The over-limit write is outside every window (the host's), but writes
        over 50 ms recur inside t1's own windows in two passes."""
        noise = slow(t1=[(0.5, 0.204), (3.0, 0.060), (15.0, 0.070)], t2=[(0.5, 0.202)], t3=[(0.5, 0.203)])
        long_round = make_round(noise, passes=3)
        self.assertEqual(psp.classify_round(long_round), psp.ROUND_INCONCLUSIVE)
        self.assertEqual(exit_of(run_of(long_round)), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_shared_spikes_inside_the_windows_in_two_passes_are_a_stall(self) -> None:
        shared = slow(t1=[(3.0, 0.204), (15.0, 0.210)], t2=[(3.0, 0.202), (15.0, 0.208)], t3=[(3.0, 0.203), (15.0, 0.209)])
        long_round = make_round(shared, passes=3)
        self.assertEqual(psp.classify_round(long_round), psp.ROUND_INCONCLUSIVE)
        self.assertEqual(exit_of(run_of(long_round)), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_the_same_spike_in_one_pass_only_is_inconclusive(self) -> None:
        once = make_round(slow(t1=[(3.0, 0.204)], t2=[(3.0, 0.202)], t3=[(3.0, 0.203)]), passes=3)
        self.assertEqual(exit_of(run_of(once)), psp.EXIT_HOST_TOO_NOISY)

    def test_two_passes_in_different_rounds_recur(self) -> None:
        once = slow(t1=[(3.0, 0.204)], t2=[(3.0, 0.202)], t3=[(3.0, 0.203)])
        self.assertEqual(exit_of(run_of(make_round(once), make_round(once))), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_two_writes_in_one_pass_are_one_pass(self) -> None:
        both = slow(t1=[(3.0, 0.204), (4.0, 0.205)], t2=[(3.0, 0.202), (4.0, 0.2)], t3=[(3.0, 0.203), (4.0, 0.2)])
        self.assertEqual(exit_of(run_of(make_round(both))), psp.EXIT_HOST_TOO_NOISY)

    def test_writes_the_hosts_own_floor_explains_do_not_recur(self) -> None:
        """A host whose writes were already this slow before the first dump."""
        shared = slow(t1=[(3.0, 0.204), (15.0, 0.210)], t2=[(3.0, 0.202), (15.0, 0.208)], t3=[(3.0, 0.203), (15.0, 0.209)])
        floor = dict.fromkeys(TENANTS, 0.25)
        self.assertEqual(exit_of(run_of(make_round(shared, baseline=floor, passes=3))), psp.EXIT_HOST_TOO_NOISY)


class RecordedRunsTests(unittest.TestCase):
    def test_a_host_that_degraded_after_round_1_is_inconclusive(self) -> None:
        self.assertEqual(exit_of(recorded("degraded_after_round_1")), psp.EXIT_HOST_TOO_NOISY)

    def test_the_same_run_with_every_spike_inside_its_tenants_window_is_a_stall(self) -> None:
        """The fixture's placement decides its result, and this pins how: the same
        figures, tenant by tenant at the tenant's own window, are the dump's."""
        moved = {}
        for number, reading in recorded("degraded_after_round_1").items():
            moved[number] = psp.RoundReading(
                reading.baseline,
                reading.worst,
                {tenant: [psp.SlowWrite(SHORT[tenant][0] + 0.1, write.latency) for write in writes] for tenant, writes in reading.slow.items()},
                reading.windows,
            )
        self.assertEqual(exit_of(moved), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_the_round_1_floor_of_382_ms_keeps_shared_spikes_in_windows_inconclusive(self) -> None:
        """Round 1's own baseline was never logged; 382 ms, the run's worst across
        rounds, stands in for it, an upper bound and not a measurement. Shared
        spikes inside the windows of two passes of the long round are the host's at
        that floor and the candidate's on a quiet one."""
        spikes = slow(t1=[(3.0, 0.331), (15.0, 0.331)], t2=[(3.0, 0.267), (15.0, 0.267)], t3=[(3.0, 0.334), (15.0, 0.334)])
        degraded = recorded("degraded_after_round_1")
        logged = psp.RoundReading(degraded[1].baseline, {"t1": 0.331, "t2": 0.267, "t3": 0.334}, spikes, windows(3))
        quiet_floor = psp.RoundReading(QUIET, logged.worst, spikes, windows(3))
        rest = {number: quiet_round() for number in range(2, 6)}
        self.assertEqual(exit_of({1: logged, **rest}), psp.EXIT_HOST_TOO_NOISY)
        self.assertEqual(exit_of({1: quiet_floor, **rest}), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_a_quiet_and_fast_run_passes(self) -> None:
        self.assertEqual(exit_of(recorded("quiet_fast")), psp.EXIT_PASSED)

    def test_the_recorded_global_lock_stall_on_a_quiet_host_is_inadequate(self) -> None:
        self.assertEqual(exit_of(recorded("quiet_real_stall")), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_the_older_slow_runner_runs_are_inconclusive(self) -> None:
        self.assertEqual(exit_of(recorded("noisy_all_rounds")), psp.EXIT_HOST_TOO_NOISY)
        self.assertEqual(exit_of(recorded("noisy_all_rounds_second")), psp.EXIT_HOST_TOO_NOISY)

    def test_the_inconclusive_message_names_the_rounds_and_never_says_inadequate(self) -> None:
        message = psp.outcome_message(psp.EXIT_HOST_TOO_NOISY, "", recorded("degraded_after_round_1"))
        self.assertIn("host too noisy: inconclusive", message)
        self.assertNotIn("INADEQUATE", message.upper())
        self.assertIn("round 5", message)
        self.assertNotIn("round 4", message)
        self.assertIn("outside every own window 3", message)


class EveryRoundTests(unittest.TestCase):
    """A stall in any one round, long or short, exits 3."""

    def test_a_30_second_stall_in_any_one_round_exits_3(self) -> None:
        for number in range(1, len(psp.PLANS[None]) + 1):
            rounds = run_of()
            rounds[number] = make_round(slow(t1=[(3.0, 30.0)]), passes=3 if number == 1 else 1)
            self.assertEqual(exit_of(rounds), psp.EXIT_CANDIDATE_INADEQUATE, f"round {number}")

    def test_the_default_plan_has_a_long_round_and_short_ones(self) -> None:
        plan = psp.PLANS[None]
        self.assertTrue(plan[0].long_round)
        self.assertTrue(any(not spec.long_round for spec in plan))

    def test_a_stall_is_never_outvoted_by_the_other_rounds(self) -> None:
        spike = make_round(slow(t1=[(0.5, 0.204)], t2=[(0.5, 0.202)], t3=[(0.5, 0.203)]))
        stall = make_round(slow(t1=[(3.0, 0.2)]))
        self.assertEqual(exit_of(run_of(spike, stall, spike)), psp.EXIT_CANDIDATE_INADEQUATE)

    def test_an_inconclusive_round_beside_clean_ones_is_inconclusive_not_a_pass(self) -> None:
        spike = make_round(slow(t1=[(0.5, 0.204)], t2=[(0.5, 0.202)], t3=[(0.5, 0.203)]))
        self.assertEqual(exit_of(run_of(quiet_round(), spike)), psp.EXIT_HOST_TOO_NOISY)

    def test_a_round_that_failed_with_every_round_ok_keeps_exit_3(self) -> None:
        self.assertEqual(psp.exit_code({**ALL_GREEN, 2: False}, sabotaged=False, rounds=run_of()), psp.EXIT_CANDIDATE_INADEQUATE)


class RecordingTests(unittest.TestCase):
    def test_the_slow_writes_and_windows_reach_the_readings(self) -> None:
        scenario = psp.Scenario()
        written = slow(t1=[(3.0, 0.150)])
        spans = windows()
        psp.record_round_baseline(scenario, 1, QUIET)
        psp.record_round_latencies(scenario, 1, {tenant: [0.004, 0.15 if tenant == "t1" else 0.03] for tenant in TENANTS})
        psp.record_round_attribution(scenario, 1, written, spans)
        reading = psp.round_readings(scenario)[1]
        self.assertEqual(reading.slow["t1"], [psp.SlowWrite(3.0, 0.150)])
        self.assertEqual(reading.windows["t2"], [psp.DumpWindow(1, 5.0, 8.0)])
        self.assertEqual(psp.classify_round(reading), psp.ROUND_STALL)

    def test_a_round_with_no_attribution_recorded_is_blind_not_inconclusive(self) -> None:
        scenario = psp.Scenario()
        psp.record_round_baseline(scenario, 1, QUIET)
        psp.record_round_latencies(scenario, 1, {tenant: [0.004, 0.5] for tenant in TENANTS})
        self.assertEqual(psp.classify_round(psp.round_readings(scenario)[1]), psp.ROUND_STALL)

    def test_each_rounds_own_baseline_is_kept_by_round(self) -> None:
        scenario = psp.Scenario()
        psp.record_round_baseline(scenario, 1, {"t1": 0.02, "t2": 0.03, "t3": 0.02})
        psp.record_round_baseline(scenario, 2, {"t1": 0.30, "t2": 0.30, "t3": 0.30})
        self.assertEqual(scenario.round_baselines[1], {"t1": 0.02, "t2": 0.03, "t3": 0.02})
        self.assertEqual(scenario.round_baselines[2], {"t1": 0.30, "t2": 0.30, "t3": 0.30})


class Control2Tests(unittest.TestCase):
    """control_2 itself, on a recorded scenario: every round, baselines and where
    the slow writes fell printed."""

    @staticmethod
    def _control_2(stalls: dict[int, float]) -> sp.ControlResult:
        scenario = psp.Scenario()
        for number in range(1, len(psp.PLANS[None]) + 1):
            psp.record_round_baseline(scenario, number, {"t1": 0.011 * number, "t2": 0.02, "t3": 0.02})
            psp.record_round_latencies(scenario, number, {tenant: [0.004, stalls.get(number, 0.03) if tenant == "t1" else 0.03] for tenant in TENANTS})
            psp.record_round_attribution(scenario, number, slow(t1=[(3.0, stalls[number])]) if number in stalls else slow(), windows())
        return psp.control_2(types.SimpleNamespace(failure=None, scenario=scenario))  # type: ignore[arg-type]

    def test_a_stall_in_a_short_round_fails_the_control(self) -> None:
        for number in range(1, len(psp.PLANS[None]) + 1):
            self.assertFalse(self._control_2({number: 30.0}).verdict.passed, f"round {number}")
        self.assertTrue(self._control_2({}).verdict.passed)

    def test_each_rounds_baseline_is_printed_per_tenant(self) -> None:
        lines = [line for line in self._control_2({}).numbers if "baseline before this round's first dump" in line]
        self.assertEqual(len(lines), len(psp.PLANS[None]))
        self.assertIn("baseline before this round's first dump t1 22.0 ms, t2 20.0 ms, t3 20.0 ms", lines[1])

    def test_where_the_slow_writes_fell_is_printed_per_round(self) -> None:
        lines = [line for line in self._control_2({2: 0.2}).numbers if "snapshot window" in line]
        self.assertEqual(len(lines), len(psp.PLANS[None]))
        self.assertIn("over 100.0 ms: 1, inside their own tenant's snapshot window 1 (a spike on every tenant at once: 0), outside every own window 0", lines[1])
        self.assertIn("over 100.0 ms: 0", lines[0])


class SabotageTests(unittest.TestCase):
    def test_the_global_lock_sabotage_stays_red(self) -> None:
        self.assertEqual(sum(spec.long_round for spec in psp.PLANS["global-lock"]), 1)
        self.assertEqual(psp.SABOTAGE_TARGETS["global-lock"], (2, 3))
        recorded_round = recorded("quiet_real_stall")[1]
        latencies = {1: {tenant: [0.004, worst] for tenant, worst in recorded_round.worst.items()}}
        verdict = psp.rounds_latency_verdict(latencies, psp.LATENCY_LIMIT_SECONDS, {1: recorded_round.baseline})
        self.assertFalse(verdict.passed)
        self.assertIn("exceeds the 100.0 ms limit", verdict.reason)
        readings = {1: recorded_round}
        self.assertEqual(psp.exit_code({2: False, 3: False}, sabotaged=True, rounds=readings), psp.EXIT_RED)
        self.assertEqual(psp.exit_code({2: True, 3: True}, sabotaged=True, rounds=readings), psp.EXIT_SABOTAGE_NOT_DETECTED)

    def test_a_sabotage_run_on_a_noisy_host_keeps_its_codes(self) -> None:
        degraded = recorded("degraded_after_round_1")
        self.assertEqual(psp.exit_code({2: False, 3: False}, sabotaged=True, rounds=degraded), psp.EXIT_RED)
        self.assertEqual(psp.exit_code({2: True}, sabotaged=True, rounds=degraded), psp.EXIT_SABOTAGE_NOT_DETECTED)

    def test_another_failed_control_is_still_inadequate_on_a_noisy_host(self) -> None:
        for control in (1, 3, 4, 5):
            outcomes = {**ALL_GREEN, 2: False, control: False}
            self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=recorded("degraded_after_round_1")), psp.EXIT_CANDIDATE_INADEQUATE, control)

    def test_no_reading_or_a_blind_round_is_never_excused(self) -> None:
        outcomes = {**ALL_GREEN, 2: False}
        degraded = recorded("degraded_after_round_1")
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=None), psp.EXIT_CANDIDATE_INADEQUATE)
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds={}), psp.EXIT_CANDIDATE_INADEQUATE)
        blind = {**degraded, 3: psp.RoundReading(degraded[3].baseline, {"t1": 0.5}, degraded[3].slow, degraded[3].windows)}
        self.assertEqual(psp.exit_code(outcomes, sabotaged=False, rounds=blind), psp.EXIT_CANDIDATE_INADEQUATE)
        self.assertFalse(psp.rounds_latency_verdict({1: {"t1": [0.004], "t2": []}}, psp.LATENCY_LIMIT_SECONDS, None).passed)
        self.assertFalse(psp.rounds_latency_verdict({}, psp.LATENCY_LIMIT_SECONDS, None).passed)

    def test_a_failing_finding_and_a_pass_are_not_hidden(self) -> None:
        degraded = recorded("degraded_after_round_1")
        self.assertEqual(psp.exit_code({**ALL_GREEN, 6: False}, sabotaged=False, rounds=degraded), psp.EXIT_FINDING_NOT_RECORDED)
        self.assertEqual(psp.exit_code(ALL_GREEN, sabotaged=False, rounds=degraded), psp.EXIT_PASSED)


class LimitAndExitTests(unittest.TestCase):
    def test_the_candidate_threshold_is_unchanged(self) -> None:
        self.assertEqual(psp.LATENCY_LIMIT_SECONDS, 0.100)
        self.assertEqual(sp.WRITER_LIMIT_SECONDS, 0.100)

    def test_the_inconclusive_exit_is_distinct(self) -> None:
        codes = {psp.EXIT_PASSED, psp.EXIT_RED, psp.EXIT_SABOTAGE_NOT_DETECTED, psp.EXIT_CANDIDATE_INADEQUATE, psp.EXIT_FINDING_NOT_RECORDED, psp.EXIT_REFUSED, 64}
        self.assertNotIn(psp.EXIT_HOST_TOO_NOISY, codes)

    def test_the_slow_threshold_and_margin_sit_under_the_limit(self) -> None:
        self.assertLess(psp.SLOW_WRITE_SECONDS, psp.LATENCY_LIMIT_SECONDS)
        self.assertEqual(psp.WINDOW_MARGIN_SECONDS, 0.020)
        self.assertEqual(psp.RECURRING_PASSES, 2)

    def test_every_round_is_judged_the_whole_run_over(self) -> None:
        """Issue 1708: every write under 100 ms for the whole run. No round, and no
        number of rounds, outvotes a stall: there is no windows-to-fail rule."""
        self.assertFalse(hasattr(psp, "WINDOWS_TO_FAIL"))
        self.assertFalse(hasattr(psp, "LATENCY_WINDOWS"))
        self.assertFalse(hasattr(psp, "HOST_BASELINE_BOUND_SECONDS"))


if __name__ == "__main__":
    unittest.main()
