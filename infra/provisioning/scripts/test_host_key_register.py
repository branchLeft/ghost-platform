#!/usr/bin/env python3
"""Tests for host_key_register.py: the parsing, recording and filling of the
host-key register, and the one test that proves the filled file is what a real
ssh client holds a real sshd to.

Test keys are made at test time and never typed in: the pure tests build a
well-formed ed25519 key blob from one repeated byte, and the real-ssh tests use
`ssh-keygen` into a temporary directory. Addresses are documentation ranges.

See host_key_register.md#module-overview.
"""

from __future__ import annotations

import ast
import base64
import contextlib
import getpass
import io
import os
import pathlib
import re
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock

_HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))

import host_key_register as hkr  # noqa: E402

REPO = _HERE.parents[2]
REGISTER = _HERE.parent / "host-key-register.txt"
WORKFLOW = REPO / ".github" / "workflows" / "provision-tenant.yml"
RUNBOOK = REPO / "RUNBOOK-tenant-onboarding.md"
IN_CI = bool(os.environ.get("GITHUB_ACTIONS"))

DOC_IPV4 = "192.0.2.10"
DOC_NAME = "host.example.com"


def make_body(seed: int) -> str:
    """The base64 body of a well-formed ed25519 key blob around 32 repeated bytes."""
    name = b"ssh-ed25519"
    blob = struct.pack(">I", len(name)) + name + struct.pack(">I", 32) + bytes([seed]) * 32
    return base64.b64encode(blob).decode("ascii")


def key_line(seed: int, comment: str = "") -> str:
    return f"ssh-ed25519 {make_body(seed)}" + (f" {comment}" if comment else "") + "\n"


HEADER = "# a comment\n\n"
BODY_A = make_body(1)
BODY_B = make_body(2)


def register(**roles: int) -> str:
    return HEADER + "".join(f"{r} ssh-ed25519 {make_body(s)}\n" for r, s in roles.items())


class ParseKeyLineTests(unittest.TestCase):
    def test_returns_the_body_and_strips_a_trailing_comment(self) -> None:
        self.assertEqual(hkr.parse_key_line(key_line(1, "root@somewhere")), BODY_A)
        self.assertEqual(hkr.parse_key_line(key_line(1)), BODY_A)
        self.assertEqual(hkr.parse_key_line(key_line(1).rstrip("\n")), BODY_A)

    def test_refuses_an_address_or_options_in_front(self) -> None:
        for prefix in (DOC_IPV4, "[192.0.2.10]:22", 'command="true"', "@cert-authority *", "|1|abc|def"):
            with self.assertRaises(hkr.RegisterError, msg=prefix):
                hkr.parse_key_line(f"{prefix} {key_line(1)}")

    def test_refuses_any_other_key_type(self) -> None:
        for kind in ("ssh-rsa", "ecdsa-sha2-nistp256", "ssh-dss", "sk-ssh-ed25519@openssh.com", "ssh-ed448"):
            with self.assertRaises(hkr.RegisterError, msg=kind):
                hkr.parse_key_line(f"{kind} {BODY_A}\n")

    def test_refuses_a_malformed_body(self) -> None:
        wrong_length = base64.b64encode(b"\x00\x00\x00\x0bssh-ed25519\x00\x00\x00\x20" + b"\x01" * 31).decode()
        wrong_name = base64.b64encode(b"\x00\x00\x00\x07ssh-rsa" + b"\x00\x00\x00\x20" + b"\x01" * 32).decode()
        for body in ("", "%%%%", BODY_A[:-4], BODY_A + "A", "AAAA=AAA", wrong_length, wrong_name, "A" * 70):
            with self.assertRaises(hkr.RegisterError, msg=body):
                hkr.parse_key_line(f"ssh-ed25519 {body}\n")

    def test_a_valid_key_needs_no_padding_so_has_one_spelling(self) -> None:
        self.assertNotIn("=", BODY_A)
        for padded in (BODY_A + "=", BODY_A + "=="):
            with self.assertRaises(hkr.RegisterError, msg=padded):
                hkr.parse_key_line(f"ssh-ed25519 {padded}\n")

    def test_refuses_empty_missing_key_and_multiple_lines(self) -> None:
        for text in ("", "\n", "   ", "ssh-ed25519", "ssh-ed25519\n", key_line(1) + key_line(2), key_line(1) + "\nx"):
            with self.assertRaises(hkr.RegisterError, msg=repr(text)):
                hkr.parse_key_line(text)


