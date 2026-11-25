#!/usr/bin/env python3
"""Write the newest attested tenant image digest as a Prometheus textfile.

Usage:
    tenant_image_gauge.py --digest sha256:<64 hex> --metrics PATH [--now EPOCH]

Run by registry-push.yml after the attest job is green, to keep the file on the
`state/tenant-image` branch, which the monitoring host scrapes. Exit 1 on a
digest that is not exactly `sha256:` and 64 lowercase hex digits (nothing is
written), 2 on a usage error. Fixed code only: no model, no network.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
import tempfile
import time
from pathlib import Path

DIGEST = re.compile(r"\Asha256:[0-9a-f]{64}\Z")
INFO = "ghost_platform_tenant_image_info"
STAMP = "ghost_platform_tenant_image_last_success_timestamp_seconds"


def render(digest: str, now: int) -> str:
    """The textfile for one digest. A digest that is not well formed raises ValueError."""
    if not DIGEST.match(digest):
        raise ValueError("digest must be sha256: and 64 lowercase hex digits")
    if now <= 0:
        raise ValueError("timestamp must be a positive epoch second")
    return (
        f"# HELP {INFO} The newest tenant image digest that passed the scan and was attested.\n"
        f"# TYPE {INFO} gauge\n"
        f'{INFO}{{digest="{digest}"}} 1\n'
        f"# HELP {STAMP} Unix time of the run that recorded it.\n"
        f"# TYPE {STAMP} gauge\n"
        f"{STAMP} {now}\n"
    )


def write_atomically(path: Path, text: str) -> None:
    """Replace the file in one step, so a scrape never reads half of it."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name + ".")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp, path)
    except BaseException:
        os.unlink(tmp)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--digest", required=True)
    parser.add_argument("--metrics", required=True, type=Path)
    parser.add_argument("--now", type=int, default=None)
    args = parser.parse_args(argv)
    now = int(time.time()) if args.now is None else args.now
    try:
        text = render(args.digest, now)
    except ValueError as err:
        print(f"tenant_image_gauge: {err}", file=sys.stderr)
        return 1
    write_atomically(args.metrics, text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
