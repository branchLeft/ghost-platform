#!/usr/bin/env python3
"""Unit tests for cutover_coordinator.py: the order, and a refusal at every precondition.

Every effect is a recorder, so a test can state which effects ran, in what
order, and which must never have run. See cutover_coordinator.md.
"""

from __future__ import annotations

import unittest
from collections.abc import Callable

import cutover_coordinator as cc
import promotion_gate as gate

SOURCE_UUID = "3e11fa47-71ca-11e1-9e33-c80aa9429562"
FROZEN = gate.FrozenSource(SOURCE_UUID, "mysql-bin.000007", 5000)
LIMITS = cc.Limits(gate_timeout_seconds=10.0, gate_poll_seconds=1.0, max_freeze_seconds=60.0)

# The effects, in the order a clean run calls them.
CLEAN_CALLS = [
    "export_done",
    "media_copy_verified",
    "edge_repoint_approved",
    "gate_control_case_refused",
    "freeze",
    "read_frozen_coordinates",
    "read_replica_status",
    "promote_replica",
    "tables_match",
    "start_new_ghost",
    "new_ghost_ready",
    "repoint_edge",
    "set_old_drain_flag",
    "old_drain_flag_set",
    "stop_old_ghost",
    "old_ghost_stopped",
    "release_freeze",
]


def replica_row(file: str = "mysql-bin.000007", position: str = "5000", **overrides: str) -> dict[str, str]:
    row = {
        "Source_UUID": SOURCE_UUID,
        "Replica_IO_Running": "Yes",
        "Replica_SQL_Running": "Yes",
        "Last_IO_Errno": "0",
        "Last_SQL_Errno": "0",
        "Last_SQL_Error": "",
        "Relay_Source_Log_File": file,
        "Exec_Source_Log_Pos": position,
    }
    row.update(overrides)
    return row


