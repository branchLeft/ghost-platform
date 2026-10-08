#!/usr/bin/env python3
"""Unit tests for render_demo_site.

Each gate has a test that names it, so a sabotage of one directive turns
exactly that test red (see render_demo_site.md, "Sabotage").
"""

from __future__ import annotations

import copy
import json
import pathlib
import unittest

import render_demo_edge as rde
import render_demo_site as rds

GOLDEN = pathlib.Path(__file__).parents[2] / "render-core" / "test" / "golden" / "demo.edge.json"
EDGE = json.loads(GOLDEN.read_text(encoding="utf-8"))


def block(**overrides):
    edge = copy.deepcopy(EDGE)
    edge.update(overrides)
    return rds.render_site_block("0", edge)


class GateTests(unittest.TestCase):
    def test_every_path_is_behind_forward_auth(self):
        text = block()
        # Only two handlers exist: the gate's own login, and the catch-all
        # that begins with forward_auth. No path matcher can sit in front of
        # the catch-all, so /ghost/* cannot be exempted.
        handles = [line.strip() for line in text.splitlines() if line.strip().startswith("handle")]
        self.assertEqual(handles, ["handle /__gate/login {", "handle {"])
        catch_all = text.split("\thandle {\n", 1)[1]
        self.assertLess(catch_all.index("forward_auth"), catch_all.index("import slot0-upstream"))
        self.assertLess(catch_all.index("forward_auth"), catch_all.index("respond"))

    def test_only_the_login_path_skips_forward_auth(self):
        login = block().split("handle /__gate/login {", 1)[1].split("}", 1)[0]
        self.assertNotIn("forward_auth", login)
        self.assertNotIn("slot0-upstream", login)

    def test_gate_verify_uri(self):
        self.assertIn("uri /__gate/verify", block())

    def test_a_non_passphrase_gate_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            block(gate={"kind": "none"})

    def test_an_admitted_hostname_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            block(admittedHostname="x.demo.example.test")


class MembersUploadTests(unittest.TestCase):
    def test_post_to_members_upload_is_refused(self):
        text = block()
        self.assertIn("method POST", text)
        self.assertIn("path /ghost/api/admin/members/upload/", text)
        self.assertIn("respond @membersImport 403", text)

    def test_get_is_not_matched(self):
        text = block()
        self.assertNotIn("method GET", text)
        matcher = text.split("@membersImport {", 1)[1].split("}", 1)[0]
        self.assertEqual(matcher.split(), ["method", "POST", "path", "/ghost/api/admin/members/upload/"])


class HeaderTests(unittest.TestCase):
    def test_noindex_on_the_site(self):
        self.assertIn('>X-Robots-Tag "noindex, nofollow"', block())

    def test_report_only_policy_uses_the_report_only_header(self):
        text = block()
        self.assertIn('>Content-Security-Policy-Report-Only "', text)
        self.assertNotIn('>Content-Security-Policy "', text)

    def test_enforcing_policy_uses_the_enforcing_header(self):
        text = block(contentSecurityPolicyMode="enforcing")
        self.assertIn('\t\t>Content-Security-Policy "default-src', text)
        self.assertNotIn("Report-Only", text)

    def test_policy_text_is_carried_verbatim(self):
        self.assertIn(EDGE["contentSecurityPolicy"], block())

    def test_policy_with_a_quote_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            block(contentSecurityPolicy='default-src "x"')

    def test_body_limit_is_carried(self):
        self.assertIn("max_size 64MiB", block())


class HealthTests(unittest.TestCase):
    def test_site_imports_its_slots_own_two_colour_snippet(self):
        text = rds.render_caddyfile([("2", EDGE)])
        self.assertIn("import slot2-upstream", text)
        self.assertIn("(slot2-upstream) {", text)
        self.assertIn("lb_policy first", text)
        self.assertIn("health_headers {", text)
        self.assertIn("X-Colour-Upstream {http.reverse_proxy.active.target_upstream}", text)

    def test_every_import_resolves_to_a_defined_snippet(self):
        text = rds.render_caddyfile([("0", EDGE)])
        self.assertIn("(slot0-upstream) {", text)

    def test_admin_api_is_off(self):
        self.assertIn("\tadmin off\n", rds.render_caddyfile([("0", EDGE)]))


class InputTests(unittest.TestCase):
    def test_hostname_with_a_brace_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            block(displayHostname="a.example.test {\n respond 200")

    def test_duplicate_host_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            rds.render_caddyfile([("0", EDGE), ("1", EDGE)])

    def test_unknown_slot_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            rds.render_caddyfile([("9", EDGE)])

    def test_tls_directive_must_be_one_directive(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            rds.render_site_block("0", EDGE, "tls internal\n\trespond 200")


if __name__ == "__main__":
    unittest.main()
