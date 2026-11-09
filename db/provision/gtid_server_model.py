#!/usr/bin/env python3
"""Test support: an in-process model of one MySQL-family server's commit
pipeline, with fakes for the four programs the backup and restore code runs
(`mysqldump`, `mysqlbinlog`, `mysql`, and the process launcher). Single
threaded and scheduled by the test, so an ordering a real server reaches
once in a thousand runs is reached on purpose. It models ORDER, not a
database engine: see gtid_server_model.md. Not shipped to any host.
"""

from __future__ import annotations

import dataclasses
import datetime
import io
import random
import re
import subprocess
from collections.abc import Callable, Iterable, Sequence

SERVER_UUID = "3e11fa47-71ca-11e1-9e33-c80aa9429562"
# A server that has lived before: transactions of another uuid already
# executed. Makes the GTID set two members, which mysqldump breaks over lines.
FOREIGN_UUID = "9a0b1c2d-1111-2222-3333-444455556666"
FOREIGN_EXECUTED = 7
BASE_TIME = datetime.datetime(2026, 1, 1, 0, 0, 0)
FIRST_EVENT_POSITION = 197  # after the format description and Previous-GTIDs events

Op = tuple[str, str, int, int]  # ("insert" | "incr", table, primary key, value or delta)


class DuplicateKey(Exception):
    """A replay inserted a row the restore target already holds (error 1062)."""


class MissingRow(Exception):
    """A replay incremented a row the restore target does not hold."""


def apply_op(state: dict[tuple[str, int], int], op: Op) -> None:
    kind, table, key, number = op
    slot = (table, key)
    if kind == "insert":
        if slot in state:
            raise DuplicateKey(f"ERROR 1062: duplicate entry {key} for {table}")
        state[slot] = number
    elif kind == "incr":
        if slot not in state:
            raise MissingRow(f"no row {key} in {table}")
        state[slot] += number
    else:
        raise AssertionError(f"unknown op {kind!r}")


def format_time(seconds: int) -> str:
    return (BASE_TIME + datetime.timedelta(seconds=seconds)).strftime("%Y-%m-%d %H:%M:%S")


def binlog_name(number: int) -> str:
    return f"mysql-bin.{number:06d}"


def _intervals(numbers: Iterable[int]) -> list[tuple[int, int]]:
    spans: list[tuple[int, int]] = []
    for number in sorted(numbers):
        if spans and number == spans[-1][1] + 1:
            spans[-1] = (spans[-1][0], number)
        else:
            spans.append((number, number))
    return spans


def gtid_set_text(own: Iterable[int], *, separator: str = ",") -> str:
    """The server's set as mysql prints it. Written here, independently of
    gtid_snapshot, so a bug there cannot hide behind the same bug here."""
    members = []
    foreign = f"{FOREIGN_UUID}:1-{FOREIGN_EXECUTED}"
    own_spans = ":".join(str(a) if a == b else f"{a}-{b}" for a, b in _intervals(own))
    members.append(foreign)
    if own_spans:
        members.append(f"{SERVER_UUID}:{own_spans}")
    return separator.join(sorted(members))


@dataclasses.dataclass
class Txn:
    seq: int
    schema: str
    ops: tuple[Op, ...]
    ts: int
    file_number: int
    start: int
    end: int
    committed: bool = False


@dataclasses.dataclass(frozen=True)
class Snapshot:
    """START TRANSACTION WITH CONSISTENT SNAPSHOT: what the read view sees,
    and what the server says about its log at that instant."""

    view: dict[str, dict[tuple[str, int], int]]
    gtids: frozenset[int]
    log_file: str
    log_position: int
    ts: int


