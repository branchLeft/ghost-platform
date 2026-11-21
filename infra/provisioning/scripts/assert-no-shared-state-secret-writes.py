#!/usr/bin/env python3
"""Fail when a workflow names the shared state credential outside a comment.

The shared pair (`HETZNER_S3_ACCESS_KEY_ID`, `HETZNER_S3_SECRET_ACCESS_KEY`)
and the provisioning job's own `TENANT_STATE_S3_*` reach every tenant's state.
A workflow step that writes one into another repository would put it back in
that tenant's hands, so no line of the files given may name one, except in a
comment. A line that writes a secret (`gh secret set`, or a PUT to a
`/secrets/` path) is reported as a write; any other mention is reported as a
mention. A write whose secret name is not a literal is refused as well, since
the check cannot see which secret it writes.
See assert-no-shared-state-secret-writes.md#module-overview.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

# GitHub secret names are not case-sensitive, so every pattern that names a
# secret or a method ignores case; a finding reports the canonical upper case.
FORBIDDEN = re.compile(
    r"\b(HETZNER_S3_ACCESS_KEY_ID|HETZNER_S3_SECRET_ACCESS_KEY|TENANT_STATE_S3_[A-Z0-9_]+)\b",
    re.IGNORECASE,
)
_GH_SECRET_SET = re.compile(r"\bgh\s+secret\s+set\b(?P<rest>.*)")
_API_SECRET_PUT = re.compile(
    r"\bgh\s+api\b.*(?:-X\s*PUT|--method[ =]PUT).*/secrets/|\bgh\s+api\b.*/secrets/.*(?:-X\s*PUT|--method[ =]PUT)",
    re.IGNORECASE,
)
_LITERAL_NAME = re.compile(r"""^\s*['"]?[A-Z][A-Z0-9_]*['"]?(\s|$)""")

SEEDED_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "seeded-shared-state-write.yml"


@dataclass(frozen=True)
class Finding:
    path: str
    line: int
    kind: str
    name: str

    def render(self) -> str:
        return f"{self.path}:{self.line}: {self.kind}: {self.name}"


def logical_lines(text: str) -> list[tuple[int, str]]:
    """(first line number, text) for each shell logical line, comments dropped and
    backslash continuations joined, so a `printf ... \\ | gh secret set X` is one line."""
    joined: list[tuple[int, str]] = []
    carry: str | None = None
    start = 0
    for number, raw in enumerate(text.splitlines(), 1):
        if raw.lstrip().startswith("#"):
            if carry is not None:
                joined.append((start, carry))
                carry = None
            continue
        if carry is None:
            start = number
            carry = ""
        stripped = raw.rstrip()
        if stripped.endswith("\\"):
            carry += stripped[:-1] + " "
            continue
        joined.append((start, carry + stripped))
        carry = None
    if carry is not None:
        joined.append((start, carry))
    return joined


def scan(path: str, text: str) -> list[Finding]:
    findings: list[Finding] = []
    for number, line in logical_lines(text):
        is_write = bool(_GH_SECRET_SET.search(line) or _API_SECRET_PUT.search(line))
        names = [name.upper() for name in FORBIDDEN.findall(line)]
        for name in sorted(set(names)):
            findings.append(Finding(path, number, "writes" if is_write else "mentions", name))
        set_match = _GH_SECRET_SET.search(line)
        if set_match and not names and not _LITERAL_NAME.match(set_match.group("rest")):
            findings.append(Finding(path, number, "writes a secret whose name is not a literal", "(unreadable)"))
    return findings


def _self_test() -> None:
    seeded = SEEDED_FIXTURE.read_text(encoding="utf-8")
    red = scan("fixture", seeded)
    assert {f.name for f in red} >= {"HETZNER_S3_ACCESS_KEY_ID", "TENANT_STATE_S3_SECRET_ACCESS_KEY"}, red
    assert any(f.kind == "writes" for f in red), red
    assert scan("clean", "run: |\n  # HETZNER_S3_ACCESS_KEY_ID is gone\n  gh secret set STATE_GATEWAY_ACCESS_KEY_ID --repo x\n") == []
    print("self-test OK")


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("files", nargs="*", help="workflow files to check")
    args = parser.parse_args(argv)
    if args.self_test:
        _self_test()
        return 0
    if not args.files:
        parser.error("name at least one file, or pass --self-test")
    findings: list[Finding] = []
    for name in args.files:
        findings += scan(name, Path(name).read_text(encoding="utf-8"))
    for finding in findings:
        print(f"::error::{finding.render()}", file=sys.stderr)
    if findings:
        return 1
    print(f"no shared state credential named in {len(args.files)} file(s)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
