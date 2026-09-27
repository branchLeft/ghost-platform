#!/usr/bin/env python3
"""Unit tests for branchleft_slot.

The property under test throughout is exactness: `parse_invocation` must
accept precisely the enumerated shapes and refuse everything else,
including the two attacks measured against real `sudo -n` -- a slot+verb
pair collapsed into one shell-quoted argument. `.github/workflows/
demo-host-sudoers-ci.yml` re-proves the same two attacks against a real
installed sudoers file and this real script; the tests here are the fast,
hermetic form of the same claim.
"""

from __future__ import annotations

import contextlib
import fcntl
import io
import os
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import branchleft_slot as bs
import render_slot_sudoers as rss


class ParseInvocationExactnessTests(unittest.TestCase):
    def test_accepts_the_two_argument_reset_form(self):
        self.assertEqual(bs.parse_invocation(["0", "reset"]), bs.ResetInvocation(slot="0"))
        self.assertEqual(bs.parse_invocation(["6", "reset"]), bs.ResetInvocation(slot="6"))

    def test_accepts_every_enumerated_colour_invocation(self):
        for slot in bs.SLOT_NAMES:
            for colour in bs.COLOURS:
                for verb in bs.VERBS:
                    self.assertEqual(
                        bs.parse_invocation([slot, colour, verb]),
                        bs.ColourInvocation(slot=slot, colour=colour, verb=verb),
                    )

    def test_accepts_every_enumerated_read_only_invocation(self):
        for slot in bs.SLOT_NAMES:
            for colour in bs.COLOURS:
                for verb in bs.READ_VERBS:
                    self.assertEqual(
                        bs.parse_invocation([slot, colour, verb]),
                        bs.ColourInvocation(slot=slot, colour=colour, verb=verb),
                    )

    def test_refuses_slot_and_verb_collapsed_into_one_shell_quoted_argument(self):
        # Reproduces `sudo branchleft-slot '0 reset'` -- sudo's own argv
        # splitting hands this process exactly one element, not two, because
        # sudo matched the space-joined text of a single quoted shell word
        # against the sudoers rule for the two-argument form. Measured
        # against real `sudo -n`, in the review that shaped this wrapper.
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["0 reset"])

    def test_refuses_colour_and_verb_collapsed_into_one_shell_quoted_argument(self):
        # Reproduces `sudo branchleft-slot 0 'a start'` -- two arguments
        # reach this process, but the second is not a member of COLOURS.
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["0", "a start"])

    def test_refuses_the_enumerated_form_with_one_extra_argument_appended(self):
        # `.github/workflows/demo-host-sudoers-ci.yml` proves sudoers itself
        # already refuses this at `sudo -l`; this proves the wrapper does
        # too; defence in depth means neither layer is allowed to be the
        # only one that holds.
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["0", "reset", "extra-argument"])
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["0", "a", "start", "extra-argument"])

    def test_refuses_zero_arguments(self):
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation([])

    def test_refuses_an_unenumerated_slot_name(self):
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["7", "reset"])
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["7", "a", "start"])

    def test_refuses_an_unenumerated_colour(self):
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["0", "c", "start"])

    def test_refuses_an_unenumerated_verb(self):
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["0", "a", "restart"])

    def test_refuses_a_path_offered_as_a_slot_name(self):
        # The wrapper "must never accept a path" (LLD-2 §02) -- proven here
        # as the specific case of a slot argument that looks like one.
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["/etc/passwd", "reset"])

    def test_never_calls_split_or_join_before_validating(self):
        # A regression guard on the module's own approach, not only its
        # output: a value that would parse differently under `.split()` than
        # under direct equality must still be refused, because nothing in
        # this function may reduce argv to a joined string before comparing
        # it element-wise. "0\treset" (a tab, not a space) would satisfy a
        # naive `" ".join(argv).split()` round-trip back into ["0", "reset"]
        # on some split implementations; it must not parse as one here.
        with self.assertRaises(bs.InvalidInvocation):
            bs.parse_invocation(["0\treset"])