class ParseRegisterTests(unittest.TestCase):
    def test_an_empty_or_comment_only_register_is_valid_and_empty(self) -> None:
        self.assertEqual(hkr.parse_register(""), {})
        self.assertEqual(hkr.parse_register(HEADER), {})

    def test_parses_roles_skipping_blank_lines_and_comments(self) -> None:
        self.assertEqual(hkr.parse_register(register(app1=1, db1=2)), {"app1": BODY_A, "db1": BODY_B})

    def test_refuses_a_line_that_is_not_exactly_role_type_body(self) -> None:
        bad = [
            f"app1 {BODY_A}",
            f"app1 ssh-ed25519 {BODY_A} comment",
            f"app1 ssh-ed25519  {BODY_A}",
            f"{DOC_IPV4} ssh-ed25519 {BODY_A}",
            f"app1 ssh-rsa {BODY_A}",
            f"App1 ssh-ed25519 {BODY_A}",
            f"1app ssh-ed25519 {BODY_A}",
            f"a{'b' * 32} ssh-ed25519 {BODY_A}",
            f" app1 ssh-ed25519 {BODY_A}",
            f"app1 ssh-ed25519 {BODY_A}\r",
            f"  # not a comment because it is indented",
            f"app1 ssh-ed25519 {BODY_A[:-4]}",
        ]
        for line in bad:
            with self.assertRaises(hkr.RegisterError, msg=repr(line)):
                hkr.parse_register(line + "\n")

    def test_refuses_a_role_listed_twice(self) -> None:
        text = f"app1 ssh-ed25519 {BODY_A}\napp1 ssh-ed25519 {BODY_B}\n"
        with self.assertRaisesRegex(hkr.RegisterError, "more than once"):
            hkr.parse_register(text)

    def test_refuses_one_key_under_two_roles(self) -> None:
        text = f"app1 ssh-ed25519 {BODY_A}\ndb1 ssh-ed25519 {BODY_A}\n"
        with self.assertRaisesRegex(hkr.RegisterError, "share one key"):
            hkr.parse_register(text)


class RecordTests(unittest.TestCase):
    def test_adds_a_role_with_its_key(self) -> None:
        out = hkr.record(HEADER, "app1", key_line(1, "root@host"))
        self.assertEqual(hkr.parse_register(out), {"app1": BODY_A})
        self.assertTrue(out.startswith(HEADER))
        self.assertNotIn("root@host", out)

    def test_adds_a_newline_when_the_file_lacks_one(self) -> None:
        out = hkr.record("# header", "app1", key_line(1))
        self.assertEqual(out, f"# header\napp1 ssh-ed25519 {BODY_A}\n")

    def test_recording_the_identical_pair_again_changes_nothing(self) -> None:
        once = hkr.record(HEADER, "app1", key_line(1))
        self.assertEqual(hkr.record(once, "app1", key_line(1, "other comment")), once)

    def test_refuses_a_different_key_under_a_recorded_role(self) -> None:
        # Control (b). The refusal is the only thing between a record and a silent
        # key swap on a trust root: remove it and this test must go red.
        existing = hkr.record(HEADER, "app1", key_line(1))
        with self.assertRaisesRegex(hkr.RegisterError, "different key"):
            hkr.record(existing, "app1", key_line(2))

    def test_the_register_is_unchanged_after_a_refused_record(self) -> None:
        existing = hkr.record(HEADER, "app1", key_line(1))
        with self.assertRaises(hkr.RegisterError):
            hkr.record(existing, "app1", key_line(2))
        self.assertEqual(hkr.parse_register(existing), {"app1": BODY_A})

    def test_refuses_a_key_already_recorded_under_another_role(self) -> None:
        existing = hkr.record(HEADER, "app1", key_line(1))
        with self.assertRaisesRegex(hkr.RegisterError, "already recorded under role 'app1'"):
            hkr.record(existing, "db1", key_line(1))

    def test_refuses_a_bad_role_and_a_bad_key_line(self) -> None:
        for role in ("", "App1", "1a", "a b", "a_b", "x" * 33, "../x"):
            with self.assertRaises(hkr.RegisterError, msg=role):
                hkr.record(HEADER, role, key_line(1))
        with self.assertRaises(hkr.RegisterError):
            hkr.record(HEADER, "app1", f"{DOC_IPV4} {key_line(1)}")

    def test_refuses_to_build_on_an_invalid_register(self) -> None:
        with self.assertRaises(hkr.RegisterError):
            hkr.record(f"app1 ssh-ed25519 {BODY_A}\napp1 ssh-ed25519 {BODY_B}\n", "db1", key_line(3))


