#!/usr/bin/env python3
"""Tests for probe_tunnel_controls.sh direct-dial mode. See probe_tunnel_controls.md."""

from __future__ import annotations

import os
import shlex
import shutil
import socket
import stat
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "probe_tunnel_controls.sh")
RUN_TIMEOUT_SECONDS = 30
SHORT_DIAL_TIMEOUT = "2"
LOOPBACK = "127.0.0.1"
USAGE_EXIT = 2
USAGE_TEXT = "direct-dial --control <host:port> --target <host:port>"


def run_probe(
    args: list[str],
    dial_timeout: str | None = SHORT_DIAL_TIMEOUT,
    extra_env: dict[str, str] | None = None,
    path_prefix: str | None = None,
) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    env.pop("PROBE_DIAL_TIMEOUT", None)
    if dial_timeout is not None:
        env["PROBE_DIAL_TIMEOUT"] = dial_timeout
    if extra_env is not None:
        env.update(extra_env)
    if path_prefix is not None:
        env["PATH"] = f"{path_prefix}{os.pathsep}{env['PATH']}"
    return subprocess.run(
        ["bash", SCRIPT, *args],
        env=env,
        capture_output=True,
        text=True,
        timeout=RUN_TIMEOUT_SECONDS,
        check=False,
    )


def open_listener(test: unittest.TestCase) -> str:
    """Listens on loopback and never accepts, so the kernel completes connects from the backlog."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    test.addCleanup(sock.close)
    sock.bind((LOOPBACK, 0))
    sock.listen()
    return f"{LOOPBACK}:{sock.getsockname()[1]}"


def closed_port(test: unittest.TestCase) -> str:
    """Binds loopback and never listens, so connects are refused and nothing else can take the port."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    test.addCleanup(sock.close)
    sock.bind((LOOPBACK, 0))
    return f"{LOOPBACK}:{sock.getsockname()[1]}"


def last_line(text: str) -> str:
    lines = text.splitlines()
    return lines[-1] if lines else ""


def port_of(spec: str) -> int:
    return int(spec.rsplit(":", 1)[1])


def timeout_shim(test: unittest.TestCase) -> tuple[str, str]:
    """Returns (shim directory, record file). The shim logs each timeout call's duration, then runs the real timeout."""
    real_timeout = shutil.which("timeout")
    if real_timeout is None:
        test.skipTest("timeout(1) is not installed")
    tmp = tempfile.TemporaryDirectory()
    test.addCleanup(tmp.cleanup)
    record = os.path.join(tmp.name, "timeout-calls.txt")
    shim = os.path.join(tmp.name, "timeout")
    with open(shim, "w", encoding="utf-8") as handle:
        handle.write(
            "#!/usr/bin/env bash\n"
            f"printf '%s\\n' \"$1\" >> {shlex.quote(record)}\n"
            f"exec {shlex.quote(real_timeout)} \"$@\"\n"
        )
    os.chmod(shim, os.stat(shim).st_mode | stat.S_IXUSR)
    return tmp.name, record


def read_lines(path: str) -> list[str]:
    with open(path, encoding="utf-8") as handle:
        return handle.read().splitlines()


