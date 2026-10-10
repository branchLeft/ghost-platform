#!/usr/bin/env python3
"""Render a demo slot's gated site block, and the whole demo Caddyfile.

Usage: render_demo_site.py --slot N --edge-json FILE [--tls DIRECTIVE] [--out FILE]
                           [--gate-env-out FILE]

`--edge-json` is the JSON of render-core's `EdgeSiteBlock` (the shape of
`render-core/test/golden/demo.edge.json`). See render_demo_site.md for what
the block guarantees and why each directive sits where it does.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from typing import Any, Mapping, Sequence

import render_demo_edge as rde
from render_slot_sudoers import SLOT_NAMES

# The gate service (services/demo-gate) listens here, reachable from this
# edge only (the host firewall opens 80 and 443 and nothing else). The edge
# shares the host network namespace, so it dials the gate from its own
# address: that one address is what the gate must trust (render_gate_environment).
GATE_PORT = 8080
GATE_UPSTREAM = f"{rde.DEMO_EDGE_ADDR}:{GATE_PORT}"
GATE_VERIFY_URI = "/__gate/verify"
GATE_LOGIN_PATH = "/__gate/login"

# Why the members-import refusal is not one literal path: render_demo_site.md.
MEMBERS_UPLOAD_PATH = "/ghost/api/admin/members/upload/"
# Caddy's `path` matcher cleans and unescapes, and is case-insensitive; a `*`
# spans any segment(s), so an unknown version prefix is still caught (it only
# ever over-refuses a POST, which is the safe direction).
MEMBERS_UPLOAD_PATH_GLOBS = (
    "/ghost/api/admin/members/upload",
    "/ghost/api/admin/members/upload/",
    "/ghost/api/*/admin/members/upload",
    "/ghost/api/*/admin/members/upload/",
)
MEMBERS_UPLOAD_PATH_REGEXP = r"(?i)^/ghost/api/(?:(?:v[0-9]+|canary)/)?admin/members/upload/?$"

NOINDEX = "noindex, nofollow"

HOSTNAME_PATTERN = re.compile(r"\A[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+\Z")
BODY_SIZE_PATTERN = re.compile(r"\A[0-9]{1,6}(KiB|MiB|GiB|KB|MB|GB)?\Z")
# Characters a header value may carry into a quoted Caddyfile string.
CSP_FORBIDDEN = re.compile(r'["\\\r\n{}`]')
# Local-CA proofs pass `tls internal`; production passes the wildcard
# certificate directive. Anything with a newline or brace is not one directive.
TLS_PATTERN = re.compile(r"\Atls [A-Za-z0-9 ./_:-]+\Z")


class InvalidEdgeBlock(ValueError):
    """Raised for an edge block this renderer refuses to turn into config."""


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise InvalidEdgeBlock(message)


def render_site_block(slot: str, edge: Mapping[str, Any], tls: str = "tls internal") -> str:
    """One gated site block. Every path goes through `forward_auth`; the
    only route that does not is the gate's own login, which has to carry a
    body and is the gate's to answer."""
    rde._validate_slot_name(slot)
    host = edge.get("displayHostname")
    _require(isinstance(host, str) and HOSTNAME_PATTERN.match(host) is not None,
             f"displayHostname {host!r} is not a plain lower-case hostname")
    _require(edge.get("admittedHostname") is None,
             "a demo must never carry an admitted hostname (no per-name certificate)")
    gate = edge.get("gate") or {}
    _require(gate.get("kind") == "passphrase",
             "every demo is gated: a gate kind other than passphrase is a rendering mistake")
    max_size = edge.get("requestBodyMaxSize")
    _require(isinstance(max_size, str) and BODY_SIZE_PATTERN.match(max_size) is not None,
             f"requestBodyMaxSize {max_size!r} is not a Caddy size")
    csp = edge.get("contentSecurityPolicy")
    _require(isinstance(csp, str) and csp != "" and CSP_FORBIDDEN.search(csp) is None,
             "contentSecurityPolicy is empty or carries a character that escapes a quoted header")
    mode = edge.get("contentSecurityPolicyMode")
    _require(mode in ("enforcing", "report-only"), f"contentSecurityPolicyMode {mode!r} unknown")
    _require(TLS_PATTERN.match(tls) is not None, f"tls directive {tls!r} is not a single tls directive")
    csp_header = "Content-Security-Policy" if mode == "enforcing" else "Content-Security-Policy-Report-Only"

    lines = [
        f"https://{host} {{",
        f"\t{tls}",
        "\theader {",
        f'\t\t>X-Robots-Tag "{NOINDEX}"',
        f'\t\t>{csp_header} "{csp}"',
        "\t}",
        f"\trequest_body {{",
        f"\t\tmax_size {max_size}",
        "\t}",
        "",
        "\t# The login form carries a body, which forward_auth does not forward.",
        f"\thandle {GATE_LOGIN_PATH} {{",
        f"\t\treverse_proxy {GATE_UPSTREAM}",
        "\t}",
        "",
        "\t# Everything else, /ghost/ and /ghost/api/admin/ included, is asked of",
        "\t# the gate first. `route` fixes the order: auth, then the upload",
        "\t# refusal, then the slot.",
        "\thandle {",
        "\t\troute {",
        f"\t\t\tforward_auth {GATE_UPSTREAM} {{",
        f"\t\t\t\turi {GATE_VERIFY_URI}",
        "\t\t\t}",
        "\t\t\t@membersImportByPath {",
        "\t\t\t\tmethod POST",
        f"\t\t\t\tpath {' '.join(MEMBERS_UPLOAD_PATH_GLOBS)}",
        "\t\t\t}",
        "\t\t\t@membersImportByPattern {",
        "\t\t\t\tmethod POST",
        f"\t\t\t\tpath_regexp {MEMBERS_UPLOAD_PATH_REGEXP}",
        "\t\t\t}",
        "\t\t\trespond @membersImportByPath 403",
        "\t\t\trespond @membersImportByPattern 403",
        f"\t\t\timport {rde.snippet_name(slot)}",
        "\t\t}",
        "\t}",
        "}",
    ]
    return "\n".join(lines) + "\n"


