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
wipe the slot's own state. For every slot/colour/reset invocation it never
touches the Docker socket (systemctl is the only privileged primitive it
uses there -- a docker command is root with no gradation, which is the exact
erosion enumeration exists to avoid), never accepts a path as an argument,
never writes `/etc/branchleft/<slot>-<colour>.env` (the broker writes that,
unprivileged, before ever asking for a start), and never reads or touches
anything outside the one slot its argv names.

**The one exception: `load`.** A fourth verb so the broker can hand a
control-plane-pushed image to the local Docker daemon without ever holding
the socket itself. It is a
narrow exception, not a hole in the boundary above, for three reasons taken
together: the argument is not a caller-chosen path but one single literal
string (`IMAGE_LOAD_PATH`, matching `render_slot_sudoers.IMAGE_LOAD_INVOCATION`
exactly) -- anything else is refused by `parse_invocation` before this
process does anything at all; the sudoers grant itself only ever offers
this one process that one literal invocation to begin with; and what this
process does with it does not trust the path's name a second time --
`RealSlotOps.load_image` opens that exact path with `O_NOFOLLOW` (a symlink
at the leaf is refused by the kernel, not followed), `fstat`s the open
descriptor (never a second `stat()` on the path, which would reopen the
TOCTOU window `O_NOFOLLOW` exists to close) to require a regular file owned
by the broker account, and only then streams that already-open descriptor
into `docker load`'s stdin -- so nothing downstream of the open ever
resolves the path again for docker, or anything else, to race.
"""

from __future__ import annotations

import fcntl
import os
import pwd
import shutil
import stat
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

# Mirrors `render_slot_sudoers.BROKER_USER`/`IMAGE_STAGING_DIR`/
# `IMAGE_STAGING_FILENAME` -- duplicated for the same reason `SLOT_NAMES`
# above is: this file runs alone on the host, with nothing else from this
# repo present. `SlotNamesDriftGuardTests` in `test_branchleft_slot.py`
# guards this pair the same way it guards the slot table.
BROKER_USER = "broker"
LOAD = "load"
IMAGE_STAGING_DIR = "/var/lib/branchleft-broker/image-tmp"
IMAGE_STAGING_FILENAME = "image.tar"
IMAGE_LOAD_PATH = f"{IMAGE_STAGING_DIR}/{IMAGE_STAGING_FILENAME}"

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


class RefusedImage(ValueError):
    """Raised by `RealSlotOps.load_image` when the file at `IMAGE_LOAD_PATH`
    fails its root-side verification at the moment this process opens it --
    a distinct failure from `InvalidInvocation`, which is about argv shape
    and never looks at the filesystem. `parse_invocation` accepting `load`
    says only that the *argument* was the one legal literal; this is what
    says the *file* behind it, right now, was not what `load` may load.
    """


@dataclass(frozen=True)
class ResetInvocation:
    slot: str


@dataclass(frozen=True)
class ColourInvocation:
    slot: str
    colour: str
    verb: str


@dataclass(frozen=True)
class LoadInvocation:
    """No fields: unlike every other invocation, `load`'s one legal argument
    is a single unchanging literal (`IMAGE_LOAD_PATH`), not a value that
    varies across calls -- there is nothing here for a field to carry.
    """


Invocation = Union[ResetInvocation, ColourInvocation, LoadInvocation]


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

    `load`'s argument is checked by the same discipline as everything else
    here: membership in a closed set, just one of size one
    (`{IMAGE_LOAD_PATH}`) rather than seven or two. A single shell-quoted
    argument `"load /var/.../image.tar"` -- sudo's own `'0 reset'` defect,
    reproduced for this verb -- has `len(argv) == 1` and falls straight
    through to the final `raise` below, exactly like a bare `"0 reset"`
    does; there is no separate branch for it to slip past.
    """
    if len(argv) == 2:
        first, second = argv
        if first == LOAD:
            if second == IMAGE_LOAD_PATH:
                return LoadInvocation()
            raise InvalidInvocation(
                f"refused: {list(argv)!r} is not the exact two-argument load form "
                f"({LOAD!r} {IMAGE_LOAD_PATH!r})"
            )
        if first in SLOT_NAMES and second == RESET:
            return ResetInvocation(slot=first)
        raise InvalidInvocation(
            f"refused: {list(argv)!r} is not the exact two-argument reset form "
            f"(<enumerated slot> {RESET!r}) or the exact two-argument load form "
            f"({LOAD!r} {IMAGE_LOAD_PATH!r})"
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
    def load_image(self, path: str) -> None: ...


class RealSlotOps:
    """The only implementation this module ships with real effects. Every
    method is a thin, explicit-argv wrapper -- `subprocess.run` is never
    given `shell=True`, so there is no second shell anywhere in this
    process to reintroduce the join/split problem `parse_invocation` exists
    to avoid.
    """

    def systemctl(self, action: str, unit: str) -> None:
        subprocess.run(["systemctl", action, unit], check=True)

    def load_image(self, path: str) -> None:
        """Opens `path` (always `IMAGE_LOAD_PATH` -- `parse_invocation`
        accepts no other value) with `O_NOFOLLOW`, so a symlink planted at
        that exact leaf is refused by the kernel's own open(2) rather than
        followed; `fstat`s the resulting descriptor -- never a second
        `os.stat(path)`, which would re-resolve the name and reopen exactly
        the race `O_NOFOLLOW` closes -- and requires a regular file owned by
        the broker account. Only the verified, already-open descriptor is
        ever handed to `docker load`, on its stdin, so docker itself never
        resolves `path` a second time either.
        """
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as exc:
            raise RefusedImage(f"refused: cannot open {path!r}: {exc}") from exc
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise RefusedImage(f"refused: {path!r} is not a regular file")
            try:
                broker_uid = pwd.getpwnam(BROKER_USER).pw_uid
            except KeyError as exc:
                raise RefusedImage(
                    f"refused: broker account {BROKER_USER!r} does not exist on this host"
                ) from exc
            if info.st_uid != broker_uid:
                raise RefusedImage(
                    f"refused: {path!r} is owned by uid {info.st_uid}, not the "
                    f"{BROKER_USER!r} account (uid {broker_uid})"
                )
            subprocess.run(["docker", "load"], stdin=fd, check=True)
        finally:
            os.close(fd)

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
    if isinstance(invocation, LoadInvocation):
        # Not slot-scoped, so it never takes `_acquire_slot_lock` -- there is
        # no slot name to lock on, and the image being loaded is shared
        # across every slot, not owned by one of them.
        ops.load_image(IMAGE_LOAD_PATH)
        return

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
