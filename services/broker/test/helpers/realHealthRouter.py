"""Starts the real demo-host health router for the broker's tests.

Imports demo-host/provision/health_router.py unchanged and builds the same
server its main() builds, on an OS-chosen loopback port instead of the slot's
fixed 10100+slot so parallel test files cannot collide. Prints that port as
the first line of stdout, then serves until killed.

Usage: realHealthRouter.py <slot> <socket-root>
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

PROVISION = Path(__file__).resolve().parents[4] / "demo-host" / "provision"
sys.path.insert(0, str(PROVISION))

import health_router  # noqa: E402


def main() -> int:
    slot, socket_root = sys.argv[1], sys.argv[2]
    server = health_router.make_server(slot, root=socket_root, owner_uid=os.getuid(), port=0)
    print(server.server_address[1], flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
