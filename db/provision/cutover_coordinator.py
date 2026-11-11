#!/usr/bin/env python3
"""Sequence the blog's estate cutover as one ordered list of steps.

Pure: every touch of the world is an injected effect, so nothing here reaches
a host, a database, a bucket or the edge. A step that cannot proceed stops the
run, and the stop is handled by how far the run got: nothing touched, abandon
and release the freeze, or halt with the freeze held. See cutover_coordinator.md
for the step table, the refusals and what each outcome leaves behind.
"""

from __future__ import annotations

import enum
import time
from dataclasses import dataclass, field
from typing import NamedTuple
from collections.abc import Callable

import promotion_gate as gate

# Every step the coordinator can record, in the only order it runs them.
STEPS = (
    "limits",
    "export_done",
    "media_copy_verified",
    "edge_repoint_approved",
    "gate_control_case",
    "freeze",
    "read_coordinates",
    "gate",
    "promote",
    "tables_match",
    "start_new_ghost",
    "new_ghost_ready",
    "measure_freeze",
    "repoint_edge",
    "set_drain_flag",
    "drain_flag_confirmed",
    "stop_old_ghost",
    "old_ghost_stopped",
    "release_freeze",
)

OK = "ok"
REFUSED = "refused"
FAILED = "failed"

# The write freeze may not be asked to outlast the gate's own wait bound.
MAX_FREEZE_LIMIT_SECONDS = gate.MAX_WAIT_SECONDS


class Outcome(enum.Enum):
    COMPLETED = "completed"
    # Stopped before the freeze: nothing was touched.
    REFUSED = "refused"
    # Stopped after the freeze, before the re-point: rolled back, the old
    # estate still serves and its database was never written after the freeze.
    ABANDONED = "abandoned"
    # Stopped where no automatic rollback is safe: a person decides next.
    HALTED = "halted"


class StepRecord(NamedTuple):
    name: str
    status: str
    detail: str


@dataclass(frozen=True)
class Limits:
    gate_timeout_seconds: float
    gate_poll_seconds: float
    max_freeze_seconds: float


@dataclass(frozen=True)
class Effects:
    """What the cutover does to the world. Each is one real action or one real read.

    A probe returns True only for a positively confirmed state. Any exception
    an effect raises is a failed step, never a pass.
    """

    export_done: Callable[[], bool]
    media_copy_verified: Callable[[], bool]
    edge_repoint_approved: Callable[[], bool]
    gate_control_case_refused: Callable[[], bool]
    freeze: Callable[[], None]
    read_frozen_coordinates: Callable[[], gate.FrozenSource]
    read_replica_status: Callable[[], list[dict[str, str]]]
    promote_replica: Callable[[], None]
    tables_match: Callable[[], bool]
    start_new_ghost: Callable[[], None]
    new_ghost_ready: Callable[[], bool]
    stop_new_ghost: Callable[[], None]
    repoint_edge: Callable[[], None]
    set_old_drain_flag: Callable[[], None]
    old_drain_flag_set: Callable[[], bool]
    stop_old_ghost: Callable[[], None]
    old_ghost_stopped: Callable[[], bool]
    release_freeze: Callable[[], None]
    clock: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep


@dataclass
class Report:
    outcome: Outcome
    reason: str
    steps: list[StepRecord] = field(default_factory=list)
    # Freeze to re-point: the window in which the blog's writes waited.
    freeze_seconds: float | None = None
    # Freeze to release: how long the lock was held in all.
    lock_held_seconds: float | None = None
    freeze_released: bool = False


class _Stop(Exception):
    def __init__(self, step: str, status: str, detail: str) -> None:
        super().__init__(detail)
        self.step = step
        self.status = status
        self.detail = detail


def limits_problem(limits: Limits) -> str | None:
    for name, seconds in (
        ("gate timeout", limits.gate_timeout_seconds),
        ("gate poll interval", limits.gate_poll_seconds),
        ("freeze threshold", limits.max_freeze_seconds),
    ):
        problem = gate.bounded_seconds_problem(seconds)
        if problem is not None:
            return f"{name} is unusable: {problem}"
    return None


def run_cutover(effects: Effects, limits: Limits) -> Report:
    """Run the whole sequence once and say how it ended. Never raises."""
    return _Cutover(effects, limits).run()


