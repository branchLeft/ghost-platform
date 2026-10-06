#!/usr/bin/env python3
"""Unit tests for tunnel_account.py. See tunnel_account.md."""

from __future__ import annotations

import base64
import io
import os
import struct
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import tunnel_account as ta  # noqa: E402


def wire(*fields: bytes) -> str:
    blob = b"".join(struct.pack(">I", len(field)) + field for field in fields)
    return base64.b64encode(blob).decode()


GOOD_BLOB = wire(b"ssh-ed25519", bytes(range(32)))
GOOD_KEY = f"ssh-ed25519 {GOOD_BLOB} db1-replica-tunnel"
NAT = "46.225.95.167"


def good_grant() -> ta.Grant:
    return ta.make_grant(GOOD_KEY, NAT, 13306, 9104)


def resolved(grant: ta.Grant, **overrides: str) -> str:
    values = ta.expected_effective(grant)
    values.update(overrides)
    lines = [f"{key} {value}" for key, value in values.items() if value is not None]
    return "port 22\n" + "\n".join(lines) + "\n"


class PublicKeyTests(unittest.TestCase):
    def test_accepts_a_key_with_and_without_a_comment(self):
        self.assertEqual(ta.validate_public_key(GOOD_KEY + "\n"), GOOD_KEY)
        bare = f"ssh-ed25519 {GOOD_BLOB}"
        self.assertEqual(ta.validate_public_key(bare), bare)

    def test_refuses_options_in_front_of_the_key(self):
        for line in (
            f"restrict ssh-ed25519 {GOOD_BLOB}",
            f'command="/bin/sh" ssh-ed25519 {GOOD_BLOB}',
            f'permitopen="*:*" ssh-ed25519 {GOOD_BLOB} c',
        ):
            with self.subTest(line=line), self.assertRaises(ta.TunnelAccountError):
                ta.validate_public_key(line)

    def test_refuses_other_key_types(self):
        with self.assertRaisesRegex(ta.TunnelAccountError, "only ssh-ed25519"):
            ta.validate_public_key(f"ssh-rsa {wire(b'ssh-rsa', b'x' * 32)}")

    def test_refuses_a_body_that_is_not_an_ed25519_key(self):
        for body in (
            "not*base64",
            wire(b"ssh-rsa", bytes(32)),
            wire(b"ssh-ed25519", bytes(31)),
            wire(b"ssh-ed25519", bytes(32), b"extra"),
            base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20abc").decode(),
            base64.b64encode(b"\x00\x00").decode(),
        ):
            with self.subTest(body=body), self.assertRaises(ta.TunnelAccountError):
                ta.validate_public_key(f"ssh-ed25519 {body}")

    def test_refuses_more_than_one_line_or_a_wrong_field_count(self):
        for line in (
            GOOD_KEY + "\n" + GOOD_KEY,
            f"ssh-ed25519 {GOOD_BLOB} a b",
            "ssh-ed25519",
            f"ssh-ed25519  {GOOD_BLOB}",
        ):
            with self.subTest(line=line), self.assertRaises(ta.TunnelAccountError):
                ta.validate_public_key(line)

    def test_refuses_a_comment_that_could_carry_syntax(self):
        for comment in ('a"b', "a,b", "x" * 65):
            with self.subTest(comment=comment), self.assertRaises(ta.TunnelAccountError):
                ta.validate_public_key(f"ssh-ed25519 {GOOD_BLOB} {comment}")


class FromAddressTests(unittest.TestCase):
    def test_accepts_one_public_ipv4_address(self):
        self.assertEqual(ta.validate_from_address(f" {NAT} "), NAT)
        self.assertEqual(ta.validate_from_address("203.0.113.20"), "203.0.113.20")

    def test_refuses_addresses_a_nat_egress_can_never_be(self):
        for value in (
            "10.20.1.20",
            "172.16.0.1",
            "192.168.1.1",
            "127.0.0.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "255.255.255.255",
        ):
            with self.subTest(value=value), self.assertRaisesRegex(
                ta.TunnelAccountError, "not a public address"
            ):
                ta.validate_from_address(value)

    def test_refuses_anything_but_a_single_address(self):
        for value in ("46.225.95.0/24", "*", "!10.0.0.1", "2a01:4f8::1", "", "46.225.95.167,1.1.1.1"):
            with self.subTest(value=value), self.assertRaisesRegex(
                ta.TunnelAccountError, "single IPv4 address"
            ):
                ta.validate_from_address(value)


