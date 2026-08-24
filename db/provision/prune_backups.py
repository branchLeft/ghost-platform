#!/usr/bin/env python3
"""Prunes current dump and binlog objects that have aged out of the backup
retention window -- see db/RUNBOOK-db.md's "Backup retention" section.

Run by branchleft-db-prune.timer via branchleft-db-prune.service,
as root on db1. Reads DB_BACKUP_BUCKET, DB_BACKUP_ENDPOINT, DB_BACKUP_REGION,
AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY from the environment --
/etc/branchleft/db.env via the unit's EnvironmentFile, the same variables
dump_nightly.py and ship_binlogs.py already use. Never touches MySQL: this
script only lists and deletes Object Storage objects.

Object versioning and the 35-day noncurrent lifecycle (configure_backup_bucket.py)
are a separate, already-decided layer against overwrites -- a delete here
still lands as a *version* the bucket keeps for 35 days, this script's own
mistakes included. This script governs only how long an object stays
*current*, which nothing else in the pipeline bounds.

A bucket lifecycle `Expiration` rule was considered and rejected for this
job, even though Hetzner's own lifecycle example documents `Expiration.Days`
as a real feature (doc 14 §16 item 3). The rejection is not that the
mechanism is unavailable -- it is that `Expiration` is blind, per-object, age
-only deletion with no way to ask "does a newer dump already cover what this
one would leave uncovered?" A missed or failed nightly dump (dump_nightly.py
raises before ever uploading, so a failure simply produces no object -- there
is never a partial one to also account for) needs the retained set to extend
further back until a covering dump exists again; a static day count cannot
express that condition, so it cannot hold this module's invariant. See
`plan_prune` for what replaces it.
"""

from __future__ import annotations

import argparse
import datetime
import os
import re
import sys
from typing import NamedTuple

from objectstorage import ObjectStorageError, delete_object, list_objects

# doc 14 §7.2's stated service level: "7-day point-in-time recovery for the
# tenant database". Change this only if that promise changes.
PITR_WINDOW_DAYS = 7

# Slack beyond the promise before an object becomes eligible for deletion at
# all -- covers the pipeline's own operational hiccups (a missed nightly
# dump, a slow investigation), not part of the promise itself. `plan_prune`
# never lets the *retained set* fall below PITR_WINDOW_DAYS of coverage
# regardless of this value; widening or narrowing MARGIN_DAYS only changes
# how much is kept beyond what the promise requires.
MARGIN_DAYS = 3

RETENTION_DAYS = PITR_WINDOW_DAYS + MARGIN_DAYS

_DUMP_KEY_RE = re.compile(r"^dumps/(?P<uuid>[^/]+)/db1-[0-9TZ]+\.sql\.age$")
_BINLOG_KEY_RE = re.compile(r"^binlogs/(?P<uuid>[^/]+)/db1-(?P<log_name>.+)\.age$")
_BINLOG_SEQUENCE_RE = re.compile(r"(\d+)$")


class PruneError(Exception):
    """Listing or deletion did not complete."""


class DumpObject(NamedTuple):
    key: str
    server_uuid: str
    timestamp: datetime.datetime


class BinlogObject(NamedTuple):
    key: str
    server_uuid: str
    log_name: str
    timestamp: datetime.datetime


class Refusal(NamedTuple):
    server_uuid: str
    reason: str


class CoverageRow(NamedTuple):
    server_uuid: str
    oldest_dump: datetime.datetime | None
    oldest_binlog: datetime.datetime | None
    status: str  # "covered", "no dump", "no binlog", "gap"


class PrunePlan(NamedTuple):
    delete_dumps: list[DumpObject]
    delete_binlogs: list[BinlogObject]
    refusals: list[Refusal]


def _parse_timestamp(value: str) -> datetime.datetime:
    """Object Storage reports `LastModified` as ISO 8601 ending in `Z`;
    `fromisoformat` wants an explicit offset instead."""
    value = value.strip()
    if value.endswith("Z"):
        value = value[:-1] + "+00:00"
    return datetime.datetime.fromisoformat(value)


def parse_dump_objects(listing: list[dict[str, str]]) -> list[DumpObject]:
    objects = []
    for entry in listing:
        match = _DUMP_KEY_RE.match(entry["key"])
        if not match:
            continue
        objects.append(
            DumpObject(
                key=entry["key"],
                server_uuid=match.group("uuid"),
                timestamp=_parse_timestamp(entry["last_modified"]),
            )
        )
    return objects