class FillTests(unittest.TestCase):
    def test_prints_a_comment_header_and_one_address_key_line(self) -> None:
        out = hkr.fill(register(app1=1), "app1", DOC_IPV4)
        lines = out.splitlines()
        self.assertTrue(all(line.startswith("#") for line in lines[:-1]))
        self.assertEqual(lines[-1], f"{DOC_IPV4} ssh-ed25519 {BODY_A}")
        data = [line for line in lines if re.match(r"[^#\s]", line)]
        self.assertEqual(len(data), 1)

    def test_the_output_satisfies_the_template_deploy_jobs_non_comment_check(self) -> None:
        out = hkr.fill(register(app1=1), "app1", DOC_NAME)
        self.assertRegex(out, re.compile(r"^[^#\s]", re.MULTILINE))
        self.assertRegex(out, re.compile(rf"^{re.escape(DOC_NAME)} ssh-ed25519 \S+$", re.MULTILINE))

    def test_the_header_carries_no_address(self) -> None:
        out = hkr.fill(register(app1=1), "app1", DOC_IPV4)
        self.assertEqual(out.count(DOC_IPV4), 1)

    def test_refuses_an_unknown_role(self) -> None:
        # Control (c). Remove the guard and this test must go red.
        with self.assertRaisesRegex(hkr.RegisterError, "not in the host-key register"):
            hkr.fill(register(app1=1), "db1", DOC_IPV4)

    def test_refuses_every_role_of_an_empty_register(self) -> None:
        for role in ("app1", "db1"):
            with self.assertRaisesRegex(hkr.RegisterError, "not in the host-key register"):
                hkr.fill(HEADER, role, DOC_IPV4)

    def test_refuses_an_empty_or_malformed_role(self) -> None:
        for role in ("", " ", "App1", "app1\n", "*"):
            with self.assertRaises(hkr.RegisterError, msg=repr(role)):
                hkr.fill(register(app1=1), role, DOC_IPV4)

    def test_accepts_plain_ipv4_and_dns_names(self) -> None:
        for address in (DOC_IPV4, "198.51.100.7", "203.0.113.200", DOC_NAME, "a", "a-b.example.org", "Host.Example.COM", "x" * 63 + ".example"):
            self.assertEqual(hkr.validate_address(address), address)

    def test_refuses_anything_else_as_an_address(self) -> None:
        bad = [
            "",
            " ",
            "192.0.2.10 ",
            " 192.0.2.10",
            "192.0.2.10\n",
            "192.0.2.10:22",
            "[192.0.2.10]:22",
            "[192.0.2.10]",
            "192.0.2.256",
            "192.0.2",
            "192.0.2.10.5",
            "192.000.2.10",
            "010.0.2.10",
            "2001:db8::1",
            "[2001:db8::1]",
            "*",
            "*.example.com",
            "host?.example.com",
            "host,other.example.com",
            "!host.example.com",
            "@cert-authority",
            "user@host.example.com",
            "|1|abc|def",
            "-host.example.com",
            "host-.example.com",
            "host..example.com",
            "host.example.com.",
            ".example.com",
            "host example.com",
            "host\tother",
            "host.example.com\nother.example.com",
            "x" * 64 + ".example",
            ("a" * 60 + ".") * 5 + "com",
            "exämple.com",
            "host.123",
        ]
        for address in bad:
            with self.assertRaises(hkr.RegisterError, msg=repr(address)):
                hkr.validate_address(address)
            with self.assertRaises(hkr.RegisterError, msg=repr(address)):
                hkr.fill(register(app1=1), "app1", address)


