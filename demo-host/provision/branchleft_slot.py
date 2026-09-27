#!/usr/bin/env python3
"""The forced-command wrapper `render_slot_sudoers.py` enumerates.

Installed at `/usr/local/sbin/branchleft-slot`, root-owned and executable,
and invoked only through the sudoers rules that file generates: `broker
ALL=(root) NOPASSWD: /usr/local/sbin/branchleft-slot <invocation>`, one
literal line per enumerated invocation.

**Why this file exists at all, given the sudoers file already enumerates
every legal invocation.** Measured against real `sudo -n`: sudo compares
the *space-joined text*
of the argv it receives against each configured command as a literal
string, not argv element by element. So `sudo branchleft-slot '0 reset'` --
one shell-quoted argument holding a space -- produces the same space-joined
text as the intended two-argument `<slot> reset` invocation and is equally
permitted by the sudoers file, but this process then receives ONE argument
(`"0 reset"`), not two. The sudoers file and this wrapper are the boundary
*together*: sudoers can only ever prove an invocation is on the list once
its arguments are already split into how many the wrapper expects, and
splitting is exactly the step sudo does not do. So `parse_invocation` below
checks argv's own length first and then each element against its own
closed set -- it is never given cause to join or re-split anything, and it
must never gain one: joining argv into a string and matching a pattern
against it is the exact defect this module exists to not have.

What this process does, and only this, per LLD-2 §02: validate that argv is
exactly the enumerated shape, take an exclusive lock on the named slot so
two reconciles cannot interleave, then start or stop the one systemd unit
that shape names -- or for `reset`, stop both of a slot's colour units and
wipe the slot's own state. It never touches the Docker socket (systemctl
is the only privileged primitive it uses -- a docker command is root with
no gradation, which is the exact erosion enumeration exists to avoid), never
accepts a path as an argument, never writes `/etc/branchleft/<slot>-<colour>.env`
(the broker writes that, unprivileged, before ever asking for a start), and
never reads or touches anything outside the one slot its argv names.
"""

from __future__ import annotations

import fcntl
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from typing import Protocol, Sequence, Union

# Mirrors `render_slot_sudoers.SLOT_NAMES` -- duplicated rather than
# imported, because this file is installed alone at
# `/usr/local/sbin/branchleft-slot` and must run with nothing else from this
# repo present on the host. `test_branchleft_slot.py`'s
# `test_slot_names_matches_the_sudoers_generators_table` is the drift guard
# that keeps the two copies equal; a table that draws them apart there fails
# a test here rather than the boundary and the wrapper silently disagreeing
# about what a legal slot is.
SLOT_NAMES: tuple[str, ...] = tuple(str(n) for n in range(7))
COLOURS: tuple[str, ...] = ("a", "b")
VERBS: tuple[str, ...] = ("start", "stop")
RESET = "reset"

# Where a slot's own management state lives, and the systemd unit name
# shape LLD-2 §02 names directly ("systemctl start|stop the corresponding
# unit"). The *contents* of that unit -- what it runs to bring one colour of
# one slot's Compose stack up -- belong to the generic `branchleft-compose@`
# template `branchLeft/shared-infra`'s `hetzner/README.md` documents; this
# module only ever names an instance of it, never defines it.
SLOT_DIR = "/opt/branchleft/demo-{slot}"
ETC_DIR = "/etc/branchleft"
LOCK_DIR = "/run/branchleft"
UNIT_TEMPLATE = "branchleft-compose@demo-{slot}-{colour}"


class InvalidInvocation(ValueError):
    """Raised for anything that is not exactly one of the enumerated shapes.

    Every message names what was refused and why, but never re-describes
    the input as anything other than exactly the argv it was -- there is no
    step in this module that would let a message imply a split or a join
    happened, because none ever does.
    """


@dataclass(frozen=True)
class ResetInvocation:
    slot: str


@dataclass(frozen=True)
class ColourInvocation:
    slot: str
    colour: str
    verb: str


Invocation = Union[ResetInvocation, ColourInvocation]


