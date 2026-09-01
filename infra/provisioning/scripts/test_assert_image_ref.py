"""Unit tests for assert-image-ref.py.

The module is loaded by path because its filename is hyphenated to match the
other guard scripts in this directory, which is not importable as a module
name -- the same loader shape as test_assert_tenant_provisioning_scoping.py.
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_SPEC = importlib.util.spec_from_file_location(
    "assert_image_ref", os.path.join(_HERE, "assert-image-ref.py"))
assert_image_ref = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(assert_image_ref)

check = assert_image_ref.check
GOOD = "ghcr.io/branchleft/ghost-tenant@sha256:" + "a" * 64


class Accepts(unittest.TestCase):
    def test_a_digest_pinned_image_in_our_ghcr_namespace(self):
        self.assertIsNone(check(GOOD))

    def test_a_nested_path_under_our_namespace(self):
        self.assertIsNone(
            check("ghcr.io/branchleft/ghost/tenant@sha256:" + "f" * 64))


class RefusesTheWrongRegistry(unittest.TestCase):
    def test_artifact_registry_even_though_it_is_digest_pinned(self):
        """The live shape: this is what registry-push.yml publishes today, and
        it satisfied the digest-only check this script replaces."""
        ref = ("europe-west1-docker.pkg.dev/branchleft-prod/"
               "ghost-platform-tenant/ghost@sha256:" + "b" * 64)
        reason = check(ref)
        self.assertIsNotNone(reason)
        self.assertIn("ghcr.io/branchleft/", reason)

    def test_artifact_registry_names_the_gcp_dependency(self):
        """A refusal that does not say why costs the reader the diagnosis."""
        ref = ("europe-west1-docker.pkg.dev/p/r/ghost@sha256:" + "b" * 64)
        self.assertIn("GCP pull credentials", check(ref))

    def test_docker_hub(self):
        self.assertIsNotNone(check("docker.io/library/ghost@sha256:" + "c" * 64))

    def test_a_lookalike_org_is_not_our_namespace(self):
        """`ghcr.io/branchleft` without the trailing slash also matches
        `branchleftevil`, an org anyone can register."""
        ref = "ghcr.io/branchleftevil/ghost-tenant@sha256:" + "d" * 64
        self.assertIsNotNone(check(ref))

    def test_our_namespace_worn_as_a_path_by_another_registry(self):
        ref = ("evil.example/ghcr.io/branchleft/ghost-tenant@sha256:"
               + "e" * 64)
        self.assertIsNotNone(check(ref))

    def test_a_bare_prefix_with_no_repository(self):
        self.assertIsNotNone(check("ghcr.io/branchleft@sha256:" + "a" * 64))


class RefusesAnUnpinnedOrMalformedDigest(unittest.TestCase):
    def test_a_tag(self):
        self.assertIsNotNone(check("ghcr.io/branchleft/ghost-tenant:latest"))

    def test_no_digest_at_all(self):
        self.assertIsNotNone(check("ghcr.io/branchleft/ghost-tenant"))

    def test_uppercase_hex(self):
        self.assertIsNotNone(
            check("ghcr.io/branchleft/ghost-tenant@sha256:" + "A" * 64))

    def test_a_short_digest(self):
        self.assertIsNotNone(
            check("ghcr.io/branchleft/ghost-tenant@sha256:" + "a" * 63))

    def test_a_long_digest(self):
        self.assertIsNotNone(
            check("ghcr.io/branchleft/ghost-tenant@sha256:" + "a" * 65))

    def test_a_non_sha256_algorithm(self):
        self.assertIsNotNone(
            check("ghcr.io/branchleft/ghost-tenant@sha512:" + "a" * 64))

    def test_a_digest_with_trailing_content(self):
        self.assertIsNotNone(
            check("ghcr.io/branchleft/ghost-tenant@sha256:" + "a" * 64 + " x"))


class RefusesEmptyAndWhitespace(unittest.TestCase):
    def test_empty(self):
        self.assertIsNotNone(check(""))

    def test_none(self):
        self.assertIsNotNone(check(None))

    def test_leading_whitespace(self):
        """A YAML input can carry it, and stripping silently would accept a
        value the operator did not type."""
        self.assertIsNotNone(check(" " + GOOD))

    def test_trailing_newline(self):
        self.assertIsNotNone(check(GOOD + "\n"))


class TheSelfTestIsItselfChecked(unittest.TestCase):
    def test_it_passes_on_the_real_rules(self):
        self.assertEqual(0, assert_image_ref.self_test())

    def test_it_covers_both_outcomes(self):
        """A self-test with no failing case would pass against a check() that
        never refuses anything."""
        outcomes = {should_pass
                    for _, should_pass in assert_image_ref.SELF_TEST_CASES}
        self.assertEqual({True, False}, outcomes)


class TheCliExits(unittest.TestCase):
    def test_nonzero_on_a_refused_ref(self):
        rc = assert_image_ref.main(
            ["assert-image-ref.py", "--image-ref",
             "docker.io/library/ghost@sha256:" + "c" * 64])
        self.assertEqual(1, rc)

    def test_zero_on_an_accepted_ref(self):
        rc = assert_image_ref.main(
            ["assert-image-ref.py", "--image-ref", GOOD])
        self.assertEqual(0, rc)


if __name__ == "__main__":
    unittest.main()
