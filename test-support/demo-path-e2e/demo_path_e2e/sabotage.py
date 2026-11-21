"""The control case: break one stage of the path in the real environment and the run must go red there.

Each sabotage breaks the real thing (the file the broker writes, the edge's own
configuration), never the stage's check, so a pass here shows the check can see
the fault it is there for.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum


class Fault(StrEnum):
    # The slot's passphrase hash belongs to some other passphrase: the issued passphrase never opens it.
    WRONG_HASH = "wrong-hash"
    # The edge's gate is skipped for the admin area: a stranger with no cookie reaches Ghost.
    EXEMPT_GHOST = "exempt-ghost"
    # A recycle that writes the next tenancy's lease and keeps the last tenancy's hash:
    # the previous occupant simply logs in again.
    HASH_NOT_ROTATED = "hash-not-rotated"


@dataclass(frozen=True)
class Sabotage:
    stage_id: str
    fault: Fault
    what: str

    @property
    def name(self) -> str:
        return f"{self.stage_id}:{self.fault.value}"


SABOTAGES: tuple[Sabotage, ...] = (
    Sabotage("gated-read", Fault.WRONG_HASH, "the slot's hash is not the issued passphrase's"),
    Sabotage("gated-read", Fault.EXEMPT_GHOST, "the edge leaves /ghost/* outside the gate"),
    Sabotage("recycle", Fault.HASH_NOT_ROTATED, "a recycle keeps the previous tenancy's hash"),
)


def find(name: str) -> Sabotage:
    for sabotage in SABOTAGES:
        if sabotage.name == name:
            return sabotage
    raise KeyError(f"no sabotage named {name!r}; known: {', '.join(s.name for s in SABOTAGES)}")
