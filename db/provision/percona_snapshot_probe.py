#!/usr/bin/env python3
"""Step 0 for the tenant database host (option (e), Percona Server): whether a
per-tenant `mysqldump --single-transaction --set-gtid-purged=ON`, run by an
account that holds no RELOAD and no LOCK TABLES, gives a GTID set that matches
its snapshot, with no lock any writer can wait behind, so a replica seeded from
the dump and started with SOURCE_AUTO_POSITION=1 misses no committed row and
applies none twice. File and position coordinates are not used: on this server
they run ahead of the snapshot (percona_snapshot_probe.md). It runs on local
throwaway containers of the Percona candidate image (the source and the
replica), and, for two of its red cases, of db1's pinned stock MySQL as the
source. Design, controls and exit codes: db/provision/percona_snapshot_probe.md.
The verdict functions are pure; test_percona_snapshot_probe.py drives them
without Docker. Nothing here reaches a host.
"""

from __future__ import annotations

import argparse
import dataclasses
import os
import pathlib
import re
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence
from typing import NamedTuple

_HERE = pathlib.Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import extract_tenant_binlog  # noqa: E402
import replication_client_probe as rcp  # noqa: E402
import snapshot_probe as sp  # noqa: E402

Verdict = sp.Verdict

TENANTS = ("t1", "t2", "t3")
# Concurrent writers on each tenant. The loss that file and position coordinates
# show is a race between commits, and a single writer per tenant hid it: three
# per tenant lost rows in every round it was tried.
WRITERS_PER_TENANT = 3
# The tenant that carries the long open transaction and the long reader.
LONG_TENANT = "t1"
SLEEP_SECONDS = 60
# During the long round the three tenants are dumped over and over; a gap
# between passes keeps the dumps from being a CPU stress test of the host.
PASS_GAP_SECONDS = 2.0
LATENCY_LIMIT_SECONDS = sp.WRITER_LIMIT_SECONDS
# A writer's first statements pay for a cold connection and a cold table cache.
WARMUP_SAMPLES = 2
DUMP_PASSWORD_FILE = "coord"

SNAPSHOT_STATUS = ("Binlog_snapshot_file", "Binlog_snapshot_position", "Binlog_snapshot_gtid_executed")
# Table locks that stop a writer. SHARED_READ is what a consistent-snapshot
# read holds, and it blocks nothing.
WRITE_BLOCKING_TABLE_LOCKS = frozenset({"SHARED_READ_ONLY", "SHARED_NO_WRITE", "SHARED_NO_READ_WRITE", "EXCLUSIVE"})
EXPECTED_ERRNO_FTWRL = 1227
EXPECTED_ERRNO_LOCK_TABLES = 1044

SABOTAGE_TARGETS = {
    "commit-before-coordinates": (1,),
    "global-lock": (2, 3),
    "gtid-drop-one": (1,),
    "gtid-extra-one": (1,),
}
# The first two red cases run on db1's stock Oracle MySQL. The two GTID cases
# mutate the set the real Percona dump wrote, so they run on Percona.
SABOTAGE_SOURCES = {
    "commit-before-coordinates": "stock",
    "global-lock": "stock",
    "gtid-drop-one": "percona",
    "gtid-extra-one": "percona",
}
# The two that change the GTID set the replica is seeded with by exactly one
# transaction of one tenant: the oracle must see a single transaction.
GTID_MUTATIONS = {"gtid-drop-one": "drop", "gtid-extra-one": "extra"}
SOURCE_KINDS = ("percona", "stock")
# The GTID mode both servers run, passed by prove-percona-snapshot.sh.
GTID_SETTINGS = (("gtid_mode", "ON"), ("enforce_gtid_consistency", "ON"))

# What `mysqldump --source-data=2` writes, in either spelling.
COORDINATES_COMMENT = re.compile(
    r"^--\s*CHANGE (?P<form>MASTER|REPLICATION SOURCE) TO (?:MASTER|SOURCE)_LOG_FILE='(?P<log_file>[^']+)',\s*"
    r"(?:MASTER|SOURCE)_LOG_POS=(?P<position>\d+);\s*$"
)

EXIT_PASSED = sp.EXIT_PASSED
EXIT_RED = sp.EXIT_RED
EXIT_SABOTAGE_NOT_DETECTED = sp.EXIT_SABOTAGE_NOT_DETECTED
EXIT_CANDIDATE_INADEQUATE = sp.EXIT_OPTION_C_UNAVAILABLE
EXIT_FINDING_NOT_RECORDED = sp.EXIT_FINDING_NOT_RECORDED
EXIT_REFUSED = sp.EXIT_REFUSED

Coordinates = tuple[str, int]


# --------------------------------------------------------------------------
# Pure verdicts
# --------------------------------------------------------------------------


def parse_status(lines: Iterable[str]) -> dict[str, str]:
    """`SHOW STATUS` rows (name, tab, value) as a mapping."""
    status: dict[str, str] = {}
    for line in lines:
        name, _, value = line.partition("\t")
        if name:
            status[name] = value
    return status


def variables_verdict(status: Mapping[str, str], settings: Mapping[str, str]) -> Verdict:
    """Control 1, first half. The server must expose the three snapshot
    variables, run the binary-log settings db1's `branchleft.cnf` sets, since
    the per-tenant replay depends on ROW format, and run GTID mode, since the
    replica is seeded by GTID set."""
    missing = [name for name in SNAPSHOT_STATUS if name not in status]
    problems = []
    if missing:
        problems.append(f"the server has no status variable {missing}")
    for name, want in (("log_bin", "1"), ("binlog_format", "ROW"), ("sync_binlog", "1"), *GTID_SETTINGS):
        if settings.get(name) != want:
            problems.append(f"@@{name} is {settings.get(name)!r}, not {want!r}")
    if problems:
        return Verdict(False, "; ".join(problems))
    return Verdict(
        True,
        "Binlog_snapshot_file, _position and _gtid_executed exist; log_bin=1, binlog_format=ROW, sync_binlog=1, "
        "gtid_mode=ON, enforce_gtid_consistency=ON",
    )


def latency_verdict(samples: Mapping[str, Sequence[float]], limit: float, baseline: Mapping[str, float] | None = None) -> Verdict:
    """Control 2. Every tenant's worst statement over the whole run is under
    `limit`; a tenant with no samples is a blind probe. `baseline` is each
    tenant's worst statement before the first dump: when that alone is over
    `limit` the host's own commit latency decides the result, and a failure
    says so. It is still a failure: the limit is not loosened."""
    if not samples:
        return Verdict(False, "no tenant was measured")
    results = {tenant: sp.writer_stall_verdict(latencies, limit) for tenant, latencies in sorted(samples.items())}
    if all(result.passed for result in results.values()):
        return Verdict(True, "; ".join(f"{tenant}: {result.reason}" for tenant, result in results.items()))
    reason = "; ".join(f"{tenant}: {result.reason}" for tenant, result in results.items() if not result.passed)
    noisy = sorted(tenant for tenant, worst in (baseline or {}).items() if worst > limit)
    if noisy:
        reason += (
            f"; before the first dump {noisy} had already exceeded the limit, so this host's own commit latency, "
            "not a dump, may be the cause: only a host whose baseline is under the limit can judge this control"
        )
    return Verdict(False, reason)


def dump_lock_verdict(rows: Iterable[Sequence[str]]) -> Verdict:
    """Control 3. Each row is (object_type, lock_type, lock_status) from
    performance_schema.metadata_locks, owned by the dump accounts' threads.
    A GLOBAL or COMMIT lock is what FLUSH TABLES WITH READ LOCK holds. A TABLE
    lock of a write-blocking type is what LOCK TABLES ... READ holds. The
    shared-read lock every snapshot read holds blocks no writer, and seeing it
    is what shows the sampler was not blind."""
    kinds = sorted({(row[0], row[1], row[2]) for row in rows})
    global_locks = [kind for kind in kinds if kind[0] in ("GLOBAL", "COMMIT")]
    table_locks = [kind for kind in kinds if kind[0] == "TABLE" and kind[1] in WRITE_BLOCKING_TABLE_LOCKS]
    if global_locks or table_locks:
        held = ", ".join("/".join(kind) for kind in global_locks + table_locks)
        return Verdict(False, f"the dump accounts held {held}")
    if not any(kind[0] == "TABLE" and kind[1] == "SHARED_READ" and kind[2] == "GRANTED" for kind in kinds):
        return Verdict(False, "the sampler never saw a dump account hold a shared-read table lock, so it could not have seen a blocking one")
    return Verdict(True, "locks seen: " + ", ".join("/".join(kind) for kind in kinds) + "; no GLOBAL, COMMIT or write-blocking TABLE lock")