class SlotNamesDriftGuardTests(unittest.TestCase):
    def test_slot_names_matches_the_sudoers_generators_table(self):
        # The two files are deliberately not one import (see
        # branchleft_slot.py's module docstring) -- this is what stops them
        # drifting apart silently instead.
        self.assertEqual(bs.SLOT_NAMES, rss.SLOT_NAMES)

    def test_colours_and_start_stop_verbs_match_the_sudoers_generator(self):
        self.assertEqual(bs.COLOURS, rss.COLOURS)
        self.assertEqual(bs.VERBS, rss.START_STOP_VERBS)

    def test_read_verbs_match_the_sudoers_generator(self):
        self.assertEqual(bs.READ_VERBS, rss.READ_VERBS)


class FakeSlotOps:
    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []

    def systemctl(self, action: str, unit: str) -> None:
        self.calls.append(("systemctl", action, unit))

    def remove_dir_contents(self, path: str) -> None:
        self.calls.append(("remove_dir_contents", path))

    def remove_file_if_present(self, path: str) -> None:
        self.calls.append(("remove_file_if_present", path))

    def recreate_empty_dir(self, path: str) -> None:
        self.calls.append(("recreate_empty_dir", path))


class PerformDispatchTests(unittest.TestCase):
    """`perform` always takes the real per-slot flock (see `SlotLockTests`),
    so every test here needs a writable `LOCK_DIR` -- the production default,
    `/run/branchleft`, is root-only and often not even mounted writable on a
    workstation. Patched per test rather than once at import time, so a
    test that forgets to request it fails loudly instead of silently
    sharing state with another test's directory.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self._patch = mock.patch.object(bs, "LOCK_DIR", self._tmp.name)
        self._patch.start()

    def tearDown(self) -> None:
        self._patch.stop()
        self._tmp.cleanup()

    def test_colour_start_calls_systemctl_start_on_the_named_units_instance(self):
        ops = FakeSlotOps()
        bs.perform(bs.ColourInvocation(slot="3", colour="a", verb="start"), ops)
        self.assertEqual(ops.calls, [("systemctl", "start", "branchleft-compose@demo-3-a")])

    def test_colour_stop_calls_systemctl_stop_on_the_named_units_instance(self):
        ops = FakeSlotOps()
        bs.perform(bs.ColourInvocation(slot="3", colour="b", verb="stop"), ops)
        self.assertEqual(ops.calls, [("systemctl", "stop", "branchleft-compose@demo-3-b")])

    def test_colour_invocation_never_touches_the_other_colour(self):
        ops = FakeSlotOps()
        bs.perform(bs.ColourInvocation(slot="3", colour="a", verb="start"), ops)
        for call in ops.calls:
            self.assertNotIn("demo-3-b", call)

    def test_reset_stops_both_colours_then_wipes_state_in_order(self):
        ops = FakeSlotOps()
        bs.perform(bs.ResetInvocation(slot="4"), ops)
        self.assertEqual(
            ops.calls,
            [
                ("systemctl", "stop", "branchleft-compose@demo-4-a"),
                ("systemctl", "stop", "branchleft-compose@demo-4-b"),
                ("remove_dir_contents", "/opt/branchleft/demo-4"),
                ("remove_file_if_present", "/etc/branchleft/demo-4-a.env"),
                ("remove_file_if_present", "/etc/branchleft/demo-4-b.env"),
                ("recreate_empty_dir", "/opt/branchleft/demo-4"),
            ],
        )

    def test_reset_wipes_before_recreating_never_the_other_way(self):
        ops = FakeSlotOps()
        bs.perform(bs.ResetInvocation(slot="0"), ops)
        names = [call[0] for call in ops.calls]
        self.assertLess(names.index("remove_dir_contents"), names.index("recreate_empty_dir"))


class SlotLockTests(unittest.TestCase):
    """Proves the flock is real OS-level exclusion, not merely a call that
    happened -- a sabotage that replaced `_acquire_slot_lock` with a no-op
    would still pass every dispatch test above, since none of them touch
    the filesystem. Only a genuine second-holder probe on the same path can
    tell the two apart.
    """

    def test_a_second_holder_is_refused_while_the_lock_is_held(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(bs, "LOCK_DIR", tmp):
                held = bs._acquire_slot_lock("2")
                try:
                    probe = open(bs._lock_path("2"), "w")
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    probe.close()
                finally:
                    fcntl.flock(held, fcntl.LOCK_UN)
                    held.close()

    def test_the_lock_is_available_again_once_released(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(bs, "LOCK_DIR", tmp):
                held = bs._acquire_slot_lock("2")
                fcntl.flock(held, fcntl.LOCK_UN)
                held.close()

                probe = open(bs._lock_path("2"), "w")
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)  # must not raise
                fcntl.flock(probe, fcntl.LOCK_UN)
                probe.close()

    def test_perform_releases_the_lock_even_when_an_op_raises(self):
        class RaisingOps(FakeSlotOps):
            def systemctl(self, action: str, unit: str) -> None:
                raise RuntimeError("systemctl is unavailable")

        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(bs, "LOCK_DIR", tmp):
                with self.assertRaises(RuntimeError):
                    bs.perform(bs.ColourInvocation(slot="5", colour="a", verb="start"), RaisingOps())

                probe = open(bs._lock_path("5"), "w")
                fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)  # must not raise
                fcntl.flock(probe, fcntl.LOCK_UN)
                probe.close()


class MainDispatchTests(unittest.TestCase):
    """Proves the boundary between argv validation and any side effect: an
    invocation `parse_invocation` refuses must never reach `perform` at
    all -- the sabotage that matters here is a `main` that validates and
    then acts regardless of the result.
    """

    def test_an_invalid_invocation_never_reaches_perform(self):
        with mock.patch("branchleft_slot.perform") as perform:
            exit_code = bs.main(["0 reset"])
        perform.assert_not_called()
        self.assertEqual(exit_code, 1)

    def test_a_valid_invocation_reaches_perform_with_the_parsed_shape(self):
        with mock.patch("branchleft_slot.perform") as perform:
            exit_code = bs.main(["3", "a", "start"])
        perform.assert_called_once()
        (invocation, ops), _kwargs = perform.call_args
        self.assertEqual(invocation, bs.ColourInvocation(slot="3", colour="a", verb="start"))
        self.assertIsInstance(ops, bs.RealSlotOps)
        self.assertEqual(exit_code, 0)

    def test_a_failure_inside_perform_exits_non_zero_rather_than_raising(self):
        with mock.patch("branchleft_slot.perform", side_effect=RuntimeError("systemctl exploded")):
            exit_code = bs.main(["0", "reset"])
        self.assertEqual(exit_code, 1)

    def test_defaults_to_sys_argv_when_no_argv_is_passed(self):
        with mock.patch("branchleft_slot.sys.argv", ["branchleft-slot", "0 reset"]):
            with mock.patch("branchleft_slot.perform") as perform:
                exit_code = bs.main()
        perform.assert_not_called()
        self.assertEqual(exit_code, 1)

    def test_a_read_only_invocation_never_reaches_perform_or_takes_the_slot_lock(self):
        # The property this test exists for: a read verb has no privileged
        # side effect, so it must never call perform/RealSlotOps.systemctl
        # at all -- proven against the real dispatch in main, not merely
        # against count_submitting_email_batches in isolation.
        with mock.patch("branchleft_slot.perform") as perform, mock.patch(
            "branchleft_slot.count_submitting_email_batches", return_value=0
        ):
            exit_code = bs.main(["0", "a", "email-batches"])
        perform.assert_not_called()
        self.assertEqual(exit_code, 0)


def _write_sqlite_db(path, submitting_count: int, other_count: int = 0) -> None:
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


class DataDirectoryTests(unittest.TestCase):
    def test_derived_from_slot_alone_via_the_uid_formula(self):
        # Mirrors services/broker/src/config.ts's BROKER_UID_BASE default
        # and slotPorts.ts's slotUid: uid = UID_BASE + int(slot).
        path = bs._data_directory("3")
        self.assertEqual(path, bs.DOCKER_VOLUME_ROOT / "ghost-demo-30004-data" / "_data")

    def test_colour_blind(self):
        # The verb takes a colour for shape symmetry only -- the query
        # this file runs never depends on it, because the colour pair
        # shares one SQLite file. Asserted by construction: _data_directory
        # itself takes no colour parameter at all.
        self.assertNotIn("colour", bs._data_directory.__code__.co_varnames)

    def test_uid_base_matches_the_broker_configs_own_default(self):
        # services/broker/src/config.ts: `uidBase: positiveInteger(env,
        # 'BROKER_UID_BASE', 30001, 65000)`. Not read from that file (this
        # module has no runtime dependency on the broker's TypeScript) --
        # this test is the tripwire that catches the two drifting apart.
        self.assertEqual(bs.UID_BASE, 30001)


class CountSubmittingEmailBatchesTests(unittest.TestCase):
    """`count_submitting_email_batches` takes no fork here -- a test
    process is never root (`os.getuid() != 0`), so every call in this
    class exercises `_read_submitting_count` directly, at whatever uid the
    test itself runs as. `UID_BASE` is patched to that real uid (always
    slot "0", so `expected_uid = UID_BASE + 0` lands exactly on it) for
    every test that expects a real file it creates to be *accepted* --
    the file is genuinely owned by the test process, so the owner check
    is exercised for real, not bypassed. Left at its production default
    (almost certainly not this process's own uid) wherever a test does
    not patch it, which is exactly what the "wrong owner" test below
    relies on.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._root = os.path.join(self._tmp.name, "volumes")
        os.makedirs(self._root)
        patcher = mock.patch.object(bs, "DOCKER_VOLUME_ROOT", Path(self._root))
        patcher.start()
        self.addCleanup(patcher.stop)

    def _data_dir_for(self, slot: str):
        data_dir = bs._data_directory(slot)
        data_dir.mkdir(parents=True)
        return data_dir

    def _own_files_as_this_process(self) -> None:
        patcher = mock.patch.object(bs, "UID_BASE", os.getuid())
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_counts_only_submitting_rows(self):
        self._own_files_as_this_process()
        data_dir = self._data_dir_for("0")
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=3, other_count=5)
        self.assertEqual(bs.count_submitting_email_batches("0"), 3)

    def test_zero_when_nothing_is_submitting(self):
        self._own_files_as_this_process()
        data_dir = self._data_dir_for("0")
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=0, other_count=5)
        self.assertEqual(bs.count_submitting_email_batches("0"), 0)

    def test_refuses_when_the_data_directory_does_not_exist(self):
        self._own_files_as_this_process()
        with self.assertRaises(bs.EmailBatchCheckError):
            bs.count_submitting_email_batches("0")

    def test_refuses_when_no_db_file_is_present(self):
        self._own_files_as_this_process()
        self._data_dir_for("0")
        with self.assertRaises(bs.EmailBatchCheckError):
            bs.count_submitting_email_batches("0")

    def test_refuses_when_more_than_one_db_file_is_present(self):
        self._own_files_as_this_process()
        data_dir = self._data_dir_for("0")
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=1)
        _write_sqlite_db(data_dir / "stray.db", submitting_count=1)
        with self.assertRaises(bs.EmailBatchCheckError):
            bs.count_submitting_email_batches("0")

    def test_refuses_when_the_table_is_missing(self):
        self._own_files_as_this_process()
        data_dir = self._data_dir_for("0")
        connection = sqlite3.connect(str(data_dir / "ghost.db"))
        connection.close()
        with self.assertRaises(bs.EmailBatchCheckError):
            bs.count_submitting_email_batches("0")

    def test_refuses_a_file_owned_by_someone_else(self):
        # UID_BASE is deliberately left at its production default here --
        # a real file this test process creates is owned by its own uid,
        # essentially never 30001, so this exercises the owner check for
        # real rather than asserting a tautology.
        data_dir = self._data_dir_for("0")
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=1)
        with self.assertRaises(bs.EmailBatchCheckError) as ctx:
            bs.count_submitting_email_batches("0")
        self.assertIn("owned by uid", str(ctx.exception))

    def test_refuses_a_symlink_even_when_it_points_at_a_valid_db(self):
        self._own_files_as_this_process()
        data_dir = self._data_dir_for("0")
        # The target is named without a ".db" suffix so it is not itself a
        # second glob("*.db") candidate -- this test means to exercise the
        # not-a-regular-file refusal, not the separate "expected exactly
        # one" check, which has its own dedicated test above.
        real_target = data_dir / "real-target"
        _write_sqlite_db(real_target, submitting_count=1)
        (data_dir / "ghost.db").symlink_to(real_target)
        with self.assertRaises(bs.EmailBatchCheckError) as ctx:
            bs.count_submitting_email_batches("0")
        # O_NOFOLLOW makes the open() call itself fail (ELOOP) for an
        # actual symlink -- proof the flag is really in the open() call,
        # not merely claimed in a comment. This is a different failure
        # shape from the fstat-based "not a regular file" refusal a FIFO
        # or a directory hits (open() succeeds for those; the S_ISREG
        # check afterwards is what refuses them) -- both are covered, each
        # by its own test.
        self.assertIn("failed to open", str(ctx.exception))

    def test_refuses_a_fifo_without_blocking(self):
        # A FIFO opened for read with no writer blocks forever under a
        # plain os.open(O_RDONLY) -- proof that this refuses without
        # hanging is proof O_NONBLOCK is actually in the open() flags,
        # not merely a comment claiming it is.
        self._own_files_as_this_process()
        data_dir = self._data_dir_for("0")
        os.mkfifo(data_dir / "ghost.db")
        started = time.monotonic()
        with self.assertRaises(bs.EmailBatchCheckError) as ctx:
            bs.count_submitting_email_batches("0")
        self.assertLess(time.monotonic() - started, 2.0)
        self.assertIn("not a regular file", str(ctx.exception))

    def test_refuses_a_directory_named_like_a_db_file(self):
        self._own_files_as_this_process()
        data_dir = self._data_dir_for("0")
        (data_dir / "ghost.db").mkdir()
        with self.assertRaises(bs.EmailBatchCheckError) as ctx:
            bs.count_submitting_email_batches("0")
        self.assertIn("not a regular file", str(ctx.exception))

    def test_never_writes_to_the_database(self):
        self._own_files_as_this_process()
        data_dir = self._data_dir_for("0")
        db_path = data_dir / "ghost.db"
        _write_sqlite_db(db_path, submitting_count=0)

        uri = f"{db_path.resolve().as_uri()}?mode=ro"
        connection = sqlite3.connect(uri, uri=True)
        try:
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute("INSERT INTO email_batches (status) VALUES ('submitting')")
        finally:
            connection.close()


