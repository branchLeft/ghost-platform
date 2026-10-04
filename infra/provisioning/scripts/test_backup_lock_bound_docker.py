#!/usr/bin/env python3
"""The bounded snapshot end to end against db1's pinned image and config:
three tenant schemas with a writer each, full runs of `run_nightly_loop`
(real `RemoteMysqldumpTransport`) and of `dump_nightly.run_mysqldump`. No
writer's insert may take two seconds, under a long query or an open write
transaction. In CI a missing Docker or image fails; locally it skips. See
db/provision/bounded_snapshot.md."""

from __future__ import annotations

import contextlib
import io
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from unittest import mock

import backup_worker as bw
import nightly_dump_loop as ndl
from dial_in_transport import RemoteMysqldumpTransport

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_DB_PROVISION = _REPO_ROOT / "db" / "provision"
if str(_DB_PROVISION) not in sys.path:
    sys.path.insert(0, str(_DB_PROVISION))

import bounded_snapshot  # noqa: E402
import dump_nightly  # noqa: E402
import extract_tenant_binlog  # noqa: E402

_PIN = re.compile(r"mysql:8\.0@sha256:[0-9a-f]{64}")
_REQUIRED = os.environ.get("CI") == "true" or os.environ.get("BACKUP_LOCK_BOUND_DOCKER") == "required"

ROOT_PASSWORD = "throwaway-root-pwd"
WORKER_PASSWORD = "throwaway-worker-pwd"
DB1_BACKUP_PASSWORD = "throwaway-db1-backup-pwd"
TENANTS = ("alpha", "bravo", "charlie")
WRITER_BOUND_SECONDS = 2.0
SOCKET = "/var/run/mysqld/mysqld.sock"
CA_IN_CONTAINER = "/var/lib/mysql/ca.pem"


def pinned_image() -> str:
    """The one digest db1 runs, read from the runbook rather than restated,
    so a re-pin there re-points this proof too."""
    pins = set(_PIN.findall((_REPO_ROOT / "db" / "RUNBOOK-db.md").read_text(encoding="utf-8")))
    if len(pins) != 1:
        raise AssertionError(f"db/RUNBOOK-db.md pins {sorted(pins)}; expected exactly one mysql:8.0 digest")
    return pins.pop()


def recovery_toolchain_image() -> str:
    """The recovery image `db/RUNBOOK-db.md` pins: the toolchain point-in-time
    replay actually runs with."""
    pins = set(re.findall(r"ghcr\.io/branchleft/db-recovery@sha256:[0-9a-f]{64}", (_REPO_ROOT / "db" / "RUNBOOK-db.md").read_text(encoding="utf-8")))
    if len(pins) != 1:
        raise AssertionError(f"db/RUNBOOK-db.md pins {sorted(pins)}; expected exactly one db-recovery digest")
    return pins.pop()


def _unavailable(reason: str):
    if _REQUIRED:
        raise AssertionError(f"the lock-bound proof cannot run in CI: {reason}")
    raise unittest.SkipTest(reason)


