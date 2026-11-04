#!/usr/bin/env python3
"""Whether REPLICATION CLIENT alone (no BACKUP_ADMIN, no RELOAD) gives binary-log
coordinates that match the snapshot, read with SHOW MASTER STATUS under the
bounded table lock. Runs the real bounded_snapshot module as that account on
local throwaway containers of the pinned MySQL digest, and replays from the
coordinates into a replica. Design, controls and exit codes:
db/provision/replication_client_probe.md. The verdict functions are pure;
test_replication_client_probe.py drives them without Docker. Nothing here
reaches a host.
"""

from __future__ import annotations

import argparse
import dataclasses
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterable, Mapping, Sequence

_HERE = pathlib.Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

import bounded_snapshot as bs  # noqa: E402
import extract_tenant_binlog  # noqa: E402
import snapshot_probe as sp  # noqa: E402

Verdict = sp.Verdict

COORD = "coord"
REQUIRED_PRIVILEGE = "REPLICATION CLIENT"
# Snapshots seeded and replayed per control 1: the coordinate race, if there
# is one, is a window, so one lucky pass proves little.
ROUNDS = 4
# How long the wrong orderings let the writers run between the coordinate
# read and the snapshot, so the gap holds blog writes for certain.
SABOTAGE_GAP_SECONDS = 0.5

# A sabotage name maps to the controls it must turn red.
SABOTAGE_TARGETS = {
    "coordinates-before-lock": (1,),
    "coordinates-after-unlock": (1,),
    "backup-admin-grant": (1, 3),
    "reload-grant": (3,),
    "old-path": (2,),
}
# Sabotages that work by granting the account one more global privilege.
GRANT_SABOTAGES = {"backup-admin-grant": "BACKUP_ADMIN", "reload-grant": "RELOAD"}

EXIT_PASSED = 0
EXIT_RED = 1
EXIT_SABOTAGE_NOT_DETECTED = 2
EXIT_NOT_ADEQUATE = 3
EXIT_REFUSED = 5


# --------------------------------------------------------------------------
# Pure verdicts
# --------------------------------------------------------------------------


def privileges_verdict(global_privileges: Iterable[str]) -> Verdict:
    """The account must hold REPLICATION CLIENT and nothing else globally.
    With more, a pass would not show that REPLICATION CLIENT is enough."""
    privileges = sorted(set(global_privileges))
    if privileges != [REQUIRED_PRIVILEGE]:
        return Verdict(False, f"global privileges are {privileges}, not exactly [{REQUIRED_PRIVILEGE!r}]")
    return Verdict(True, f"{REQUIRED_PRIVILEGE} is the only global privilege")


def grant_shape_verdict(
    *,
    errno_other_schema: int,
    errno_ftwrl: int,
    errno_instance_lock: int,
    errno_master_status: int,
    privileges: Iterable[str],
) -> Verdict:
    """Control 3. The account reads no other schema (1142), cannot take a
    global read lock (1227) or the instance backup lock (1227), and can run
    SHOW MASTER STATUS (0)."""
    problems = []
    expected = (
        ("reading the other schema", errno_other_schema, 1142),
        ("FLUSH TABLES WITH READ LOCK", errno_ftwrl, 1227),
        ("LOCK INSTANCE FOR BACKUP", errno_instance_lock, 1227),
        ("SHOW MASTER STATUS", errno_master_status, 0),
    )
    for label, got, want in expected:
        if got != want:
            problems.append(f"{label} gave error {got}, not {want}")
    shape = privileges_verdict(privileges)
    if not shape.passed:
        problems.append(shape.reason)
    if problems:
        return Verdict(False, "; ".join(problems))
    return Verdict(
        True,
        "error 1142 on the other schema, 1227 on FTWRL and on LOCK INSTANCE FOR BACKUP, "
        f"SHOW MASTER STATUS allowed, {REQUIRED_PRIVILEGE} the only global privilege",
    )