class _Cutover:
    def __init__(self, effects: Effects, limits: Limits) -> None:
        self.fx = effects
        self.limits = limits
        self.report = Report(Outcome.REFUSED, "")
        self.froze_at: float | None = None
        self.new_ghost_started = False
        self.repoint_attempted = False

    def run(self) -> Report:
        try:
            self._sequence()
        except _Stop as stop:
            self._record(stop.step, stop.status, stop.detail)
            self._stopped(stop)
        return self.report

    def _record(self, name: str, status: str, detail: str) -> None:
        self.report.steps.append(StepRecord(name, status, detail))

    def _call(self, name: str, call: Callable[[], object]) -> object:
        try:
            return call()
        except Exception as error:  # noqa: BLE001 -- any surprise is a stop, never a pass
            raise _Stop(name, FAILED, f"{name} raised {error!r}") from error

    def _do(self, name: str, action: Callable[[], None], detail: str = "done") -> None:
        self._call(name, action)
        self._record(name, OK, detail)

    def _check(self, name: str, probe: Callable[[], bool], refusal: str) -> None:
        if self._call(name, probe) is not True:
            raise _Stop(name, REFUSED, refusal)
        self._record(name, OK, "confirmed")

    def _elapsed(self) -> float:
        assert self.froze_at is not None
        return self.fx.clock() - self.froze_at

    def _sequence(self) -> None:
        fx = self.fx
        problem = limits_problem(self.limits)
        if problem is not None:
            raise _Stop("limits", REFUSED, problem)
        self._record("limits", OK, "bounded")

        # Preconditions: each refuses before anything is touched.
        self._check("export_done", fx.export_done, "no verified export of the blog is recorded")
        self._check(
            "media_copy_verified",
            fx.media_copy_verified,
            "the media copy is not confirmed complete, so no cutover may point at the new location",
        )
        self._check("edge_repoint_approved", fx.edge_repoint_approved, "the queued edge re-point is not approved")
        self._check(
            "gate_control_case",
            fx.gate_control_case_refused,
            "the gate has not been shown refusing a disconnected replica in this run",
        )

        self._do("freeze", fx.freeze)
        self.froze_at = fx.clock()
        frozen = self._call("read_coordinates", fx.read_frozen_coordinates)
        assert isinstance(frozen, gate.FrozenSource)
        self._record("read_coordinates", OK, f"{frozen.log_file}:{frozen.log_position}")
        self._gate(frozen)

        self._do("promote", fx.promote_replica)
        self._check("tables_match", fx.tables_match, "a blog table's count or checksum differs from frozen db1")
        self.new_ghost_started = True
        self._do("start_new_ghost", fx.start_new_ghost)
        self._check("new_ghost_ready", fx.new_ghost_ready, "the new Ghost did not answer a real query")

        elapsed = self._elapsed()
        if elapsed > self.limits.max_freeze_seconds:
            raise _Stop(
                "measure_freeze",
                REFUSED,
                f"the freeze has lasted {elapsed:.3f}s, over the {self.limits.max_freeze_seconds:g}s threshold",
            )
        self._record("measure_freeze", OK, f"{elapsed:.3f}s within {self.limits.max_freeze_seconds:g}s")

        self.repoint_attempted = True
        self._do("repoint_edge", fx.repoint_edge)
        self.report.freeze_seconds = self._elapsed()

        # The writes now land on the new estate. The old Ghost must be drained
        # and stopped before db1 is released, so a write waiting on it fails.
        self._do("set_drain_flag", fx.set_old_drain_flag)
        self._check("drain_flag_confirmed", fx.old_drain_flag_set, "the old colour's drain flag is not observed set")
        self._do("stop_old_ghost", fx.stop_old_ghost)
        self._check("old_ghost_stopped", fx.old_ghost_stopped, "the old Ghost is not observed stopped")
        self._do("release_freeze", fx.release_freeze)
        self.report.lock_held_seconds = self._elapsed()
        self.report.freeze_released = True
        self.report.outcome = Outcome.COMPLETED
        self.report.reason = "re-pointed, old Ghost stopped, freeze released"

    def _gate(self, frozen: gate.FrozenSource) -> None:
        def read() -> list[dict[str, str]]:
            try:
                return self.fx.read_replica_status()
            except gate.GateInputError:
                raise
            except Exception as error:  # noqa: BLE001 -- any surprise is a stop, never a pass
                raise gate.StatusReadError(repr(error)) from error

        verdict = gate.wait_for_promotion(
            frozen,
            read,
            timeout_seconds=self.limits.gate_timeout_seconds,
            poll_seconds=self.limits.gate_poll_seconds,
            clock=self.fx.clock,
            sleep=self.fx.sleep,
        )
        if verdict.decision != gate.PROMOTE:
            raise _Stop("gate", REFUSED, f"DO NOT PROMOTE: {verdict.reason}")
        self._record("gate", OK, verdict.reason)

    def _stopped(self, stop: _Stop) -> None:
        report = self.report
        if self.froze_at is None:
            report.outcome = Outcome.REFUSED
            report.reason = f"{stop.step}: {stop.detail}"
            return
        if self.repoint_attempted:
            # The edge may already send readers to the new estate and writes to it.
            # Releasing db1 here could break the stop-then-release order.
            report.outcome = Outcome.HALTED
            report.reason = f"{stop.step}: {stop.detail}; freeze deliberately held"
            return
        self._rollback(stop)

    def _rollback(self, stop: _Stop) -> None:
        report = self.report
        clean = True
        if self.new_ghost_started:
            try:
                self.fx.stop_new_ghost()
                self._record("rollback_stop_new_ghost", OK, "new Ghost stopped, never re-pointed")
            except Exception as error:  # noqa: BLE001 -- any surprise is a stop, never a pass
                clean = False
                self._record("rollback_stop_new_ghost", FAILED, repr(error))
        try:
            self.fx.release_freeze()
            report.freeze_released = True
            report.lock_held_seconds = self._elapsed()
            self._record("rollback_release_freeze", OK, "db1 released, nothing was written after the freeze")
        except Exception as error:  # noqa: BLE001 -- any surprise is a stop, never a pass
            clean = False
            self._record("rollback_release_freeze", FAILED, repr(error))
        base = f"{stop.step}: {stop.detail}"
        if clean:
            report.outcome = Outcome.ABANDONED
            report.reason = f"{base}; rolled back, the old estate still serves"
        else:
            report.outcome = Outcome.HALTED
            report.reason = f"{base}; rollback incomplete, see the rollback steps"
