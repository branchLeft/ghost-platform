"""Cleanup of the csp and widgets proof scripts, with docker, node, pnpm and curl stubbed.

No container, network or browser is started. Every call goes to one stub that
records its argv and keeps a state file of the names it has created.
"""

import os
import signal
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
CSP_SCRIPT = REPO / "csp" / "proof" / "run-proof.sh"
WIDGETS_SCRIPT = REPO / "widgets" / "proof" / "run-proof.sh"

STUB = """#!/usr/bin/python3 -I
import json
import os
import sys
import time

STATE = os.environ["STUB_STATE"]
LOG = os.environ["STUB_LOG"]
FAIL_RM = os.environ.get("STUB_FAIL_RM") == "1"
FAIL_RM_RED = os.environ.get("STUB_FAIL_RM_RED") == "1"
LABEL = STATE + ".label"


def load():
    try:
        with open(STATE) as f:
            return [line.strip() for line in f if line.strip()]
    except FileNotFoundError:
        return []


def save(names):
    with open(STATE, "w") as f:
        for n in names:
            f.write(n + "\\n")


def matching(names, pattern):
    if pattern.startswith("^"):
        p = pattern[1:]
        if p.endswith("$"):
            return [n for n in names if n == p[:-1]]
        return [n for n in names if n.startswith(p)]
    return [n for n in names if pattern in n]


name = os.path.basename(sys.argv[0])
args = sys.argv[1:]
with open(LOG, "a") as f:
    f.write(json.dumps([name] + args) + "\\n")

if name == "docker":
    cmd = args[0] if args else ""
    if cmd == "ps" or (cmd == "network" and args[1:2] == ["ls"]):
        pattern = args[args.index("--filter") + 1].split("=", 1)[1]
        for n in matching(load(), pattern):
            print(n)
        sys.exit(0)
    if cmd == "run":
        save(load() + [args[args.index("--name") + 1]])
        sys.exit(0)
    if cmd == "network" and args[1:2] == ["create"]:
        save(load() + [args[2]])
        sys.exit(0)
    if cmd == "rm" or (cmd == "network" and args[1:2] == ["rm"]):
        names = args[2:] if cmd == "network" else [a for a in args[1:] if not a.startswith("-")]
        last_label = open(LABEL).read() if os.path.exists(LABEL) else ""
        if FAIL_RM or (FAIL_RM_RED and last_label.startswith("RED")):
            print("Error: removal refused by stub", file=sys.stderr)
            sys.exit(1)
        save([n for n in load() if n not in names])
        sys.exit(0)
    sys.exit(0)

if name == "node":
    if os.environ.get("PROOF_LABEL"):
        with open(LABEL, "w") as f:
            f.write(os.environ["PROOF_LABEL"])
    time.sleep(float(os.environ.get("STUB_NODE_SLEEP", "0")))
sys.exit(0)
"""


class Harness:
    def __init__(self, tmp):
        self.bin = Path(tmp) / "bin"
        self.bin.mkdir()
        stub = self.bin / "stub.py"
        stub.write_text(STUB)
        stub.chmod(0o755)
        for name in ("docker", "node", "pnpm", "curl"):
            os.symlink(stub, self.bin / name)
        self.state = Path(tmp) / "state"
        self.log = Path(tmp) / "log"

    def env(self, fail_rm=False, node_sleep=0, fail_rm_red=False):
        e = dict(os.environ)
        e["PATH"] = f"{self.bin}{os.pathsep}{e['PATH']}"
        e["STUB_STATE"] = str(self.state)
        e["STUB_LOG"] = str(self.log)
        e["PNPM"] = str(self.bin / "pnpm")
        e["STUB_NODE_SLEEP"] = str(node_sleep)
        for key, on in (("STUB_FAIL_RM", fail_rm), ("STUB_FAIL_RM_RED", fail_rm_red)):
            if on:
                e[key] = "1"
            else:
                e.pop(key, None)
        return e

    def seed(self, names):
        self.state.write_text("".join(n + "\n" for n in names))

    def left(self):
        return self.state.read_text().split() if self.state.exists() else []

    def run(self, script, **kw):
        return subprocess.run(
            ["sh", str(script)],
            check=False,
            cwd=str(REPO),
            env=self.env(**kw),
            capture_output=True,
            text=True,
            timeout=300,
        )


class ProofCleanupTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.h = Harness(self._tmp.name)

    def tearDown(self):
        self._tmp.cleanup()

    def assert_failed_removal_reported(self, script):
        self.h.seed([])
        r = self.h.run(script, fail_rm=True)
        self.assertIn("CLEANUP FAILED", r.stderr)
        self.assertNotEqual(r.returncode, 0)

    def assert_clean_run_leaves_nothing(self, script, prefix):
        self.h.seed([])
        r = self.h.run(script)
        self.assertNotIn("CLEANUP FAILED", r.stderr)
        self.assertEqual([n for n in self.h.left() if n.startswith(prefix)], [])

    def assert_stale_swept(self, script, stale):
        self.h.seed(stale)
        self.h.run(script)
        self.assertEqual([n for n in self.h.left() if n in stale], [])

    def assert_stale_sweep_failure_reported(self, script, stale):
        self.h.seed(stale)
        r = self.h.run(script, fail_rm=True)
        self.assertIn("could not remove", r.stderr)
        self.assertNotEqual(r.returncode, 0)

    def assert_term_cleans_up(self, script, prefix):
        self.h.seed([])
        proc = subprocess.Popen(
            ["sh", str(script)],
            cwd=str(REPO),
            env=self.h.env(node_sleep=3),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        ghost = f"{prefix}-ghost-{proc.pid}"
        deadline = time.time() + 120
        while ghost not in self.h.left():
            if time.time() > deadline or proc.poll() is not None:
                proc.kill()
                self.fail("the script never created its ghost container")
            time.sleep(0.2)
        proc.send_signal(signal.SIGTERM)
        proc.wait(timeout=120)
        mine = [n for n in self.h.left() if n.endswith(f"-{proc.pid}")]
        self.assertEqual(mine, [], "containers or networks left after SIGTERM")


class CspProof(ProofCleanupTests):
    STALE = (
        "csp-proof-ghost-424242",
        "csp-proof-origin-424242",
        "csp-proof-net-424242",
    )

    def test_failed_removal_is_reported(self):
        self.assert_failed_removal_reported(CSP_SCRIPT)

    def test_clean_run_leaves_nothing(self):
        self.assert_clean_run_leaves_nothing(CSP_SCRIPT, "csp-proof-")

    def test_stale_leftovers_are_swept(self):
        self.assert_stale_swept(CSP_SCRIPT, self.STALE)

    def test_stale_sweep_failure_is_reported(self):
        self.assert_stale_sweep_failure_reported(CSP_SCRIPT, self.STALE)

    def test_term_runs_cleanup(self):
        self.assert_term_cleans_up(CSP_SCRIPT, "csp-proof")


class WidgetsProof(ProofCleanupTests):
    STALE = (
        "widgets-proof-ghost-424242",
        "widgets-proof-origin-424242",
        "widgets-proof-net-424242",
    )

    def test_failed_removal_is_reported(self):
        self.assert_failed_removal_reported(WIDGETS_SCRIPT)

    def test_clean_run_leaves_nothing(self):
        self.assert_clean_run_leaves_nothing(WIDGETS_SCRIPT, "widgets-proof-")

    def test_stale_leftovers_are_swept(self):
        self.assert_stale_swept(WIDGETS_SCRIPT, self.STALE)

    def test_stale_sweep_failure_is_reported(self):
        self.assert_stale_sweep_failure_reported(WIDGETS_SCRIPT, self.STALE)

    def test_term_runs_cleanup(self):
        self.assert_term_cleans_up(WIDGETS_SCRIPT, "widgets-proof")

    def test_red_pass_with_refused_removal_is_not_proof_ok(self):
        # Every capture passes, so each sabotage pass is undetected; the RED
        # passes' removals are refused. The run must not claim a proof.
        self.h.seed([])
        r = self.h.run(WIDGETS_SCRIPT, fail_rm_red=True)
        self.assertIn("CLEANUP FAILED", r.stderr)
        self.assertNotIn("PROOF OK", r.stdout)
        self.assertNotEqual(r.returncode, 0)


if __name__ == "__main__":
    unittest.main()