class CountSubmittingEmailBatchesRootDispatchTests(unittest.TestCase):
    """`count_submitting_email_batches` itself never forks in this
    process (a test is never root) -- this proves the *decision*, not the
    fork, by making `os.getuid` lie.
    """

    def test_dispatches_to_the_privileged_fork_path_only_when_root(self):
        with mock.patch("branchleft_slot.os.getuid", return_value=0), mock.patch(
            "branchleft_slot._read_submitting_count_as_uid", return_value=7
        ) as forked, mock.patch("branchleft_slot._read_submitting_count") as direct:
            result = bs.count_submitting_email_batches("2")
        forked.assert_called_once_with("2", bs.UID_BASE + 2)
        direct.assert_not_called()
        self.assertEqual(result, 7)

    def test_dispatches_directly_with_no_fork_when_not_root(self):
        with mock.patch(
            "branchleft_slot._read_submitting_count", return_value=9
        ) as direct, mock.patch("branchleft_slot._read_submitting_count_as_uid") as forked:
            result = bs.count_submitting_email_batches("2")
        direct.assert_called_once_with("2", bs.UID_BASE + 2)
        forked.assert_not_called()
        self.assertEqual(result, 9)


class ReadSubmittingCountAsUidForkTests(unittest.TestCase):
    """Real `os.fork()` throughout -- forking itself needs no privilege,
    only `os.setuid`/`os.setgid` to an arbitrary *different* uid does, so
    every test here either drops to this process's own current uid/gid
    (a no-op `setuid`/`setgid` POSIX permits any process to perform on
    itself) or deliberately leaves the drop ineffective to prove the
    parent's own verification catches that -- never a mocked fork, which
    would prove nothing about whether the pipe, the wait or the kill
    actually work across a real process boundary.
    """

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self._root = os.path.join(self._tmp.name, "volumes")
        os.makedirs(self._root)
        patcher = mock.patch.object(bs, "DOCKER_VOLUME_ROOT", Path(self._root))
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_real_self_drop_succeeds_end_to_end_through_the_pipe(self):
        # setuid(getuid()) is a no-op POSIX permits any unprivileged
        # process to perform on itself -- the one way to exercise a
        # *successful* privilege drop's setuid call for real without
        # being root. setgroups([]) always requires real privilege
        # (there is no "unless it's already my groups" exception in
        # POSIX); this platform's setgid also refuses an unprivileged
        # caller even at its own current gid (stricter than Linux's own
        # permitted self-target case) -- both are mocked away here, since
        # neither is testable from an unprivileged process on this
        # platform either way, so that setuid -- the call this test
        # actually means to prove -- runs for real. No UID_BASE patch
        # needed: `_read_submitting_count_as_uid` takes `uid` directly,
        # and `_data_directory` (used both to create the fixture here and
        # inside the call under test) derives its own path from the same,
        # untouched default `UID_BASE` either way.
        own_uid = os.getuid()
        data_dir = bs._data_directory("0")
        data_dir.mkdir(parents=True)
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=4)
        with mock.patch(
            "branchleft_slot.os.setgroups", side_effect=lambda groups: None
        ), mock.patch("branchleft_slot.os.setgid", side_effect=lambda gid: None):
            count = bs._read_submitting_count_as_uid("0", own_uid)
        self.assertEqual(count, 4)

    def test_a_drop_that_setuid_silently_no_ops_is_caught_by_the_parents_own_uid_check(self):
        # Sabotage of the privilege drop itself: os.setuid/setgid are
        # patched to no-ops (as if the calls were removed or failed
        # silently), so the child keeps running as this process's own
        # real uid while the parent asked for a *different* target uid.
        # `_read_submitting_count` is mocked to a canned success so this
        # test isolates the drop-verification property from the file/
        # owner checks, which have their own dedicated tests above.
        target_uid = os.getuid() + 12345
        with mock.patch("branchleft_slot.os.setuid", side_effect=lambda uid: None), mock.patch(
            "branchleft_slot.os.setgid", side_effect=lambda gid: None
        ), mock.patch(
            "branchleft_slot.os.setgroups", side_effect=lambda groups: None
        ), mock.patch("branchleft_slot._read_submitting_count", return_value=1):
            with self.assertRaises(bs.EmailBatchCheckError) as ctx:
                bs._read_submitting_count_as_uid("0", target_uid)
        self.assertIn("reported running as uid", str(ctx.exception))

    def test_a_target_uid_this_process_cannot_reach_fails_closed_not_hanging(self):
        # No mocking at all: a real, unprivileged child calling
        # setgroups/setgid/setuid with no privilege to back any of them
        # genuinely fails with EPERM, which must reach the parent as a
        # refusal, not a hang or a crash -- whichever of the three calls
        # is what actually raises first.
        with self.assertRaises(bs.EmailBatchCheckError):
            bs._read_submitting_count_as_uid("0", os.getuid() + 1)

    def test_a_real_setuid_to_an_unreachable_target_is_refused_before_any_read(self):
        # setgroups/setgid mocked away for the same platform reason as the
        # self-drop success test (both fail unconditionally here, masking
        # whatever setuid itself would do) -- setuid is left real. A
        # target uid this process cannot reach must fail via a real
        # PermissionError raised *by setuid itself*, distinguishable from
        # the "silently no-op'd" test above (which mocks setuid away on
        # purpose): removing the real `os.setuid(uid)` call would let the
        # child fall through to the mocked, always-succeeding
        # `_read_submitting_count` and report success at its own
        # (unchanged) uid -- caught only by the parent's separate uid
        # mismatch message, not this one, so the two assertions together
        # are what make the setuid call's own presence load-bearing.
        target_uid = os.getuid() + 54321
        with mock.patch(
            "branchleft_slot.os.setgroups", side_effect=lambda groups: None
        ), mock.patch(
            "branchleft_slot.os.setgid", side_effect=lambda gid: None
        ), mock.patch("branchleft_slot._read_submitting_count", return_value=1):
            with self.assertRaises(bs.EmailBatchCheckError) as ctx:
                bs._read_submitting_count_as_uid("0", target_uid)
        self.assertIn("Operation not permitted", str(ctx.exception))

    def test_a_wedged_child_is_killed_after_the_timeout_rather_than_awaited(self):
        # setgroups/setgid mocked away for the same platform reason as
        # the self-drop success test above -- this test means to prove
        # the timeout/kill mechanics, not re-prove the drop itself.
        with mock.patch.object(bs, "_READ_TIMEOUT_SECONDS", 0.2), mock.patch(
            "branchleft_slot._read_submitting_count", side_effect=lambda *a, **k: time.sleep(30)
        ), mock.patch(
            "branchleft_slot.os.setgroups", side_effect=lambda groups: None
        ), mock.patch("branchleft_slot.os.setgid", side_effect=lambda gid: None):
            started = time.monotonic()
            with self.assertRaises(bs.EmailBatchCheckError) as ctx:
                bs._read_submitting_count_as_uid("0", os.getuid())
            elapsed = time.monotonic() - started
        self.assertLess(elapsed, 5.0)
        self.assertIn("timed out", str(ctx.exception))


class MainEmailBatchesDispatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        patcher = mock.patch.object(bs, "DOCKER_VOLUME_ROOT", Path(self._tmp.name))
        patcher.start()
        self.addCleanup(patcher.stop)
        # A test process is never root, and `main` still calls
        # `count_submitting_email_batches`, which owner-checks against
        # `UID_BASE + slot` -- patched to this process's own uid so the
        # real file created below is genuinely accepted, not bypassed.
        uid_patcher = mock.patch.object(bs, "UID_BASE", os.getuid())
        uid_patcher.start()
        self.addCleanup(uid_patcher.stop)

    def test_prints_the_bare_count_on_success(self):
        data_dir = bs._data_directory("0")
        data_dir.mkdir(parents=True)
        _write_sqlite_db(data_dir / "ghost.db", submitting_count=2)

        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            exit_code = bs.main(["0", "a", "email-batches"])
        self.assertEqual(exit_code, 0)
        self.assertEqual(out.getvalue(), "2\n")

    def test_fails_closed_on_a_missing_data_directory_printing_nothing_to_stdout(self):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            exit_code = bs.main(["1", "a", "email-batches"])
        self.assertEqual(exit_code, 1)
        self.assertEqual(out.getvalue(), "")
        self.assertNotEqual(err.getvalue(), "")


