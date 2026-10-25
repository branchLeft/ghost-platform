#!/usr/bin/env python3
"""Unit tests for provision_tenant_db.

This is the one script that creates a MySQL account with a real credential,
so its idempotency (never silently rotating an existing tenant's password)
and its refusal of an invalid tenant name are covered here rather than left
to a live run against db1 to discover.
"""

import math
import subprocess
import unittest

import provision_tenant_db as ptd
from naming import InvalidTenantName

FAKE_TIMEOUT_SECONDS = 7


class FakeRun:
    """Stands in for subprocess.run against the `mysql` CLI. Each call pops
    the next queued stdout; a call with no queued response returns empty
    stdout and exit 0. `timeout_on_substring` makes a call whose SQL contains
    it raise subprocess.TimeoutExpired carrying the full argv, as the real
    subprocess.run does; the empty string matches every call."""

    def __init__(self, responses=None, fail_on_substring=None, timeout_on_substring=None):
        self.responses = list(responses or [])
        self.calls = []
        self.timeouts = []
        self.raised_timeouts = []
        self.fail_on_substring = fail_on_substring
        self.timeout_on_substring = timeout_on_substring

    def __call__(self, argv, env=None, capture_output=None, text=None, check=None, timeout=None):
        self.calls.append({"argv": list(argv), "env": dict(env or {})})
        self.timeouts.append(timeout)
        sql = argv[argv.index("-e") + 1] if "-e" in argv else ""
        if self.timeout_on_substring is not None and self.timeout_on_substring in sql:
            expired = subprocess.TimeoutExpired(
                cmd=argv, timeout=FAKE_TIMEOUT_SECONDS if timeout is None else timeout
            )
            self.raised_timeouts.append(expired)
            raise expired
        if self.fail_on_substring and self.fail_on_substring in sql:
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="boom")
        stdout = self.responses.pop(0) if self.responses else ""
        return subprocess.CompletedProcess(argv, 0, stdout=stdout, stderr="")


class ProvisionNewTenantTests(unittest.TestCase):
    def setUp(self):
        self.run = FakeRun(responses=["0\n"])  # user_exists -> False

    def test_creates_database_user_grants_and_cap(self):
        result = ptd.provision_tenant_database(
            "blog",
            socket_path="/tmp/mysqld.sock",
            admin_user="root",
            admin_password="secret",
            max_user_connections=7,
            password_factory=lambda: "generated-pw",
            run=self.run,
        )
        self.assertTrue(result.created)
        self.assertEqual(result.database, "ghost_blog")
        self.assertEqual(result.password, "generated-pw")

        provisioning_call = self.run.calls[-1]
        sql = provisioning_call["argv"][provisioning_call["argv"].index("-e") + 1]
        self.assertIn("CREATE DATABASE IF NOT EXISTS `ghost_blog`", sql)
        self.assertIn("CREATE USER 'ghost_blog'@'10.20.1.%' IDENTIFIED BY 'generated-pw'", sql)
        self.assertIn(r"GRANT ALL PRIVILEGES ON `ghost\_blog`.*", sql)
        self.assertIn("WITH MAX_USER_CONNECTIONS 7", sql)

    def test_never_passes_the_admin_password_as_an_argument(self):
        ptd.provision_tenant_database(
            "blog",
            socket_path="/tmp/mysqld.sock",
            admin_user="root",
            admin_password="super-secret",
            password_factory=lambda: "x",
            run=self.run,
        )
        for call in self.run.calls:
            self.assertNotIn("super-secret", call["argv"])
            self.assertEqual(call["env"]["MYSQL_PWD"], "super-secret")

    def test_folds_a_hyphenated_tenant_name(self):
        result = ptd.provision_tenant_database(
            "blog-archive",
            socket_path="/tmp/mysqld.sock",
            admin_user="root",
            admin_password="secret",
            password_factory=lambda: "x",
            run=self.run,
        )
        self.assertEqual(result.database, "ghost_blog_archive")


def _grant_target_matches(grant_target: str, database: str) -> bool:
    """Model MySQL's database-level GRANT matching: an unescaped _ matches
    any one character, an unescaped % any run, and a backslash escapes the
    next character so it is literal."""
    import re

    pattern = []
    chars = iter(grant_target)
    for ch in chars:
        if ch == "\\":
            pattern.append(re.escape(next(chars)))
        elif ch == "_":
            pattern.append(".")
        elif ch == "%":
            pattern.append(".*")
        else:
            pattern.append(re.escape(ch))
    return re.fullmatch("".join(pattern), database) is not None


