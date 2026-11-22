#!/usr/bin/env python3
"""Prove the broker tunnel grant against a real OpenSSH server, then break it.

Runs as root inside a throwaway Debian container with openssh-server,
openssh-client and python3 installed (demo-host-broker-tunnel-ci.yml starts
it). It never touches a real host. See render_broker_tunnel.md, "The proof".

For each case it installs what render_broker_tunnel.py renders (or a widened
copy), restarts sshd, and runs the probes:

  broker      -L to 127.0.0.1:8090 reaches the stand-in broker's /status
  other       -L to 127.0.0.1:8091 (a second listener) is refused
  sshd-port   -L to 127.0.0.1:22 is refused
  shell       a command gets no shell
  reverse     -R is refused
  file-check  check_authorized_keys passes the installed file

Every restriction is set twice (key and sshd), so widening one layer alone
leaves `other` green and widening both turns it red. The run exits 0 only
when every case gives exactly the expected result, red included.
"""

from __future__ import annotations

import http.client
import http.server
import os
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import render_broker_tunnel as rbt  # noqa: E402

BROKER_PORT = 8090
OTHER_PORT = 8091
BROKER_BODY = b"broker-status"
OTHER_BODY = b"not-the-broker"
SSH_TIMEOUT = 15
WIDE_KEY = 'permitopen="127.0.0.1:8090",permitopen="127.0.0.1:8091",permitopen="127.0.0.1:22"'
WIDE_SSHD = "PermitOpen 127.0.0.1:8090 127.0.0.1:8091 127.0.0.1:22"


@dataclass(frozen=True)
class Case:
    name: str
    widen_key: bool
    widen_sshd: bool
    # The probes expected to fail in this case; every other probe must pass.
    expected_red: frozenset[str]


CASES = (
    Case("grant as rendered", False, False, frozenset()),
    Case("sabotage: widen permitopen on the key only", True, False, frozenset({"file-check"})),
    Case("sabotage: widen PermitOpen in sshd only", False, True, frozenset()),
    Case(
        "sabotage: widen both",
        True,
        True,
        frozenset({"other", "sshd-port", "file-check"}),
    ),
)


class _Handler(http.server.BaseHTTPRequestHandler):
    body = b""

    def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
        self.send_response(200)
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()
        self.wfile.write(self.body)

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - the stdlib's name
        return


def serve(port: int, body: bytes) -> None:
    handler = type(f"Handler{port}", (_Handler,), {"body": body})
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()


