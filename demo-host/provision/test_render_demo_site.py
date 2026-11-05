#!/usr/bin/env python3
"""Unit tests for render_demo_site.

Each gate has a test that names it, so a sabotage of one directive turns
exactly that test red (see render_demo_site.md, "Sabotage").
"""

from __future__ import annotations

import contextlib
import copy
import io
import ipaddress
import json
import pathlib
import re
import tempfile
import unittest
from typing import Any

import render_demo_edge as rde
import render_demo_site as rds

GOLDEN = pathlib.Path(__file__).parents[2] / "render-core" / "test" / "golden" / "demo.edge.json"
EDGE = json.loads(GOLDEN.read_text(encoding="utf-8"))
BASE = "demo-domain.example.test"
SECOND_HOST = f"p4q-rowan-quiet.{BASE}"
LOCAL_TLS = "tls internal"
DNS_DIRECTIVE = "dns hetzner {file./etc/demo-edge/dns-token}"


def edge_for(host: str, **overrides: Any) -> dict[str, Any]:
    edge = copy.deepcopy(EDGE)
    edge["displayHostname"] = host
    edge.update(overrides)
    return edge


SECOND_EDGE = edge_for(SECOND_HOST)


def block(**overrides: Any) -> str:
    """Slot 0's matcher and handle, as the wildcard site carries them."""
    edge = copy.deepcopy(EDGE)
    edge.update(overrides)
    return "\n".join(rds.render_slot_handle("0", edge, BASE)) + "\n"


def caddyfile(
    sites: list[tuple[str, dict[str, Any]]] | None = None,
    tls: str | None = LOCAL_TLS,
    dns_directive: str | None = None,
) -> str:
    chosen = [("0", EDGE)] if sites is None else sites
    return rds.render_caddyfile(BASE, chosen, tls=tls, dns_directive=dns_directive)


def two_slots() -> str:
    return caddyfile([("0", EDGE), ("1", SECOND_EDGE)])


def slot_section(text: str, slot: str) -> list[str]:
    """The lines inside one slot's `handle @slotN { }`, up to its closing brace."""
    lines = text.splitlines()
    start = lines.index(f"\thandle @slot{slot} {{") + 1
    end = lines.index("\t}", start)
    return lines[start:end]


class GateTests(unittest.TestCase):
    def test_every_path_is_behind_forward_auth(self):
        text = two_slots()
        # The site's own handlers are one per slot matcher and the final
        # abort; inside each slot only two exist: the gate's own login, and
        # the catch-all that begins with forward_auth. No path matcher can
        # sit in front of the catch-all, so /ghost/* cannot be exempted.
        site_handles = [line.strip() for line in text.splitlines() if line.startswith("\thandle")]
        self.assertEqual(site_handles, ["handle @slot0 {", "handle @slot1 {", "handle {"])
        for slot in ("0", "1"):
            section = slot_section(text, slot)
            handles = [line.strip() for line in section if line.strip().startswith("handle")]
            self.assertEqual(handles, ["handle /__gate/login {", "handle {"])
            catch_all = "\n".join(section).split("\t\thandle {\n", 1)[1]
            self.assertLess(catch_all.index("forward_auth"), catch_all.index(f"import slot{slot}-upstream"))
            self.assertLess(catch_all.index("forward_auth"), catch_all.index("respond"))
        forward_auths = [line for line in text.splitlines() if line.strip().startswith("forward_auth ")]
        self.assertEqual(len(forward_auths), 2)

    def test_only_the_login_path_skips_forward_auth(self):
        login = block().split("handle /__gate/login {", 1)[1].split("}", 1)[0]
        self.assertNotIn("forward_auth", login)
        self.assertNotIn("slot0-upstream", login)

    def test_gate_verify_uri(self):
        self.assertIn("uri /__gate/verify", block())

    def test_a_non_passphrase_gate_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            block(gate={"kind": "none"})

    def test_an_admitted_hostname_is_still_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock) as raised:
            block(admittedHostname=f"x.{BASE}")
        self.assertIn("admitted hostname", str(raised.exception))


