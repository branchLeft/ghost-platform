#!/usr/bin/env python3
"""Unit tests for restore_drained.py.

Every external effect is faked -- no real mysql client, no real HTTP call,
no real sleep -- so these cover the ordering the module promises (readiness,
restore, verify, undrain-last) and, deterministically, the exact control
design 09 names: a `200` with no expected content must never be read as
success, and must be reported differently from "never answered at all".
`run_drained_restore`'s own ordering guarantee -- the flag is only ever
cleared after every earlier stage has passed -- is proven for each stage by
sabotaging that one stage's fake and checking the flag-clear fake was never
called.
"""

from __future__ import annotations

import os
import tempfile
import unittest
from unittest import mock

import restore_drained as rd


class FakeClock:
    """A monotonic clock this suite advances itself, so a deadline in the
    module under test is real without any test actually sleeping."""

    def __init__(self, start: float = 0.0) -> None:
        self.t = start

    def now(self) -> float:
        return self.t

    def sleep(self, seconds: float) -> None:
        self.t += seconds


def fake_run(returncode: int, stderr: str = ""):
    def _run(*_args, **_kwargs):
        return mock.Mock(returncode=returncode, stdout="", stderr=stderr)

    return _run


class WaitForMysqlReadyTests(unittest.TestCase):
    def test_returns_once_ready(self) -> None:
        rd.wait_for_mysql_ready(
            host="scratch", port=3306, user="root", password="x",
            run=fake_run(0), sleep=lambda s: None, now=lambda: 0.0,
        )  # no exception raised is the assertion

    def test_raises_readiness_error_on_timeout(self) -> None:
        clock = FakeClock()
        with self.assertRaises(rd.ReadinessError) as ctx:
            rd.wait_for_mysql_ready(
                host="scratch", port=3306, user="root", password="x",
                timeout_s=5.0, poll_s=1.0,
                run=fake_run(1, stderr="Can't connect to MySQL server"),
                sleep=clock.sleep, now=clock.now,
            )
        self.assertIn("did not answer SELECT 1", str(ctx.exception))
        self.assertIn("Can't connect", str(ctx.exception))

    def test_recovers_after_early_failures(self) -> None:
        calls = {"n": 0}

        def flaky_run(*_args, **_kwargs):
            calls["n"] += 1
            if calls["n"] < 3:
                return mock.Mock(returncode=1, stdout="", stderr="not ready yet")
            return mock.Mock(returncode=0, stdout="", stderr="")

        clock = FakeClock()
        rd.wait_for_mysql_ready(
            host="scratch", port=3306, user="root", password="x",
            timeout_s=30.0, poll_s=1.0, run=flaky_run, sleep=clock.sleep, now=clock.now,
        )
        self.assertEqual(calls["n"], 3)

    def test_mysql_pwd_passed_per_call_never_a_fixed_name(self) -> None:
        seen_envs = []

        def capturing_run(*_args, **kwargs):
            seen_envs.append(kwargs["env"])
            return mock.Mock(returncode=0, stdout="", stderr="")

        rd.wait_for_mysql_ready(
            host="scratch", port=3306, user="root", password="s3cret",
            run=capturing_run, sleep=lambda s: None, now=lambda: 0.0,
        )
        self.assertEqual(seen_envs[0]["MYSQL_PWD"], "s3cret")


class RestoreDumpTests(unittest.TestCase):
    def setUp(self) -> None:
        fd, self.dump_path = tempfile.mkstemp()
        os.close(fd)
        with open(self.dump_path, "w", encoding="utf-8") as f:
            f.write("CREATE DATABASE IF NOT EXISTS ghost_t1;\n")

    def tearDown(self) -> None:
        os.remove(self.dump_path)

    def test_success(self) -> None:
        rd.restore_dump(
            dump_path=self.dump_path, host="scratch", port=3306, user="root",
            password="x", run=fake_run(0),
        )

    def test_failure_raises_dump_import_error(self) -> None:
        with self.assertRaises(rd.DumpImportError) as ctx:
            rd.restore_dump(
                dump_path=self.dump_path, host="scratch", port=3306, user="root",
                password="x", run=fake_run(1, stderr="ERROR 1045: Access denied"),
            )
        self.assertIn("Access denied", str(ctx.exception))

    def test_dump_file_streamed_as_stdin(self) -> None:
        captured = {}

        def capturing_run(_args, **kwargs):
            captured["stdin"] = kwargs["stdin"]
            return mock.Mock(returncode=0, stdout="", stderr="")

        rd.restore_dump(
            dump_path=self.dump_path, host="scratch", port=3306, user="root",
            password="x", run=capturing_run,
        )
        self.assertEqual(captured["stdin"].name, self.dump_path)