class RealSlotOpsWiringTests(unittest.TestCase):
    """Proves `RealSlotOps` -- the implementation `main` actually uses --
    only ever invokes `systemctl`, with an explicit argv list and no shell,
    across every dispatch path. A sabotage that had this reach for `docker`
    instead (or `shell=True`) would still satisfy every FakeSlotOps-based
    test above; only a check on the real implementation catches it.
    """

    def test_systemctl_is_called_with_an_explicit_argv_list_and_no_shell(self):
        ops = bs.RealSlotOps()
        with mock.patch("branchleft_slot.subprocess.run") as run:
            ops.systemctl("start", "branchleft-compose@demo-0-a")
        run.assert_called_once_with(
            ["systemctl", "start", "branchleft-compose@demo-0-a"], check=True
        )

    def test_every_perform_path_calls_only_systemctl_as_the_privileged_primitive(self):
        with tempfile.TemporaryDirectory() as tmp:
            with mock.patch.object(bs, "LOCK_DIR", tmp), \
                mock.patch.object(bs, "SLOT_DIR", os.path.join(tmp, "demo-{slot}")), \
                mock.patch.object(bs, "ETC_DIR", tmp), \
                mock.patch("branchleft_slot.subprocess.run") as run:
                bs.perform(bs.ResetInvocation(slot="1"), bs.RealSlotOps())
        for call in run.call_args_list:
            argv = call.args[0]
            self.assertEqual(argv[0], "systemctl")


