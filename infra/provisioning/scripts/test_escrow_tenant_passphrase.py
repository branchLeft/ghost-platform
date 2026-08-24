"""Unit tests for escrow-tenant-passphrase.py.

This is a security-sensitive path: if the escrow silently produces something
that cannot be decrypted, the failure surfaces only when a tenant's passphrase
is already lost, at which point that tenant's stack cannot be decrypted *or*
destroyed. So the tests exercise the real openssl invocations round-trip rather
than asserting on argument lists.
"""

from __future__ import annotations

import base64
import importlib.util
import io
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parent

_spec = importlib.util.spec_from_file_location(
    "escrow_tenant_passphrase", SCRIPTS / "escrow-tenant-passphrase.py"
)
assert _spec and _spec.loader
module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(module)


# One keypair per size for the whole module. RSA-3072 keygen is seconds, and a
# fresh pair per test turned this file into the slowest thing in the repo -- a
# test suite people skip is a test suite that stops catching anything. The
# directory lives as long as the process and is removed with it.
_KEY_DIR = tempfile.TemporaryDirectory()
_KEYS: dict[int, tuple[pathlib.Path, pathlib.Path]] = {}


def keypair(bits: int = 3072) -> tuple[pathlib.Path, pathlib.Path]:
    if bits not in _KEYS:
        directory = pathlib.Path(_KEY_DIR.name) / str(bits)
        directory.mkdir()
        private = directory / "private.pem"
        public = directory / "public.pem"
        subprocess.run(
            ["openssl", "genpkey", "-algorithm", "RSA",
             "-pkeyopt", f"rsa_keygen_bits:{bits}", "-out", str(private)],
            check=True, capture_output=True,
        )
        os.chmod(private, 0o600)
        subprocess.run(
            ["openssl", "pkey", "-in", str(private), "-pubout", "-out", str(public)],
            check=True, capture_output=True,
        )
        _KEYS[bits] = (private, public)
    return _KEYS[bits]


class RoundTrip(unittest.TestCase):
    def test_a_minted_passphrase_recovers_exactly(self) -> None:
        private, public = keypair()
        secret = base64.urlsafe_b64encode(os.urandom(32)).decode("ascii")
        self.assertEqual(module.decrypt(module.escrow(secret, public), private), secret)

    def test_the_ciphertext_is_the_full_modulus_width(self) -> None:
        # A short ciphertext would mean the padding mode was not what this
        # thinks it was, and the recovery command in the runbook would fail.
        _, public = keypair()
        raw = base64.b64decode(module.escrow("x", public), validate=True)
        self.assertEqual(len(raw), 3072 // 8)

    def test_two_escrows_of_one_value_differ(self) -> None:
        # OAEP is randomised. Deterministic output would let anyone holding the
        # public key confirm a guessed passphrase from a published ciphertext.
        _, public = keypair()
        self.assertNotEqual(module.escrow("same", public), module.escrow("same", public))

    def test_the_recovery_one_liner_in_the_runbook_works(self) -> None:
        # The runbook tells an operator to decrypt without this repository. If
        # that command drifts from what `escrow()` produced, the escrow is
        # unusable exactly when it is needed, so it is asserted here.
        private, public = keypair()
        with tempfile.TemporaryDirectory() as tmp:
            directory = pathlib.Path(tmp)
            ciphertext = directory / "cipher.bin"
            ciphertext.write_bytes(base64.b64decode(module.escrow("recover-me", public)))
            result = subprocess.run(
                ["openssl", "pkeyutl", "-decrypt", "-inkey", str(private),
                 "-pkeyopt", "rsa_padding_mode:oaep",
                 "-pkeyopt", "rsa_oaep_md:sha256",
                 "-pkeyopt", "rsa_mgf1_md:sha256",
                 "-in", str(ciphertext)],
                check=True, capture_output=True,
            )
            self.assertEqual(result.stdout.decode(), "recover-me")


class Refusals(unittest.TestCase):
    def test_an_empty_passphrase_is_refused(self) -> None:
        _, public = keypair()
        with self.assertRaises(module.EscrowError):
            module.escrow("", public)

    def test_a_missing_key_is_refused_by_name(self) -> None:
        with self.assertRaises(module.EscrowError) as caught:
            module.escrow("x", pathlib.Path("/nonexistent/escrow.pem"))
        self.assertIn("missing", str(caught.exception))

    def test_a_private_key_file_is_refused_outright(self) -> None:
        # The realistic mistake: pointing the flag at the wrong half. Committing
        # or publishing the private half would hand every tenant passphrase to
        # anyone who ever reads the repository.
        private, _ = keypair()
        with self.assertRaises(module.EscrowError) as caught:
            module.escrow("x", private)
        # Either refusal is correct and both name the private half: the PEM
        # header check fires first for an ordinary `genpkey` output, and the
        # explicit `PRIVATE KEY` block check catches a file carrying both.
        self.assertIn("PRIVATE", str(caught.exception))

    def test_a_key_below_the_minimum_size_is_refused(self) -> None:
        _, public = keypair(bits=2048)
        with self.assertRaises(module.EscrowError) as caught:
            module.escrow("x", public)
        self.assertIn("2048", str(caught.exception))

    def test_a_non_key_file_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "notakey.pem"
            path.write_text("hello\n", encoding="utf-8")
            with self.assertRaises(module.EscrowError):
                module.escrow("x", path)

    def test_an_over_long_passphrase_is_refused_rather_than_chunked(self) -> None:
        _, public = keypair()
        with self.assertRaises(module.EscrowError) as caught:
            module.escrow("a" * 4096, public)
        self.assertIn("RSA-OAEP", str(caught.exception))


class Main(unittest.TestCase):
    def test_self_test_exits_zero(self) -> None:
        self.assertEqual(module.main(["--self-test"]), 0)

    def test_stdout_carries_only_the_ciphertext(self) -> None:
        # The caller captures this with `$(...)`. Anything else on stdout ends
        # up inside the escrowed value's transport.
        private, public = keypair()
        stdin, stdout = io.StringIO("a-passphrase\n"), io.StringIO()
        saved_in, saved_out = sys.stdin, sys.stdout
        sys.stdin, sys.stdout = stdin, stdout
        try:
            status = module.main(["--public-key", str(public)])
        finally:
            sys.stdin, sys.stdout = saved_in, saved_out
        self.assertEqual(status, 0)
        printed = stdout.getvalue()
        self.assertNotIn("\n", printed)
        self.assertEqual(module.decrypt(printed, private), "a-passphrase")

    def test_a_missing_key_exits_one(self) -> None:
        self.assertEqual(module.main(["--public-key", "/nonexistent/escrow.pem"]), 1)

    def test_self_test_refuses_a_public_key_argument(self) -> None:
        self.assertEqual(module.main(["--self-test", "--public-key", "x.pem"]), 1)


if __name__ == "__main__":
    unittest.main()