def parse_binlog_objects(listing: list[dict[str, str]]) -> list[BinlogObject]:
    objects = []
    for entry in listing:
        match = _BINLOG_KEY_RE.match(entry["key"])
        if not match:
            continue
        objects.append(
            BinlogObject(
                key=entry["key"],
                server_uuid=match.group("uuid"),
                log_name=match.group("log_name"),
                timestamp=_parse_timestamp(entry["last_modified"]),
            )
        )
    return objects


def _binlog_sequence(log_name: str) -> int:
    match = _BINLOG_SEQUENCE_RE.search(log_name)
    if not match:
        raise PruneError(f"binlog name {log_name!r} carries no numeric sequence")
    return int(match.group(1))


def _group_by_uuid(objects):
    groups: dict[str, list] = {}
    for obj in objects:
        groups.setdefault(obj.server_uuid, []).append(obj)
    return groups


def plan_prune(
    dumps: list[DumpObject],
    binlogs: list[BinlogObject],
    *,
    now: datetime.datetime,
    pitr_window_days: int = PITR_WINDOW_DAYS,
    margin_days: int = MARGIN_DAYS,
) -> PrunePlan:
    """The retention decision over a listing -- no I/O, so every case below
    is a unit test rather than a live-bucket experiment.

    The invariant: at every instant, the oldest *retained* dump plus the
    retained binlogs from its timestamp forward must together cover the
    full `pitr_window_days`-day PITR window, with margin. Evaluated
    independently per `server_uuid` -- a rebuilt db1's previous
    incarnation's objects age out under the exact same rule and need no
    special-casing, since recoverability is only ever promised for the
    current incarnation's data.

    The **anchor** is the newest dump at or before `now - pitr_window_days`:
    the oldest dump the window actually needs, because it plus continuous
    binlogs from its own timestamp forward already covers every point back
    to the window's edge. Everything older than the anchor is surplus.
    **The anchor is never deleted, however old it is** -- a run of missed or
    failed nightly dumps just pushes the anchor further back than
    `RETENTION_DAYS`, and this function keeps it there rather than deleting
    on a blind age threshold that cannot see whether a replacement exists.

    Binlogs are kept back to `min(now - RETENTION_DAYS, anchor.timestamp)`,
    so a stretched anchor extends binlog retention exactly as far as it
    extended dump retention -- the anchor dump is never left with nothing to
    replay forward from. Deletions are only ever the oldest contiguous run
    by binlog **sequence number** (parsed from the log's own filename), not
    by timestamp alone: a binlog file's rotation can straddle the cutoff
    (it was opened before the cutoff and only closed, and so only
    timestamped, after it), so sequence order is the one thing here that
    cannot be skewed by when shipping happened to run.

    A `server_uuid` group that cannot be pruned without the retained set
    falling short of the window is refused outright -- nothing in that
    group is deleted, dumps or binlogs, rather than pruned partway.
    """
    retention_cutoff = now - datetime.timedelta(days=pitr_window_days + margin_days)
    anchor_cutoff = now - datetime.timedelta(days=pitr_window_days)

    dump_groups = _group_by_uuid(dumps)
    binlog_groups = _group_by_uuid(binlogs)

    delete_dumps: list[DumpObject] = []
    delete_binlogs: list[BinlogObject] = []
    refusals: list[Refusal] = []

    for server_uuid in sorted(set(dump_groups) | set(binlog_groups)):
        uuid_dumps = sorted(dump_groups.get(server_uuid, []), key=lambda d: d.timestamp)
        uuid_binlogs = sorted(binlog_groups.get(server_uuid, []), key=lambda b: b.timestamp)

        eligible_anchors = [d for d in uuid_dumps if d.timestamp <= anchor_cutoff]
        if not eligible_anchors:
            # No dump old enough to anchor the window yet: a pipeline
            # younger than the window, or every dump this incarnation has
            # is still within it. Nothing here is surplus; keep it all.
            continue
        anchor = eligible_anchors[-1]

        keep_dump_keys = {d.key for d in uuid_dumps if d.timestamp > retention_cutoff}
        keep_dump_keys.add(anchor.key)
        group_delete_dumps = [d for d in uuid_dumps if d.key not in keep_dump_keys]

        surviving_dumps = [d for d in uuid_dumps if d.key not in {x.key for x in group_delete_dumps}]
        oldest_surviving = min(surviving_dumps, key=lambda d: d.timestamp)
        if oldest_surviving.timestamp > anchor_cutoff:
            # Structurally unreachable given the anchor is always kept
            # above -- this is the invariant's own hard stop, not a hope.
            refusals.append(Refusal(server_uuid, "no retained dump would cover the PITR window boundary"))
            continue

        binlog_keep_cutoff = min(retention_cutoff, anchor.timestamp)
        group_keep_binlogs = [b for b in uuid_binlogs if b.timestamp >= binlog_keep_cutoff]
        group_delete_binlogs = [b for b in uuid_binlogs if b.timestamp < binlog_keep_cutoff]

        if group_delete_binlogs and not group_keep_binlogs:
            # Every shipped binlog for this incarnation is older than the
            # cutoff -- shipping has been broken for the whole margin
            # window. Deleting them all would strand the anchor dump with
            # nothing to replay forward from.
            refusals.append(
                Refusal(server_uuid, "deleting every shipped binlog would leave the anchor dump unreplayable")
            )
            continue

        if group_delete_binlogs:
            try:
                sequences = [_binlog_sequence(b.log_name) for b in uuid_binlogs]
                delete_seq = {_binlog_sequence(b.log_name) for b in group_delete_binlogs}
                keep_seq = {_binlog_sequence(b.log_name) for b in group_keep_binlogs}
            except PruneError as exc:
                # A name `_binlog_sequence` can't parse is this incarnation's
                # problem alone -- letting it propagate out of the function
                # would abandon every other `server_uuid`'s otherwise-safe
                # plan over one bad key in an unrelated incarnation.
                refusals.append(Refusal(server_uuid, f"unparseable binlog name: {exc}"))
                continue
            if sequences != sorted(sequences):
                # Sequence order should always track ship order, and so
                # timestamp order. If it doesn't, a cutoff split by
                # timestamp alone can no longer be trusted not to open a
                # hole in the middle of what's retained.
                refusals.append(Refusal(server_uuid, "binlog sequence numbers are not monotonic with ship time"))
                continue
            if delete_seq and keep_seq and max(delete_seq) >= min(keep_seq):
                # Redundant with the monotonic check above given how the
                # split above is constructed -- kept as its own guard so a
                # future change to the split logic cannot silently
                # reintroduce a gap without also breaking this assertion.
                refusals.append(
                    Refusal(server_uuid, "binlog deletion would not be a clean prefix of the retained sequence")
                )
                continue

        delete_dumps.extend(group_delete_dumps)
        delete_binlogs.extend(group_delete_binlogs)

    return PrunePlan(delete_dumps=delete_dumps, delete_binlogs=delete_binlogs, refusals=refusals)


