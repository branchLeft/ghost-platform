#!/usr/bin/env python3
"""Fails when the recovery image's `mysql`, `mysqldump` or `mysqlbinlog` do
not report the same major.minor line as the MySQL server the tenant estate
actually runs.

A recovery image built against the wrong line is worse than an obviously
missing one: `mysqldump --source-data=2` from an 8.4 client issues `SHOW
BINARY LOG STATUS` unconditionally, which an 8.0 server rejects outright
(install_host_prereqs.py's own module docstring records this, found live
during the first db1 bootstrap) -- so the failure shows up only when the
image is actually needed, under incident conditions, against a server that
cannot be changed to suit it. This check exists so that failure happens at
build time instead.

The server's pin is read out of db/RUNBOOK-db.md rather than carried as a
second constant here: `branchleft-deploy db mysql:...@sha256:...` is the one
command that actually re-pins db1, and a copy of that digest living in this
file too is exactly the kind of drift the rest of this design keeps
warning about -- two things that are supposed to agree, checked against each
other only by both having been edited correctly. --server-image overrides
this for the control case: proving the check fails on a genuine mismatch
without needing a second real MySQL line to build a server image from.

The runbook carries that command twice (the first, always-fails bootstrap
run in step 3, and the re-pin that follows it) and both are meant to name
the same image -- so this reads every occurrence with `findall`, not just
the first, and refuses to pick a winner when they disagree. A regex that
stopped at the first match would stay green while the second line alone
drifted, which is worse than not checking at all: it reports a match that
was never actually re-verified against what `branchleft-deploy` would
really pin.

This check compares against the runbook's pin, not against what `db1`
itself currently reports running -- there is no way to read
`/etc/branchleft/db.image.env` back from CI (no SSH, no host reachable from
a GitHub Actions runner). `db/RUNBOOK-db.md`'s restore-drill section now
carries an owner step asking Rob to read that file back by hand and record
the date; until that record exists, a green run here is evidence the
runbook is internally consistent, not evidence it matches what db1 is
currently running.

Major.minor, not the full patch version: the same standard
install_host_prereqs.py's own verify() uses, and design 09's own R5/§05
language -- "exact-matched to the server's 8.0 line, not merely compatible
with it" -- means the line, not the patch digit.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys

REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
RUNBOOK_PATH = REPO_ROOT / "db" / "RUNBOOK-db.md"

# Matches the exact command db/RUNBOOK-db.md carries (twice, identically) to
# re-pin db1's own MySQL server image.
SERVER_PIN_RE = re.compile(r"branchleft-deploy db (mysql:\S+@sha256:[0-9a-f]{64})")

CLIENT_BINARIES = ("mysql", "mysqldump", "mysqlbinlog")
VERSION_RE = re.compile(r"(\d+)\.(\d+)\.(\d+)")


class ToolchainCheckError(Exception):
    """The pin could not be read, a version could not be parsed, or a
    client/server line mismatch was found. main() reports this and exits
    non-zero."""


def server_image_from_runbook(text: str | None = None, *, runbook_path: pathlib.Path = RUNBOOK_PATH) -> str:
    if text is None:
        text = runbook_path.read_text(encoding="utf-8")
    matches = SERVER_PIN_RE.findall(text)
    if not matches:
        raise ToolchainCheckError(f"no `branchleft-deploy db mysql:...@sha256:...` pin found in {runbook_path}")
    unique = sorted(set(matches))
    if len(unique) > 1:
        raise ToolchainCheckError(
            f"{runbook_path} carries disagreeing `branchleft-deploy db mysql:...@sha256:...` pins "
            f"({len(matches)} occurrences, {len(unique)} distinct values): {unique!r}"
        )
    return unique[0]


def major_minor(version_output: str, *, label: str) -> str:
    match = VERSION_RE.search(version_output)
    if not match:
        raise ToolchainCheckError(f"{label}: could not parse a version out of {version_output.strip()!r}")
    return f"{match.group(1)}.{match.group(2)}"


def docker_run_version(image: str, binary: str, *, run=subprocess.run) -> str:
    """`docker run --rm <image> <binary> --version`. Works unmodified for
    both images this script compares: the recovery image sets no custom
    entrypoint, and the official mysql server image's entrypoint execs a
    bare `mysqld` argument directly rather than routing it through
    initialisation -- both were verified live, not assumed."""
    result = run(
        ["docker", "run", "--rm", "--entrypoint", binary, image, "--version"],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise ToolchainCheckError(
            f"docker run --rm --entrypoint {binary} {image} --version exited {result.returncode}: "
            f"{result.stderr.strip()}"
        )
    return result.stdout


def check(*, recovery_image: str, server_image: str, run=subprocess.run) -> list[str]:
    """Returns a list of human-readable mismatches; empty means every client
    binary in `recovery_image` reports the same major.minor line as
    `server_image`'s `mysqld`."""
    server_output = docker_run_version(server_image, "mysqld", run=run)
    server_line = major_minor(server_output, label=f"{server_image} mysqld")

    problems: list[str] = []
    for binary in CLIENT_BINARIES:
        client_output = docker_run_version(recovery_image, binary, run=run)
        try:
            client_line = major_minor(client_output, label=f"{recovery_image} {binary}")
        except ToolchainCheckError as exc:
            problems.append(str(exc))
            continue
        if client_line != server_line:
            problems.append(
                f"{binary} in {recovery_image} reports {client_line}.x, "
                f"server {server_image} reports {server_line}.x"
            )
    return problems


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--recovery-image", required=True, help="Image built from db/recovery/Dockerfile")
    parser.add_argument(
        "--server-image",
        default=None,
        help="Overrides the pin read from db/RUNBOOK-db.md (the control case uses this to force a mismatch)",
    )
    args = parser.parse_args(argv)

    try:
        server_image = args.server_image or server_image_from_runbook()
        problems = check(recovery_image=args.recovery_image, server_image=server_image)
    except ToolchainCheckError as exc:
        print(f"check_toolchain_version: {exc}", file=sys.stderr)
        return 1

    if problems:
        for problem in problems:
            print(f"check_toolchain_version: {problem}", file=sys.stderr)
        return 1

    print(
        "check_toolchain_version: mysql, mysqldump and mysqlbinlog in "
        f"{args.recovery_image} all match the server line"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