def multiset_verdict(what: str, source: Mapping[str, int], replica: Mapping[str, int]) -> Verdict:
    """No lost and no duplicated rows: each key's count on the replica equals
    the source's. A source with nothing in it is a blind probe, not a pass."""
    if not source:
        return Verdict(False, f"the source has no {what}: the probe could not see a loss or a duplicate")
    lost = sorted(key for key, count in source.items() if replica.get(key, 0) < count)
    duplicated = sorted(key for key, count in replica.items() if count > source.get(key, 0))
    if lost or duplicated:
        return Verdict(
            False,
            f"{what}: {len(lost)} lost {lost[:3]}, {len(duplicated)} duplicated {duplicated[:3]} "
            f"(of {len(source)} keys on the source)",
        )
    return Verdict(True, f"{what}: none of {len(source)} keys lost or duplicated")


def replay_verdict(rows_in_dump: int, rows_final: int) -> Verdict:
    """The replay must have applied at least one blog write that the dump did
    not hold, or a clean result says nothing about the coordinates."""
    replayed = rows_final - rows_in_dump
    if replayed < 1:
        return Verdict(False, f"nothing was replayed past the dump ({rows_in_dump} then {rows_final} rows): the replay proved nothing")
    return Verdict(True, f"{replayed} blog rows came from the replay, past the dump's {rows_in_dump}")


def rounds_verdict(rounds: Sequence[Verdict]) -> Verdict:
    if not rounds:
        return Verdict(False, "no round ran")
    failed = [(number, verdict.reason) for number, verdict in enumerate(rounds, 1) if not verdict.passed]
    if failed:
        return Verdict(False, f"{len(failed)} of {len(rounds)} rounds failed; first, round {failed[0][0]}: {failed[0][1]}")
    return Verdict(True, f"all {len(rounds)} rounds replayed cleanly from the coordinates")


def exit_code(outcomes: Mapping[int, bool], *, sabotaged: bool) -> int:
    """`outcomes` maps each control run to whether it passed."""
    if sabotaged:
        return EXIT_SABOTAGE_NOT_DETECTED if any(outcomes.values()) else EXIT_RED
    return EXIT_PASSED if outcomes and all(outcomes.values()) else EXIT_NOT_ADEQUATE


SELF_TEST_CASES: tuple[tuple[str, bool, Callable[[], Verdict]], ...] = (
    ("privileges: BACKUP_ADMIN also held", False, lambda: privileges_verdict(["REPLICATION CLIENT", "BACKUP_ADMIN"])),
    ("privileges: none", False, lambda: privileges_verdict([])),
    ("privileges: healthy", True, lambda: privileges_verdict(["REPLICATION CLIENT"])),
    (
        "grant_shape: FTWRL accepted",
        False,
        lambda: grant_shape_verdict(
            errno_other_schema=1142, errno_ftwrl=0, errno_instance_lock=1227, errno_master_status=0, privileges=["REPLICATION CLIENT"]
        ),
    ),
    (
        "grant_shape: instance lock accepted",
        False,
        lambda: grant_shape_verdict(
            errno_other_schema=1142, errno_ftwrl=1227, errno_instance_lock=0, errno_master_status=0, privileges=["REPLICATION CLIENT"]
        ),
    ),
    (
        "grant_shape: SHOW MASTER STATUS refused",
        False,
        lambda: grant_shape_verdict(
            errno_other_schema=1142, errno_ftwrl=1227, errno_instance_lock=1227, errno_master_status=1227, privileges=["REPLICATION CLIENT"]
        ),
    ),
    (
        "grant_shape: healthy",
        True,
        lambda: grant_shape_verdict(
            errno_other_schema=1142, errno_ftwrl=1227, errno_instance_lock=1227, errno_master_status=0, privileges=["REPLICATION CLIENT"]
        ),
    ),
    ("multiset: a lost row", False, lambda: multiset_verdict("emails", {"1": 1, "2": 1}, {"1": 1})),
    ("multiset: a duplicated row", False, lambda: multiset_verdict("emails", {"1": 1}, {"1": 2})),
    ("multiset: blind source", False, lambda: multiset_verdict("emails", {}, {})),
    ("multiset: healthy", True, lambda: multiset_verdict("emails", {"1": 1, "2": 1}, {"1": 1, "2": 1})),
    ("replay: nothing replayed", False, lambda: replay_verdict(500, 500)),
    ("replay: healthy", True, lambda: replay_verdict(500, 530)),
    ("rounds: one failed", False, lambda: rounds_verdict([Verdict(True, "ok"), Verdict(False, "bad")])),
    ("rounds: none ran", False, lambda: rounds_verdict([])),
    ("rounds: healthy", True, lambda: rounds_verdict([Verdict(True, "ok"), Verdict(True, "ok")])),
)


