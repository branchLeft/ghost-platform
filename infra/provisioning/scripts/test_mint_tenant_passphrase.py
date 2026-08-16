#!/usr/bin/env python3
"""Unit tests for mint-tenant-passphrase.

This script's output becomes a tenant's `PULUMI_CONFIG_PASSPHRASE` -- the only
thing standing between that tenant's stack and permanent unavailability once
GCP KMS is gone. These tests check the properties that matter for that: the
generator is the CSPRNG one and not the predictable one, the entropy floor is
enforced rather than merely documented, two mints never collide in a sample
large enough to make a collision meaningful, and the value on stdout is
exactly the passphrase -- no newline, no label, nothing a naive `$(...)`
capture in the workflow could get wrong.
"""

import importlib.util
import io
import pathlib
import re
import unittest
from contextlib import redirect_stdout


def _load_module():
    """Import the script by path: its filename has hyphens, so it is not a
    legal module name for a plain import."""
    path = pathlib.Path(__file__).resolve().parent / "mint-tenant-passphrase.py"
    spec = importlib.util.spec_from_file_location("mint_tenant_passphrase", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mint_mod = _load_module()

# token_urlsafe's alphabet: base64 URL-safe, no padding.
URLSAFE_B64 = re.compile(r"\A[A-Za-z0-9_-]+\Z")


class MintTests(unittest.TestCase):
    def test_default_call_meets_the_entropy_floor(self):
        value = mint_mod.mint()
        # token_urlsafe(n) encodes n bytes into roughly ceil(4n/3) chars.
        # 32 bytes must not shrink to something a human could plausibly type
        # or brute-force -- assert a floor well below the true output length
        # rather than the exact formula, so a future encoding tweak upstream
        # doesn't make this test brittle for no security reason.
        self.assertGreaterEqual(len(value), 40)

    def test_uses_the_urlsafe_alphabet(self):
        value = mint_mod.mint()
        self.assertRegex(value, URLSAFE_B64)

    def test_refuses_below_the_entropy_floor(self):
        with self.assertRaises(SystemExit):
            mint_mod.mint(16)

    def test_accepts_exactly_the_floor(self):
        # The floor itself must still work -- a boundary that only rejects
        # the value one below it and never accepts the value at it is a
        # boundary drawn in the wrong place.
        value = mint_mod.mint(mint_mod.MIN_BYTES)
        self.assertTrue(value)

    def test_more_bytes_asked_for_is_never_refused(self):
        value = mint_mod.mint(64)
        self.assertTrue(value)

    def test_successive_mints_do_not_collide(self):
        # Not a proof of randomness -- a smoke test that would fail hard if
        # the generator were ever swapped for something deterministic or
        # zero-entropy (an empty string, a fixed constant).
        values = {mint_mod.mint() for _ in range(200)}
        self.assertEqual(len(values), 200)

    def test_uses_the_csprng_module_not_random(self):
        # `random` is a Mersenne Twister: predictable from enough observed
        # output, and exactly the wrong tool for a secret. Assert the
        # implementation calls through `secrets`, not merely that its output
        # happens to look random this run.
        source = pathlib.Path(mint_mod.__file__).read_text()
        self.assertIn("secrets.token_urlsafe", source)
        self.assertNotRegex(source, r"(?<!\w)random\.")


class MainTests(unittest.TestCase):
    def test_stdout_is_exactly_the_passphrase_no_newline_no_label(self):
        captured = io.StringIO()
        with redirect_stdout(captured):
            mint_mod.main([])
        output = captured.getvalue()
        self.assertNotIn("\n", output)
        self.assertRegex(output, URLSAFE_B64)

    def test_bytes_flag_is_honoured(self):
        captured = io.StringIO()
        with redirect_stdout(captured):
            mint_mod.main(["--bytes", "64"])
        shorter = io.StringIO()
        with redirect_stdout(shorter):
            mint_mod.main(["--bytes", "32"])
        self.assertGreater(len(captured.getvalue()), len(shorter.getvalue()))

    def test_bytes_flag_below_the_floor_exits_nonzero(self):
        with self.assertRaises(SystemExit):
            mint_mod.main(["--bytes", "8"])


if __name__ == "__main__":
    unittest.main()
