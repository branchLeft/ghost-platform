#!/usr/bin/env python3
"""Unit tests for scratch_migrate.py. The migration tables are read through a
fake `mysql` runner; test_scratch_boot_smoke.py runs the same reads against a
real throwaway server. Nothing here reaches a host. See scratch_migrate.md."""

from __future__ import annotations

import subprocess
import unittest

import scratch_migrate as sm


def state(*names: str, version: str | None = "6.55", held: bool = False) -> sm.MigrationState:
    return sm.MigrationState(names=tuple(names), newest_version=version, lock_held=held)


def runner(stdout: str = "", *, code: int = 0, stderr: str = ""):
    calls: list[tuple[list[str], dict]] = []

    def run(argv, **kwargs):
        calls.append((list(argv), kwargs))
        return subprocess.CompletedProcess(argv, code, stdout, stderr)

    return run, calls


def read(run) -> sm.MigrationState:
    return sm.read_state(run=run, host="scratch-host", password="pw", database="ghost_blog")


class ReadStateTests(unittest.TestCase):
    def test_it_reads_names_in_order_the_newest_version_and_a_free_lock(self):
        run, calls = runner("M\ta.js\tinit\nM\tb.js\t6.55\nL\tkm01\t0\n")
        got = read(run)
        self.assertEqual(got, state("a.js", "b.js", version="6.55"))
        argv, kwargs = calls[0]
        self.assertEqual(argv[argv.index("--host") + 1], "scratch-host")
        self.assertEqual(argv[argv.index("--database") + 1], "ghost_blog")
        self.assertEqual(kwargs["env"], {"MYSQL_PWD": "pw"}, "the password crosses as environment, never argv")
        self.assertNotIn("pw", argv)

    def test_a_held_lock_is_read_as_held(self):
        run, _ = runner("M\ta.js\tinit\nL\tkm01\t1\n")
        self.assertTrue(read(run).lock_held)

    def test_a_failed_read_is_an_error_naming_why(self):
        run, _ = runner(code=1, stderr="ERROR 1146 (42S02): Table 'ghost_blog.migrations' doesn't exist")
        with self.assertRaisesRegex(sm.MigrationCheckError, "could not be read.*1146"):
            read(run)

    def test_no_migration_row_is_an_error_not_a_pass(self):
        run, _ = runner("L\tkm01\t0\n")
        with self.assertRaisesRegex(sm.MigrationCheckError, "records no migration"):
            read(run)

    def test_a_missing_lock_row_is_an_error_not_a_free_lock(self):
        run, _ = runner("M\ta.js\tinit\n")
        with self.assertRaisesRegex(sm.MigrationCheckError, "lock row"):
            read(run)

    def test_a_lock_value_that_is_not_zero_or_one_is_an_error(self):
        run, _ = runner("M\ta.js\tinit\nL\tkm01\tNULL\n")
        with self.assertRaisesRegex(sm.MigrationCheckError, "lock row"):
            read(run)

    def test_output_in_another_shape_is_an_error(self):
        run, _ = runner("M\ta.js\nL\tkm01\t0\n")
        with self.assertRaisesRegex(sm.MigrationCheckError, "unexpected output"):
            read(run)


class JudgeTests(unittest.TestCase):
    def test_new_migrations_after_the_run_are_recorded_as_applied(self):
        outcome = sm.judge(state("a.js", version="6.55"), state("a.js", "b.js", "c.js", version="6.56"))
        self.assertEqual(outcome.applied, ("b.js", "c.js"))
        self.assertEqual((outcome.before_count, outcome.after_count), (1, 3))
        self.assertEqual((outcome.from_version, outcome.to_version), ("6.55", "6.56"))
        self.assertEqual(outcome.summary(), "migrations: before=1 after=3 applied=2 from=6.55 to=6.56")

    def test_nothing_to_migrate_is_a_pass_with_nothing_applied(self):
        outcome = sm.judge(state("a.js"), state("a.js"))
        self.assertEqual(outcome.applied, ())

    def test_control_a_lock_still_held_is_refused(self):
        with self.assertRaisesRegex(sm.MigrationCheckError, "did not finish"):
            sm.judge(state("a.js"), state("a.js", "b.js", held=True))

    def test_control_a_run_that_lost_an_applied_migration_is_refused(self):
        with self.assertRaisesRegex(sm.MigrationCheckError, "do not extend"):
            sm.judge(state("a.js", "b.js"), state("a.js"))

    def test_control_a_run_that_rewrote_an_applied_migration_is_refused(self):
        with self.assertRaisesRegex(sm.MigrationCheckError, "do not extend"):
            sm.judge(state("a.js", "b.js"), state("a.js", "x.js", "y.js"))


class WaitTests(unittest.TestCase):
    def waiter(self, reads: list[sm.MigrationState], *, timeout_s: float = 10.0):
        ticks = {"now": 0.0, "slept": 0, "reads": 0}

        def read_one() -> sm.MigrationState:
            ticks["reads"] += 1
            return reads.pop(0) if len(reads) > 1 else reads[0]

        def sleep(seconds: float) -> None:
            ticks["slept"] += 1
            ticks["now"] += seconds

        def run(before: sm.MigrationState) -> sm.MigrationOutcome:
            return sm.wait_for_migrations(
                read=read_one, before=before, timeout_s=timeout_s, sleep=sleep, now=lambda: ticks["now"]
            )

        return run, ticks

    def test_a_free_lock_is_judged_at_once(self):
        run, ticks = self.waiter([state("a.js", "b.js")])
        self.assertEqual(run(state("a.js")).applied, ("b.js",))
        self.assertEqual((ticks["reads"], ticks["slept"]), (1, 0))

    def test_a_held_lock_is_waited_on_until_it_is_released(self):
        run, ticks = self.waiter([state("a.js", held=True), state("a.js", held=True), state("a.js", "b.js")])
        self.assertEqual(run(state("a.js")).applied, ("b.js",))
        self.assertEqual(ticks["slept"], 2)

    def test_control_a_lock_that_is_never_released_is_refused_at_the_timeout(self):
        run, ticks = self.waiter([state("a.js", held=True)], timeout_s=3.0)
        with self.assertRaisesRegex(sm.MigrationCheckError, "did not finish"):
            run(state("a.js"))
        self.assertGreaterEqual(ticks["slept"], 3)

    def test_an_unreadable_table_ends_the_wait_at_once(self):
        def read_one() -> sm.MigrationState:
            raise sm.MigrationCheckError("the migration tables could not be read: gone")

        slept: list[float] = []
        with self.assertRaises(sm.MigrationCheckError):
            sm.wait_for_migrations(
                read=read_one, before=state("a.js"), timeout_s=10.0, sleep=slept.append, now=lambda: 0.0
            )
        self.assertEqual(slept, [])


if __name__ == "__main__":
    unittest.main()