class Server:
    """The commit pipeline: a transaction is first written to the binary log
    (flush stage: it gets its GTID and its position), and only later made
    visible in the engine (commit stage). Between the two it is logged and
    invisible. That window is the whole race."""

    def __init__(self, *, flavour: str = "percona", rotate_bytes: int = 700, gtid_binlogs: bool = True) -> None:
        self.flavour = flavour
        self.rotate_bytes = rotate_bytes
        self.gtid_binlogs = gtid_binlogs
        self.state: dict[str, dict[tuple[str, int], int]] = {}
        self.txns: list[Txn] = []
        self.executed: set[int] = set()
        self.clock = 0
        self.file_number = 1
        self.position = FIRST_EVENT_POSITION
        self.locked_schemas: set[str] = set()
        # What the tests assert about locking.
        self.lock_requests = 0
        self.global_lock_attempts = 0
        self.stalled_submits = 0
        # The ordering knob the sabotage tests turn: which GTID set the dump
        # header carries. "snapshot" is the contract (the set of the read
        # view, read atomically with it); "live_after" reads the server's
        # executed set after the snapshot has opened; "none" writes no
        # statement at all.
        self.header_set_source = "snapshot"
        self.spawned: list[str] = []
        self.argv_log: list[list[str]] = []
        self.activity: Callable[[], None] = lambda: None
        self.dump_runs = 0
        self.snapshots: list[Snapshot] = []
        self.target = RestoreTarget()

    def submit(self, schema: str, ops: Sequence[Op]) -> Txn | None:
        if schema in self.locked_schemas:
            self.stalled_submits += 1
            return None
        self.clock += 1
        size = 90 + 30 * len(ops)
        if self.position + size > self.rotate_bytes and any(t.file_number == self.file_number for t in self.txns):
            self.file_number += 1
            self.position = FIRST_EVENT_POSITION
        txn = Txn(
            seq=len(self.txns) + 1,
            schema=schema,
            ops=tuple(ops),
            ts=self.clock,
            file_number=self.file_number,
            start=self.position,
            end=self.position + size,
        )
        self.position += size
        self.txns.append(txn)
        return txn

    def pending(self) -> list[Txn]:
        return [t for t in self.txns if not t.committed]

    def commit_next(self) -> Txn | None:
        for txn in self.txns:
            if not txn.committed:
                apply_op_all(self.state.setdefault(txn.schema, {}), txn.ops)
                txn.committed = True
                self.executed.add(txn.seq)
                return txn
        return None

    def drain(self) -> None:
        while self.commit_next() is not None:
            pass

    def lock_tables(self, schema: str) -> None:
        self.lock_requests += 1
        self.locked_schemas.add(schema)

    def unlock_tables(self, schema: str) -> None:
        self.locked_schemas.discard(schema)

    def open_snapshot(self) -> Snapshot:
        snapshot = Snapshot(
            view={schema: dict(rows) for schema, rows in self.state.items()},
            gtids=frozenset(self.executed),
            log_file=binlog_name(self.file_number),
            log_position=self.position,
            ts=self.clock,
        )
        self.snapshots.append(snapshot)
        return snapshot

    # --- what the programs see -------------------------------------------------

    def previous_gtids(self, file_number: int) -> set[int]:
        return {t.seq for t in self.txns if t.file_number < file_number}

    def expected_state(self, schema: str, stop_ts: int | None = None) -> dict[tuple[str, int], int]:
        """The tenant's rows after every transaction logged before `stop_ts`,
        in log order: what a perfect point-in-time restore holds."""
        rows: dict[tuple[str, int], int] = {}
        for txn in self.txns:
            if txn.schema == schema and (stop_ts is None or txn.ts < stop_ts):
                apply_op_all(rows, txn.ops)
        return rows

    def binlog_paths(self, directory: str = "/restore/binlogs", first: int = 1) -> list[str]:
        return [f"{directory}/{binlog_name(n)}" for n in range(first, self.file_number + 1)]

    def popen(self, argv, **kwargs):
        """The launcher `ClientFactory` is given in place of subprocess.Popen."""
        binary = argv[0]
        self.spawned.append(binary)
        self.argv_log.append(list(argv))
        if binary != "mysqldump":
            raise AssertionError(f"a lock-free snapshot must open no session of its own, but spawned {binary!r}")
        return self._mysqldump(list(argv[1:]))

    def _mysqldump(self, args: list[str]) -> "FakeDump":
        flags = [a for a in args if not a.startswith("--defaults-extra-file=") and a != "-v"]
        names = {a.split("=", 1)[0] for a in flags}
        self.dump_runs += 1
        if "--set-gtid-purged=ON" in flags and self.flavour == "stock":
            # Oracle mysqldump 8.0.32+ takes FLUSH TABLES WITH READ LOCK here
            # to read the set; the backup account holds no RELOAD.
            self.global_lock_attempts += 1
            return FakeDump(lines=[], returncode=2, stderr=b"mysqldump: Couldn't execute 'FLUSH TABLES WITH READ LOCK': Access denied (1227)\n")
        if "--single-transaction" not in names:
            raise AssertionError("the fake models only --single-transaction dumps")
        if names & {"--lock-all-tables", "--lock-tables", "--flush-logs"}:
            self.lock_requests += 1
        database = flags[flags.index("--databases") + 1]
        snapshot = self.open_snapshot()
        header = "none"
        if "--set-gtid-purged=ON" in flags:
            header = "gtid"
        elif any(f.startswith(("--source-data", "--master-data")) for f in flags):
            header = "position"
        return FakeDump(
            lines=self._dump_lines(snapshot, database, header),
            returncode=0,
            stderr=b"",
            tick=self.activity,
            before=self.activity,
        )

    def _dump_lines(self, snapshot: Snapshot, schema: str, header: str) -> Iterable[str]:
        yield "-- MySQL dump 10.13  Distrib 8.0.46-37, for Linux (x86_64)\n"
        yield f"-- Host: localhost    Database: {schema}\n"
        yield "/*!50503 SET NAMES utf8mb4 */;\n"
        yield "SET @MYSQLDUMP_TEMP_LOG_BIN = @@SESSION.SQL_LOG_BIN;\n"
        yield "SET @@SESSION.SQL_LOG_BIN= 0;\n"
        if header == "gtid" and self.header_set_source != "none":
            gtids = snapshot.gtids if self.header_set_source == "snapshot" else frozenset(self.executed)
            yield "\n--\n-- GTID state at the beginning of the backup \n--\n\n"
            text = gtid_set_text(gtids, separator=",\n")
            yield f"SET @@GLOBAL.GTID_PURGED=/*!80000 '+'*/ '{text}';\n"
        elif header == "position":
            yield f"-- CHANGE MASTER TO MASTER_LOG_FILE='{snapshot.log_file}', MASTER_LOG_POS={snapshot.log_position};\n"
        yield f"\nCREATE DATABASE /*!32312 IF NOT EXISTS*/ `{schema}` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\n"
        yield f"\nUSE `{schema}`;\n"
        tables: dict[str, list[tuple[int, int]]] = {}
        for (table, key), number in sorted(snapshot.view.get(schema, {}).items()):
            tables.setdefault(table, []).append((key, number))
        for table, rows in tables.items():
            yield f"CREATE TABLE `{table}` (`id` int NOT NULL, `n` int NOT NULL);\n"
            values = ",".join(f"({key},{number})" for key, number in rows)
            yield f"INSERT INTO `{table}` VALUES {values};\n"

    # --- mysqlbinlog and mysql (the `run` the extract code is given) ----------

    def run(self, argv, capture_output=None, check=None, input=None, env=None):
        self.argv_log.append(list(argv))
        if argv[0] == "mysqlbinlog":
            return self._mysqlbinlog(list(argv[1:]))
        if argv[0] == "mysql":
            return self._mysql(input)
        raise AssertionError(f"unexpected command {argv[0]!r}")

    def _header_events(self, file_number: int) -> list[str]:
        stamp = BASE_TIME.strftime("%y%m%d %H:%M:%S")
        lines = [f"# at 4\n#{stamp} server id 1  end_log_pos 126 CRC32 0x00000000 \tStart: binlog v 4"]
        if self.gtid_binlogs:
            lines.append(f"# at 126\n#{stamp} server id 1  end_log_pos 197 CRC32 0x00000000 \tPrevious-GTIDs")
            lines.append("# " + gtid_set_text(self.previous_gtids(file_number), separator=",\n# "))
        return lines

    def _mysqlbinlog(self, args: list[str]) -> subprocess.CompletedProcess:
        database = start_position = stop_ts = stop_position = None
        exclude: set[int] = set()
        skip_gtids = False
        files: list[str] = []
        for arg in args:
            if arg.startswith("--database="):
                database = arg.split("=", 1)[1]
            elif arg.startswith("--start-position="):
                start_position = int(arg.split("=", 1)[1])
            elif arg.startswith("--stop-position="):
                stop_position = int(arg.split("=", 1)[1])
            elif arg.startswith("--stop-datetime="):
                stop_ts = int((datetime.datetime.strptime(arg.split("=", 1)[1], "%Y-%m-%d %H:%M:%S") - BASE_TIME).total_seconds())
            elif arg.startswith("--exclude-gtids="):
                exclude = self._own_seqs(arg.split("=", 1)[1])
            elif arg == "--skip-gtids":
                skip_gtids = True
            elif arg.startswith("--"):
                raise AssertionError(f"the fake does not know {arg!r}")
            else:
                files.append(arg)
        numbers = [int(f.rsplit(".", 1)[1]) for f in files]
        out: list[str] = []
        if stop_position is not None:
            out.extend(self._header_events(numbers[0]))
            return subprocess.CompletedProcess(args, 0, stdout="\n".join(out).encode(), stderr=b"")
        for index, number in enumerate(numbers):
            for txn in [t for t in self.txns if t.file_number == number]:
                if index == 0 and start_position is not None and txn.start < start_position:
                    continue
                if txn.seq in exclude:
                    continue
                if stop_ts is not None and txn.ts >= stop_ts:
                    continue
                if database is not None and txn.schema != database:
                    continue
                out.append(self._txn_text(txn, skip_gtids))
            if number < self.file_number:
                last = max((t.ts for t in self.txns if t.file_number == number), default=0)
                if stop_ts is None or last < stop_ts:
                    stamp = (BASE_TIME + datetime.timedelta(seconds=last)).strftime("%y%m%d %H:%M:%S")
                    out.append(f"#{stamp} server id 1  end_log_pos 999 CRC32 0x00000000 \tRotate to {binlog_name(number + 1)}  pos: 4")
        return subprocess.CompletedProcess(args, 0, stdout="\n".join(out).encode(), stderr=b"")

    def _own_seqs(self, text: str) -> set[int]:
        seqs: set[int] = set()
        for member in re.split(r"[,\s]+", text.strip()):
            if not member.startswith(SERVER_UUID):
                continue
            for span in member.split(":")[1:]:
                low, _, high = span.partition("-")
                seqs.update(range(int(low), int(high or low) + 1))
        return seqs

    def _txn_text(self, txn: Txn, skip_gtids: bool) -> str:
        moment = BASE_TIME + datetime.timedelta(seconds=txn.ts)
        stamp = moment.strftime("%y%m%d %H:%M:%S")
        head = f"#{stamp} server id 1  end_log_pos {txn.end} CRC32 0x00000000 "
        lines = [f"# at {txn.start}"]
        if self.gtid_binlogs:
            lines.append(f"{head}\tGTID\tlast_committed=0\tsequence_number=1\trbr_only=no")
            if not skip_gtids:
                lines.append(f"SET @@SESSION.GTID_NEXT= '{SERVER_UUID}:{txn.seq}'/*!*/;")
        lines.append(f"{head}\tQuery\tthread_id=1\texec_time=0\terror_code=0")
        lines.append(f"SET TIMESTAMP={int(moment.timestamp())}/*!*/;\nBEGIN\n/*!*/;")
        for kind, table, key, number in txn.ops:
            lines.append(f"{head}\tTable_map: `{txn.schema}`.`{table}` mapped to number 1")
            lines.append(f"### {kind} {txn.schema} {table} {key} {number}")
        lines.append(f"{head}\tXid = {txn.seq}\nCOMMIT/*!*/;")
        return "\n".join(lines)

    def _mysql(self, sql: bytes) -> subprocess.CompletedProcess:
        target = self.target
        for line in sql.decode().splitlines():
            if not line.startswith("### "):
                continue
            _, kind, schema, table, key, number = line.split()
            try:
                apply_op(target.state.setdefault(schema, {}), (kind, table, int(key), int(number)))
            except (DuplicateKey, MissingRow) as exc:
                return subprocess.CompletedProcess(["mysql"], 1, stdout=b"", stderr=str(exc).encode())
        return subprocess.CompletedProcess(["mysql"], 0, stdout=b"", stderr=b"")


