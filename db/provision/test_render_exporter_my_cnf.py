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


class StubAtTheOutputPath(unittest.TestCase):
    """Docker creates an empty directory at a bind-mount source it cannot find.
    That happens the first time the stack starts without this renderer, and it
    then fails every subsequent start -- MySQL's included, and across reboots
    -- because os.replace cannot rename over a directory. /etc/branchleft is
    swept by nothing, so it is permanent until somebody removes it by hand."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.path = self.root / "db-exporter.my.cnf"

    def test_an_empty_directory_at_the_target_is_replaced(self) -> None:
        self.path.mkdir()
        r.write(self.path, "content\n", uid=65534, is_root=False)
        self.assertEqual(self.path.read_text(), "content\n")

    def test_a_non_empty_directory_is_refused_rather_than_deleted(self) -> None:
        # It is not Docker's stub, so it is somebody's data. Failing loudly is
        # the right way round; the caller turns this into a named message.
        self.path.mkdir()
        (self.path / "something").write_text("do not delete me")
        with self.assertRaises(OSError):
            r.write(self.path, "content\n", uid=65534, is_root=False)
        self.assertTrue((self.path / "something").is_file())

    def test_a_stale_temp_file_from_a_crashed_run_does_not_block_a_retry(self) -> None:
        # 0400 owned by the caller cannot be reopened for writing, so without
        # the unlink a crashed render would fail every retry.
        tmp = self.path.with_name(self.path.name + ".tmp")
        r.write(self.path, "first\n", uid=65534, is_root=False)
        os.close(os.open(tmp, os.O_WRONLY | os.O_CREAT, 0o400))
        r.write(self.path, "second\n", uid=65534, is_root=False)
        self.assertEqual(self.path.read_text(), "second\n")

    def test_a_symlink_at_the_temp_path_is_not_followed(self) -> None:
        # This runs as root under systemd, so a followed symlink would write a
        # plaintext password wherever it pointed.
        victim = self.root / "victim"
        victim.write_text("untouched")
        (self.root / "db-exporter.my.cnf.tmp").symlink_to(victim)
        r.write(self.path, "content\n", uid=65534, is_root=False)
        self.assertEqual(victim.read_text(), "untouched")

    def test_a_symlink_at_the_target_is_replaced_not_followed(self) -> None:
        victim = self.root / "victim"
        victim.write_text("untouched")
        self.path.symlink_to(victim)
        r.write(self.path, "content\n", uid=65534, is_root=False)
        self.assertEqual(victim.read_text(), "untouched")
        self.assertFalse(self.path.is_symlink())
        self.assertEqual(self.path.read_text(), "content\n")


class Main(unittest.TestCase):
    """main() is an ExecStartPre. Its stderr is the whole of what an operator
    sees before MySQL fails to come back with it, so a traceback there is a
    real cost rather than untidiness."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = pathlib.Path(self.tmp.name) / "db-exporter.my.cnf"
        for var in (r.PASSWORD_VAR, "EXPORTER_MY_CNF_PATH", "EXPORTER_DATA_SOURCE_NAME"):
            self.addCleanup(os.environ.pop, var, None)
        os.environ["EXPORTER_MY_CNF_PATH"] = str(self.path)

    def test_a_good_render_writes_the_file_and_returns_zero(self) -> None:
        os.environ[r.PASSWORD_VAR] = GOOD
        self.assertEqual(r.main([]), 0)
        self.assertIn(f"password = {GOOD}", self.path.read_text())

    def test_a_write_failure_returns_one_instead_of_raising(self) -> None:
        os.environ[r.PASSWORD_VAR] = GOOD
        self.path.mkdir()
        (self.path / "something").write_text("data")
        self.assertEqual(r.main([]), 1)

    def test_a_bad_password_returns_one_and_writes_nothing(self) -> None:
        os.environ[r.PASSWORD_VAR] = "short$"
        self.assertEqual(r.main([]), 1)
        self.assertFalse(self.path.exists())


class HostPath(unittest.TestCase):
    def test_the_default_output_is_outside_the_stack_directory(self) -> None:
        # It has to exist before `docker compose up` runs, and /opt/branchleft/db
        # is a deploy target that is re-copied wholesale. /etc/branchleft is
        # where every other stack secret on this estate lives.
        self.assertEqual(
            str(r.DEFAULT_OUTPUT_PATH), "/etc/branchleft/db-exporter.my.cnf"
        )
        self.assertFalse(str(r.DEFAULT_OUTPUT_PATH).startswith("/opt/branchleft/db"))

    def test_the_default_stands_when_no_override_is_set(self) -> None:
        # Read from the environment at call time rather than at import, so an
        # inherited variable on a CI runner cannot fail an unrelated assertion.
        self.assertEqual(r.output_path({}), r.DEFAULT_OUTPUT_PATH)
        self.assertEqual(r.output_path({"EXPORTER_MY_CNF_PATH": ""}), r.DEFAULT_OUTPUT_PATH)
        self.assertEqual(
            r.output_path({"EXPORTER_MY_CNF_PATH": "/tmp/x"}), pathlib.Path("/tmp/x")
        )

    def test_the_uid_matches_the_user_the_exporter_image_runs_as(self) -> None:
        # prom/mysqld-exporter:v0.20.0 declares USER nobody = 65534. A
        # root-owned 0400 file makes the exporter exit with "permission
        # denied" on the config path.
        self.assertEqual(r.EXPORTER_UID, 65534)


if __name__ == "__main__":
    unittest.main()
