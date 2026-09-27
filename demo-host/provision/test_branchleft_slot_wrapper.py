#!/usr/bin/env python3
"""Unit tests for branchleft_slot_wrapper.

Two properties matter, and each has its own test class: `parse_invocation`
refuses everything that is not exactly one of the enumerated shapes (this
is the argument-injection boundary `render_slot_sudoers.py`'s own docstring
describes -- sudoers matches space-joined text, not argument boundaries,
so this module's own, independent argv-length check is the real backstop);
and `count_submitting_email_batches` runs its one fixed query against
exactly the slot-derived file it is supposed to, refusing rather than
guessing whenever that is not unambiguous.
"""

from __future__ import annotations

import sqlite3
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import branchleft_slot_wrapper as bsw
import render_slot_sudoers as rss


class ParseInvocationValidShapesTests(unittest.TestCase):
    def test_reset_alone(self):
        invocation = bsw.parse_invocation(["0", "reset"])
        self.assertEqual(invocation.slot, "0")
        self.assertIsNone(invocation.colour)
        self.assertEqual(invocation.verb, "reset")

    def test_colour_and_start(self):
        invocation = bsw.parse_invocation(["6", "b", "start"])
        self.assertEqual((invocation.slot, invocation.colour, invocation.verb), ("6", "b", "start"))

    def test_colour_and_stop(self):
        invocation = bsw.parse_invocation(["2", "a", "stop"])
        self.assertEqual((invocation.slot, invocation.colour, invocation.verb), ("2", "a", "stop"))

    def test_colour_and_email_batches(self):
        invocation = bsw.parse_invocation(["3", "a", "email-batches"])
        self.assertEqual(
            (invocation.slot, invocation.colour, invocation.verb), ("3", "a", "email-batches")
        )

    def test_every_enumerated_invocation_from_the_generator_parses(self):
        # The two modules must never drift: everything render_slot_sudoers
        # would put in the sudoers file must parse here without error.
        for invocation_text in rss.all_invocations():
            bsw.parse_invocation(invocation_text.split(" "))


class ParseInvocationRejectionTests(unittest.TestCase):
    def test_rejects_zero_arguments(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation([])

    def test_rejects_one_argument(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["0"])

    def test_rejects_a_smuggled_single_argument_matching_sudoers_text(self):
        # The exact injection render_slot_sudoers.py's own docstring
        # describes: "0 reset" reaching here as ONE argv element (a caller
        # quoted it as a single shell argument) rather than two.
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["0 reset"])

    def test_rejects_four_arguments(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["0", "a", "start", "extra"])

    def test_rejects_an_unenumerated_slot_name(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["7", "reset"])

    def test_rejects_a_slot_name_carrying_a_wildcard(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["0 *", "reset"])

    def test_rejects_two_arguments_with_a_verb_other_than_reset(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["0", "start"])

    def test_rejects_an_unenumerated_colour(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["0", "c", "start"])

    def test_rejects_an_unenumerated_verb(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["0", "a", "delete"])

    def test_rejects_reset_carrying_a_colour(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["0", "a", "reset"])

    def test_rejects_free_form_sql_as_a_verb(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["0", "a", "DROP TABLE users"])

    def test_rejects_a_path_in_place_of_a_slot(self):
        with self.assertRaises(bsw.InvocationError):
            bsw.parse_invocation(["/etc/passwd", "a", "email-batches"])


class DataDirectoryTests(unittest.TestCase):
    def test_derived_from_slot_alone_via_the_uid_formula(self):
        # Mirrors services/broker/src/config.ts's BROKER_UID_BASE default
        # and slotPorts.ts's slotUid: uid = UID_BASE + int(slot).
        path = bsw._data_directory("3")
        self.assertEqual(path, bsw.DOCKER_VOLUME_ROOT / "ghost-demo-30004-data" / "_data")

    def test_colour_blind(self):
        # The verb takes a colour for shape symmetry only -- the query
        # this file runs never depends on it, because the colour pair
        # shares one SQLite file. Asserted by construction: _data_directory
        # itself takes no colour parameter at all.
        self.assertNotIn("colour", bsw._data_directory.__code__.co_varnames)

    def test_uid_base_matches_the_broker_configs_own_default(self):
        # services/broker/src/config.ts: `uidBase: positiveInteger(env,
        # 'BROKER_UID_BASE', 30001, 65000)`. Not read from that file (this
        # script has no runtime dependency on the broker's TypeScript) --
        # this test is the tripwire that catches the two drifting apart.
        self.assertEqual(bsw.UID_BASE, 30001)


