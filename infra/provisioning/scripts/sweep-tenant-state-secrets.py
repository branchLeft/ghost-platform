#!/usr/bin/env python3
"""Sweep every tenant repository's `production` environment for the old state secrets.

Lists the secret NAMES (never values) of the `production` environment of every
generated tenant repository, and fails if any lists `HETZNER_S3_ACCESS_KEY_ID`
or `HETZNER_S3_SECRET_ACCESS_KEY`. It prints how many repositories it read and
fails if that differs from the tenant register's count, so a sweep that read
fewer repositories than exist cannot report success for the ones it never
opened. A seeded scratch repository (`--control-repo`) is read in the same run
and must be reported by name; if it is not, the sweep is blind and fails.
A repository it cannot read is reported as "cannot read", never as "none found".
See sweep-tenant-state-secrets.md#module-overview.

Exit codes: 0 clean, 1 an old name found, 2 usage, 3 a control was not
reported, 4 a repository or the enumeration could not be read, 5 the count
differs from the register.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path

OLD_NAMES = frozenset({"HETZNER_S3_ACCESS_KEY_ID", "HETZNER_S3_SECRET_ACCESS_KEY"})
TENANT_ZERO = "branchLeft/ghost-tenant-blog"
DEFAULT_ORG = "branchLeft"
DEFAULT_TEMPLATE = "branchLeft/ghost-platform-tenant-template"

EXIT_CLEAN, EXIT_FOUND, EXIT_USAGE, EXIT_BLIND, EXIT_CANNOT_READ, EXIT_COUNT = 0, 1, 2, 3, 4, 5


class CannotRead(Exception):
    """A repository's secret names, or the repository list, could not be read."""

    def __init__(self, subject: str, reason: str) -> None:
        super().__init__(f"{subject}: {reason}")
        self.subject = subject
        self.reason = reason


Lister = Callable[[str], list[str]]
Enumerator = Callable[[], list[str]]


@dataclass
class Report:
    read: list[str] = field(default_factory=list)
    found: dict[str, list[str]] = field(default_factory=dict)
    unreadable: dict[str, str] = field(default_factory=dict)
    controls_reported: list[str] = field(default_factory=list)
    controls_blind: list[str] = field(default_factory=list)
    register_count: int = 0

    @property
    def count_matches(self) -> bool:
        return len(self.read) == self.register_count

    def exit_code(self) -> int:
        if self.unreadable:
            return EXIT_CANNOT_READ
        if self.found:
            return EXIT_FOUND
        if self.controls_blind:
            return EXIT_BLIND
        if not self.count_matches:
            return EXIT_COUNT
        return EXIT_CLEAN


def sweep(
    repos: Sequence[str], controls: Sequence[str], lister: Lister, register_count: int
) -> Report:
    """Read each repository's names through `lister`. Controls are read too, but
    are counted apart: a control must hold an old name, and is not a tenant."""
    report = Report(register_count=register_count)
    for repo in repos:
        try:
            names = lister(repo)
        except CannotRead as error:
            report.unreadable[repo] = error.reason
            continue
        report.read.append(repo)
        hits = sorted(OLD_NAMES & set(names))
        if hits:
            report.found[repo] = hits
    for repo in controls:
        try:
            names = lister(repo)
        except CannotRead as error:
            report.unreadable[repo] = error.reason
            continue
        hits = sorted(OLD_NAMES & set(names))
        (report.controls_reported if hits else report.controls_blind).append(repo)
    return report


def render(report: Report) -> list[str]:
    lines = [
        f"read {len(report.read)} tenant repositories; the register counts {report.register_count}",
    ]
    for repo, reason in sorted(report.unreadable.items()):
        lines.append(f"CANNOT READ {repo}: {reason} (this is not 'none found')")
    for repo, hits in sorted(report.found.items()):
        lines.append(f"FOUND {repo} lists {', '.join(hits)}")
    for repo in report.controls_reported:
        lines.append(f"control {repo}: reported, as seeded")
    for repo in report.controls_blind:
        lines.append(f"CONTROL NOT REPORTED {repo}: the seeded old name was not seen; the sweep is blind")
    if not report.count_matches:
        lines.append(
            f"COUNT DIFFERS: read {len(report.read)}, register {report.register_count}; "
            "some tenant repository was not opened"
        )
    if report.exit_code() == EXIT_CLEAN:
        lines.append("clean: no tenant repository lists an old state secret name")
    return lines


