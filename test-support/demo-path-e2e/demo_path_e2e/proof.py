"""Reads a sabotaged run and says whether the control case held.

It held when the run is red at the sabotaged stage and at no other: every
built stage before it passed, the sabotaged stage failed, and every built stage
after it was not run. A stage that is not built is pending in every run and is
not part of the judgement.
"""

from __future__ import annotations

from collections.abc import Sequence

from .report import Outcome, Report
from .sabotage import Sabotage


def problems_with(report: Report, sabotage: Sabotage, built: Sequence[str]) -> list[str]:
    """What is wrong with this run as a control case; empty when it held."""
    found: list[str] = []
    if report.sabotage != sabotage.name:
        found.append(f"the run was made under {report.sabotage!r}, not {sabotage.name!r}")
    if sabotage.stage_id not in built:
        found.append(f"{sabotage.stage_id} is not a built stage")
        return found
    by_id = {r.stage_id: r for r in report.results}
    position = built.index(sabotage.stage_id)
    for stage_id in built:
        result = by_id.get(stage_id)
        if result is None:
            found.append(f"{stage_id} is missing from the report")
            continue
        index = built.index(stage_id)
        expected = (
            Outcome.PASSED
            if index < position
            else Outcome.FAILED
            if index == position
            else Outcome.NOT_RUN
        )
        if result.outcome is not expected:
            found.append(f"{stage_id}: expected {expected.value}, saw {result.outcome.value}")
    for result in report.results:
        if result.outcome is Outcome.FAILED and result.stage_id != sabotage.stage_id:
            found.append(f"{result.stage_id} went red too")
    return found