def parse_invocation(argv: Sequence[str]) -> Invocation:
    """The one function that decides whether argv is legal.

    Checks length first, then membership of each element in its own closed
    set -- `argv[i] in ALLOWED_SET`, always. Nothing here calls `.split()`,
    `.join()`, `" ".join()` or any string formatting on argv itself before
    comparing it; the only formatting in this module happens *after*
    validation, when building the unit name or path from an already-checked
    slot/colour. That absence is the property under test: a caller that
    reduces argv to a string at any point before this function returns
    reproduces sudo's own defect on the second layer, in the one place that
    exists to not have it.
    """
    if len(argv) == 2:
        slot, verb = argv
        if slot in SLOT_NAMES and verb == RESET:
            return ResetInvocation(slot=slot)
        raise InvalidInvocation(
            f"refused: {list(argv)!r} is not the exact two-argument reset form "
            f"(<enumerated slot> {RESET!r})"
        )
    if len(argv) == 3:
        slot, colour, verb = argv
        if slot in SLOT_NAMES and colour in COLOURS and verb in VERBS:
            return ColourInvocation(slot=slot, colour=colour, verb=verb)
        raise InvalidInvocation(
            f"refused: {list(argv)!r} is not an enumerated colour invocation "
            f"(<enumerated slot> {{{'|'.join(COLOURS)}}} {{{'|'.join(VERBS)}}})"
        )
    raise InvalidInvocation(
        f"refused: expected exactly 2 or 3 arguments, got {len(argv)}: {list(argv)!r} -- "
        "a single argument holding a space is not two arguments, however sudo counted it"
    )


class SlotOps(Protocol):
    def systemctl(self, action: str, unit: str) -> None: ...
    def remove_dir_contents(self, path: str) -> None: ...
    def remove_file_if_present(self, path: str) -> None: ...
    def recreate_empty_dir(self, path: str) -> None: ...


class RealSlotOps:
    """The only implementation this module ships with real effects. Every
    method is a thin, explicit-argv wrapper -- `subprocess.run` is never
    given `shell=True`, so there is no second shell anywhere in this
    process to reintroduce the join/split problem `parse_invocation` exists
    to avoid.
    """

    def systemctl(self, action: str, unit: str) -> None:
        subprocess.run(["systemctl", action, unit], check=True)

    def remove_dir_contents(self, path: str) -> None:
        if not os.path.isdir(path):
            return
        for name in os.listdir(path):
            target = os.path.join(path, name)
            if os.path.islink(target) or os.path.isfile(target):
                os.remove(target)
            else:
                shutil.rmtree(target)

    def remove_file_if_present(self, path: str) -> None:
        try:
            os.remove(path)
        except FileNotFoundError:
            pass

    def recreate_empty_dir(self, path: str) -> None:
        os.makedirs(path, exist_ok=True)


def _lock_path(slot: str) -> str:
    return os.path.join(LOCK_DIR, f"branchleft-slot-{slot}.lock")


def _acquire_slot_lock(slot: str):
    """An exclusive `flock` on a per-slot file, held for the whole of
    `perform` -- LLD-2 §02: "take an exclusive flock on the slot so two
    reconciles cannot interleave." One file per slot rather than one for
    the whole host, so two different slots' invocations never wait on each
    other for no reason.
    """
    os.makedirs(LOCK_DIR, exist_ok=True)
    handle = open(_lock_path(slot), "w")
    fcntl.flock(handle, fcntl.LOCK_EX)
    return handle


def perform(invocation: Invocation, ops: SlotOps) -> None:
    lock = _acquire_slot_lock(invocation.slot)
    try:
        if isinstance(invocation, ColourInvocation):
            unit = UNIT_TEMPLATE.format(slot=invocation.slot, colour=invocation.colour)
            ops.systemctl(invocation.verb, unit)
            return

        # Reset is slot-level: stop both colours regardless of which one (if
        # either) is actually running, because a reset that left one colour
        # up would hand the next lease a live Ghost belonging to the last
        # one (LLD-2 §01b, §02).
        for colour in COLOURS:
            unit = UNIT_TEMPLATE.format(slot=invocation.slot, colour=colour)
            ops.systemctl("stop", unit)

        slot_dir = SLOT_DIR.format(slot=invocation.slot)
        ops.remove_dir_contents(slot_dir)
        for colour in COLOURS:
            ops.remove_file_if_present(
                os.path.join(ETC_DIR, f"demo-{invocation.slot}-{colour}.env")
            )
        ops.recreate_empty_dir(slot_dir)
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)
        lock.close()


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    try:
        invocation = parse_invocation(args)
    except InvalidInvocation as exc:
        print(f"branchleft-slot: {exc}", file=sys.stderr)
        return 1
    try:
        perform(invocation, RealSlotOps())
    except Exception as exc:  # noqa: BLE001 -- this is the process boundary; report and exit non-zero
        print(f"branchleft-slot: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