def run(argv: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
    return subprocess.run(argv, capture_output=True, text=True, check=False, timeout=60, **kwargs)  # type: ignore[call-overload,no-any-return]


def must(argv: list[str]) -> str:
    result = run(argv)
    if result.returncode != 0:
        raise SystemExit(f"PROOF SETUP FAILED: {' '.join(argv)}: {result.stderr.strip()}")
    return result.stdout


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


class Lab:
    def __init__(self, work: str) -> None:
        self.work = work
        self.key = os.path.join(work, "client")
        must(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "proof", "-f", self.key])
        with open(self.key + ".pub", encoding="utf-8") as handle:
            self.public_key = handle.read()
        must(["ssh-keygen", "-A"])
        os.makedirs("/run/sshd", mode=0o755, exist_ok=True)
        try:
            pwd.getpwnam(rbt.ACCOUNT)
        except KeyError:
            must(
                [
                    "useradd", "--system", "--no-create-home", "--home-dir", "/nonexistent",
                    "--shell", rbt.NOLOGIN, rbt.ACCOUNT,
                ]
            )
        must(["usermod", "--lock", rbt.ACCOUNT])
        serve(BROKER_PORT, BROKER_BODY)
        serve(OTHER_PORT, OTHER_BODY)
        self.sshd: subprocess.Popen[str] | None = None

    def install(self, case: Case) -> None:
        keys = rbt.render_authorized_keys(self.public_key)
        dropin = rbt.render_sshd_dropin()
        if case.widen_key:
            keys = keys.replace(f'permitopen="{rbt.BROKER_OPEN}"', WIDE_KEY)
        if case.widen_sshd:
            dropin = dropin.replace(f"PermitOpen {rbt.BROKER_OPEN}", WIDE_SSHD)
        os.makedirs(rbt.AUTHORIZED_KEYS_DIR, mode=0o755, exist_ok=True)
        with open(rbt.AUTHORIZED_KEYS, "w", encoding="utf-8") as handle:
            handle.write(keys)
        os.chmod(rbt.AUTHORIZED_KEYS, 0o644)
        with open(rbt.SSHD_DROPIN, "w", encoding="utf-8") as handle:
            handle.write(dropin)
        must(["/usr/sbin/sshd", "-t"])
        effective = must(["/usr/sbin/sshd", "-T", "-C", f"user={rbt.ACCOUNT},host=proof,addr=127.0.0.1"])
        resolved = {}
        for line in effective.splitlines():
            keyword, _, value = line.partition(" ")
            resolved.setdefault(keyword, value)
        if not case.widen_sshd:
            wrong = {k: resolved.get(k) for k, v in rbt.expected_effective().items() if resolved.get(k) != v}
            if wrong:
                raise SystemExit(f"PROOF SETUP FAILED: sshd -T differs from the rendered grant: {wrong}")
        self.restart_sshd()

    def restart_sshd(self) -> None:
        if self.sshd is not None:
            self.sshd.terminate()
            self.sshd.wait(timeout=10)
        self.sshd = subprocess.Popen(["/usr/sbin/sshd", "-D", "-e"], stderr=subprocess.DEVNULL, text=True)
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                socket.create_connection(("127.0.0.1", 22), timeout=1).close()
                return
            except OSError:
                time.sleep(0.2)
        raise SystemExit("PROOF SETUP FAILED: sshd did not start listening")

    def ssh_argv(self, *extra: str) -> list[str]:
        return [
            "ssh", "-F", "none", "-i", self.key, "-o", "IdentitiesOnly=yes", "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
            "-o", "LogLevel=ERROR", "-o", "ExitOnForwardFailure=yes", *extra,
            f"{rbt.ACCOUNT}@127.0.0.1",
        ]

    def through_forward(self, destination: str) -> bytes | None:
        """The body fetched through `-L` to the destination, or None when the forward gave nothing."""
        local = free_port()
        tunnel = subprocess.Popen(
            self.ssh_argv("-N", "-L", f"127.0.0.1:{local}:{destination}"),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + SSH_TIMEOUT
            while time.monotonic() < deadline:
                if tunnel.poll() is not None:
                    return None
                try:
                    socket.create_connection(("127.0.0.1", local), timeout=1).close()
                    break
                except OSError:
                    time.sleep(0.2)
            else:
                return None
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{local}/status", timeout=5) as reply:  # noqa: S310 - loopback only
                    return bytes(reply.read())
            except (urllib.error.URLError, OSError, http.client.HTTPException):
                return None
        finally:
            tunnel.terminate()
            tunnel.wait(timeout=10)

    def probe_broker(self) -> bool:
        return self.through_forward(f"127.0.0.1:{BROKER_PORT}") == BROKER_BODY

    def probe_other(self) -> bool:
        return self.through_forward(f"127.0.0.1:{OTHER_PORT}") is None

    def probe_sshd_port(self) -> bool:
        # The forward to 22 is refused when nothing comes back through it; an
        # SSH banner back means sshd let the key open its own port.
        local = free_port()
        tunnel = subprocess.Popen(
            self.ssh_argv("-N", "-L", f"127.0.0.1:{local}:127.0.0.1:22"),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + SSH_TIMEOUT
            while time.monotonic() < deadline:
                try:
                    with socket.create_connection(("127.0.0.1", local), timeout=1) as sock:
                        sock.settimeout(5)
                        try:
                            banner = sock.recv(64)
                        except OSError:
                            banner = b""
                        return not banner.startswith(b"SSH-")
                except OSError:
                    if tunnel.poll() is not None:
                        return True
                    time.sleep(0.2)
            return True
        finally:
            tunnel.terminate()
            tunnel.wait(timeout=10)

    def probe_shell(self) -> bool:
        result = run(self.ssh_argv("id"))
        return "uid=" not in result.stdout and result.returncode != 0

    def probe_reverse(self) -> bool:
        result = run(self.ssh_argv("-N", "-R", f"127.0.0.1:{free_port()}:127.0.0.1:{BROKER_PORT}"))
        return result.returncode != 0

    def probe_file_check(self) -> bool:
        with open(rbt.AUTHORIZED_KEYS, encoding="utf-8") as handle:
            return rbt.check_authorized_keys(handle.read()) == []

    def stop(self) -> None:
        if self.sshd is not None:
            self.sshd.terminate()
            self.sshd.wait(timeout=10)


def main() -> int:
    if os.geteuid() != 0 or not os.path.exists("/.dockerenv"):
        print("prove_broker_tunnel: run as root in a throwaway container only", file=sys.stderr)
        return 2
    work = tempfile.mkdtemp(prefix="broker-tunnel-proof-")
    lab = Lab(work)
    probes: dict[str, Callable[[], bool]] = {
        "broker": lab.probe_broker,
        "other": lab.probe_other,
        "sshd-port": lab.probe_sshd_port,
        "shell": lab.probe_shell,
        "reverse": lab.probe_reverse,
        "file-check": lab.probe_file_check,
    }
    failures = []
    try:
        for case in CASES:
            print(f"\n== {case.name}")
            lab.install(case)
            for name, probe in probes.items():
                green = probe()
                expected_green = name not in case.expected_red
                verdict = "ok" if green == expected_green else "UNEXPECTED"
                print(f"  {name:<10} {'green' if green else 'RED':<5} (expected {'green' if expected_green else 'red'}) {verdict}")
                if green != expected_green:
                    failures.append(f"{case.name}: {name}")
    finally:
        lab.stop()
        shutil.rmtree(work, ignore_errors=True)
    if failures:
        print("\nPROOF FAILED: " + "; ".join(failures), file=sys.stderr)
        return 1
    print("\nPROOF PASSED: the grant holds, and only widening both layers opens another port")
    return 0


if __name__ == "__main__":
    sys.exit(main())
