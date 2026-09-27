#!/usr/bin/env python3
"""Unit tests for backup_worker.py, through its real entry points --
`run_tenant_dump` AND, separately, `main()` itself -- against the REAL
`db/provision/dump_tenant.py`, never a fake standing in for the producer
itself. `mysql` and `mysqldump` are the two binaries faked (as tiny shell
scripts placed first on `PATH`), because a real MySQL instance is the
local-container proof this repo's own convention (see
`db/provision/test_extract_tenant_binlog.py`) keeps out of the fast,
hermetic unit suite.

What IS real here: `dump_tenant.py`'s own Python code (its floor checks,
its env-forwarding allowlist, its argument parsing),
`dial_in_transport.LocalProcessTransport` spawning it as a genuine
subprocess, `age` encrypting and decrypting the result, and, in
`MainCopyWiringTests` below, `main()`'s own argument parsing and
`BACKUP_WORKER_COPY_*` env-var wiring. The only things this file invents
are the two MySQL client binaries, the storage "copies" (plain local files
standing in for the two cloud buckets in the `run_tenant_dump`-level tests
-- their credentials are not this story's to provision, see the PR body),
and, in `MainCopyWiringTests`, `shared_objectstorage.put_object` itself --
that boundary is mocked there specifically so `main()`'s real env-parsing
and copy-selection logic runs unmocked against synthetic, dummy credential
values, with no real network call.
"""

from __future__ import annotations

import os
import pathlib
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

import backup_worker as bw
from dial_in_transport import LocalProcessTransport
from pull_encrypt_store import CopyTarget

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_DUMP_TENANT_PATH = str(_REPO_ROOT / "db" / "provision" / "dump_tenant.py")

_FAKE_MYSQL = """#!/bin/sh
# Stands in for the real `mysql` client: db/provision/dump_tenant.py's
# check_floor() calls this twice (once per floor table) with a `SELECT
# COUNT(*)` and expects a bare row count on stdout. This fake ignores the
# query entirely and always reports a nonzero count, so the pre-check
# always passes -- the property these tests exercise is the worker's OWN
# plumbing, not MySQL's counting.
echo 5
"""

_FAKE_MYSQLDUMP_HAPPY = """#!/bin/sh
echo "-- MySQL dump 10.13"
echo "INSERT INTO \\`users\\` VALUES ('u1','Owner');"
echo "INSERT INTO \\`settings\\` VALUES ('s1','title','Blog');"
exit 0
"""

_FAKE_MYSQLDUMP_MISSING_SETTINGS = """#!/bin/sh
echo "-- MySQL dump 10.13 (--no-data)"
echo "INSERT INTO \\`users\\` VALUES ('u1','Owner');"
exit 0
"""


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
    """Proves the required/optional distinction is actually load-bearing --
    not by breaking `backup_worker.py`'s shipped code (a permanently-red
    test would fail every future CI run, which is not what "record red"
    means here), but by demonstrating that the OLD shape --
    `_copy_target_from_env(..., required=True)` for the secondary copy too,
    which is exactly what `main()` did before this fix -- refuses the same
    environment the fixed `main()` accepts today. Both are real, executed
    assertions against the real function, not prose; the live edit/run/
    revert transcript against `main()` itself is recorded in the PR body's
    Sabotage section, since that half genuinely does require breaking and
    restoring the shipped file."""

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
    `pull_encrypt_and_store`'s `post_stream_check` parameter -- not merely
    present as a method nobody calls.

    This class deliberately does NOT run the real `dump_tenant.py`: that
    producer's own `run_mysqldump` already raises `FloorError` (a nonzero
    exit) the moment a floor table's `INSERT` never appears, so a dump
    reaching this worker with the settings floor missing but a 0 exit is
    never produced by the real producer -- it is exactly the shape a
    DIFFERENT or future producer, or a stream corrupted between the
    producer and this worker, could still produce. That is what this
    worker's own independent watch exists to catch even so, and this class
    isolates it with a bare shell command as the "producer" -- a fake one,
    on purpose, so the real `dump_tenant.py`'s own floor check (proven
    against separately above) cannot be the thing making this pass.
    """

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


if __name__ == "__main__":
    unittest.main()