def register_repos(path: str) -> list[str]:
    """The repositories of the tenants in a names register (`kind: tenant`)."""
    document = json.loads(Path(path).read_text(encoding="utf-8"))
    return sorted(e["repo"] for e in document["names"] if e.get("kind") == "tenant")


def _gh(args: list[str]) -> str:
    done = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if done.returncode != 0:
        status = re.search(r"HTTP (\d{3})", done.stderr)
        raise CannotRead(" ".join(args[:2]), f"HTTP {status.group(1)}" if status else "gh failed")
    return done.stdout


def gh_lister(repo: str) -> list[str]:
    """The names, never the values, of the repository's `production` environment secrets."""
    try:
        out = _gh(["api", f"repos/{repo}/environments/production/secrets", "--paginate", "--jq", ".secrets[].name"])
    except CannotRead as error:
        raise CannotRead(repo, error.reason) from error
    return [line.strip() for line in out.splitlines() if line.strip()]


def make_gh_enumerator(org: str, template: str) -> Enumerator:
    def enumerate_generated() -> list[str]:
        listing = _gh(["repo", "list", org, "--limit", "1000", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"])
        generated: list[str] = []
        for repo in (line.strip() for line in listing.splitlines() if line.strip()):
            source = _gh(["api", f"repos/{repo}", "--jq", ".template_repository.full_name // \"\""]).strip()
            if source == template:
                generated.append(repo)
        return generated

    return enumerate_generated


def _self_test() -> None:
    old = sorted(OLD_NAMES)[0]
    held = {"org/blog": ["APP_KEY"], "org/acme": ["APP_KEY"], "org/scratch": [old]}

    def lister(repo: str) -> list[str]:
        return held[repo]

    green = sweep(["org/blog", "org/acme"], [], lister, 2)
    assert green.exit_code() == EXIT_CLEAN, render(green)
    with_control = sweep(["org/blog", "org/acme"], ["org/scratch"], lister, 2)
    assert with_control.controls_reported == ["org/scratch"], render(with_control)
    held["org/acme"] = [old]
    red = sweep(["org/blog", "org/acme"], [], lister, 2)
    assert red.exit_code() == EXIT_FOUND and "org/acme" in red.found, render(red)
    print("self-test OK")


def main(
    argv: list[str],
    lister: Lister | None = None,
    enumerator: Enumerator | None = None,
) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--register", help="the tenant names register (registers/tenant-names.json)")
    parser.add_argument("--register-count", type=int, help="the tenant register's count, when it is not a names file")
    parser.add_argument("--control-repo", action="append", default=[], help="a seeded scratch repository that must be reported")
    parser.add_argument("--org", default=DEFAULT_ORG)
    parser.add_argument("--template", default=DEFAULT_TEMPLATE)
    args = parser.parse_args(argv)
    if args.self_test:
        _self_test()
        return EXIT_CLEAN
    if (args.register is None) == (args.register_count is None):
        parser.error("give exactly one of --register and --register-count")

    list_names = lister or gh_lister
    enumerate_generated = enumerator or make_gh_enumerator(args.org, args.template)
    try:
        generated = enumerate_generated()
    except CannotRead as error:
        print(f"CANNOT READ the repository list: {error.reason} (this is not 'none found')", file=sys.stderr)
        return EXIT_CANNOT_READ
    repos = sorted(set(generated) | {TENANT_ZERO})
    expected = len(register_repos(args.register)) if args.register else args.register_count
    report = sweep(repos, sorted(set(args.control_repo) - set(repos)), list_names, expected)
    for line in render(report):
        print(line)
    return report.exit_code()


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