class AssertTargetHasNoLiveDatabaseTests(unittest.TestCase):
    """Rob's own ruling on this issue, made mechanical: a per-tenant dump's
    own CREATE DATABASE IF NOT EXISTS/USE restores INTO whatever already has
    that name, so a target that already holds a live database must be
    refused before anything is imported -- a name match against the tenant
    being restored is never the bar; any non-system database is."""

    def _run_listing(self, databases: list[str]):
        stdout = "".join(f"{name}\n" for name in databases)

        def _run(*_args, **_kwargs):
            return mock.Mock(returncode=0, stdout=stdout, stderr="")

        return _run

    def test_passes_when_only_system_databases_present(self) -> None:
        rd.assert_target_has_no_live_database(
            host="scratch", port=3306, user="root", password="x",
            run=self._run_listing(["information_schema", "mysql", "performance_schema", "sys"]),
        )  # no exception is the assertion

    def test_passes_on_a_genuinely_empty_listing(self) -> None:
        rd.assert_target_has_no_live_database(
            host="scratch", port=3306, user="root", password="x", run=self._run_listing([]),
        )

    def test_refuses_when_the_tenant_database_is_already_there(self) -> None:
        with self.assertRaises(rd.LiveDatabaseCollisionError) as ctx:
            rd.assert_target_has_no_live_database(
                host="scratch", port=3306, user="root", password="x",
                run=self._run_listing(["information_schema", "mysql", "ghost_t1"]),
            )
        message = str(ctx.exception)
        self.assertIn("ghost_t1", message)
        self.assertIn("not empty", message)

    def test_refuses_on_any_non_system_database_not_only_a_name_match(self) -> None:
        """The bar is emptiness, not a match against the tenant being
        restored -- a target holding some OTHER live database is refused
        too, exactly as a target holding this tenant's own would be."""
        with self.assertRaises(rd.LiveDatabaseCollisionError) as ctx:
            rd.assert_target_has_no_live_database(
                host="scratch", port=3306, user="root", password="x",
                run=self._run_listing(["mysql", "some_unrelated_database"]),
            )
        self.assertIn("some_unrelated_database", str(ctx.exception))

    def test_lists_every_live_database_found_not_only_the_first(self) -> None:
        with self.assertRaises(rd.LiveDatabaseCollisionError) as ctx:
            rd.assert_target_has_no_live_database(
                host="scratch", port=3306, user="root", password="x",
                run=self._run_listing(["ghost_t1", "ghost_t2", "mysql"]),
            )
        message = str(ctx.exception)
        self.assertIn("ghost_t1", message)
        self.assertIn("ghost_t2", message)

    def test_listing_failure_raises_readiness_error_not_a_false_pass(self) -> None:
        with self.assertRaises(rd.ReadinessError) as ctx:
            rd.assert_target_has_no_live_database(
                host="scratch", port=3306, user="root", password="x",
                run=fake_run(1, stderr="ERROR 2003: Can't connect"),
            )
        self.assertIn("Can't connect", str(ctx.exception))