class GrantTests(unittest.TestCase):
    def test_ports_are_bounded_and_distinct(self):
        for listen, metrics in ((80, 9104), (13306, 70000), (13306, 0)):
            with self.subTest(listen=listen, metrics=metrics), self.assertRaises(
                ta.TunnelAccountError
            ):
                ta.make_grant(GOOD_KEY, NAT, listen, metrics)
        with self.assertRaisesRegex(ta.TunnelAccountError, "must differ"):
            ta.make_grant(GOOD_KEY, NAT, 13306, 13306)

    def test_authorized_keys_line_carries_exactly_the_two_forwards(self):
        line = ta.render_authorized_keys(good_grant())
        self.assertEqual(
            line,
            'restrict,port-forwarding,permitlisten="127.0.0.1:13306",'
            f'permitopen="127.0.0.1:9104",from="{NAT}" {GOOD_KEY}\n',
        )
        self.assertNotIn("pty", line)
        self.assertEqual(line.count("permitopen"), 1)
        self.assertEqual(line.count("permitlisten"), 1)

    def test_sshd_dropin_scopes_every_restriction_to_the_account(self):
        text = ta.render_sshd_dropin(good_grant())
        lines = text.splitlines()
        self.assertEqual(lines[1], "Match User dbtunnel")
        for expected in (
            "    PermitListen 127.0.0.1:13306",
            "    PermitOpen 127.0.0.1:9104",
            "    ForceCommand /usr/sbin/nologin",
            "    PermitTTY no",
            "    GatewayPorts no",
            "    AuthorizedKeysFile /etc/branchleft/db-tunnel/authorized_keys",
        ):
            self.assertIn(expected, lines)
        self.assertTrue(all(line.startswith("    ") for line in lines[2:]))


class EffectiveConfigTests(unittest.TestCase):
    def test_first_value_wins_like_sshd(self):
        self.assertEqual(ta.parse_sshd_t("permitopen a\npermitopen b\n\n")["permitopen"], "a")

    def test_matching_config_has_no_mismatches(self):
        grant = good_grant()
        self.assertEqual(ta.effective_mismatches(resolved(grant), grant), [])

    def test_a_widened_or_missing_keyword_is_reported(self):
        grant = good_grant()
        for override in (
            {"permitopen": "127.0.0.1:9104 127.0.0.1:22"},
            {"permitlisten": "any"},
            {"forcecommand": "none"},
            {"permittty": "yes"},
            {"allowtcpforwarding": None},
        ):
            with self.subTest(override=override):
                problems = ta.effective_mismatches(resolved(grant, **override), grant)
                self.assertEqual(len(problems), 1)
                self.assertIn(next(iter(override)), problems[0])


class FakeRunner:
    """Answers each command from a table; records every call."""

    def __init__(self, grant: ta.Grant, **answers):
        self.calls: list[list[str]] = []
        self.answers = {
            "getent": (2, ""),
            "useradd": (0, ""),
            "usermod": (0, ""),
            "sshd -t": (0, ""),
            "sshd -T": (0, resolved(grant)),
            "systemctl": (0, ""),
        }
        self.answers.update(answers)

    def __call__(self, argv):
        self.calls.append(list(argv))
        key = " ".join(argv[:2]) if argv[0] == "sshd" else argv[0]
        code, out = self.answers[key]
        return subprocess.CompletedProcess(argv, code, out, "boom" if code else "")

    def ran(self, name: str) -> bool:
        return any(call[0] == name for call in self.calls)


class InstallTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.grant = good_grant()
        self.host_key = os.path.join(self.root, "ssh_host_ed25519_key.pub")
        with open(self.host_key, "w", encoding="utf-8") as handle:
            handle.write(f"ssh-ed25519 {GOOD_BLOB} root@db-t1\n")

    def host(self, runner) -> ta.Host:
        return ta.Host(
            run=runner,
            authorized_keys=os.path.join(self.root, "etc/branchleft/db-tunnel/authorized_keys"),
            sshd_dropin=os.path.join(self.root, "etc/ssh/sshd_config.d/60-db-tunnel.conf"),
            host_key=self.host_key,
            owner_uid=os.getuid(),
            owner_gid=os.getgid(),
        )

    def read(self, path):
        with open(path, encoding="utf-8") as handle:
            return handle.read()

    def test_fresh_install_creates_the_account_writes_reloads_and_verifies(self):
        runner = FakeRunner(self.grant)
        host = self.host(runner)
        log = ta.install(self.grant, host)
        self.assertIn("--shell", runner.calls[1])
        self.assertIn("/usr/sbin/nologin", runner.calls[1])
        self.assertEqual(runner.calls[2], ["usermod", "--lock", "dbtunnel"])
        self.assertEqual(self.read(host.authorized_keys), ta.render_authorized_keys(self.grant))
        self.assertEqual(self.read(host.sshd_dropin), ta.render_sshd_dropin(self.grant))
        self.assertEqual(os.stat(host.authorized_keys).st_mode & 0o777, 0o644)
        self.assertIn(["systemctl", "reload", "ssh"], runner.calls)
        self.assertIn(f"addr={NAT}", runner.calls[-1][-1])
        self.assertTrue(log[-1].endswith(f"ssh-ed25519 {GOOD_BLOB}"))

    def test_second_run_changes_nothing_and_does_not_reload(self):
        ta.install(self.grant, self.host(FakeRunner(self.grant)))
        runner = FakeRunner(self.grant, getent=(0, "dbtunnel:x:996:996::/nonexistent:/usr/sbin/nologin\n"))
        log = ta.install(self.grant, self.host(runner))
        self.assertFalse(runner.ran("systemctl"))
        self.assertFalse(runner.ran("useradd"))
        self.assertIn("already up to date", log[1])

    def test_an_existing_account_with_a_shell_is_refused_before_anything_is_written(self):
        runner = FakeRunner(self.grant, getent=(0, "dbtunnel:x:996:996::/home/dbtunnel:/bin/bash\n"))
        host = self.host(runner)
        with self.assertRaisesRegex(ta.TunnelAccountError, "refusing to reuse"):
            ta.install(self.grant, host)
        self.assertFalse(os.path.exists(host.authorized_keys))

    def test_a_getent_failure_is_not_read_as_a_missing_account(self):
        runner = FakeRunner(self.grant, getent=(1, ""))
        with self.assertRaisesRegex(ta.TunnelAccountError, "getent"):
            ta.install(self.grant, self.host(runner))
        self.assertFalse(runner.ran("useradd"))

    def test_a_failed_useradd_stops_the_install(self):
        runner = FakeRunner(self.grant, useradd=(9, ""))
        with self.assertRaisesRegex(ta.TunnelAccountError, "useradd"):
            ta.install(self.grant, self.host(runner))

    def test_sshd_rejecting_the_config_restores_the_previous_files(self):
        host = self.host(FakeRunner(self.grant))
        ta.install(self.grant, host)
        before = (self.read(host.authorized_keys), self.read(host.sshd_dropin))
        wider = ta.make_grant(GOOD_KEY, NAT, 13307, 9104)
        runner = FakeRunner(wider, **{"sshd -t": (1, "")})
        host.run = runner
        with self.assertRaisesRegex(ta.TunnelAccountError, "previous files restored"):
            ta.install(wider, host)
        self.assertEqual((self.read(host.authorized_keys), self.read(host.sshd_dropin)), before)
        self.assertFalse(runner.ran("systemctl"))

    def test_sshd_rejecting_a_first_install_leaves_no_files(self):
        host = self.host(FakeRunner(self.grant, **{"sshd -t": (1, "")}))
        with self.assertRaises(ta.TunnelAccountError):
            ta.install(self.grant, host)
        self.assertFalse(os.path.exists(host.authorized_keys))
        self.assertFalse(os.path.exists(host.sshd_dropin))

    def test_an_effective_config_that_differs_is_a_failure(self):
        runner = FakeRunner(self.grant, **{"sshd -T": (0, resolved(self.grant, forcecommand="none"))})
        with self.assertRaisesRegex(ta.TunnelAccountError, "forcecommand"):
            ta.install(self.grant, self.host(runner))

    def test_a_missing_or_malformed_host_key_is_a_failure(self):
        os.unlink(self.host_key)
        with self.assertRaisesRegex(ta.TunnelAccountError, "no host key"):
            ta.install(self.grant, self.host(FakeRunner(self.grant)))
        with open(self.host_key, "w", encoding="utf-8") as handle:
            handle.write("garbage\n")
        with self.assertRaisesRegex(ta.TunnelAccountError, "not an ssh public key"):
            ta.install(self.grant, self.host(FakeRunner(self.grant)))

    def test_a_failed_write_leaves_no_temporary_file(self):
        host = self.host(FakeRunner(self.grant))
        with mock.patch.object(ta.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(OSError):
                ta.install(self.grant, host)
        leftovers = os.listdir(os.path.dirname(host.authorized_keys))
        self.assertEqual(leftovers, [])


class MainTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.key_file = os.path.join(tmp.name, "db1.pub")
        with open(self.key_file, "w", encoding="utf-8") as handle:
            handle.write(GOOD_KEY + "\n")

    def run_main(self, *argv, host=None):
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = ta.main(list(argv), host=host)
        return code, out.getvalue(), err.getvalue()

    def test_render_actions_print_the_files(self):
        code, out, _ = self.run_main(
            "render-authorized-keys", "--public-key-file", self.key_file, "--from-address", NAT
        )
        self.assertEqual((code, out), (0, ta.render_authorized_keys(good_grant())))
        code, out, _ = self.run_main(
            "render-sshd", "--public-key-file", self.key_file, "--from-address", NAT
        )
        self.assertEqual((code, out), (0, ta.render_sshd_dropin(good_grant())))

    def test_bad_input_exits_one_with_a_reason(self):
        code, _, err = self.run_main(
            "render-sshd", "--public-key-file", self.key_file, "--from-address", "10.20.1.20"
        )
        self.assertEqual(code, 1)
        self.assertIn("not a public address", err)
        code, _, err = self.run_main(
            "render-sshd", "--public-key-file", "/nonexistent.pub", "--from-address", NAT
        )
        self.assertEqual(code, 1)
        self.assertIn("no public key file", err)

    def test_install_refuses_to_run_unprivileged(self):
        with mock.patch.object(ta.os, "geteuid", return_value=1000):
            code, _, err = self.run_main(
                "install", "--public-key-file", self.key_file, "--from-address", NAT
            )
        self.assertEqual(code, 1)
        self.assertIn("must run as root", err)

    def test_install_through_main_prints_its_log(self):
        with tempfile.TemporaryDirectory() as root:
            host_key = os.path.join(root, "host.pub")
            with open(host_key, "w", encoding="utf-8") as handle:
                handle.write(f"ssh-ed25519 {GOOD_BLOB}\n")
            host = ta.Host(
                run=FakeRunner(good_grant()),
                authorized_keys=os.path.join(root, "ak"),
                sshd_dropin=os.path.join(root, "dropin.conf"),
                host_key=host_key,
                owner_uid=os.getuid(),
                owner_gid=os.getgid(),
            )
            code, out, _ = self.run_main(
                "install", "--public-key-file", self.key_file, "--from-address", NAT, host=host
            )
        self.assertEqual(code, 0)
        self.assertIn("tunnel_account: host key to pin", out)

    def test_default_runner_runs_a_real_command(self):
        result = ta.default_runner([sys.executable, "-c", "print('ok')"])
        self.assertEqual((result.returncode, result.stdout.strip()), (0, "ok"))


if __name__ == "__main__":
    unittest.main()
