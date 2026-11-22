"""The node-env gate: the image's own default NODE_ENV must be production.

Runs the candidate image with no NODE_ENV override and reads the value the
node process reports from inside the container. Exit 0 only when that value is
exactly "production". Anything else, including an unset variable, exits 1.

Usage: python3 gate-set/node_env_gate.py <image-ref>
"""

from __future__ import annotations

import subprocess
import sys
from collections.abc import Sequence
from typing import Final

EXPECTED: Final[str] = "production"
UNSET: Final[str] = "<unset>"
PRINT_VALUE: Final[str] = (
    "process.stdout.write(process.env.NODE_ENV === undefined "
    "? '<unset>' : process.env.NODE_ENV)"
)
TIMEOUT_SECONDS: Final[int] = 60


def docker_argv(image: str) -> list[str]:
    """The docker command that prints NODE_ENV from a fresh container."""
    return [
        "docker",
        "run",
        "--rm",
        "--entrypoint",
        "node",
        image,
        "-e",
        PRINT_VALUE,
    ]


def judge(reported: str) -> bool:
    """True only for the exact value the image must report."""
    return reported == EXPECTED


def read_value(image: str) -> tuple[int, str]:
    """Run the container and return (exit code, value it printed)."""
    completed = subprocess.run(
        docker_argv(image),
        capture_output=True,
        text=True,
        timeout=TIMEOUT_SECONDS,
        check=False,
    )
    return completed.returncode, completed.stdout.strip()


def main(argv: Sequence[str]) -> int:
    if len(argv) != 2 or not argv[1]:
        print("usage: node_env_gate.py <image-ref>", file=sys.stderr)
        return 2
    code, reported = read_value(argv[1])
    if code != 0:
        print(f"node-env: docker run exited {code}", file=sys.stderr)
        return 1
    if judge(reported):
        print(f"node-env: process reports {EXPECTED}")
        return 0
    print(f"node-env: process reports {reported!r}, not {EXPECTED!r}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