class VerifyTenantContentTests(unittest.TestCase):
    """The exact control design 09 R4 names: 200 alone is never success."""

    def test_succeeds_once_expected_body_present(self) -> None:
        rd.verify_tenant_content(
            base_url="http://colour/", expected_post_body="Tenant B original post",
            get=lambda url, timeout_s: (200, "<html>Tenant B original post</html>"),
            sleep=lambda s: None, now=lambda: 0.0,
        )

    def test_control_case_200_with_no_content_fails_loudly(self) -> None:
        """The empty-database control: Ghost answers 200 on a fresh schema,
        with none of the tenant's own content. This must raise, not pass."""
        clock = FakeClock()
        with self.assertRaises(rd.ContentVerificationError) as ctx:
            rd.verify_tenant_content(
                base_url="http://colour/", expected_post_body="Tenant B original post",
                timeout_s=3.0, poll_s=1.0,
                get=lambda url, timeout_s: (200, "<html>Ghost</html>"),
                sleep=clock.sleep, now=clock.now,
            )
        message = str(ctx.exception)
        self.assertIn("200 but never carried the expected content", message)
        self.assertIn("empty database serves 200 too", message)

    def test_never_answering_200_is_reported_differently_from_the_control(self) -> None:
        clock = FakeClock()
        with self.assertRaises(rd.ContentVerificationError) as ctx:
            rd.verify_tenant_content(
                base_url="http://colour/", expected_post_body="Tenant B original post",
                timeout_s=3.0, poll_s=1.0,
                get=lambda url, timeout_s: (0, "connection refused"),
                sleep=clock.sleep, now=clock.now,
            )
        message = str(ctx.exception)
        self.assertIn("never answered 200", message)
        self.assertNotIn("empty database", message)

    def test_recovers_once_ghost_finishes_booting(self) -> None:
        calls = {"n": 0}

        def slow_boot_get(_url, timeout_s):
            calls["n"] += 1
            if calls["n"] < 3:
                return 0, "connection refused"
            return 200, "Tenant B original post"

        clock = FakeClock()
        rd.verify_tenant_content(
            base_url="http://colour/", expected_post_body="Tenant B original post",
            timeout_s=30.0, poll_s=1.0, get=slow_boot_get, sleep=clock.sleep, now=clock.now,
        )
        self.assertEqual(calls["n"], 3)


class ClearDrainFlagTests(unittest.TestCase):
    def test_removes_an_existing_flag(self) -> None:
        fd, path = tempfile.mkstemp()
        os.close(fd)
        rd.clear_drain_flag(path)
        self.assertFalse(os.path.exists(path))

    def test_absent_flag_is_not_an_error(self) -> None:
        rd.clear_drain_flag("/nonexistent/definitely/not-here")  # must not raise


class RestoreOnlyAndVerifyAndUndrainTests(unittest.TestCase):
    """The two-phase split a real orchestrator needs: the colour's Ghost
    process must start in between `restore_only` and `verify_and_undrain`,
    so callers with a real container to bring up in the middle cannot use
    `run_drained_restore` end to end."""

    def setUp(self) -> None:
        fd, self.dump_path = tempfile.mkstemp()
        os.close(fd)
        fd2, self.flag_path = tempfile.mkstemp()
        os.close(fd2)

    def tearDown(self) -> None:
        for path in (self.dump_path, self.flag_path):
            if os.path.exists(path):
                os.remove(path)

    def test_restore_only_never_touches_the_flag(self) -> None:
        rd.restore_only(
            dump_path=self.dump_path, host="scratch", port=3306, user="root", password="x",
            run=fake_run(0), sleep=lambda s: None, now=lambda: 0.0,
        )
        self.assertTrue(os.path.exists(self.flag_path), "restore_only must never clear the flag itself")

    def test_restore_only_refuses_a_live_target_before_ever_importing(self) -> None:
        """Rob's own ruling on this issue, exercised through the real entry
        point: readiness succeeds, the target already has `ghost_t1`, and
        the import must never be attempted. The fake `run` below would
        happily let an import through (returncode 0) if `restore_only`
        reached it -- so this fails as a clean, readable assertion (an
        unraised exception, or an extra logged call) if the refusal is ever
        skipped, rather than as a crash from some unrelated missing file."""
        calls: list[str] = []

        def run(args, **_kwargs):
            if "SELECT 1;" in args:
                calls.append("readiness")
            elif "SHOW DATABASES;" in args:
                calls.append("listing")
            else:
                calls.append("import")
            if "SHOW DATABASES;" in args:
                return mock.Mock(returncode=0, stdout="information_schema\nghost_t1\n", stderr="")
            return mock.Mock(returncode=0, stdout="", stderr="")

        with self.assertRaises(rd.LiveDatabaseCollisionError) as ctx:
            rd.restore_only(
                dump_path=self.dump_path, host="scratch", port=3306,
                user="root", password="x", run=run, sleep=lambda s: None, now=lambda: 0.0,
            )
        self.assertIn("ghost_t1", str(ctx.exception))
        self.assertEqual(calls, ["readiness", "listing"], "the import must never be attempted once refused")

    def test_verify_and_undrain_clears_the_flag_on_success(self) -> None:
        rd.verify_and_undrain(
            base_url="http://colour/", expected_post_body="Tenant B original post", flag_path=self.flag_path,
            get=lambda url, timeout_s: (200, "Tenant B original post"), sleep=lambda s: None, now=lambda: 0.0,
        )
        self.assertFalse(os.path.exists(self.flag_path))

    def test_verify_and_undrain_leaves_the_flag_set_on_the_control_case(self) -> None:
        clock = FakeClock()
        with self.assertRaises(rd.ContentVerificationError):
            rd.verify_and_undrain(
                base_url="http://colour/", expected_post_body="Tenant B original post", flag_path=self.flag_path,
                content_timeout_s=3.0, get=lambda url, timeout_s: (200, "<html>Ghost</html>"),
                sleep=clock.sleep, now=clock.now,
            )
        self.assertTrue(os.path.exists(self.flag_path))

    def test_run_drained_restore_still_composes_both_halves(self) -> None:
        """Same happy-path guarantee as before the split -- the composition,
        not just each half in isolation."""
        rd.run_drained_restore(
            dump_path=self.dump_path, host="scratch", port=3306, user="root", password="x",
            base_url="http://colour/", expected_post_body="Tenant B original post", flag_path=self.flag_path,
            run=fake_run(0), get=lambda url, timeout_s: (200, "Tenant B original post"),
            sleep=lambda s: None, now=lambda: 0.0,
        )
        self.assertFalse(os.path.exists(self.flag_path))


