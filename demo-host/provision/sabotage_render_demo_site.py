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
     '        "\\thandle {",\n',
     '        "\\thandle /ghost/* {",\n        "\\t\\treverse_proxy 127.0.0.1:1",\n        "\\t}",\n        "\\thandle {",\n'),
    ("drop forward_auth from the catch-all",
     '        f"\\t\\t\\tforward_auth {GATE_UPSTREAM} {{",\n        f"\\t\\t\\t\\turi {GATE_VERIFY_URI}",\n        "\\t\\t\\t}",\n',
     ""),
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
