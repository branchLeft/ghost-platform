#!/usr/bin/env python3
"""Render the whole demo Caddyfile: every occupied slot's gated block under one
wildcard site.

Usage: render_demo_site.py --base DOMAIN --site SLOT=EDGE_JSON [--site ...]
                           (--dns-directive DIRECTIVE | --tls DIRECTIVE)
                           [--out FILE] [--gate-env-out FILE]

`EDGE_JSON` is the JSON of render-core's `EdgeSiteBlock` (the shape of
`render-core/test/golden/demo.edge.json`). Exactly one TLS source is
required: `--dns-directive` is the production one (a DNS-01 wildcard
certificate); `--tls` is for the local-CA proof only. See
render_demo_site.md for what the block guarantees and why each directive
sits where it does.
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
# The wildcard covers one label, so the base and each slot host are one dot apart.
BASE_PATTERN = re.compile(r"\A([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?\Z")
# Local-CA proofs pass `tls internal`. Anything with a newline or brace is
# not one directive.
TLS_PATTERN = re.compile(r"\Atls [A-Za-z0-9 ./_:-]+\Z")
# The production source: one DNS-challenge provider and exactly one argument,
# a single placeholder, so the token is read at run time and never sits in
# the Caddyfile. A literal token, the block form, a relative path, a newline
# or a second directive never match.
DNS_DIRECTIVE_PATTERN = re.compile(
    r"\Adns [a-z][a-z0-9_]* \{(?:env\.[A-Za-z_][A-Za-z0-9_]*|file\.(?P<path>(?:/[A-Za-z0-9._-]+)+))\}\Z"
)


class InvalidEdgeBlock(ValueError):
    """Raised for an edge block this renderer refuses to turn into config."""


class InvalidBaseDomain(InvalidEdgeBlock):
    """Raised for a wildcard base that is not a plain lower-case domain."""


class HostOutsideWildcard(InvalidEdgeBlock):
    """Raised for a slot host that is not exactly one label below the base."""


class InvalidTlsSource(InvalidEdgeBlock):
    """Raised unless exactly one valid TLS source is given."""


class InvalidDnsDirective(InvalidTlsSource):
    """Raised for a DNS-challenge directive that is not one placeholder argument."""


def _require(condition: bool, message: str, error: type[InvalidEdgeBlock] = InvalidEdgeBlock) -> None:
    if not condition:
        raise error(message)


def validate_base(base: str) -> None:
    """Raises InvalidBaseDomain unless `base` is a plain lower-case domain of
    at least two labels, with a non-numeric last one."""
    _require(BASE_PATTERN.match(base) is not None,
             f"base {base!r} is not a plain lower-case domain", InvalidBaseDomain)


def _slot_host(edge: Mapping[str, Any], base: str) -> str:
    """The slot's hostname. Raises InvalidEdgeBlock for one that is not a
    plain lower-case hostname or for an edge carrying an admitted hostname,
    and HostOutsideWildcard unless it is exactly one label below `base`."""
    host = edge.get("displayHostname")
    _require(isinstance(host, str) and HOSTNAME_PATTERN.match(host) is not None,
             f"displayHostname {host!r} is not a plain lower-case hostname")
    _require(edge.get("admittedHostname") is None,
             "a demo must never carry an admitted hostname (no per-name certificate)")
    _label, _dot, parent = host.partition(".")
    _require(parent == base, f"hostname {host!r} is not exactly one label below {base!r}",
             HostOutsideWildcard)
    return host


def render_slot_body(slot: str, edge: Mapping[str, Any]) -> list[str]:
    """One slot's gated directives, indented one tab. Every path goes through
    `forward_auth`; the only route that does not is the gate's own login,
    which has to carry a body and is the gate's to answer."""
    rde._validate_slot_name(slot)
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
    csp_header = "Content-Security-Policy" if mode == "enforcing" else "Content-Security-Policy-Report-Only"

    return [
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
    ]


def render_slot_handle(slot: str, edge: Mapping[str, Any], base: str) -> list[str]:
    """One slot's host matcher and the `handle` that carries its gated body.
    Raises what `_slot_host` and `render_slot_body` raise."""
    rde._validate_slot_name(slot)
    host = _slot_host(edge, base)
    body = render_slot_body(slot, edge)
    return [
        f"\t@slot{slot} host {host}",
        f"\thandle @slot{slot} {{",
        *(f"\t{line}" if line else line for line in body),
        "\t}",
    ]


def _checked_dns_directive(directive: str) -> str:
    """Raises InvalidDnsDirective unless `directive` is one provider with one
    placeholder argument. The message never echoes it: a refused one may be a
    literal token."""
    match = DNS_DIRECTIVE_PATTERN.match(directive)
    if match is None:
        raise InvalidDnsDirective(
            "the DNS directive is not one provider with one {file.<absolute path>} or {env.NAME} argument")
    path = match.group("path")
    if path is not None and {".", ".."} & set(path.split("/")):
        raise InvalidDnsDirective("the DNS directive's file path has a . or .. segment")
    return directive


