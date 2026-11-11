#!/usr/bin/env python3
"""Unit tests for scratch_boot_smoke.py. Part 1's restore runs for real (every
`mysql` call lands on a throwaway MySQL server, as in test_scratch_preflight.py);
the docker calls around it are faked, and so is the green colour's HTTP, which
in production is read from inside the colour's own container. Nothing here
reaches a host. See scratch_boot_smoke.md."""

from __future__ import annotations

import contextlib
import fcntl
import html
import io
import pathlib
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import restore_drill as rd
import scratch_boot_smoke as sbs
import scratch_migrate as sm
import scratch_preflight as sp
import test_restore_drill as trd
import test_scratch_preflight as tsp

TENANT = tsp.TENANT
GHOST = "scratch-preflight-ghost-abcd"
SIDECAR = "scratch-preflight-sidecar-abcd"
MYSQL = "scratch-preflight-mysql-abcd"
NETWORK = "scratch-preflight-abcd"
PASSING_BODY = html.escape("<h1>Fixture's Site</h1><p>Newest Fixture Post</p>")
ALL_CHECKS = ["drained at boot", "serves", "migrations", "tenant content", "ready once undrained"]

# What the colour's boot migrations do to the restored copy, as the throwaway
# server sees it. The restore leaves two applied migrations and a free lock.
MIGRATED = (
    f"INSERT INTO `{tsp.DATABASE}`.`migrations` (`name`, `version`) VALUES "
    "('2026-09-01-00-00-00-fixture-two.js','6.56'),('2026-09-02-00-00-00-fixture-three.js','6.56');"
)
LOCK_HELD = f"UPDATE `{tsp.DATABASE}`.`migrations_lock` SET `locked`=1 WHERE `lock_key`='km01';"
LOCK_FREE = f"UPDATE `{tsp.DATABASE}`.`migrations_lock` SET `locked`=0 WHERE `lock_key`='km01';"


class FakeColourHttp:
    """The green colour as the checks see it: Ghost answers `ghost` with `body`;
    the sidecar answers `drained` while the flag file exists and `undrained`
    once it is gone. Records, in order, what each request saw."""

    def __init__(self, flag_dir: pathlib.Path, *, body=PASSING_BODY, ghost=200, drained=503, undrained=200):
        self.flag = flag_dir / rd.FLAG_NAME
        self.body, self.ghost, self.drained, self.undrained = body, ghost, drained, undrained
        self.events: list[str] = []

    def __call__(self, url, timeout_s):
        flag = "flag-set" if self.flag.exists() else "flag-clear"
        if url.endswith("/healthz"):
            status = self.drained if self.flag.exists() else self.undrained
            self.events.append(f"sidecar:{status}:{flag}")
            return status, ""
        self.events.append(f"ghost:{self.ghost}:{flag}")
        return self.ghost, self.body if self.ghost == 200 else ""


class BootDocker(tsp.ThrowawayDocker):
    """The part 1 fake, except that starting the colour does not reset the
    scratch server: only the scratch server's own `docker run` does. Starting
    the Ghost runs `migrate` on the server, as Ghost's boot migrations would."""

    def __init__(self, server, *, migrate: str | None = MIGRATED, **kwargs) -> None:
        super().__init__(server, **kwargs)
        self.migrate = migrate

    def __call__(self, argv, **kwargs):
        if argv[:3] == ["docker", "run", "-d"] and ("--name" in argv) and argv[argv.index("--name") + 1] in (GHOST, SIDECAR):
            result = trd.FakeDocker.__call__(self, argv, **kwargs)
            if argv[argv.index("--name") + 1] == GHOST and result.returncode == 0 and self.migrate:
                self.server.sql(self.migrate)
            return result
        return super().__call__(argv, **kwargs)

    def colour_runs(self) -> list[list[str]]:
        return [c for c in self.calls if c[:3] == ["docker", "run", "-d"] and c[c.index("--name") + 1] in (GHOST, SIDECAR)]