def render_caddyfile(sites: Sequence[tuple[str, Mapping[str, Any]]], tls: str = "tls internal") -> str:
    """The whole demo Caddyfile: global options and every slot's upstream
    snippet (render_demo_edge), then the gated site block per occupied slot."""
    seen_hosts: set[str] = set()
    seen_slots: set[str] = set()
    blocks = []
    for slot, edge in sites:
        _require(slot in SLOT_NAMES, f"slot {slot!r} is not in the slot table")
        _require(slot not in seen_slots, f"slot {slot} appears twice")
        seen_slots.add(slot)
        host = edge.get("displayHostname")
        _require(host not in seen_hosts, f"host {host!r} appears twice")
        seen_hosts.add(host)
        blocks.append(render_site_block(slot, edge, tls))
    return rde.render() + "\n" + "\n".join(blocks)


def render_gate_environment() -> str:
    """The gate's environment file (`KEY=value` lines, no quoting): where it
    listens and which peer it trusts to forward the visitor's address.

    The trusted list is the edge's own address and nothing wider. Left unset
    the gate keys every attempt on the socket peer, which behind the edge is
    always the edge, so one visitor's wrong guesses would lock out all."""
    return "\n".join([
        "# Generated by render_demo_site.py -- edit the renderer, not this file.",
        f"LISTEN_HOST={rde.DEMO_EDGE_ADDR}",
        f"PORT={GATE_PORT}",
        f"GATE_TRUSTED_PROXIES={rde.DEMO_EDGE_ADDR}",
    ]) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slot", required=True)
    parser.add_argument("--edge-json", required=True)
    parser.add_argument("--tls", default="tls internal")
    parser.add_argument("--out")
    parser.add_argument("--gate-env-out", help="also write the gate's environment file here")
    args = parser.parse_args(argv)
    with open(args.edge_json, encoding="utf-8") as handle:
        edge = json.load(handle)
    content = render_caddyfile([(args.slot, edge)], args.tls)
    if args.out is None:
        sys.stdout.write(content)
    else:
        rde.write_generated_file(args.out, content)
    if args.gate_env_out is not None:
        rde.write_generated_file(args.gate_env_out, render_gate_environment())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
