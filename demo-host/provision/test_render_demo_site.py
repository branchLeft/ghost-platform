#!/usr/bin/env python3
"""Unit tests for render_demo_site.

Each gate has a test that names it, so a sabotage of one directive turns
exactly that test red (see render_demo_site.md, "Sabotage").
"""

from __future__ import annotations

import copy
import ipaddress
import json
import pathlib
import re
import tempfile
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
    # Every spelling Ghost 6.55.0 routes to the members import handler:
    # `legacy-api-path-match.js` accepts v2|v3|v4|canary before admin, and
    # express does not require the trailing slash.
    GHOST_SPELLINGS = (
        "/ghost/api/admin/members/upload/",
        "/ghost/api/admin/members/upload",
        "/ghost/api/v4/admin/members/upload/",
        "/ghost/api/v4/admin/members/upload",
        "/ghost/api/canary/admin/members/upload/",
        "/ghost/api/canary/admin/members/upload",
        "/ghost/api/v2/admin/members/upload/",
        "/ghost/api/v3/admin/members/upload",
        "/ghost/api/Admin/Members/Upload",
    )
    NOT_THE_IMPORT = (
        "/ghost/api/admin/members/",
        "/ghost/api/admin/members/upload/x",
        "/ghost/api/admin/members/uploads/",
        "/ghost/api/admin/posts/",
        "/members/upload/",
    )

    def test_post_is_refused_by_both_matchers(self):
        text = block()
        self.assertEqual(text.count("method POST"), 2)
        self.assertIn("respond @membersImportByPath 403", text)
        self.assertIn("respond @membersImportByPattern 403", text)

    def test_the_pattern_matches_every_ghost_spelling(self):
        pattern = re.compile(rds.MEMBERS_UPLOAD_PATH_REGEXP)
        for path in self.GHOST_SPELLINGS:
            with self.subTest(path=path):
                self.assertIsNotNone(pattern.match(path))

    def test_the_pattern_leaves_other_paths_alone(self):
        pattern = re.compile(rds.MEMBERS_UPLOAD_PATH_REGEXP)
        for path in self.NOT_THE_IMPORT:
            with self.subTest(path=path):
                self.assertIsNone(pattern.match(path))

    def test_the_globs_cover_with_and_without_slash_and_any_version(self):
        globs = rds.MEMBERS_UPLOAD_PATH_GLOBS
        self.assertIn("/ghost/api/admin/members/upload", globs)
        self.assertIn("/ghost/api/admin/members/upload/", globs)
        self.assertIn("/ghost/api/*/admin/members/upload", globs)
        self.assertIn("/ghost/api/*/admin/members/upload/", globs)
        text = block()
        for glob in globs:
            self.assertIn(glob, text)

    def test_the_narrow_literal_alone_is_not_enough(self):
        # The original matcher; the review showed four spellings pass it.
        self.assertGreater(len(rds.MEMBERS_UPLOAD_PATH_GLOBS), 1)

    def test_get_is_not_matched(self):
        text = block()
        self.assertNotIn("method GET", text)
        self.assertNotIn("method HEAD", text)


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


class GateEnvironmentTests(unittest.TestCase):
    """The gate keys its attempt ceilings on the socket peer unless that peer
    is listed in GATE_TRUSTED_PROXIES, and behind the edge the peer is always
    the edge. An unset list pools every visitor into one bucket."""

    @staticmethod
    def environment() -> dict[str, str]:
        render = getattr(rds, "render_gate_environment", None)
        assert render is not None, "render_demo_site renders no gate environment"
        pairs = [
            line.split("=", 1)
            for line in render().splitlines()
            if line and not line.startswith("#")
        ]
        return {key: value for key, value in pairs}

    def test_trusted_proxies_is_exactly_the_edge_address(self):
        self.assertEqual(self.environment()["GATE_TRUSTED_PROXIES"], rde.DEMO_EDGE_ADDR)

    def test_trusted_proxies_is_one_host_never_a_range_or_a_list(self):
        value = self.environment()["GATE_TRUSTED_PROXIES"]
        self.assertNotIn(",", value)
        network = ipaddress.ip_network(value, strict=True)
        self.assertEqual(network.prefixlen, network.max_prefixlen)

    def test_the_gate_listens_where_the_site_block_dials_it(self):
        host, port = rds.GATE_UPSTREAM.rsplit(":", 1)
        environment = self.environment()
        self.assertEqual((environment["LISTEN_HOST"], environment["PORT"]), (host, port))
        self.assertIn(f"reverse_proxy {rds.GATE_UPSTREAM}", block())

    def test_the_trusted_address_is_the_one_the_edge_dials_upstreams_from(self):
        self.assertEqual(self.environment()["GATE_TRUSTED_PROXIES"], rds.GATE_UPSTREAM.rsplit(":", 1)[0])
        self.assertIn(f"reverse_proxy {rde.DEMO_EDGE_ADDR}:", rds.render_caddyfile([("0", EDGE)]))

    def test_main_writes_the_gate_environment_beside_the_caddyfile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            edge_json = root / "edge.json"
            edge_json.write_text(json.dumps(EDGE), encoding="utf-8")
            code = rds.main([
                "--slot", "0", "--edge-json", str(edge_json),
                "--out", str(root / "Caddyfile"), "--gate-env-out", str(root / "gate.env"),
            ])
            self.assertEqual(code, 0)
            self.assertEqual((root / "gate.env").read_text(encoding="utf-8"), rds.render_gate_environment())


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