def self_test() -> list[str]:
    """The labels of the cases whose verdict was not the expected one."""
    return [label for label, expected, case in SELF_TEST_CASES if case().passed != expected]


# --------------------------------------------------------------------------
# Container plumbing
# --------------------------------------------------------------------------


@dataclasses.dataclass
class Run:
    ctx: sp.Ctx
    password: str

    @property
    def source(self) -> sp.Server:
        return self.ctx.source

    def sabotaged(self, name: str) -> bool:
        return self.ctx.sabotaged(name)

    def as_coord(self, sql: str) -> subprocess.CompletedProcess:
        return self.source.run(sql, user=COORD, password=self.password, check=False)


class CoordLockSampler(sp.LockSampler):
    """The metadata locks held by this account's threads."""

    SQL = (
        "SELECT ml.OBJECT_TYPE, ml.LOCK_TYPE, ml.LOCK_STATUS "
        "FROM performance_schema.metadata_locks ml JOIN performance_schema.threads t ON t.THREAD_ID = ml.OWNER_THREAD_ID "
        f"WHERE t.PROCESSLIST_USER = '{COORD}';"
    )


def seed_account(run: Run) -> None:
    """The move account's grants, with REPLICATION CLIENT where BACKUP_ADMIN was."""
    run.source.run(
        f"CREATE USER '{COORD}'@'localhost' IDENTIFIED BY '{run.password}';\n"
        f"GRANT SELECT, LOCK TABLES, SHOW VIEW, TRIGGER ON {sp.BLOG}.* TO '{COORD}'@'localhost';\n"
        f"GRANT {REQUIRED_PRIVILEGE} ON *.* TO '{COORD}'@'localhost';\n"
    )


def global_privileges(run: Run) -> frozenset[str]:
    grants = [row[0] for row in run.source.query(f"SHOW GRANTS FOR '{COORD}'@'localhost';")]
    return sp.parse_global_privileges(grants)


def read_master_status(run: Run) -> tuple[str, int]:
    result = run.as_coord("SHOW MASTER STATUS;")
    if result.returncode != 0:
        raise sp.ProofError(f"SHOW MASTER STATUS as {COORD} failed: {result.stderr.strip()[:300]}")
    try:
        return bs.parse_master_status(result.stdout.splitlines())
    except bs._Fatal as exc:
        raise sp.ProofError(str(exc)) from None


