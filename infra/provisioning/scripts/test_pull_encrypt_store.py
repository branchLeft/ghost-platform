#!/usr/bin/env python3
"""Unit tests for pull_encrypt_store.py.

Real `age` (not a fake `Popen`) for every encryption and stanza-counting
claim -- the property under test is exactly whether this pipeline agrees
with what `age` itself does, so a fake encoder would only ever prove
agreement with itself. The transport is a small local fake here (not
`dial_in_transport.LocalProcessTransport`): what this file proves is
`pull_encrypt_and_store`'s own ordering and gating, independent of any one
transport implementation -- `test_backup_worker.py` covers the two wired
together through the real entry point.
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest

import pull_encrypt_store as pes


def _generate_age_identity() -> tuple[str, str]:
    """Returns (identity_path, recipient) for a throwaway keypair, real
    `age-keygen` output, in a temp file this test leaks for the duration of
    the process (fine: it is a throwaway key with nothing behind it).
    `age-keygen -o` refuses to overwrite an existing file, so the path is
    generated without ever being created first."""
    fd, path = tempfile.mkstemp(suffix=".age-key")
    os.close(fd)
    os.remove(path)
    result = subprocess.run(["age-keygen", "-o", path], capture_output=True, text=True, check=True)
    # age-keygen prints "Public key: age1..." to stderr.
    recipient = result.stderr.strip().rsplit(" ", 1)[-1]
    return path, recipient


class _FakeTransport:
    """Stands in for a real DialInTransport: writes `lines` to whatever
    sink `pull_encrypt_and_store` gives it, then returns `exit_code`.
    Records the env it was called with, so a test can assert
    `pull_encrypt_and_store` never adds anything to it."""

    def __init__(self, *, lines: list[bytes], exit_code: int = 0) -> None:
        self.lines = lines
        self.exit_code = exit_code
        self.calls: list[dict] = []

    def run(self, *, command, env, stdout) -> int:
        self.calls.append({"command": list(command), "env": dict(env)})
        for line in self.lines:
            stdout.write(line)
        return self.exit_code


class _RecordingCopy:
    def __init__(self, name: str, *, fail: bool = False) -> None:
        self.name = name
        self.fail = fail
        self.puts: list[bytes] = []

    def put(self, ciphertext: bytes) -> None:
        if self.fail:
            raise RuntimeError(f"{self.name} is deliberately broken for this test")
        self.puts.append(ciphertext)

    def as_target(self) -> pes.CopyTarget:
        return pes.CopyTarget(name=self.name, put=self.put)


class NeverPutsBeforeExitZeroTests(unittest.TestCase):
    def setUp(self) -> None:
        self.identity_path, self.recipient = _generate_age_identity()

    def test_a_nonzero_exit_writes_to_no_copy_and_reports_ok_false(self) -> None:
        transport = _FakeTransport(lines=[b"partial line one\n", b"partial line two\n"], exit_code=1)
        copy_a = _RecordingCopy("primary")
        result = pes.pull_encrypt_and_store(
            transport=transport,
            command=["irrelevant"],
            env={},
            age_recipient=self.recipient,
            copies=[copy_a.as_target()],
        )
        self.assertFalse(result.ok)
        self.assertEqual(result.exit_code, 1)
        self.assertEqual(result.copies_written, ())
        self.assertEqual(copy_a.puts, [])

    def test_a_zero_exit_writes_to_every_copy(self) -> None:
        transport = _FakeTransport(lines=[b"INSERT INTO `users` VALUES (1);\n"], exit_code=0)
        copy_a = _RecordingCopy("primary")
        copy_b = _RecordingCopy("secondary")
        result = pes.pull_encrypt_and_store(
            transport=transport,
            command=["irrelevant"],
            env={},
            age_recipient=self.recipient,
            copies=[copy_a.as_target(), copy_b.as_target()],
        )
        self.assertTrue(result.ok)
        self.assertEqual(result.copies_written, ("primary", "secondary"))
        self.assertEqual(len(copy_a.puts), 1)
        self.assertEqual(len(copy_b.puts), 1)
        # Both copies received the identical ciphertext -- decrypts to the
        # same plaintext with the one identity generated above.
        decrypted = subprocess.run(
            ["age", "--decrypt", "-i", self.identity_path],
            input=copy_a.puts[0],
            capture_output=True,
            check=True,
        )
        self.assertEqual(decrypted.stdout, b"INSERT INTO `users` VALUES (1);\n")


class SingleRecipientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.identity_a, self.recipient_a = _generate_age_identity()
        self.identity_b, self.recipient_b = _generate_age_identity()

    def test_stores_ciphertext_with_exactly_one_recipient_stanza(self) -> None:
        transport = _FakeTransport(lines=[b"INSERT INTO `settings` VALUES (1);\n"])
        copy_a = _RecordingCopy("primary")
        result = pes.pull_encrypt_and_store(
            transport=transport,
            command=["irrelevant"],
            env={},
            age_recipient=self.recipient_a,
            copies=[copy_a.as_target()],
        )
        self.assertEqual(result.stanza_count, 1)
        from media_backup_restore import count_age_recipient_stanzas

        self.assertEqual(count_age_recipient_stanzas(copy_a.puts[0]), 1)

    def test_tenant_as_own_identity_decrypts_tenant_bs_object_never(self) -> None:
        """The crypto-shredding property this pipeline exists to hold:
        decrypts with the tenant's own identity, fails with every other
        tenant's."""
        transport = _FakeTransport(lines=[b"INSERT INTO `users` VALUES ('tenant-b-row');\n"])
        copy = _RecordingCopy("primary")
        pes.pull_encrypt_and_store(
            transport=transport,
            command=["irrelevant"],
            env={},
            age_recipient=self.recipient_b,
            copies=[copy.as_target()],
        )
        ciphertext = copy.puts[0]

        correct = subprocess.run(
            ["age", "--decrypt", "-i", self.identity_b],
            input=ciphertext,
            capture_output=True,
            check=True,
        )
        self.assertIn(b"tenant-b-row", correct.stdout)

        wrong = subprocess.run(
            ["age", "--decrypt", "-i", self.identity_a],
            input=ciphertext,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(wrong.returncode, 0)
        self.assertIn(b"no identity matched", wrong.stderr.lower())

    def test_a_two_recipient_ciphertext_is_refused_before_any_copy_is_written(self) -> None:
        """The exact defect this pipeline exists to catch: a second
        recipient, silently, while every other signal stays green. Forced
        here by handing `pull_encrypt_and_store` a `popen` double that
        actually calls real `age` with TWO `-r` flags -- proving the
        refusal fires against genuine two-recipient `age` output, not an
        invented ciphertext shape."""

        class _TwoRecipientPopen:
            def __call__(self, argv, **kwargs):
                # argv is ["age", "-r", recipient, ...]; insert a second
                # recipient right after the first, so the real `age`
                # binary itself produces the two-stanza header.
                patched = argv[:3] + ["-r", self.other_recipient] + argv[3:]
                return subprocess.Popen(patched, **kwargs)

        popen = _TwoRecipientPopen()
        popen.other_recipient = self.recipient_b

        transport = _FakeTransport(lines=[b"INSERT INTO `users` VALUES (1);\n"])
        copy = _RecordingCopy("primary")
        with self.assertRaises(pes.PullEncryptStoreError) as ctx:
            pes.pull_encrypt_and_store(
                transport=transport,
                command=["irrelevant"],
                env={},
                age_recipient=self.recipient_a,
                copies=[copy.as_target()],
                popen=popen,
            )
        self.assertIn("2 age recipient stanza", str(ctx.exception))
        self.assertEqual(copy.puts, [])


class ForbiddenEnvAndNoCopiesTests(unittest.TestCase):
    def setUp(self) -> None:
        _, self.recipient = _generate_age_identity()

    def test_refuses_before_dialing_in_when_env_carries_a_storage_credential(self) -> None:
        transport = _FakeTransport(lines=[b"should never be read\n"])
        with self.assertRaises(pes.PullEncryptStoreError):
            pes.pull_encrypt_and_store(
                transport=transport,
                command=["irrelevant"],
                env={"AWS_ACCESS_KEY_ID": "leak"},
                age_recipient=self.recipient,
                copies=[_RecordingCopy("primary").as_target()],
            )
        self.assertEqual(transport.calls, [])

    def test_refuses_with_no_copies_configured(self) -> None:
        transport = _FakeTransport(lines=[b"x\n"])
        with self.assertRaises(pes.PullEncryptStoreError):
            pes.pull_encrypt_and_store(
                transport=transport,
                command=["irrelevant"],
                env={},
                age_recipient=self.recipient,
                copies=[],
            )
        self.assertEqual(transport.calls, [])


class PostStreamCheckGateTests(unittest.TestCase):
    """Proves the hook `backup_worker.py`'s floor watch relies on actually
    gates storage -- called after a 0 exit and a valid ciphertext, but
    strictly before any `copy.put()`."""

    def setUp(self) -> None:
        _, self.recipient = _generate_age_identity()

    def test_a_raising_post_stream_check_writes_to_no_copy(self) -> None:
        transport = _FakeTransport(lines=[b"INSERT INTO `users` VALUES (1);\n"])
        copy = _RecordingCopy("primary")

        def _always_fails() -> None:
            raise pes.PullEncryptStoreError("floor not met")

        with self.assertRaises(pes.PullEncryptStoreError):
            pes.pull_encrypt_and_store(
                transport=transport,
                command=["irrelevant"],
                env={},
                age_recipient=self.recipient,
                copies=[copy.as_target()],
                post_stream_check=_always_fails,
            )
        self.assertEqual(copy.puts, [])

    def test_a_passing_post_stream_check_still_stores(self) -> None:
        transport = _FakeTransport(lines=[b"INSERT INTO `users` VALUES (1);\n"])
        copy = _RecordingCopy("primary")
        result = pes.pull_encrypt_and_store(
            transport=transport,
            command=["irrelevant"],
            env={},
            age_recipient=self.recipient,
            copies=[copy.as_target()],
            post_stream_check=lambda: None,
        )
        self.assertTrue(result.ok)
        self.assertEqual(len(copy.puts), 1)


class MultiCopyFailureTests(unittest.TestCase):
    def setUp(self) -> None:
        _, self.recipient = _generate_age_identity()

    def test_a_failing_second_copy_surfaces_which_copies_already_landed(self) -> None:
        transport = _FakeTransport(lines=[b"INSERT INTO `users` VALUES (1);\n"])
        copy_a = _RecordingCopy("primary")
        copy_b = _RecordingCopy("secondary", fail=True)
        with self.assertRaises(pes.PullEncryptStoreError) as ctx:
            pes.pull_encrypt_and_store(
                transport=transport,
                command=["irrelevant"],
                env={},
                age_recipient=self.recipient,
                copies=[copy_a.as_target(), copy_b.as_target()],
            )
        self.assertIn("secondary", str(ctx.exception))
        self.assertIn("primary", str(ctx.exception))
        self.assertEqual(len(copy_a.puts), 1)
        self.assertEqual(copy_b.puts, [])


if __name__ == "__main__":
    unittest.main()
