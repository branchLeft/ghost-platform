#!/usr/bin/env python3
"""Step 0 for the tenant database host (option (e), Percona Server): whether a
per-tenant `mysqldump --single-transaction --source-data=2`, run by an account
that holds no RELOAD and no LOCK TABLES, gives binary-log coordinates that match
its snapshot, with no lock any writer can wait behind. It runs on local
throwaway containers of the Percona candidate image (the source and the
replica), and, for its two red cases, of db1's pinned stock MySQL as the source.
Design, controls and exit codes: db/provision/percona_snapshot_probe.md. The
verdict functions are pure; test_percona_snapshot_probe.py drives them without
Docker. Nothing here reaches a host.
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

_HERE = pathlib.Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import extract_tenant_binlog  # noqa: E402
import replication_client_probe as rcp  # noqa: E402
import snapshot_probe as sp  # noqa: E402

Verdict = sp.Verdict

TENANTS = ("t1", "t2", "t3")
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
}
# Both red cases run on db1's stock Oracle MySQL; the green run on Percona.
SABOTAGE_SOURCE = "stock"
SOURCE_KINDS = ("percona", "stock")

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
    variables, and run the binary-log settings db1's `branchleft.cnf` sets,
    since the per-tenant replay depends on ROW format."""
    missing = [name for name in SNAPSHOT_STATUS if name not in status]
    problems = []
    if missing:
        problems.append(f"the server has no status variable {missing}")
    for name, want in (("log_bin", "1"), ("binlog_format", "ROW"), ("sync_binlog", "1")):
        if settings.get(name) != want:
            problems.append(f"@@{name} is {settings.get(name)!r}, not {want!r}")
    if problems:
        return Verdict(False, "; ".join(problems))
    return Verdict(True, "Binlog_snapshot_file, _position and _gtid_executed exist; log_bin=1, binlog_format=ROW, sync_binlog=1")


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


def pinned_percona(wrapper_text: str) -> str:
    """The one Percona digest the wrapper pins."""
    pins = set(re.findall(r"percona/percona-server@sha256:[0-9a-f]{64}", wrapper_text))
    if len(pins) != 1:
        raise ValueError(f"expected exactly one Percona digest, found {sorted(pins)}")
    return pins.pop()


_OK = ("mysql-bin.000003", 1461)
_NEXT = ("mysql-bin.000003", 1700)