class CheckTests(unittest.TestCase):
    def test_passes_a_valid_register_and_a_present_required_role(self) -> None:
        hkr.check(register(app1=1, db1=2), require=["app1", "db1"])
        hkr.check(HEADER)

    def test_refuses_a_missing_required_role(self) -> None:
        with self.assertRaisesRegex(hkr.RegisterError, "'db1'"):
            hkr.check(register(app1=1), require=["app1", "db1"])
        with self.assertRaises(hkr.RegisterError):
            hkr.check(HEADER, require=["app1"])

    def test_refuses_an_invalid_register(self) -> None:
        with self.assertRaises(hkr.RegisterError):
            hkr.check(f"{DOC_IPV4} ssh-ed25519 {BODY_A}\n")


class CommandLineTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = pathlib.Path(self.tmp.name) / "register.txt"
        self.path.write_text(HEADER, encoding="utf-8")
        self.keyfile = pathlib.Path(self.tmp.name) / "key.pub"

    def run_cli(self, *argv: str, stdin: str | None = None) -> tuple[int, str, str]:
        out, err = io.StringIO(), io.StringIO()
        stdin_obj = io.TextIOWrapper(io.BytesIO((stdin or "").encode()), encoding="utf-8")
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), mock.patch.object(sys, "stdin", stdin_obj):
            code = hkr.main(list(argv))
        return code, out.getvalue(), err.getvalue()

    def test_record_from_stdin_then_fill_then_check(self) -> None:
        code, out, err = self.run_cli("record", "app1", "--register", str(self.path), stdin=key_line(1, "root@h"))
        self.assertEqual((code, err), (0, ""))
        self.assertRegex(out, r"^recorded app1 SHA256:[A-Za-z0-9+/]{43}\n$")
        self.assertEqual(hkr.parse_register(self.path.read_text()), {"app1": BODY_A})

        code, out, err = self.run_cli("fill", "app1", DOC_IPV4, "--register", str(self.path))
        self.assertEqual((code, err), (0, ""))
        self.assertTrue(out.endswith(f"{DOC_IPV4} ssh-ed25519 {BODY_A}\n"))

        code, out, _ = self.run_cli("check", "--require", "app1", "--register", str(self.path))
        self.assertEqual(code, 0)
        self.assertIn("register ok: 1 host(s): app1", out)

    def test_record_from_a_key_file_and_the_repeat_is_reported_not_written(self) -> None:
        self.keyfile.write_text(key_line(1), encoding="utf-8")
        self.assertEqual(self.run_cli("record", "app1", "--key-file", str(self.keyfile), "--register", str(self.path))[0], 0)
        before = self.path.read_text()
        code, out, _ = self.run_cli("record", "app1", "--key-file", str(self.keyfile), "--register", str(self.path))
        self.assertEqual(code, 0)
        self.assertTrue(out.startswith("already recorded app1 "))
        self.assertEqual(self.path.read_text(), before)

    def test_every_refusal_exits_non_zero_with_one_line_and_leaves_the_file_alone(self) -> None:
        self.run_cli("record", "app1", "--register", str(self.path), stdin=key_line(1))
        before = self.path.read_text()
        cases = [
            ("record", "app1", "--register", str(self.path)),
            ("record", "db1", "--register", str(self.path)),
            ("record", "App1", "--register", str(self.path)),
            ("fill", "db1", DOC_IPV4, "--register", str(self.path)),
            ("fill", "app1", "192.0.2.10:22", "--register", str(self.path)),
            ("check", "--require", "db1", "--register", str(self.path)),
            ("check", "--register", str(self.path) + ".missing"),
        ]
        stdins = [key_line(2), key_line(1), key_line(3), None, None, None, None]
        for argv, stdin in zip(cases, stdins):
            code, out, err = self.run_cli(*argv, stdin=stdin)
            self.assertEqual(code, 1, msg=argv)
            self.assertEqual(out, "", msg=argv)
            self.assertEqual(len(err.strip().splitlines()), 1, msg=argv)
            self.assertTrue(err.startswith("host_key_register: refused: "), msg=argv)
        self.assertEqual(self.path.read_text(), before)

    def test_a_register_with_a_bad_line_is_refused_by_every_command(self) -> None:
        self.path.write_text(f"{DOC_IPV4} ssh-ed25519 {BODY_A}\n", encoding="utf-8")
        for argv in (("check",), ("fill", "app1", DOC_IPV4), ("record", "app1")):
            code, _, err = self.run_cli(*argv, "--register", str(self.path), stdin=key_line(1))
            self.assertEqual(code, 1, msg=argv)
            self.assertIn("refused", err)

    def test_the_default_register_is_the_one_beside_the_scripts_directory(self) -> None:
        self.assertEqual(hkr.DEFAULT_REGISTER, REGISTER)


