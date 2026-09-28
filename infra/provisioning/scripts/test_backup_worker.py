#!/usr/bin/env python3
"""Unit tests for backup_worker.py, through its real entry points, against
the REAL `dump_tenant.py`. `mysql`/`mysqldump` are faked as tiny shell
scripts on `PATH`. `RunTenantDumpAgainstTheRealMysqldumpTransportTests`
runs a real `mysqldump` through the real `RemoteMysqldumpTransport`
(`route=b`); `RemoteMysqldumpAgainstARealMysqlContainerTests` runs that
against a real MySQL server, skipping cleanly without Docker. `age` is
real throughout; only the storage credential path is faked.
"""

from __future__ import annotations

import contextlib
import io
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock

import backup_worker as bw
from dial_in_transport import LocalProcessTransport, RemoteMysqldumpTransport
from pull_encrypt_store import CopyTarget

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_DUMP_TENANT_PATH = str(_REPO_ROOT / "db" / "provision" / "dump_tenant.py")

# Stands in for the real `mysql` client: dump_tenant.py's check_floor()
# calls this twice (once per floor table) with a `SELECT COUNT(*)` and
# expects a bare row count on stdout. Always reports a nonzero count, so
# the pre-check always passes -- these tests exercise the worker's own
# plumbing, not MySQL's counting.
_FAKE_MYSQL = """#!/bin/sh
echo 5"""

_FAKE_MYSQLDUMP_HAPPY = """#!/bin/sh
echo "-- MySQL dump 10.13"
echo "INSERT INTO \\`users\\` VALUES ('u1','Owner');"
echo "INSERT INTO \\`settings\\` VALUES ('s1','title','Blog');"
exit 0"""

_FAKE_MYSQLDUMP_MISSING_SETTINGS = """#!/bin/sh
echo "-- MySQL dump 10.13 (--no-data)"
echo "INSERT INTO \\`users\\` VALUES ('u1','Owner');"
exit 0"""


def _write_fake_bin(directory: str, name: str, contents: str) -> None:
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(contents)
    os.chmod(path, 0o755)


def _generate_age_identity() -> tuple[str, str]:
    fd, path = tempfile.mkstemp(suffix=".age-key")
    os.close(fd)
    os.remove(path)
    result = subprocess.run(["age-keygen", "-o", path], capture_output=True, text=True, check=True)
    recipient = result.stderr.strip().rsplit(" ", 1)[-1]
    return path, recipient


class _FileCopy:
    """A CopyTarget backed by a plain local file -- standing in for one of
    the two cloud copies (see the module docstring: neither cloud
    credential is this story's to provision)."""

    def __init__(self, name: str, directory: str) -> None:
        self.name = name
        self.path = os.path.join(directory, f"{name}.age")

    def put(self, ciphertext: bytes) -> None:
        with open(self.path, "wb") as handle:
            handle.write(ciphertext)

    def as_target(self) -> CopyTarget:
        return CopyTarget(name=self.name, put=self.put)


class RunTenantDumpAgainstTheRealProducerTests(unittest.TestCase):
    """Every test in this class runs through `backup_worker.run_tenant_dump`
    -- the real entry point -- with `LocalProcessTransport` spawning the
    real `dump_tenant.py`."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(self.bin_dir)
        _write_fake_bin(self.bin_dir, "mysql", _FAKE_MYSQL)

        self.identity_a, self.recipient_a = _generate_age_identity()
        self.identity_b, self.recipient_b = _generate_age_identity()

        self.copies_dir = os.path.join(self.tmp.name, "copies")
        os.makedirs(self.copies_dir)
        self.primary = _FileCopy("primary", self.copies_dir)
        self.secondary = _FileCopy("secondary", self.copies_dir)

        self._path_patch = mock.patch.dict(
            os.environ, {"PATH": self.bin_dir + os.pathsep + os.environ.get("PATH", "")}
        )
        self._path_patch.start()
        self.addCleanup(self._path_patch.stop)

    def _run(self, tenant: str = "blog") -> bw.DumpResult:
        return bw.run_tenant_dump(
            tenant=tenant,
            transport=LocalProcessTransport(),
            mysql_pwd="irrelevant-fake-password",
            age_recipient=self.recipient_a,
            copies=[self.primary.as_target(), self.secondary.as_target()],
            dump_tenant_path=_DUMP_TENANT_PATH,
        )

    def test_happy_path_reports_ok_true_with_both_floor_tables_seen(self) -> None:
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY)
        result = self._run()
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.floor_tables_seen, frozenset({"users", "settings"}))
        self.assertEqual(result.missing_floor_tables, frozenset())
        self.assertEqual(result.copies_written, ("primary", "secondary"))

    def test_the_stored_object_decrypts_with_the_owning_tenants_identity(self) -> None:
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY)
        self._run()
        with open(self.primary.path, "rb") as handle:
            ciphertext = handle.read()
        decrypted = subprocess.run(
            ["age", "--decrypt", "-i", self.identity_a], input=ciphertext, capture_output=True, check=True
        )
        self.assertIn(b"INSERT INTO `users`", decrypted.stdout)

    def test_the_stored_object_never_decrypts_with_a_different_tenants_identity(self) -> None:
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY)
        self._run()
        with open(self.primary.path, "rb") as handle:
            ciphertext = handle.read()
        wrong = subprocess.run(
            ["age", "--decrypt", "-i", self.identity_b], input=ciphertext, capture_output=True, check=False
        )
        self.assertNotEqual(wrong.returncode, 0)

    def test_a_dump_missing_the_settings_floor_writes_to_no_copy(self) -> None:
        """The exact reviewer-measured defect dump_tenant.py's own tests
        name: mysqldump exits 0 having written no INSERT for a floor
        table. This worker's OWN independent watch (backup_worker.py's
        _FloorWatcher, gating via post_stream_check) must refuse to store
        it -- proving the gate through the real entry point, not just
        pull_encrypt_store.py's own unit tests."""
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_MISSING_SETTINGS)
        result = self._run()
        self.assertFalse(result.ok)
        self.assertEqual(result.missing_floor_tables, frozenset({"settings"}))
        self.assertEqual(result.copies_written, ())
        self.assertFalse(os.path.exists(self.primary.path))
        self.assertFalse(os.path.exists(self.secondary.path))

    def test_env_passed_to_the_real_producer_carries_no_storage_credential(self) -> None:
        """dump_tenant.py itself refuses to start if AWS_*/DB_BACKUP_*/AGE_*
        is in ITS environment -- this proves the worker never even offers
        it the chance, by running with those variables present in the
        WORKER's own ambient environment (legitimately, for its own
        storage calls) and confirming the real producer still succeeds
        rather than refusing."""
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY)
        with mock.patch.dict(os.environ, {"AWS_ACCESS_KEY_ID": "worker-holds-this-legitimately"}):
            result = self._run()
        self.assertTrue(result.ok, result.error)

    def test_an_invalid_tenant_name_never_reaches_the_transport(self) -> None:
        with self.assertRaises(bw.InvalidTenantName):
            self._run(tenant="Not Valid!")
        self.assertFalse(os.path.exists(self.primary.path))


