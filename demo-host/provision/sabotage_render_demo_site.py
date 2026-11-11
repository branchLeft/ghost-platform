#!/usr/bin/env python3
"""Sabotage proof for render_demo_site: break each gate in a scratch copy and
require the suite to go red, then require the untouched copy green.

Usage: sabotage_render_demo_site.py

Prints one line per gate: `RED` when the sabotaged copy fails the suite (the
gate is proven), `NOT RED` and exit 1 when it still passes (the gate is not).
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).parent
GOLDEN = HERE.parents[1] / "render-core" / "test" / "golden" / "demo.edge.json"

# (name, old text, new text) -- each edits render_demo_site.py only.
SABOTAGES = [
    ("exempt /ghost/* from forward_auth",
     '        "\\t# refusal, then the slot.",\n        "\\thandle {",\n',
     '        "\\t# refusal, then the slot.",\n        "\\thandle /ghost/* {",\n        "\\t\\treverse_proxy 127.0.0.1:1",\n        "\\t}",\n        "\\thandle {",\n'),
    ("drop forward_auth from the catch-all",
     '        f"\\t\\t\\tforward_auth {GATE_UPSTREAM} {{",\n        f"\\t\\t\\t\\turi {GATE_VERIFY_URI}",\n        "\\t\\t\\t}",\n',
     ""),
    ("wildcard site: drop the final abort catch-all",
     '        "\\thandle {",\n        "\\t\\tabort",\n        "\\t}",\n',
     ""),
    ("wildcard site: widen a slot's matcher so it answers any name",
     'f"\\t@slot{slot} host {host}",',
     'f"\\t@slot{slot} host *",'),
    ("wildcard site: render a slot outside its host matcher",
     'f"\\thandle @slot{slot} {{",',
     '"\\thandle {",'),
    ("wildcard site: replace the wildcard address with per-host addresses",
     'f"*.{base} {{",',
     '", ".join(f"https://{edge[\'displayHostname\']}" for _slot, edge in sites) + " {",'),
    ("wildcard site: drop the tls block's DNS directive",
     'return ["\\ttls {", f"\\t\\t{_checked_dns_directive(dns_directive)}", "\\t}"]\n',
     'return ["\\ttls {", "\\t}"]\n'),
    ("wildcard site: accept a host two labels below the base",
     '_require(parent == base,',
     '_require(parent.endswith(base),'),
    ("wildcard site: accept a host used by two slots",
     '_require(host not in seen_hosts,',
     '_require(True,'),
    ("wildcard site: accept a slot used twice",
     '_require(slot not in seen_slots,',
     '_require(True,'),
    ("wildcard site: accept a base that is not a plain domain",
     '_require(BASE_PATTERN.match(base) is not None,',
     '_require(True,'),
    ("admitted hostname accepted",
     '_require(edge.get("admittedHostname") is None,',
     '_require(True,'),
    ("tls source: both given is accepted",
     '    if tls is not None:\n        raise InvalidTlsSource("two',
     '    if False:\n        raise InvalidTlsSource("two'),
    ("tls source: neither given falls back to a local CA",
     '        if tls is None:\n            raise InvalidTlsSource(\n',
     '        if tls is None:\n            tls = "tls internal"\n        if tls is False:\n            raise InvalidTlsSource(\n'),
    ("tls option: a newline or brace is accepted",
     'TLS_PATTERN = re.compile(r"\\Atls [A-Za-z0-9 ./_:-]+\\Z")',
     'TLS_PATTERN = re.compile(r"\\Atls [A-Za-z0-9 ./_:{}\\n\\t-]+\\Z")'),
    ("dns directive: pattern has no end anchor (a second directive follows)",
     '\\}\\Z"\n)',
     '\\}"\n)'),
    ("dns directive: a .. path segment accepted",
     'if path is not None and {".", ".."} & set(path.split("/")):',
     'if False:'),
    ("dns directive: refusal message echoes the directive",
     '            "the DNS directive is not one provider',
     '            directive + "the DNS directive is not one provider'),
    ("members upload: only the narrow literal path is refused (the reviewed bypass)",
     'MEMBERS_UPLOAD_PATH_GLOBS = (\n    "/ghost/api/admin/members/upload",\n    "/ghost/api/admin/members/upload/",\n    "/ghost/api/*/admin/members/upload",\n    "/ghost/api/*/admin/members/upload/",\n)\n',
     'MEMBERS_UPLOAD_PATH_GLOBS = ("/ghost/api/admin/members/upload/",)\n'),
    ("members upload: version prefix not covered by the pattern",
     "(?:(?:v[0-9]+|canary)/)?",
     ""),
    ("members upload: pattern needs the trailing slash",
     "upload/?$",
     "upload/$"),
    ("members upload: pattern case-sensitive",
     'r"(?i)^/ghost',
     'r"^/ghost'),
    ("members upload POST not refused (path matcher)",
     '        "\\t\\t\\trespond @membersImportByPath 403",\n',
     ""),
    ("members upload POST not refused (pattern matcher)",
     '        "\\t\\t\\trespond @membersImportByPattern 403",\n',
     ""),
    ("members upload refusal also hits GET",
     '        "\\t\\t\\t\\tmethod POST",\n        f"\\t\\t\\t\\tpath {',
     '        "\\t\\t\\t\\tmethod GET POST",\n        f"\\t\\t\\t\\tpath {'),
    ("upload guard: the path matcher's 403 dropped",
     '        "\\t\\t\\t\\trespond @activeUploadByPath 403",\n',
     ""),
    ("upload guard: the pattern matcher's 403 dropped",
     '        "\\t\\t\\trespond @activeUploadByPattern 403",\n',
     ""),
    ("upload guard: only .js refused",
     'ACTIVE_CONTENT_EXTENSIONS = (\n    "js", "mjs", "cjs",\n    "html", "htm", "shtml", "xhtml", "xht",\n    "xml", "xsl", "xslt",\n    "css",\n    "svg", "svgz",\n    "kml", "gpx",\n)\n',
     'ACTIVE_CONTENT_EXTENSIONS = ("js",)\n'),
    ("upload guard: .svg left out",
     '    "svg", "svgz",\n    "kml", "gpx",\n)\n',
     '    "svgz",\n    "kml", "gpx",\n)\n'),
    ("upload guard: .kml left out",
     '    "kml", "gpx",\n)\n',
     '    "gpx",\n)\n'),
    ("upload guard: .gpx left out",
     '    "kml", "gpx",\n)\n',
     '    "kml",\n)\n'),
    ("upload guard: the media prefix left out",
     'UPLOAD_PATH_PREFIXES = ("/content/files/", "/content/images/", "/content/media/")',
     'UPLOAD_PATH_PREFIXES = ("/content/files/", "/content/images/")'),
    ("upload guard: pattern case-sensitive",
     'r"(?i)^/+content/+',
     'r"^/+content/+'),
    ("upload guard: pattern stops at the first directory below the prefix",
     '(?:files|images|media)/.*\\.(?:',
     '(?:files|images|media)/[^/]*\\.(?:'),
    ("upload guard: refusal limited to GET",
     '        "\\t\\t\\t@uploadsByPath {",\n',
     '        "\\t\\t\\t@uploadsByPath {",\n        "\\t\\t\\t\\tmethod GET",\n'),
    ("upload guard: runs before forward_auth (an anonymous visitor reaches the refusal)",
     '        "\\t\\troute {",\n',
     '        "\\t\\troute {",\n        *render_upload_guard(),\n'),
    ("upload guard: prefix and extension in one matcher (two path lines are an OR)",
     '        "\\t\\t\\t\\t@activeUploadByPath {",\n        f"\\t\\t\\t\\t\\tpath {extensions}",\n',
     '        "\\t\\t\\t\\t@activeUploadByPath {",\n        f"\\t\\t\\t\\t\\tpath {prefixes}",\n        f"\\t\\t\\t\\t\\tpath {extensions}",\n'),
    ("drop nosniff",
     '        \'\\t\\t>X-Content-Type-Options "nosniff"\',\n',
     ""),
    ("drop nosniff from the site's error response",
     '        \'\\t\\t\\t>X-Content-Type-Options "nosniff"\',\n',
     ""),
    ("drop noindex",
     '        f\'\\t\\t>X-Robots-Tag "{NOINDEX}"\',\n',
     ""),
    ("enforcing policy rendered report-only",
     'csp_header = "Content-Security-Policy" if mode == "enforcing" else',
     'csp_header = "Content-Security-Policy-Report-Only" if mode == "enforcing" else'),
    ("accept an ungated descriptor",
     'gate.get("kind") == "passphrase"',
     'gate.get("kind") in ("passphrase", "none")'),
    ("drop the per-colour upstream import",
     '        f"\\t\\t\\timport {rde.snippet_name(slot)}",\n',
     ""),
    ("gate environment: trust every address",
     '        f"GATE_TRUSTED_PROXIES={rde.DEMO_EDGE_ADDR}",\n',
     '        "GATE_TRUSTED_PROXIES=0.0.0.0/0",\n'),
    ("gate environment: trust the whole loopback range",
     '        f"GATE_TRUSTED_PROXIES={rde.DEMO_EDGE_ADDR}",\n',
     '        "GATE_TRUSTED_PROXIES=127.0.0.0/8",\n'),
    ("gate environment: leave the trusted list unset",
     '        f"GATE_TRUSTED_PROXIES={rde.DEMO_EDGE_ADDR}",\n',
     ""),
    ("gate environment: listen on every interface",
     '        f"LISTEN_HOST={rde.DEMO_EDGE_ADDR}",\n',
     '        "LISTEN_HOST=0.0.0.0",\n'),
]


def run_suite(directory: pathlib.Path) -> bool:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "test_render_demo_site"],
        cwd=directory, capture_output=True, text=True,
    )
    return result.returncode == 0


def main() -> int:
    failures = 0
    for name, old, new in SABOTAGES:
        with tempfile.TemporaryDirectory() as tmp:
            scratch = pathlib.Path(tmp) / "demo-host" / "provision"
            shutil.copytree(HERE, scratch, ignore=shutil.ignore_patterns("__pycache__"))
            golden = pathlib.Path(tmp) / "render-core" / "test" / "golden"
            golden.mkdir(parents=True)
            shutil.copy(GOLDEN, golden / "demo.edge.json")
            target = scratch / "render_demo_site.py"
            source = target.read_text(encoding="utf-8")
            if source.count(old) != 1:
                print(f"BROKEN SABOTAGE (pattern found {source.count(old)} times): {name}")
                failures += 1
                continue
            target.write_text(source.replace(old, new), encoding="utf-8")
            red = not run_suite(scratch)
        print(f"{'RED' if red else 'NOT RED'}: {name}")
        failures += 0 if red else 1
    green = run_suite(HERE)
    print(f"{'GREEN' if green else 'NOT GREEN'}: unsabotaged suite")
    return 0 if failures == 0 and green else 1


if __name__ == "__main__":
    raise SystemExit(main())