class NoNetworkTests(unittest.TestCase):
    """The tool reads a file and prints text. It must stay that way."""

    def test_the_module_imports_nothing_that_reaches_a_network_or_runs_a_process(self) -> None:
        tree = ast.parse((_HERE / "host_key_register.py").read_text(encoding="utf-8"))
        imported: set[str] = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name.split(".")[0] for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        forbidden = {"subprocess", "socket", "ssl", "urllib", "http", "ftplib", "smtplib", "asyncio", "requests", "pty"}
        self.assertEqual(imported & forbidden, set())

    def test_it_never_calls_a_process_or_keyscan(self) -> None:
        tree = ast.parse((_HERE / "host_key_register.py").read_text(encoding="utf-8"))
        calls = {
            node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
        }
        self.assertTrue({"system", "popen", "run", "Popen", "check_output", "exec", "eval"}.isdisjoint(calls))


# --- the shipped register -------------------------------------------------------------

_IPV4_SHAPE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
_IPV6_SHAPE = re.compile(r"(?:\b[0-9A-Fa-f]{1,4}:){2,}|::")
_HOSTNAME_SHAPE = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+")
_DATA_LINE = re.compile(r"[a-z][a-z0-9-]{0,31} ssh-ed25519 [A-Za-z0-9+/]+={0,2}")


def register_leaks(text: str) -> list[str]:
    """Every line of `text` that could carry an address, or that is not a role and a key.

    A non-comment line may be only `role ssh-ed25519 base64`; a comment line may
    carry no IPv4 address, IPv6 address or host name shape.
    """
    problems = []
    for number, line in enumerate(text.split("\n"), start=1):
        if not line.strip():
            continue
        if line.startswith("#"):
            for name, shape in (("IPv4", _IPV4_SHAPE), ("IPv6", _IPV6_SHAPE), ("host name", _HOSTNAME_SHAPE)):
                if shape.search(line):
                    problems.append(f"line {number}: a comment carries an {name} shape")
        elif not _DATA_LINE.fullmatch(line):
            problems.append(f"line {number}: not exactly `role ssh-ed25519 <base64>`")
    return problems