def apply_op_all(rows: dict[tuple[str, int], int], ops: Iterable[Op]) -> None:
    for op in ops:
        apply_op(rows, op)


class RestoreTarget:
    """A scratch server a dump is loaded into and a replay applied to."""

    def __init__(self) -> None:
        self.state: dict[str, dict[tuple[str, int], int]] = {}

    def load_dump(self, text: str) -> None:
        schema = None
        for line in text.splitlines():
            match = re.match(r"^USE `([^`]+)`;$", line)
            if match:
                schema = match.group(1)
                self.state.setdefault(schema, {})
                continue
            match = re.match(r"^INSERT INTO `([^`]+)` VALUES (.*);$", line)
            if match and schema is not None:
                for key, number in re.findall(r"\((\d+),(\d+)\)", match.group(2)):
                    self.state[schema][(match.group(1), int(key))] = int(number)

    def rows(self, schema: str) -> dict[tuple[str, int], int]:
        return dict(self.state.get(schema, {}))


class _Lines(io.RawIOBase):
    """A dump's stdout: iterates bytes lines, and lets the writers run between
    them, as writers do while a real dump streams."""

    def __init__(self, lines: Iterable[str], tick: Callable[[], None]) -> None:
        super().__init__()
        self._lines = iter(lines)
        self._pending: list[str] = []
        self._tick = tick

    def __iter__(self):
        return self

    def __next__(self) -> bytes:
        self._tick()
        while not self._pending:
            self._pending = next(self._lines).splitlines(keepends=True)[::-1]
        return self._pending.pop().encode()

    def readable(self) -> bool:
        return True


