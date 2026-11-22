#!/usr/bin/env python3
"""Sabotage proof for branchleft_demo_isolation_probe: break each guarantee in a scratch copy and
require the suite red, then the untouched copy green.

Usage: sabotage_branchleft_demo_isolation_probe.py
"""

from __future__ import annotations

import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).parent
PROGRAM = "branchleft_demo_isolation_probe.py"
TEST = "test_branchleft_demo_isolation_probe.py"

# (name, old text, new text) -- each edits the program only, in a scratch copy.
SABOTAGES = [
    ("a completed connection is not reported as reached",
     '            return Outcome("REACHED", route.label)\n    except (OSError, socket.timeout):',
     '            return Outcome("REFUSED", route.label)\n    except (OSError, socket.timeout):'),
    ("a dropped or timed-out route is reported as reached",
     '    except (OSError, socket.timeout):\n        return Outcome("REFUSED", route.label)',
     '    except (OSError, socket.timeout):\n        return Outcome("REACHED", route.label)'),
    ("a readable directory is not reported as reached",
     "        if os.path.isdir(route.path):\n            os.listdir(route.path)\n        else:\n            with open(route.path, \"rb\") as handle:\n                handle.read(1)\n        return Outcome(\"REACHED\", route.label)",
     "        if os.path.isdir(route.path):\n            os.listdir(route.path)\n        else:\n            with open(route.path, \"rb\") as handle:\n                handle.read(1)\n        return Outcome(\"REFUSED\", route.label)"),
    ("a missing path counts as refused",
     '    except OSError as error:\n        return Outcome("UNCHECKED", route.label, type(error).__name__)',
     '    except OSError as error:\n        return Outcome("REFUSED", route.label)'),
    ("the spool's allowed port is probed too",
     "            if port == spool_allowed_port:\n                continue  # the one drain/submit port is the only allowed route\n",
     ""),
    ("the public routes are dropped",
     "    for label, host, port in PUBLIC_ROUTES:\n        routes.append(TcpRoute(label, host, port))\n",
     ""),
    ("slot ports are probed on loopback only, not the bridge gateway",
     '        routes.append(TcpRoute(f"slot B port {port} on bridge gateway", gateway, port))\n',
     ""),
    ("running as root is allowed",
     "    if euid == 0:\n",
     "    if False:\n"),
    ("a uid other than the expected one is allowed",
     "    if args.expect_uid is not None and euid != args.expect_uid:\n",
     "    if False:\n"),
    ("a reached route still exits zero",
     "    if any(outcome.verdict == \"REACHED\" for outcome in outcomes):\n        return EXIT_REACHED\n",
     ""),
    ("an unchecked route passes",
     '    if not outcomes or any(outcome.verdict == "UNCHECKED" for outcome in outcomes):',
     "    if not outcomes:"),
]


def run_suite(directory: pathlib.Path) -> int:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "-q", "test_branchleft_demo_isolation_probe"],
        cwd=directory, capture_output=True, text=True, timeout=300, check=False,
    )
    return result.returncode


def scratch_copy(root: pathlib.Path) -> pathlib.Path:
    root.mkdir(parents=True)
    for name in (PROGRAM, TEST):
        shutil.copy(HERE / name, root / name)
    return root


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        base = pathlib.Path(tmp)

        clean = scratch_copy(base / "clean")
        if run_suite(clean) != 0:
            print("sabotage: the untouched copy is not green; nothing else can be concluded")
            return 1
        print("sabotage: untouched copy green")

        failures = 0
        for index, (name, old, new) in enumerate(SABOTAGES):
            copy = scratch_copy(base / f"s{index}")
            text = (copy / PROGRAM).read_text()
            if text.count(old) != 1:
                print(f"sabotage: '{name}' does not apply exactly once; the program changed under it")
                failures += 1
                continue
            (copy / PROGRAM).write_text(text.replace(old, new))
            code = run_suite(copy)
            if code == 0:
                print(f"sabotage: '{name}' left the suite green; the suite misses it")
                failures += 1
            else:
                print(f"sabotage: '{name}' -> red (as required)")

        if failures:
            print(f"sabotage: {failures} sabotage(s) not caught")
            return 1
        print(f"sabotage: all {len(SABOTAGES)} guarantees caught")
        return 0


if __name__ == "__main__":
    sys.exit(main())