def take_snapshot(
    run: Run,
    name: str,
    *,
    ordering: str = "correct",
    limits: bs.Limits | None = None,
    log: Callable[[str], None] = lambda message: None,
) -> tuple[bs.SnapshotReport, tuple[str, int], pathlib.Path]:
    """The real module as the account, positions read with SHOW MASTER STATUS
    under its lock; the dump written with the coordinates as its first line.
    The wrong orderings read the position themselves, before the module takes
    its lock or after it has released it, and use that instead."""
    ctx = run.ctx
    factory = bs.ClientFactory(
        connection_args=[f"--user={COORD}"], password=run.password, env={}, popen=sp.container_popen(ctx.source)
    )
    early = None
    if ordering == "before-lock":
        early = read_master_status(run)
        time.sleep(SABOTAGE_GAP_SECONDS)
    dump, report = bs.take_bounded_snapshot(
        factory=factory,
        schemas=[sp.BLOG],
        dump_args=sp.DUMP_ARGS,
        limits=limits or bs.Limits(),
        log=log,
        coordinates=bs.COORDINATES_MASTER_STATUS,
    )
    coordinates = (report.log_file, report.log_position)
    if early is not None:
        coordinates = early
    elif ordering == "after-unlock":
        time.sleep(SABOTAGE_GAP_SECONDS)
        coordinates = read_master_status(run)
    path = ctx.workdir / name
    with open(path, "wb") as handle:
        handle.write(f"-- CHANGE MASTER TO MASTER_LOG_FILE='{coordinates[0]}', MASTER_LOG_POS={coordinates[1]};\n".encode())
        shutil.copyfileobj(dump.process.stdout, handle)
    returncode = dump.process.wait(timeout=300)
    dump.stderr.join(5)
    if returncode != 0:
        raise sp.ProofError(f"mysqldump failed ({returncode}): {dump.stderr.text()[:400]}")
    return report, coordinates, path