class GrantTargetEscapingTests(unittest.TestCase):
    def _grant_sql(self, tenant):
        run = FakeRun(responses=["0\n"])
        ptd.provision_tenant_database(
            tenant,
            socket_path="/tmp/mysqld.sock",
            admin_user="root",
            admin_password="secret",
            password_factory=lambda: "x",
            run=run,
        )
        call = run.calls[-1]
        sql = call["argv"][call["argv"].index("-e") + 1]
        grant_line = next(line for line in sql.split("\n") if line.startswith("GRANT ALL"))
        return sql, grant_line

    def test_hyphenated_tenant_grant_escapes_the_underscores(self):
        sql, grant_line = self._grant_sql("a-b")
        self.assertIn(r"GRANT ALL PRIVILEGES ON `ghost\_a\_b`.* TO 'ghost_a_b'@'10.20.1.%';", sql)
        self.assertNotIn("`ghost_a_b`.*", sql)

    def test_hyphenated_tenant_grant_does_not_reach_a_digit_tenant_database(self):
        # Tenant a-b and tenant a1b are both valid names. An unescaped grant
        # on ghost_a_b would also cover ghost_a1b, another tenant's database.
        _, grant_line = self._grant_sql("a-b")
        target = grant_line.split("ON `", 1)[1].split("`.*", 1)[0]
        self.assertTrue(_grant_target_matches(target, "ghost_a_b"))
        self.assertFalse(_grant_target_matches(target, "ghost_a1b"))

    def test_the_prefix_underscore_is_escaped_for_a_name_without_a_hyphen(self):
        # Every tenant database name carries the ghost_ prefix, whose
        # underscore is a wildcard too. Only that one underscore is escaped
        # for a plain name, and the grant still matches only ghost_blog.
        sql, _ = self._grant_sql("blog")
        self.assertIn(r"GRANT ALL PRIVILEGES ON `ghost\_blog`.* TO 'ghost_blog'@'10.20.1.%';", sql)
        target = r"ghost\_blog"
        self.assertTrue(_grant_target_matches(target, "ghost_blog"))
        self.assertFalse(_grant_target_matches(target, "ghostXblog"))

    def test_the_create_database_identifier_is_not_escaped(self):
        sql, _ = self._grant_sql("a-b")
        self.assertIn("CREATE DATABASE IF NOT EXISTS `ghost_a_b`", sql)


class GrantPatternEscapeUnitTests(unittest.TestCase):
    # Tenant names cannot carry % or a backslash, so these call the helper
    # directly: each escape must be load-bearing on its own.

    def test_percent_is_escaped(self):
        self.assertEqual(ptd.grant_database_pattern("a%b"), "a\\%b")

    def test_backslash_is_escaped(self):
        self.assertEqual(ptd.grant_database_pattern("a\\b"), "a\\\\b")

    def test_an_escaped_percent_matches_only_the_literal_name(self):
        target = ptd.grant_database_pattern("a%b")
        self.assertTrue(_grant_target_matches(target, "a%b"))
        self.assertFalse(_grant_target_matches(target, "axxb"))

    def test_an_escaped_backslash_matches_only_the_literal_name(self):
        target = ptd.grant_database_pattern("a\\b")
        self.assertTrue(_grant_target_matches(target, "a\\b"))
        self.assertFalse(_grant_target_matches(target, "ab"))


class ProvisionExistingTenantTests(unittest.TestCase):
    def test_does_not_rotate_the_password_or_reissue_create_user(self):
        run = FakeRun(responses=["1\n"])  # user_exists -> True
        result = ptd.provision_tenant_database(
            "blog",
            socket_path="/tmp/mysqld.sock",
            admin_user="root",
            admin_password="secret",
            max_user_connections=10,
            password_factory=lambda: self.fail("password_factory must not be called"),
            run=run,
        )
        self.assertFalse(result.created)
        self.assertIsNone(result.password)

        provisioning_call = run.calls[-1]
        sql = provisioning_call["argv"][provisioning_call["argv"].index("-e") + 1]
        self.assertNotIn("CREATE USER", sql)
        self.assertIn("GRANT ALL PRIVILEGES", sql)
        self.assertIn("WITH MAX_USER_CONNECTIONS 10", sql)

    def test_still_reapplies_a_raised_connection_cap(self):
        run = FakeRun(responses=["1\n"])
        result = ptd.provision_tenant_database(
            "blog",
            socket_path="/tmp/mysqld.sock",
            admin_user="root",
            admin_password="secret",
            max_user_connections=25,
            password_factory=lambda: "unused",
            run=run,
        )
        provisioning_call = run.calls[-1]
        sql = provisioning_call["argv"][provisioning_call["argv"].index("-e") + 1]
        self.assertIn("WITH MAX_USER_CONNECTIONS 25", sql)
        self.assertFalse(result.created)


