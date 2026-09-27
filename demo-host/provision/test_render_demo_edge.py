#!/usr/bin/env python3
"""Unit tests for render_demo_edge.

Mirrors `test_render_slot_sudoers.py`'s own approach: the expected text is
reconstructed independently of `render()`'s own loop, so a bug in assembly
(a dropped slot, a swapped port, a missing directive) shows up as a
mismatch rather than being reproduced on both sides.
"""

from __future__ import annotations

import pathlib
import re
import tempfile
import unittest

import render_demo_edge as rde


def _expected_snippet(slot: str) -> str:
    a_port = rde.APP_PORT_BASE + int(slot) * 2
    b_port = a_port + 1
    health_port = rde.HEALTH_PORT_BASE + int(slot)
    return "\n".join(
        [
            f"(slot{slot}-upstream) {{",
            f"\treverse_proxy 127.0.0.1:{a_port} 127.0.0.1:{b_port} {{",
            "\t\tlb_policy first",
            "\t\thealth_uri /healthz",
            f"\t\thealth_port {health_port}",
            "\t\thealth_interval 2s",
            "\t\thealth_headers {",
            "\t\t\tX-Colour-Upstream {http.reverse_proxy.active.target_upstream}",
            "\t\t}",
            "\t}",
            "}",
        ]
    )


def _expected_full_text(slots=rde.SLOT_NAMES) -> str:
    lines = list(rde.HEADER_COMMENT_LINES) + ["{", "\tadmin off", "}", ""]
    for slot in slots:
        lines.append(_expected_snippet(slot))
        lines.append("")
    return "\n".join(lines).rstrip("\n") + "\n"


class PortArithmeticTests(unittest.TestCase):
    def test_slot_app_port_matches_slotPorts_ts_formula(self):
        # appPortBase + slot*2 (+1 for "b") -- services/broker/src/slotPorts.ts.
        self.assertEqual(rde.slot_app_port("0", "a"), 9300)
        self.assertEqual(rde.slot_app_port("0", "b"), 9301)
        self.assertEqual(rde.slot_app_port("3", "a"), 9306)
        self.assertEqual(rde.slot_app_port("3", "b"), 9307)

    def test_slot_health_port_matches_slotPorts_ts_formula(self):
        self.assertEqual(rde.slot_health_port("0"), 9100)
        self.assertEqual(rde.slot_health_port("6"), 9106)

    def test_slot_app_port_rejects_a_colour_outside_the_closed_set(self):
        with self.assertRaises(ValueError):
            rde.slot_app_port("0", "c")

    def test_port_functions_reject_a_non_digit_slot_name(self):
        with self.assertRaises(rde.InvalidSlotName):
            rde.slot_app_port("0 *", "a")
        with self.assertRaises(rde.InvalidSlotName):
            rde.slot_health_port("")


class SnippetNameTests(unittest.TestCase):
    def test_snippet_name_is_stable_and_slot_specific(self):
        self.assertEqual(rde.snippet_name("0"), "slot0-upstream")
        self.assertEqual(rde.snippet_name("6"), "slot6-upstream")

    def test_every_slot_has_a_distinct_snippet_name(self):
        names = [rde.snippet_name(s) for s in rde.SLOT_NAMES]
        self.assertEqual(len(names), len(set(names)))


class RenderSlotSnippetTests(unittest.TestCase):
    def test_one_slot_matches_the_independently_built_expectation(self):
        self.assertEqual(rde.render_slot_snippet("2"), _expected_snippet("2"))

    def test_carries_every_load_bearing_directive_literally(self):
        # Each pinned per LLD-4 §U3b/§08 -- a test that only checked
        # presence of *a* health_port, without the exact value, would pass
        # a swapped health_interval default (Caddy's own default is 30s)
        # or a renamed header just as easily.
        snippet = rde.render_slot_snippet("0")
        self.assertIn("lb_policy first", snippet)
        self.assertIn("health_uri /healthz", snippet)
        self.assertIn("health_interval 2s", snippet)
        self.assertIn("X-Colour-Upstream {http.reverse_proxy.active.target_upstream}", snippet)

    def test_rejects_a_bad_slot_name(self):
        with self.assertRaises(rde.InvalidSlotName):
            rde.render_slot_snippet("0; rm -rf /")


class RenderExactnessTests(unittest.TestCase):
    def test_render_output_equals_the_independently_built_expected_text(self):
        self.assertEqual(rde.render(), _expected_full_text())

    def test_admin_off_appears_exactly_once_in_a_global_options_block(self):
        content = rde.render()
        self.assertEqual(content.count("admin off"), 1)
        # It is the *global* options block -- address-less, at the top,
        # never inside a per-slot named snippet.
        self.assertNotIn("(slot0-upstream) {\n\tadmin off", content)

    def test_seven_slots_produce_seven_distinct_snippets(self):
        content = rde.render()
        names = re.findall(r"\(slot(\d+)-upstream\)", content)
        self.assertEqual(len(names), 7)
        self.assertEqual(len(set(names)), 7)

    def test_no_two_slots_share_an_app_port_or_health_port(self):
        app_ports = []
        health_ports = []
        for slot in rde.SLOT_NAMES:
            app_ports.append(rde.slot_app_port(slot, "a"))
            app_ports.append(rde.slot_app_port(slot, "b"))
            health_ports.append(rde.slot_health_port(slot))
        self.assertEqual(len(app_ports), len(set(app_ports)))
        self.assertEqual(len(health_ports), len(set(health_ports)))

    def test_scales_with_a_smaller_slot_table(self):
        self.assertEqual(rde.render(("0", "1")), _expected_full_text(("0", "1")))

    def test_render_is_deterministic(self):
        self.assertEqual(rde.render(), rde.render())

    def test_file_ends_with_a_single_trailing_newline(self):
        content = rde.render()
        self.assertTrue(content.endswith("\n"))
        self.assertFalse(content.endswith("\n\n"))

    def test_every_snippet_braces_balance(self):
        content = rde.render()
        self.assertEqual(content.count("{"), content.count("}"))


class WriteGeneratedFileTests(unittest.TestCase):
    def test_writes_the_real_rendered_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "demo-edge.caddy"
            rde.write_generated_file(str(target), rde.render())
            self.assertEqual(target.read_text(), rde.render())

    def test_no_temp_file_left_behind_on_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "demo-edge.caddy"
            rde.write_generated_file(str(target), rde.render())
            leftovers = [p for p in pathlib.Path(tmp).iterdir() if p != target]
            self.assertEqual(leftovers, [])


class MainTests(unittest.TestCase):
    def test_main_writes_to_stdout_by_default(self):
        import io
        import sys

        original_stdout = sys.stdout
        sys.stdout = io.StringIO()
        try:
            exit_code = rde.main([])
            self.assertEqual(exit_code, 0)
            self.assertEqual(sys.stdout.getvalue(), rde.render())
        finally:
            sys.stdout = original_stdout

    def test_main_writes_via_out(self):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = pathlib.Path(tmp) / "generated-demo-edge.caddy"
            exit_code = rde.main(["--out", str(out_path)])
            self.assertEqual(exit_code, 0)
            self.assertEqual(out_path.read_text(), rde.render())


if __name__ == "__main__":
    unittest.main()