class RunTenantDumpAgainstTheRealMysqldumpTransportTests(unittest.TestCase):
    """`backup_worker.py` against the real transport (`route=b`): a real
    `mysqldump` subprocess run by `RemoteMysqldumpTransport`, faked here
    only as a tiny shell script on `PATH` (the same technique
    `RunTenantDumpAgainstTheRealProducerTests` uses for `LocalProcessTransport`)
    -- everything else (the transport's own argv construction, the
    process boundary, streaming, the worker's floor watch, encryption and
    storage) is real, unmocked code."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(self.bin_dir)

        self.identity_a, self.recipient_a = _generate_age_identity()
        self.copies_dir = os.path.join(self.tmp.name, "copies")
        os.makedirs(self.copies_dir)
        self.primary = _FileCopy("primary", self.copies_dir)

        self._path_patch = mock.patch.dict(
            os.environ, {"PATH": self.bin_dir + os.pathsep + os.environ.get("PATH", "")}
        )
        self._path_patch.start()
        self.addCleanup(self._path_patch.stop)

    def _run(self, tenant: str = "blog") -> bw.DumpResult:
        transport = RemoteMysqldumpTransport(
            host="10.20.1.20", user="backup_ops1", ssl_ca="/etc/branchleft/mysql-ca.pem"
        )
        return bw.run_tenant_dump(
            tenant=tenant,
            transport=transport,
            mysql_pwd="irrelevant-fake-password",
            age_recipient=self.recipient_a,
            copies=[self.primary.as_target()],
            dump_tenant_path=_DUMP_TENANT_PATH,  # ignored by the real transport; kept for the call shape
        )

    def test_happy_path_through_a_real_mysqldump_subprocess(self) -> None:
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY)
        result = self._run()
        self.assertTrue(result.ok, result.error)
        self.assertEqual(result.exit_code, 0)
        self.assertEqual(result.floor_tables_seen, frozenset({"users", "settings"}))
        self.assertEqual(result.copies_written, ("primary",))
        with open(self.primary.path, "rb") as handle:
            ciphertext = handle.read()
        decrypted = subprocess.run(
            ["age", "--decrypt", "-i", self.identity_a], input=ciphertext, capture_output=True, check=True
        )
        self.assertIn(b"INSERT INTO `users`", decrypted.stdout)

    def test_a_dump_missing_the_settings_floor_writes_to_no_copy(self) -> None:
        """The same missing-floor defect `RunTenantDumpAgainstTheRealProducerTests`
        proves for `LocalProcessTransport`, proven again here through the
        real transport: the worker's own `_FloorWatcher` observes
        `mysqldump`'s stream directly as it arrives (there is no server
        side to buffer it away this time), sees only `users`, and refuses
        to store."""
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_MISSING_SETTINGS)
        result = self._run()
        self.assertFalse(result.ok)
        self.assertEqual(result.missing_floor_tables, frozenset({"settings"}))
        self.assertEqual(result.copies_written, ())
        self.assertFalse(os.path.exists(self.primary.path))

    def test_a_nonzero_exit_writes_to_no_copy(self) -> None:
        _write_fake_bin(self.bin_dir, "mysqldump", "#!/bin/sh\necho partial\nexit 1")
        result = self._run()
        self.assertFalse(result.ok)
        self.assertEqual(result.copies_written, ())


def _docker_answers_within(seconds: float) -> bool:
    if shutil.which("docker") is None:
        return False
    try:
        subprocess.run(["docker", "info"], capture_output=True, timeout=seconds, check=True)
        return True
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
        return False


_MYSQL_CONTAINER_NAME = "backup-worker-remote-mysqldump-tls-proof"


class RemoteMysqldumpAgainstARealMysqlContainerTests(unittest.TestCase):
    """The other half of the two-process harness `route=b` asks for: a
    real MySQL 8 server, in a local Docker container, `mysqldump`
    negotiating real TLS against that server's own auto-generated
    certificate, through a TLS-required, grant-limited account -- nothing
    faked but the container's throwaway data. Skips (never fails) when
    Docker itself doesn't answer within 20s, since it is shared
    infrastructure another session may be restarting."""

    @classmethod
    def setUpClass(cls) -> None:
        if not _docker_answers_within(20):
            raise unittest.SkipTest("docker did not answer within 20s")
        cls.root_pwd = "throwaway-root-pwd"
        cls.worker_pwd = "throwaway-worker-pwd"
        subprocess.run(["docker", "rm", "-f", _MYSQL_CONTAINER_NAME], capture_output=True, check=False)
        run = subprocess.run(
            [
                "docker", "run", "-d", "--name", _MYSQL_CONTAINER_NAME,
                "-e", f"MYSQL_ROOT_PASSWORD={cls.root_pwd}",
                "-p", "127.0.0.1::3306",
                "mysql:8.0",
            ],
            capture_output=True,
            text=True,
        )
        if run.returncode != 0:
            raise unittest.SkipTest(f"docker run failed: {run.stderr.strip()}")
        cls.addClassCleanup(
            lambda: subprocess.run(["docker", "rm", "-f", _MYSQL_CONTAINER_NAME], capture_output=True, check=False)
        )
        cls._wait_for_mysqld_ready()
        port_out = subprocess.run(
            ["docker", "port", _MYSQL_CONTAINER_NAME, "3306"], capture_output=True, text=True, check=True
        )
        cls.port = int(port_out.stdout.strip().rsplit(":", 1)[-1])
        cls._provision_database_and_account()
        cls.ssl_ca_dir = tempfile.mkdtemp()
        cls.addClassCleanup(lambda: shutil.rmtree(cls.ssl_ca_dir, ignore_errors=True))
        cls.ssl_ca_path = os.path.join(cls.ssl_ca_dir, "ca.pem")
        subprocess.run(
            ["docker", "cp", f"{_MYSQL_CONTAINER_NAME}:/var/lib/mysql/ca.pem", cls.ssl_ca_path],
            check=True,
        )

    @classmethod
    def _wait_for_mysqld_ready(cls, *, deadline_s: float = 90.0) -> None:
        """`mysqladmin ping` returns 0 even against MySQL's own transient,
        socket-only init server (and even on access-denied) -- it cannot
        tell "the real server is up" from "something answered". This polls
        with the same real, authenticated, TLS-required query
        `RemoteMysqldumpTransport` itself makes -- over TCP, inside the
        container -- so a pass here means the real server, with real TLS
        materials and the real root password, is actually ready. Once the
        container is running at all, a timeout here is a genuine CI
        failure, never a silent skip -- this is the one live proof of
        VERIFY_CA and the grant set."""
        start = time.monotonic()
        last_stderr = b""
        while time.monotonic() - start < deadline_s:
            probe = subprocess.run(
                [
                    "docker", "exec", _MYSQL_CONTAINER_NAME,
                    "mysql", "--protocol=TCP", "--host=127.0.0.1", "--ssl-mode=REQUIRED",
                    "-uroot", f"-p{cls.root_pwd}", "-e", "SELECT 1",
                ],
                capture_output=True,
            )
            if probe.returncode == 0:
                return
            last_stderr = probe.stderr
            time.sleep(1)
        raise AssertionError(
            f"mysqld in the container never answered an authenticated TLS query within "
            f"{deadline_s}s: {last_stderr.decode(errors='replace')}"
        )

    @classmethod
    def _provision_database_and_account(cls) -> None:
        # One row per floor table, real GRANTs, real REQUIRE SSL, matching
        # db/RUNBOOK-db.md's "Backup worker account" grant set (LOCK
        # TABLES and EVENT dropped; this test confirms mysqldump still
        # runs without them). `backup_ops1` stays host-'%' -- this test's
        # client reaches the container through Docker's NAT, whose source
        # address inside the container isn't reliably 127.0.0.1. Host
        # restriction is proven instead by `backup_right_host`/
        # `backup_wrong_host`, a control pair tested container-internally.
        sql_template = (
            "CREATE DATABASE ghost_blog;"
            "CREATE TABLE ghost_blog.users (id INT PRIMARY KEY, name VARCHAR(64));"
            "INSERT INTO ghost_blog.users VALUES (1, 'Owner');"
            "CREATE TABLE ghost_blog.settings (id INT PRIMARY KEY, value VARCHAR(64));"
            "INSERT INTO ghost_blog.settings VALUES (1, 'title');"
            "CREATE USER 'backup_ops1'@'%' IDENTIFIED BY '{worker_pwd}' REQUIRE SSL;"
            "GRANT SELECT, SHOW VIEW, TRIGGER, PROCESS, RELOAD, REPLICATION CLIENT "
            "ON *.* TO 'backup_ops1'@'%';"
            "CREATE USER 'backup_right_host'@'127.0.0.1' IDENTIFIED BY '{right_host_pwd}' REQUIRE SSL;"
            "GRANT SELECT ON *.* TO 'backup_right_host'@'127.0.0.1';"
            "CREATE USER 'backup_wrong_host'@'10.99.99.99' IDENTIFIED BY '{wrong_host_pwd}' REQUIRE SSL;"
            "GRANT SELECT ON *.* TO 'backup_wrong_host'@'10.99.99.99';"
            "FLUSH PRIVILEGES;"
        )
        cls.right_host_pwd = "throwaway-right-host-pwd"
        cls.wrong_host_pwd = "throwaway-wrong-host-pwd"
        sql = sql_template.format(
            worker_pwd=cls.worker_pwd, right_host_pwd=cls.right_host_pwd, wrong_host_pwd=cls.wrong_host_pwd
        )
        subprocess.run(
            ["docker", "exec", "-i", _MYSQL_CONTAINER_NAME, "mysql", "-uroot", f"-p{cls.root_pwd}"],
            input=sql,
            text=True,
            check=True,
            capture_output=True,
        )

    def _mysql_probe(self, *, user: str, password: str) -> subprocess.CompletedProcess:
        # Run inside the container, over the same TCP loopback the
        # readiness probe uses -- never assumes a `mysql` client exists on
        # the CI runner itself, only inside the image already pulled.
        return subprocess.run(
            [
                "docker", "exec", _MYSQL_CONTAINER_NAME,
                "mysql", "--protocol=TCP", "--host=127.0.0.1", "--ssl-mode=REQUIRED",
                "-u", user, f"-p{password}", "-e", "SELECT 1",
            ],
            capture_output=True,
        )

    def test_the_host_restriction_actually_refuses_a_non_matching_address(self) -> None:
        """Proves account-host matching with a control case, not a refusal
        alone: `backup_right_host`/`backup_wrong_host` are identical
        (`REQUIRE SSL`, same connection path) except the granted address --
        `@'127.0.0.1'` (how this container reaches itself) vs
        `@'10.99.99.99'` (nothing here has it). Without the matching case
        too, a server refusing every connection would pass identically."""
        matching = self._mysql_probe(user="backup_right_host", password=self.right_host_pwd)
        self.assertEqual(matching.returncode, 0, matching.stderr.decode(errors="replace"))

        non_matching = self._mysql_probe(user="backup_wrong_host", password=self.wrong_host_pwd)
        self.assertNotEqual(non_matching.returncode, 0)
        self.assertIn(b"Access denied", non_matching.stderr)

    def test_mysqldump_over_real_tls_against_the_grant_limited_account(self) -> None:
        transport = RemoteMysqldumpTransport(
            host="127.0.0.1", port=self.port, user="backup_ops1", ssl_ca=self.ssl_ca_path
        )
        sink = _CollectingSinkForContainerTest()
        exit_code = transport.run(
            command=["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"],
            env={"DB_DUMP_MYSQL_PWD": self.worker_pwd},
            stdout=sink,
        )
        output = b"".join(sink.chunks)
        self.assertEqual(exit_code, 0, output.decode(errors="replace"))
        self.assertIn(b"INSERT INTO `users`", output)
        self.assertIn(b"INSERT INTO `settings`", output)

    def test_verify_ca_rejects_a_wrong_certificate_authority(self) -> None:
        """Proves `--ssl-mode=VERIFY_CA` actually verifies the server's
        certificate, not merely that the connection is encrypted: a
        throwaway, unrelated CA must fail the handshake itself -- nonzero
        exit, nothing streamed, a named certificate reason. Degrading to
        `--ssl-mode=REQUIRED` would let this connection through; sabotage
        proof in the PR body."""
        wrong_ca_dir = tempfile.mkdtemp()
        self.addCleanup(lambda: shutil.rmtree(wrong_ca_dir, ignore_errors=True))
        wrong_ca_path = os.path.join(wrong_ca_dir, "wrong-ca.pem")
        wrong_key_path = os.path.join(wrong_ca_dir, "wrong-ca-key.pem")
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                "-keyout", wrong_key_path, "-out", wrong_ca_path,
                "-days", "1", "-subj", "/CN=throwaway-unrelated-ca",
            ],
            check=True,
            capture_output=True,
        )

        transport = RemoteMysqldumpTransport(
            host="127.0.0.1", port=self.port, user="backup_ops1", ssl_ca=wrong_ca_path
        )
        sink = _CollectingSinkForContainerTest()
        captured_stderr = io.StringIO()
        with contextlib.redirect_stderr(captured_stderr):
            exit_code = transport.run(
                command=["python3", "/x/dump_tenant.py", "blog", "--socket", "/x.sock"],
                env={"DB_DUMP_MYSQL_PWD": self.worker_pwd},
                stdout=sink,
            )

        self.assertNotEqual(exit_code, 0)
        self.assertEqual(b"".join(sink.chunks), b"")
        self.assertIn("certificate", captured_stderr.getvalue().lower())


class _CollectingSinkForContainerTest:
    def __init__(self) -> None:
        self.chunks: list[bytes] = []

    def write(self, chunk: bytes) -> int:
        self.chunks.append(chunk)
        return len(chunk)


# Dummy values only -- never a real credential. These exist purely to give
# main()'s env-parsing something syntactically present to read; nothing
# here is escrowed anywhere or reaches a real endpoint, because
# shared_objectstorage.put_object is mocked in every test that uses them.
_DUMMY_PRIMARY_ENV = {
    "BACKUP_WORKER_COPY_PRIMARY_BUCKET": "dummy-primary-bucket",
    "BACKUP_WORKER_COPY_PRIMARY_ENDPOINT": "dummy-primary.example.invalid",
    "BACKUP_WORKER_COPY_PRIMARY_REGION": "dummy-region",
    "BACKUP_WORKER_COPY_PRIMARY_ACCESS_KEY_ID": "dummy-access-key-id",
    "BACKUP_WORKER_COPY_PRIMARY_SECRET_ACCESS_KEY": "dummy-secret-access-key",
}
_DUMMY_SECONDARY_ENV = {
    "BACKUP_WORKER_COPY_SECONDARY_BUCKET": "dummy-secondary-bucket",
    "BACKUP_WORKER_COPY_SECONDARY_ENDPOINT": "dummy-secondary.example.invalid",
    "BACKUP_WORKER_COPY_SECONDARY_REGION": "dummy-region-2",
    "BACKUP_WORKER_COPY_SECONDARY_ACCESS_KEY_ID": "dummy-access-key-id-2",
    "BACKUP_WORKER_COPY_SECONDARY_SECRET_ACCESS_KEY": "dummy-secret-access-key-2",
}


class MainCopyWiringTests(unittest.TestCase):
    """Through `main()` itself -- its argument parsing and its
    `BACKUP_WORKER_COPY_*` env-var wiring -- with a synthetic environment
    carrying dummy credential values only. `shared_objectstorage.put_object`
    is the one thing mocked: every other line `main()` runs, including
    which copies it decides to build and in what order, runs for real.
    """

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(self.bin_dir)
        _write_fake_bin(self.bin_dir, "mysql", _FAKE_MYSQL)
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY)
        _, recipient = _generate_age_identity()

        self._path_patch = mock.patch.dict(
            os.environ, {"PATH": self.bin_dir + os.pathsep + os.environ.get("PATH", "")}
        )
        self._path_patch.start()
        self.addCleanup(self._path_patch.stop)

        self._put_object_patch = mock.patch.object(bw.shared_objectstorage, "put_object")
        self.mock_put_object = self._put_object_patch.start()
        self.addCleanup(self._put_object_patch.stop)

        self._base_env = {
            "DB_DUMP_MYSQL_PWD": "dummy-mysql-password",
            "AGE_RECIPIENT_PUBLIC_KEY": recipient,
            # Without this, a successful run falls through to
            # bw.DEFAULT_BACKUP_AGE_METRICS_DIR -- a real, absolute,
            # hardcoded production path. Harmless on a dev machine or CI
            # runner only because that path happens to be unwritable there;
            # run as the account the real worker deploys as (where it IS
            # writable) and this class would write fabricated blog/shop
            # timestamps into the exact file node_exporter scrapes for the
            # real signal.
            "BACKUP_WORKER_METRICS_DIR": os.path.join(self.tmp.name, "metrics"),
        }

    def _main(self, env: dict[str, str]) -> int:
        with mock.patch.dict(os.environ, env):
            return bw.main(
                ["--tenant", "blog", "--local-test-transport", "--dump-tenant-path", _DUMP_TENANT_PATH]
            )

    def _bucket_args(self) -> list[str]:
        return [call.kwargs["bucket"] for call in self.mock_put_object.call_args_list]

    def test_primary_only_env_runs_and_writes_the_primary_copy_alone(self) -> None:
        exit_code = self._main({**self._base_env, **_DUMMY_PRIMARY_ENV})
        self.assertEqual(exit_code, 0)
        self.assertEqual(self._bucket_args(), ["dummy-primary-bucket"])

    def test_a_partially_configured_secondary_is_refused_before_any_put(self) -> None:
        partial_secondary = {"BACKUP_WORKER_COPY_SECONDARY_BUCKET": "dummy-secondary-bucket"}
        with self.assertRaises(SystemExit) as ctx:
            self._main({**self._base_env, **_DUMMY_PRIMARY_ENV, **partial_secondary})
        self.assertIn("secondary", str(ctx.exception))
        self.mock_put_object.assert_not_called()

    def test_both_copies_fully_configured_writes_both(self) -> None:
        exit_code = self._main({**self._base_env, **_DUMMY_PRIMARY_ENV, **_DUMMY_SECONDARY_ENV})
        self.assertEqual(exit_code, 0)
        self.assertEqual(self._bucket_args(), ["dummy-primary-bucket", "dummy-secondary-bucket"])

    def test_a_missing_primary_is_refused_even_with_secondary_fully_configured(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            self._main({**self._base_env, **_DUMMY_SECONDARY_ENV})
        self.assertIn("primary", str(ctx.exception))
        self.mock_put_object.assert_not_called()

    def test_a_partially_configured_primary_is_refused_even_though_its_required(self) -> None:
        partial_primary = {
            "BACKUP_WORKER_COPY_PRIMARY_BUCKET": "dummy-primary-bucket",
            "BACKUP_WORKER_COPY_PRIMARY_ENDPOINT": "dummy-primary.example.invalid",
        }
        with self.assertRaises(SystemExit) as ctx:
            self._main({**self._base_env, **partial_primary})
        self.assertIn("primary", str(ctx.exception))
        self.mock_put_object.assert_not_called()


class WiringSabotageForTheCopySelectionTests(unittest.TestCase):
    """Proves the required/optional distinction is load-bearing without
    permanently breaking shipped code: the OLD shape --
    `_copy_target_from_env(..., required=True)` for the secondary copy too
    -- refuses the same environment the fixed `main()` accepts today, both
    real, executed calls against the real function. The live edit/run/
    revert transcript against `main()` itself is in the PR body's Sabotage
    section."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(self.bin_dir)
        _write_fake_bin(self.bin_dir, "mysql", _FAKE_MYSQL)
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY)
        _, recipient = _generate_age_identity()

        self._path_patch = mock.patch.dict(
            os.environ, {"PATH": self.bin_dir + os.pathsep + os.environ.get("PATH", "")}
        )
        self._path_patch.start()
        self.addCleanup(self._path_patch.stop)

        self._put_object_patch = mock.patch.object(bw.shared_objectstorage, "put_object")
        self.mock_put_object = self._put_object_patch.start()
        self.addCleanup(self._put_object_patch.stop)

        self._env = {
            "DB_DUMP_MYSQL_PWD": "dummy-mysql-password",
            "AGE_RECIPIENT_PUBLIC_KEY": recipient,
            # See MainCopyWiringTests.setUp's identical line: without this
            # a successful run here falls through to the real production
            # metrics directory default.
            "BACKUP_WORKER_METRICS_DIR": os.path.join(self.tmp.name, "metrics"),
            **_DUMMY_PRIMARY_ENV,
        }

    def test_the_wired_shape_backup_worker_main_uses_accepts_primary_only(self) -> None:
        """The GREEN control: `main()` itself, unmodified, on a
        primary-only environment."""
        with mock.patch.dict(os.environ, self._env):
            exit_code = bw.main(
                ["--tenant", "blog", "--local-test-transport", "--dump-tenant-path", _DUMP_TENANT_PATH]
            )
        self.assertEqual(exit_code, 0)
        self.mock_put_object.assert_called_once()

    def test_the_old_shape_required_true_for_secondary_refuses_the_same_environment(self) -> None:
        """The RED demonstration: the identical environment, but building
        the secondary copy the way `main()` used to -- unconditionally
        required -- refuses it. Exactly what shipping without this fix
        would still do."""
        with mock.patch.dict(os.environ, self._env):
            with self.assertRaises(SystemExit):
                bw._copy_target_from_env(copy_name="secondary", tenant="blog", required=True)
        self.mock_put_object.assert_not_called()


