#!/usr/bin/env python3
"""Unit tests for backup_recipients.py: per-tenant recipient parsing,
lookup and the refusals that keep one tenant's key off another's dump."""

from __future__ import annotations

import os
import tempfile
import unittest

import backup_recipients as br

KEY_A = "age1" + "a" * 58
KEY_B = "age1" + "b" * 58


class ParseTests(unittest.TestCase):
    def test_parses_tenant_recipient_pairs_skipping_blanks_and_comments(self) -> None:
        text = f"# comment\n\nblog {KEY_A}\n  shop   {KEY_B}  \n"
        self.assertEqual(br.parse_recipients(text.replace("\\\n", "\n")), {"blog": KEY_A, "shop": KEY_B})

    def test_an_empty_file_is_an_empty_mapping(self) -> None:
        self.assertEqual(br.parse_recipients(""), {})

    def test_refuses_a_line_that_is_not_exactly_two_fields(self) -> None:
        for line in (f"blog", f"blog {KEY_A} {KEY_B}", f"blog {KEY_A},{KEY_B}"):
            with self.assertRaises(br.RecipientError, msg=line):
                br.parse_recipients(line + "\n")

    def test_refuses_a_value_that_is_not_an_age_public_key(self) -> None:
        for value in ("x", "AGE-SECRET-KEY-1ABC", "age1short", KEY_A.upper(), "ssh-ed25519"):
            with self.assertRaises(br.RecipientError, msg=value):
                br.parse_recipients(f"blog {value}\n")

    def test_refuses_an_invalid_tenant_name(self) -> None:
        for name in ("Blog", "1blog", "blog-", "bl_og", "-"):
            with self.assertRaises(br.RecipientError, msg=name):
                br.parse_recipients(f"{name} {KEY_A}\n")

    def test_refuses_a_tenant_listed_twice(self) -> None:
        with self.assertRaisesRegex(br.RecipientError, "more than once"):
            br.parse_recipients(f"blog {KEY_A}\nblog {KEY_B}\n")

    def test_refuses_one_recipient_shared_by_two_tenants(self) -> None:
        with self.assertRaisesRegex(br.RecipientError, "share one recipient"):
            br.parse_recipients(f"blog {KEY_A}\nshop {KEY_A}\n")


class LookupTests(unittest.TestCase):
    def test_returns_only_the_named_tenants_recipient(self) -> None:
        recipients = {"blog": KEY_A, "shop": KEY_B}
        self.assertEqual(br.recipient_for("blog", recipients), KEY_A)
        self.assertEqual(br.recipient_for("shop", recipients), KEY_B)

    def test_a_tenant_with_no_recipient_is_refused_not_defaulted(self) -> None:
        with self.assertRaises(br.MissingRecipient) as ctx:
            br.recipient_for("cafe", {"blog": KEY_A, "shop": KEY_B})
        self.assertIn("cafe", str(ctx.exception))
        self.assertNotIn(KEY_A, str(ctx.exception))

    def test_an_empty_mapping_refuses_everyone(self) -> None:
        with self.assertRaises(br.MissingRecipient):
            br.recipient_for("blog", {})

    def test_missing_recipient_is_a_recipient_error(self) -> None:
        self.assertTrue(issubclass(br.MissingRecipient, br.RecipientError))


class LoadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def _write(self, name: str, text: str) -> str:
        path = os.path.join(self.tmp.name, name)
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)
        return path

    def test_loads_a_regular_file(self) -> None:
        path = self._write("r", f"blog {KEY_A}\n")
        self.assertEqual(br.load_recipients(path), {"blog": KEY_A})

    def test_a_missing_file_is_refused(self) -> None:
        with self.assertRaisesRegex(br.RecipientError, "cannot be read"):
            br.load_recipients(os.path.join(self.tmp.name, "absent"))

    def test_a_symlink_is_refused(self) -> None:
        target = self._write("real", f"blog {KEY_A}\n")
        link = os.path.join(self.tmp.name, "link")
        os.symlink(target, link)
        with self.assertRaises(br.RecipientError):
            br.load_recipients(link)

    def test_a_directory_is_refused(self) -> None:
        with self.assertRaises(br.RecipientError):
            br.load_recipients(self.tmp.name)

    def test_a_malformed_file_is_refused(self) -> None:
        path = self._write("bad", "blog not-a-key\n")
        with self.assertRaises(br.RecipientError):
            br.load_recipients(path)


if __name__ == "__main__":
    unittest.main()