class MainCliModeTests(unittest.TestCase):
    """Covers main()'s own argument wiring -- the part no lower-level test
    touches, and the part a mis-wired --mode dispatch would break silently
    (calling the wrong function while still exiting 0)."""

    def setUp(self) -> None:
        fd, self.dump_path = tempfile.mkstemp()
        os.close(fd)
        fd2, self.flag_path = tempfile.mkstemp()
        os.close(fd2)
        self.env_patch = mock.patch.dict(os.environ, {"RESTORE_MYSQL_PWD": "x"})
        self.env_patch.start()

    def tearDown(self) -> None:
        self.env_patch.stop()
        for path in (self.dump_path, self.flag_path):
            if os.path.exists(path):
                os.remove(path)

    def test_restore_only_mode_calls_restore_only_not_the_other_modes(self) -> None:
        # Patched on the module, not via subprocess/_default_get: those are
        # only the INNER functions' own default arguments, bound once at
        # def time -- patching them would never be seen by a call that (like
        # main()'s) never passes run=/get= through, so this test would
        # silently exercise a real subprocess/network call instead of the
        # fake. Patching the dispatched-to function by its module-level name
        # is what main()'s own `restore_only(...)` call actually looks up.
        with mock.patch("restore_drained.restore_only") as restore_only_mock, \
             mock.patch("restore_drained.verify_and_undrain") as verify_mock, \
             mock.patch("restore_drained.run_drained_restore") as full_mock:
            code = rd.main(["--mode", "restore-only", "--dump", self.dump_path, "--host", "scratch"])
        self.assertEqual(code, 0)
        restore_only_mock.assert_called_once()
        verify_mock.assert_not_called()
        full_mock.assert_not_called()

    def test_restore_only_mode_without_dump_fails_before_dispatch(self) -> None:
        with mock.patch("restore_drained.restore_only") as restore_only_mock:
            code = rd.main(["--mode", "restore-only", "--host", "scratch"])
        self.assertEqual(code, 1)
        restore_only_mock.assert_not_called()

    def test_verify_and_undrain_mode_calls_verify_and_undrain_not_the_other_modes(self) -> None:
        with mock.patch("restore_drained.restore_only") as restore_only_mock, \
             mock.patch("restore_drained.verify_and_undrain") as verify_mock, \
             mock.patch("restore_drained.run_drained_restore") as full_mock:
            code = rd.main(
                [
                    "--mode", "verify-and-undrain",
                    "--base-url", "http://colour/",
                    "--expect", "Tenant B original post",
                    "--flag-path", self.flag_path,
                ]
            )
        self.assertEqual(code, 0)
        verify_mock.assert_called_once()
        restore_only_mock.assert_not_called()
        full_mock.assert_not_called()

    def test_full_mode_is_the_default_and_calls_run_drained_restore(self) -> None:
        with mock.patch("restore_drained.restore_only") as restore_only_mock, \
             mock.patch("restore_drained.verify_and_undrain") as verify_mock, \
             mock.patch("restore_drained.run_drained_restore") as full_mock:
            code = rd.main(
                [
                    "--dump", self.dump_path,
                    "--host", "scratch",
                    "--base-url", "http://colour/",
                    "--expect", "Tenant B original post",
                    "--flag-path", self.flag_path,
                ]
            )
        self.assertEqual(code, 0)
        full_mock.assert_called_once()
        restore_only_mock.assert_not_called()
        verify_mock.assert_not_called()

    def test_an_unexpected_exception_gets_a_clean_message_not_a_traceback(self) -> None:
        """A missing binary, a permissions error -- anything main()'s own
        RestoreError catch doesn't name -- must still exit 1 with a plain
        stderr line, for an operator reading a terminal mid-incident."""
        with mock.patch("restore_drained.restore_only", side_effect=RuntimeError("no such file or directory")), \
             mock.patch("sys.stderr") as stderr_mock:
            code = rd.main(["--mode", "restore-only", "--dump", self.dump_path, "--host", "scratch"])
        self.assertEqual(code, 1)
        printed = "".join(call.args[0] for call in stderr_mock.write.call_args_list if call.args)
        self.assertIn("unexpected error", printed)
        self.assertIn("no such file or directory", printed)

    def test_an_unexpected_exception_still_leaves_the_flag_set(self) -> None:
        with mock.patch("restore_drained.verify_and_undrain", side_effect=RuntimeError("boom")):
            code = rd.main(
                [
                    "--mode", "verify-and-undrain",
                    "--base-url", "http://colour/",
                    "--expect", "Tenant B original post",
                    "--flag-path", self.flag_path,
                ]
            )
        self.assertEqual(code, 1)
        self.assertTrue(os.path.exists(self.flag_path), "an unexpected exception must not clear the flag")


