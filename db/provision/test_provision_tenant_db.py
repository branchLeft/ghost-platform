#!/usr/bin/env python3
"""Unit tests for provision_tenant_db.

This is the one script that creates a MySQL account with a real credential,
so its idempotency (never silently rotating an existing tenant's password)
and its refusal of an invalid tenant name are covered here rather than left
to a live run against db1 to discover.
"""

import subprocess
import unittest

import provision_tenant_db as ptd
from naming import InvalidTenantName


class FakeRun:
    """Stands in for subprocess.run against the `mysql` CLI. Each call pops
    the next queued stdout; a call with no queued response returns empty
    stdout and exit 0."""

    def __init__(self, responses=None, fail_on_substring=None):
        self.responses = list(responses or [])
        self.calls = []
        self.fail_on_substring = fail_on_substring

    def __call__(self, argv, env=None, capture_output=None, text=None, check=None):
        self.calls.append({"argv": list(argv), "env": dict(env or {})})
        sql = argv[argv.index("-e") + 1] if "-e" in argv else ""
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
        self.assertIn("GRANT ALL PRIVILEGES ON `ghost_blog`.*", sql)
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
