#!/usr/bin/env python3
"""Render a demo slot's gated site block, and the whole demo Caddyfile.

Usage: render_demo_site.py --slot N --edge-json FILE [--tls DIRECTIVE] [--out FILE]

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
# edge only (the host firewall opens 80 and 443 and nothing else).
GATE_UPSTREAM = "127.0.0.1:8080"
GATE_VERIFY_URI = "/__gate/verify"
GATE_LOGIN_PATH = "/__gate/login"

# HLD F1: the members import is refused at the edge; the GET (the export)
# is the prospect's and stays open behind the gate.
MEMBERS_UPLOAD_PATH = "/ghost/api/admin/members/upload/"

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
        f"\t\t\t@membersImport method POST",
        f"\t\t\trespond @membersImport 403",
        f"\t\t\timport {rde.snippet_name(slot)}",
        "\t\t}",
        "\t}",
        "}",
    ]
    # The path matcher belongs on the same named matcher; build it explicitly.
    text = "\n".join(lines)
    text = text.replace(
        "\t\t\t@membersImport method POST\n",
        f"\t\t\t@membersImport {{\n\t\t\t\tmethod POST\n\t\t\t\tpath {MEMBERS_UPLOAD_PATH}\n\t\t\t}}\n",
    )
    return text + "\n"


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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--slot", required=True)
    parser.add_argument("--edge-json", required=True)
    parser.add_argument("--tls", default="tls internal")
    parser.add_argument("--out")
    args = parser.parse_args(argv)
    with open(args.edge_json, encoding="utf-8") as handle:
        edge = json.load(handle)
    content = render_caddyfile([(args.slot, edge)], args.tls)
    if args.out is None:
        sys.stdout.write(content)
    else:
        rde.write_generated_file(args.out, content)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
