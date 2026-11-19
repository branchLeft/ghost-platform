"""Tests for render_broker_tunnel.py: the grant, stated as exact text.

The property is that the key may open 127.0.0.1:8090 and nothing else, with
no shell. So these tests assert the rendered text directly, and assert that
the check refuses every widened or reordered option set.
"""

from __future__ import annotations

import base64
import io
import os
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import render_broker_tunnel as rbt  # noqa: E402


def _key_blob(material: bytes, key_type: bytes = b"ssh-ed25519") -> str:
    blob = struct.pack(">I", len(key_type)) + key_type + struct.pack(">I", len(material)) + material
    return base64.b64encode(blob).decode()


GOOD_BLOB = _key_blob(bytes(range(32)))
GOOD_KEY = f"ssh-ed25519 {GOOD_BLOB} ops1-broker-tunnel"
GRANT_LINE = f'restrict,port-forwarding,permitopen="127.0.0.1:8090" {GOOD_KEY}\n'


class RenderAuthorizedKeysTest(unittest.TestCase):
    def test_the_line_is_the_grant_exactly(self) -> None:
        self.assertEqual(rbt.render_authorized_keys(GOOD_KEY), GRANT_LINE)

    def test_the_only_open_is_the_broker(self) -> None:
        line = rbt.render_authorized_keys(GOOD_KEY)
        self.assertEqual(line.count("permitopen"), 1)
        self.assertIn('permitopen="127.0.0.1:8090"', line)
        self.assertNotIn("permitlisten", line)
        self.assertNotIn("command=", line)

    def test_restrict_comes_first(self) -> None:
        self.assertTrue(rbt.render_authorized_keys(GOOD_KEY).startswith("restrict,"))

    def test_trailing_whitespace_is_dropped(self) -> None:
        self.assertEqual(rbt.render_authorized_keys(f"  {GOOD_KEY}\n"), GRANT_LINE)

    def test_refuses_a_key_with_options_in_front(self) -> None:
        with self.assertRaises(rbt.BrokerTunnelError):
            rbt.render_authorized_keys(f'permitopen="*:*" ssh-ed25519 {GOOD_BLOB} c')

    def test_refuses_two_lines(self) -> None:
        with self.assertRaises(rbt.BrokerTunnelError):
            rbt.render_authorized_keys(f"{GOOD_KEY}\n{GOOD_KEY}")

    def test_refuses_another_key_type(self) -> None:
        with self.assertRaises(rbt.BrokerTunnelError):
            rbt.render_authorized_keys(f"ssh-rsa {GOOD_BLOB}")

    def test_refuses_a_blob_of_another_type(self) -> None:
        with self.assertRaises(rbt.BrokerTunnelError):
            rbt.render_authorized_keys(f"ssh-ed25519 {_key_blob(bytes(32), b'ssh-rsa')}")

    def test_refuses_a_short_blob(self) -> None:
        with self.assertRaises(rbt.BrokerTunnelError):
            rbt.render_authorized_keys(f"ssh-ed25519 {_key_blob(bytes(31))}")

    def test_refuses_bad_base64(self) -> None:
        with self.assertRaises(rbt.BrokerTunnelError):
            rbt.render_authorized_keys("ssh-ed25519 not*base64")

    def test_refuses_a_comment_with_odd_characters(self) -> None:
        with self.assertRaises(rbt.BrokerTunnelError):
            rbt.render_authorized_keys(f"ssh-ed25519 {GOOD_BLOB} a,b")


class RenderSshdDropinTest(unittest.TestCase):
    def setUp(self) -> None:
        self.text = rbt.render_sshd_dropin()
        self.body = [
            line.strip() for line in self.text.splitlines() if line.strip() and not line.startswith("#")
        ]

    def test_one_match_block_for_the_account_then_match_all(self) -> None:
        self.assertEqual(self.body[0], "Match User brokertunnel")
        self.assertEqual(self.body[-1], "Match all")
        self.assertEqual(sum(1 for line in self.body if line.startswith("Match")), 2)

    def test_every_expected_setting_is_written_once_with_its_value(self) -> None:
        settings = {line.split(" ", 1)[0].lower(): line.split(" ", 1)[1] for line in self.body[1:-1]}
        self.assertEqual(settings, rbt.expected_effective())
        self.assertEqual(len(self.body) - 2, len(settings))

    def test_forwarding_is_local_only_and_open_is_the_broker(self) -> None:
        self.assertIn("AllowTcpForwarding local", self.body)
        self.assertIn("PermitOpen 127.0.0.1:8090", self.body)
        self.assertIn("PermitListen none", self.body)
        self.assertIn("ForceCommand /usr/sbin/nologin", self.body)