class WiringSabotageThroughTheRealEntryPointTests(unittest.TestCase):
    """Proves the floor gate in `run_tenant_dump` is actually WIRED to
    `pull_encrypt_and_store`'s `post_stream_check` -- not merely present as
    a method nobody calls. Deliberately does NOT run the real
    `dump_tenant.py` (whose own `run_mysqldump` already refuses a missing
    floor table itself): a fake shell "producer" isolates the case a
    DIFFERENT producer, or a corrupted stream, could still reach this
    worker with a 0 exit and a missing floor -- what this worker's own
    independent watch exists to catch even then."""

    def setUp(self) -> None:
        _, self.recipient = _generate_age_identity()
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.copies_dir = os.path.join(self.tmp.name, "copies")
        os.makedirs(self.copies_dir)
        self.primary = _FileCopy("primary", self.copies_dir)
        # Exits 0 having written an INSERT for `users` only -- never
        # `settings` -- the exact shape the real producer's own check would
        # also refuse, used here to isolate THIS worker's independent gate.
        self.floor_failing_command = [
            "/bin/sh",
            "-c",
            "echo \"INSERT INTO \\`users\\` VALUES (1);\"",
        ]

    def test_the_wired_path_backup_worker_run_tenant_dump_uses_refuses_this_shape(self) -> None:
        """The GREEN control: `pull_encrypt_and_store` called exactly the
        way `run_tenant_dump` calls it -- WITH `post_stream_check` -- on
        the fake producer above."""
        watcher = bw._FloorWatcher(bw.FLOOR_TABLES)
        from pull_encrypt_store import PullEncryptStoreError, pull_encrypt_and_store

        with self.assertRaises(PullEncryptStoreError):
            pull_encrypt_and_store(
                transport=LocalProcessTransport(),
                command=self.floor_failing_command,
                env={},
                age_recipient=self.recipient,
                copies=[self.primary.as_target()],
                chunk_watcher=watcher.observe,
                post_stream_check=watcher.assert_floor_met,
            )
        self.assertFalse(os.path.exists(self.primary.path))

    def test_disconnecting_post_stream_check_lets_the_same_dump_through(self) -> None:
        """The RED demonstration: the identical call above, with
        `post_stream_check` omitted -- exactly what deleting that one
        keyword argument from `backup_worker.run_tenant_dump` would do.
        Kept as a real, executed test (not prose) so this sabotage is
        re-provable by anyone, any time, rather than only claimed once in
        a PR body."""
        from pull_encrypt_store import pull_encrypt_and_store

        result = pull_encrypt_and_store(
            transport=LocalProcessTransport(),
            command=self.floor_failing_command,
            env={},
            age_recipient=self.recipient,
            copies=[self.primary.as_target()],
            # post_stream_check deliberately omitted.
        )
        self.assertTrue(result.ok)
        self.assertTrue(os.path.exists(self.primary.path))