class WildcardSiteTests(unittest.TestCase):
    def test_two_slots_share_one_fragment_and_one_wildcard_site(self):
        text = two_slots()
        fragment = rde.render()
        self.assertTrue(text.startswith(fragment))
        self.assertEqual(text.count(fragment), 1)
        self.assertEqual(text.count(f"*.{BASE} {{\n"), 1)
        for slot, host in (("0", EDGE["displayHostname"]), ("1", SECOND_HOST)):
            with self.subTest(slot=slot):
                self.assertEqual(text.count(host), 1)
                self.assertIn(f"\t@slot{slot} host {host}\n\thandle @slot{slot} {{\n", text)
                self.assertEqual(text.count(f"import slot{slot}-upstream"), 1)
                self.assertIn(f"import slot{slot}-upstream", "\n".join(slot_section(text, slot)))

    def test_every_slot_carries_every_gate_directive(self):
        text = two_slots()
        for slot in ("0", "1"):
            section = "\n".join(slot_section(text, slot))
            with self.subTest(slot=slot):
                self.assertEqual(section.count("method POST"), 2)
                self.assertIn("respond @membersImportByPath 403", section)
                self.assertIn("respond @membersImportByPattern 403", section)
                self.assertIn('>X-Robots-Tag "noindex, nofollow"', section)
                self.assertIn(f'>Content-Security-Policy-Report-Only "{EDGE["contentSecurityPolicy"]}"', section)
                self.assertIn("max_size 64MiB", section)
                self.assertIn("uri /__gate/verify", section)

    def test_the_only_tls_directive_in_the_output_is_the_wildcard_block(self):
        for label, sources in (
            ("local CA", {"tls": LOCAL_TLS}),
            ("DNS challenge", {"tls": None, "dns_directive": DNS_DIRECTIVE}),
        ):
            with self.subTest(source=label):
                text = caddyfile([("0", EDGE), ("1", SECOND_EDGE)], **sources)
                lines = text.splitlines()
                tls_lines = [line for line in lines if line.strip().startswith("tls")]
                self.assertEqual(len(tls_lines), 1)
                self.assertTrue(lines[lines.index(f"*.{BASE} {{") + 1].startswith("\ttls"))
                sites = [line for line in lines if line.endswith(" {") and line[0] not in " \t(#"]
                self.assertEqual(sites, [f"*.{BASE} {{"])
                self.assertNotIn("https://", text)
                self.assertNotIn("http://", text)

    def test_a_name_under_the_wildcard_that_is_no_slot_is_aborted(self):
        text = two_slots()
        self.assertTrue(text.endswith("\thandle {\n\t\tabort\n\t}\n}\n"))
        self.assertEqual(text.count("abort"), 1)
        site_handles = [line.strip() for line in text.splitlines() if line.startswith("\thandle")]
        self.assertEqual(site_handles[-1], "handle {")
        self.assertTrue(all(handle.startswith("handle @slot") for handle in site_handles[:-1]))

    def test_the_dns_directive_goes_inside_the_wildcard_tls_block(self):
        text = caddyfile(tls=None, dns_directive=DNS_DIRECTIVE)
        self.assertIn(f"*.{BASE} {{\n\ttls {{\n\t\t{DNS_DIRECTIVE}\n\t}}\n\t@slot0 host", text)


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