def grant_verdict(
    *,
    errno_ftwrl: int,
    errno_lock_tables: int,
    global_privileges: Iterable[str],
    grant_lines: Iterable[str],
    dumps_succeeded: Sequence[bool],
) -> Verdict:
    """Control 4. The dump account cannot take a global read lock (1227) or
    LOCK TABLES (1044), holds no global privilege and no RELOAD or LOCK TABLES
    anywhere in its grants, and its dump succeeded all the same, so the dump
    did not need either."""
    problems = []
    if errno_ftwrl != EXPECTED_ERRNO_FTWRL:
        problems.append(f"FLUSH TABLES WITH READ LOCK gave error {errno_ftwrl}, not {EXPECTED_ERRNO_FTWRL}")
    if errno_lock_tables != EXPECTED_ERRNO_LOCK_TABLES:
        problems.append(f"LOCK TABLES gave error {errno_lock_tables}, not {EXPECTED_ERRNO_LOCK_TABLES}")
    privileges = sorted(set(global_privileges))
    if privileges:
        problems.append(f"global privileges are {privileges}, not none")
    text = "\n".join(grant_lines).upper()
    held = [name for name in ("RELOAD", "LOCK TABLES") if name in text]
    if held:
        problems.append(f"the grants name {held}")
    if not dumps_succeeded:
        problems.append("no dump was taken, so nothing shows the dump needs neither privilege")
    elif not all(dumps_succeeded):
        problems.append(f"{dumps_succeeded.count(False)} of {len(dumps_succeeded)} dumps failed without them")
    if problems:
        return Verdict(False, "; ".join(problems))
    return Verdict(
        True,
        f"error {EXPECTED_ERRNO_FTWRL} on FTWRL, error {EXPECTED_ERRNO_LOCK_TABLES} on LOCK TABLES, no global privilege, "
        f"no RELOAD or LOCK TABLES in the grants, and {len(dumps_succeeded)} dumps succeeded",
    )


def binlog_order(coordinates: Coordinates) -> tuple[int, int]:
    """Orders (file, position) pairs: by the file's numeric suffix, then position."""
    match = re.search(r"(\d+)$", coordinates[0])
    return (int(match.group(1)) if match else -1, coordinates[1])


def snapshot_coordinate_verdict(
    *,
    opened: Coordinates,
    live_before: Coordinates,
    inside_after: Coordinates,
    live_after: Coordinates,
    log_status_after: Coordinates,
    rows_before: int,
    rows_inside: int,
) -> Verdict:
    """Control 5, deterministic. With nothing else writing: a snapshot is
    opened, a commit is forced, and the snapshot's coordinates are read again.
    `opened` and `inside_after` are Binlog_snapshot_file/position; `live_*` are
    the live binary-log position; `log_status_after` is performance_schema.
    log_status read inside the same transaction. The snapshot's coordinates
    must be the position when it opened and stay put; the live position and
    log_status must move with the commit; the snapshot must not see the row."""
    problems = []
    if opened[0] == "" or opened[1] == 0:
        problems.append("the snapshot recorded no coordinates")
    if opened != live_before:
        problems.append(f"the snapshot opened at {opened[0]}:{opened[1]} but the live position was {live_before[0]}:{live_before[1]}")
    if inside_after != opened:
        problems.append(f"the snapshot's coordinates moved from {opened[0]}:{opened[1]} to {inside_after[0]}:{inside_after[1]} after a commit")
    if binlog_order(live_after) <= binlog_order(opened):
        problems.append(f"the live position did not advance past {opened[0]}:{opened[1]}: the forced commit was not seen")
    if log_status_after != live_after:
        problems.append(f"log_status read {log_status_after[0]}:{log_status_after[1]}, not the live {live_after[0]}:{live_after[1]}")
    if rows_inside != rows_before:
        problems.append(f"the snapshot saw {rows_inside} rows after the commit, not {rows_before}")
    if problems:
        return Verdict(False, "; ".join(problems))
    return Verdict(
        True,
        f"snapshot coordinates stayed {opened[0]}:{opened[1]} while the live position and log_status moved to "
        f"{live_after[0]}:{live_after[1]}, and the snapshot kept its {rows_before} rows",
    )


@dataclasses.dataclass(frozen=True)
class CommentFinding:
    """Control 6, recorded rather than gated."""

    form: str | None
    coordinates: Coordinates | None
    parsed_by_extractor: bool

    @property
    def text(self) -> str:
        if self.form is None:
            return "the dump has no coordinates comment"
        return (
            f"the dump's comment is `-- CHANGE {self.form} TO ...` at {self.coordinates[0]}:{self.coordinates[1]}; "
            f"extract_tenant_binlog.SOURCE_DATA_PATTERN {'parses it' if self.parsed_by_extractor else 'does NOT parse it'}"
        )


def comment_finding(dump_text: str) -> CommentFinding:
    """The first coordinates comment in a dump, in whichever spelling, and
    whether extract_tenant_binlog's own pattern reads it."""
    for line in dump_text.splitlines():
        match = COORDINATES_COMMENT.match(line)
        if match:
            return CommentFinding(
                form=match.group("form"),
                coordinates=(match.group("log_file"), int(match.group("position"))),
                parsed_by_extractor=extract_tenant_binlog.SOURCE_DATA_PATTERN.match(line) is not None,
            )
    return CommentFinding(None, None, False)


def comment_verdict(finding: CommentFinding) -> Verdict:
    """Control 6 is recorded, not gated: it fails only when nothing could be
    read, which is a dump with no coordinates at all."""
    return Verdict(finding.form is not None, finding.text)


# --------------------------------------------------------------------------
# GTID sets, and the oracle that judges a snapshot against the set it is
# seeded with
# --------------------------------------------------------------------------

_UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
_GTID_PART = rf"{_UUID}(?::\d+(?:-\d+)?)+"
GTID_SET_TEXT = re.compile(rf"(?:{_GTID_PART}(?:,{_GTID_PART})*)?")
# `SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '<set>';`, what the dump writes
# under --set-gtid-purged=ON, which the replica's load applies.
GTID_PURGED_LINE = re.compile(r"GTID_PURGED=(?:/\*!\d+ '\+'\*/ )?'([^']*)'")
GTID_NEXT_LINE = re.compile(rf"^SET @@SESSION\.GTID_NEXT= '({_UUID}):(\d+)'")
POSTS_INSERT_LINE = re.compile(r"^### INSERT INTO `(\w+)`\.`posts`\s*$")
SLUG_COLUMN_LINE = re.compile(r"^###\s+@3='([^']*)'")
WRITER_SLUG = re.compile(r"w\d+-\d+")
# Examples of a lost or duplicated row a verdict prints.
ORACLE_EXAMPLES = 3

GtidSet = dict[str, list[tuple[int, int]]]


def normalize_gtid_set(text: str) -> str:
    """A GTID set as the server or the dump wrote it, without the line breaks
    (real, or the two characters `\\n` that `mysql -B` prints) and spaces it
    may carry. Raises ValueError for text that is not a GTID set."""
    cleaned = re.sub(r"(?:\\n|\s)+", "", text)
    if not GTID_SET_TEXT.fullmatch(cleaned):
        raise ValueError(f"not a GTID set: {text[:80]!r}")
    return cleaned


def parse_gtid_set(text: str) -> GtidSet:
    """uuid (lower case) -> sorted, merged (first, last) sequence intervals."""
    parsed: GtidSet = {}
    cleaned = normalize_gtid_set(text)
    for part in cleaned.split(",") if cleaned else []:
        uuid, *intervals = part.split(":")
        spans = parsed.setdefault(uuid.lower(), [])
        for interval in intervals:
            first, _, last = interval.partition("-")
            spans.append((int(first), int(last or first)))
    return {uuid: _merge(spans) for uuid, spans in parsed.items()}


def _merge(spans: Iterable[tuple[int, int]]) -> list[tuple[int, int]]:
    merged: list[tuple[int, int]] = []
    for first, last in sorted(spans):
        if merged and first <= merged[-1][1] + 1:
            merged[-1] = (merged[-1][0], max(merged[-1][1], last))
        else:
            merged.append((first, last))
    return merged


def format_gtid_set(parsed: Mapping[str, Sequence[tuple[int, int]]]) -> str:
    return ",".join(
        uuid + "".join(f":{first}-{last}" if last > first else f":{first}" for first, last in spans)
        for uuid, spans in sorted(parsed.items())
        if spans
    )


def gtid_contains(parsed: Mapping[str, Sequence[tuple[int, int]]], uuid: str, seq: int) -> bool:
    return any(first <= seq <= last for first, last in parsed.get(uuid.lower(), ()))


def gtid_without(text: str, uuid: str, seq: int) -> str:
    """The set with the one transaction `uuid:seq` taken out."""
    parsed = parse_gtid_set(text)
    spans: list[tuple[int, int]] = []
    for first, last in parsed.get(uuid.lower(), []):
        if first <= seq <= last:
            spans += [(first, seq - 1)] if seq > first else []
            spans += [(seq + 1, last)] if seq < last else []
        else:
            spans.append((first, last))
    parsed[uuid.lower()] = spans
    return format_gtid_set(parsed)


