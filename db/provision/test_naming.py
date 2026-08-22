#!/usr/bin/env python3
"""Unit tests for naming.py.

Tenant-name validation is the security boundary every other script in this
directory depends on -- every SQL statement they build interpolates the
result of `sql_identifier`/`database_and_user_name` directly, so a gap here
is a SQL-injection or cross-tenant-access gap everywhere else.
"""

import unittest

import naming


class ValidateTenantNameTests(unittest.TestCase):
    def test_accepts_valid_names(self):
        for name in ("blog", "blog-archive", "a1", "x-9-y", "a", "a-b-c-d", "a--b"):
            naming.validate_tenant_name(name)  # does not raise

    def test_rejects_uppercase(self):
        for name in ("Blog", "BLOG"):
            with self.assertRaises(naming.InvalidTenantName):
                naming.validate_tenant_name(name)

    def test_rejects_leading_digit_or_hyphen(self):
        for name in ("1blog", "-blog"):
            with self.assertRaises(naming.InvalidTenantName):
                naming.validate_tenant_name(name)

    def test_rejects_underscore_and_dot(self):
        for name in ("blog_archive", "blog.archive"):
            with self.assertRaises(naming.InvalidTenantName):
                naming.validate_tenant_name(name)

    def test_rejects_empty(self):
        with self.assertRaises(naming.InvalidTenantName):
            naming.validate_tenant_name("")

    def test_rejects_whitespace_in_any_position(self):
        for name in (" ", "   ", " blog", "blog ", "blog archive", "blog\tarchive", "blog\narchive"):
            with self.assertRaises(naming.InvalidTenantName):
                naming.validate_tenant_name(name)

    def test_rejects_sql_metacharacters(self):
        # The class of input that matters most: this repo builds SQL by
        # f-string interpolation of the validated name, so a name carrying a
        # quote or a statement terminator must never reach that point.
        for name in ("blog'; drop table users; --", "blog`", 'blog"', "blog;drop"):
            with self.assertRaises(naming.InvalidTenantName):
                naming.validate_tenant_name(name)

    def test_rejects_shell_metacharacters(self):
        # These scripts also shell out (mysqldump, mysqlbinlog, age) with the
        # derived identifier appearing in object-storage keys and filenames.
        for name in ("blog$(id)", "blog;rm -rf /", "blog|cat", "blog&&true"):
            with self.assertRaises(naming.InvalidTenantName):
                naming.validate_tenant_name(name)

    def test_accepts_up_to_the_mysql_account_name_limit(self):
        name = "a" * naming.MAX_TENANT_NAME_LENGTH
        naming.validate_tenant_name(name)  # does not raise
        self.assertEqual(
            len(naming.TENANT_DB_PREFIX) + len(name), naming.MAX_MYSQL_ACCOUNT_NAME_LENGTH
        )

    def test_rejects_one_over_the_mysql_account_name_limit(self):
        with self.assertRaises(naming.InvalidTenantName):
            naming.validate_tenant_name("a" * (naming.MAX_TENANT_NAME_LENGTH + 1))


class SqlIdentifierTests(unittest.TestCase):
    def test_folds_hyphens_to_underscores(self):
        self.assertEqual(naming.sql_identifier("blog-archive"), "blog_archive")

    def test_leaves_a_hyphen_free_name_unchanged(self):
        self.assertEqual(naming.sql_identifier("blog"), "blog")


class DatabaseAndUserNameTests(unittest.TestCase):
    def test_shares_the_prefix(self):
        self.assertEqual(naming.database_and_user_name("blog"), "ghost_blog")

    def test_stays_within_the_mysql_account_name_limit_at_the_boundary(self):
        sql_id = naming.sql_identifier("a" * naming.MAX_TENANT_NAME_LENGTH)
        name = naming.database_and_user_name(sql_id)
        self.assertEqual(len(name), naming.MAX_MYSQL_ACCOUNT_NAME_LENGTH)


if __name__ == "__main__":
    unittest.main()