class World:
    """Recorders for every effect, a manual clock, and a hook to change one behaviour."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.now = 1000.0
        self.advance: dict[str, float] = {}
        self.results: dict[str, object] = {}
        self.replica_rows: Callable[[], list[dict[str, str]]] = lambda: [replica_row()]

    def _probe(self, name: str) -> Callable[[], bool]:
        def probe() -> bool:
            return self._act(name, True)  # type: ignore[return-value]

        return probe

    def _action(self, name: str) -> Callable[[], None]:
        def action() -> None:
            self._act(name, None)

        return action

    def _act(self, name: str, default: object) -> object:
        self.calls.append(name)
        self.now += self.advance.get(name, 0.0)
        result = self.results.get(name, default)
        if isinstance(result, Exception):
            raise result
        return result

    def sleep(self, seconds: float) -> None:
        self.now += seconds

    def clock(self) -> float:
        return self.now

    def effects(self) -> cc.Effects:
        def coordinates() -> gate.FrozenSource:
            return self._act("read_frozen_coordinates", FROZEN)  # type: ignore[return-value]

        def replica_status() -> list[dict[str, str]]:
            self.calls.append("read_replica_status")
            result = self.results.get("read_replica_status")
            if isinstance(result, Exception):
                raise result
            return self.replica_rows()

        return cc.Effects(
            export_done=self._probe("export_done"),
            media_copy_verified=self._probe("media_copy_verified"),
            edge_repoint_approved=self._probe("edge_repoint_approved"),
            gate_control_case_refused=self._probe("gate_control_case_refused"),
            freeze=self._action("freeze"),
            read_frozen_coordinates=coordinates,
            read_replica_status=replica_status,
            promote_replica=self._action("promote_replica"),
            tables_match=self._probe("tables_match"),
            start_new_ghost=self._action("start_new_ghost"),
            new_ghost_ready=self._probe("new_ghost_ready"),
            stop_new_ghost=self._action("stop_new_ghost"),
            repoint_edge=self._action("repoint_edge"),
            set_old_drain_flag=self._action("set_old_drain_flag"),
            old_drain_flag_set=self._probe("old_drain_flag_set"),
            stop_old_ghost=self._action("stop_old_ghost"),
            old_ghost_stopped=self._probe("old_ghost_stopped"),
            release_freeze=self._action("release_freeze"),
            clock=self.clock,
            sleep=self.sleep,
        )

    def run(self, limits: cc.Limits = LIMITS) -> cc.Report:
        return cc.run_cutover(self.effects(), limits)


def last_step(report: cc.Report) -> cc.StepRecord:
    return report.steps[-1]


class CleanRunTests(unittest.TestCase):
    def test_a_clean_run_calls_every_effect_once_in_order(self) -> None:
        world = World()
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.COMPLETED, report.reason)
        self.assertEqual(world.calls, CLEAN_CALLS)

    def test_the_recorded_steps_are_the_declared_steps_in_order(self) -> None:
        report = World().run()
        self.assertEqual([step.name for step in report.steps], list(cc.STEPS))
        self.assertTrue(all(step.status == cc.OK for step in report.steps))

    def test_the_old_ghost_stops_before_the_freeze_is_released(self) -> None:
        world = World()
        world.run()
        self.assertLess(world.calls.index("stop_old_ghost"), world.calls.index("release_freeze"))
        self.assertLess(world.calls.index("repoint_edge"), world.calls.index("set_old_drain_flag"))
        self.assertLess(world.calls.index("old_drain_flag_set"), world.calls.index("stop_old_ghost"))

    def test_the_freeze_window_and_the_lock_time_are_measured(self) -> None:
        world = World()
        world.advance = {"promote_replica": 3.0, "start_new_ghost": 2.0, "repoint_edge": 5.0, "stop_old_ghost": 4.0}
        report = world.run()
        self.assertEqual(report.freeze_seconds, 10.0)
        self.assertEqual(report.lock_held_seconds, 14.0)
        self.assertTrue(report.freeze_released)

    def test_the_gate_may_wait_and_then_promote(self) -> None:
        world = World()
        readings = [[replica_row(position="4000")], [replica_row(position="4500")], [replica_row()]]
        world.replica_rows = lambda: readings.pop(0)
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.COMPLETED, report.reason)
        self.assertEqual(world.calls.count("read_replica_status"), 3)


class PreconditionRefusalTests(unittest.TestCase):
    """A precondition that is false or unreadable refuses before the freeze."""

    def assert_refused_before_freeze(self, world: World, report: cc.Report, step: str) -> None:
        self.assertEqual(report.outcome, cc.Outcome.REFUSED)
        self.assertEqual(last_step(report).name, step)
        self.assertNotIn(last_step(report).status, (cc.OK,))
        for effect in ("release_freeze", "promote_replica", "start_new_ghost", "repoint_edge"):
            self.assertNotIn(effect, world.calls)
        if step != "freeze":
            self.assertNotIn("freeze", world.calls)
        self.assertFalse(report.freeze_released)

    def test_each_false_precondition_refuses(self) -> None:
        for name, step in (
            ("export_done", "export_done"),
            ("media_copy_verified", "media_copy_verified"),
            ("edge_repoint_approved", "edge_repoint_approved"),
            ("gate_control_case_refused", "gate_control_case"),
        ):
            with self.subTest(precondition=name):
                world = World()
                world.results[name] = False
                report = world.run()
                self.assert_refused_before_freeze(world, report, step)
                self.assertEqual(last_step(report).status, cc.REFUSED)
                self.assertEqual(world.calls[-1], name)

    def test_each_unreadable_precondition_refuses(self) -> None:
        for name, step in (
            ("export_done", "export_done"),
            ("media_copy_verified", "media_copy_verified"),
            ("edge_repoint_approved", "edge_repoint_approved"),
            ("gate_control_case_refused", "gate_control_case"),
        ):
            with self.subTest(precondition=name):
                world = World()
                world.results[name] = OSError("no answer")
                report = world.run()
                self.assert_refused_before_freeze(world, report, step)
                self.assertEqual(last_step(report).status, cc.FAILED)

    def test_a_probe_must_answer_true_not_merely_truthy(self) -> None:
        world = World()
        world.results["export_done"] = "yes"
        report = world.run()
        self.assert_refused_before_freeze(world, report, "export_done")

    def test_unusable_limits_refuse_before_any_effect(self) -> None:
        nan, inf = float("nan"), float("inf")
        for limits in (
            cc.Limits(nan, 1.0, 60.0),
            cc.Limits(10.0, 0.0, 60.0),
            cc.Limits(10.0, 1.0, inf),
            cc.Limits(10.0, 1.0, -5.0),
            cc.Limits(cc.MAX_FREEZE_LIMIT_SECONDS + 1, 1.0, 60.0),
            cc.Limits(10.0, 1.0, cc.MAX_FREEZE_LIMIT_SECONDS + 1),
        ):
            with self.subTest(limits=limits):
                world = World()
                report = world.run(limits)
                self.assertEqual(report.outcome, cc.Outcome.REFUSED)
                self.assertEqual(world.calls, [])
                self.assertEqual(last_step(report).name, "limits")

    def test_a_failed_freeze_refuses_and_releases_nothing(self) -> None:
        world = World()
        world.results["freeze"] = TimeoutError("lock wait")
        report = world.run()
        self.assert_refused_before_freeze(world, report, "freeze")
        self.assertEqual(last_step(report).status, cc.FAILED)


class GateRefusalTests(unittest.TestCase):
    """Anything but PROMOTE unlocks and stops. Nothing is promoted or started."""

    def assert_abandoned_at_the_gate(self, world: World, report: cc.Report) -> None:
        self.assertEqual(report.outcome, cc.Outcome.ABANDONED, report.reason)
        self.assertIn("gate", [step.name for step in report.steps if step.status == cc.REFUSED])
        self.assertEqual(world.calls[-1], "release_freeze")
        for effect in ("promote_replica", "start_new_ghost", "stop_new_ghost", "repoint_edge", "stop_old_ghost"):
            self.assertNotIn(effect, world.calls)
        self.assertTrue(report.freeze_released)

    def test_a_replica_that_stays_behind_abandons_at_the_timeout(self) -> None:
        world = World()
        world.replica_rows = lambda: [replica_row(position="4000")]
        self.assert_abandoned_at_the_gate(world, world.run())

    def test_a_replica_past_the_frozen_coordinates_abandons(self) -> None:
        world = World()
        world.replica_rows = lambda: [replica_row(position="5200")]
        self.assert_abandoned_at_the_gate(world, world.run())

    def test_a_disconnected_replica_abandons_though_it_reports_no_lag(self) -> None:
        world = World()
        world.replica_rows = lambda: [replica_row(Replica_IO_Running="Connecting", Seconds_Behind_Source="0")]
        self.assert_abandoned_at_the_gate(world, world.run())

    def test_a_stopped_sql_thread_abandons(self) -> None:
        world = World()
        world.replica_rows = lambda: [replica_row(Replica_SQL_Running="No")]
        self.assert_abandoned_at_the_gate(world, world.run())

    def test_a_replica_status_that_cannot_be_read_abandons(self) -> None:
        world = World()
        world.results["read_replica_status"] = RuntimeError("client died")
        self.assert_abandoned_at_the_gate(world, world.run())

    def test_unreadable_frozen_coordinates_abandon_and_release(self) -> None:
        world = World()
        world.results["read_frozen_coordinates"] = RuntimeError("log_status unreadable")
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.ABANDONED)
        self.assertEqual(world.calls[-1], "release_freeze")
        self.assertNotIn("read_replica_status", world.calls)


class PostGateAbandonTests(unittest.TestCase):
    """Between promotion and the re-point the old estate still serves: roll back."""

    def test_a_table_mismatch_abandons_before_any_ghost_starts(self) -> None:
        world = World()
        world.results["tables_match"] = False
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.ABANDONED)
        self.assertEqual(world.calls[-2:], ["tables_match", "release_freeze"])
        self.assertNotIn("start_new_ghost", world.calls)
        self.assertNotIn("repoint_edge", world.calls)

    def test_a_new_ghost_that_is_not_ready_is_stopped_then_the_freeze_released(self) -> None:
        world = World()
        world.results["new_ghost_ready"] = False
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.ABANDONED)
        self.assertEqual(world.calls[-3:], ["new_ghost_ready", "stop_new_ghost", "release_freeze"])
        self.assertNotIn("repoint_edge", world.calls)

    def test_a_new_ghost_that_fails_to_start_is_still_stopped(self) -> None:
        world = World()
        world.results["start_new_ghost"] = RuntimeError("compose failed")
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.ABANDONED)
        self.assertEqual(world.calls[-2:], ["stop_new_ghost", "release_freeze"])

    def test_a_freeze_over_the_threshold_abandons_before_the_re_point(self) -> None:
        world = World()
        world.advance = {"start_new_ghost": 61.0}
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.ABANDONED)
        self.assertEqual(world.calls[-3:], ["new_ghost_ready", "stop_new_ghost", "release_freeze"])
        self.assertNotIn("repoint_edge", world.calls)
        refused = [step for step in report.steps if step.status == cc.REFUSED]
        self.assertEqual([step.name for step in refused], ["measure_freeze"])

    def test_a_freeze_exactly_at_the_threshold_may_proceed(self) -> None:
        world = World()
        world.advance = {"start_new_ghost": 60.0}
        self.assertEqual(world.run().outcome, cc.Outcome.COMPLETED)

    def test_a_rollback_that_cannot_release_the_freeze_halts(self) -> None:
        world = World()
        world.results["tables_match"] = False
        world.results["release_freeze"] = RuntimeError("session gone")
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.HALTED)
        self.assertFalse(report.freeze_released)

    def test_a_rollback_that_cannot_stop_the_new_ghost_still_releases_then_halts(self) -> None:
        world = World()
        world.results["new_ghost_ready"] = False
        world.results["stop_new_ghost"] = RuntimeError("container busy")
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.HALTED)
        self.assertEqual(world.calls[-1], "release_freeze")
        self.assertTrue(report.freeze_released)


class PostRepointHaltTests(unittest.TestCase):
    """After the re-point a stop never releases db1: the stop-then-release order holds."""

    def assert_halted_with_freeze_held(self, world: World, report: cc.Report) -> None:
        self.assertEqual(report.outcome, cc.Outcome.HALTED, report.reason)
        self.assertNotIn("release_freeze", world.calls)
        self.assertNotIn("stop_new_ghost", world.calls)
        self.assertFalse(report.freeze_released)
        self.assertIn("freeze deliberately held", report.reason)

    def test_a_failed_re_point_halts_without_releasing(self) -> None:
        world = World()
        world.results["repoint_edge"] = RuntimeError("edge apply failed")
        report = world.run()
        self.assert_halted_with_freeze_held(world, report)
        self.assertNotIn("stop_old_ghost", world.calls)

    def test_an_unconfirmed_drain_flag_never_stops_the_old_ghost(self) -> None:
        world = World()
        world.results["old_drain_flag_set"] = False
        report = world.run()
        self.assert_halted_with_freeze_held(world, report)
        self.assertNotIn("stop_old_ghost", world.calls)
        self.assertEqual(last_step(report).name, "drain_flag_confirmed")
        self.assertEqual(last_step(report).status, cc.REFUSED)

    def test_a_drain_flag_that_cannot_be_set_never_stops_the_old_ghost(self) -> None:
        world = World()
        world.results["set_old_drain_flag"] = PermissionError("flag dir")
        report = world.run()
        self.assert_halted_with_freeze_held(world, report)
        self.assertNotIn("stop_old_ghost", world.calls)

    def test_an_old_ghost_not_confirmed_stopped_never_releases(self) -> None:
        world = World()
        world.results["old_ghost_stopped"] = False
        report = world.run()
        self.assert_halted_with_freeze_held(world, report)
        self.assertEqual(world.calls[-1], "old_ghost_stopped")

    def test_a_stop_that_raises_never_releases(self) -> None:
        world = World()
        world.results["stop_old_ghost"] = RuntimeError("docker unreachable")
        report = world.run()
        self.assert_halted_with_freeze_held(world, report)

    def test_a_release_that_fails_at_the_end_halts_with_the_freeze_not_released(self) -> None:
        world = World()
        world.results["release_freeze"] = RuntimeError("session gone")
        report = world.run()
        self.assertEqual(report.outcome, cc.Outcome.HALTED)
        self.assertFalse(report.freeze_released)
        self.assertIsNotNone(report.freeze_seconds)


class ContractTests(unittest.TestCase):
    def test_the_declared_steps_have_no_duplicates(self) -> None:
        self.assertEqual(len(cc.STEPS), len(set(cc.STEPS)))

    def test_every_stop_records_the_step_that_stopped_it(self) -> None:
        world = World()
        world.results["export_done"] = False
        report = world.run()
        self.assertEqual([step.name for step in report.steps], ["limits", "export_done"])
        self.assertIn("export", report.reason)


if __name__ == "__main__":
    unittest.main()