class RealSlotOpsFilesystemTests(unittest.TestCase):
    def test_remove_dir_contents_empties_the_directory_without_removing_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            slot_dir = os.path.join(tmp, "demo-0")
            os.makedirs(os.path.join(slot_dir, "sub"))
            with open(os.path.join(slot_dir, "compose.yml"), "w") as handle:
                handle.write("x")
            with open(os.path.join(slot_dir, "sub", "nested"), "w") as handle:
                handle.write("x")

            bs.RealSlotOps().remove_dir_contents(slot_dir)

            self.assertTrue(os.path.isdir(slot_dir))
            self.assertEqual(os.listdir(slot_dir), [])

    def test_remove_dir_contents_on_a_missing_directory_is_a_no_op(self):
        with tempfile.TemporaryDirectory() as tmp:
            missing = os.path.join(tmp, "not-there")
            bs.RealSlotOps().remove_dir_contents(missing)  # must not raise

    def test_remove_file_if_present_is_idempotent(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "demo-0-a.env")
            bs.RealSlotOps().remove_file_if_present(path)  # missing: no-op
            with open(path, "w") as handle:
                handle.write("x")
            bs.RealSlotOps().remove_file_if_present(path)
            self.assertFalse(os.path.exists(path))

    def test_recreate_empty_dir_creates_a_missing_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = os.path.join(tmp, "demo-2")
            bs.RealSlotOps().recreate_empty_dir(target)
            self.assertTrue(os.path.isdir(target))


if __name__ == "__main__":
    unittest.main()