def gtid_with(text: str, uuid: str, seq: int) -> str:
    """The set with the one transaction `uuid:seq` added."""
    parsed = parse_gtid_set(text)
    parsed[uuid.lower()] = _merge([*parsed.get(uuid.lower(), []), (seq, seq)])
    return format_gtid_set(parsed)


def same_gtid_set(left: str, right: str) -> bool:
    return parse_gtid_set(left) == parse_gtid_set(right)


def dump_gtid_set(dump_text: str) -> str | None:
    """The GTID set a `--set-gtid-purged=ON` dump says its snapshot holds."""
    match = GTID_PURGED_LINE.search(dump_text)
    return normalize_gtid_set(match.group(1)) if match else None


def replace_dump_gtid_set(dump_text: str, gtid_set: str) -> str:
    """The dump with the GTID set its load seeds the server with replaced."""
    replaced, count = re.subn(r"(GTID_PURGED=(?:/\*!\d+ '\+'\*/ )?')[^']*'", lambda m: f"{m.group(1)}{normalize_gtid_set(gtid_set)}'", dump_text, count=1)
    if count != 1:
        raise ValueError("the dump has no GTID_PURGED line to replace")
    return replaced


def dump_slugs(dump_text: str) -> frozenset[str]:
    """The writers' posts rows (`w<n>-<n>`) a dump holds."""
    return frozenset(re.findall(r"'(w\d+-\d+)'", dump_text))


class Placement(NamedTuple):
    """Where in the source's binary log a posts row was committed."""

    tenant: str
    uuid: str
    seq: int


def binlog_placements(decoded_binlog: str) -> dict[str, Placement]:
    """slug -> the GTID of the transaction that inserted it, from the text
    `mysqlbinlog --base64-output=DECODE-ROWS -v` printed for the source's own
    binary log. An oracle that is not the replica and not the dump."""
    placements: dict[str, Placement] = {}
    gtid: tuple[str, int] | None = None
    tenant: str | None = None
    for line in decoded_binlog.splitlines():
        match = GTID_NEXT_LINE.match(line)
        if match:
            gtid, tenant = (match.group(1).lower(), int(match.group(2))), None
            continue
        match = POSTS_INSERT_LINE.match(line)
        if match:
            tenant = match.group(1)
            continue
        if tenant is not None:
            match = SLUG_COLUMN_LINE.match(line)
            if match and gtid is not None:
                placements[match.group(1)] = Placement(tenant, gtid[0], gtid[1])
                tenant = None
            elif line.startswith("### ") and line != "### SET" and not line.startswith("###   @"):
                tenant = None  # another statement began before the slug column
    return placements


@dataclasses.dataclass(frozen=True)
class OracleCount:
    """One or more snapshots judged against the set each was seeded with."""

    snapshots: int = 0
    checked: int = 0
    in_snapshot: int = 0
    after_set: int = 0
    lost: int = 0
    duplicated: int = 0
    unplaced: int = 0
    examples: tuple[str, ...] = ()

    def __add__(self, other: "OracleCount") -> "OracleCount":
        return OracleCount(
            self.snapshots + other.snapshots,
            self.checked + other.checked,
            self.in_snapshot + other.in_snapshot,
            self.after_set + other.after_set,
            self.lost + other.lost,
            self.duplicated + other.duplicated,
            self.unplaced + other.unplaced,
            (self.examples + other.examples)[:ORACLE_EXAMPLES],
        )


def gtid_oracle(
    *,
    tenant: str,
    rows: frozenset[str],
    gtid_set: str,
    committed: Iterable[str],
    placements: Mapping[str, Placement],
) -> OracleCount:
    """One snapshot against its seeding set. `committed` is every writer row
    on the source when the writers had stopped; `rows` is what the dump holds;
    `gtid_set` is the set the replica was seeded with. A committed row must be
    in the dump or after the set, and exactly one of the two: in the set but
    not the dump is LOST (the replica never gets it), in the dump but not in
    the set is DUPLICATED (the replica applies it a second time)."""
    parsed = parse_gtid_set(gtid_set)
    checked = in_snapshot = after_set = lost = duplicated = unplaced = 0
    examples: list[str] = []
    for slug in sorted(committed):
        placed = placements.get(slug)
        if placed is None:
            unplaced += 1
            if len(examples) < ORACLE_EXAMPLES:
                examples.append(f"UNPLACED {tenant} {slug}: not in the source's binary log")
            continue
        checked += 1
        in_dump = slug in rows
        in_set = gtid_contains(parsed, placed.uuid, placed.seq)
        in_snapshot += in_dump
        after_set += not in_set
        if in_set and not in_dump:
            lost += 1
            if len(examples) < ORACLE_EXAMPLES:
                examples.append(f"LOST {tenant} {slug} ({placed.uuid}:{placed.seq} is in the seeding set, the dump lacks the row)")
        elif in_dump and not in_set:
            duplicated += 1
            if len(examples) < ORACLE_EXAMPLES:
                examples.append(f"DUPLICATED {tenant} {slug} ({placed.uuid}:{placed.seq} is not in the seeding set, the dump holds the row)")
    return OracleCount(1, checked, in_snapshot, after_set, lost, duplicated, unplaced, tuple(examples))


def oracle_verdict(count: OracleCount) -> Verdict:
    """Control 1's oracle. Every committed row is either in the snapshot or
    after the seeding set, none is both and none is neither; every row was
    found in the source's binary log; and both regions were exercised, since an
    oracle that only ever saw one of them proves nothing."""
    problems = []
    if count.snapshots == 0 or count.checked == 0:
        problems.append("no snapshot or no committed row was checked")
    if count.lost:
        problems.append(f"{count.lost} committed rows LOST (in the seeding set, not in the snapshot)")
    if count.duplicated:
        problems.append(f"{count.duplicated} rows DUPLICATED (in the snapshot, not in the seeding set)")
    if count.unplaced:
        problems.append(f"{count.unplaced} committed rows were not found in the source's binary log, so the oracle was blind to them")
    if count.checked and not count.in_snapshot:
        problems.append("no checked row was in a snapshot")
    if count.checked and not count.after_set:
        problems.append("no checked row was after a seeding set, so nothing was replayed")
    if problems:
        return Verdict(False, "; ".join(problems + list(count.examples)))
    return Verdict(
        True,
        f"{count.snapshots} snapshots, {count.checked} committed-row checks ({count.in_snapshot} in a snapshot, "
        f"{count.after_set} after the seeding set): 0 lost, 0 duplicated",
    )


def mutate_gtid_set(
    kind: str, tenant: str, rows: frozenset[str], gtid_set: str, placements: Mapping[str, Placement]
) -> tuple[str, str] | None:
    """The sabotage on the seeding set: exactly one transaction of one tenant.
    `drop`: take out the latest of the tenant's transactions that the set and
    the dump both hold, so the replica applies it a second time. `extra`: add
    the earliest of the tenant's transactions that the set and the dump both
    lack, so the replica never gets it. Returns the new set and what was done,
    or None when the tenant has no such transaction."""
    parsed = parse_gtid_set(gtid_set)
    own = [
        (placed.seq, slug, placed)
        for slug, placed in placements.items()
        if placed.tenant == tenant and WRITER_SLUG.fullmatch(slug)
    ]
    if kind == "drop":
        held = sorted((seq, slug, placed) for seq, slug, placed in own if slug in rows and gtid_contains(parsed, placed.uuid, seq))
        if not held:
            return None
        seq, slug, placed = held[-1]
        return gtid_without(gtid_set, placed.uuid, seq), f"{tenant}: dropped {placed.uuid}:{seq} (row {slug}) from the seeding set"
    if kind == "extra":
        later = sorted((seq, slug, placed) for seq, slug, placed in own if slug not in rows and not gtid_contains(parsed, placed.uuid, seq))
        if not later:
            return None
        seq, slug, placed = later[0]
        return gtid_with(gtid_set, placed.uuid, seq), f"{tenant}: added {placed.uuid}:{seq} (row {slug}) to the seeding set"
    raise ValueError(f"unknown GTID mutation {kind!r}")


