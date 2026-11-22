"""Runs the stages in order and says what happened at each.

The first stage to fail stops the run; every stage after it that could have
run is `not_run`, so a break is red at its own stage and nowhere else. A stage
with nothing built behind it is `pending` and never stops the run.
"""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass

from .report import Outcome, Report, StageResult


class StageFailure(Exception):
    """A check of a stage did not hold. The message says what was expected and what was seen."""


class Checks:
    """Records each check a stage makes, in order, and raises at the first that does not hold."""

    def __init__(self) -> None:
        self.passed: list[str] = []

    def equal(self, label: str, expected: object, actual: object) -> None:
        if expected != actual:
            raise StageFailure(f"{label}: expected {expected!r}, saw {actual!r}")
        self.passed.append(f"{label} ({actual!r})")

    def true(self, label: str, condition: bool, why_not: str = "") -> None:
        if not condition:
            raise StageFailure(f"{label}: did not hold" + (f" ({why_not})" if why_not else ""))
        self.passed.append(label)


@dataclass(frozen=True)
class StageDef[C]:
    """One stage of the path. `run` is None while that part of the path is not built; `missing` then says what is."""

    stage_id: str
    title: str
    run: Callable[[C, Checks], None] | None
    missing: str = ""


def run_stages[C](stages: Sequence[StageDef[C]], context: C, sabotage: str = "") -> Report:
    results: list[StageResult] = []
    stopped = False
    for stage in stages:
        if stage.run is None:
            results.append(StageResult(stage.stage_id, stage.title, Outcome.PENDING, detail=stage.missing))
            continue
        if stopped:
            results.append(
                StageResult(stage.stage_id, stage.title, Outcome.NOT_RUN, detail="an earlier stage failed")
            )
            continue
        checks = Checks()
        try:
            stage.run(context, checks)
        except StageFailure as failure:
            stopped = True
            results.append(
                StageResult(stage.stage_id, stage.title, Outcome.FAILED, tuple(checks.passed), str(failure))
            )
        except Exception as error:  # noqa: BLE001 - any fault in a stage is that stage's red
            stopped = True
            results.append(
                StageResult(
                    stage.stage_id,
                    stage.title,
                    Outcome.FAILED,
                    tuple(checks.passed),
                    f"{type(error).__name__}: {error}",
                )
            )
        else:
            results.append(StageResult(stage.stage_id, stage.title, Outcome.PASSED, tuple(checks.passed)))
    return Report(tuple(results), sabotage)
