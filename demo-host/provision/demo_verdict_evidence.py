#!/usr/bin/env python3
"""The check a demo go-live or a checkpoint's evidence must pass before it may
say the demo's upload route scans anything: every slot's broker status reports a
production verdict source, read from what render-core rendered.

Usage: demo_verdict_evidence.py --broker-url URL

Exit 0 and one `VERDICT SOURCE WIRED:` line naming every slot checked, or exit 1
and one `REFUSED:` line naming every slot that is not wired. Fails closed on an
unreachable broker or an unreadable answer. See demo_verdict_evidence.md.
"""

from __future__ import annotations

import argparse
import sys

from demo_go_live import GoLiveRefused, check_verdict_source
from render_slot_sudoers import SLOT_NAMES


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--broker-url", required=True)
    args = parser.parse_args(argv)
    try:
        check_verdict_source(args.broker_url)
    except GoLiveRefused as refusal:
        print(f"REFUSED: {refusal}", file=sys.stderr)
        return 1
    print(f"VERDICT SOURCE WIRED: slots {', '.join(SLOT_NAMES)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