SELF_TEST_CASES: tuple[tuple[str, bool, Callable[[], Verdict]], ...] = (
    (
        "variables: stock server has none",
        False,
        lambda: variables_verdict({}, {"log_bin": "1", "binlog_format": "ROW", "sync_binlog": "1"}),
    ),
    (
        "variables: statement format",
        False,
        lambda: variables_verdict(dict.fromkeys(SNAPSHOT_STATUS, ""), {"log_bin": "1", "binlog_format": "STATEMENT", "sync_binlog": "1"}),
    ),
    (
        "variables: healthy",
        True,
        lambda: variables_verdict(dict.fromkeys(SNAPSHOT_STATUS, ""), {"log_bin": "1", "binlog_format": "ROW", "sync_binlog": "1"}),
    ),
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
# one tenant) then four short ones: a coordinate race is a window, so one lucky
# pass proves little (replication_client_probe.py makes the same point). The
# sabotages need less.
PLANS: Mapping[str | None, tuple[RoundSpec, ...]] = {
    None: (RoundSpec(True, True),) + (RoundSpec(False, False),) * 4,
    "commit-before-coordinates": (RoundSpec(False, False),),
    "global-lock": (RoundSpec(True, False),),
}
DUMP_MODES: Mapping[str | None, str] = {None: "percona", "commit-before-coordinates": "commit-before-coordinates", "global-lock": "old-path"}
SEEDING: Mapping[str | None, bool] = {None: True, "commit-before-coordinates": True, "global-lock": False}


@dataclasses.dataclass
class DumpRecord:
    tenant: str
    path: pathlib.Path
    returncode: int
    stderr: str
    coordinates: Coordinates | None
    finding: CommentFinding


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


def dump_argv(run: Run, tenant: str) -> list[str]:
    """The per-tenant dump, as dump_tenant.py takes it, plus --no-tablespaces
    (the account has no PROCESS). The stock-no-lock case leaves --source-data
    off: a stock account without RELOAD cannot use it, and the coordinates are
    then read by the sabotage itself."""
    argv = [
        "mysqldump",
        f"--user={run.account(tenant)}",
        "--single-transaction",
        *([] if run.mode == "commit-before-coordinates" else ["--source-data=2"]),
        "--routines",
        "--triggers",
        "--set-gtid-purged=OFF",
        "--no-tablespaces",
        "--databases",
        tenant,
    ]
    return argv


def dump_tenant(run: Run, tenant: str, name: str) -> DumpRecord:
    """One tenant's dump. Under `commit-before-coordinates` a committed
    transaction is forced into every table of the tenant after the dump
    finishes, and only then is log_status read as the coordinates: the order
    the design exists to close, with no lock between the two."""
    ctx = run.ctx
    process = ctx.source.popen(dump_argv(run, tenant), run.password, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out, err = process.communicate(timeout=300)
    path = ctx.workdir / name
    path.write_bytes(out)
    finding = comment_finding(out.decode(errors="replace"))
    coordinates = finding.coordinates
    if run.mode == "commit-before-coordinates" and process.returncode == 0:
        ctx.source.run(inject_sql(f"forced-{tenant}-{time.monotonic_ns()}"), database=tenant)
        coordinates = sp.read_log_status(ctx.source)
    return DumpRecord(tenant, path, process.returncode, err.decode(errors="replace").strip()[:400], coordinates, finding)


def checked_dump(run: Run, tenant: str, name: str) -> DumpRecord:
    record = dump_tenant(run, tenant, name)
    if record.returncode != 0 or record.coordinates is None:
        raise sp.ProofError(f"the dump of {tenant} failed ({record.returncode}) or has no coordinates: {record.stderr}")
    return record


def reseed(run: Run, record: DumpRecord) -> int:
    """Seeds the replica with one tenant: its dump, then replication at the
    dump's recorded coordinates, filtered to that tenant. Returns the rows of
    emails the dump alone held."""
    ctx = run.ctx
    for statement in ("STOP REPLICA", "RESET REPLICA ALL", f"DROP DATABASE IF EXISTS {record.tenant}"):
        ctx.replica.run(statement, check=False)
    ctx.replica.load_file(record.path)
    in_dump = int(ctx.replica.query(f"SELECT COUNT(*) FROM {record.tenant}.emails;")[0][0])
    ctx.replica.run(f"CHANGE REPLICATION FILTER REPLICATE_WILD_DO_TABLE = ('{record.tenant}.%');")
    sp.start_replication(ctx, *record.coordinates)
    return in_dump


def binlog_event_position(decoded_binlog: str, slug: str) -> int | None:
    """The `# at` offset of the row event that inserted `slug`, in the text
    `mysqlbinlog --base64-output=DECODE-ROWS -v` printed; None if not there."""
    index = decoded_binlog.find(f"'{slug}'")
    if index < 0:
        return None
    offsets = re.findall(r"^# at (\d+)$", decoded_binlog[:index], re.M)
    return int(offsets[-1]) if offsets else None


def classify_missing(*, event_position: int | None, coordinates: Coordinates, in_dump: bool) -> str:
    """Where a row that is on the source but not on the seeded replica sits
    against the dump and its recorded coordinates. Only a row committed before
    the coordinates yet absent from the dump says the coordinates ran ahead of
    the snapshot: the replay starts after it and the dump never held it."""
    if in_dump:
        return "in the dump but not on the replica: the replay or load lost it"
    if event_position is None:
        return f"absent from the dump and not in {coordinates[0]}"
    if event_position < coordinates[1]:
        return (
            f"committed to the binary log at {event_position}, before the recorded coordinates {coordinates[1]}, "
            "yet absent from the dump: the coordinates ran ahead of the snapshot"
        )
    return f"at {event_position}, after the recorded coordinates {coordinates[1]}: the replay should have applied it"


def locate_missing(run: Run, record: DumpRecord, limit: int = 3) -> list[str]:
    """For a tenant whose tables differ: the posts rows the replica lacks,
    each placed against the dump and the coordinates by reading the source's
    own binary log, an oracle that is not the replica."""
    ctx = run.ctx
    tenant = record.tenant
    source = {row[0] for row in ctx.source.query(f"SELECT slug FROM {tenant}.posts;")}
    replica = {row[0] for row in ctx.replica.query(f"SELECT slug FROM {tenant}.posts;")}
    lacking = sorted(source - replica)
    if not lacking:
        return []
    dump_text = record.path.read_text(errors="replace")
    # The stock image has no mysqlbinlog; the Percona replica's reads the source's
    # log over the network as the replication account, whichever source it is.
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
                record.coordinates[0],
            ]
        ),
        env=sp._client_env(ctx.passwords.repl),
        capture_output=True,
        text=True,
        check=False,
        timeout=300,
    )
    if result.returncode != 0:
        said = (result.stderr.strip() or result.stdout.strip())[:200]
        return [f"{len(lacking)} posts rows missing; mysqlbinlog exited {result.returncode} reading {record.coordinates[0]}: {said}"]
    decoded = result.stdout
    return [
        f"posts row {slug} {classify_missing(event_position=binlog_event_position(decoded, slug), coordinates=record.coordinates, in_dump=slug in dump_text)}"
        for slug in lacking[:limit]
    ] + ([f"and {len(lacking) - limit} more posts rows"] if len(lacking) > limit else [])