def old_path_dump(run: Run) -> None:
    """The path being retired: `mysqldump --source-data=2` flushes tables and
    takes FLUSH TABLES WITH READ LOCK. Needs RELOAD, granted by the caller."""
    dump = run.source.popen(
        ["mysqldump", f"--user={COORD}", "--single-transaction", "--source-data=2", "--no-tablespaces", "--databases", sp.BLOG],
        run.password,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    _, stderr = dump.communicate(timeout=120)
    if dump.returncode != 0:
        raise sp.ProofError(f"the old-path mysqldump failed: {stderr.decode(errors='replace')[:300]}")


def counts(server: sp.Server, sql: str) -> dict[str, int]:
    return {row[0]: int(row[1]) for row in server.query(sql)}


POSTS_SQL = f"SELECT title, COUNT(*) FROM {sp.BLOG}.posts GROUP BY title;"
EMAILS_SQL = f"SELECT post_id, COUNT(*) FROM {sp.BLOG}.emails GROUP BY post_id;"


# --------------------------------------------------------------------------
# The controls
# --------------------------------------------------------------------------


def one_round(run: Run, number: int) -> tuple[Verdict, str]:
    ctx = run.ctx
    ordering = {"coordinates-before-lock": "before-lock", "coordinates-after-unlock": "after-unlock"}.get(ctx.sabotage or "", "correct")
    sp.reset_replica(ctx)
    blog = sp.Writer(ctx.source, sp.BLOG, sp.blog_statement)
    other = sp.Writer(ctx.source, sp.OTHER, sp.other_posts_statement)
    blog.start()
    other.start()
    time.sleep(1.0)
    try:
        report, coordinates, dump_path = take_snapshot(run, f"coord-seed-{number}.sql", ordering=ordering)
        with open(dump_path, "rb") as handle:
            first_line = handle.readline().decode().rstrip("\n")
        match = extract_tenant_binlog.SOURCE_DATA_PATTERN.match(first_line)
        if match is None or (match.group("log_file"), int(match.group("position"))) != coordinates:
            raise sp.ProofError(f"the dump's first line does not parse as the coordinates: {first_line!r}")
        ctx.replica.load_file(dump_path)
        rows_in_dump = int(ctx.replica.query(f"SELECT COUNT(*) FROM {sp.BLOG}.emails;")[0][0])
        sp.start_replication(ctx, *coordinates)
        time.sleep(1.5)
    finally:
        blog_statements = len(blog.samples)
        sp._check_writers(blog, other)
    final = sp.read_log_status(ctx.source)
    failure = sp.wait_caught_up(ctx.replica, *final)
    source_sums, replica_sums = sp.table_sums(ctx.source), sp.table_sums(ctx.replica)
    rows_final = int(ctx.replica.query(f"SELECT COUNT(*) FROM {sp.BLOG}.emails;")[0][0]) if failure is None else rows_in_dump
    parts = [
        sp.checksum_verdict(source_sums, replica_sums),
        multiset_verdict("posts by title", counts(ctx.source, POSTS_SQL), counts(ctx.replica, POSTS_SQL)),
        multiset_verdict("emails by post", counts(ctx.source, EMAILS_SQL), counts(ctx.replica, EMAILS_SQL)),
        replay_verdict(rows_in_dump, rows_final),
    ]
    failures = ([failure] if failure is not None else []) + [part.reason for part in parts if not part.passed]
    verdict = Verdict(False, "; ".join(failures)) if failures else Verdict(True, "; ".join(part.reason for part in parts))
    line = (
        f"round {number} ({ordering}): coordinates {coordinates[0]}:{coordinates[1]} read by SHOW MASTER STATUS, "
        f"lock wait {report.lock_wait_seconds * 1000:.0f} ms, hold {report.hold_seconds * 1000:.0f} ms, attempts {report.attempts}; "
        f"{blog_statements} blog write transactions ({blog.deadlocks} deadlock victims); "
        f"{len(source_sums)} tables, replayed to {final[0]}:{final[1]}; {verdict.reason}"
    )
    return verdict, line


def control_1(run: Run) -> sp.ControlResult:
    """Coordinates consistent with the snapshot: replay loses and duplicates nothing."""
    shape = privileges_verdict(global_privileges(run))
    rounds, lines = [], []
    if shape.passed:
        for number in range(1, ROUNDS + 1):
            verdict, line = one_round(run, number)
            rounds.append(verdict)
            lines.append(line)
    summary = rounds_verdict(rounds)
    if not shape.passed:
        summary = Verdict(False, shape.reason)
    return sp.ControlResult(1, "coordinates consistent with the snapshot", summary, lines)


def other_tenant_phase(run: Run) -> tuple[Verdict, list[str]]:
    """A SELECT SLEEP(10) holds `other.posts` while the blog is snapshotted
    over and over; `other`'s writer's worst statement stays under the limit."""
    ctx = run.ctx
    old_path = run.sabotaged("old-path")
    writer = sp.Writer(ctx.source, sp.OTHER, sp.other_posts_statement)
    reader = ctx.source.session(database=sp.OTHER)
    snapshots = 0
    writer.start()
    try:
        time.sleep(2.5)
        baseline = sp.worst_of(writer.samples[2:])
        done = threading.Event()
        errors: list[sp.ProofError] = []

        def hold_reader() -> None:
            try:
                reader.run("SELECT SLEEP(10) FROM posts LIMIT 1;")
            except sp.ProofError as exc:
                errors.append(exc)
            finally:
                done.set()

        threading.Thread(target=hold_reader, daemon=True).start()
        for _ in range(100):
            if ctx.source.query("SELECT COUNT(*) FROM performance_schema.processlist WHERE INFO LIKE 'SELECT SLEEP(10)%';")[0][0] != "0":
                break
            time.sleep(0.1)
        else:
            raise sp.ProofError("the long reader never started")
        began = time.monotonic()
        if old_path:
            ctx.source.run(f"GRANT RELOAD ON *.* TO '{COORD}'@'localhost';")
            old_path_dump(run)
            snapshots = 1
        else:
            while not done.is_set():
                take_snapshot(run, "under-reader.sql")
                snapshots += 1
                time.sleep(0.2)
        done.wait(timeout=60)
        if errors:
            raise errors[0]
        ended = time.monotonic()
    finally:
        if old_path:
            ctx.source.run(f"REVOKE RELOAD ON *.* FROM '{COORD}'@'localhost';", check=False)
        reader.close()
        samples = writer.finish()
    latencies = sp.latencies_between(samples, began, ended)
    verdict = sp.writer_stall_verdict(latencies, sp.WRITER_LIMIT_SECONDS)
    line = (
        f"a SELECT SLEEP(10) held other.posts for {ended - began:.1f} s while {snapshots} "
        f"{'old-path dump' if old_path else 'snapshot(s)'} ran; baseline worst `other` statement {sp._ms(baseline)}; {verdict.reason}"
    )
    return verdict, [line]


def lock_phase(run: Run) -> tuple[Verdict, list[str]]:
    """Repeated snapshots with a Ghost-like blog writer running: the account
    holds no GLOBAL or COMMIT lock, and the blog writer's wait stays bounded."""
    ctx = run.ctx
    old_path = run.sabotaged("old-path")
    sampler = CoordLockSampler(ctx.source)
    blog = sp.Writer(ctx.source, sp.BLOG, sp.blog_statement, pause=0.01)
    blog.start()
    sampler.start()
    began = time.monotonic()
    runs = 0
    try:
        if old_path:
            ctx.source.run(f"GRANT RELOAD ON *.* TO '{COORD}'@'localhost';")
        for _ in range(3 if old_path else 10):
            if old_path:
                old_path_dump(run)
            else:
                take_snapshot(run, "sampled.sql")
            runs += 1
    finally:
        ended = time.monotonic()
        if old_path:
            ctx.source.run(f"REVOKE RELOAD ON *.* FROM '{COORD}'@'localhost';", check=False)
        sampler.finish()
        samples = blog.finish()
    lock = sp.global_lock_verdict(sampler.rows)
    waits = sp.latencies_between(samples, began, ended)
    wait = sp.bounded_wait_verdict(waits, sp.MODULE_WAIT_BOUND_SECONDS, sp.BODY_WAIT_CEILING_SECONDS)
    verdict = Verdict(lock.passed and wait.passed, "; ".join(part.reason for part in (lock, wait)))
    line = (
        f"{sampler.samples} samples of metadata_locks over {runs} {'old-path dump(s)' if old_path else 'snapshot(s)'}, "
        f"{sampler.table_lock_samples} saw a granted table lock; {verdict.reason}"
    )
    return verdict, [line]


def control_2(run: Run) -> sp.ControlResult:
    """Another tenant's writes are never blocked: no stall, no global lock."""
    stall, stall_lines = other_tenant_phase(run)
    lock, lock_lines = lock_phase(run)
    verdict = Verdict(stall.passed and lock.passed, "; ".join(part.reason for part in (stall, lock)))
    return sp.ControlResult(2, "another tenant is not blocked", verdict, stall_lines + lock_lines)


def control_3(run: Run) -> sp.ControlResult:
    """The grants are what the design says and no more."""
    other = run.as_coord(f"SELECT * FROM {sp.OTHER}.posts LIMIT 1;")
    ftwrl = run.as_coord("FLUSH TABLES WITH READ LOCK; UNLOCK TABLES;")
    instance = run.as_coord("LOCK INSTANCE FOR BACKUP; UNLOCK INSTANCE;")
    master = run.as_coord("SHOW MASTER STATUS;")
    log_status = run.as_coord("SELECT LOCAL FROM performance_schema.log_status;")
    privileges = global_privileges(run)
    verdict = grant_shape_verdict(
        errno_other_schema=sp.parse_errno(other.stderr),
        errno_ftwrl=sp.parse_errno(ftwrl.stderr),
        errno_instance_lock=sp.parse_errno(instance.stderr),
        errno_master_status=sp.parse_errno(master.stderr),
        privileges=privileges,
    )
    numbers = [
        f"read of {sp.OTHER}.posts: error {sp.parse_errno(other.stderr)}; FTWRL: error {sp.parse_errno(ftwrl.stderr)}; "
        f"LOCK INSTANCE FOR BACKUP: error {sp.parse_errno(instance.stderr)}; SHOW MASTER STATUS: error {sp.parse_errno(master.stderr)}",
        f"global privileges: {sorted(privileges)}; reading performance_schema.log_status gives error {sp.parse_errno(log_status.stderr)}",
    ]
    return sp.ControlResult(3, "scoped grants", verdict, numbers)


CONTROLS: Mapping[int, Callable[[Run], sp.ControlResult]] = {1: control_1, 2: control_2, 3: control_3}


def run_probe(args: argparse.Namespace) -> int:
    reason = sp.refusal([args.source, args.replica], os.environ.get("DOCKER_HOST"), sp.docker_context)
    if reason is not None:
        print(f"REFUSED: {reason}", file=sys.stderr)
        return EXIT_REFUSED
    workdir = pathlib.Path(args.workdir)
    root = (workdir / "root.pw").read_text().strip()
    ctx = sp.Ctx(
        source=sp.Server(args.source, root),
        replica=sp.Server(args.replica, root),
        workdir=workdir,
        passwords=sp.Passwords.read(workdir),
        sabotage=args.sabotage,
    )
    run = Run(ctx, (workdir / f"{COORD}.pw").read_text().strip())
    controls = [int(part) for part in args.controls.split()]
    if args.sabotage:
        if args.sabotage not in SABOTAGE_TARGETS:
            print(f"unknown SABOTAGE {args.sabotage!r}; known: {sorted(SABOTAGE_TARGETS)}", file=sys.stderr)
            return 64
        controls = [n for n in controls if n in SABOTAGE_TARGETS[args.sabotage]]
        if not controls:
            print(f"SABOTAGE {args.sabotage} targets controls {SABOTAGE_TARGETS[args.sabotage]}; none selected", file=sys.stderr)
            return 64
    sp.seed(ctx)
    seed_account(run)
    extra = GRANT_SABOTAGES.get(args.sabotage or "")
    if extra:
        ctx.source.run(f"GRANT {extra} ON *.* TO '{COORD}'@'localhost';")
    outcomes: dict[int, bool] = {}
    try:
        for number in controls:
            ctx.say(f"== control {number}" + (f" (sabotage: {args.sabotage})" if args.sabotage else ""))
            try:
                result = CONTROLS[number](run)
            except (sp.ProofError, bs.SnapshotError, subprocess.TimeoutExpired) as exc:
                result = sp.ControlResult(number, "did not complete", Verdict(False, f"{type(exc).__name__}: {exc}"), [])
            for line in result.numbers:
                ctx.say(f"  {line}")
            outcomes[number] = result.verdict.passed
            label = "PASS" if result.verdict.passed else ("RED" if args.sabotage else "FAIL")
            ctx.say(f"{label} control {number}, {result.title}: {result.verdict.reason}")
    finally:
        if extra:
            ctx.source.run(f"REVOKE {extra} ON *.* FROM '{COORD}'@'localhost';", check=False)
    code = exit_code(outcomes, sabotaged=bool(args.sabotage))
    if code == EXIT_PASSED:
        ctx.say("ALL PASSED: REPLICATION CLIENT alone gives coordinates consistent with the snapshot. BACKUP_ADMIN is not needed.")
    elif code == EXIT_RED:
        ctx.say(f"RED as expected under sabotage {args.sabotage}: the control sees the failure")
    elif code == EXIT_SABOTAGE_NOT_DETECTED:
        ctx.say(f"SABOTAGE NOT DETECTED: a control stayed green under {args.sabotage}")
    else:
        ctx.say("REPLICATION CLIENT NOT ADEQUATE: a control failed on the correct ordering. BACKUP_ADMIN stays in the grant list.")
    return code


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true", help="run the verdict functions on canned red and green inputs")
    sub = parser.add_subparsers(dest="command")
    runner = sub.add_parser("run", help="run the controls against two running containers (prove-replication-client.sh does this)")
    runner.add_argument("--source", required=True)
    runner.add_argument("--replica", required=True)
    runner.add_argument("--workdir", required=True)
    runner.add_argument("--controls", default="1 2 3")
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