class CheckAuthorizedKeysTest(unittest.TestCase):
    def test_the_rendered_file_passes(self) -> None:
        self.assertEqual(rbt.check_authorized_keys(rbt.render_authorized_keys(GOOD_KEY)), [])

    def test_a_second_destination_is_refused(self) -> None:
        widened = GRANT_LINE.replace(
            'permitopen="127.0.0.1:8090"', 'permitopen="127.0.0.1:8090",permitopen="127.0.0.1:22"'
        )
        self.assertTrue(rbt.check_authorized_keys(widened))

    def test_another_destination_is_refused(self) -> None:
        for other in ("127.0.0.1:8091", "127.0.0.1:*", "*:8090", "localhost:8090", "0.0.0.0:8090"):
            with self.subTest(other=other):
                self.assertTrue(
                    rbt.check_authorized_keys(GRANT_LINE.replace("127.0.0.1:8090", other))
                )

    def test_a_missing_permitopen_is_refused(self) -> None:
        self.assertTrue(
            rbt.check_authorized_keys(GRANT_LINE.replace(',permitopen="127.0.0.1:8090"', ""))
        )

    def test_a_missing_restrict_is_refused(self) -> None:
        self.assertTrue(rbt.check_authorized_keys(GRANT_LINE.replace("restrict,", "")))

    def test_an_extra_option_is_refused(self) -> None:
        for extra in ("pty", "agent-forwarding", 'permitlisten="127.0.0.1:1"', "user-rc"):
            with self.subTest(extra=extra):
                self.assertTrue(
                    rbt.check_authorized_keys(
                        GRANT_LINE.replace("port-forwarding,", f"port-forwarding,{extra},")
                    )
                )

    def test_upper_case_options_are_refused(self) -> None:
        self.assertTrue(
            rbt.check_authorized_keys(GRANT_LINE.replace("permitopen", "PERMITOPEN"))
        )

    def test_a_second_key_is_refused(self) -> None:
        self.assertTrue(rbt.check_authorized_keys(GRANT_LINE + f"{GOOD_KEY}\n"))

    def test_an_empty_file_is_refused(self) -> None:
        self.assertTrue(rbt.check_authorized_keys(""))

    def test_a_bad_key_after_good_options_is_refused(self) -> None:
        self.assertTrue(rbt.check_authorized_keys(GRANT_LINE.replace(GOOD_BLOB, "AAAA")))


class MainTest(unittest.TestCase):
    def _run(self, *argv: str) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = rbt.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_authorized_keys_prints_the_grant(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".pub", delete=False) as handle:
            handle.write(GOOD_KEY + "\n")
        self.addCleanup(os.unlink, handle.name)
        self.assertEqual(self._run("authorized-keys", "--public-key-file", handle.name), (0, GRANT_LINE, ""))

    def test_sshd_prints_the_dropin(self) -> None:
        self.assertEqual(self._run("sshd")[:2], (0, rbt.render_sshd_dropin()))

    def test_check_fails_a_widened_file(self) -> None:
        with tempfile.NamedTemporaryFile("w", delete=False) as handle:
            handle.write(GRANT_LINE.replace("127.0.0.1:8090", "127.0.0.1:22"))
        self.addCleanup(os.unlink, handle.name)
        code, _, err = self._run("check-authorized-keys", handle.name)
        self.assertEqual(code, 1)
        self.assertIn("127.0.0.1:22", err)

    def test_missing_key_file_is_a_refusal(self) -> None:
        code, _, err = self._run("authorized-keys", "--public-key-file", "/nonexistent/key.pub")
        self.assertEqual(code, 1)
        self.assertIn("cannot read", err)


if __name__ == "__main__":
    unittest.main()