class RunDrainedRestoreOrderingTests(unittest.TestCase):
    """Proves the ordering guarantee directly: the flag is cleared if and
    only if every earlier stage succeeded, and never before."""

    def setUp(self) -> None:
        fd, self.dump_path = tempfile.mkstemp()
        os.close(fd)
        fd2, self.flag_path = tempfile.mkstemp()
        os.close(fd2)  # the flag "already set" precondition -- present before the run

    def tearDown(self) -> None:
        for path in (self.dump_path, self.flag_path):
            if os.path.exists(path):
                os.remove(path)

    def _run(self, *, run, get, clock=None):
        clock = clock or FakeClock()
        rd.run_drained_restore(
            dump_path=self.dump_path, host="scratch", port=3306, user="root", password="x",
            base_url="http://colour/", expected_post_body="Tenant B original post",
            flag_path=self.flag_path, mysql_ready_timeout_s=3.0, content_timeout_s=3.0,
            run=run, get=get, sleep=clock.sleep, now=clock.now,
        )

    def test_happy_path_clears_the_flag_last(self) -> None:
        self._run(run=fake_run(0), get=lambda url, timeout_s: (200, "Tenant B original post"))
        self.assertFalse(os.path.exists(self.flag_path), "flag must be cleared on full success")

    def test_readiness_failure_leaves_the_flag_set(self) -> None:
        with self.assertRaises(rd.ReadinessError):
            self._run(run=fake_run(1, stderr="down"), get=lambda url, timeout_s: (200, "irrelevant"))
        self.assertTrue(os.path.exists(self.flag_path), "flag must stay set if mysql never became ready")

    def test_import_failure_leaves_the_flag_set(self) -> None:
        # mysql readiness ("SELECT 1;") succeeds, the import itself fails --
        # distinguished by whether "-e" is in the argv the fake receives.
        def run(args, **kwargs):
            if "-e" in args:
                return mock.Mock(returncode=0, stdout="", stderr="")
            return mock.Mock(returncode=1, stdout="", stderr="ERROR 1049: unknown database")

        with self.assertRaises(rd.DumpImportError):
            self._run(run=run, get=lambda url, timeout_s: (200, "irrelevant"))
        self.assertTrue(os.path.exists(self.flag_path), "flag must stay set if the import failed")

    def test_content_verification_failure_leaves_the_flag_set(self) -> None:
        """This is the control case run through the full ordered chain, not
        just verify_tenant_content in isolation: an empty restore that still
        answers 200 must leave the colour drained, never undrained."""
        with self.assertRaises(rd.ContentVerificationError):
            self._run(run=fake_run(0), get=lambda url, timeout_s: (200, "<html>Ghost</html>"))
        self.assertTrue(os.path.exists(self.flag_path), "flag must stay set if content verification failed")


if __name__ == "__main__":
    unittest.main()