def inject_sql(tag: str) -> str:
    """One committed transaction that adds a row to every table of a tenant:
    the commit the sabotage forces between the snapshot and the coordinates."""
    return (
        "START TRANSACTION; "
        f"INSERT INTO users (name, email) VALUES ('{tag}', '{tag}@example.invalid'); "
        f"INSERT INTO posts (title, slug, status, author_id) VALUES ('{tag}', '{tag}', 'draft', 1); "
        f"INSERT INTO tags (name, slug) VALUES ('{tag}', '{tag}'); "
        "INSERT INTO posts_tags (post_id, tag_id) VALUES (1, 1); "
        f"INSERT INTO settings (`key`, value) VALUES ('{tag}', '1'); "
        f"INSERT INTO members (email) VALUES ('{tag}@example.invalid'); "
        f"INSERT INTO newsletters (name) VALUES ('{tag}'); "
        "INSERT INTO members_newsletters (member_id, newsletter_id) VALUES (1, 1); "
        f"INSERT INTO products (name) VALUES ('{tag}'); "
        "INSERT INTO members_products (member_id, product_id) VALUES (1, 1); "
        "INSERT INTO offers (name, product_id) VALUES ('OFFER', 1); "
        f"INSERT INTO integrations (name) VALUES ('{tag}'); "
        "INSERT INTO api_keys (integration_id, secret_hash) VALUES (1, MD5('placeholder')); "
        "INSERT INTO emails (post_id, status) VALUES (1, 'pending'); "
        "COMMIT;"
    )


def exit_code(outcomes: Mapping[int, bool], *, sabotaged: bool) -> int:
    """`outcomes` maps each control run to whether it passed: snapshot_probe's
    convention, controls 1 to 5 gating and 6 recorded."""
    return sp.exit_code(outcomes, sabotaged=sabotaged)


_OK = ("mysql-bin.000003", 1461)
_NEXT = ("mysql-bin.000003", 1700)
_SETTINGS = {"log_bin": "1", "binlog_format": "ROW", "sync_binlog": "1", "gtid_mode": "ON", "enforce_gtid_consistency": "ON"}
_UUID_A = "11111111-2222-3333-4444-555555555555"
_PLACED = {
    "w1-1": Placement("t1", _UUID_A, 5),
    "w1-2": Placement("t1", _UUID_A, 7),
    "w1-3": Placement("t1", _UUID_A, 9),
}


def _oracle(rows: frozenset[str], gtid_set: str, placements: Mapping[str, Placement] = _PLACED) -> Verdict:
    return oracle_verdict(gtid_oracle(tenant="t1", rows=rows, gtid_set=gtid_set, committed=_PLACED, placements=placements))


SELF_TEST_CASES: tuple[tuple[str, bool, Callable[[], Verdict]], ...] = (
    ("variables: stock server has none", False, lambda: variables_verdict({}, _SETTINGS)),
    (
        "variables: statement format",
        False,
        lambda: variables_verdict(dict.fromkeys(SNAPSHOT_STATUS, ""), {**_SETTINGS, "binlog_format": "STATEMENT"}),
    ),
    ("variables: gtid mode off", False, lambda: variables_verdict(dict.fromkeys(SNAPSHOT_STATUS, ""), {**_SETTINGS, "gtid_mode": "OFF"})),
    ("variables: healthy", True, lambda: variables_verdict(dict.fromkeys(SNAPSHOT_STATUS, ""), _SETTINGS)),
    (
        "gtid_oracle: a committed row in the seeding set but not in the snapshot",
        False,
        lambda: _oracle(frozenset({"w1-1"}), f"{_UUID_A}:1-8"),
    ),
    (
        "gtid_oracle: a row in the snapshot but not in the seeding set",
        False,
        lambda: _oracle(frozenset({"w1-1", "w1-2", "w1-3"}), f"{_UUID_A}:1-8"),
    ),
    (
        "gtid_oracle: a committed row the binary log never placed",
        False,
        lambda: _oracle(frozenset({"w1-1"}), f"{_UUID_A}:1-6", {"w1-1": _PLACED["w1-1"]}),
    ),
    ("gtid_oracle: nothing after the set was seen", False, lambda: _oracle(frozenset({"w1-1", "w1-2", "w1-3"}), f"{_UUID_A}:1-10")),
    ("gtid_oracle: healthy", True, lambda: _oracle(frozenset({"w1-1", "w1-2"}), f"{_UUID_A}:1-8")),
    ("gtid_oracle: healthy with a gap in the set", True, lambda: _oracle(frozenset({"w1-1", "w1-3"}), f"{_UUID_A}:1-6:9-9")),
    ("latency: a 10 s stall on one tenant", False, lambda: latency_verdict({"t1": [0.004, 10.1], "t2": [0.004], "t3": [0.005]}, LATENCY_LIMIT_SECONDS)),
    ("latency: a tenant with no samples", False, lambda: latency_verdict({"t1": [0.004], "t2": []}, LATENCY_LIMIT_SECONDS)),
    ("latency: healthy", True, lambda: latency_verdict({"t1": [0.004, 0.031], "t2": [0.005], "t3": [0.006]}, LATENCY_LIMIT_SECONDS)),
    (
        "dump_lock: a GLOBAL and COMMIT lock",
        False,
        lambda: dump_lock_verdict([("TABLE", "SHARED_READ", "GRANTED"), ("GLOBAL", "SHARED", "GRANTED"), ("COMMIT", "SHARED", "GRANTED")]),
    ),
    ("dump_lock: a write-blocking table lock", False, lambda: dump_lock_verdict([("TABLE", "SHARED_READ", "GRANTED"), ("TABLE", "SHARED_NO_WRITE", "GRANTED")])),
    ("dump_lock: blind sampler", False, lambda: dump_lock_verdict([])),
    ("dump_lock: healthy", True, lambda: dump_lock_verdict([("TABLE", "SHARED_READ", "GRANTED"), ("SCHEMA", "INTENTION_EXCLUSIVE", "GRANTED")])),
    (
        "grant: RELOAD held and FTWRL accepted",
        False,
        lambda: grant_verdict(
            errno_ftwrl=0, errno_lock_tables=1044, global_privileges=["RELOAD"], grant_lines=["GRANT RELOAD ON *.* TO `d`@`localhost`"], dumps_succeeded=[True]
        ),
    ),
    (
        "grant: LOCK TABLES granted",
        False,
        lambda: grant_verdict(
            errno_ftwrl=1227,
            errno_lock_tables=0,
            global_privileges=[],
            grant_lines=["GRANT SELECT, LOCK TABLES ON `t1`.* TO `d`@`localhost`"],
            dumps_succeeded=[True],
        ),
    ),
    ("grant: the dump failed without them", False, lambda: grant_verdict(errno_ftwrl=1227, errno_lock_tables=1044, global_privileges=[], grant_lines=[], dumps_succeeded=[True, False])),
    ("grant: no dump taken", False, lambda: grant_verdict(errno_ftwrl=1227, errno_lock_tables=1044, global_privileges=[], grant_lines=[], dumps_succeeded=[])),
    (
        "grant: healthy",
        True,
        lambda: grant_verdict(
            errno_ftwrl=1227,
            errno_lock_tables=1044,
            global_privileges=[],
            grant_lines=["GRANT USAGE ON *.* TO `d`@`localhost`", "GRANT SELECT, SHOW VIEW, TRIGGER ON `t1`.* TO `d`@`localhost`"],
            dumps_succeeded=[True, True, True],
        ),
    ),
    (
        "snapshot_coordinate: coordinates followed the commit",
        False,
        lambda: snapshot_coordinate_verdict(
            opened=_OK, live_before=_OK, inside_after=_NEXT, live_after=_NEXT, log_status_after=_NEXT, rows_before=10, rows_inside=10
        ),
    ),
    (
        "snapshot_coordinate: the snapshot saw the new row",
        False,
        lambda: snapshot_coordinate_verdict(
            opened=_OK, live_before=_OK, inside_after=_OK, live_after=_NEXT, log_status_after=_NEXT, rows_before=10, rows_inside=11
        ),
    ),
    (
        "snapshot_coordinate: no commit was seen",
        False,
        lambda: snapshot_coordinate_verdict(
            opened=_OK, live_before=_OK, inside_after=_OK, live_after=_OK, log_status_after=_OK, rows_before=10, rows_inside=10
        ),
    ),
    (
        "snapshot_coordinate: recorded nothing",
        False,
        lambda: snapshot_coordinate_verdict(
            opened=("", 0), live_before=_OK, inside_after=("", 0), live_after=_NEXT, log_status_after=_NEXT, rows_before=10, rows_inside=10
        ),
    ),
    (
        "snapshot_coordinate: healthy",
        True,
        lambda: snapshot_coordinate_verdict(
            opened=_OK, live_before=_OK, inside_after=_OK, live_after=_NEXT, log_status_after=_NEXT, rows_before=10, rows_inside=10
        ),
    ),
    ("comment: no coordinates in the dump", False, lambda: comment_verdict(comment_finding("-- MySQL dump 10.13\nCREATE TABLE t (id INT);\n"))),
    (
        "comment: healthy",
        True,
        lambda: comment_verdict(comment_finding("-- CHANGE MASTER TO MASTER_LOG_FILE='mysql-bin.000003', MASTER_LOG_POS=1461;\n")),
    ),
)


def self_test() -> list[str]:
    """The labels of the cases whose verdict was not the expected one."""
    return [label for label, expected, case in SELF_TEST_CASES if case().passed != expected]