class ShippedRegisterTests(unittest.TestCase):
    def test_the_shipped_register_parses_and_passes_check(self) -> None:
        text = REGISTER.read_text(encoding="utf-8")
        hkr.parse_register(text)
        hkr.check(text)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(hkr.main(["check"]), 0)

    def test_the_shipped_register_carries_no_address_and_only_role_type_key_lines(self) -> None:
        self.assertEqual(register_leaks(REGISTER.read_text(encoding="utf-8")), [])

    def test_the_shipped_register_is_a_plain_file_not_a_link(self) -> None:
        self.assertTrue(REGISTER.is_file() and not REGISTER.is_symlink())

    def test_every_recorded_key_is_a_public_ed25519_key_blob(self) -> None:
        # Vacuous while the register ships empty; it starts to bite when a key is recorded.
        for role, body in hkr.parse_register(REGISTER.read_text(encoding="utf-8")).items():
            self.assertRegex(role, r"^[a-z][a-z0-9-]{0,31}$")
            self.assertIsNone(hkr._blob_error(body))

    def test_the_static_guard_catches_what_it_is_there_to_catch(self) -> None:
        """Control cases: without them the test above would pass against a broken guard."""
        good = REGISTER.read_text(encoding="utf-8") + f"app1 ssh-ed25519 {BODY_A}\n"
        self.assertEqual(register_leaks(good), [])
        for leak in (
            f"{DOC_IPV4} ssh-ed25519 {BODY_A}\n",
            f"app1 ssh-ed25519 {BODY_A} {DOC_IPV4}\n",
            f"app1 ssh-ed25519 {BODY_A} comment\n",
            f"[{DOC_IPV4}]:22 ssh-ed25519 {BODY_A}\n",
            f"{DOC_NAME} ssh-ed25519 {BODY_A}\n",
            f"2001:db8::1 ssh-ed25519 {BODY_A}\n",
            f"# the app host is {DOC_IPV4}\n",
            "# reach it at host.example.com\n",
            "# reach it at 2001:db8::1\n",
            f"app1 {BODY_A}\n",
        ):
            self.assertNotEqual(register_leaks(good + leak), [], msg=leak)


# --- the workflow and the runbook call the tool and keep no second copy -------------------

class WorkflowWiringTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.text = WORKFLOW.read_text(encoding="utf-8")

    def index(self, needle: str, start: int = 0) -> int:
        at = self.text.find(needle, start)
        self.assertGreaterEqual(at, 0, msg=f"{needle!r} is not in provision-tenant.yml")
        return at

    def test_the_fill_step_sits_between_generation_and_the_handover_pull_request(self) -> None:
        generate = self.index("- name: Clone and generate")
        fill = self.index("- name: Fill the tenant's known_hosts from the host-key register")
        handover = self.index("- name: Open the handover pull request")
        self.assertLess(generate, fill)
        self.assertLess(fill, handover)

    def test_the_fill_step_uses_the_tool_with_role_app1_and_the_input_address(self) -> None:
        start = self.index("- name: Fill the tenant's known_hosts from the host-key register")
        step = self.text[start:self.index("- name: Mint, escrow and publish", start)]
        self.assertIn('host_key_register.py fill app1 "$APP_HOST_SSH_ADDRESS"', step)
        self.assertIn("tenant/known_hosts", step)
        self.assertIn("set -euo pipefail", step)
        self.assertIn("::error::", step)
        self.assertIn("host_key_register.py record app1", step)

    def test_the_preflight_runs_in_validate_inputs_before_anything_is_created(self) -> None:
        validate = self.index("- name: Validate inputs")
        preflight = self.index("host_key_register.py check --require app1")
        create = self.index("- name: Generate the tenant repo from the template")
        self.assertLess(validate, preflight)
        self.assertLess(preflight, create)
        self.assertIn("host_key_register.py record app1", self.text[validate:create])
        self.assertIn('host_key_register.py fill app1 "$APP_HOST_SSH_ADDRESS" > /dev/null', self.text[validate:create])

    def test_the_workflow_never_scans_for_a_host_key(self) -> None:
        # The word may appear only to forbid itself ("Never ssh-keyscan").
        for match in re.finditer(r"ssh-keyscan", self.text):
            before = self.text[max(0, match.start() - 40):match.start()].lower()
            self.assertRegex(before, r"never[\s#]+`?$", msg=f"ssh-keyscan used other than to forbid it: {before!r}")

    def test_the_handover_text_no_longer_asks_for_known_hosts_by_hand(self) -> None:
        start = self.index("- name: Open the handover pull request")
        handover = self.text[start:]
        self.assertNotIn("host key, taken from the host over", handover)
        self.assertNotRegex(handover, r"- `known_hosts` —")
        self.assertRegex(handover, r"host-key\s+register")
        before = self.text[self.index("# Deliberately never pushes"):start]
        self.assertIn("two things", before)
        self.assertNotIn("three things", before)

    def test_the_runbook_points_at_the_register_not_at_a_hand_step(self) -> None:
        text = RUNBOOK.read_text(encoding="utf-8")
        self.assertIn("host_key_register.py record app1", text)
        self.assertNotIn("Write one line into `known_hosts`", text)
        self.assertNotRegex(text, r"(?m)^\s*ssh-keyscan\b")