class BackupAgeMetricFormattingTests(unittest.TestCase):
    """The exposition-format helpers in isolation -- pure functions, no
    filesystem, no real dump."""

    def test_render_is_sorted_by_tenant(self) -> None:
        text = bw.render_backup_age_prometheus_text({"shop": 50.0, "blog": 100.5})
        self.assertLess(text.index('tenant="blog"'), text.index('tenant="shop"'))
        self.assertIn('backup_worker_last_success_timestamp_seconds{tenant="blog"} 100.5', text)
        self.assertIn('backup_worker_last_success_timestamp_seconds{tenant="shop"} 50.0', text)

    def test_parse_round_trips_what_render_wrote(self) -> None:
        original = {"blog": 100.0, "shop": 200.5}
        text = bw.render_backup_age_prometheus_text(original)
        self.assertEqual(bw._parse_previous_backup_age_metrics(text), original)

    def test_parse_ignores_help_and_type_comment_lines(self) -> None:
        text = bw.render_backup_age_prometheus_text({"blog": 1.0})
        for line in text.splitlines():
            if line.startswith("#"):
                self.assertEqual(bw._parse_previous_backup_age_metrics(line), {})


class BackupAgeMetricRecordingTests(unittest.TestCase):
    """`record_backup_age_metric` against a real temp directory -- the
    read-merge-write cycle that keeps one tenant's write from erasing
    every other tenant's line."""

    def _read(self, metrics_dir: str) -> dict[str, float]:
        path = pathlib.Path(metrics_dir) / bw.BACKUP_AGE_METRIC_FILENAME
        if not path.exists():
            return {}
        return bw._parse_previous_backup_age_metrics(path.read_text())

    def test_a_first_write_creates_the_directory_and_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            metrics_dir = os.path.join(tmp, "nested", "metrics")
            bw.record_backup_age_metric(tenant="blog", metrics_dir=metrics_dir, now=100.0)
            self.assertEqual(self._read(metrics_dir), {"blog": 100.0})

    def test_a_second_tenants_write_merges_rather_than_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bw.record_backup_age_metric(tenant="blog", metrics_dir=tmp, now=100.0)
            bw.record_backup_age_metric(tenant="shop", metrics_dir=tmp, now=200.0)
            self.assertEqual(self._read(tmp), {"blog": 100.0, "shop": 200.0})

    def test_a_repeat_write_for_the_same_tenant_updates_only_that_tenant(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            bw.record_backup_age_metric(tenant="blog", metrics_dir=tmp, now=100.0)
            bw.record_backup_age_metric(tenant="shop", metrics_dir=tmp, now=200.0)
            bw.record_backup_age_metric(tenant="blog", metrics_dir=tmp, now=999.0)
            self.assertEqual(self._read(tmp), {"blog": 999.0, "shop": 200.0})

    def test_an_unwritable_directory_is_reported_and_never_raises(self) -> None:
        """Best-effort by design (see the function's own docstring): a
        metrics-write failure must not be indistinguishable from every
        other exception main() propagates as a failed dump."""
        with tempfile.TemporaryDirectory() as tmp:
            blocked = os.path.join(tmp, "blocked")
            with open(blocked, "w", encoding="utf-8") as handle:
                handle.write("a file, not a directory")
            # mkdir(parents=True) on a path that already exists as a file
            # raises FileExistsError, a subclass of OSError -- exactly the
            # write-failure shape this function must swallow.
            bw.record_backup_age_metric(
                tenant="blog", metrics_dir=os.path.join(blocked, "metrics"), now=100.0
            )  # must not raise


_FAKE_MYSQLDUMP_HAPPY_TENANT_B = """#!/bin/sh
echo "-- MySQL dump 10.13"
echo "INSERT INTO \\`users\\` VALUES ('u2','Owner');"
echo "INSERT INTO \\`settings\\` VALUES ('s2','title','Shop');"
exit 0
"""


class BackupAgeMetricWiredThroughMainTests(unittest.TestCase):
    """Through `main()` itself -- the real entry point -- proving the
    export is actually wired to a successful run rather than merely present
    as a function nobody calls. See the module's own `_FloorWatcher` class
    docstring for why this repo treats that distinction as worth proving
    separately every time."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin_dir = os.path.join(self.tmp.name, "bin")
        os.makedirs(self.bin_dir)
        _write_fake_bin(self.bin_dir, "mysql", _FAKE_MYSQL)
        _, self.recipient = _generate_age_identity()
        self.metrics_dir = os.path.join(self.tmp.name, "metrics")

        self._path_patch = mock.patch.dict(
            os.environ, {"PATH": self.bin_dir + os.pathsep + os.environ.get("PATH", "")}
        )
        self._path_patch.start()
        self.addCleanup(self._path_patch.stop)

        self._put_object_patch = mock.patch.object(bw.shared_objectstorage, "put_object")
        self.mock_put_object = self._put_object_patch.start()
        self.addCleanup(self._put_object_patch.stop)

        self._env = {
            "DB_DUMP_MYSQL_PWD": "dummy-mysql-password",
            "AGE_RECIPIENT_PUBLIC_KEY": self.recipient,
            "BACKUP_WORKER_METRICS_DIR": self.metrics_dir,
            **_DUMMY_PRIMARY_ENV,
        }

    def _main(self, tenant: str) -> int:
        with mock.patch.dict(os.environ, self._env):
            return bw.main(
                ["--tenant", tenant, "--local-test-transport", "--dump-tenant-path", _DUMP_TENANT_PATH]
            )

    def _read_metrics(self) -> dict[str, float]:
        path = pathlib.Path(self.metrics_dir) / bw.BACKUP_AGE_METRIC_FILENAME
        if not path.exists():
            return {}
        return bw._parse_previous_backup_age_metrics(path.read_text())

    def test_a_successful_run_writes_that_tenants_timestamp(self) -> None:
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY)
        before = time.time()
        exit_code = self._main("blog")
        self.assertEqual(exit_code, 0)
        metrics = self._read_metrics()
        self.assertIn("blog", metrics)
        self.assertGreaterEqual(metrics["blog"], before)

    def test_a_refused_dump_never_writes_or_updates_a_metric(self) -> None:
        _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_MISSING_SETTINGS)
        exit_code = self._main("blog")
        self.assertEqual(exit_code, 1)
        self.assertEqual(self._read_metrics(), {})

    def test_stopping_one_tenants_backups_leaves_only_that_tenants_gauge_stale(self) -> None:
        """The story's own sabotage, run through the real entry point:
        stop one tenant's backups and the signal must move for that
        tenant only. `shop` and `blog` both succeed once; `blog`'s
        producer is then made to miss its settings floor (refused) while
        `shop` succeeds again -- `blog`'s gauge must stay exactly at its
        first, now-stale value while `shop`'s advances."""
        with mock.patch.object(bw.time, "time", side_effect=[100.0, 200.0, 300.0]):
            _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY_TENANT_B)
            self.assertEqual(self._main("shop"), 0)
            _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY)
            self.assertEqual(self._main("blog"), 0)
            first_round = self._read_metrics()

            _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_MISSING_SETTINGS)
            self.assertEqual(self._main("blog"), 1)
            _write_fake_bin(self.bin_dir, "mysqldump", _FAKE_MYSQLDUMP_HAPPY_TENANT_B)
            self.assertEqual(self._main("shop"), 0)
            second_round = self._read_metrics()

        self.assertEqual(first_round, {"shop": 100.0, "blog": 200.0})
        self.assertEqual(second_round["blog"], first_round["blog"])
        self.assertGreater(second_round["shop"], first_round["shop"])
        self.assertEqual(second_round["shop"], 300.0)


