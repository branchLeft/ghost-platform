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

CLASSIFY_REFUSED = "    if isinstance(error, (ConnectionRefusedError, TimeoutError)) or error.errno in REFUSED_ERRNOS:\n"

# (name, [(old text, new text), ...]) -- each edits the program only, in a scratch copy.
# Every old text must occur exactly once in the program.
SABOTAGES: list[tuple[str, list[tuple[str, str]]]] = [
    # Item 1: only the four named errors are refusals; every other error is UNCHECKED.
    ("a completed connection is not reported as reached",
     [('        with socket.create_connection((route.host, route.port), timeout=timeout):\n            return Outcome("REACHED", route.label)',
       '        with socket.create_connection((route.host, route.port), timeout=timeout):\n            return Outcome("REFUSED", route.label)')]),
    ("every OS error is a refusal (the verdict's High)",
     [(CLASSIFY_REFUSED, "    if True:\n")]),
    ("a name that does not resolve is a refusal",
     [(CLASSIFY_REFUSED,
       "    if isinstance(error, (ConnectionRefusedError, TimeoutError, socket.gaierror)) or error.errno in REFUSED_ERRNOS:\n")]),
    ("a denied connect (EPERM/EACCES) is a refusal",
     [(CLASSIFY_REFUSED,
       "    if isinstance(error, (ConnectionRefusedError, TimeoutError)) or error.errno in REFUSED_ERRNOS or isinstance(error, PermissionError):\n")]),
    ("a timeout is not a refusal",
     [(CLASSIFY_REFUSED, "    if isinstance(error, ConnectionRefusedError) or error.errno in REFUSED_ERRNOS:\n")]),
    ("an unreachable network is not a refusal",
     [(CLASSIFY_REFUSED, "    if isinstance(error, (ConnectionRefusedError, TimeoutError)):\n")]),
    ("an UNCHECKED route counts as a pass",
     [('    if any(outcome.verdict == "UNCHECKED" for outcome in outcomes):',
       "    if False:")]),
    # Item 2: the positive control must open, or the probe stops with no verdict.
    ("the control is not required to open",
     [('    if control_outcome.verdict != "REACHED":', "    if False:")]),
    # Item 3: every route class is mandatory; --expect-uid is required.
    ("the gateway is optional",
     [('"--gateway", required=True,', '"--gateway", default="127.0.0.1",')]),
    ("the peer ports are optional",
     [('"--peer-port", type=parse_port, action="append", required=True,',
       '"--peer-port", type=parse_port, action="append", default=[],')]),
    ("the host ports are optional",
     [('"--host-port", type=parse_port, action="append", required=True,',
       '"--host-port", type=parse_port, action="append", default=[],')]),
    ("the estate addresses are optional",
     [('"--estate", type=parse_estate, action="append", required=True,',
       '"--estate", type=parse_estate, action="append", default=[],')]),
    ("the spool address is optional",
     [('parser.add_argument("--spool-address", required=True)',
       'parser.add_argument("--spool-address", default="127.0.0.1")')]),
    ("the spool ports are optional",
     [('"--spool-port", type=parse_port, action="append", required=True)',
       '"--spool-port", type=parse_port, action="append", default=[])')]),
    ("the file paths are optional",
     [('"--file-path", action="append", required=True,', '"--file-path", action="append", default=[],')]),
    ("--expect-uid is optional",
     [('"--expect-uid", type=int, required=True,', '"--expect-uid", type=int, default=None,'),
      ("    if euid != args.expect_uid:\n", "    if args.expect_uid is not None and euid != args.expect_uid:\n")]),
    # Gateway control: a route through the bridge gateway is read only when the gateway's own control opened.
    ("a route through the bridge gateway is probed when its control did not open (REFUSED instead of UNCHECKED)",
     [("        if route.via_gateway and not gateway_ok:", "        if False:")]),
    ("the gateway control port is optional",
     [('"--gateway-control-port", type=parse_port, required=True,', '"--gateway-control-port", type=parse_port, default=1,')]),
    # Search without read: a directory whose listing is denied but which is searchable is UNCHECKED, never REFUSED.
    ("a search-only directory is REFUSED (its denied listing taken as isolation)",
     [("        if os.path.isdir(route.path) and os.access(route.path, os.X_OK, effective_ids=True):", "        if False:")]),
    # UDP silence: a UDP route is tried only after the UDP control answered; otherwise it reads UNCHECKED.
    ("a UDP route is tried, and silence read as REFUSED, before the UDP control answered",
     [("    if udp_ok:\n        outcomes.append(probe_udp(udp_route, args.timeout))\n",
       "    if True:\n        outcomes.append(probe_udp(udp_route, args.timeout))\n")]),
    # IPv6 and UDP DNS: each is its own route class, probed and printed.
    ("the IPv6 routes are not probed",
     [('    for address, port in ipv6:\n        routes.append(TcpRoute(f"IPv6 route [{address}]:{port}", address, port))\n', "")]),
    ("the UDP DNS route to the resolver is not probed",
     [("    outcomes.append(probe_udp(udp_route, args.timeout))\n", "")]),
    ("an answered UDP route is not REACHED",
     [('            sock.recv(512)\n        return Outcome("REACHED", route.label)', '            sock.recv(512)\n        return Outcome("REFUSED", route.label)')]),
    # Guarantees from the first cycle, kept.
    ("a readable directory is not reported as reached",
     [('        return Outcome("REACHED", route.label)\n    except PermissionError:',
       '        return Outcome("REFUSED", route.label)\n    except PermissionError:')]),
    ("a missing path counts as refused",
     [('    except OSError as error:\n        return Outcome("UNCHECKED", route.label, type(error).__name__)',
       '    except OSError as error:\n        return Outcome("REFUSED", route.label)')]),
    ("the spool's allowed port is probed too",
     [("        if port == spool_allowed_port:\n            continue  # the one drain/submit port is the control, not a route to refuse\n",
       "")]),
    ("the public routes are dropped",
     [("    for label, host, port in PUBLIC_ROUTES:\n        routes.append(TcpRoute(label, host, port))\n", "")]),
    ("slot ports are probed on loopback only, not the bridge gateway",
     [('        routes.append(TcpRoute(f"slot B port {port} on bridge gateway", gateway, port, via_gateway=True))\n', "")]),
    ("running as root is allowed",
     [("    if euid == 0:\n", "    if False:\n")]),
    ("a uid other than the expected one is allowed",
     [("    if euid != args.expect_uid:\n", "    if False:\n")]),
    ("a reached route still exits zero",
     [('    if any(outcome.verdict == "REACHED" for outcome in outcomes):\n        return EXIT_REACHED\n', "")]),
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
        for index, (name, edits) in enumerate(SABOTAGES):
            copy = scratch_copy(base / f"s{index}")
            text = (copy / PROGRAM).read_text()
            if any(text.count(old) != 1 for old, _ in edits):
                print(f"sabotage: '{name}' does not apply exactly once; the program changed under it")
                failures += 1
                continue
            for old, new in edits:
                text = text.replace(old, new)
            (copy / PROGRAM).write_text(text)
            if run_suite(copy) == 0:
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