class UploadGuardTests(unittest.TestCase):
    """A file a tenant uploads is served from the tenant's own origin,
    where `script-src 'self'` allows it to run. The edge refuses the ones a
    browser would run; the live proof is csp/gate (Chromium) and
    scripts/test-demo-edge.sh (real Caddy)."""

    # Written out here, not read from the module: a test that takes its list
    # from the code under test passes when an entry is dropped from it.
    PREFIXES = ("/content/files/", "/content/images/", "/content/media/")
    EXTENSIONS = (
        "js", "mjs", "cjs", "html", "htm", "shtml", "xhtml", "xht", "xml", "xsl", "xslt", "css", "svg", "svgz",
        "kml", "gpx",
    )

    def setUp(self) -> None:
        self.text = two_slots()
        self.pattern = re.compile(rds.UPLOAD_ACTIVE_PATH_REGEXP[len("(?i)"):], re.IGNORECASE)

    def test_the_guard_sits_after_forward_auth_and_before_the_upstream(self):
        for slot in ("0", "1"):
            with self.subTest(slot=slot):
                catch_all = "\n".join(slot_section(self.text, slot)).split("\t\thandle {\n", 1)[1]
                forward_auth = catch_all.index("forward_auth")
                upstream = catch_all.index(f"import slot{slot}-upstream")
                for directive in ("respond @activeUploadByPath 403", "respond @activeUploadByPattern 403"):
                    self.assertIn(directive, catch_all)
                    self.assertLess(forward_auth, catch_all.index(directive))
                    self.assertLess(catch_all.index(directive), upstream)

    def test_the_guard_in_the_site_is_the_guard_the_proof_imports(self):
        guard = [line.strip() for line in rds.render_upload_guard()]
        for slot in ("0", "1"):
            section = [line.strip() for line in slot_section(self.text, slot)]
            start = section.index(guard[0])
            self.assertEqual(section[start:start + len(guard)], guard)

    def test_every_prefix_and_extension_is_covered_by_the_glob_matchers(self):
        tokens = "\n".join(rds.render_upload_guard()).split()
        for prefix in self.PREFIXES:
            self.assertIn(f"{prefix}*", tokens)
        for extension in self.EXTENSIONS:
            self.assertIn(f"*.{extension}", tokens)

    def test_the_prefix_and_the_extension_are_separate_matchers(self):
        # Two `path` lines in one named matcher are an OR in Caddy (measured on
        # 2.11.4): the whole of /content/ would be refused, or every .js.
        guard = "\n".join(rds.render_upload_guard()) + "\n"
        path_lines = [line.strip() for line in guard.splitlines() if line.strip().startswith("path ")]
        self.assertEqual(len(path_lines), 2)
        prefix_line = next(line for line in path_lines if "/content/" in line)
        extension_line = next(line for line in path_lines if "*.js" in line)
        self.assertNotIn("*.", prefix_line)
        self.assertNotIn("/content/", extension_line)

    def test_the_pattern_matches_every_prefix_extension_case_and_depth(self):
        for prefix in self.PREFIXES:
            for extension in self.EXTENSIONS:
                for path in (
                    f"{prefix}x.{extension}",
                    f"{prefix}2026/11/x.{extension}",
                    f"{prefix}2026/11/X.{extension.upper()}",
                    f"{prefix}2026/11/x-abc123.{extension}",
                    f"/{prefix}x.{extension}",
                    f"{prefix}a//b/x.{extension}",
                    f"{prefix}x.{extension}/",
                ):
                    with self.subTest(path=path):
                        self.assertIsNotNone(self.pattern.match(path))

    def test_the_pattern_leaves_other_paths_alone(self):
        for path in (
            "/content/images/a.png", "/content/images/2026/11/a.webp", "/content/files/report.pdf",
            "/content/media/clip.mp4", "/content/files/x.jsx", "/content/files/js", "/content/files/x.js.png",
            "/ghost/assets/app.js", "/assets/built/main.css", "/x.js", "/content/other/x.js", "/content/x.js",
            "/members/api/member/", "/ghost/api/admin/files/upload/",
        ):
            with self.subTest(path=path):
                self.assertIsNone(self.pattern.match(path))

    def test_every_method_is_refused(self):
        self.assertNotIn("method", "\n".join(rds.render_upload_guard()))

    def test_each_matcher_is_followed_by_a_403(self):
        guard = "\n".join(rds.render_upload_guard())
        self.assertEqual(guard.count("respond @"), 2)
        self.assertIn("respond @activeUploadByPath 403", guard)
        self.assertIn("respond @activeUploadByPattern 403", guard)

    def test_nosniff_is_on_every_slot(self):
        for slot in ("0", "1"):
            self.assertIn('>X-Content-Type-Options "nosniff"', "\n".join(slot_section(self.text, slot)))

    def test_it_is_independent_of_the_policy_mode(self):
        for mode in ("enforcing", "report-only"):
            with self.subTest(mode=mode):
                self.assertIn("respond @activeUploadByPath 403", block(contentSecurityPolicyMode=mode))

    def test_the_guard_adds_no_handler(self):
        for slot in ("0", "1"):
            handles = [line.strip() for line in slot_section(self.text, slot) if line.strip().startswith("handle")]
            self.assertEqual(handles, ["handle /__gate/login {", "handle {"])

    def test_the_print_flag_prints_the_guard_alone(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = rds.main(["--print-upload-guard"])
        self.assertEqual(code, 0)
        self.assertEqual(out.getvalue(), "\n".join(rds.render_upload_guard()) + "\n")


class HeaderTests(unittest.TestCase):
    def test_noindex_on_the_site(self):
        self.assertIn('>X-Robots-Tag "noindex, nofollow"', block())

    def test_report_only_policy_uses_the_report_only_header(self):
        text = block()
        self.assertIn('>Content-Security-Policy-Report-Only "', text)
        self.assertNotIn('>Content-Security-Policy "', text)

    def test_enforcing_policy_uses_the_enforcing_header(self):
        text = block(contentSecurityPolicyMode="enforcing")
        self.assertIn('\t\t\t>Content-Security-Policy "default-src', text)
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
        text = caddyfile([("2", EDGE)])
        self.assertIn("import slot2-upstream", text)
        self.assertIn("(slot2-upstream) {", text)
        self.assertIn("lb_policy first", text)
        self.assertIn("health_headers {", text)
        self.assertIn("X-Colour-Upstream {http.reverse_proxy.active.target_upstream}", text)

    def test_every_import_resolves_to_a_defined_snippet(self):
        text = caddyfile([("0", EDGE)])
        self.assertIn("(slot0-upstream) {", text)

    def test_admin_api_is_off(self):
        self.assertIn("\tadmin off\n", caddyfile())


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
        self.assertEqual(self.environment().get("GATE_TRUSTED_PROXIES", ""), rde.DEMO_EDGE_ADDR)

    def test_trusted_proxies_is_one_host_never_a_range_or_a_list(self):
        value = self.environment().get("GATE_TRUSTED_PROXIES", "")
        self.assertNotEqual(value, "", "the trusted list is unset")
        self.assertNotIn(",", value)
        network = ipaddress.ip_network(value, strict=True)
        self.assertEqual(network.prefixlen, network.max_prefixlen)

    def test_the_gate_listens_where_the_site_block_dials_it(self):
        host, port = rds.GATE_UPSTREAM.rsplit(":", 1)
        environment = self.environment()
        self.assertEqual((environment.get("LISTEN_HOST", ""), environment.get("PORT", "")), (host, port))
        self.assertIn(f"reverse_proxy {rds.GATE_UPSTREAM}", block())

    def test_the_trusted_address_is_the_one_the_edge_dials_upstreams_from(self):
        trusted = self.environment().get("GATE_TRUSTED_PROXIES", "")
        self.assertEqual(trusted, rds.GATE_UPSTREAM.rsplit(":", 1)[0])
        self.assertIn(f"reverse_proxy {rde.DEMO_EDGE_ADDR}:", caddyfile())

    def test_main_writes_the_gate_environment_beside_the_caddyfile(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            edge_json = root / "edge.json"
            edge_json.write_text(json.dumps(EDGE), encoding="utf-8")
            code = rds.main([
                "--base", BASE, "--site", f"0={edge_json}", "--tls", LOCAL_TLS,
                "--out", str(root / "Caddyfile"), "--gate-env-out", str(root / "gate.env"),
            ])
            self.assertEqual(code, 0)
            self.assertEqual((root / "gate.env").read_text(encoding="utf-8"), rds.render_gate_environment())


class InputTests(unittest.TestCase):
    BAD_BASES = {
        "upper case": "Demo-Domain.example.test",
        "leading dot": f".{BASE}",
        "trailing dot": f"{BASE}.",
        "a wildcard already": f"*.{BASE}",
        "a brace": f"{BASE} {{",
        "a trailing newline": f"{BASE}\n",
        "a leading space": f" {BASE}",
        "a single label": "test",
        "an IP address": "127.0.0.1",
        "an underscore": "demo_domain.example.test",
        "empty": "",
        "an empty label": "demo-domain..example.test",
        "a leading hyphen": "-demo.example.test",
        "a numeric top label": "example.123",
    }
    NOT_ONE_LABEL_BELOW = {
        "two labels below": f"a.b.{BASE}",
        "the base itself": BASE,
        "a sibling domain": "k7m-vale-bright.example.test",
        "another domain": "k7m-vale-bright.other.example.test",
        "the base as a label suffix": f"k7m.{BASE}.example.test",
        "a label glued onto the base": f"k7m{BASE}",
    }

    def test_base_must_be_a_plain_lower_case_domain(self):
        for reason, base in self.BAD_BASES.items():
            with self.subTest(base=reason):
                with self.assertRaises(rds.InvalidBaseDomain):
                    rds.render_caddyfile(
                        base, [("0", edge_for(f"k7m-vale-bright.{base}"))], tls=LOCAL_TLS)

    def test_a_slot_host_must_be_exactly_one_label_below_the_base(self):
        for reason, host in self.NOT_ONE_LABEL_BELOW.items():
            with self.subTest(host=reason):
                with self.assertRaises(rds.HostOutsideWildcard):
                    caddyfile([("0", edge_for(host))])

    def test_a_host_used_by_two_slots_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock) as raised:
            caddyfile([("0", EDGE), ("1", EDGE)])
        self.assertIn("appears twice", str(raised.exception))

    def test_a_slot_used_twice_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock) as raised:
            caddyfile([("0", EDGE), ("0", SECOND_EDGE)])
        self.assertIn("slot 0 appears twice", str(raised.exception))

    def test_hostname_with_a_brace_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            block(displayHostname=f"a.{BASE} {{\n respond 200")

    def test_a_hostname_that_is_not_text_is_refused_with_a_named_error(self):
        for host in (None, ["a"], 7):
            with self.subTest(host=host):
                with self.assertRaises(rds.InvalidEdgeBlock):
                    caddyfile([("0", edge_for(host))])

    def test_unknown_slot_is_refused(self):
        with self.assertRaises(rds.InvalidEdgeBlock):
            caddyfile([("9", EDGE)])