@unittest.skipUnless(trd.HAVE_AGE, "needs the age binary")
class BootGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = tsp.Throwaway()
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
        self.flag_dir = self.config.flag_root / f"{sbs.FLAG_DIR_PREFIX}abcd"
        self.server.wipe()
        self.store_backup(tsp.backup_plaintext())

    def store_backup(self, plaintext: bytes) -> None:
        dump = trd._encrypt(plaintext, self.recipient)
        self.store = trd.FakeStore({"primary": {tsp.KEY: dump}, "secondary": {tsp.KEY: dump}})

    def hooks(self, docker):
        hooks = rd.Hooks(runner=docker, store=self.store, sleep=lambda s: None, clock=trd.Clock(),
                         now=lambda: trd.NOW, run_id=lambda: "abcd")
        hooks.content_timeout_s = 5.0
        hooks.sidecar_timeout_s = 5.0
        return hooks

    def boot(self, docker, http=None, *, sleep=None, **kwargs):
        http = http or FakeColourHttp(self.flag_dir)
        self.asked_for = []
        hooks = self.hooks(docker)
        if sleep is not None:
            hooks.sleep = sleep

        def make_get(container):
            self.asked_for.append(container)
            return http

        return sbs.run_boot_gate(config=self.config, tenant=TENANT, hooks=hooks, make_get=make_get, **kwargs)

    def assert_nothing_left(self, docker):
        self.assertEqual(self.server.databases(), [], "the scratch server still holds a tenant database")
        self.assertIn(["docker", "rm", "-f", "-v", SIDECAR], docker.calls)
        self.assertIn(["docker", "rm", "-f", "-v", GHOST], docker.calls)
        self.assertIn(["docker", "network", "rm", NETWORK], docker.calls)
        self.assertFalse(self.flag_dir.exists())
        self.assertFalse((self.config.work_dir / "preflight-run-abcd").exists())

    def assert_colour_goes_before_the_network(self, docker):
        removals = [c for c in docker.calls if c[:3] in (["docker", "rm", "-f"], ["docker", "network", "rm"])]
        order = [c[-1] for c in removals]
        self.assertLess(max(order.index(SIDECAR), order.index(GHOST)), order.index(NETWORK))

    # green --------------------------------------------------------------------

    def test_green_boots_the_candidate_on_the_restored_copy_and_passes_every_check(self):
        docker = BootDocker(self.server)
        http = FakeColourHttp(self.flag_dir)
        report = self.boot(docker, http)
        self.assertTrue(report.ok, report.error)
        self.assertEqual(report.checks, ALL_CHECKS)
        self.assertEqual(self.asked_for, [GHOST])
        ghost = docker.colour_runs()[0]
        self.assertEqual(ghost[-1], self.config.images.ghost)
        self.assertIn(f"database__connection__database={tsp.DATABASE}", ghost)
        self.assertEqual(docker.colour_runs()[1][-1], self.config.images.sidecar)
        self.assert_nothing_left(docker)
        self.assert_colour_goes_before_the_network(docker)

    def test_the_flag_stays_up_until_the_content_is_proven_then_the_colour_undrains(self):
        http = FakeColourHttp(self.flag_dir)
        self.assertTrue(self.boot(BootDocker(self.server), http).ok)
        first_clear = next(i for i, e in enumerate(http.events) if e.endswith(":flag-clear"))
        self.assertTrue(all(e.endswith(":flag-set") for e in http.events[:first_clear]))
        self.assertIn("ghost:200:flag-set", http.events[:first_clear])
        self.assertEqual(http.events[first_clear], "sidecar:200:flag-clear")

    def test_no_public_traffic_reaches_the_colour_and_it_has_no_route_out(self):
        docker = BootDocker(self.server)
        self.assertTrue(self.boot(docker).ok)
        ghost, sidecar = docker.colour_runs()
        for call in (ghost, sidecar):
            self.assertNotIn("-p", call)
            self.assertNotIn("--publish", call)
            self.assertNotIn("-P", call)
            self.assertNotIn("host", call)
            self.assertIn(f"{sp.SCRATCH_LABEL}=abcd", call)
        self.assertEqual(ghost[ghost.index("--network") + 1], NETWORK)
        self.assertEqual(sidecar[sidecar.index("--network") + 1], f"container:{GHOST}")
        create = next(c for c in docker.calls if c[:3] == ["docker", "network", "create"])
        self.assertIn("--internal", create)
        self.assertFalse(any(c[:2] == ["docker", "port"] for c in docker.calls))

    def test_the_colour_reaches_no_database_but_the_scratch_server(self):
        docker = BootDocker(self.server)
        self.assertTrue(self.boot(docker).ok)
        hosts = {a for c in docker.colour_runs() for a in c if a.startswith("database__connection__host=")}
        self.assertEqual(hosts, {f"database__connection__host={MYSQL}"})

    def test_the_password_reaches_the_colour_as_environment_never_argv(self):
        docker = BootDocker(self.server)
        self.assertTrue(self.boot(docker).ok)
        password = next(e["MYSQL_ROOT_PASSWORD"] for e in docker.envs if "MYSQL_ROOT_PASSWORD" in e)
        self.assertIn(password, [e.get("database__connection__password") for e in docker.envs])
        self.assertNotIn(password, " ".join(" ".join(c) for c in docker.calls))

    def test_the_gate_reaches_no_host_but_the_scratch_server(self):
        docker = BootDocker(self.server)
        self.assertTrue(self.boot(docker).ok)
        hosts = {c[c.index("--host") + 1] for c in docker.calls if "--host" in c}
        self.assertEqual(hosts, {MYSQL})

    # the controls: each is a colour that must not pass --------------------------

    def test_control_a_colour_that_never_serves_is_refused(self):
        docker = BootDocker(self.server)
        report = self.boot(docker, FakeColourHttp(self.flag_dir, ghost=503))
        self.assertFalse(report.ok)
        self.assertIn("check 'serves' failed", report.error)
        self.assertEqual(report.checks, ["drained at boot"])
        self.assert_nothing_left(docker)

    def test_control_a_colour_that_serves_without_the_tenants_content_is_refused(self):
        """A Ghost on an empty database answers 200 too."""
        docker = BootDocker(self.server)
        report = self.boot(docker, FakeColourHttp(self.flag_dir, body="<h1>Coming soon</h1>"))
        self.assertFalse(report.ok)
        self.assertIn("check 'tenant content' failed", report.error)
        self.assertIn("ContentVerificationError", report.error)
        self.assertEqual(report.checks, ["drained at boot", "serves", "migrations"])
        self.assert_nothing_left(docker)

    def test_control_a_colour_that_is_not_drained_at_boot_is_refused(self):
        docker = BootDocker(self.server)
        report = self.boot(docker, FakeColourHttp(self.flag_dir, drained=200))
        self.assertFalse(report.ok)
        self.assertIn("check 'drained at boot' failed", report.error)
        self.assertEqual(report.checks, [])
        self.assert_nothing_left(docker)

    def test_control_a_colour_that_never_reports_ready_is_refused(self):
        docker = BootDocker(self.server)
        report = self.boot(docker, FakeColourHttp(self.flag_dir, undrained=503))
        self.assertFalse(report.ok)
        self.assertIn("check 'ready once undrained' failed", report.error)
        self.assertEqual(report.checks, ["drained at boot", "serves", "migrations", "tenant content"])
        self.assert_nothing_left(docker)

    # the migrations: what the colour's boot migrations did to the copy -------------

    def test_green_records_what_the_colours_migrations_did_to_the_copy(self):
        docker = BootDocker(self.server)
        report = self.boot(docker)
        self.assertTrue(report.ok, report.error)
        outcome = report.migrations
        self.assertEqual((outcome.before_count, outcome.after_count), (2, 4))
        self.assertEqual((outcome.from_version, outcome.to_version), ("6.55", "6.56"))
        self.assertEqual(outcome.applied, ("2026-09-01-00-00-00-fixture-two.js", "2026-09-02-00-00-00-fixture-three.js"))
        self.assertIn("scratch_boot_smoke: migrations: before=2 after=4 applied=2 from=6.55 to=6.56",
                      sbs.format_report(report))
        self.assert_nothing_left(docker)

    def test_a_colour_with_nothing_to_migrate_passes_and_records_that(self):
        report = self.boot(BootDocker(self.server, migrate=None))
        self.assertTrue(report.ok, report.error)
        self.assertEqual(report.migrations.applied, ())
        self.assertEqual(report.migrations.before_count, report.migrations.after_count)

    def test_the_migrations_are_read_after_the_colour_serves_and_before_its_content_is_checked(self):
        report = self.boot(BootDocker(self.server))
        self.assertEqual(report.checks.index("migrations"), report.checks.index("serves") + 1)
        self.assertEqual(report.checks.index("tenant content"), report.checks.index("migrations") + 1)

    def test_a_lock_that_is_released_while_the_gate_waits_is_a_pass(self):
        docker = BootDocker(self.server, migrate=MIGRATED + LOCK_HELD)
        report = self.boot(docker, sleep=lambda seconds: self.server.sql(LOCK_FREE))
        self.assertTrue(report.ok, report.error)
        self.assertEqual(len(report.migrations.applied), 2)
        self.assert_nothing_left(docker)

    def test_control_a_colour_whose_migration_never_releases_its_lock_is_refused(self):
        """Ghost answers 200 and shows the tenant's content, and the swap is
        still refused: the migration did not finish."""
        docker = BootDocker(self.server, migrate=MIGRATED + LOCK_HELD)
        report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertIn("check 'migrations' failed", report.error)
        self.assertIn("lock is still held", report.error)
        self.assertEqual(report.checks, ["drained at boot", "serves"])
        self.assertIsNone(report.migrations)
        self.assert_nothing_left(docker)

    def test_control_the_lock_check_is_what_refuses_it(self):
        """The same colour with that check removed passes."""
        docker = BootDocker(self.server, migrate=MIGRATED + LOCK_HELD)
        free = sm.MigrationOutcome(before_count=2, after_count=4, from_version="6.55", to_version="6.56", applied=())
        with mock.patch.object(sm, "judge", lambda before, after: free):
            report = self.boot(docker)
        self.assertTrue(report.ok, "the sabotaged gate should have wrongly passed this colour")

    def test_control_a_migration_that_removed_an_applied_migration_is_refused(self):
        docker = BootDocker(self.server, migrate=f"DELETE FROM `{tsp.DATABASE}`.`migrations` WHERE `id` = 1;")
        report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertIn("do not extend", report.error)
        self.assert_nothing_left(docker)

    def test_control_migration_tables_that_cannot_be_read_after_the_run_are_refused(self):
        docker = BootDocker(self.server, migrate=f"DROP TABLE `{tsp.DATABASE}`.`migrations`;")
        report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertIn("check 'migrations' failed", report.error)
        self.assertIn("could not be read", report.error)
        self.assert_nothing_left(docker)

    def test_control_a_backup_with_no_migration_record_is_refused_before_the_colour_starts(self):
        self.store_backup(tsp.backup_plaintext(lines=tsp.dump_lines(migration_tables=False)))
        docker = BootDocker(self.server)
        report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertIn("could not be read", report.error)
        self.assertEqual(docker.colour_runs(), [])
        self.assert_nothing_left(docker)

    # the discard, on every path ---------------------------------------------------

    def test_discard_after_a_pass(self):
        docker = BootDocker(self.server)
        self.assertTrue(self.boot(docker).ok)
        self.assert_nothing_left(docker)

    def test_discard_after_a_failed_smoke_check(self):
        docker = BootDocker(self.server)
        self.assertFalse(self.boot(docker, FakeColourHttp(self.flag_dir, ghost=503)).ok)
        self.assert_nothing_left(docker)

    def test_discard_after_a_failed_migration(self):
        docker = BootDocker(self.server, migrate=MIGRATED + LOCK_HELD)
        self.assertFalse(self.boot(docker).ok)
        self.assert_nothing_left(docker)

    def test_discard_after_an_error_nobody_foresaw_while_the_colour_is_checked(self):
        def boom(url, timeout_s):
            raise RuntimeError("a bug in a check")

        docker = BootDocker(self.server)
        report = self.boot(docker, boom)
        self.assertFalse(report.ok)
        self.assertIn("UnexpectedError: RuntimeError: a bug in a check", report.error)
        self.assert_nothing_left(docker)

    def test_discard_after_an_error_nobody_foresaw_while_the_colour_starts(self):
        def boom(argv):
            raise RuntimeError("docker returned nonsense")

        docker = BootDocker(self.server, fail={f"--name {GHOST}": boom})
        report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertIn("UnexpectedError: RuntimeError", report.error)
        self.assert_nothing_left(docker)

    def test_discard_after_an_error_nobody_foresaw_while_the_migrations_are_read(self):
        docker = BootDocker(self.server)
        with mock.patch.object(sm, "read_state", side_effect=RuntimeError("a bug in the reader")):
            report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertIn("UnexpectedError: RuntimeError: a bug in the reader", report.error)
        self.assert_nothing_left(docker)

    def test_discard_after_sigterm_during_the_checks(self):
        def term(url, timeout_s):
            raise rd.DrillInterrupted()

        docker = BootDocker(self.server)
        report = self.boot(docker, term)
        self.assertTrue(report.interrupted)
        self.assertFalse(report.ok)
        self.assert_nothing_left(docker)

    def test_discard_after_a_keyboard_interrupt_during_the_checks(self):
        def interrupt(url, timeout_s):
            raise KeyboardInterrupt()

        docker = BootDocker(self.server)
        with self.assertRaises(KeyboardInterrupt):
            self.boot(docker, interrupt)
        self.assert_nothing_left(docker)

    def test_discard_when_removing_the_colour_itself_fails(self):
        """The runner breaks on the sidecar's removal; the Ghost, the scratch
        server and the network are still removed, and the swap is refused."""
        def gone(argv):
            raise OSError("docker went away")

        docker = BootDocker(self.server, fail={f"rm -f -v {SIDECAR}": gone})
        report = self.boot(docker)
        self.assertFalse(report.ok, "a copy that could not be removed must refuse the swap")
        self.assertIn("could not remove the scratch copy", report.error)
        self.assert_nothing_left(docker)

    def test_discard_when_removing_the_network_fails_refuses_the_swap(self):
        docker = BootDocker(self.server, fail={
            "network rm": trd._completed([], code=1, err="network has active endpoints"),
        })
        report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertIn("network has active endpoints", report.error)
        self.assertEqual(report.checks, ALL_CHECKS, "the refusal is the removal, not a check")

    def test_a_thing_that_is_already_gone_is_not_a_failed_discard(self):
        docker = BootDocker(self.server, fail={
            f"rm -f -v {GHOST}": trd._completed([], code=1, err="Error: No such container"),
        })
        self.assertTrue(self.boot(docker).ok)

    def test_control_the_smoke_checks_are_what_refuse_an_empty_colour(self):
        """The same colour with the checks removed passes: the controls above
        are sensitive to exactly these checks."""
        docker = BootDocker(self.server)
        with mock.patch.object(sbs, "run_smoke_checks", lambda **kwargs: None):
            report = self.boot(docker, FakeColourHttp(self.flag_dir, body="<h1>Coming soon</h1>", ghost=503))
        self.assertTrue(report.ok, "the sabotaged gate should have wrongly passed this colour")

    def test_control_a_colour_that_cannot_start_is_refused_and_everything_is_removed(self):
        docker = BootDocker(self.server, fail={f"--name {GHOST}": trd._completed([], code=125, err="no such image")})
        report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertIn("ColourStartError", report.error)
        self.assertIn("no such image", report.error)
        self.assert_nothing_left(docker)

    def test_control_an_image_that_cannot_be_pulled_is_refused_before_anything_starts(self):
        docker = BootDocker(self.server, fail={
            "image inspect": trd._completed([], code=1, err="No such image"),
            "pull": trd._completed([], code=1, err="denied"),
        })
        report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertIn("denied", report.error)
        self.assertFalse(docker.ran("network create"))
        self.assertEqual(docker.colour_runs(), [])

    def test_control_a_restore_the_first_part_refuses_never_boots_a_colour(self):
        self.store_backup(tsp.backup_plaintext(lines=tsp.dump_lines()[:3] + ["THIS IS NOT SQL;\n"]))
        docker = BootDocker(self.server)
        report = self.boot(docker)
        self.assertFalse(report.ok)
        self.assertFalse(report.gate.ok)
        self.assertIn("DumpImportError", report.error)
        self.assertEqual(docker.colour_runs(), [])
        self.assertEqual(self.server.databases(), [])
        self.assertFalse(self.flag_dir.exists())

    def test_sigterm_mid_boot_removes_the_colour_the_server_and_the_flag(self):
        def interrupt(argv):
            raise rd.DrillInterrupted()

        docker = BootDocker(self.server, fail={f"--name {SIDECAR}": interrupt})
        report = self.boot(docker)
        self.assertTrue(report.interrupted)
        self.assertFalse(report.ok)
        self.assert_nothing_left(docker)


