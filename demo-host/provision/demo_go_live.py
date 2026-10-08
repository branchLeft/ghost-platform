#!/usr/bin/env python3
"""The demo host's go-live step: refuse to open the demo to visitors while any
test stand-in is loaded by the broker, or while the clock is unsynchronised.

Usage: demo_go_live.py --broker-url URL --caddyfile SRC --install DEST

"Opening" means placing the rendered Caddyfile where the edge reads it. The
check runs first and nothing is written on a refusal. See demo_go_live.md.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import urllib.request
from typing import Callable, Sequence

from render_demo_edge import write_generated_file
from render_slot_sudoers import SLOT_NAMES

STATUS_TIMEOUT_SECONDS = 5


class GoLiveRefused(Exception):
    """The demo must not be opened; the message says why, in one line."""


def fetch_status(broker_url: str, slot: str) -> object:
    url = f"{broker_url.rstrip('/')}/status/{slot}"
    with urllib.request.urlopen(url, timeout=STATUS_TIMEOUT_SECONDS) as response:  # noqa: S310
        return json.loads(response.read())


def clock_is_synchronised() -> bool:
    result = subprocess.run(
        ["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
        capture_output=True, text=True, timeout=10, check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == "yes"


def check_seams(
    broker_url: str,
    slots: Sequence[str] = SLOT_NAMES,
    fetch: Callable[[str, str], object] = None,  # type: ignore[assignment]
) -> None:
    """Refuses unless every slot's status reports both seam lists present and
    empty. Fails closed: an unreachable broker, a body that is not an object,
    or a list that is missing is a refusal, never an assumption of clean."""
    fetch = fetch or fetch_status
    for slot in slots:
        try:
            status = fetch(broker_url, slot)
        except Exception as error:  # any failure to read is a refusal
            raise GoLiveRefused(f"slot {slot}: broker status unreadable ({type(error).__name__})") from error
        if not isinstance(status, dict):
            raise GoLiveRefused(f"slot {slot}: broker status is not an object")
        for key, why in (("notReal", "test stand-in loaded"), ("interim", "interim module loaded")):
            names = status.get(key)
            if not isinstance(names, list) or not all(isinstance(n, str) for n in names):
                raise GoLiveRefused(f"slot {slot}: broker status carries no usable {key} list")
            if names:
                raise GoLiveRefused(f"slot {slot}: {why}: {', '.join(sorted(names))}")


def go_live(
    broker_url: str,
    caddyfile_src: str,
    install_path: str,
    *,
    fetch: Callable[[str, str], object] | None = None,
    clock: Callable[[], bool] | None = None,
) -> None:
    # Resolved at call time, so a caller (or a test) that replaces the module's
    # own reader is honoured.
    check_seams(broker_url, fetch=fetch or fetch_status)
    if not (clock or clock_is_synchronised)():
        raise GoLiveRefused("the host clock is not synchronised (gate cookies and break-glass tokens expire)")
    with open(caddyfile_src, encoding="utf-8") as handle:
        content = handle.read()
    write_generated_file(install_path, content)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--broker-url", required=True)
    parser.add_argument("--caddyfile", required=True)
    parser.add_argument("--install", required=True)
    args = parser.parse_args(argv)
    try:
        go_live(args.broker_url, args.caddyfile, args.install)
    except GoLiveRefused as refusal:
        print(f"REFUSED: {refusal}", file=sys.stderr)
        return 1
    print(f"demo opened: {os.path.abspath(args.install)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
