"""What a run says: one outcome per stage, and the run's verdict read from them.

A stage ends in exactly one of four outcomes. `passed` and `failed` are what a
stage that ran says. `not_run` is a stage that could have run and did not,
because an earlier stage failed: it is never red, so a break is reported at the
stage it is in and at no other. `pending` is a stage whose part of the path is
not built yet: it is named, in the report, in every run, so a green run can
never be mistaken for the whole path.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from enum import StrEnum
from typing import Any


class Outcome(StrEnum):
    PASSED = "passed"
    FAILED = "failed"
    NOT_RUN = "not_run"
    PENDING = "pending"


@dataclass(frozen=True)
class StageResult:
    stage_id: str
    title: str
    outcome: Outcome
    # What was checked and held, in order, for a stage that ran.
    checks: tuple[str, ...] = ()
    # For a failed stage, the check that broke and what was seen; for a
    # pending stage, what is not built yet.
    detail: str = ""


@dataclass(frozen=True)
class Report:
    results: tuple[StageResult, ...]
    # The sabotage this run was made under, or empty for a clean run.
    sabotage: str = ""

    @property
    def failed(self) -> tuple[str, ...]:
        return tuple(r.stage_id for r in self.results if r.outcome is Outcome.FAILED)

    @property
    def green(self) -> bool:
        """No stage that ran went red."""
        return not self.failed

    @property
    def complete(self) -> bool:
        """Every stage of the path ran and passed: nothing pending, nothing skipped."""
        return all(r.outcome is Outcome.PASSED for r in self.results)

    def to_json(self) -> str:
        return json.dumps(
            {
                "sabotage": self.sabotage,
                "green": self.green,
                "complete": self.complete,
                "failed": list(self.failed),
                "stages": [
                    {
                        "id": r.stage_id,
                        "title": r.title,
                        "outcome": r.outcome.value,
                        "checks": list(r.checks),
                        "detail": r.detail,
                    }
                    for r in self.results
                ],
            },
            indent=2,
        )

    @staticmethod
    def from_json(text: str) -> Report:
        data: dict[str, Any] = json.loads(text)
        return Report(
            results=tuple(
                StageResult(
                    stage_id=s["id"],
                    title=s["title"],
                    outcome=Outcome(s["outcome"]),
                    checks=tuple(s["checks"]),
                    detail=s["detail"],
                )
                for s in data["stages"]
            ),
            sabotage=data["sabotage"],
        )

    def to_markdown(self) -> str:
        passed = sum(1 for r in self.results if r.outcome is Outcome.PASSED)
        pending = sum(1 for r in self.results if r.outcome is Outcome.PENDING)
        if not self.green:
            verdict = "RED at " + ", ".join(self.failed)
        elif self.complete:
            verdict = "GREEN, the whole path"
        else:
            verdict = f"GREEN for the slice built so far ({passed} passed, {pending} not built yet)"
        lines = [
            "## Demo path, end to end" + (f" (sabotage: {self.sabotage})" if self.sabotage else ""),
            "",
            f"Verdict: {verdict}",
            "",
            "| Stage | Outcome | Detail |",
            "| --- | --- | --- |",
        ]
        for r in self.results:
            detail = r.detail.replace("|", "/").replace("\n", " ")
            lines.append(f"| {r.stage_id} | {r.outcome.value} | {detail} |")
        return "\n".join(lines) + "\n"