class ExecGetTests(unittest.TestCase):
    def runner(self, result=None, raises=None):
        calls = []

        def run(argv, **kwargs):
            calls.append((list(argv), kwargs))
            if raises:
                raise raises
            return result

        return run, calls

    def test_it_asks_the_colours_own_container_and_reads_status_then_body(self):
        done = subprocess.CompletedProcess([], 0, "200\n<html>\nbody\n", "")
        run, calls = self.runner(done)
        status, body = sbs.exec_get(run, GHOST)("http://127.0.0.1:2368/", 5.0)
        self.assertEqual((status, body), (200, "<html>\nbody\n"))
        argv, kwargs = calls[0]
        self.assertEqual(argv[:5], ["docker", "exec", GHOST, "node", "-e"])
        self.assertEqual(argv[-2:], ["http://127.0.0.1:2368/", "5.0"])
        self.assertIn("x-forwarded-proto", argv[5])
        self.assertGreater(kwargs["timeout"], 5.0)

    def test_a_failed_exec_is_status_zero_with_the_error(self):
        run, _ = self.runner(subprocess.CompletedProcess([], 1, "", "No such container\n"))
        self.assertEqual(sbs.exec_get(run, GHOST)("http://x/", 5.0), (0, "No such container"))

    def test_a_hung_exec_is_status_zero(self):
        run, _ = self.runner(raises=subprocess.TimeoutExpired("docker", 20))
        self.assertEqual(sbs.exec_get(run, GHOST)("http://x/", 5.0)[0], 0)

    def test_output_that_is_not_a_status_is_status_zero(self):
        run, _ = self.runner(subprocess.CompletedProcess([], 0, "garbage", ""))
        self.assertEqual(sbs.exec_get(run, GHOST)("http://x/", 5.0), (0, "garbage"))