# --------------------------------------------------------------------------
# Container plumbing
# --------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class RoundSpec:
    long_round: bool
    long_transaction: bool


# The rounds each run does, how a dump is taken, and whether a replica is seeded.
# Default: one long round (a long write transaction and SELECT SLEEP(60) on
# one tenant) then four short ones: a commit race is a window, so one lucky
# pass proves little (replication_client_probe.py makes the same point). The
# sabotages need less.
PLANS: Mapping[str | None, tuple[RoundSpec, ...]] = {
    None: (RoundSpec(True, True),) + (RoundSpec(False, False),) * 4,
    "commit-before-coordinates": (RoundSpec(False, False),),
    "global-lock": (RoundSpec(True, False),),
    "gtid-drop-one": (RoundSpec(False, False),) * 2,
    "gtid-extra-one": (RoundSpec(False, False),) * 2,
}
DUMP_MODES: Mapping[str | None, str] = {
    None: "percona",
    "commit-before-coordinates": "commit-before-coordinates",
    "global-lock": "old-path",
    "gtid-drop-one": "percona",
    "gtid-extra-one": "percona",
}
SEEDING: Mapping[str | None, bool] = {None: True, "commit-before-coordinates": True, "global-lock": False, "gtid-drop-one": True, "gtid-extra-one": True}


@dataclasses.dataclass
class DumpRecord:
    tenant: str
    path: pathlib.Path
    returncode: int
    stderr: str
    finding: CommentFinding
    # The GTID set the replica is seeded with, and whether the dump file
    # carries it (a `--set-gtid-purged=ON` dump does; the stock no-lock
    # sabotage reads it from the live server instead, after the dump).
    gtid_set: str | None
    set_in_dump: bool
    # The writers' posts rows the dump holds.
    rows: frozenset[str]


@dataclasses.dataclass
class Scenario:
    rounds: list[Verdict] = dataclasses.field(default_factory=list)
    lines: list[str] = dataclasses.field(default_factory=list)
    latencies: dict[str, list[float]] = dataclasses.field(default_factory=lambda: {tenant: [] for tenant in TENANTS})
    baseline: dict[str, float] = dataclasses.field(default_factory=lambda: dict.fromkeys(TENANTS, 0.0))
    lock_rows: set[tuple[str, str, str]] = dataclasses.field(default_factory=set)
    lock_samples: int = 0
    lock_table_samples: int = 0
    snapshots: int = 0
    oracle: OracleCount = dataclasses.field(default_factory=OracleCount)


@dataclasses.dataclass
class Run:
    ctx: sp.Ctx
    password: str
    scenario: Scenario | None = None
    failure: Exception | None = None

    @property
    def sabotage(self) -> str | None:
        return self.ctx.sabotage

    @property
    def mode(self) -> str:
        return DUMP_MODES[self.sabotage]

    def account(self, tenant: str) -> str:
        return f"dump_{tenant}"

    def accounts(self) -> list[str]:
        return [self.account(tenant) for tenant in TENANTS]

    def as_dump(self, tenant: str, sql: str) -> subprocess.CompletedProcess:
        return self.ctx.source.run(sql, user=self.account(tenant), password=self.password, check=False)


def seed_run(run: Run) -> None:
    """Three Ghost-shaped tenants, each with a dump account that holds SELECT,
    SHOW VIEW and TRIGGER on its own schema and no global privilege, and the
    replication account the replica connects as."""
    ctx = run.ctx
    sql = "".join(sp.blog_ddl(tenant) for tenant in TENANTS)
    for tenant in TENANTS:
        account = run.account(tenant)
        sql += (
            f"CREATE USER '{account}'@'localhost' IDENTIFIED BY '{run.password}';\n"
            f"GRANT SELECT, SHOW VIEW, TRIGGER ON {tenant}.* TO '{account}'@'localhost';\n"
        )
    sql += (
        f"CREATE USER '{sp.REPLICATION_USER}'@'%' IDENTIFIED BY '{ctx.passwords.repl}' REQUIRE SSL;\n"
        f"GRANT REPLICATION SLAVE ON *.* TO '{sp.REPLICATION_USER}'@'%';\n"
    )
    ctx.source.run(sql)


def grant_old_path(run: Run) -> None:
    """What the retired path needs: `mysqldump --source-data=2` flushes tables,
    takes the global read lock, and reads the position."""
    for account in run.accounts():
        run.ctx.source.run(f"GRANT RELOAD, REPLICATION CLIENT ON *.* TO '{account}'@'localhost';")


def revoke_old_path(run: Run) -> None:
    for account in run.accounts():
        run.ctx.source.run(f"REVOKE RELOAD, REPLICATION CLIENT ON *.* FROM '{account}'@'localhost';", check=False)


def dump_argv(run: Run, tenant: str, *, coordinates: bool = False) -> list[str]:
    """The per-tenant dump, as dump_tenant.py takes it, plus --no-tablespaces
    (the account has no PROCESS). On Percona it writes the snapshot's GTID set
    (--set-gtid-purged=ON) and no file and position: `coordinates` adds
    --source-data=2 for control 6 alone, which only records the comment. The
    stock no-lock case reads the set itself after the dump, and a stock account
    without RELOAD cannot use --source-data. The retired path takes it."""
    old_path = run.mode == "old-path"
    argv = [
        "mysqldump",
        f"--user={run.account(tenant)}",
        "--single-transaction",
        *(["--source-data=2"] if old_path or (coordinates and run.mode == "percona") else []),
        "--routines",
        "--triggers",
        f"--set-gtid-purged={'ON' if run.mode == 'percona' else 'OFF'}",
        "--no-tablespaces",
        "--databases",
        tenant,
    ]
    return argv


def source_gtid_executed(server: sp.Server) -> str:
    """The server's GTID set right now."""
    return normalize_gtid_set(server.query("SELECT @@GLOBAL.gtid_executed;")[0][0])


