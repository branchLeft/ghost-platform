"""Control case: break one rule in the real code and the test that guards it must go red; unbroken it must be green.

Run `python3 sabotage.py` from this directory for the table. `test_sabotage.py`
runs the same proof on every CI run.
"""

from __future__ import annotations

import io
import sys
import unittest
from collections.abc import Callable
from dataclasses import dataclass
from unittest import mock

from warmup_controller import rules
from warmup_controller.model import DayEvidence


@dataclass(frozen=True)
class Fault:
    name: str
    # The attribute of `warmup_controller.rules` that is broken, and what replaces it.
    target: str
    replacement: object
    # The tests that must go red while it is broken.
    guards: tuple[str, ...]


def _counts_seed_mail(day: DayEvidence) -> int:
    return day.real_sent + day.seed_sent


def _never_stale(*_args: object) -> tuple[str, ...]:
    return ()


def _unbounded_ceiling(*_args: object) -> int:
    return 10**9


def _always_resume(*_args: object) -> bool:
    return True


def _reads_nothing(*_args: object) -> tuple[object, ...]:
    return ()


def _always_read(*_args: object) -> bool:
    return True


FAULTS: tuple[Fault, ...] = (
    Fault(
        "advances on seed mail",
        "counted_volume",
        _counts_seed_mail,
        (
            "test_decide.NoRealMailTests.test_seed_mail_alone_never_advances",
            "test_decide.NoRealMailTests.test_seed_mail_does_not_count_towards_the_evidence_floor",
            "test_decide.NoRealMailTests.test_seed_mail_does_not_lift_the_cap",
        ),
    ),
    Fault(
        "advances on stale evidence",
        "stale_feeds",
        _never_stale,
        (
            "test_decide.AdvanceGateTests.test_stale_evidence_holds",
            "test_decide.AdvanceGateTests.test_a_missing_feed_holds",
        ),
    ),
    Fault(
        "cap above proven volume",
        "proven_ceiling",
        _unbounded_ceiling,
        ("test_decide.CeilingTests.test_cap_never_above_proven_volume",),
    ),
    Fault(
        "resumes without the card",
        "resume_allowed",
        _always_resume,
        (
            "test_decide.ResumeTests.test_no_resume_without_the_card",
            "test_decide.ResumeTests.test_a_card_for_an_earlier_stop_does_not_resume_a_later_one",
        ),
    ),
    Fault(
        "stop ignores the days since the last run",
        "stop_days",
        _reads_nothing,
        (
            "test_decide.StopTests.test_a_rejection_cluster_on_any_day_since_the_last_run_stops_the_lane",
            "test_decide.StopTests.test_a_blocklisting_that_cleared_before_the_run_still_stops_the_lane",
        ),
    ),
    Fault(
        "marks a day read without its data",
        "day_is_read",
        _always_read,
        ("test_decide.StopTests.test_a_run_on_missing_data_does_not_mark_yesterday_read",),
    ),
    Fault(
        "resumes a cleared blocklist at once",
        "BLOCKLIST_RESUME_HOURS",
        0,
        ("test_decide.ResumeTests.test_a_cleared_blocklist_does_not_resume_before_24_hours",),
    ),
)


@dataclass(frozen=True)
class Proof:
    fault: str
    green_when_whole: bool
    red_when_broken: tuple[str, ...]

    @property
    def proven(self) -> bool:
        return self.green_when_whole and len(self.red_when_broken) > 0


def run_guards(guards: tuple[str, ...]) -> tuple[str, ...]:
    """The names of the guard tests that fail or error."""
    suite = unittest.defaultTestLoader.loadTestsFromNames(list(guards))
    result = unittest.TextTestRunner(stream=io.StringIO(), verbosity=0).run(suite)
    return tuple(case.id() for case, _trace in [*result.failures, *result.errors])


def prove(fault: Fault) -> Proof:
    green = run_guards(fault.guards) == ()
    with mock.patch.object(rules, fault.target, fault.replacement):
        red = run_guards(fault.guards)
    return Proof(fault.name, green, red)


def main(write: Callable[[str], object] = sys.stdout.write) -> int:
    failed = 0
    for fault in FAULTS:
        proof = prove(fault)
        write(f"{fault.name}\n")
        write(f"  whole:  {'green' if proof.green_when_whole else 'RED'}\n")
        write(f"  broken: {'red' if proof.red_when_broken else 'GREEN'}\n")
        for test in proof.red_when_broken:
            write(f"    red: {test}\n")
        failed += 0 if proof.proven else 1
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