class TlsSourceTests(unittest.TestCase):
    REFUSED_DNS_DIRECTIVES = {
        "a newline and a second line": f"{DNS_DIRECTIVE}\n\trespond 200",
        "a trailing newline": f"{DNS_DIRECTIVE}\n",
        "a leading newline": f"\n{DNS_DIRECTIVE}",
        "a carriage return": f"{DNS_DIRECTIVE}\r",
        "a newline that closes the tls block": f"{DNS_DIRECTIVE}\n\t}}\n\trespond 200\n\ttls {{",
        "an extra closing brace": f"{DNS_DIRECTIVE}}}",
        "an extra opening brace": "dns hetzner {{file./etc/demo-edge/dns-token}",
        "a second directive on the line": f"{DNS_DIRECTIVE} dns other {{env.OTHER_TOKEN}}",
        "a second argument": f"{DNS_DIRECTIVE} {{env.OTHER_TOKEN}}",
        "a semicolon then a directive": f"{DNS_DIRECTIVE}; respond 200",
        "the block form": "dns hetzner {\n\tapi_token x\n}",
        "a literal token": "dns hetzner literal-token-value",
        "no argument": "dns hetzner",
        "a relative file path": "dns hetzner {file.dns-token}",
        "an empty file path": "dns hetzner {file.}",
        "a directory path": "dns hetzner {file./etc/demo-edge/}",
        "a doubled slash": "dns hetzner {file.//etc/dns-token}",
        "a space in the path": "dns hetzner {file./etc/dns token}",
        "a non-ASCII path": "dns hetzner {file./etc/dns-t\uff4fken}",
        "an empty env name": "dns hetzner {env.}",
        "a dotted env name": "dns hetzner {env.A.B}",
        "a default value": "dns hetzner {env.NAME:-fallback}",
        "another placeholder": "dns hetzner {http.request.uri}",
        "an upper case provider": "dns Hetzner {env.DNS_API_TOKEN}",
        "a tab separator": "dns\thetzner {env.DNS_API_TOKEN}",
        "a different directive": "tls internal",
        "empty": "",
    }
    ACCEPTED_DNS_DIRECTIVES = (
        DNS_DIRECTIVE,
        "dns hetzner {env.DNS_API_TOKEN}",
        "dns hetzner {file./run/demo-edge/dns_token-1.txt}",
        "dns hetzner {file./etc/a..b/token}",
    )
    DOT_SEGMENT_PATHS = (
        "/etc/../dns-token",
        "/..",
        "/etc/..",
        "/../dns-token",
        "/./dns-token",
        "/etc/.",
        "/etc/./dns-token",
    )

    def test_neither_tls_source_is_refused(self):
        with self.assertRaises(rds.InvalidTlsSource) as raised:
            rds.render_caddyfile(BASE, [("0", EDGE)])
        self.assertIn("no default", str(raised.exception))
        with self.assertRaises(rds.InvalidTlsSource):
            caddyfile(tls=None, dns_directive=None)

    def test_both_tls_sources_are_refused(self):
        with self.assertRaises(rds.InvalidTlsSource):
            caddyfile(tls=LOCAL_TLS, dns_directive=DNS_DIRECTIVE)

    def test_a_dns_directive_with_a_newline_brace_or_second_directive_is_refused(self):
        for reason, directive in self.REFUSED_DNS_DIRECTIVES.items():
            with self.subTest(directive=reason):
                with self.assertRaises(rds.InvalidDnsDirective):
                    caddyfile(tls=None, dns_directive=directive)

    def test_a_dns_directive_path_with_dot_dot_is_refused(self):
        for path in self.DOT_SEGMENT_PATHS:
            with self.subTest(path=path):
                with self.assertRaises(rds.InvalidDnsDirective):
                    caddyfile(tls=None, dns_directive=f"dns hetzner {{file.{path}}}")

    def test_a_dns_directive_with_one_placeholder_is_accepted(self):
        for directive in self.ACCEPTED_DNS_DIRECTIVES:
            with self.subTest(directive=directive):
                self.assertIn(f"\ttls {{\n\t\t{directive}\n\t}}\n", caddyfile(tls=None, dns_directive=directive))

    def test_a_refused_dns_directive_is_never_echoed(self):
        # A literal token is the secret this pattern exists to keep out of the file.
        with self.assertRaises(rds.InvalidDnsDirective) as raised:
            caddyfile(tls=None, dns_directive="dns hetzner SECRET-LOOKING-VALUE")
        self.assertNotIn("SECRET-LOOKING-VALUE", str(raised.exception))
        self.assertNotIn("SECRET-LOOKING-VALUE", repr(raised.exception))

    def test_the_dns_directive_is_not_accepted_by_the_tls_option(self):
        with self.assertRaises(rds.InvalidTlsSource):
            caddyfile(tls=DNS_DIRECTIVE, dns_directive=None)

    def test_tls_directive_must_be_one_directive(self):
        with self.assertRaises(rds.InvalidTlsSource):
            caddyfile(tls="tls internal\n\trespond 200")


class CommandLineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = pathlib.Path(self.directory.name)
        self.first = self.root / "edge0.json"
        self.second = self.root / "edge1.json"
        self.first.write_text(json.dumps(EDGE), encoding="utf-8")
        self.second.write_text(json.dumps(SECOND_EDGE), encoding="utf-8")
        self.out = self.root / "Caddyfile"

    def test_main_renders_every_site_in_one_file(self):
        code = rds.main([
            "--base", BASE, "--site", f"0={self.first}", "--site", f"1={self.second}",
            "--dns-directive", DNS_DIRECTIVE, "--out", str(self.out),
        ])
        self.assertEqual(code, 0)
        expected = caddyfile([("0", EDGE), ("1", SECOND_EDGE)], tls=None, dns_directive=DNS_DIRECTIVE)
        self.assertEqual(self.out.read_text(encoding="utf-8"), expected)

    def test_main_without_a_tls_source_writes_nothing(self):
        with self.assertRaises(rds.InvalidTlsSource):
            rds.main(["--base", BASE, "--site", f"0={self.first}", "--out", str(self.out)])
        self.assertFalse(self.out.exists())

    def test_main_refuses_a_site_without_a_slot_and_a_file(self):
        for site in ("0", "=file.json", "0="):
            with self.subTest(site=site):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    rds.main(["--base", BASE, "--site", site, "--tls", LOCAL_TLS])
                self.assertEqual(raised.exception.code, 2)

    def test_main_requires_a_base_and_a_site(self):
        for argv in (["--site", f"0={self.first}", "--tls", LOCAL_TLS], ["--base", BASE, "--tls", LOCAL_TLS]):
            with self.subTest(argv=argv[0]):
                with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as raised:
                    rds.main(argv)
                self.assertEqual(raised.exception.code, 2)


if __name__ == "__main__":
    unittest.main()