def dump_tenant(run: Run, tenant: str, name: str, *, coordinates: bool = False) -> DumpRecord:
    """One tenant's dump. Under `commit-before-coordinates` a committed
    transaction is forced into every table of the tenant after the dump
    finishes, and only then is the server's GTID set read as the replica's
    start point: the order the design exists to close, with no lock between
    the two."""
    ctx = run.ctx
    process = ctx.source.popen(dump_argv(run, tenant, coordinates=coordinates), run.password, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = process.communicate(timeout=300)
    path = ctx.workdir / name
    path.write_bytes(out)
    text = out.decode(errors="replace")
    stderr = err.decode(errors="replace").strip()[:400]
    try:
        gtid_set = dump_gtid_set(text)
    except ValueError as exc:
        gtid_set, stderr = None, f"{stderr} {exc}".strip()
    set_in_dump = gtid_set is not None
    if run.mode == "commit-before-coordinates" and process.returncode == 0:
        ctx.source.run(inject_sql(f"forced-{tenant}-{time.monotonic_ns()}"), database=tenant)
        gtid_set = source_gtid_executed(ctx.source)
    return DumpRecord(tenant, path, process.returncode, stderr, comment_finding(text), gtid_set, set_in_dump, dump_slugs(text))


def checked_dump(run: Run, tenant: str, name: str) -> DumpRecord:
    record = dump_tenant(run, tenant, name)
    if record.returncode != 0 or (SEEDING[run.sabotage] and not record.gtid_set):
        raise sp.ProofError(f"the dump of {tenant} failed ({record.returncode}) or has no GTID set: {record.stderr}")
    return record


def start_replication_by_gtid(ctx: sp.Ctx) -> None:
    """The replica asks the source for every transaction its own GTID set
    lacks. No file, no position."""
    ctx.replica.run(
        f"CHANGE REPLICATION SOURCE TO SOURCE_HOST='{ctx.source.name}', SOURCE_USER='{sp.REPLICATION_USER}', "
        f"SOURCE_PASSWORD='{ctx.passwords.repl}', SOURCE_AUTO_POSITION=1, SOURCE_SSL=1, SOURCE_CONNECT_RETRY=2; START REPLICA;"
    )


def wait_caught_up_gtid(replica: sp.Server, target: str, timeout: float = 240) -> str | None:
    """None once the replica has executed every transaction in `target`, else
    the reason it did not (an applier or connection error, or a timeout)."""
    target = normalize_gtid_set(target)
    deadline = time.monotonic() + timeout
    status: dict[str, str] = {}
    while time.monotonic() < deadline:
        status = sp.replica_status(replica)
        if status.get("Last_SQL_Errno", "0") not in ("0", ""):
            return f"replica SQL thread stopped: error {status['Last_SQL_Errno']}: {status.get('Last_SQL_Error', '')[:200]}"
        if status.get("Last_IO_Errno", "0") not in ("0", ""):
            return f"replica IO thread stopped: error {status['Last_IO_Errno']}: {status.get('Last_IO_Error', '')[:200]}"
        if replica.query(f"SELECT GTID_SUBSET('{target}', @@GLOBAL.gtid_executed);")[0][0] == "1":
            return None
        time.sleep(0.5)
    return f"replica did not execute GTID set {target} in {timeout:.0f}s (it has {status.get('Executed_Gtid_Set', '')[:120]})"


def reseed(run: Run, record: DumpRecord) -> int:
    """Seeds the replica with one tenant: its dump, then replication by GTID
    set (SOURCE_AUTO_POSITION=1), filtered to that tenant. The replica's own
    GTID state is cleared first, so the dump's set is the whole of it. Returns
    the rows of emails the dump alone held."""
    ctx = run.ctx
    for statement in ("STOP REPLICA", "RESET REPLICA ALL", f"DROP DATABASE IF EXISTS {record.tenant}", "RESET MASTER"):
        ctx.replica.run(statement, check=False)
    ctx.replica.load_file(record.path)
    if not record.set_in_dump:
        ctx.replica.run(f"SET @@GLOBAL.GTID_PURGED='{normalize_gtid_set(record.gtid_set or '')}';")
    seeded = normalize_gtid_set(ctx.replica.query("SELECT @@GLOBAL.gtid_purged;")[0][0])
    if not same_gtid_set(seeded, record.gtid_set or ""):
        raise sp.ProofError(f"{record.tenant}: the replica was seeded with GTID set {seeded}, not the {record.gtid_set} the oracle judged")
    in_dump = int(ctx.replica.query(f"SELECT COUNT(*) FROM {record.tenant}.emails;")[0][0])
    ctx.replica.run(f"CHANGE REPLICATION FILTER REPLICATE_WILD_DO_TABLE = ('{record.tenant}.%');")
    start_replication_by_gtid(ctx)
    return in_dump


def read_placements(run: Run) -> dict[str, Placement]:
    """Every posts row's GTID, read from the source's own binary log through
    the replica's mysqlbinlog (the stock image has none), as the replication
    account. The log is the oracle: not the replica, and not the dump."""
    ctx = run.ctx
    first = ctx.source.query("SHOW BINARY LOGS;")[0][0]
    result = subprocess.run(
        ctx.replica.exec_argv(
            [
                "mysqlbinlog",
                "--read-from-remote-server",
                f"--host={ctx.source.name}",
                f"--user={sp.REPLICATION_USER}",
                "--ssl-mode=REQUIRED",
                "--base64-output=DECODE-ROWS",
                "-v",
                "--to-last-log",
                first,
            ]
        ),
        env=sp._client_env(ctx.passwords.repl),
        capture_output=True,
        text=True,
        check=False,
        timeout=900,
    )
    if result.returncode != 0:
        said = (result.stderr.strip() or result.stdout.strip())[:200]
        raise sp.ProofError(f"mysqlbinlog exited {result.returncode} reading the source's binary log from {first}: {said}")
    return binlog_placements(result.stdout)


def committed_rows(run: Run) -> dict[str, list[str]]:
    """Each tenant's writer rows on the source, read once the writers stopped."""
    return {
        tenant: [row[0] for row in run.ctx.source.query(f"SELECT slug FROM {tenant}.posts WHERE slug REGEXP '^w[0-9]+-[0-9]+$';")]
        for tenant in TENANTS
    }


def apply_gtid_sabotage(run: Run, records: Mapping[str, DumpRecord], placements: Mapping[str, Placement], scenario: Scenario) -> None:
    """Under `gtid-drop-one` and `gtid-extra-one`: change the set each tenant's
    replica is seeded with by one of that tenant's transactions, in the dump
    file the replica loads and in the record the oracle judges."""
    kind = GTID_MUTATIONS.get(run.sabotage)
    if kind is None:
        return
    for tenant, record in records.items():
        changed = mutate_gtid_set(kind, tenant, record.rows, record.gtid_set or "", placements)
        if changed is None:
            scenario.lines.append(f"  sabotage {run.sabotage}: {tenant} had no transaction to change")
            continue
        new_set, what = changed
        record.path.write_text(replace_dump_gtid_set(record.path.read_text(errors="surrogateescape"), new_set), errors="surrogateescape")
        record.gtid_set = new_set
        scenario.lines.append(f"  sabotage {run.sabotage}: {what}")


def _brief(text: str, limit: int = 200) -> str:
    """A long list of differing tables, cut to its start."""
    return text if len(text) <= limit else text[:limit].rstrip() + " ..."


def seed_and_compare(run: Run, records: Mapping[str, DumpRecord], final: str) -> tuple[Verdict, list[str]]:
    """Each tenant in turn: seed by GTID set, replay to the source's final
    GTID set, compare every table's count and CHECKSUM TABLE, and require that
    the replay applied something the dump did not hold."""
    ctx = run.ctx
    failures: list[str] = []
    lines: list[str] = []
    for tenant in TENANTS:
        record = records[tenant]
        in_dump = reseed(run, record)
        failure = wait_caught_up_gtid(ctx.replica, final)
        source_sums = sp.table_sums(ctx.source, tenant)
        replica_sums = sp.table_sums(ctx.replica, tenant)
        rows_final = int(ctx.replica.query(f"SELECT COUNT(*) FROM {tenant}.emails;")[0][0]) if failure is None else in_dump
        parts = [sp.checksum_verdict(source_sums, replica_sums), rcp.replay_verdict(in_dump, rows_final)]
        reasons = ([failure] if failure is not None else []) + [_brief(part.reason) for part in parts if not part.passed]
        if reasons:
            failures.append(f"{tenant}: " + "; ".join(reasons))
        lines.append(
            f"  {tenant}: seeded with GTID set {_brief(record.gtid_set or '', 80)}, replayed to {_brief(final, 80)}; "
            + ("; ".join(reasons) if reasons else "; ".join(part.reason for part in parts))
        )
    return (Verdict(False, " | ".join(failures)) if failures else Verdict(True, f"all {len(TENANTS)} tenants matched")), lines


def start_long_reader(run: Run, done: threading.Event, errors: list[sp.ProofError]) -> sp.Session:
    """A `SELECT SLEEP` that reads the long tenant's posts for SLEEP_SECONDS."""
    ctx = run.ctx
    reader = ctx.source.session(database=LONG_TENANT)

    def hold() -> None:
        try:
            reader.run(f"SELECT SLEEP({SLEEP_SECONDS}) FROM posts LIMIT 1;")
        except sp.ProofError as exc:
            errors.append(exc)
        finally:
            done.set()

    threading.Thread(target=hold, daemon=True).start()
    for _ in range(100):
        if ctx.source.query(f"SELECT COUNT(*) FROM performance_schema.processlist WHERE INFO LIKE 'SELECT SLEEP({SLEEP_SECONDS})%';")[0][0] != "0":
            return reader
        time.sleep(0.1)
    raise sp.ProofError("the long reader never started")


def finish_writers(writers: Mapping[str, Sequence[sp.Writer]]) -> dict[str, list[list[tuple[float, float]]]]:
    """Stops every writer, each tenant's samples as one list per writer. Every
    writer is stopped even when one died; the first death is then raised."""
    samples: dict[str, list[list[tuple[float, float]]]] = {tenant: [] for tenant in writers}
    first: sp.ProofError | None = None
    for tenant, group in writers.items():
        for writer in group:
            try:
                samples[tenant].append(writer.finish())
            except sp.ProofError as exc:
                first = first or exc
    if first is not None:
        raise first
    return samples


def run_round(run: Run, scenario: Scenario, number: int, spec: RoundSpec) -> None:
    ctx = run.ctx
    writers = {tenant: [sp.Writer(ctx.source, tenant, sp.blog_statement) for _ in range(WRITERS_PER_TENANT)] for tenant in TENANTS}
    holder: sp.Session | None = None
    reader: sp.Session | None = None
    done = threading.Event()
    reader_errors: list[sp.ProofError] = []
    records: dict[str, DumpRecord] = {}
    # Every dump this round takes, not only the last of each tenant: the oracle
    # judges each one against the set it carries.
    round_dumps: list[DumpRecord] = []
    for group in writers.values():
        for writer in group:
            writer.start()
    dumping = time.monotonic()
    passes = 0
    try:
        time.sleep(1.5)
        if spec.long_transaction:
            holder = ctx.source.session(database=LONG_TENANT)
            holder.run("START TRANSACTION; INSERT INTO integrations (name) VALUES ('LONG-TRANSACTION');")
        if spec.long_round:
            reader = start_long_reader(run, done, reader_errors)
        dumping = time.monotonic()
        while True:
            for tenant in TENANTS:
                records[tenant] = checked_dump(run, tenant, f"{tenant}-round{number}.sql")
                round_dumps.append(records[tenant])
            passes += 1
            if not spec.long_round or done.is_set():
                break
            time.sleep(PASS_GAP_SECONDS)
        if spec.long_round:
            done.wait(timeout=SLEEP_SECONDS + 60)
            if reader_errors:
                raise reader_errors[0]
    finally:
        try:
            samples = finish_writers(writers)
        finally:
            if reader is not None:
                reader.close()
    committed = ""
    if holder is not None:
        holder.run("COMMIT;")
        holder.close()
        committed = "; the long transaction committed after the last dump"
    for tenant, per_writer in samples.items():
        for writer_samples in per_writer:
            scenario.latencies[tenant].extend(latency for _, latency in writer_samples[WARMUP_SAMPLES:])
            before = [latency for start, latency in writer_samples[WARMUP_SAMPLES:] if start + latency < dumping]
            scenario.baseline[tenant] = max(scenario.baseline[tenant], max(before, default=0.0))
    scenario.snapshots += passes * len(TENANTS)
    statements = {tenant: sum(len(writer_samples) for writer_samples in per_writer) for tenant, per_writer in samples.items()}
    kind = "short"
    if spec.long_round:
        kind = f"long: SELECT SLEEP({SLEEP_SECONDS}) on {LONG_TENANT}" + (" and an open write transaction" if spec.long_transaction else "")
    scenario.lines.append(
        f"round {number} ({kind}): {passes} pass(es) of {len(TENANTS)} dumps, {WRITERS_PER_TENANT} writers per tenant, "
        f"write transactions per tenant {statements}{committed}"
    )
    if not SEEDING[run.sabotage]:
        return
    final = source_gtid_executed(ctx.source)
    placements = read_placements(run)
    committed_by_tenant = committed_rows(run)
    apply_gtid_sabotage(run, records, placements, scenario)
    replica_verdict, lines = seed_and_compare(run, records, final)
    count = OracleCount()
    for record in round_dumps:
        count += gtid_oracle(
            tenant=record.tenant,
            rows=record.rows,
            gtid_set=record.gtid_set or "",
            committed=committed_by_tenant[record.tenant],
            placements=placements,
        )
    oracle = oracle_verdict(count)
    scenario.oracle += count
    failed = [f"{name}: {part.reason}" for name, part in (("replica", replica_verdict), ("oracle", oracle)) if not part.passed]
    scenario.rounds.append(Verdict(False, " | ".join(failed)) if failed else Verdict(True, f"{replica_verdict.reason}; {oracle.reason}"))
    scenario.lines.extend(lines)
    scenario.lines.append(f"  oracle, {len(round_dumps)} snapshots against the source's binary log: {oracle.reason}")
def get_scenario(run: Run) -> Scenario:
    """The one pass that controls 1, 2 and 3 share: writers on every tenant
    for the whole of it, a lock sampler on the dump accounts, and the rounds."""
    if run.failure is not None:
        raise run.failure
    if run.scenario is not None:
        return run.scenario
    scenario = Scenario()
    # Unpaced on purpose: a global lock is held for milliseconds, and a sampler
    # reading every 20 ms missed it entirely under the global-lock sabotage.
    sampler = sp.LockSampler(run.ctx.source, run.accounts())
    sampler.start()
    try:
        if run.mode == "old-path":
            grant_old_path(run)
        for number, spec in enumerate(PLANS[run.sabotage], 1):
            run_round(run, scenario, number, spec)
    except (sp.ProofError, subprocess.TimeoutExpired) as exc:
        # The controls that share this pass all report it; none reruns it.
        run.failure = exc
        raise
    finally:
        if run.mode == "old-path":
            revoke_old_path(run)
        sampler.finish()
    scenario.lock_rows = sampler.rows
    scenario.lock_samples = sampler.samples
    scenario.lock_table_samples = sampler.table_lock_samples
    run.scenario = scenario
    return scenario


# --------------------------------------------------------------------------
# The six controls
# --------------------------------------------------------------------------


def control_1(run: Run) -> sp.ControlResult:
    """The variables exist, GTID mode is on, and a replica seeded from each
    dump's GTID set matches every table of every tenant. The oracle beside it
    reads the source's own binary log: every committed row is in the snapshot
    or after its set, and exactly one of the two."""
    ctx = run.ctx
    title = "variables and a GTID set consistent with the snapshot"
    status = parse_status(f"{row[0]}\t{row[1]}" for row in ctx.source.query("SHOW STATUS LIKE 'Binlog_snapshot%';"))
    row = ctx.source.query("SELECT @@log_bin, @@binlog_format, @@sync_binlog, @@gtid_mode, @@enforce_gtid_consistency;")[0]
    settings = {"log_bin": row[0], "binlog_format": row[1], "sync_binlog": row[2], "gtid_mode": row[3], "enforce_gtid_consistency": row[4]}
    version = ctx.source.query("SELECT @@version, @@version_comment;")[0]
    numbers = [f"source server: {version[0]} ({version[1]})"]
    variables = variables_verdict(status, settings)
    # Under the stock-source sabotages the source has no such variables by
    # design; what must go red is the replica, not this check.
    if not variables.passed and not run.sabotage:
        return sp.ControlResult(1, title, variables, numbers)
    mutation = GTID_MUTATIONS.get(run.sabotage)
    try:
        scenario = get_scenario(run)
    except (sp.ProofError, subprocess.TimeoutExpired) as exc:
        if mutation is None:
            raise
        # A harness failure is not the oracle seeing the change.
        return sp.ControlResult(1, title, Verdict(True, f"the sabotage run did not complete, so nothing was detected: {type(exc).__name__}: {exc}"), numbers)
    numbers += scenario.lines
    rounds = rcp.rounds_verdict(scenario.rounds)
    if mutation is not None:
        # Red only counts when the oracle itself saw the one changed
        # transaction: a drop shows as a duplicated row, an extra as a lost one.
        seen = scenario.oracle.duplicated if mutation == "drop" else scenario.oracle.lost
        if not seen:
            return sp.ControlResult(
                1, title, Verdict(True, f"the oracle did not see the {mutation} of one transaction ({scenario.oracle.lost} lost, {scenario.oracle.duplicated} duplicated)"), numbers
            )
    if run.sabotage:
        verdict = rounds
    elif rounds.passed:
        verdict = Verdict(
            True,
            f"{variables.reason}; all {len(scenario.rounds)} rounds seeded by GTID set and replayed cleanly with {WRITERS_PER_TENANT} writers per tenant; "
            f"oracle over all rounds: {scenario.oracle.snapshots} snapshots, {scenario.oracle.checked} committed-row checks "
            f"({scenario.oracle.in_snapshot} in a snapshot, {scenario.oracle.after_set} after the seeding set), "
            f"{scenario.oracle.lost} lost, {scenario.oracle.duplicated} duplicated",
        )
    else:
        verdict = Verdict(False, f"{variables.reason}; {rounds.reason}")
    return sp.ControlResult(1, title, verdict, numbers)


def control_2(run: Run) -> sp.ControlResult:
    """Every tenant's worst write stays under the limit for the whole run."""
    scenario = get_scenario(run)
    verdict = latency_verdict(scenario.latencies, LATENCY_LIMIT_SECONDS, scenario.baseline)
    numbers = [
        f"{tenant}: {len(latencies)} write transactions timed, worst {sp._ms(max(latencies, default=0.0))}, "
        f"worst before the first dump {sp._ms(scenario.baseline[tenant])}"
        for tenant, latencies in scenario.latencies.items()
    ]
    return sp.ControlResult(2, "no tenant's writes stall", verdict, numbers)


def control_3(run: Run) -> sp.ControlResult:
    """No GLOBAL or COMMIT lock and no write-blocking table lock is held by a
    dump account, sampled across the whole run."""
    scenario = get_scenario(run)
    verdict = dump_lock_verdict(scenario.lock_rows)
    numbers = [
        f"{scenario.lock_samples} samples of metadata_locks over {scenario.snapshots} dumps; "
        f"{scenario.lock_table_samples} saw a granted table lock",
        "lock kinds seen (object/lock/status): " + ", ".join("/".join(kind) for kind in sorted(scenario.lock_rows)),
    ]
    return sp.ControlResult(3, "no global or write-blocking lock held", verdict, numbers)


def control_4(run: Run) -> sp.ControlResult:
    """The dump account holds neither RELOAD nor LOCK TABLES and the dump of
    every tenant succeeds without them."""
    ftwrl = run.as_dump(LONG_TENANT, "FLUSH TABLES WITH READ LOCK; UNLOCK TABLES;")
    lock_tables = run.as_dump(LONG_TENANT, f"LOCK TABLES {LONG_TENANT}.posts READ; UNLOCK TABLES;")
    grants = [row[0] for row in run.ctx.source.query(f"SHOW GRANTS FOR '{run.account(LONG_TENANT)}'@'localhost';")]
    privileges = sp.parse_global_privileges(grants)
    records = [dump_tenant(run, tenant, f"{tenant}-grant.sql") for tenant in TENANTS]
    verdict = grant_verdict(
        errno_ftwrl=sp.parse_errno(ftwrl.stderr),
        errno_lock_tables=sp.parse_errno(lock_tables.stderr),
        global_privileges=privileges,
        grant_lines=grants,
        dumps_succeeded=[record.returncode == 0 for record in records],
    )
    numbers = [
        f"as {run.account(LONG_TENANT)}: FLUSH TABLES WITH READ LOCK error {sp.parse_errno(ftwrl.stderr)}, LOCK TABLES error {sp.parse_errno(lock_tables.stderr)}",
        f"grants: {grants}",
        "dump exit codes: " + ", ".join(f"{record.tenant} {record.returncode}" for record in records)
        + "".join(f" ({record.tenant}: {record.stderr})" for record in records if record.returncode != 0),
    ]
    return sp.ControlResult(4, "no RELOAD and no LOCK TABLES needed", verdict, numbers)


def read_coordinates(lines: Sequence[str]) -> Coordinates:
    status = parse_status(lines)
    return status["Binlog_snapshot_file"], int(status["Binlog_snapshot_position"])


def control_5(run: Run) -> sp.ControlResult:
    """Deterministic discrimination. With every writer stopped, a consistent
    snapshot is opened, a commit is forced, and the snapshot's coordinates are
    read again, beside the live position and performance_schema.log_status,
    which move with the commit."""
    ctx = run.ctx
    session = ctx.source.session(database=LONG_TENANT)
    try:
        session.run("START TRANSACTION WITH CONSISTENT SNAPSHOT;")
        opened = read_coordinates(session.run("SHOW STATUS LIKE 'Binlog_snapshot%';")[0])
        rows_before = int(session.run("SELECT COUNT(*) FROM posts;")[0][0])
        live_before = sp.read_log_status(ctx.source)
        slug = f"forced-{time.monotonic_ns()}"
        ctx.source.run(f"INSERT INTO {LONG_TENANT}.posts (title, slug, status, author_id) VALUES ('{slug}', '{slug}', 'draft', 1);")
        live_after = sp.read_log_status(ctx.source)
        inside_after = read_coordinates(session.run("SHOW STATUS LIKE 'Binlog_snapshot%';")[0])
        rows_inside = int(session.run("SELECT COUNT(*) FROM posts;")[0][0])
        log_status = session.run("SELECT LOCAL->>'$.binary_log_file', LOCAL->>'$.binary_log_position' FROM performance_schema.log_status;")[0][0]
        file, _, position = log_status.partition("\t")
        log_status_after = (file, int(position))
        session.run("COMMIT;")
    except (sp.ProofError, KeyError, ValueError) as exc:
        return sp.ControlResult(5, "snapshot coordinates are the snapshot's", Verdict(False, f"{type(exc).__name__}: {exc}"), [])
    finally:
        session.close()
    verdict = snapshot_coordinate_verdict(
        opened=opened,
        live_before=live_before,
        inside_after=inside_after,
        live_after=live_after,
        log_status_after=log_status_after,
        rows_before=rows_before,
        rows_inside=rows_inside,
    )
    numbers = [
        f"snapshot opened at Binlog_snapshot {opened[0]}:{opened[1]} (live {live_before[0]}:{live_before[1]})",
        f"after a forced commit: Binlog_snapshot {inside_after[0]}:{inside_after[1]}; live {live_after[0]}:{live_after[1]}; "
        f"performance_schema.log_status {log_status_after[0]}:{log_status_after[1]}; rows seen {rows_before} then {rows_inside}",
    ]
    return sp.ControlResult(5, "snapshot coordinates are the snapshot's", verdict, numbers)


def control_6(run: Run) -> sp.ControlResult:
    """FINDING: the comment form a dump with --source-data=2 emits, and whether
    extract_tenant_binlog.SOURCE_DATA_PATTERN parses it. Recorded for that
    extractor only: the proof never seeds a replica from these coordinates,
    which run ahead of the snapshot on this server (the proof's documentation)."""
    record = dump_tenant(run, LONG_TENANT, "finding.sql", coordinates=True)
    if record.returncode != 0:
        return sp.ControlResult(6, "coordinates comment form (finding)", Verdict(False, f"the dump failed ({record.returncode}): {record.stderr}"), [])
    note = ["file and position are recorded here only; seeding uses the GTID set (control 1), because the coordinates can include a transaction the snapshot cannot see"]
    return sp.ControlResult(6, "coordinates comment form (finding)", comment_verdict(record.finding), note)


CONTROLS: Mapping[int, Callable[[Run], sp.ControlResult]] = {1: control_1, 2: control_2, 3: control_3, 4: control_4, 5: control_5, 6: control_6}


def run_probe(args: argparse.Namespace) -> int:
    reason = sp.refusal([args.source, args.replica], os.environ.get("DOCKER_HOST"), sp.docker_context)
    if reason is not None:
        print(f"REFUSED: {reason}", file=sys.stderr)
        return EXIT_REFUSED
    if args.sabotage is not None and args.sabotage not in SABOTAGE_TARGETS:
        print(f"unknown SABOTAGE {args.sabotage!r}; known: {sorted(SABOTAGE_TARGETS)}", file=sys.stderr)
        return 64
    if args.sabotage is not None and args.source_kind != SABOTAGE_SOURCES[args.sabotage]:
        want = SABOTAGE_SOURCES[args.sabotage]
        print(f"SABOTAGE {args.sabotage} runs on the {want} source (PROOF_SOURCE={want}), not {args.source_kind}", file=sys.stderr)
        return 64
    controls = [int(part) for part in args.controls.split()]
    if args.sabotage:
        controls = [number for number in controls if number in SABOTAGE_TARGETS[args.sabotage]]
        if not controls:
            print(f"SABOTAGE {args.sabotage} targets controls {SABOTAGE_TARGETS[args.sabotage]}; none selected", file=sys.stderr)
            return 64
    workdir = pathlib.Path(args.workdir)
    root = (workdir / "root.pw").read_text().strip()
    ctx = sp.Ctx(
        source=sp.Server(args.source, root),
        replica=sp.Server(args.replica, root),
        workdir=workdir,
        passwords=sp.Passwords.read(workdir),
        sabotage=args.sabotage,
    )
    run = Run(ctx, (workdir / f"{DUMP_PASSWORD_FILE}.pw").read_text().strip())
    seed_run(run)
    outcomes: dict[int, bool] = {}
    for number in controls:
        ctx.say(f"== control {number}" + (f" (sabotage: {args.sabotage})" if args.sabotage else ""))
        try:
            result = CONTROLS[number](run)
        except (sp.ProofError, subprocess.TimeoutExpired) as exc:
            result = sp.ControlResult(number, "did not complete", Verdict(False, f"{type(exc).__name__}: {exc}"), [])
        for line in result.numbers:
            ctx.say(f"  {line}")
        outcomes[number] = result.verdict.passed
        label = "FINDING" if number == 6 else ("PASS" if result.verdict.passed else ("RED" if args.sabotage else "FAIL"))
        ctx.say(f"{label} control {number}, {result.title}: {result.verdict.reason}")
    code = exit_code(outcomes, sabotaged=bool(args.sabotage))
    if code == EXIT_PASSED:
        ctx.say("ALL PASSED" + (f" (controls {args.controls})" if args.controls != "1 2 3 4 5 6" else ""))
    elif code == EXIT_RED:
        ctx.say(f"RED as expected under sabotage {args.sabotage}: the control sees the failure")
    elif code == EXIT_SABOTAGE_NOT_DETECTED:
        ctx.say(f"SABOTAGE NOT DETECTED: a control stayed green under {args.sabotage}")
    elif code == EXIT_CANDIDATE_INADEQUATE:
        ctx.say("CANDIDATE INADEQUATE: a control from 1 to 5 failed with nothing sabotaged. Stop and tell the owner.")
    else:
        ctx.say("the comment-form finding (control 6) could not be recorded")
    return code


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run the verdict functions on canned red and green inputs")
    sub = parser.add_subparsers(dest="command")
    runner = sub.add_parser("run", help="run the controls against two running containers (prove-percona-snapshot.sh does this)")
    runner.add_argument("--source", required=True)
    runner.add_argument("--replica", required=True)
    runner.add_argument("--workdir", required=True)
    runner.add_argument("--source-kind", choices=SOURCE_KINDS, default="percona")
    runner.add_argument("--controls", default="1 2 3 4 5 6")
    runner.add_argument("--sabotage", default=None)
    args = parser.parse_args(argv)
    if args.self_test:
        failed = self_test()
        for label in failed:
            print(f"SELF-TEST FAILED: {label}")
        print(f"self-test: {len(SELF_TEST_CASES) - len(failed)} of {len(SELF_TEST_CASES)} cases behaved")
        return 1 if failed else 0
    if args.command == "run":
        return run_probe(args)
    parser.print_help()
    return 64


if __name__ == "__main__":
    sys.exit(main())
