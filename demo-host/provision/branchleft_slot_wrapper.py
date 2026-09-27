"""The demo host's forced-command wrapper -- the one program
`render_slot_sudoers.py`'s generated file names. Installed at
`/usr/local/sbin/branchleft-slot` as a thin shim (`branchleft-slot`, this
directory) that imports this module, because sudoers matches a literal
path and Python cannot import a module whose name carries a hyphen.

**Why this validates independently, even though it imports `SLOT_NAMES`/
`COLOURS` from `render_slot_sudoers.py`.** That module's own docstring
already establishes the property this file exists to hold: sudo compares
the *space-joined text* of the argv it receives against each sudoers
command, not argument boundaries, so a caller who smuggles `"0 reset"` as
one quoted shell argument produces the same text as the intended
two-argument form and is let through by sudoers -- but arrives here as
*one* argv element, not two. This module is the second, structural layer
sudoers cannot be: it refuses anything that is not exactly two or three
distinct argv elements, each matching its own literal shape, regardless of
what the space-joined text looked like to sudo.

**Verbs**, two kinds:
- Privileged (`start`, `stop`) and slot-level (`reset`) -- LLD-2 §02
  describes what they do (systemd start/stop, or stop-both-and-wipe for
  reset); no design for the unit names, the per-slot flock path or reset's
  own side effects has landed in this repository yet, so this module does
  not guess at them. Recognised as legal argument shapes (so the argument
  boundary they carry, above, is still enforced), then refused with a
  plain "not implemented" message rather than silently accepted.
- Read-only (`email-batches`): the one verb this file actually carries
  out. Takes a slot and a colour, never a path or SQL text, and runs
  exactly one fixed, literal query -- a `COUNT` of that slot's
  `email_batches` rows with `status = 'submitting'` -- against the colour
  pair's own SQLite file, printing the bare count to stdout on success.

**What this must never do** (LLD-2 §02, load-bearing): touch the Docker
socket (holding it is root with no gradation); accept a path from a
caller; build a query from anything other than a literal string; or read
anything outside the slot it was named for.
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path
from typing import Sequence

from render_slot_sudoers import COLOURS, READ_VERBS, SLOT_NAMES, START_STOP_VERBS

# The read-only verb this wrapper implements. `READ_VERBS` is a tuple (the
# generator's own shape, open to a future second read-only verb); this
# module carries out exactly the one it knows about today.
EMAIL_BATCHES_VERB = "email-batches"
assert EMAIL_BATCHES_VERB in READ_VERBS

# Docker's own default local-volume-driver layout -- read directly off the
# filesystem, never through the Docker socket or CLI (LLD-2 §02 forbids
# touching either). Assumes the demo host's Docker daemon uses its
# built-in "local" driver with no custom `data-root`; a host build that
# changes either would need to update this constant to match.
DOCKER_VOLUME_ROOT = Path("/var/lib/docker/volumes")

# Mirrors `services/broker/src/config.ts`'s own `BROKER_UID_BASE` default.
# Duplicated rather than imported -- this script has no runtime dependency
# on the broker's TypeScript and never will -- and covered by this
# module's own test asserting the two stay equal.
UID_BASE = 30001

# Exit codes, distinct so a caller (or a human running this by hand) can
# tell "the argument shape was wrong" from "a real verb refused to run"
# from "the one implemented verb tried and failed" without parsing stderr.
EXIT_BAD_INVOCATION = 2
EXIT_NOT_IMPLEMENTED = 3
EXIT_CHECK_FAILED = 4


class InvocationError(ValueError):
    """Raised for any argv that is not exactly one of the enumerated shapes."""


class Invocation:
    """One validated argv. `colour` is `None` only for `reset`."""

    __slots__ = ("slot", "colour", "verb")

    def __init__(self, slot: str, colour: str | None, verb: str) -> None:
        self.slot = slot
        self.colour = colour
        self.verb = verb

    def __repr__(self) -> str:  # pragma: no cover -- debugging aid only
        return f"Invocation(slot={self.slot!r}, colour={self.colour!r}, verb={self.verb!r})"


def parse_invocation(argv: Sequence[str]) -> Invocation:
    """The one place that decides whether an argv is legal at all.

    Exactly two or three arguments, full stop -- an argv of any other
    length is refused before a single element of it is even inspected,
    because that shape alone is what a smuggled sudoers argument (see the
    module doc comment) or a stray extra argument both produce.
    """
    if len(argv) == 2:
        slot, verb = argv
        if verb != "reset":
            raise InvocationError(f"a two-argument invocation must be \"<slot> reset\", got {argv!r}")
        if slot not in SLOT_NAMES:
            raise InvocationError(f"slot {slot!r} is not one of the enumerated slot names")
        return Invocation(slot, None, "reset")

    if len(argv) == 3:
        slot, colour, verb = argv
        if slot not in SLOT_NAMES:
            raise InvocationError(f"slot {slot!r} is not one of the enumerated slot names")
        if colour not in COLOURS:
            raise InvocationError(f"colour {colour!r} is not one of {COLOURS!r}")
        if verb not in (*START_STOP_VERBS, *READ_VERBS):
            raise InvocationError(f"verb {verb!r} is not one of the enumerated verbs")
        return Invocation(slot, colour, verb)

    raise InvocationError(
        f"expected exactly two or three arguments, got {len(argv)}: {list(argv)!r}"
    )


class EmailBatchCheckError(RuntimeError):
    """Raised for anything that stops the count from being trustworthy.
    `main` turns every one of these into a refusal -- never a guessed
    count."""


def _data_directory(slot: str) -> Path:
    """The one, slot-derived path to the colour pair's shared SQLite data
    volume -- never a caller-supplied path. Mirrors `render-core`'s
    `demoDataMount` (`render-core/src/render.ts`): the volume is named
    `ghost-demo-<uid>-data`, and `uid` is `UID_BASE + int(slot)` -- the one
    field `services/broker/src/app.ts`'s `handleReconcile` enforces must
    equal the slot's own allocation before any render happens, so it is
    safe to re-derive here from the slot literal alone.

    Colour-blind on purpose: `render-core/src/compose.ts`'s
    `composeDocument` mounts this same volume into *both* `ghost-a` and
    `ghost-b` -- one shared SQLite file per slot, not one per colour -- so
    a colour argument changes nothing about which file this opens; it is
    accepted only so this verb's own argument shape matches every other
    enumerated invocation's.
    """
    uid = UID_BASE + int(slot)
    return DOCKER_VOLUME_ROOT / f"ghost-demo-{uid}-data" / "_data"


# The one query this file ever runs, a literal string -- `slot` selects
# which SQLite file to open, never anything interpolated into the SQL text
# itself, and nothing here ever builds a query from a caller-supplied
# fragment.
_SUBMITTING_COUNT_QUERY = "SELECT COUNT(*) FROM email_batches WHERE status = 'submitting'"


def count_submitting_email_batches(slot: str) -> int:
    """Opens that slot's one SQLite file read-only and runs the one fixed
    count query against it. Raises `EmailBatchCheckError` for anything
    that would otherwise require guessing -- no data directory, no exactly
    one `*.db` file there, or the query itself failing -- rather than
    return a number that might not mean what it claims to.
    """
    data_dir = _data_directory(slot)
    if not data_dir.is_dir():
        raise EmailBatchCheckError(f'slot "{slot}"\'s data directory does not exist: {data_dir}')

    candidates = sorted(data_dir.glob("*.db"))
    if len(candidates) != 1:
        raise EmailBatchCheckError(
            f'slot "{slot}"\'s data directory has {len(candidates)} "*.db" files '
            f"(expected exactly one): {data_dir}"
        )
    db_path = candidates[0]

    try:
        uri = f"{db_path.resolve().as_uri()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True, timeout=5)
    except (sqlite3.Error, OSError, ValueError) as exc:
        raise EmailBatchCheckError(f"failed to open {db_path} read-only: {exc}") from exc

    try:
        row = connection.execute(_SUBMITTING_COUNT_QUERY).fetchone()
    except sqlite3.Error as exc:
        raise EmailBatchCheckError(
            f"the submitting-count query failed against {db_path}: {exc}"
        ) from exc
    finally:
        connection.close()

    if row is None or len(row) != 1 or not isinstance(row[0], int) or row[0] < 0:
        raise EmailBatchCheckError(f"the submitting-count query returned an unexpected row: {row!r}")
    return row[0]


def main(argv: Sequence[str]) -> int:
    try:
        invocation = parse_invocation(argv)
    except InvocationError as exc:
        print(f"branchleft-slot: {exc}", file=sys.stderr)
        return EXIT_BAD_INVOCATION

    if invocation.verb != EMAIL_BATCHES_VERB:
        print(
            f"branchleft-slot: verb {invocation.verb!r} is enumerated in sudoers but not yet "
            "implemented by this wrapper -- refusing rather than guessing",
            file=sys.stderr,
        )
        return EXIT_NOT_IMPLEMENTED

    try:
        count = count_submitting_email_batches(invocation.slot)
    except EmailBatchCheckError as exc:
        print(f"branchleft-slot: {exc}", file=sys.stderr)
        return EXIT_CHECK_FAILED

    print(count)
    return 0


if __name__ == "__main__":  # pragma: no cover -- exercised via `branchleft-slot`
    raise SystemExit(main(sys.argv[1:]))