def _brief(text: str, limit: int = 200) -> str:
    """A long list of differing tables, cut to its start."""
    return text if len(text) <= limit else text[:limit].rstrip() + " ..."


def seed_and_compare(run: Run, records: Mapping[str, DumpRecord], final: Coordinates) -> tuple[Verdict, list[str]]:
    """Each tenant in turn: seed, replay to the source's final position,
    compare every table's count and CHECKSUM TABLE, and require that the
    replay applied something the dump did not hold."""
    ctx = run.ctx
    failures: list[str] = []
    lines: list[str] = []
    for tenant in TENANTS:
        record = records[tenant]
        in_dump = reseed(run, record)
        failure = sp.wait_caught_up(ctx.replica, *final)
        source_sums = sp.table_sums(ctx.source, tenant)
        replica_sums = sp.table_sums(ctx.replica, tenant)
        rows_final = int(ctx.replica.query(f"SELECT COUNT(*) FROM {tenant}.emails;")[0][0]) if failure is None else in_dump
        parts = [sp.checksum_verdict(source_sums, replica_sums), rcp.replay_verdict(in_dump, rows_final)]
        reasons = ([failure] if failure is not None else []) + [_brief(part.reason) for part in parts if not part.passed]
        if not parts[0].passed:
            reasons += locate_missing(run, record)
        if reasons:
            failures.append(f"{tenant}: " + "; ".join(reasons))
        lines.append(
            f"  {tenant}: seeded at {record.coordinates[0]}:{record.coordinates[1]}, replayed to {final[0]}:{final[1]}; "
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


def run_round(run: Run, scenario: Scenario, number: int, spec: RoundSpec) -> None:
    ctx = run.ctx
    writers = {tenant: sp.Writer(ctx.source, tenant, sp.blog_statement) for tenant in TENANTS}
    holder: sp.Session | None = None
    reader: sp.Session | None = None
    done = threading.Event()
    reader_errors: list[sp.ProofError] = []
    records: dict[str, DumpRecord] = {}
    for writer in writers.values():
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
            samples = {tenant: writer.finish() for tenant, writer in writers.items()}
        finally:
            if reader is not None:
                reader.close()
    committed = ""
    if holder is not None:
        holder.run("COMMIT;")
        holder.close()
        committed = "; the long transaction committed after the last dump"
    for tenant, tenant_samples in samples.items():
        scenario.latencies[tenant].extend(latency for _, latency in tenant_samples[WARMUP_SAMPLES:])
        before = [latency for start, latency in tenant_samples[WARMUP_SAMPLES:] if start + latency < dumping]
        scenario.baseline[tenant] = max(scenario.baseline[tenant], max(before, default=0.0))
    scenario.snapshots += passes * len(TENANTS)
    statements = {tenant: len(tenant_samples) for tenant, tenant_samples in samples.items()}
    kind = "short"
    if spec.long_round:
        kind = f"long: SELECT SLEEP({SLEEP_SECONDS}) on {LONG_TENANT}" + (" and an open write transaction" if spec.long_transaction else "")
    scenario.lines.append(f"round {number} ({kind}): {passes} pass(es) of {len(TENANTS)} dumps, write transactions per tenant {statements}{committed}")
    if not SEEDING[run.sabotage]:
        return
    final = sp.read_log_status(ctx.source)
    verdict, lines = seed_and_compare(run, records, final)
    scenario.rounds.append(verdict)
    scenario.lines.extend(lines)


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
    """The variables exist, and a replica seeded at the recorded coordinates
    matches every table of every tenant."""
    ctx = run.ctx
    status = parse_status(f"{row[0]}\t{row[1]}" for row in ctx.source.query("SHOW STATUS LIKE 'Binlog_snapshot%';"))
    row = ctx.source.query("SELECT @@log_bin, @@binlog_format, @@sync_binlog;")[0]
    settings = {"log_bin": row[0], "binlog_format": row[1], "sync_binlog": row[2]}
    version = ctx.source.query("SELECT @@version, @@version_comment;")[0]
    numbers = [f"source server: {version[0]} ({version[1]})"]
    variables = variables_verdict(status, settings)
    # Under a sabotage the source is stock MySQL, which has no such variables
    # by design; what must go red is the replica, not this check.
    if not variables.passed and not run.sabotage:
        return sp.ControlResult(1, "variables and consistent coordinates", variables, numbers)
    scenario = get_scenario(run)
    numbers += scenario.lines
    rounds = rcp.rounds_verdict(scenario.rounds)
    verdict = rounds if run.sabotage else Verdict(rounds.passed, f"{variables.reason}; {rounds.reason}")
    return sp.ControlResult(1, "variables and consistent coordinates", verdict, numbers)


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
    """FINDING: the comment form the dump emits, and whether
    extract_tenant_binlog.SOURCE_DATA_PATTERN parses it."""
    record = dump_tenant(run, LONG_TENANT, "finding.sql")
    if record.returncode != 0:
        return sp.ControlResult(6, "coordinates comment form (finding)", Verdict(False, f"the dump failed ({record.returncode}): {record.stderr}"), [])
    return sp.ControlResult(6, "coordinates comment form (finding)", comment_verdict(record.finding), [])


CONTROLS: Mapping[int, Callable[[Run], sp.ControlResult]] = {1: control_1, 2: control_2, 3: control_3, 4: control_4, 5: control_5, 6: control_6}


def run_probe(args: argparse.Namespace) -> int:
    reason = sp.refusal([args.source, args.replica], os.environ.get("DOCKER_HOST"), sp.docker_context)
    if reason is not None:
        print(f"REFUSED: {reason}", file=sys.stderr)
        return EXIT_REFUSED
    if args.sabotage is not None and args.sabotage not in SABOTAGE_TARGETS:
        print(f"unknown SABOTAGE {args.sabotage!r}; known: {sorted(SABOTAGE_TARGETS)}", file=sys.stderr)
        return 64
    if args.sabotage is not None and args.source_kind != SABOTAGE_SOURCE:
        print(f"SABOTAGE {args.sabotage} runs on the {SABOTAGE_SOURCE} source (PROOF_SOURCE={SABOTAGE_SOURCE}), not {args.source_kind}", file=sys.stderr)
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
