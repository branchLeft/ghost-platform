#!/usr/bin/env python3
"""Unit tests for render_slot_sudoers.

The property that matters is exactness: the generated file must contain
precisely the enumerated invocations and nothing else -- no appended
`Defaults` line, no `@includedir`, no widened verb. A test that only checks
lines starting with the broker's name would let every one of those through
silently, so the tests here reconstruct the expected file independently
(`_expected_rule_lines` / `_expected_full_text`) rather than filtering
render()'s own output and trusting the filter.
"""

from __future__ import annotations

import io
import pathlib
import re
import stat
import sys
import tempfile
import unittest
from unittest import mock

import render_slot_sudoers as rss

# Matches one rule line's shape and captures the invocation. Used with
# `fullmatch` against a single line at a time -- `finditer` against the whole
# multi-line file would need `re.M` for `\A`/`\Z` to anchor per line, and
# without it silently matches nothing.
RULE_LINE_PATTERN = re.compile(
    re.escape(f"{rss.BROKER_USER} ALL=(root) NOPASSWD: {rss.WRAPPER_PATH} ")
    + r"(?P<invocation>[a-zA-Z0-9 ]+)"
)


def _expected_rule_lines() -> list[str]:
    """The 35 rule lines, reconstructed independently of render()'s own
    loop -- from the slot table and the fixed line shape only, so a bug in
    render()'s assembly (an appended line, a dropped slot, a duplicate)
    shows up as a mismatch rather than being reproduced on both sides.
    """
    lines = []
    for slot in rss.SLOT_NAMES:
        lines.append(f"{rss.BROKER_USER} ALL=(root) NOPASSWD: {rss.WRAPPER_PATH} {slot} reset")
        for colour in rss.COLOURS:
            for verb in rss.START_STOP_VERBS:
                lines.append(
                    f"{rss.BROKER_USER} ALL=(root) NOPASSWD: {rss.WRAPPER_PATH} "
                    f"{slot} {colour} {verb}"
                )
    return lines


def _expected_full_text() -> str:
    return "\n".join(list(rss.HEADER_COMMENT_LINES) + [""] + _expected_rule_lines() + [""])


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


class SlotNameValidationTests(unittest.TestCase):
    def test_slot_invocations_rejects_a_non_digit_slot_name(self):
        with self.assertRaises(rss.InvalidSlotName):
            rss.slot_invocations("0 *")

    def test_slot_invocations_rejects_an_empty_slot_name(self):
        with self.assertRaises(rss.InvalidSlotName):
            rss.slot_invocations("")

    def test_render_rejects_a_slot_table_carrying_a_wildcard(self):
        # A slot "name" that is actually an attempt to smuggle a wildcard
        # into the invocation.
        with self.assertRaises(rss.InvalidSlotName):
            rss.render(("0 *",))

    def test_all_invocations_rejects_a_bad_slot_name_even_mid_table(self):
        with self.assertRaises(rss.InvalidSlotName):
            rss.all_invocations(("0", "1", "not-a-slot"))


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


class RenderPinnedLiteralsTests(unittest.TestCase):
    """These two strings are hardcoded, not read from `rss.BROKER_USER` /
    `rss.WRAPPER_PATH` -- a test built from the same constant the generator
    reads moves with it, so it stays green even if that constant is changed
    to something wrong (`BROKER_USER = "ALL"` puts `ALL` in every rule's
    user field, so every local account matches, and no test deriving its
    expectation from `BROKER_USER` itself can see that).
    """

    def test_rendered_output_pins_the_literal_broker_account_and_wrapper_path(self):
        content = rss.render()
        self.assertIn(
            "broker ALL=(root) NOPASSWD: /usr/local/sbin/branchleft-slot 0 reset", content
        )
        self.assertIn(
            "broker ALL=(root) NOPASSWD: /usr/local/sbin/branchleft-slot 6 b stop", content
        )


class RenderExactnessTests(unittest.TestCase):
    def test_render_output_equals_the_independently_built_expected_text(self):
        self.assertEqual(rss.render(), _expected_full_text())

    def test_every_non_blank_line_is_an_enumerated_rule_or_a_hash_space_comment(self):
        expected_rules = set(_expected_rule_lines())
        for line in rss.render().splitlines():
            if line == "":
                continue
            self.assertTrue(
                line in expected_rules or line.startswith("# "),
                f"unexpected line in generated file, neither an enumerated rule "
                f"nor a '# ' comment: {line!r}",
            )

    def test_exactly_thirty_five_rule_lines(self):
        matched = sum(1 for line in rss.render().splitlines() if line in set(_expected_rule_lines()))
        self.assertEqual(matched, 35)


class RenderTests(unittest.TestCase):
    def test_no_wildcard_anywhere_in_the_file(self):
        self.assertNotIn("*", rss.render())

    def test_no_ALL_in_any_commands_argument_list(self):
        # ALL is expected and correct as the host spec and the runas spec --
        # "broker ALL=(root)" -- but must never appear inside the invocation
        # itself, which is the part a caller's argument reaches. Matched
        # per line with `fullmatch`, and the match count is asserted so an
        # empty loop cannot pass silently.
        matched = 0
        for line in rss.render().splitlines():
            match = RULE_LINE_PATTERN.fullmatch(line)
            if match is None:
                continue
            matched += 1
            self.assertNotIn("ALL", match.group("invocation"))
        self.assertEqual(matched, 35, "the matcher itself matched nothing -- see test docstring")

    def test_render_is_deterministic(self):
        self.assertEqual(rss.render(), rss.render())

    def test_header_never_claims_an_installation_mechanism(self):
        # The generator has no way to know how or whether it will be
        # installed -- that mechanism does not exist yet -- so the header
        # must not assert one. Regression guard for a claim like "cloud-init
        # regenerates this" or "a hand edit is overwritten".
        content = rss.render()
        self.assertNotIn("cloud-init", content)
        self.assertNotIn("overwritten", content)

    def test_file_ends_with_a_single_trailing_newline(self):
        content = rss.render()
        self.assertTrue(content.endswith("\n"))
        self.assertFalse(content.endswith("\n\n"))


