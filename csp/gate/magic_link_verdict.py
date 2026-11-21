"""The verdict on a magic-link round trip under the strict content policy.

Observation lives in csp/proof/capture-magic-link.ts; the live runner is
magic_link_gate.py. This module only judges what the capture reported, and reads
nothing but that JSON. The flow and what it does not prove:
csp/gate/csp-magic-link-gate.md.

Usage:
    magic_link_verdict.py ORIGIN < capture.json     exit 0 holds, 1 does not
"""

from __future__ import annotations

import json
import sys
from collections.abc import Mapping, Sequence
from urllib.parse import parse_qs, urlsplit

STEPS = (
    "signup-form-shown",
    "signup-sent",
    "magic-link-mailed",
    "magic-link-followed",
    "member-session",
    "portal-account-shown",
)
# The path the edge serves the vendored widget files under (render-core's
# WIDGET_ASSET_PATH_PREFIX); Portal must load from there, on the tenant's own origin.
PORTAL_PATH = "/bl-assets/portal.min.js"
MAX_LISTED = 5


def listed(items: Sequence[str]) -> str:
    """The first few items, and how many were left out."""
    shown = "; ".join(items[:MAX_LISTED])
    extra = len(items) - MAX_LISTED
    return shown if extra <= 0 else f"{shown}; and {extra} more"


def describe_violation(violation: Mapping[str, object]) -> str:
    directive = violation.get("directive", "?")
    blocked = violation.get("blockedURI", "?")
    frame = violation.get("frame", "?")
    return f"{directive} blocked {blocked} (in {frame})"


def as_list(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def judge(run: Mapping[str, object], origin: str) -> list[str]:
    """Failure strings for one capture; empty means the round trip holds.

    It holds only when every step happened in order, the mail the tenant sent
    carried a link to its own origin, the member really is signed in, Portal
    really loaded from the tenant's own origin (so a clean report is not a page that
    never ran it), nothing but an image reached a third party, and no frame reported a violation.
    """
    failures: list[str] = []
    if run.get("error"):
        failures.append(f"the browser run stopped {run.get('failedAt')}: {run['error']}")
    steps = [str(step) for step in as_list(run.get("steps"))]
    if steps != list(STEPS):
        failures.append(f"the steps were [{', '.join(steps)}], not [{', '.join(STEPS)}]")
    if run.get("linkOrigin") != origin:
        failures.append(
            f"the magic link in the mail does not point at the tenant's own origin: {run.get('linkOrigin')}"
        )
    if run.get("memberSession") is not True:
        failures.append("Ghost did not serve a member session for the address that signed up")
    final = urlsplit(str(run.get("finalUrl") or ""))
    query = parse_qs(final.query)
    if query.get("action") != ["signup"] or query.get("success") != ["true"]:
        failures.append(f"Ghost did not send the browser back with action=signup&success=true: {final.query!r}")
    if run.get("portalScriptUrl") != f"{origin}{PORTAL_PATH}":
        failures.append(
            f"Portal did not load from the tenant's own origin ({run.get('portalScriptUrl')})"
        )
    foreign = [str(item) for item in as_list(run.get("foreignRequests"))]
    if foreign:
        failures.append(f"the browser reached {len(foreign)} request(s) off the tenant's origin: {listed(foreign)}")
    violations = [item for item in as_list(run.get("violations")) if isinstance(item, dict)]
    if violations:
        failures.append(
            f"{len(violations)} content-policy violation(s): "
            + listed([describe_violation(item) for item in violations])
        )
    return failures


def notes(run: Mapping[str, object]) -> list[str]:
    """What the run saw that the verdict does not judge: the policy allows an image
    from any https origin, so a third-party image is not a violation, but it is a
    reader's browser contacting that third party, and the run says so."""
    images = [str(item) for item in as_list(run.get("thirdPartyImages"))]
    if not images:
        return []
    return [f"{len(images)} third-party image(s) loaded, which the policy allows: {listed(images)}"]


def main(argv: Sequence[str]) -> int:
    if len(argv) != 1:
        print("usage: magic_link_verdict.py ORIGIN < capture.json", file=sys.stderr)
        return 2
    try:
        run = json.load(sys.stdin)
    except json.JSONDecodeError as problem:
        print(f"magic_link_verdict: the capture is not JSON: {problem}", file=sys.stderr)
        return 2
    if not isinstance(run, dict):
        print("magic_link_verdict: the capture is not a JSON object", file=sys.stderr)
        return 2
    for note in notes(run):
        print(f"NOTE: {note}")
    failures = judge(run, argv[0])
    if failures:
        for failure in failures:
            print(f"FAIL: {failure}")
        print(f"MAGIC LINK GATE RED: {len(failures)} check(s) failed")
        return 1
    print(
        "MAGIC LINK GATE GREEN: a reader signed up, followed the mailed link and signed in "
        "with zero content-policy violations"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
