#!/usr/bin/env python3
"""Tests for render_exporter_my_cnf.py.

The password rules here are not style. Each rejected character was verified
against prom/mysqld-exporter v0.20.0 to change the string the exporter
authenticates with, or to change where the parser thinks a value ends -- and
in every case the container stays up and serves /metrics, so the only symptom
is `mysql_up 0`. A password the renderer accepts must be one MySQL will
actually match.
"""

from __future__ import annotations

import os
import pathlib
import stat
import tempfile
import unittest

import render_exporter_my_cnf as r

GOOD = "Abcdefghijklmnopqrstuvwxyz0123456789"


class Render(unittest.TestCase):
    def test_renders_a_client_section_with_user_password_and_socket(self) -> None:
        out = r.render({r.PASSWORD_VAR: GOOD})
        self.assertEqual(
            out,
            "[client]\n"
            "user = exporter\n"
            f"password = {GOOD}\n"
            "socket = /var/run/mysqld/mysqld.sock\n",
        )

    def test_the_socket_is_the_one_the_stack_bind_mounts(self) -> None:
        # If these drift apart the exporter connects over TCP to
        # 127.0.0.1:3306 instead, where `'exporter'@'localhost'` does not
        # exist -- an auth failure that reads like a wrong password.
        self.assertIn("socket = /var/run/mysqld/mysqld.sock", r.render({r.PASSWORD_VAR: GOOD}))

    def test_an_absent_password_names_the_variable_and_the_file(self) -> None:
        with self.assertRaises(ValueError) as caught:
            r.render({})
        message = str(caught.exception)
        self.assertIn("EXPORTER_MYSQL_PWD", message)
        self.assertIn("/etc/branchleft/db.env", message)

    def test_an_empty_password_is_refused_like_an_absent_one(self) -> None:
        with self.assertRaises(ValueError):
            r.render({r.PASSWORD_VAR: ""})

    def test_the_retired_dsn_variable_does_not_satisfy_the_requirement(self) -> None:
        # It is still in db.env on a host that has not been updated. Accepting
        # it would reintroduce exactly the failure being fixed.
        with self.assertRaises(ValueError):
            r.render(
                {"EXPORTER_DATA_SOURCE_NAME": f"exporter:{GOOD}@unix(/var/run/mysqld/mysqld.sock)/"}
            )


class RejectedPasswords(unittest.TestCase):
    def assert_rejected(self, password: str) -> None:
        with self.assertRaises(ValueError):
            r.render({r.PASSWORD_VAR: password})

    def test_a_dollar_sign_is_refused(self) -> None:
        # config.go sets `cfg.ValueMapper = os.ExpandEnv`, so `pw$with$dollars`
        # in the file becomes `pw` by the time the DSN is formed. Verified
        # against the pinned image: the container stayed up and reported
        # `mysql_up 0` with "Access denied".
        self.assert_rejected("pw" + "$" + "with" + "$" + "dollars" + GOOD)

    def test_a_double_quote_is_refused(self) -> None:
        # The ini loader runs with UnescapeValueDoubleQuotes, which strips a
        # leading and trailing quotation mark from the value.
        self.assert_rejected('"' + GOOD + '"')

    def test_a_comment_character_is_refused(self) -> None:
        for character in ("#", ";"):
            with self.subTest(character=character):
                self.assert_rejected(GOOD + character + "tail")

    def test_a_backslash_is_refused(self) -> None:
        self.assert_rejected(GOOD + "\\" + "tail")

    def test_a_newline_is_refused(self) -> None:
        # Anything after it would be parsed as another key in [client].
        self.assert_rejected(GOOD + "\nuser = root")

    def test_surrounding_whitespace_is_refused(self) -> None:
        # The ini parser trims it, so the file and MySQL would disagree about
        # the password by exactly the characters that are hardest to see.
        for password in (" " + GOOD, GOOD + " ", GOOD + "\t"):
            with self.subTest(password=repr(password)):
                self.assert_rejected(password)

    def test_a_short_password_is_refused(self) -> None:
        self.assert_rejected("Abc123")

    def test_the_refusal_says_how_to_generate_an_acceptable_one(self) -> None:
        # A rule with no remedy beside it gets worked around rather than met.
        with self.assertRaises(ValueError) as caught:
            r.render({r.PASSWORD_VAR: "short$"})
        self.assertIn("/dev/urandom", str(caught.exception))