class _Container:
    def __init__(self, image: str) -> None:
        self.image = image
        self.name = f"backup-lock-bound-{uuid.uuid4().hex[:8]}"
        self.conf_dir = tempfile.mkdtemp()

    def start(self) -> None:
        cnf = (_REPO_ROOT / "db" / "stack" / "conf.d" / "branchleft.cnf").read_text(encoding="utf-8")
        # db1 binds its private address; a container binds its own.
        cnf = re.sub(r"(?m)^bind-address\s*=.*$", "bind-address = 0.0.0.0", cnf)
        conf_path = os.path.join(self.conf_dir, "branchleft.cnf")
        with open(conf_path, "w", encoding="utf-8") as handle:
            handle.write(cnf)
        os.chmod(self.conf_dir, 0o755)
        os.chmod(conf_path, 0o644)
        started = subprocess.run(
            [
                "docker", "run", "-d", "--name", self.name, "--platform", "linux/amd64",
                "-e", f"MYSQL_ROOT_PASSWORD={ROOT_PASSWORD}",
                "-v", f"{conf_path}:/etc/mysql/conf.d/branchleft.cnf:ro",
                self.image,
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        if started.returncode != 0:
            _unavailable(f"cannot start {self.image}: {started.stderr.strip()}")
        deadline = time.monotonic() + 240
        while time.monotonic() < deadline:
            probe = self.root("SELECT @@log_bin", tcp=True)
            if probe.returncode == 0 and probe.stdout.strip() == "1":
                return
            time.sleep(2)
        raise AssertionError(f"{self.image} never answered over TLS: {probe.stderr}")

    def stop(self) -> None:
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True, check=False)
        shutil.rmtree(self.conf_dir, ignore_errors=True)

    def root(self, sql: str, *, tcp: bool = False) -> subprocess.CompletedProcess:
        transport = ["--protocol=TCP", "--host=127.0.0.1", "--ssl-mode=REQUIRED"] if tcp else []
        return subprocess.run(
            ["docker", "exec", "-e", f"MYSQL_PWD={ROOT_PASSWORD}", self.name, "mysql", "-uroot", *transport, "-N", "-B", "-e", sql],
            capture_output=True,
            text=True,
            check=False,
        )

    def root_ok(self, sql: str) -> str:
        result = self.root(sql)
        if result.returncode != 0:
            raise AssertionError(f"{sql[:80]!r} failed: {result.stderr}")
        return result.stdout

    def root_session(self) -> subprocess.Popen:
        return subprocess.Popen(
            ["docker", "exec", "-i", "-e", f"MYSQL_PWD={ROOT_PASSWORD}", self.name, "mysql", "-uroot", "-N", "-B", "-n"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )

    def popen(self, argv, *, env=None, pass_fds=(), **kwargs):
        """What `ClientFactory` hands its `popen`, run inside the container:
        the option file's password becomes the exec's MYSQL_PWD, since a
        passed fd cannot cross `docker exec`."""
        password = None
        inner = []
        for arg in argv:
            if arg.startswith("--defaults-extra-file=/dev/fd/"):
                fd = int(arg.rsplit("/", 1)[1])
                password = os.read(fd, 4096).decode().split("password=", 1)[1].strip()
                continue
            inner.append(arg)
        return subprocess.Popen(
            ["docker", "exec", "-i", "-e", f"MYSQL_PWD={password}", self.name, *inner], **kwargs
        )


class _Writer(threading.Thread):
    """One tenant's writer: a single session inserting one row at a time and
    timing each insert to its acknowledgement."""

    def __init__(self, container: _Container, schema: str, *, pause: float = 0.05, update: bool = False) -> None:
        super().__init__(daemon=True)
        self.schema = schema
        self.pause = pause
        self.update = update
        self.samples: list[tuple[float, float]] = []
        self.halt = threading.Event()
        self.session = container.root_session()

    def run(self) -> None:
        sequence = 0
        while not self.halt.is_set():
            sequence += 1
            token = f"w{sequence}"
            began = time.monotonic()
            update = f"UPDATE {self.schema}.settings SET value = '{token}' WHERE id = 1; " if self.update else ""
            self.session.stdin.write(
                f"INSERT INTO {self.schema}.posts (title) VALUES ('{token}'); {update}SELECT '{token}';\n".encode()
            )
            self.session.stdin.flush()
            while True:
                line = self.session.stdout.readline()
                if not line or line.strip().decode() == token:
                    break
            if not line:
                return
            self.samples.append((began, time.monotonic() - began))
            time.sleep(self.pause)

    def finish(self) -> list[tuple[float, float]]:
        self.halt.set()
        self.join(timeout=60)
        self.session.stdin.close()
        self.session.wait(timeout=30)
        self.session.stdout.close()
        return self.samples


@contextlib.contextmanager
def _writers(container: _Container):
    writers = {tenant: _Writer(container, f"ghost_{tenant}") for tenant in TENANTS}
    for writer in writers.values():
        writer.start()
    time.sleep(1.0)
    window = {"began": time.monotonic()}
    try:
        yield writers, window
    finally:
        window["ended"] = time.monotonic()
        for writer in writers.values():
            writer.finish()


class BackupLockBoundAgainstDb1sImageTests(unittest.TestCase):
    container: _Container

    @classmethod
    def setUpClass(cls) -> None:
        if shutil.which("docker") is None:
            _unavailable("docker is not installed")
        if subprocess.run(["docker", "info"], capture_output=True, check=False).returncode != 0:
            _unavailable("docker is not running")
        if shutil.which("age") is None or shutil.which("age-keygen") is None:
            _unavailable("age is not installed")
        image = pinned_image()
        pulled = subprocess.run(["docker", "pull", "--platform", "linux/amd64", "-q", image], capture_output=True, text=True, check=False)
        if pulled.returncode != 0 and subprocess.run(["docker", "image", "inspect", image], capture_output=True, check=False).returncode != 0:
            _unavailable(f"cannot pull {image}: {pulled.stderr.strip()}")
        cls.container = _Container(image)
        cls.addClassCleanup(cls.container.stop)
        cls.container.start()
        cls.server_version = cls.container.root_ok("SELECT @@version").strip()
        statements = ["SET GLOBAL log_output = 'TABLE'", "SET GLOBAL general_log = 'ON'"]
        for tenant in TENANTS:
            schema = f"ghost_{tenant}"
            statements += [
                f"CREATE DATABASE {schema}",
                f"CREATE TABLE {schema}.users (id INT PRIMARY KEY, name VARCHAR(64))",
                f"INSERT INTO {schema}.users VALUES (1, 'OWNER')",
                f"CREATE TABLE {schema}.settings (id INT PRIMARY KEY, value VARCHAR(64))",
                f"INSERT INTO {schema}.settings VALUES (1, 'TITLE')",
                f"CREATE TABLE {schema}.posts (id INT AUTO_INCREMENT PRIMARY KEY, title VARCHAR(64))",
                f"INSERT INTO {schema}.posts (title) VALUES ('seed')",
            ]
            statements += [f"CREATE TABLE {schema}.filler_{n} (id INT PRIMARY KEY)" for n in range(20)]
        statements += [
            f"CREATE USER 'backup_ops1'@'%' IDENTIFIED BY '{WORKER_PASSWORD}' REQUIRE SSL",
            "GRANT SELECT, SHOW VIEW, TRIGGER, LOCK TABLES, BACKUP_ADMIN ON *.* TO 'backup_ops1'@'%'",
            f"CREATE USER 'backup'@'localhost' IDENTIFIED BY '{DB1_BACKUP_PASSWORD}'",
            "GRANT SELECT, LOCK TABLES, SHOW VIEW, EVENT, TRIGGER, PROCESS, REPLICATION CLIENT, BACKUP_ADMIN "
            "ON *.* TO 'backup'@'localhost'",
        ]
        cls.container.root_ok("; ".join(statements) + ";")
        cls.tmp = tempfile.mkdtemp()
        cls.addClassCleanup(lambda: shutil.rmtree(cls.tmp, ignore_errors=True))
        cls.identity = os.path.join(cls.tmp, "identity.age")
        keygen = subprocess.run(["age-keygen", "-o", cls.identity], capture_output=True, text=True, check=True)
        cls.recipient = keygen.stderr.strip().rsplit(" ", 1)[-1]

    def setUp(self) -> None:
        self.container.root_ok("TRUNCATE mysql.general_log;")
        self.metrics_dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.metrics_dir, True)
        self.stored: dict[str, bytes] = {}
        copy_env = {
            "BACKUP_WORKER_COPY_PRIMARY_BUCKET": "throwaway-bucket",
            "BACKUP_WORKER_COPY_PRIMARY_ENDPOINT": "objectstorage.invalid",
            "BACKUP_WORKER_COPY_PRIMARY_REGION": "none",
            "BACKUP_WORKER_COPY_PRIMARY_ACCESS_KEY_ID": "none",
            "BACKUP_WORKER_COPY_PRIMARY_SECRET_ACCESS_KEY": "none",
        }
        patches = [
            mock.patch.dict(os.environ, copy_env),
            mock.patch.object(bw.shared_objectstorage, "put_object", side_effect=self._store),
        ]
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)

    def _store(self, *, key: str, data: bytes, **_) -> None:
        self.stored[key.split("/")[1]] = data

    def _nightly_run(self) -> list[ndl.TenantOutcome]:
        transport = RemoteMysqldumpTransport(
            host="127.0.0.1", port=3306, user="backup_ops1", ssl_ca=CA_IN_CONTAINER, popen=self.container.popen
        )
        with contextlib.redirect_stdout(io.StringIO()):
            return ndl.run_nightly_loop(
                tenants=list(TENANTS),
                transport=transport,
                mysql_pwd=WORKER_PASSWORD,
                age_recipient=self.recipient,
                dump_tenant_path="/unused",
                socket_path="/unused",
                metrics_dir=self.metrics_dir,
            )

    def _decrypt(self, tenant: str) -> str:
        result = subprocess.run(["age", "--decrypt", "-i", self.identity], input=self.stored[tenant], capture_output=True, check=True)
        return result.stdout.decode()

    def _flushes_by_backup_accounts(self) -> list[str]:
        return [
            line
            for line in self.container.root_ok(
                "SELECT argument FROM mysql.general_log WHERE user_host LIKE 'backup%' AND argument LIKE '%FLUSH%';"
            ).splitlines()
            if line.strip()
        ]

    def _assert_no_writer_stalled(self, writers, window) -> None:
        for tenant, writer in writers.items():
            during = [latency for began, latency in writer.samples if window["began"] <= began <= window["ended"]]
            self.assertGreater(len(during), 5, f"{tenant}'s writer barely ran during the backup")
            self.assertLess(max(during), WRITER_BOUND_SECONDS, f"{tenant}'s writer stalled {max(during):.2f}s")

    def _hold_long_query(self, schema: str) -> subprocess.Popen:
        session = self.container.root_session()
        session.stdin.write(f"SELECT SLEEP(60) FROM {schema}.posts LIMIT 1;\n".encode())
        session.stdin.flush()
        self.addCleanup(self._end_session, session)
        self._await(lambda: "SLEEP(60)" in self.container.root_ok("SELECT INFO FROM information_schema.PROCESSLIST;"))
        return session

    def _hold_open_transaction(self, schema: str, seconds: float) -> subprocess.Popen:
        session = self.container.root_session()
        session.stdin.write(
            f"BEGIN; INSERT INTO {schema}.posts (title) VALUES ('held'); SELECT SLEEP({seconds}); COMMIT;\n".encode()
        )
        session.stdin.flush()
        self.addCleanup(self._end_session, session)
        self._await(lambda: f"SLEEP({seconds})" in self.container.root_ok("SELECT INFO FROM information_schema.PROCESSLIST;"))
        return session

    def _end_session(self, session: subprocess.Popen) -> None:
        for row in self.container.root_ok(
            "SELECT ID FROM information_schema.PROCESSLIST WHERE INFO LIKE 'SELECT SLEEP%';"
        ).split():
            self.container.root(f"KILL {int(row)};")
        session.stdin.close()
        session.wait(timeout=30)
        session.stdout.close()

    @staticmethod
    def _await(condition, timeout: float = 30.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if condition():
                return
            time.sleep(0.2)
        raise AssertionError("condition never held")

    def _read_metrics(self) -> str:
        return "".join(
            path.read_text() for path in sorted(pathlib.Path(self.metrics_dir).glob("*.prom"))
        )

    def test_a_quiet_night_dumps_every_tenant_with_no_global_lock(self) -> None:
        with _writers(self.container) as (writers, window):
            outcomes = self._nightly_run()
        self.assertEqual([o.error for o in outcomes if not o.ok], [])
        self._assert_no_writer_stalled(writers, window)
        self.assertEqual(self._flushes_by_backup_accounts(), [])
        for tenant in TENANTS:
            plaintext = self._decrypt(tenant)
            log_file, position = extract_tenant_binlog.find_resume_point(
                io.StringIO(plaintext), tenant_database=f"ghost_{tenant}"
            )
            self.assertTrue(log_file.startswith("mysql-bin."))
            self.assertGreater(position, 0)
            self.assertNotIn("ghost_" + next(t for t in TENANTS if t != tenant), plaintext)
        for outcome in outcomes:
            self.assertLess(outcome.result.lock_hold_seconds, bounded_snapshot.HOLD_BOUND_SECONDS)
        metrics = self._read_metrics()
        for tenant in TENANTS:
            self.assertRegex(metrics, rf'backup_worker_lock_aborts_total\{{tenant="{tenant}"\}} [0-9]+')
            self.assertIn(f'backup_worker_lock_hold_seconds{{tenant="{tenant}"}}', metrics)
            self.assertIn(f'backup_worker_lock_wait_seconds{{tenant="{tenant}"}}', metrics)

    def test_a_long_query_on_one_tenants_table_stalls_no_writer(self) -> None:
        with _writers(self.container) as (writers, window):
            self._hold_long_query("ghost_alpha")
            outcomes = self._nightly_run()
        self.assertEqual([o.error for o in outcomes if not o.ok], [])
        self._assert_no_writer_stalled(writers, window)
        self.assertEqual(self._flushes_by_backup_accounts(), [])

    def test_an_open_write_transaction_aborts_retries_and_succeeds(self) -> None:
        with _writers(self.container) as (writers, window):
            self._hold_open_transaction("ghost_alpha", 3.5)
            outcomes = self._nightly_run()
        by_tenant = {o.tenant: o for o in outcomes}
        self.assertTrue(by_tenant["alpha"].ok, by_tenant["alpha"].error)
        self.assertGreaterEqual(by_tenant["alpha"].result.lock_aborts, 1)
        self.assertTrue(by_tenant["bravo"].ok and by_tenant["charlie"].ok)
        self._assert_no_writer_stalled(writers, window)
        self.assertRegex(self._read_metrics(), r'backup_worker_lock_aborts_total\{tenant="alpha"\} [1-9]')

    def _db1_dump(self) -> tuple[bounded_snapshot.SnapshotReport, str]:
        out_path = os.path.join(self.metrics_dir, "db1.sql")
        with contextlib.redirect_stderr(io.StringIO()):
            report = dump_nightly.run_mysqldump(
                socket_path=SOCKET, password=DB1_BACKUP_PASSWORD, out_path=out_path, popen=self.container.popen
            )
        with open(out_path, encoding="utf-8") as handle:
            return report, handle.read()

    def test_db1s_nightly_dump_under_a_long_query_stalls_no_writer(self) -> None:
        with _writers(self.container) as (writers, window):
            self._hold_long_query("ghost_alpha")
            report, plaintext = self._db1_dump()
        self._assert_no_writer_stalled(writers, window)
        self.assertEqual(self._flushes_by_backup_accounts(), [])
        self.assertLess(report.hold_seconds, bounded_snapshot.HOLD_BOUND_SECONDS)
        for tenant in TENANTS:
            extract_tenant_binlog.find_resume_point(io.StringIO(plaintext), tenant_database=f"ghost_{tenant}")

    def test_db1s_nightly_dump_retries_past_an_open_transaction(self) -> None:
        with _writers(self.container) as (writers, window):
            self._hold_open_transaction("ghost_charlie", 3.5)
            report, _ = self._db1_dump()
        self.assertGreaterEqual(report.aborted_attempts, 1)
        self._assert_no_writer_stalled(writers, window)

    @staticmethod
    def _checksums(container: _Container, schema: str) -> dict[str, str]:
        tables = [f"{schema}.{name}" for name in ("users", "settings", "posts")]
        rows = container.root_ok(f"CHECKSUM TABLE {', '.join(tables)};").splitlines()
        counts = container.root_ok(
            " UNION ALL ".join(f"SELECT '{t}', COUNT(*) FROM {t}" for t in tables) + ";"
        ).splitlines()
        return {"checksums": sorted(rows), "counts": sorted(counts)}

    def test_the_recorded_position_replays_to_the_source_exactly(self) -> None:
        """The position is measured, not argued: dump one tenant under heavy
        concurrent writes, restore it into a fresh server of the same image,
        replay the binary log from the dump's own comment with the PITR
        tool's own extract, and compare every table with the source."""
        schema = "ghost_alpha"
        writers = [_Writer(self.container, schema, pause=0.0, update=True) for _ in range(3)]
        for writer in writers:
            writer.start()
        time.sleep(1.0)
        transport = RemoteMysqldumpTransport(
            host="127.0.0.1", port=3306, user="backup_ops1", ssl_ca=CA_IN_CONTAINER, popen=self.container.popen
        )
        sink = io.BytesIO()
        with contextlib.redirect_stderr(io.StringIO()):
            exit_code = transport.run(
                command=["python3", "/unused", "alpha"], env={"DB_DUMP_MYSQL_PWD": WORKER_PASSWORD}, stdout=sink
            )
        time.sleep(1.5)
        for writer in writers:
            writer.finish()
        self.assertEqual(exit_code, 0)
        dump = sink.getvalue()
        log_file, position = extract_tenant_binlog.find_resume_point(io.StringIO(dump.decode()), tenant_database=schema)
        source = self._checksums(self.container, schema)

        binlogs = [row.split()[0] for row in self.container.root_ok("SHOW BINARY LOGS;").splitlines()]
        paths = [f"/var/lib/mysql/{name}" for name in binlogs if name >= log_file]

        recovery_image = recovery_toolchain_image()

        def in_source_container(argv, **kwargs):
            # The PITR toolchain image, reading the source's binary logs from
            # its data volume: the server image ships no mysqlbinlog.
            kwargs.pop("env", None)
            return subprocess.run(
                [
                    "docker", "run", "--rm", "--user", "0", "-e", "TZ=UTC",
                    "--volumes-from", f"{self.container.name}:ro", "--entrypoint", argv[0],
                    recovery_image, *argv[1:],
                ],
                **kwargs,
            )

        stream = extract_tenant_binlog.extract_tenant_stream(
            paths, database=schema, start_position=position, run=in_source_container
        )
        self.assertIn(f"Table_map: `{schema}`.`posts`".encode(), stream, "no write landed after the snapshot")

        fresh = _Container(self.container.image)
        self.addCleanup(fresh.stop)
        fresh.start()
        for sql in (dump, stream):
            loaded = subprocess.run(
                ["docker", "exec", "-i", "-e", f"MYSQL_PWD={ROOT_PASSWORD}", fresh.name, "mysql", "-uroot"],
                input=sql,
                capture_output=True,
                check=False,
            )
            self.assertEqual(loaded.returncode, 0, loaded.stderr.decode(errors="replace"))
        self.assertEqual(self._checksums(fresh, schema), source)

    def test_the_proof_ran_on_db1s_server_line(self) -> None:
        self.assertTrue(self.server_version.startswith("8.0."), self.server_version)


if __name__ == "__main__":
    unittest.main()