class InvalidTenantNameTests(unittest.TestCase):
    def test_refuses_before_running_any_sql(self):
        run = FakeRun()
        with self.assertRaises(InvalidTenantName):
            ptd.provision_tenant_database(
                "Not Valid",
                socket_path="/tmp/mysqld.sock",
                admin_user="root",
                admin_password="secret",
                run=run,
            )
        self.assertEqual(run.calls, [])

    def test_refuses_a_sql_injection_attempt(self):
        run = FakeRun()
        with self.assertRaises(InvalidTenantName):
            ptd.provision_tenant_database(
                "blog'; DROP DATABASE mysql; --",
                socket_path="/tmp/mysqld.sock",
                admin_user="root",
                admin_password="secret",
                run=run,
            )
        self.assertEqual(run.calls, [])


class MysqlFailureTests(unittest.TestCase):
    def test_a_failed_statement_batch_raises_rather_than_reporting_success(self):
        run = FakeRun(responses=["0\n"], fail_on_substring="GRANT ALL")
        with self.assertRaises(ptd.ProvisionError):
            ptd.provision_tenant_database(
                "blog",
                socket_path="/tmp/mysqld.sock",
                admin_user="root",
                admin_password="secret",
                password_factory=lambda: "x",
                run=run,
            )


def _exception_chain(exception: BaseException) -> list[BaseException]:
    """Every exception reachable through __cause__ and __context__."""
    seen: list[BaseException] = []
    pending = [exception]
    while pending:
        current = pending.pop()
        if any(current is already for already in seen):
            continue
        seen.append(current)
        for linked in (current.__cause__, current.__context__):
            if linked is not None:
                pending.append(linked)
    return seen


class MysqlTimeoutTests(unittest.TestCase):
    def _provision(self, run: FakeRun) -> ptd.ProvisionResult:
        return ptd.provision_tenant_database(
            "blog",
            socket_path="/tmp/mysqld.sock",
            admin_user="root",
            admin_password="secret",
            password_factory=lambda: "generated-pw",
            run=run,
        )

    def test_every_mysql_call_gets_a_positive_finite_timeout(self):
        run = FakeRun(responses=["0\n"])
        self._provision(run)
        self.assertEqual(len(run.timeouts), 2)
        for timeout in run.timeouts:
            self.assertIsNotNone(timeout)
            self.assertTrue(math.isfinite(timeout))
            self.assertGreater(timeout, 0)

    def test_a_timed_out_mysql_call_raises_provision_error_naming_program_and_seconds(self):
        run = FakeRun(timeout_on_substring="")
        with self.assertRaises(ptd.ProvisionError) as raised:
            self._provision(run)
        message = str(raised.exception)
        self.assertIn("mysql", message)
        self.assertIn(f"{run.timeouts[0]:g}", message)

    def test_a_timeout_on_create_user_leaks_neither_password_through_the_exception_chain(self):
        run = FakeRun(responses=["0\n"], timeout_on_substring="CREATE USER")
        with self.assertRaises(ptd.ProvisionError) as raised:
            self._provision(run)

        self.assertEqual(len(run.raised_timeouts), 1)
        self.assertIn("generated-pw", " ".join(run.raised_timeouts[0].cmd))

        self.assertIsNone(raised.exception.__cause__)
        self.assertIsNone(raised.exception.__context__)
        for link in _exception_chain(raised.exception):
            for text in (str(link), repr(link)):
                self.assertNotIn("generated-pw", text)
                self.assertNotIn("secret", text)


class MainTests(unittest.TestCase):
    def test_refuses_to_run_without_mysql_pwd_set(self):
        import contextlib
        import io
        import os
        from unittest import mock

        stderr = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MYSQL_PWD", None)
            with contextlib.redirect_stderr(stderr):
                code = ptd.main(["blog"])
        self.assertEqual(code, 2)
        self.assertIn("MYSQL_PWD", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