class BackupAgeMetricConcurrencyTests(unittest.TestCase):
    """The read-merge-write inside `record_backup_age_metric` must be safe
    when two tenants' runs finish close together. Two lines of proof: real
    concurrent threads recording DIFFERENT tenants with no forced ordering
    (below), and a deterministic test seam (`_after_read`, `_use_lock`)
    that forces the exact interleave a real race might only reproduce
    occasionally -- used here because a lost-update race is inherently
    timing-dependent, and a test that only sometimes catches a regression
    is not the proof this needs."""

    def _read(self, metrics_dir: str) -> dict[str, float]:
        path = pathlib.Path(metrics_dir) / bw.BACKUP_AGE_METRIC_FILENAME
        if not path.exists():
            return {}
        return bw._parse_previous_backup_age_metrics(path.read_text())

    def test_several_threads_recording_different_tenants_all_survive(self) -> None:
        """Real concurrency, no forced ordering: N threads, N distinct
        tenants, a barrier to start them as close together as the
        scheduler allows. Every tenant's timestamp must survive -- the
        lock's whole job is that no ordering of real, concurrent callers
        can lose one."""
        tenants = [f"tenant-{i}" for i in range(8)]
        with tempfile.TemporaryDirectory() as tmp:
            barrier = threading.Barrier(len(tenants))

            def worker(tenant: str, now: float) -> None:
                barrier.wait()
                bw.record_backup_age_metric(tenant=tenant, metrics_dir=tmp, now=now)

            threads = [
                threading.Thread(target=worker, args=(tenant, float(100 + i)))
                for i, tenant in enumerate(tenants)
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(timeout=10)
                self.assertFalse(thread.is_alive())

            metrics = self._read(tmp)
        self.assertEqual(metrics, {tenant: float(100 + i) for i, tenant in enumerate(tenants)})

    def test_a_forced_interleave_survives_when_locked(self) -> None:
        """The GREEN control: the lock's own default (`_use_lock=True`),
        with a second writer started -- via the `_after_read` test seam --
        WHILE the first writer is inside its own critical section, between
        its read and its write. With the lock held, the second writer's
        own `flock()` call blocks until the first releases, so no ordering
        of "who read first" can occur -- both tenants' values must survive
        regardless."""
        with tempfile.TemporaryDirectory() as tmp:
            bw.record_backup_age_metric(tenant="blog", metrics_dir=tmp, now=1.0)
            bw.record_backup_age_metric(tenant="shop", metrics_dir=tmp, now=1.0)

            second_writer = threading.Thread(
                target=lambda: bw.record_backup_age_metric(tenant="shop", metrics_dir=tmp, now=200.0)
            )

            def start_the_second_writer_mid_critical_section() -> None:
                second_writer.start()
                # Whatever this resolves to, the first writer's own write
                # happens next -- either before or after the second
                # writer's flock() succeeds, but never overlapping it.
                time.sleep(0.2)

            bw.record_backup_age_metric(
                tenant="blog",
                metrics_dir=tmp,
                now=100.0,
                _after_read=start_the_second_writer_mid_critical_section,
            )
            second_writer.join(timeout=5)
            self.assertFalse(second_writer.is_alive())
            metrics = self._read(tmp)
        self.assertEqual(metrics, {"blog": 100.0, "shop": 200.0})

    def test_disabling_the_lock_via_the_test_seam_loses_the_concurrent_update(self) -> None:
        """The RED demonstration, via the seam rather than a live edit to
        the shipped file (a genuine race is not reliably forceable on
        demand, and a flaky red is not a proof): the identical interleave
        above, with `_use_lock=False` on BOTH writers -- exactly the shape
        `record_backup_age_metric` had before this lock existed. The
        second writer's fresh, real 200.0 for `shop` is silently reverted
        to the first writer's stale in-memory read of 1.0, because the
        first writer's own merge and write run AFTER the second writer's,
        using data it read before the second writer ever wrote."""
        with tempfile.TemporaryDirectory() as tmp:
            bw.record_backup_age_metric(tenant="blog", metrics_dir=tmp, now=1.0)
            bw.record_backup_age_metric(tenant="shop", metrics_dir=tmp, now=1.0)

            second_writer = threading.Thread(
                target=lambda: bw.record_backup_age_metric(
                    tenant="shop", metrics_dir=tmp, now=200.0, _use_lock=False
                )
            )

            def start_the_second_writer_mid_critical_section() -> None:
                second_writer.start()
                second_writer.join(timeout=5)

            bw.record_backup_age_metric(
                tenant="blog",
                metrics_dir=tmp,
                now=100.0,
                _use_lock=False,
                _after_read=start_the_second_writer_mid_critical_section,
            )
            metrics = self._read(tmp)

        # blog's own update DOES land -- this race silently reverts the
        # OTHER tenant's fresh success, which is the more dangerous shape:
        # a healthy tenant made to look stale, not merely an update absent.
        self.assertEqual(metrics["blog"], 100.0)
        self.assertEqual(metrics["shop"], 1.0)  # lost: the real write was 200.0
        self.assertNotEqual(metrics["shop"], 200.0)


def tearDownModule() -> None:
    """If any test in this module ever falls through to the real
    production metrics directory instead of a temp one, this turns that
    into a loud test failure rather than a silent write into the exact
    file the live monitored signal reads."""
    default_path = pathlib.Path(bw.DEFAULT_BACKUP_AGE_METRICS_DIR)
    if default_path.exists():
        raise AssertionError(
            f"{default_path} was created during this test run -- some test wrote to the "
            "real production backup-age metrics directory instead of a temp one"
        )


if __name__ == "__main__":
    unittest.main()
