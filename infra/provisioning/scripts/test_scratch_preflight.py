#!/usr/bin/env python3
"""Unit tests for scratch_preflight.py. The restore itself runs for real: every
`mysql` call the gate makes lands on a throwaway MySQL server started by this
file (a local `mysqld` on a temporary datadir, or a container of db1's pinned
image in CI, where a missing one fails rather than skips). The docker calls
around it are faked, and `age` is the real local binary on real ciphertext.
Nothing here reaches a host. See scratch_preflight.md."""

from __future__ import annotations

import contextlib
import dataclasses
import datetime
import fcntl
import io
import os
import pathlib
import re
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
import uuid
from unittest import mock

import backup_manifest as bm
import restore_drill as rd
import scratch_preflight as sp
import test_restore_drill as trd

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
REQUIRED = os.environ.get("CI") == "true"
SYSTEM_DATABASES = ("information_schema", "mysql", "performance_schema", "sys")
TENANT = "blog"
DATABASE = "ghost_blog"
KEY = "dumps/blog/20261003T014000Z.sql.age"
_PIN = re.compile(r"mysql:8\.0@sha256:[0-9a-f]{64}")


# --- the throwaway database -------------------------------------------------


def _local_mysqld() -> str | None:
    """A real MySQL server binary, never MariaDB: the gate restores into MySQL."""
    candidates = [os.environ.get("THROWAWAY_MYSQLD", "")]
    for pattern in ("/opt/homebrew/opt/mysql*/bin/mysqld", "/usr/local/opt/mysql*/bin/mysqld"):
        candidates += [str(p) for p in sorted(pathlib.Path("/").glob(pattern.lstrip("/")))]
    candidates += ["/usr/sbin/mysqld", shutil.which("mysqld") or ""]
    for candidate in candidates:
        if not candidate or not os.access(candidate, os.X_OK):
            continue
        version = subprocess.run([candidate, "--version"], capture_output=True, text=True, check=False)
        if version.returncode == 0 and "MariaDB" not in version.stdout:
            return candidate
    return None


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class Throwaway:
    """One MySQL server the gate's `mysql` calls are forwarded to. `reset`
    stands in for a container's first boot (empty, root password as given) and
    `wipe` for removing it."""

    def __init__(self) -> None:
        self.password = ""
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.process: subprocess.Popen | None = None
        self.container: str | None = None
        self.port = 0

    # lifecycle ----------------------------------------------------------------

    def start(self) -> None:
        mysqld = None if REQUIRED else _local_mysqld()
        if mysqld is not None:
            self._start_local(mysqld)
        elif REQUIRED:
            self._start_docker()
        else:
            raise unittest.SkipTest("no local MySQL server binary (set THROWAWAY_MYSQLD); CI uses db1's pinned image")

    def _start_local(self, mysqld: str) -> None:
        self.client_bin = str(pathlib.Path(mysqld).with_name("mysql"))
        data = self.dir / "data"
        subprocess.run([mysqld, "--no-defaults", "--initialize-insecure", f"--datadir={data}"],
                       capture_output=True, check=True)
        self.port = _free_port()
        self.process = subprocess.Popen(
            [mysqld, "--no-defaults", f"--datadir={data}", f"--port={self.port}", f"--socket={self.dir}/m.sock",
             "--mysqlx=OFF", "--bind-address=127.0.0.1", f"--pid-file={self.dir}/m.pid",
             f"--log-error={self.dir}/err.log"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        self._wait_ready()

    def _start_docker(self) -> None:
        pins = set(_PIN.findall((REPO_ROOT / "db" / "RUNBOOK-db.md").read_text(encoding="utf-8")))
        if len(pins) != 1:
            raise AssertionError(f"db/RUNBOOK-db.md pins {sorted(pins)}; expected exactly one mysql:8.0 digest")
        self.container = f"scratch-preflight-test-{uuid.uuid4().hex[:8]}"
        started = subprocess.run(
            ["docker", "run", "-d", "--name", self.container, "--platform", "linux/amd64",
             "-e", "MYSQL_ALLOW_EMPTY_PASSWORD=yes", pins.pop()],
            capture_output=True, text=True, check=False,
        )
        if started.returncode != 0:
            raise AssertionError(f"cannot start the throwaway MySQL: {started.stderr.strip()}")
        self._wait_ready(timeout=240)

    def _wait_ready(self, timeout: float = 60) -> None:
        """Ready means answering over TCP. The image's entrypoint first runs a
        temporary server with networking off, on which only the socket answers;
        a socket probe passes on that server, which is then shut down while the
        tests are already using it, and the real server starts after."""
        deadline = time.monotonic() + timeout
        while True:
            probe = self.client(["--protocol=TCP", "-N", "-B", "-e", "SELECT 1;"], password="")
            if probe.returncode == 0 and probe.stdout.strip() == "1":
                return
            if time.monotonic() >= deadline:
                raise AssertionError(f"the throwaway MySQL never answered: {probe.stderr}")
            time.sleep(1)

    def stop(self) -> None:
        if self.process is not None:
            self.process.terminate()
            with contextlib.suppress(subprocess.TimeoutExpired):
                self.process.wait(timeout=30)
            self.process.kill()
        if self.container is not None:
            subprocess.run(["docker", "rm", "-f", "-v", self.container], capture_output=True, check=False)
        shutil.rmtree(self.dir, ignore_errors=True)

    # use ------------------------------------------------------------------------

    def client(self, args, *, password, stdin=None, text=True, timeout=None) -> subprocess.CompletedProcess:
        """The gate's mysql call with its host and port pointed here."""
        kept, skip = [], False
        for arg in args:
            if skip:
                skip = False
            elif arg in ("--host", "--port"):
                skip = True
            else:
                kept.append(arg)
        if self.container is not None:
            argv = ["docker", "exec", "-i", "-e", f"MYSQL_PWD={password}", self.container, "mysql", *kept]
            env = None
        else:
            argv = [self.client_bin, "--protocol=TCP", "--host=127.0.0.1", f"--port={self.port}", *kept]
            env = {"PATH": os.environ["PATH"], "MYSQL_PWD": password}
        return subprocess.run(argv, stdin=stdin, capture_output=True, text=text, timeout=timeout, env=env, check=False)

    def sql(self, statement: str) -> str:
        result = self.client(["--user", "root", "-N", "-B", "-e", statement], password=self.password)
        if result.returncode != 0:
            raise AssertionError(f"{statement!r} failed: {result.stderr}")
        return result.stdout

    def databases(self) -> list[str]:
        return [d for d in self.sql("SHOW DATABASES;").split() if d not in SYSTEM_DATABASES]

    def wipe(self) -> None:
        for database in self.databases():
            self.sql(f"DROP DATABASE `{database}`;")

    def reset(self, password: str, preseed: str | None) -> None:
        self.wipe()
        if preseed:
            self.sql(preseed)
        self.sql(f"ALTER USER 'root'@'localhost' IDENTIFIED BY '{password}';")
        self.password = password


class ThrowawayDocker(trd.FakeDocker):
    """The drill's docker fake, with the mysql calls answered by a real server.
    Starting the scratch server resets the throwaway to a fresh one; removing
    it wipes it, so what the gate leaves behind is what the server still holds."""

    def __init__(self, server: Throwaway, *, preseed: str | None = None, **kwargs) -> None:
        super().__init__(**kwargs)
        self.server = server
        self.preseed = preseed
        self.starts = 0
        self.removals = 0
        self.held_at_removal = ""

    def __call__(self, argv, **kwargs):
        result = super().__call__(argv, **kwargs)
        if argv[:3] == ["docker", "run", "-d"]:
            self.starts += 1
            self.server.reset(kwargs["env"]["MYSQL_ROOT_PASSWORD"], self.preseed)
        elif argv[:4] == ["docker", "rm", "-f", "-v"] and "scratch-preflight-mysql-abcd" in argv:
            self.removals += 1
            self.held_at_removal = self.server.sql(
                "SELECT CONCAT(table_schema, '.', table_name) FROM information_schema.tables "
                "WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys') "
                "ORDER BY 1;"
            )
            self.server.wipe()
        return result

    def _mysql(self, argv, kwargs):
        args = argv[argv.index("mysql") + 1:]
        return self.server.client(
            args, password=kwargs["env"]["MYSQL_PWD"], stdin=kwargs.get("stdin"),
            text=kwargs.get("text"), timeout=kwargs.get("timeout"),
        )


# --- a backup like the worker writes ---------------------------------------


def dump_lines(
    *, title="Fixture's Site", newest="Newest Fixture Post", create_schema=True, migration_tables=True,
) -> list[str]:
    """A mysqldump-shaped dump of a miniature Ghost schema. All of it is made up."""
    title_sql = title.replace("'", "\\'")
    lines = [
        "-- MySQL dump (synthetic fixture)\n",
        f"CREATE DATABASE /*!32312 IF NOT EXISTS*/ `{DATABASE}` /*!40100 DEFAULT CHARACTER SET utf8mb4 */;\n",
        f"USE `{DATABASE}`;\n",
    ]
    if create_schema:
        lines += [
            "DROP TABLE IF EXISTS `settings`;\n",
            "CREATE TABLE `settings` (\n",
            "  `id` varchar(24) NOT NULL,\n",
            "  `key` varchar(50) NOT NULL,\n",
            "  `value` text,\n",
            "  PRIMARY KEY (`id`)\n",
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n",
            f"INSERT INTO `settings` VALUES ('s1','title','{title_sql}'),"
            "('s2','description','A made-up site');\n",
            "DROP TABLE IF EXISTS `users`;\n",
            "CREATE TABLE `users` (\n",
            "  `id` varchar(24) NOT NULL,\n",
            "  `name` varchar(100) NOT NULL,\n",
            "  PRIMARY KEY (`id`)\n",
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n",
            "INSERT INTO `users` VALUES ('u1','Fixture Staff');\n",
            "DROP TABLE IF EXISTS `members`;\n",
            "CREATE TABLE `members` (\n",
            "  `id` varchar(24) NOT NULL,\n",
            "  `email` varchar(191) NOT NULL,\n",
            "  PRIMARY KEY (`id`)\n",
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n",
            "INSERT INTO `members` VALUES ('m1','one@example.invalid'),('m2','two@example.invalid'),"
            "('m3','three@example.invalid');\n",
            "DROP TABLE IF EXISTS `posts`;\n",
            "CREATE TABLE `posts` (\n",
            "  `id` varchar(24) NOT NULL,\n",
            "  `title` varchar(255) NOT NULL,\n",
            "  `slug` varchar(191) NOT NULL,\n",
            "  `type` varchar(50) NOT NULL,\n",
            "  `status` varchar(50) NOT NULL,\n",
            "  `published_at` datetime DEFAULT NULL,\n",
            "  PRIMARY KEY (`id`)\n",
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n",
            f"INSERT INTO `posts` VALUES ('p1','Older Post','older','post','published','2026-09-01 10:00:00'),"
            f"('p2','{newest}','newest','post','published','2026-10-01 10:00:00'),"
            "('p3','A Draft','draft','post','draft',NULL);\n",
        ]
    if create_schema and migration_tables:
        lines += [
            "DROP TABLE IF EXISTS `migrations`;\n",
            "CREATE TABLE `migrations` (\n",
            "  `id` int NOT NULL AUTO_INCREMENT,\n",
            "  `name` varchar(120) NOT NULL,\n",
            "  `version` varchar(70) NOT NULL,\n",
            "  PRIMARY KEY (`id`)\n",
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n",
            "INSERT INTO `migrations` VALUES (1,'1-create-fixture-tables.js','init'),"
            "(2,'2026-08-01-00-00-00-fixture-one.js','6.55');\n",
            "DROP TABLE IF EXISTS `migrations_lock`;\n",
            "CREATE TABLE `migrations_lock` (\n",
            "  `lock_key` varchar(191) NOT NULL,\n",
            "  `locked` tinyint(1) DEFAULT '0',\n",
            "  PRIMARY KEY (`lock_key`)\n",
            ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;\n",
            "INSERT INTO `migrations_lock` VALUES ('km01',0);\n",
        ]
    return lines


def manifest_of(lines: list[str]) -> bm.Manifest:
    """What the backup worker records: the manifest read off the dump's own lines."""
    watcher = bm.ManifestWatcher()
    for line in lines:
        watcher.observe(line.encode())
    manifest = watcher.manifest()
    assert manifest.error is None, manifest.error
    return manifest


def backup_plaintext(lines: list[str] | None = None, *, manifest: bm.Manifest | None = None, tail: str = "") -> bytes:
    lines = dump_lines() if lines is None else lines
    manifest = manifest_of(dump_lines()) if manifest is None else manifest
    return "".join(lines).encode() + tail.encode() + b"-- Dump completed\n" + manifest.to_trailer()


# --- the gate against a real restore ----------------------------------------


@unittest.skipUnless(trd.HAVE_AGE, "needs the age binary")
class GateRestoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = Throwaway()
        cls.addClassCleanup(cls.server.stop)
        cls.server.start()

    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.ids = self.dir / "ids"
        self.ids.mkdir()
        _, self.recipient = trd._keygen(self.ids, TENANT)
        self.config = rd.DrillConfig(
            copies=(trd._copy("primary"), trd._copy("secondary")),
            images=rd.Images(recovery="r" + trd.DIGEST, mysql="m" + trd.DIGEST, ghost="g" + trd.DIGEST,
                             sidecar="s" + trd.DIGEST),
            identity_dir=self.ids, work_dir=self.dir / "work", flag_root=self.dir / "flags",
            metrics_dir=self.dir / "metrics", max_backup_age_s=48 * 3600, require_volatile_work_dir=False,
        )
        self.server.wipe()
        self.store_backup(backup_plaintext())

    def store_backup(self, plaintext: bytes) -> None:
        dump = trd._encrypt(plaintext, self.recipient)
        self.store = trd.FakeStore({"primary": {KEY: dump}, "secondary": {KEY: dump}})

    def hooks(self, docker):
        return rd.Hooks(runner=docker, store=self.store, sleep=lambda s: None, clock=trd.Clock(),
                        now=lambda: trd.NOW, run_id=lambda: "abcd")

    def gate(self, docker, **kwargs):
        return sp.run_gate(config=self.config, tenant=TENANT, hooks=self.hooks(docker), **kwargs)

    def assert_nothing_left(self, docker):
        self.assertEqual(self.server.databases(), [], "the scratch server still holds a tenant database")
        self.assertGreaterEqual(docker.removals, 1)
        self.assertIn(["docker", "network", "rm", "scratch-preflight-abcd"], docker.calls)
        self.assertFalse((self.config.work_dir / "preflight-run-abcd").exists())

    # green --------------------------------------------------------------------

    def test_green_restores_the_backup_and_removes_the_scratch_server(self):
        docker = ThrowawayDocker(self.server)
        report = self.gate(docker)
        self.assertTrue(report.ok, report.error)
        self.assertEqual((report.tenant, report.copy, report.object_key), (TENANT, "primary", KEY))
        self.assertEqual(report.content.site_title, "Fixture's Site")
        self.assertEqual((report.content.users, report.content.published_posts, report.content.members), (1, 2, 3))
        self.assertEqual(report.content.newest_post_title, "Newest Fixture Post")
        self.assertEqual(report.manifest.site_title, report.content.site_title)
        self.assertEqual(report.bytes_recovered, len(backup_plaintext()))
        self.assertEqual(docker.starts, 1)
        self.assertEqual(
            docker.held_at_removal.split(),
            [f"{DATABASE}.{table}" for table in ("members", "migrations", "migrations_lock", "posts", "settings", "users")],
            "the restore did not load the tenant's tables before the server was removed",
        )
        self.assert_nothing_left(docker)

    def test_keep_hands_a_passing_server_over_and_nothing_else_removes_it(self):
        docker = ThrowawayDocker(self.server)
        report = self.gate(docker, keep=True)
        self.assertTrue(report.ok, report.error)
        self.assertEqual(self.server.databases(), [DATABASE])
        self.assertEqual(docker.removals, 0)
        self.assertEqual(report.scratch.container, "scratch-preflight-mysql-abcd")
        self.assertNotIn(report.scratch.password, repr(report.scratch))
        report.scratch.discard()
        self.assertEqual(docker.removals, 1)
        self.assertEqual(self.server.databases(), [])

    def test_the_gate_reaches_no_host_but_the_scratch_server(self):
        docker = ThrowawayDocker(self.server)
        self.assertTrue(self.gate(docker).ok)
        hosts = {call[call.index("--host") + 1] for call in docker.calls if "--host" in call}
        self.assertEqual(hosts, {"scratch-preflight-mysql-abcd"})
        networks = {call[call.index("--network") + 1] for call in docker.calls if "--network" in call}
        self.assertEqual(networks, {"none", "scratch-preflight-abcd"})

    def test_the_scratch_network_has_no_route_out_and_every_container_is_labelled(self):
        docker = ThrowawayDocker(self.server)
        self.assertTrue(self.gate(docker).ok)
        create = next(c for c in docker.calls if c[:3] == ["docker", "network", "create"])
        self.assertIn("--internal", create)
        self.assertIn(f"{sp.SCRATCH_LABEL}=abcd", create)
        server = next(c for c in docker.calls if c[:3] == ["docker", "run", "-d"])
        self.assertIn(f"{sp.SCRATCH_LABEL}=abcd", server)
        self.assertEqual(server[server.index("--tmpfs") + 1],
                         f"{rd.MYSQL_DATADIR}:rw,noexec,nosuid,size={rd.MYSQL_TMPFS_SIZE}")

    def test_the_password_crosses_as_environment_never_argv(self):
        docker = ThrowawayDocker(self.server)
        self.assertTrue(self.gate(docker).ok)
        password = next(e["MYSQL_ROOT_PASSWORD"] for e in docker.envs if "MYSQL_ROOT_PASSWORD" in e)
        self.assertGreaterEqual(len(password), 24)
        self.assertNotIn(password, " ".join(" ".join(c) for c in docker.calls))
        self.assertIn(password, [e.get("MYSQL_PWD") for e in docker.envs])

    def test_everything_that_sees_plaintext_runs_without_a_log(self):
        docker = ThrowawayDocker(self.server)
        self.assertTrue(self.gate(docker).ok)
        transient = [c for c in docker.calls if c[:3] == ["docker", "run", "--rm"]]
        self.assertGreaterEqual(len(transient), 3)
        for call in transient:
            self.assertIn(("--log-driver", "none"), list(zip(call, call[1:])), call)

    # the refusals, each a real restore that must not pass ------------------------

    def test_control_a_restore_that_exits_nonzero_after_loading_everything_is_refused(self):
        """Every watched table loads and the content equals the manifest, so only
        the import's own exit status can refuse this one."""
        self.store_backup(backup_plaintext(tail="INSERT INTO `scratch_no_such_table` VALUES (1);\n"))
        docker = ThrowawayDocker(self.server)
        report = self.gate(docker, keep=True)
        self.assertFalse(report.ok)
        self.assertIsNone(report.scratch)
        self.assertIn("DumpImportError", report.error)
        self.assertIn("1146", report.error)
        self.assert_nothing_left(docker)

    def test_control_the_import_exit_is_the_only_thing_that_refuses_it(self):
        """The same backup with the import's failure swallowed passes: the control
        above is sensitive to exactly that check."""
        self.store_backup(backup_plaintext(tail="INSERT INTO `scratch_no_such_table` VALUES (1);\n"))
        real = rd.restore_drained.restore_only

        def swallow(**kwargs):
            with contextlib.suppress(rd.restore_drained.DumpImportError):
                real(**kwargs)

        with mock.patch.object(rd.restore_drained, "restore_only", swallow):
            report = self.gate(ThrowawayDocker(self.server))
        self.assertTrue(report.ok, "the sabotaged gate should have wrongly passed this restore")

    def test_control_a_dump_that_does_not_parse_is_refused(self):
        self.store_backup(backup_plaintext(lines=dump_lines()[:3] + ["THIS IS NOT SQL;\n"]))
        docker = ThrowawayDocker(self.server)
        report = self.gate(docker)
        self.assertFalse(report.ok)
        self.assertIn("DumpImportError", report.error)
        self.assert_nothing_left(docker)

    def test_control_a_restore_that_differs_from_its_backup_is_refused(self):
        forged = dataclasses.replace(manifest_of(dump_lines()), site_title="Another Site")
        self.store_backup(backup_plaintext(manifest=forged))
        docker = ThrowawayDocker(self.server)
        report = self.gate(docker)
        self.assertFalse(report.ok)
        self.assertIn("ContentFloorError", report.error)
        self.assertIn("site_title: restored \"Fixture's Site\", backed up 'Another Site'", report.error)
        self.assert_nothing_left(docker)

    def test_control_the_content_comparison_is_what_refuses_a_differing_restore(self):
        forged = dataclasses.replace(manifest_of(dump_lines()), users=7)
        self.store_backup(backup_plaintext(manifest=forged))
        with mock.patch.object(rd, "compare_with_manifest", lambda content, manifest: None):
            report = self.gate(ThrowawayDocker(self.server))
        self.assertTrue(report.ok, "the sabotaged gate should have wrongly passed this restore")

    def test_control_an_empty_restore_is_refused(self):
        """Imports cleanly into an empty database, backed up as a real site."""
        self.store_backup(backup_plaintext(lines=dump_lines(create_schema=False)))
        docker = ThrowawayDocker(self.server)
        report = self.gate(docker)
        self.assertFalse(report.ok)
        self.assertIn("holds no Ghost schema", report.error)
        self.assert_nothing_left(docker)

    def test_control_a_server_that_already_holds_the_database_is_never_imported_into(self):
        seed = f"CREATE DATABASE `{DATABASE}`; CREATE TABLE `{DATABASE}`.`canary` (`id` INT); " \
               f"INSERT INTO `{DATABASE}`.`canary` VALUES (1);"
        docker = ThrowawayDocker(self.server, preseed=seed)
        report = self.gate(docker)
        self.assertFalse(report.ok)
        self.assertIn("LiveDatabaseCollisionError", report.error)
        self.assertEqual(docker.held_at_removal, f"{DATABASE}.canary\n", "the import ran into the existing database")

    def test_a_failing_restore_discards_the_server_even_when_the_caller_asked_to_keep_it(self):
        self.store_backup(backup_plaintext(lines=dump_lines()[:3] + ["THIS IS NOT SQL;\n"]))
        docker = ThrowawayDocker(self.server)
        report = self.gate(docker, keep=True)
        self.assertFalse(report.ok)
        self.assertIsNone(report.scratch)
        self.assert_nothing_left(docker)


# --- the refusals that never reach a restore --------------------------------


@unittest.skipUnless(trd.HAVE_AGE, "needs the age binary")
class GateRefusalTests(unittest.TestCase):
    """Backups that must be refused before the restore, and failures around it,
    against the drill's fake docker (no database)."""

    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        self.ids = self.dir / "ids"
        self.ids.mkdir()
        _, self.recipient = trd._keygen(self.ids, TENANT)
        self.config = rd.DrillConfig(
            copies=(trd._copy("primary"), trd._copy("secondary")),
            images=rd.Images(recovery="r" + trd.DIGEST, mysql="m" + trd.DIGEST, ghost="g" + trd.DIGEST,
                             sidecar="s" + trd.DIGEST),
            identity_dir=self.ids, work_dir=self.dir / "work", flag_root=self.dir / "flags",
            metrics_dir=self.dir / "metrics", max_backup_age_s=48 * 3600, require_volatile_work_dir=False,
        )
        self.plaintext = backup_plaintext()
        dump = trd._encrypt(self.plaintext, self.recipient)
        self.store = trd.FakeStore({"primary": {KEY: dump}, "secondary": {KEY: dump}})

    def hooks(self, docker, **kwargs):
        hooks = rd.Hooks(runner=docker, store=self.store, sleep=lambda s: None, clock=trd.Clock(),
                         now=lambda: trd.NOW, run_id=lambda: "abcd")
        for name, value in kwargs.items():
            setattr(hooks, name, value)
        return hooks

    def gate(self, docker, tenant=TENANT, **kwargs):
        hooks = self.hooks(docker, **kwargs.pop("hooks", {}))
        return sp.run_gate(config=self.config, tenant=tenant, hooks=hooks, **kwargs)

    def assert_cleaned_up(self, docker):
        self.assertIn(["docker", "rm", "-f", "-v", "scratch-preflight-mysql-abcd"], docker.calls)
        self.assertIn(["docker", "network", "rm", "scratch-preflight-abcd"], docker.calls)
        self.assertFalse((self.config.work_dir / "preflight-run-abcd").exists())

    def test_a_stale_backup_is_refused_before_anything_starts(self):
        docker = trd.FakeDocker()
        report = self.gate(docker, hooks={"now": lambda: trd.NOW + datetime.timedelta(days=3)})
        self.assertIn("StaleBackupError", report.error)
        self.assertFalse(docker.ran("network create"))

    def test_a_backup_without_a_manifest_is_refused(self):
        self.store.objects["primary"][KEY] = trd._encrypt(b"CREATE DATABASE ghost_blog;\n", self.recipient)
        docker = trd.FakeDocker()
        report = self.gate(docker)
        self.assertIn("carries no manifest", report.error)
        self.assertFalse(docker.ran("MYSQL_ROOT_PASSWORD"))
        self.assert_cleaned_up(docker)

    def test_a_backup_with_two_recipients_is_refused_before_it_is_decrypted(self):
        _, other = trd._keygen(self.dir, "other")
        self.store.objects["primary"][KEY] = trd._encrypt(self.plaintext, self.recipient, other)
        docker = trd.FakeDocker()
        report = self.gate(docker)
        self.assertIn("RecipientAuditError", report.error)
        self.assertFalse(docker.ran("age --decrypt"))

    def test_a_backup_the_tenants_own_key_cannot_open_is_refused(self):
        _, other = trd._keygen(self.dir, "other")
        self.store.objects["primary"][KEY] = trd._encrypt(self.plaintext, other)
        report = self.gate(trd.FakeDocker())
        self.assertIn("DecryptError", report.error)

    def test_a_missing_identity_invalid_name_unknown_copy_and_no_backup_are_refused(self):
        self.assertIn("DrillConfigError", self.gate(trd.FakeDocker(), tenant="other").error)
        self.assertIn("InvalidTenantName", self.gate(trd.FakeDocker(), tenant="Bad_Name").error)
        self.assertIn("no configured copy", self.gate(trd.FakeDocker(), copy_name="third").error)
        self.store.objects["primary"].clear()
        self.assertIn("NoBackupError", self.gate(trd.FakeDocker()).error)

    def test_a_non_volatile_work_dir_is_refused_before_decrypting(self):
        self.config = dataclasses.replace(self.config, require_volatile_work_dir=True)
        docker = trd.FakeDocker()
        with mock.patch.object(rd, "require_volatile", side_effect=rd.DrillConfigError("on ext4, not tmpfs")):
            report = self.gate(docker)
        self.assertIn("not tmpfs", report.error)
        self.assertFalse(docker.ran("age --decrypt"))

    def test_docker_unavailable_is_a_refusal_not_a_pass(self):
        docker = trd.FakeDocker(fail={"ps -aq": trd._completed([], code=1, err="Cannot connect to the Docker daemon")})
        report = self.gate(docker)
        self.assertFalse(report.ok)
        self.assertIn("Cannot connect", report.error)

    def test_an_image_that_cannot_be_pulled_is_a_refusal(self):
        docker = trd.FakeDocker(fail={
            "image inspect": trd._completed([], code=1, err="No such image"),
            "pull": trd._completed([], code=1, err="denied"),
        })
        report = self.gate(docker)
        self.assertIn("denied", report.error)
        self.assertFalse(docker.ran("network create"))

    def test_a_scratch_server_that_cannot_start_is_a_refusal_and_is_cleaned_up(self):
        docker = trd.FakeDocker(fail={"run -d": trd._completed([], code=1, err="no space left")})
        report = self.gate(docker)
        self.assertIn("ScratchStartError", report.error)
        self.assert_cleaned_up(docker)

    def test_a_server_that_never_answers_is_a_refusal(self):
        docker = trd.FakeDocker(fail={"SELECT 1;": trd._completed([], code=1, err="Can't connect")})
        report = self.gate(docker)
        self.assertIn("ReadinessError", report.error)
        self.assert_cleaned_up(docker)

    def test_sigterm_mid_run_removes_the_server_and_the_decrypted_dump(self):
        def interrupt(argv):
            self.assertTrue((self.config.work_dir / "preflight-run-abcd" / "dump.sql").exists())
            raise rd.DrillInterrupted()

        docker = trd.FakeDocker(fail={"network create": interrupt})
        report = self.gate(docker)
        self.assertTrue(report.interrupted)
        self.assertFalse(report.ok)
        self.assert_cleaned_up(docker)

    # the discard, on every path -------------------------------------------------

    def test_discard_after_an_error_nobody_foresaw(self):
        def boom(argv):
            raise RuntimeError("docker returned nonsense")

        docker = trd.FakeDocker(fail={"network create": boom})
        report = self.gate(docker)
        self.assertFalse(report.ok)
        self.assertIn("UnexpectedError: RuntimeError: docker returned nonsense", report.error)
        self.assert_cleaned_up(docker)

    def test_discard_when_removing_the_server_fails_still_removes_the_network_and_the_plaintext(self):
        def gone(argv):
            raise OSError("docker went away")

        docker = trd.FakeDocker(fail={
            "network create": trd._completed([], code=1, err="no space"),
            "rm -f -v scratch-preflight-mysql-abcd": gone,
        })
        report = self.gate(docker)
        self.assertFalse(report.ok)
        self.assertIn("no space", report.error)
        self.assertIn("could not remove the scratch copy", report.error)
        self.assert_cleaned_up(docker)

    def test_a_passing_gate_whose_network_cannot_be_removed_is_refused(self):
        docker = trd.FakeDocker(
            snapshot="Fixture's Site\t1\t2\t3\tNewest Fixture Post\n",
            fail={"network rm": trd._completed([], code=1, err="network has active endpoints")},
        )
        report = self.gate(docker)
        self.assertFalse(report.ok, "a copy that could not be removed must refuse the swap")
        self.assertIn("network has active endpoints", report.error)
        self.assertIsNone(report.scratch)
        self.assert_cleaned_up(docker)

    def test_control_the_same_gate_passes_when_the_removal_succeeds(self):
        docker = trd.FakeDocker(snapshot="Fixture's Site\t1\t2\t3\tNewest Fixture Post\n")
        self.assertTrue(self.gate(docker).ok)

    def test_a_thing_docker_says_is_gone_is_not_a_failed_removal(self):
        for wording in ("Error: No such network: scratch-preflight-abcd", "Error response from daemon: network scratch-preflight-abcd not found"):
            with self.subTest(wording=wording):
                docker = trd.FakeDocker(
                    snapshot="Fixture's Site\t1\t2\t3\tNewest Fixture Post\n",
                    fail={"network rm": trd._completed([], code=1, err=wording)},
                )
                self.assertTrue(self.gate(docker).ok)

    def test_a_removal_that_is_interrupted_is_held_until_the_others_are_tried(self):
        calls: list[list[str]] = []

        def runner(argv, **kwargs):
            calls.append(list(argv))
            if argv[:2] == ["docker", "rm"]:
                raise rd.DrillInterrupted()
            return trd._completed(argv)

        with self.assertRaises(rd.DrillInterrupted):
            sp.run_removals(runner, [["docker", "rm", "-f", "-v", "c"], ["docker", "network", "rm", "n"]])
        self.assertEqual([c[:2] for c in calls], [["docker", "rm"], ["docker", "network"]])

    def test_the_decrypted_dump_is_private_and_gone_afterwards(self):
        seen = {}

        def look(argv):
            dump = self.config.work_dir / "preflight-run-abcd" / "dump.sql"
            seen["mode"] = dump.stat().st_mode & 0o777
            seen["run_dir"] = (self.config.work_dir / "preflight-run-abcd").stat().st_mode & 0o777
            raise rd.DrillInterrupted()

        self.gate(trd.FakeDocker(fail={"network create": look}))
        self.assertEqual((seen["mode"], seen["run_dir"]), (0o600, 0o700))

    def test_a_gate_never_touches_a_drill_run_directory(self):
        drill = self.config.work_dir / "run-1234"
        (drill / "dump.sql").parent.mkdir(parents=True)
        (drill / "dump.sql").write_text("drill plaintext")
        stale = self.config.work_dir / "preflight-run-dead"
        stale.mkdir()
        self.gate(trd.FakeDocker())
        self.assertTrue((drill / "dump.sql").exists())
        self.assertFalse(stale.exists())


# --- the command line --------------------------------------------------------


@unittest.skipUnless(trd.HAVE_AGE, "needs the age binary")
class MainTests(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        ids = self.dir / "ids"
        ids.mkdir()
        _, recipient = trd._keygen(ids, TENANT)
        dump = trd._encrypt(backup_plaintext(), recipient)
        self.store = trd.FakeStore({"primary": {KEY: dump}})
        self.env = trd._env(BACKUP_DRILL_IDENTITY_DIR=str(ids), BACKUP_DRILL_WORK_DIR=str(self.dir / "work"))

    def hooks(self, docker):
        return rd.Hooks(runner=docker, store=self.store, sleep=lambda s: None, clock=trd.Clock(),
                        now=lambda: trd.NOW, run_id=lambda: "abcd")

    def main(self, docker, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = sp.main(argv, hooks=self.hooks(docker), environ=self.env)
        return code, out.getvalue(), err.getvalue()

    def test_a_pass_exits_zero(self):
        docker = trd.FakeDocker(snapshot="Fixture's Site\t1\t2\t3\tNewest Fixture Post\n")
        code, out, err = self.main(docker, ["--tenant", TENANT, "--allow-disk-work-dir"])
        self.assertEqual((code, err), (0, ""), out)
        self.assertIn("scratch_preflight: PASS", out)

    def test_a_refusal_exits_one_and_says_so(self):
        docker = trd.FakeDocker(snapshot="Ghost\t1\t1\t0\tComing soon\n")
        code, out, err = self.main(docker, ["--tenant", TENANT, "--allow-disk-work-dir"])
        self.assertEqual(code, sp.EXIT_REFUSED)
        self.assertIn("scratch_preflight: REFUSED", err)
        self.assertNotIn("PASS", out + err)

    def test_the_environment_cannot_switch_off_the_tmpfs_check(self):
        self.env["BACKUP_DRILL_REQUIRE_VOLATILE_WORK_DIR"] = "0"
        docker = trd.FakeDocker()
        code, _, err = self.main(docker, ["--tenant", TENANT])
        self.assertEqual(code, sp.EXIT_NOT_RUN)
        self.assertIn("tmpfs check", err)
        self.assertEqual(docker.calls, [])

    def test_a_tenant_is_required(self):
        code, _, err = self.main(trd.FakeDocker(), [])
        self.assertEqual(code, sp.EXIT_NOT_RUN)
        self.assertIn("--tenant is required", err)

    def test_a_bad_max_age_is_not_run(self):
        for value in ("0", "-1", "nan"):
            with self.subTest(value=value):
                code, _, err = self.main(trd.FakeDocker(), ["--tenant", TENANT, "--max-age-hours", value])
                self.assertEqual(code, sp.EXIT_NOT_RUN)
                self.assertIn("positive", err)

    def test_max_age_hours_tightens_the_age_bound(self):
        docker = trd.FakeDocker(snapshot="Fixture's Site\t1\t2\t3\tNewest Fixture Post\n")
        code, _, err = self.main(docker, ["--tenant", TENANT, "--allow-disk-work-dir", "--max-age-hours", "1"])
        self.assertEqual(code, sp.EXIT_REFUSED)
        self.assertIn("StaleBackupError", err)

    def test_a_second_run_is_refused_while_one_holds_the_lock(self):
        (self.dir / "work").mkdir()
        with open(self.dir / "work" / sp.LOCK_NAME, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            code, _, err = self.main(trd.FakeDocker(), ["--tenant", TENANT, "--allow-disk-work-dir"])
        self.assertEqual(code, sp.EXIT_NOT_RUN)
        self.assertIn("holds the lock", err)

    def test_cleanup_removes_labelled_leftovers_and_run_directories(self):
        stale = self.dir / "work" / "preflight-run-dead"
        stale.mkdir(parents=True)
        docker = trd.FakeDocker(fail={
            "ps -aq": trd._completed([], out="c1\n"),
            "network ls": trd._completed([], out="n1\n"),
        })
        code, out, _ = self.main(docker, ["--cleanup"])
        self.assertEqual(code, 0)
        self.assertIn(["docker", "ps", "-aq", "--filter", f"label={sp.SCRATCH_LABEL}"], docker.calls)
        self.assertIn(["docker", "rm", "-f", "-v", "c1"], docker.calls)
        self.assertIn(["docker", "network", "rm", "n1"], docker.calls)
        self.assertFalse(stale.exists())
        self.assertIn("removed", out)

    def test_cleanup_with_docker_down_fails(self):
        docker = trd.FakeDocker(fail={"ps -aq": trd._completed([], code=1, err="daemon down")})
        code, _, err = self.main(docker, ["--cleanup"])
        self.assertEqual(code, sp.EXIT_REFUSED)
        self.assertIn("daemon down", err)


class SharedPullTests(unittest.TestCase):
    def test_ensure_images_pulls_only_what_is_absent(self):
        docker = trd.FakeDocker(fail={"inspect --format {{.Id}} m": trd._completed([], code=1, err="No such image")})
        rd.ensure_images(docker, ["r" + trd.DIGEST, "m" + trd.DIGEST])
        self.assertEqual([c[-1] for c in docker.calls if c[1] == "pull"], ["m" + trd.DIGEST])


if __name__ == "__main__":
    unittest.main()