# --- the filled file against a real ssh client and a real sshd ---------------------------

def _tool(name: str, *extra: str) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for path in extra:
        if os.access(path, os.X_OK):
            return path
    return None


SSH = _tool("ssh")
SSH_KEYGEN = _tool("ssh-keygen")
SSHD = _tool("sshd", "/usr/sbin/sshd", "/usr/local/sbin/sshd", "/opt/homebrew/sbin/sshd")


def _missing(*needs: tuple[str, str | None]) -> str:
    return ", ".join(name for name, path in needs if not path)


def _unavailable(test: unittest.TestCase, what: str) -> None:
    """On CI a missing tool is a failure, not a skip: a skipped proof proves nothing."""
    if IN_CI:
        test.fail(f"{what} is missing on CI, so the real-ssh proof did not run")
    test.skipTest(f"{what} is missing here; the real-ssh proof runs on CI")


def keygen(path: pathlib.Path) -> str:
    """Make an ed25519 keypair at `path`; return its public key line."""
    subprocess.run([SSH_KEYGEN, "-q", "-t", "ed25519", "-N", "", "-C", "test-key", "-f", str(path)], check=True)
    return pathlib.Path(f"{path}.pub").read_text(encoding="utf-8")


class RealKeygenTests(unittest.TestCase):
    def test_a_key_line_written_by_ssh_keygen_is_accepted_and_recorded(self) -> None:
        if not SSH_KEYGEN:
            _unavailable(self, "ssh-keygen")
        with tempfile.TemporaryDirectory() as tmp:
            line = keygen(pathlib.Path(tmp) / "host")
            body = hkr.parse_key_line(line)
            out = hkr.record(HEADER, "app1", line)
            self.assertEqual(hkr.parse_register(out), {"app1": body})
            shown = subprocess.run(
                [SSH_KEYGEN, "-l", "-f", f"{tmp}/host.pub"], check=True, capture_output=True, text=True
            ).stdout
            self.assertIn(hkr.fingerprint(body), shown)