class DirectDialTest(unittest.TestCase):
    def assert_usage_error(self, args: list[str]) -> None:
        result = run_probe(args)
        self.assertEqual(result.returncode, USAGE_EXIT, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIn("usage:", result.stderr)
        self.assertIn(USAGE_TEXT, result.stderr)

    def test_closed_target_with_open_control_passes(self) -> None:
        control = open_listener(self)
        target = closed_port(self)
        result = run_probe(["direct-dial", "--control", control, "--target", target])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"PASS direct-dial control: {control} accepted a connection", result.stdout)
        self.assertIn(f"PASS direct-dial: a connection to {target} was not accepted", result.stdout)
        self.assertEqual(last_line(result.stdout), "GREEN: every probe passed")

    def test_open_target_still_fails(self) -> None:
        control = open_listener(self)
        target = open_listener(self)
        result = run_probe(["direct-dial", "--control", control, "--target", target])
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"FAIL direct-dial: a connection to {target} was accepted", result.stdout)
        self.assertEqual(last_line(result.stdout), "RED: 1 probe(s) failed")

    def test_unreachable_control_fails_every_target(self) -> None:
        control = closed_port(self)
        target = closed_port(self)
        result = run_probe(["direct-dial", "--control", control, "--target", target])
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(f"FAIL direct-dial control: {control} did not accept a connection", result.stdout)
        self.assertIn(f"FAIL direct-dial: {target} inconclusive, the control did not connect", result.stdout)
        self.assertNotIn("PASS", result.stdout)
        self.assertEqual(last_line(result.stdout), "RED: 2 probe(s) failed")

    def test_no_route_control_fails(self) -> None:
        control = "192.0.2.1:80"
        target = "192.0.2.2:80"
        result = run_probe(["direct-dial", "--control", control, "--target", target])
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertNotIn("PASS", result.stdout)
        self.assertIn("FAIL direct-dial control", result.stdout)
        self.assertIn(f"FAIL direct-dial control: {control} did not accept a connection", result.stdout)
        self.assertIn(f"FAIL direct-dial: {target} inconclusive, the control did not connect", result.stdout)
        self.assertEqual(last_line(result.stdout), "RED: 2 probe(s) failed")

    def test_missing_control_is_a_usage_error(self) -> None:
        target = closed_port(self)
        result = run_probe(["direct-dial", "--target", target])
        self.assertEqual(result.returncode, USAGE_EXIT, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIn("usage:", result.stderr)
        self.assertIn(USAGE_TEXT, result.stderr)
        self.assertIn("--control", result.stderr)

    def test_invalid_control_or_target_is_a_usage_error(self) -> None:
        open_ok = open_listener(self)
        bad_values = [
            "127.0.0.1",
            "127.0.0.1:",
            ":80",
            "127.0.0.1:0",
            "127.0.0.1:65536",
            "127.0.0.1:abc",
            "127.0.0.1:-1",
            "a:b:80",
            "::1:80",
            "127.0.0.1;ls:80",
            "127.0.0.1:80abc",
            "127.0.0.1:18446744073709551617",
            "127.0.0.1:99999999999999999999",
            "127.0.0.1:000",
            "127.0.0.1:80\n",
            "a b:80",
            "$HOME:80",
            "`id`:80",
            "[::1]:80",
            "",
            "127.0.0.1:\u0663",
            "caf\u00e9:80",
        ]
        for bad in bad_values:
            with self.subTest(role="control", value=bad):
                self.assert_usage_error(["direct-dial", "--control", bad, "--target", open_ok])
            with self.subTest(role="target", value=bad):
                self.assert_usage_error(["direct-dial", "--control", open_ok, "--target", bad])

    def test_valid_but_unusual_values_are_accepted(self) -> None:
        control = f"{LOOPBACK}:0{port_of(open_listener(self))}"
        closed = closed_port(self)
        target = f"{LOOPBACK}:000{port_of(closed)}"
        result = run_probe(["direct-dial", "--control", control, "--target", target])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"PASS direct-dial control: {control} accepted a connection", result.stdout)
        self.assertIn(f"PASS direct-dial: a connection to {target} was not accepted", result.stdout)

    def test_hostname_with_underscore_and_hyphen_is_not_a_usage_error(self) -> None:
        control = open_listener(self)
        target = "a_b-c.d:80"
        result = run_probe(["direct-dial", "--control", control, "--target", target])
        self.assertIn(result.returncode, (0, 1), result.stdout + result.stderr)
        self.assertNotEqual(result.returncode, USAGE_EXIT, result.stderr)
        target_rows = [
            line
            for line in result.stdout.splitlines()
            if line.startswith(("PASS direct-dial:", "FAIL direct-dial:")) and target in line
        ]
        self.assertEqual(len(target_rows), 1, result.stdout)

    def test_control_and_target_count_and_value_errors_are_usage_errors(self) -> None:
        open_ok = open_listener(self)
        with self.subTest(case="two controls"):
            self.assert_usage_error(
                ["direct-dial", "--control", open_ok, "--control", open_ok, "--target", open_ok]
            )
        with self.subTest(case="no target"):
            self.assert_usage_error(["direct-dial", "--control", open_ok])
        with self.subTest(case="control flag without value"):
            self.assert_usage_error(["direct-dial", "--target", open_ok, "--control"])
        with self.subTest(case="target flag without value"):
            self.assert_usage_error(["direct-dial", "--control", open_ok, "--target"])

    def test_unknown_flag_is_a_usage_error(self) -> None:
        open_ok = open_listener(self)
        self.assert_usage_error(["direct-dial", "--control", open_ok, "--target", open_ok, "--bogus", "x"])

    def test_flag_value_that_looks_like_a_flag_is_a_usage_error(self) -> None:
        valid = open_listener(self)
        with self.subTest(form="control takes a flag"):
            self.assert_usage_error(["direct-dial", "--control", "--target", valid])
        with self.subTest(form="target takes a flag"):
            self.assert_usage_error(["direct-dial", "--target", "--control", valid])

    def test_control_after_targets_is_position_independent(self) -> None:
        control = open_listener(self)
        target = closed_port(self)
        result = run_probe(["direct-dial", "--target", target, "--control", control])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"PASS direct-dial control: {control} accepted a connection", result.stdout)
        self.assertIn(f"PASS direct-dial: a connection to {target} was not accepted", result.stdout)

    def test_invalid_dial_timeout_is_a_usage_error(self) -> None:
        control = open_listener(self)
        target = open_listener(self)
        for bad in ["0", "0.0", "-1", "abc", "1e3", ".5"]:
            with self.subTest(timeout=bad):
                result = run_probe(["direct-dial", "--control", control, "--target", target], dial_timeout=bad)
                self.assertEqual(result.returncode, USAGE_EXIT, result.stderr)
                self.assertIn("PROBE_DIAL_TIMEOUT", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_fractional_dial_timeout_is_accepted(self) -> None:
        control = open_listener(self)
        target = closed_port(self)
        result = run_probe(["direct-dial", "--control", control, "--target", target], dial_timeout="0.5")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f"PASS direct-dial: a connection to {target} was not accepted", result.stdout)

    def test_dial_timeout_is_passed_to_timeout_as_given(self) -> None:
        shim_dir, record = timeout_shim(self)
        control = open_listener(self)
        target = closed_port(self)
        result = run_probe(
            ["direct-dial", "--control", control, "--target", target],
            dial_timeout="0.5",
            path_prefix=shim_dir,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(read_lines(record), ["0.5", "0.5"])

    def test_unset_dial_timeout_defaults_to_ten(self) -> None:
        shim_dir, record = timeout_shim(self)
        control = open_listener(self)
        target = closed_port(self)
        result = run_probe(
            ["direct-dial", "--control", control, "--target", target],
            dial_timeout=None,
            path_prefix=shim_dir,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(read_lines(record), ["10", "10"])

    def test_empty_dial_timeout_defaults_to_ten(self) -> None:
        shim_dir, record = timeout_shim(self)
        control = open_listener(self)
        target = closed_port(self)
        result = run_probe(
            ["direct-dial", "--control", control, "--target", target],
            dial_timeout="",
            path_prefix=shim_dir,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(read_lines(record), ["10", "10"])

    def test_every_target_is_judged_with_two_targets(self) -> None:
        control = open_listener(self)
        closed = closed_port(self)
        open_target = open_listener(self)
        result = run_probe(
            ["direct-dial", "--control", control, "--target", closed, "--target", open_target]
        )
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        pass_rows = [line for line in result.stdout.splitlines() if line.startswith("PASS direct-dial:")]
        fail_rows = [line for line in result.stdout.splitlines() if line.startswith("FAIL direct-dial:")]
        self.assertEqual(len(pass_rows), 1, result.stdout)
        self.assertEqual(len(fail_rows), 1, result.stdout)
        self.assertEqual(last_line(result.stdout), "RED: 1 probe(s) failed")

    def test_key_holder_usage_is_unchanged(self) -> None:
        result = run_probe(["key-holder"])
        self.assertEqual(result.returncode, USAGE_EXIT, result.stderr)
        self.assertEqual(result.stdout, "")
        self.assertIn("key-holder --host <ip> --key <path> --known-hosts <path>", result.stderr)
        self.assertIn(USAGE_TEXT, result.stderr)

    def test_key_holder_ignores_dial_timeout(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            key = os.path.join(tmp, "missing-key")
            known_hosts = os.path.join(tmp, "missing-known-hosts")
            result = run_probe(
                ["key-holder", "--host", LOOPBACK, "--key", key, "--known-hosts", known_hosts],
                dial_timeout="abc",
                extra_env={"PROBE_TIMEOUT": SHORT_DIAL_TIMEOUT},
            )
        self.assertNotIn("PROBE_DIAL_TIMEOUT", result.stderr)


if __name__ == "__main__":
    unittest.main()
