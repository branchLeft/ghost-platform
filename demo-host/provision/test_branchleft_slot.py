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

import fcntl
import os
import tempfile
import unittest
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