class MigrationFake(trd.FakeDocker):
    """The drill's docker fake, answering the migration read with `before` the
    first time and `after` on every read after it."""

    BEFORE = "M\t1-create-fixture-tables.js\tinit\nM\t2026-08-01-00-00-00-fixture-one.js\t6.55\nL\tkm01\t0\n"
    AFTER = BEFORE.replace("L\tkm01", "M\t2026-09-01-00-00-00-fixture-two.js\t6.56\nL\tkm01")

    def __init__(self, *, after=AFTER, **kwargs):
        super().__init__(**kwargs)
        self.reads = [self.BEFORE, after]

    def _mysql(self, argv, kwargs):
        if sm.MIGRATIONS_QUERY in argv:
            out = self.reads.pop(0) if len(self.reads) > 1 else self.reads[0]
            return trd._completed(argv, out=out)
        return super()._mysql(argv, kwargs)


@unittest.skipUnless(trd.HAVE_AGE, "needs the age binary")
class MainTests(unittest.TestCase):
    def setUp(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        ids = self.dir / "ids"
        ids.mkdir()
        _, recipient = trd._keygen(ids, TENANT)
        dump = trd._encrypt(tsp.backup_plaintext(), recipient)
        self.store = trd.FakeStore({"primary": {tsp.KEY: dump}})
        self.env = trd._env(BACKUP_DRILL_IDENTITY_DIR=str(ids), BACKUP_DRILL_WORK_DIR=str(self.dir / "work"),
                            BACKUP_DRILL_FLAG_ROOT=str(self.dir / "flags"))
        self.flag_dir = self.dir / "flags" / f"{sbs.FLAG_DIR_PREFIX}abcd"

    def hooks(self, docker):
        hooks = rd.Hooks(runner=docker, store=self.store, sleep=lambda s: None, clock=trd.Clock(),
                         now=lambda: trd.NOW, run_id=lambda: "abcd")
        hooks.content_timeout_s = hooks.sidecar_timeout_s = 5.0
        return hooks

    def main(self, docker, argv, http=None):
        out, err = io.StringIO(), io.StringIO()
        http = http or FakeColourHttp(self.flag_dir)
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                mock.patch.object(sbs, "exec_get", lambda runner, container: http):
            code = sbs.main(argv, hooks=self.hooks(docker), environ=self.env)
        return code, out.getvalue(), err.getvalue()

    def good_docker(self, **kwargs):
        return MigrationFake(snapshot="Fixture's Site\t1\t2\t3\tNewest Fixture Post\n", **kwargs)

    def test_a_pass_exits_zero_and_lists_every_check(self):
        code, out, err = self.main(self.good_docker(), ["--tenant", TENANT, "--allow-disk-work-dir"])
        self.assertEqual((code, err), (0, ""), out)
        for name in ALL_CHECKS:
            self.assertIn(f"scratch_boot_smoke: check passed: {name}", out)
        self.assertEqual(out.count("PASS"), 1, "only the whole gate's verdict says PASS")
        self.assertTrue(out.strip().splitlines()[-1].startswith("scratch_boot_smoke: PASS"))

    def test_a_failed_check_exits_one_and_the_refusal_is_the_last_line(self):
        http = FakeColourHttp(self.flag_dir, body="<h1>Coming soon</h1>")
        code, out, err = self.main(self.good_docker(), ["--tenant", TENANT, "--allow-disk-work-dir"], http)
        self.assertEqual(code, sbs.EXIT_REFUSED)
        self.assertNotIn("PASS", out + err)
        self.assertTrue(err.strip().splitlines()[-1].startswith("scratch_boot_smoke: REFUSED"), err)
        self.assertIn("tenant content", err)

    def test_a_pass_prints_what_the_migrations_did(self):
        code, out, _ = self.main(self.good_docker(), ["--tenant", TENANT, "--allow-disk-work-dir"])
        self.assertEqual(code, 0)
        self.assertIn("scratch_boot_smoke: migrations: before=2 after=3 applied=1 from=6.55 to=6.56", out)

    def test_a_migration_that_did_not_finish_exits_one_and_never_says_pass(self):
        unfinished = MigrationFake.AFTER.replace("L\tkm01\t0", "L\tkm01\t1")
        code, out, err = self.main(self.good_docker(after=unfinished), ["--tenant", TENANT, "--allow-disk-work-dir"])
        self.assertEqual(code, sbs.EXIT_REFUSED)
        self.assertNotIn("PASS", out + err)
        self.assertTrue(err.strip().splitlines()[-1].startswith("scratch_boot_smoke: REFUSED"), err)
        self.assertIn("check 'migrations' failed", err)

    def test_a_restore_refusal_exits_one_before_any_boot(self):
        docker = trd.FakeDocker(snapshot="Ghost\t1\t1\t0\tComing soon\n")
        code, _, err = self.main(docker, ["--tenant", TENANT, "--allow-disk-work-dir"])
        self.assertEqual(code, sbs.EXIT_REFUSED)
        self.assertIn("scratch_boot_smoke: REFUSED before boot:", err)
        self.assertFalse(docker.ran("--name scratch-preflight-ghost"))

    def test_the_candidate_image_is_the_one_booted(self):
        docker = self.good_docker()
        candidate = "ghcr.io/x/candidate@sha256:" + "b" * 64
        code, _, err = self.main(docker, ["--tenant", TENANT, "--allow-disk-work-dir", "--ghost-image", candidate])
        self.assertEqual((code, err), (0, ""))
        ghost = next(c for c in docker.calls if "--name" in c and c[c.index("--name") + 1] == GHOST)
        self.assertEqual(ghost[-1], candidate)

    def test_an_image_not_named_by_digest_is_not_run(self):
        docker = trd.FakeDocker()
        code, _, err = self.main(docker, ["--tenant", TENANT, "--ghost-image", "ghcr.io/x/ghost:latest"])
        self.assertEqual(code, sbs.EXIT_NOT_RUN)
        self.assertIn("sha256 digest", err)
        self.assertEqual(docker.calls, [])

    def test_a_tenant_is_required(self):
        code, _, err = self.main(trd.FakeDocker(), [])
        self.assertEqual(code, sbs.EXIT_NOT_RUN)
        self.assertIn("--tenant is required", err)

    def test_the_environment_cannot_switch_off_the_tmpfs_check(self):
        self.env["BACKUP_DRILL_REQUIRE_VOLATILE_WORK_DIR"] = "0"
        docker = trd.FakeDocker()
        code, _, err = self.main(docker, ["--tenant", TENANT])
        self.assertEqual(code, sbs.EXIT_NOT_RUN)
        self.assertIn("tmpfs check", err)
        self.assertEqual(docker.calls, [])

    def test_a_second_run_is_refused_while_one_holds_the_lock(self):
        (self.dir / "work").mkdir()
        with open(self.dir / "work" / sp.LOCK_NAME, "w") as held:
            fcntl.flock(held, fcntl.LOCK_EX)
            code, _, err = self.main(trd.FakeDocker(), ["--tenant", TENANT, "--allow-disk-work-dir"])
        self.assertEqual(code, sbs.EXIT_NOT_RUN)
        self.assertIn("holds the lock", err)

    def test_cleanup_removes_the_labelled_colour_and_the_drain_flag_directories(self):
        stale = self.dir / "flags" / f"{sbs.FLAG_DIR_PREFIX}dead"
        stale.mkdir(parents=True)
        drill_flags = self.dir / "flags" / "run-keep"
        drill_flags.mkdir()
        docker = trd.FakeDocker(fail={
            "ps -aq": trd._completed([], out="ghost1\nsidecar1\n"),
            "network ls": trd._completed([], out="n1\n"),
        })
        code, out, _ = self.main(docker, ["--cleanup"])
        self.assertEqual(code, 0)
        self.assertIn(["docker", "rm", "-f", "-v", "ghost1", "sidecar1"], docker.calls)
        self.assertFalse(stale.exists())
        self.assertTrue(drill_flags.exists(), "the drill's own flag directories are not this gate's to remove")
        self.assertIn("removed", out)

    def test_cleanup_with_docker_down_fails(self):
        docker = trd.FakeDocker(fail={"ps -aq": trd._completed([], code=1, err="daemon down")})
        code, _, err = self.main(docker, ["--cleanup"])
        self.assertEqual(code, sbs.EXIT_REFUSED)
        self.assertIn("daemon down", err)


if __name__ == "__main__":
    unittest.main()