class WriteGeneratedFileTests(unittest.TestCase):
    def test_writes_the_real_rendered_file_at_mode_0440(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "branchleft-slot"
            rss.write_generated_file(str(target), rss.render())
            self.assertEqual(target.read_text(), rss.render())
            mode = stat.S_IMODE(target.stat().st_mode)
            self.assertEqual(mode, 0o440)

    def test_no_temp_file_left_behind_on_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "branchleft-slot"
            rss.write_generated_file(str(target), rss.render())
            leftovers = [p for p in pathlib.Path(tmp).iterdir() if p != target]
            self.assertEqual(leftovers, [])

    def test_invalid_content_is_rejected_and_target_is_left_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "branchleft-slot"
            with self.assertRaises(RuntimeError):
                # An unterminated quote is invalid sudoers syntax.
                rss.write_generated_file(str(target), 'broker ALL=(root) NOPASSWD: "unterminated\n')
            self.assertFalse(target.exists())

    def test_no_temp_file_left_behind_on_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "branchleft-slot"
            with self.assertRaises(RuntimeError):
                rss.write_generated_file(str(target), 'broker ALL=(root) NOPASSWD: "unterminated\n')
            self.assertEqual(list(pathlib.Path(tmp).iterdir()), [])

    def test_raises_a_clear_error_when_visudo_is_not_on_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "branchleft-slot"
            with mock.patch(
                "render_slot_sudoers.subprocess.run", side_effect=FileNotFoundError()
            ):
                with self.assertRaises(RuntimeError):
                    rss.write_generated_file(str(target), rss.render())
            self.assertFalse(target.exists())
            self.assertEqual(list(pathlib.Path(tmp).iterdir()), [])

    def test_a_prior_file_at_the_target_is_left_untouched_on_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "branchleft-slot"
            target.write_text("previous good content\n")
            with self.assertRaises(RuntimeError):
                rss.write_generated_file(str(target), 'broker ALL=(root) NOPASSWD: "unterminated\n')
            self.assertEqual(target.read_text(), "previous good content\n")


class InstallGeneratedFileTests(unittest.TestCase):
    """`install_generated_file` is `write_generated_file` plus `chown
    root:root` -- a property review named directly: `write_generated_file`
    sets mode 0440 but not ownership, and sudo ignores a sudoers.d file it
    is set on either count.
    """

    def test_chowns_the_written_file_to_root_root(self):
        # `os.chown` needs real root to succeed against a real file, which a
        # test process is not guaranteed to be -- so the call itself is
        # mocked and its arguments asserted, rather than skipped outright.
        # `test_render_slot_sudoers_ci.yml`'s container job is what proves
        # this against a real root chown; this test proves the call happens
        # at all and with the right arguments.
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "branchleft-slot"
            with mock.patch("render_slot_sudoers.os.chown") as chown:
                rss.install_generated_file(str(target), rss.render())
            chown.assert_called_once_with(str(target), 0, 0)
            self.assertEqual(target.read_text(), rss.render())

    def test_chown_failure_propagates_rather_than_being_swallowed(self):
        # A caller that cannot set root:root has not installed a working
        # boundary -- silently accepting a chown failure would leave a file
        # sudo ignores while reporting success.
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "branchleft-slot"
            with mock.patch(
                "render_slot_sudoers.os.chown", side_effect=PermissionError("not root")
            ):
                with self.assertRaises(PermissionError):
                    rss.install_generated_file(str(target), rss.render())
            # write_generated_file's own atomicity still held: the file it
            # wrote is there even though the chown after it failed.
            self.assertEqual(target.read_text(), rss.render())

    def test_still_mode_0440_after_install(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "branchleft-slot"
            with mock.patch("render_slot_sudoers.os.chown"):
                rss.install_generated_file(str(target), rss.render())
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o440)


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

    def test_main_writes_via_out_using_the_same_safe_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = pathlib.Path(tmp) / "generated-sudoers"
            exit_code = rss.main(["--out", str(out_path)])
            self.assertEqual(exit_code, 0)
            self.assertEqual(out_path.read_text(), rss.render())
            self.assertEqual(stat.S_IMODE(out_path.stat().st_mode), 0o440)

    def test_main_installs_via_install_and_chowns_root_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = pathlib.Path(tmp) / "generated-sudoers"
            with mock.patch("render_slot_sudoers.os.chown") as chown:
                exit_code = rss.main(["--install", str(out_path)])
            self.assertEqual(exit_code, 0)
            self.assertEqual(out_path.read_text(), rss.render())
            self.assertEqual(stat.S_IMODE(out_path.stat().st_mode), 0o440)
            chown.assert_called_once_with(str(out_path), 0, 0)

    def test_out_and_install_are_mutually_exclusive(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(pathlib.Path(tmp) / "generated-sudoers")
            with self.assertRaises(SystemExit):
                rss.main(["--out", path, "--install", path])


if __name__ == "__main__":
    unittest.main()