def build_plan(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    now: datetime.datetime | None = None,
    lister=list_objects,
) -> PrunePlan:
    now = now or datetime.datetime.now(datetime.timezone.utc)
    common = dict(bucket=bucket, endpoint=endpoint, region=region, access_key=access_key, secret_key=secret_key)
    dumps = parse_dump_objects(lister(prefix="dumps/", **common))
    binlogs = parse_binlog_objects(lister(prefix="binlogs/", **common))
    return plan_prune(dumps, binlogs, now=now)


def coverage_report(dumps: list[DumpObject], binlogs: list[BinlogObject]) -> list[CoverageRow]:
    """Per-`server_uuid` (oldest retained dump, oldest retained binlog,
    status), re-derived from a fresh listing rather than trusted from
    `plan_prune`'s own guarantee -- this is the independent check an
    operator runs after a prune to see the bucket's actual state.

    A **bucket-wide** `min()` across every incarnation's objects (an earlier
    version of this check did exactly that) is meaningless: it mixes a live
    incarnation's numbers with a dead, rebuilt one's forever-kept anchor, so
    a live gap can hide behind an old incarnation's reassuringly ancient
    timestamp. Grouping by `server_uuid` is what makes the check mean
    anything.

    `"gap"` (oldest binlog newer than the oldest dump) is the one status
    that means recoverability is actually at risk -- there is no shipped
    binlog old enough to replay from the anchor dump's own timestamp
    forward. `"no dump"` and `"no binlog"` are reported as distinct
    conditions rather than folded into `"gap"` because they read
    differently to an operator: an incarnation with binlogs but no dump has
    nothing to restore *from* at all, and one still inside its first ~15
    minutes legitimately has a dump and no binlog yet.
    """
    dump_groups = _group_by_uuid(dumps)
    binlog_groups = _group_by_uuid(binlogs)
    rows: list[CoverageRow] = []
    for server_uuid in sorted(set(dump_groups) | set(binlog_groups)):
        oldest_dump = min((d.timestamp for d in dump_groups.get(server_uuid, [])), default=None)
        oldest_binlog = min((b.timestamp for b in binlog_groups.get(server_uuid, [])), default=None)
        if oldest_dump is None:
            status = "no dump"
        elif oldest_binlog is None:
            status = "no binlog"
        elif oldest_binlog > oldest_dump:
            status = "gap"
        else:
            status = "covered"
        rows.append(CoverageRow(server_uuid, oldest_dump, oldest_binlog, status))
    return rows


