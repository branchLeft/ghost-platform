#!/usr/bin/env python3
"""Unit tests for render_slot_sudoers.

The property that matters is exactness: the generated file must contain
precisely the enumerated invocations and nothing a pattern could widen. A
generator that silently dropped a slot, duplicated a line, or let a `*` slip
into an f-string would still "look like" a sudoers file -- these tests are
what would catch that.
"""

from __future__ import annotations

import io
import pathlib
import re
import sys
import tempfile
import unittest

import render_slot_sudoers as rss

# The rule line's shape: user, host/runas spec, NOPASSWD, the wrapper path,
# then a literal invocation with no glob character anywhere in it.
RULE_PATTERN = re.compile(
    r"\A"
    + re.escape(f"{rss.BROKER_USER} ALL=(root) NOPASSWD: {rss.WRAPPER_PATH} ")
    + r"(?P<invocation>[a-zA-Z0-9 ]+)\Z"
)


class SlotInvocationsTests(unittest.TestCase):
    def test_five_invocations_per_slot_in_stable_order(self):
        self.assertEqual(
            rss.slot_invocations("3"),
            ["3 reset", "3 a start", "3 a stop", "3 b start", "3 b stop"],
        )

    def test_reset_carries_no_colour(self):
        for invocation in rss.slot_invocations("0"):
            if invocation.endswith("reset"):
                self.assertEqual(invocation, "0 reset")

    def test_every_slot_name_is_a_plain_digit_string(self):
        # The wrapper's first argument is matched literally by sudoers, so a
        # slot name carrying a space or shell metacharacter would either
        # break the enumeration or smuggle a second field into one line.
        for slot in rss.SLOT_NAMES:
            self.assertRegex(slot, r"\A[0-9]+\Z")


class AllInvocationsTests(unittest.TestCase):
    def test_seven_slots_times_five_invocations_is_thirty_five(self):
        self.assertEqual(len(rss.SLOT_NAMES), 7)
        self.assertEqual(len(rss.all_invocations()), 35)

    def test_every_invocation_is_unique(self):
        invocations = rss.all_invocations()
        self.assertEqual(len(invocations), len(set(invocations)))

    def test_scales_with_a_smaller_slot_table(self):
        # Proves the enumeration is derived from the table rather than a
        # hardcoded count of thirty-five: three slots must yield fifteen.
        self.assertEqual(len(rss.all_invocations(("0", "1", "2"))), 15)

    def test_scales_with_a_larger_slot_table(self):
        self.assertEqual(len(rss.all_invocations(tuple(str(n) for n in range(9)))), 45)


class RenderTests(unittest.TestCase):
    def test_exactly_thirty_five_rule_lines(self):
        rule_lines = [
            line for line in rss.render().splitlines() if line.startswith(rss.BROKER_USER + " ")
        ]
        self.assertEqual(len(rule_lines), 35)

    def test_no_wildcard_anywhere_in_the_file(self):
        self.assertNotIn("*", rss.render())

    def test_no_ALL_in_any_commands_argument_list(self):
        # ALL is expected and correct as the host spec and the runas spec --
        # "broker ALL=(root)" -- but must never appear inside the invocation
        # itself, which is the part a caller's argument reaches.
        for match in RULE_PATTERN.finditer(rss.render()):
            self.assertNotIn("ALL", match.group("invocation"))

    def test_every_rule_line_matches_the_enumerated_shape(self):
        rule_lines = [
            line for line in rss.render().splitlines() if line.startswith(rss.BROKER_USER + " ")
        ]
        for line in rule_lines:
            self.assertRegex(line, RULE_PATTERN)

    def test_rule_lines_are_exactly_the_slot_tables_invocations(self):
        rule_lines = [
            line for line in rss.render().splitlines() if line.startswith(rss.BROKER_USER + " ")
        ]
        expected = {
            f"{rss.BROKER_USER} ALL=(root) NOPASSWD: {rss.WRAPPER_PATH} {invocation}"
            for invocation in rss.all_invocations()
        }
        self.assertEqual(set(rule_lines), expected)
        self.assertEqual(len(rule_lines), len(expected))

    def test_render_is_deterministic(self):
        self.assertEqual(rss.render(), rss.render())

    def test_header_comment_never_edit_by_hand(self):
        self.assertIn("do not edit by hand", rss.render())

    def test_file_ends_with_a_single_trailing_newline(self):
        content = rss.render()
        self.assertTrue(content.endswith("\n"))
        self.assertFalse(content.endswith("\n\n"))


class MainTests(unittest.TestCase):
    def test_main_writes_the_rendered_content_to_stdout_by_default(self):
        original_stdout = sys.stdout
        sys.stdout = io.StringIO()
        try:
            exit_code = rss.main([])
            self.assertEqual(exit_code, 0)
            self.assertEqual(sys.stdout.getvalue(), rss.render())
        finally:
            sys.stdout = original_stdout

    def test_main_writes_to_the_out_file_when_given(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = pathlib.Path(tmp) / "generated-sudoers"
            exit_code = rss.main(["--out", str(out_path)])
            self.assertEqual(exit_code, 0)
            self.assertEqual(out_path.read_text(), rss.render())


if __name__ == "__main__":
    unittest.main()
