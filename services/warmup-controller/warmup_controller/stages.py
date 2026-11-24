"""The IP2 warm-up stage table, pinned by `test_stages.py` to the collector's own table. See ../README.md."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class DestinationGroup(StrEnum):
    """The receivers with their own cap inside a stage. Same names the collector's state file uses."""

    GMAIL = "gmail"
    MICROSOFT = "microsoft"
    YAHOO = "yahoo"


@dataclass(frozen=True)
class StageCaps:
    stage: int
    total: int
    gmail: int
    microsoft: int
    yahoo: int


STAGES: tuple[StageCaps, ...] = (
    StageCaps(1, 50, 25, 15, 15),
    StageCaps(2, 100, 50, 30, 30),
    StageCaps(3, 200, 100, 60, 60),
    StageCaps(4, 400, 200, 120, 120),
    StageCaps(5, 800, 400, 240, 240),
    StageCaps(6, 1600, 800, 480, 480),
    StageCaps(7, 3200, 1600, 960, 960),
)

FIRST_STAGE = STAGES[0].stage
LAST_STAGE = STAGES[-1].stage


class UnknownStageError(ValueError):
    """A stage outside the table."""


def caps_for(stage: int) -> StageCaps:
    """The caps of a stage.

    Raises:
        UnknownStageError: `stage` is not one of the seven.
    """
    for caps in STAGES:
        if caps.stage == stage:
            return caps
    raise UnknownStageError(stage)