def build_coverage_report(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    lister=list_objects,
) -> list[CoverageRow]:
    common = dict(bucket=bucket, endpoint=endpoint, region=region, access_key=access_key, secret_key=secret_key)
    dumps = parse_dump_objects(lister(prefix="dumps/", **common))
    binlogs = parse_binlog_objects(lister(prefix="binlogs/", **common))
    return coverage_report(dumps, binlogs)


def apply_plan(
    plan: PrunePlan,
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    remover=delete_object,
) -> None:
    for obj in (*plan.delete_dumps, *plan.delete_binlogs):
        remover(bucket=bucket, endpoint=endpoint, region=region, access_key=access_key, secret_key=secret_key, key=obj.key)


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise PruneError(f"{name} must be set (see /etc/branchleft/db.env)")
    return value


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--dry-run", action="store_true", help="Print the plan and any refusals; delete nothing."
    )
    parser.add_argument(
        "--verify-coverage",
        action="store_true",
        help="Report each server_uuid's oldest retained dump/binlog and whether the window is covered; deletes nothing.",
    )
    args = parser.parse_args(argv)

    try:
        bucket = _require_env("DB_BACKUP_BUCKET")
        endpoint = _require_env("DB_BACKUP_ENDPOINT")
        region = _require_env("DB_BACKUP_REGION")
        access_key = _require_env("AWS_ACCESS_KEY_ID")
        secret_key = _require_env("AWS_SECRET_ACCESS_KEY")

        if args.verify_coverage:
            rows = build_coverage_report(
                bucket=bucket, endpoint=endpoint, region=region, access_key=access_key, secret_key=secret_key
            )
        else:
            plan = build_plan(
                bucket=bucket, endpoint=endpoint, region=region, access_key=access_key, secret_key=secret_key
            )
    except (PruneError, ObjectStorageError) as exc:
        print(f"prune_backups: {exc}", file=sys.stderr)
        return 1

    if args.verify_coverage:
        for row in rows:
            print(f"prune_backups: {row.server_uuid} oldest_dump={row.oldest_dump} oldest_binlog={row.oldest_binlog} status={row.status}")
        if any(row.status != "covered" for row in rows):
            print("prune_backups: coverage check FAILED -- see status above", file=sys.stderr)
            return 1
        print("prune_backups: coverage check passed for every server_uuid")
        return 0

    verb = "would delete" if args.dry_run else "deleting"
    print(f"prune_backups: {verb} {len(plan.delete_dumps)} dump(s), {len(plan.delete_binlogs)} binlog(s)")
    for obj in (*plan.delete_dumps, *plan.delete_binlogs):
        print(f"prune_backups: {verb} {obj.key}")
    for refusal in plan.refusals:
        print(f"prune_backups: REFUSED {refusal.server_uuid}: {refusal.reason}", file=sys.stderr)

    if not args.dry_run:
        try:
            apply_plan(plan, bucket=bucket, endpoint=endpoint, region=region, access_key=access_key, secret_key=secret_key)
        except ObjectStorageError as exc:
            print(f"prune_backups: {exc}", file=sys.stderr)
            return 1

    return 1 if plan.refusals else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