class FakeDump:
    """What `ClientFactory` gets back for a mysqldump: a process-shaped object.
    Its pid is None so `kill_process` can never signal a real process group."""

    pid = None

    def __init__(self, *, lines, returncode: int, stderr: bytes, tick=lambda: None, before=lambda: None) -> None:
        before()  # writes that land between the snapshot opening and the first byte
        self.stdout = _Lines(lines, tick)
        self.stderr = io.BytesIO(stderr)
        self.returncode = returncode

    def wait(self, timeout=None) -> int:
        return self.returncode

    def kill(self) -> None:
        pass


class Workload:
    """Random writers, scheduled by a seeded generator: submit a transaction
    on a random tenant, or commit the oldest pending one. Deterministic per
    seed. Every transaction is valid in log order, so a replay that applies
    it twice or not at all is visible as an error or a wrong value."""

    def __init__(self, server: Server, tenants: Sequence[str], seed: int, *, commit_bias: float = 0.55) -> None:
        self.server = server
        self.tenants = list(tenants)
        self.random = random.Random(seed)
        self.commit_bias = commit_bias
        self._next_key = {t: 1 for t in tenants}
        self.max_pending = 3

    def write(self, tenant: str | None = None) -> Txn | None:
        tenant = tenant or self.random.choice(self.tenants)
        key = self._next_key[tenant]
        ops: list[Op] = [("insert", "posts", key, self.random.randint(1, 9))]
        if key > 1:
            ops.append(("incr", "posts", self.random.randint(1, key - 1), self.random.randint(1, 5)))
        ops.append(("insert", "emails", key, self.random.randint(1, 9)))
        txn = self.server.submit(tenant, ops)
        if txn is not None:
            self._next_key[tenant] = key + 1
        return txn

    def step(self) -> None:
        pending = len(self.server.pending())
        if pending < self.max_pending and (pending == 0 or self.random.random() > self.commit_bias):
            self.write()
        else:
            self.server.commit_next()

    def run(self, steps: int) -> None:
        for _ in range(steps):
            self.step()