def render_tls_lines(tls: str | None, dns_directive: str | None) -> list[str]:
    """The wildcard site's TLS lines. There is no default: exactly one source
    is required. Raises InvalidTlsSource for none or both, or for a `tls`
    line that is not a single tls directive; InvalidDnsDirective for what
    `_checked_dns_directive` refuses."""
    if dns_directive is None:
        if tls is None:
            raise InvalidTlsSource(
                "no TLS source given: pass a DNS directive, or a tls line for the local-CA proof (there is no default)")
        _require(TLS_PATTERN.match(tls) is not None,
                 f"tls directive {tls!r} is not a single tls directive", InvalidTlsSource)
        return [f"\t{tls}"]
    if tls is not None:
        raise InvalidTlsSource("two TLS sources given: pass a DNS directive or a tls line, not both")
    return ["\ttls {", f"\t\t{_checked_dns_directive(dns_directive)}", "\t}"]


def _render_slot_handles(base: str, sites: Sequence[tuple[str, Mapping[str, Any]]]) -> list[str]:
    seen_hosts: set[str] = set()
    seen_slots: set[str] = set()
    lines: list[str] = []
    for slot, edge in sites:
        _require(slot in SLOT_NAMES, f"slot {slot!r} is not in the slot table")
        _require(slot not in seen_slots, f"slot {slot} appears twice")
        seen_slots.add(slot)
        handle = render_slot_handle(slot, edge, base)
        host = edge["displayHostname"]
        _require(host not in seen_hosts, f"host {host!r} appears twice")
        seen_hosts.add(host)
        lines += [*handle, ""]
    return lines


def render_caddyfile(
    base: str,
    sites: Sequence[tuple[str, Mapping[str, Any]]],
    tls: str | None = None,
    dns_directive: str | None = None,
) -> str:
    """The whole demo Caddyfile: global options and every slot's upstream
    snippet (render_demo_edge) once, then one `*.<base>` site whose
    host-matched handle carries each occupied slot's gated block. A name that
    matches no slot is aborted, so the wildcard answers nothing else.

    Raises InvalidBaseDomain, InvalidTlsSource, InvalidDnsDirective,
    HostOutsideWildcard, or InvalidEdgeBlock for a bad slot, host or edge."""
    validate_base(base)
    tls_lines = render_tls_lines(tls, dns_directive)
    lines = [
        f"*.{base} {{",
        *tls_lines,
        *_render_slot_handles(base, sites),
        "\thandle {",
        "\t\tabort",
        "\t}",
        "}",
    ]
    return rde.render() + "\n" + "\n".join(lines) + "\n"


def render_gate_environment() -> str:
    """The gate's environment file (`KEY=value` lines, no quoting): where it
    listens and which peer it trusts to forward the visitor's address.

    The trusted list is the edge's own address and nothing wider. Left unset
    the gate keys every attempt on the socket peer, which for every visitor
    request is the edge, so all visitors would share one bucket."""
    return "\n".join([
        "# Generated by render_demo_site.py -- edit the renderer, not this file.",
        f"LISTEN_HOST={rde.DEMO_EDGE_ADDR}",
        f"PORT={GATE_PORT}",
        f"GATE_TRUSTED_PROXIES={rde.DEMO_EDGE_ADDR}",
    ]) + "\n"


def _parse_site(value: str) -> tuple[str, str]:
    slot, separator, edge_json = value.partition("=")
    if not separator or not slot or not edge_json:
        raise argparse.ArgumentTypeError(f"{value!r} is not SLOT=EDGE_JSON")
    return slot, edge_json


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", required=True, help="the wildcard's base domain: sites are one label below it")
    parser.add_argument("--site", action="append", required=True, type=_parse_site, metavar="SLOT=EDGE_JSON",
                        help="one occupied slot and its edge JSON; repeat for each slot")
    parser.add_argument("--dns-directive", help="the production TLS source: one `dns <provider> {file.<path>}` line")
    parser.add_argument("--tls", help="the local-CA proof's TLS source, e.g. `tls internal`; never for production")
    parser.add_argument("--out")
    parser.add_argument("--gate-env-out", help="also write the gate's environment file here")
    args = parser.parse_args(argv)
    sites = []
    for slot, edge_json in args.site:
        with open(edge_json, encoding="utf-8") as handle:
            sites.append((slot, json.load(handle)))
    content = render_caddyfile(args.base, sites, tls=args.tls, dns_directive=args.dns_directive)
    if args.out is None:
        sys.stdout.write(content)
    else:
        rde.write_generated_file(args.out, content)
    if args.gate_env_out is not None:
        rde.write_generated_file(args.gate_env_out, render_gate_environment())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