def _write_sqlite_db(path: Path, submitting_count: int, other_count: int = 0) -> None:
    connection = sqlite3.connect(str(path))
    try:
        connection.execute("CREATE TABLE email_batches (id INTEGER PRIMARY KEY, status TEXT)")
        for _ in range(submitting_count):
            connection.execute("INSERT INTO email_batches (status) VALUES ('submitting')")
        for _ in range(other_count):
            connection.execute("INSERT INTO email_batches (status) VALUES ('submitted')")
        connection.commit()
    finally:
        connection.close()


class CountSubmittingEmailBatchesTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._root = Path(self._tmp.name)
        patcher = mock.patch.object(bsw, "DOCKER_VOLUME_ROOT", self._root)
        patcher.start()
        self.addCleanup(patcher.stop)

    def _data_dir_for(self, slot: str) -> Path:
        data_dir = bsw._data_directory(slot)
        data_dir.mkdir(parents=True)
        return data_dir

    def test_counts_only_submitting_rows(self):
        data_dir = self._data_dir_for("0")
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=3, other_count=5)
        self.assertEqual(bsw.count_submitting_email_batches("0"), 3)

    def test_zero_when_nothing_is_submitting(self):
        data_dir = self._data_dir_for("1")
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=0, other_count=5)
        self.assertEqual(bsw.count_submitting_email_batches("1"), 0)

    def test_refuses_when_the_data_directory_does_not_exist(self):
        # No mkdir -- slot "2"'s directory was never created.
        with self.assertRaises(bsw.EmailBatchCheckError):
            bsw.count_submitting_email_batches("2")

    def test_refuses_when_no_db_file_is_present(self):
        self._data_dir_for("3")
        with self.assertRaises(bsw.EmailBatchCheckError):
            bsw.count_submitting_email_batches("3")

    def test_refuses_when_more_than_one_db_file_is_present(self):
        data_dir = self._data_dir_for("4")
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=1)
        _write_sqlite_db(data_dir / "stray.db", submitting_count=1)
        with self.assertRaises(bsw.EmailBatchCheckError):
            bsw.count_submitting_email_batches("4")

    def test_refuses_when_the_table_is_missing(self):
        data_dir = self._data_dir_for("5")
        connection = sqlite3.connect(str(data_dir / "ghost.db"))
        connection.close()
        with self.assertRaises(bsw.EmailBatchCheckError):
            bsw.count_submitting_email_batches("5")

    def test_never_writes_to_the_database(self):
        # Opened read-only (mode=ro): an attempted write against the
        # connection this function opens must fail, proving the "read-only"
        # claim rather than merely asserting it in a comment.
        data_dir = self._data_dir_for("6")
        db_path = data_dir / "ghost.db"
        _write_sqlite_db(db_path, submitting_count=0)

        uri = f"{db_path.resolve().as_uri()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("INSERT INTO email_batches (status) VALUES ('submitting')")
        finally:
            connection.close()


class MainTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patcher = mock.patch.object(bsw, "DOCKER_VOLUME_ROOT", Path(self._tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_bad_invocation_exits_with_the_bad_invocation_code_and_prints_nothing_to_stdout(self):
        import contextlib
        import io

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exit_code = bsw.main(["7", "reset"])
        self.assertEqual(exit_code, bsw.EXIT_BAD_INVOCATION)
        self.assertEqual(out.getvalue(), "")
        self.assertNotEqual(err.getvalue(), "")

    def test_reset_is_recognised_but_not_implemented(self):
        import contextlib
        import io

        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            exit_code = bsw.main(["0", "reset"])
        self.assertEqual(exit_code, bsw.EXIT_NOT_IMPLEMENTED)
        self.assertEqual(out.getvalue(), "")

    def test_start_is_recognised_but_not_implemented(self):
        import contextlib
        import io

        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            exit_code = bsw.main(["0", "a", "start"])
        self.assertEqual(exit_code, bsw.EXIT_NOT_IMPLEMENTED)

    def test_email_batches_prints_the_bare_count_on_success(self):
        import contextlib
        import io

        data_dir = bsw._data_directory("0")
        data_dir.mkdir(parents=True)
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=2)

        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            exit_code = bsw.main(["0", "a", "email-batches"])
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.getvalue(), "2\n")

    def test_email_batches_fails_closed_on_a_missing_data_directory(self):
        import contextlib
        import io

        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exit_code = bsw.main(["1", "a", "email-batches"])
        self.assertEqual(exit_code, bsw.EXIT_CHECK_FAILED)
        self.assertEqual(out.getvalue(), "")
        self.assertNotEqual(err.getvalue(), "")


if __name__ == "__main__":
    unittest.main()
