#!/usr/bin/python3 -I
"""The pre-swap scratch-copy gate, part 3. After the green colour has booted on
the restored copy, its own migrations have run on that copy; this reads what
they did from the copy's migration tables, records it, and refuses unless the
migrations finished. It reads the throwaway server alone. See scratch_migrate.md.
"""

from __future__ import annotations

import dataclasses
import pathlib
import sys
from collections.abc import Callable

# `-I` drops the script's own directory from the import path; the siblings this
# imports by name are put back explicitly, from this file's resolved location.
_HERE = str(pathlib.Path(__file__).resolve().parent)
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import restore_drill as rd  # noqa: E402

# Ghost's migration tool keeps one row per applied migration, and one lock row
# that it holds while a migration runs and releases when it finishes.
LOCK_KEY = "km01"
MIGRATIONS_QUERY = (
    "SELECT 'M', `name`, `version` FROM `migrations` ORDER BY `id`; "
    f"SELECT 'L', `lock_key`, `locked` FROM `migrations_lock` WHERE `lock_key` = '{LOCK_KEY}';"
)


class MigrationCheckError(rd.DrillError):
    """The scratch copy's migrations did not finish, or could not be read."""


@dataclasses.dataclass(frozen=True)
class MigrationState:
    """The scratch copy's migration tables at one moment."""

    names: tuple[str, ...]
    newest_version: str | None
    lock_held: bool


@dataclasses.dataclass(frozen=True)
class MigrationOutcome:
    """What the green colour's migrations did to the scratch copy."""

    before_count: int
    after_count: int
    from_version: str | None
    to_version: str | None
    applied: tuple[str, ...]

    def summary(self) -> str:
        return (
            f"migrations: before={self.before_count} after={self.after_count} applied={len(self.applied)} "
            f"from={self.from_version} to={self.to_version}"
        )


def read_state(*, run: rd.Runner, host: str, password: str, database: str) -> MigrationState:
    """Reads the migration tables from the scratch server. A server that cannot
    be reached, tables that are missing, or output that is not what Ghost's
    tables give is an error: nothing could be proven from it."""
    result = run(
        ["mysql", "--host", host, "--user", "root", "--database", database, "-N", "-B", "-e", MIGRATIONS_QUERY],
        env={"MYSQL_PWD": password}, capture_output=True, text=True, check=False,
    )
    if result.returncode != 0:
        raise MigrationCheckError(
            f"the migration tables could not be read: {(result.stderr or '').strip() or 'mysql exited nonzero'}"
        )
    names: list[str] = []
    versions: list[str] = []
    locks: list[str] = []
    for line in (result.stdout or "").splitlines():
        fields = line.split("\t")
        if fields[0] == "M" and len(fields) == 3:
            names.append(fields[1])
            versions.append(fields[2])
        elif fields[0] == "L" and len(fields) == 3:
            locks.append(fields[2])
        else:
            raise MigrationCheckError(f"unexpected output reading the migration tables: {line!r}")
    if not names:
        raise MigrationCheckError("the migration table records no migration, so nothing could be compared")
    if len(locks) != 1 or locks[0] not in ("0", "1"):
        raise MigrationCheckError(f"the migration lock row {LOCK_KEY!r} is missing or unreadable")
    return MigrationState(names=tuple(names), newest_version=versions[-1], lock_held=locks[0] == "1")


def judge(before: MigrationState, after: MigrationState) -> MigrationOutcome:
    """The verdict on one run of the colour's migrations. Raises unless they
    finished: the lock is released and nothing that was applied has gone."""
    if after.lock_held:
        raise MigrationCheckError(
            "the migration lock is still held after the colour came up: its migrations did not finish"
        )
    if len(after.names) < len(before.names) or after.names[: len(before.names)] != before.names:
        raise MigrationCheckError("the applied migrations after the colour's run do not extend those before it")
    return MigrationOutcome(
        before_count=len(before.names),
        after_count=len(after.names),
        from_version=before.newest_version,
        to_version=after.newest_version,
        applied=after.names[len(before.names):],
    )


def wait_for_migrations(
    *, read: Callable[[], MigrationState], before: MigrationState, timeout_s: float, sleep: Callable[[float], None],
    now: Callable[[], float],
) -> MigrationOutcome:
    """Reads until the lock is released or the time is out, then judges. An
    unreadable table is an error at once; only a held lock is waited on."""
    deadline = now() + timeout_s
    while True:
        after = read()
        if not after.lock_held or now() >= deadline:
            return judge(before, after)
        sleep(1.0)