class RealSshdTests(unittest.TestCase):
    """The control for the trust root: a real ssh client held to a real sshd by the filled file.

    The steps, the fixture and the reason for HostKeyAlias are in
    host_key_register.md under "The proof".
    """

    ADDRESS = "127.0.0.1"

    def setUp(self) -> None:
        missing = _missing(("ssh", SSH), ("ssh-keygen", SSH_KEYGEN), ("sshd", SSHD))
        if missing:
            _unavailable(self, missing)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = pathlib.Path(self.tmp.name)
        self.host_line = keygen(self.dir / "host_key")
        self.client_line = keygen(self.dir / "client_key")
        (self.dir / "authorized_keys").write_text(self.client_line, encoding="utf-8")
        for name in ("host_key", "client_key", "authorized_keys"):
            os.chmod(self.dir / name, 0o600)
        self.port = self._free_port()
        config = "\n".join(
            [
                f"Port {self.port}",
                f"ListenAddress {self.ADDRESS}",
                f"HostKey {self.dir / 'host_key'}",
                f"PidFile {self.dir / 'sshd.pid'}",
                f"AuthorizedKeysFile {self.dir / 'authorized_keys'}",
                "PubkeyAuthentication yes",
                "PasswordAuthentication no",
                "KbdInteractiveAuthentication no",
                "UsePAM no",
                "StrictModes no",
                "LogLevel ERROR",
                "",
            ]
        )
        (self.dir / "sshd_config").write_text(config, encoding="utf-8")
        self.sshd_log = open(self.dir / "sshd.log", "wb")
        self.addCleanup(self.sshd_log.close)
        self.proc = subprocess.Popen(
            [SSHD, "-D", "-e", "-f", str(self.dir / "sshd_config")],
            stdin=subprocess.DEVNULL,
            stdout=self.sshd_log,
            stderr=subprocess.STDOUT,
        )
        self.addCleanup(self._stop)
        self._wait_for_port()

    @staticmethod
    def _free_port() -> int:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            return probe.getsockname()[1]

    def _stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()

    def _sshd_log_text(self) -> str:
        self.sshd_log.flush()
        return (self.dir / "sshd.log").read_text(errors="replace").strip()[:2000]

    def _wait_for_port(self, deadline_seconds: float = 20.0) -> None:
        deadline = time.monotonic() + deadline_seconds
        pause = threading.Event()
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                break
            try:
                with socket.create_connection((self.ADDRESS, self.port), timeout=1):
                    return
            except OSError:
                pause.wait(0.05)
        message = f"the loopback sshd did not come up on port {self.port} (exit {self.proc.poll()}): {self._sshd_log_text()}"
        if IN_CI:
            self.fail(message)
        self.skipTest(message)

    def _ssh(self, known_hosts: pathlib.Path) -> subprocess.CompletedProcess[str]:
        argv = [
            SSH,
            "-F", "/dev/null",
            "-p", str(self.port),
            "-l", getpass.getuser(),
            "-i", str(self.dir / "client_key"),
            "-o", "IdentitiesOnly=yes",
            "-o", "IdentityAgent=none",
            "-o", "BatchMode=yes",
            "-o", "StrictHostKeyChecking=yes",
            "-o", f"UserKnownHostsFile={known_hosts}",
            "-o", "GlobalKnownHostsFile=/dev/null",
            "-o", "HostKeyAlgorithms=ssh-ed25519",
            "-o", f"HostKeyAlias={self.ADDRESS}",
            "-o", "CheckHostIP=no",
            "-o", "ConnectTimeout=10",
            self.ADDRESS,
            "true",
        ]
        return subprocess.run(argv, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)

    def _filled(self, register_text: str, name: str) -> pathlib.Path:
        path = self.dir / name
        path.write_text(hkr.fill(register_text, "app1", self.ADDRESS), encoding="utf-8")
        return path

    def test_green_red_green_on_one_changed_character_of_the_recorded_key(self) -> None:
        recorded = hkr.record(HEADER, "app1", self.host_line)
        body = hkr.parse_register(recorded)["app1"]

        # Green: the register holds the host's real key.
        green = self._ssh(self._filled(recorded, "known_hosts_green"))
        self.assertEqual(green.returncode, 0, msg=f"green phase refused:\n{green.stderr}\nsshd log:\n{self._sshd_log_text()}")

        # Red: the same register with one character of the key changed. Position 40
        # lies inside the 32 key bytes, so the line is still a well-formed key that
        # is not this host's.
        swapped = ("A" if body[40] != "A" else "B")
        sabotaged_body = body[:40] + swapped + body[41:]
        self.assertNotEqual(sabotaged_body, body)
        sabotaged = recorded.replace(body, sabotaged_body)
        self.assertNotEqual(sabotaged, recorded)
        red = self._ssh(self._filled(sabotaged, "known_hosts_red"))
        self.assertNotEqual(red.returncode, 0, msg="the sabotaged key was accepted")
        self.assertIn("Host key verification failed", red.stderr)
        self.assertIn("REMOTE HOST IDENTIFICATION HAS CHANGED", red.stderr)
        self.assertNotIn("Permission denied", red.stderr)

        # Green again: restored.
        restored = self._ssh(self._filled(recorded, "known_hosts_restored"))
        self.assertEqual(restored.returncode, 0, msg=f"restored phase refused:\n{restored.stderr}\nsshd log:\n{self._sshd_log_text()}")

    def test_an_empty_known_hosts_is_refused_not_trusted_on_first_use(self) -> None:
        empty = self.dir / "known_hosts_empty"
        empty.write_text("", encoding="utf-8")
        result = self._ssh(empty)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Host key verification failed", result.stderr)

    def test_a_key_recorded_for_another_host_is_refused(self) -> None:
        other = keygen(self.dir / "other_host")
        recorded = hkr.record(HEADER, "app1", other)
        result = self._ssh(self._filled(recorded, "known_hosts_other"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Host key verification failed", result.stderr)


if __name__ == "__main__":
    unittest.main()