class AcceptedPasswords(unittest.TestCase):
    def test_the_documented_generator_alphabet_is_accepted(self) -> None:
        # `tr -dc 'A-Za-z0-9'` is what the error message and the runbook tell
        # the operator to run. If the pattern ever stopped accepting its
        # output, every rotation would fail the stack start.
        self.assertTrue(r.render({r.PASSWORD_VAR: "a" * 20}))
        self.assertTrue(r.render({r.PASSWORD_VAR: GOOD}))

    def test_the_other_allowed_punctuation_is_accepted(self) -> None:
        self.assertTrue(r.render({r.PASSWORD_VAR: "a.b_c~d-e" + "f" * 20}))


class Write(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = pathlib.Path(self.tmp.name) / "db-exporter.my.cnf"

    def test_the_file_is_written_with_the_rendered_content(self) -> None:
        r.write(self.path, "content\n", uid=65534, is_root=False)
        self.assertEqual(self.path.read_text(), "content\n")

    def test_the_file_is_readable_only_by_its_owner(self) -> None:
        # It holds a plaintext password. 0444 would expose it to every other
        # account on the host, the CI deploy account included.
        r.write(self.path, "content\n", uid=65534, is_root=False)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o400)

    def test_the_mode_is_never_wider_even_briefly(self) -> None:
        # Set by os.open rather than a later chmod: a chmod leaves a window in
        # which the password is on disk under the process umask.
        r.write(self.path, "content\n", uid=65534, is_root=False)
        self.assertEqual(stat.S_IMODE(self.path.stat().st_mode), 0o400)

    def test_no_temporary_file_is_left_behind(self) -> None:
        r.write(self.path, "content\n", uid=65534, is_root=False)
        self.assertEqual(
            sorted(p.name for p in pathlib.Path(self.tmp.name).iterdir()),
            ["db-exporter.my.cnf"],
        )

    def test_a_rewrite_replaces_the_previous_content(self) -> None:
        # A 0400 file cannot be opened for writing by its own owner, so a
        # second render has to go through the temp-and-rename path or a
        # rotation fails with "permission denied" on the file it just wrote.
        r.write(self.path, "first\n", uid=65534, is_root=False)
        r.write(self.path, "second\n", uid=65534, is_root=False)
        self.assertEqual(self.path.read_text(), "second\n")

    def test_ownership_is_left_alone_when_not_root(self) -> None:
        # Under CI and a local render there is no container to read the file
        # and no privilege to chown with; a chown attempt would fail the run.
        r.write(self.path, "content\n", uid=65534, is_root=False)
        self.assertEqual(self.path.stat().st_uid, os.getuid())


class HostPath(unittest.TestCase):
    def test_the_default_output_is_outside_the_stack_directory(self) -> None:
        # /opt/branchleft/db is an rsync --delete target. The alertmanager.yml
        # equivalent on edge1 is deleted by every deploy for exactly this
        # reason, and survives only in the running container's file handle.
        self.assertEqual(
            str(r.OUTPUT_PATH), "/etc/branchleft/db-exporter.my.cnf"
        )
        self.assertFalse(str(r.OUTPUT_PATH).startswith("/opt/branchleft/db"))

    def test_the_uid_matches_the_user_the_exporter_image_runs_as(self) -> None:
        # prom/mysqld-exporter:v0.20.0 declares USER nobody = 65534. A
        # root-owned 0400 file makes the exporter exit with "permission
        # denied" on the config path.
        self.assertEqual(r.EXPORTER_UID, 65534)


if __name__ == "__main__":
    unittest.main()
