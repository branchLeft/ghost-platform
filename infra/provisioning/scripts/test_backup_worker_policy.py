#!/usr/bin/env python3
"""Unit tests for backup_worker_policy.py.

The property under test is the issue's own load-bearing mark: "the
worker's put credential is an explicit allow, never a deny-except". Every
test below either proves the rendered policy passes its own assertion, or
proves the assertion actually refuses each way a policy can fail to be
that -- an absent policy, a NotAction/NotPrincipal statement, a wildcard
action, an over-wide grant, an unscoped resource, or simply naming no one.
"""

from __future__ import annotations

import unittest

import backup_worker_policy as bwp

BUCKET = "branchleft-db-backups"
PREFIX = "dumps/"
PRINCIPAL = "arn:aws:iam:::user/1234:AKIAEXAMPLE"


class RenderedPolicyPassesItsOwnAssertionTests(unittest.TestCase):
    def test_the_rendered_policy_is_an_explicit_allow(self) -> None:
        policy = bwp.render_backup_worker_put_policy(bucket=BUCKET, prefix=PREFIX, worker_principal=PRINCIPAL)
        bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)  # must not raise

    def test_a_prefix_without_a_trailing_slash_is_refused_at_render_time(self) -> None:
        with self.assertRaises(bwp.BackupWorkerPolicyError):
            bwp.render_backup_worker_put_policy(bucket=BUCKET, prefix="dumps", worker_principal=PRINCIPAL)


class RefusesAnAbsentOrUnscopedPolicyTests(unittest.TestCase):
    def test_no_statement_at_all_is_refused(self) -> None:
        with self.assertRaises(bwp.BackupWorkerPolicyError) as ctx:
            bwp.assert_explicit_allow_put_only({}, bucket=BUCKET, worker_principal=PRINCIPAL)
        self.assertIn("no Statement", str(ctx.exception))

    def test_a_statement_naming_a_different_principal_is_not_enough(self) -> None:
        policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Sid": "someone-else",
                    "Effect": "Allow",
                    "Principal": {"AWS": ["arn:aws:iam:::user/9999:AKIAOTHER"]},
                    "Action": ["s3:PutObject"],
                    "Resource": [f"arn:aws:s3:::{BUCKET}/dumps/*"],
                }
            ],
        }
        with self.assertRaises(bwp.BackupWorkerPolicyError) as ctx:
            bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)
        self.assertIn("no statement names", str(ctx.exception))


class RefusesNotActionAndNotPrincipalTests(unittest.TestCase):
    """The NotAction defect Hetzner's own bucket-policy engine has already
    shown once (backup_worker_policy.py's own module docstring; see the
    memory note this run's own context carries: "Hetzner stores a
    bucket-policy NotAction and enforces NOTHING"). This module refuses the
    construct outright rather than trying to reason about what it would
    do."""

    def test_a_not_action_statement_is_refused_even_naming_the_right_principal(self) -> None:
        policy = {
            "Statement": [
                {
                    "Sid": "not-action",
                    "Effect": "Allow",
                    "Principal": {"AWS": [PRINCIPAL]},
                    "NotAction": ["s3:DeleteBucket"],
                    "Resource": [f"arn:aws:s3:::{BUCKET}/dumps/*"],
                }
            ]
        }
        with self.assertRaises(bwp.BackupWorkerPolicyError) as ctx:
            bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)
        self.assertIn("NotAction", str(ctx.exception))

    def test_a_not_principal_statement_is_refused(self) -> None:
        policy = {
            "Statement": [
                {
                    "Sid": "not-principal",
                    "Effect": "Allow",
                    "NotPrincipal": {"AWS": ["arn:aws:iam:::user/9999:AKIAOTHER"]},
                    "Action": ["s3:PutObject"],
                    "Resource": [f"arn:aws:s3:::{BUCKET}/dumps/*"],
                }
            ]
        }
        with self.assertRaises(bwp.BackupWorkerPolicyError):
            bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)


class RefusesWildcardAndOverWideActionsTests(unittest.TestCase):
    def test_s3_star_is_refused_even_though_it_covers_put_object(self) -> None:
        policy = {
            "Statement": [
                {
                    "Sid": "too-wide",
                    "Effect": "Allow",
                    "Principal": {"AWS": [PRINCIPAL]},
                    "Action": "s3:*",
                    "Resource": [f"arn:aws:s3:::{BUCKET}/dumps/*"],
                }
            ]
        }
        with self.assertRaises(bwp.BackupWorkerPolicyError) as ctx:
            bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)
        self.assertIn("wildcard", str(ctx.exception))

    def test_an_action_beyond_put_object_is_refused(self) -> None:
        policy = {
            "Statement": [
                {
                    "Sid": "too-much",
                    "Effect": "Allow",
                    "Principal": {"AWS": [PRINCIPAL]},
                    "Action": ["s3:PutObject", "s3:DeleteObject"],
                    "Resource": [f"arn:aws:s3:::{BUCKET}/dumps/*"],
                }
            ]
        }
        with self.assertRaises(bwp.BackupWorkerPolicyError) as ctx:
            bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)
        self.assertIn("DeleteObject", str(ctx.exception))

    def test_a_statement_missing_put_object_entirely_is_refused(self) -> None:
        policy = {
            "Statement": [
                {
                    "Sid": "wrong-action",
                    "Effect": "Allow",
                    "Principal": {"AWS": [PRINCIPAL]},
                    "Action": ["s3:GetObject"],
                    "Resource": [f"arn:aws:s3:::{BUCKET}/dumps/*"],
                }
            ]
        }
        with self.assertRaises(bwp.BackupWorkerPolicyError):
            bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)


class RefusesEffectDenyAndUnscopedResourceTests(unittest.TestCase):
    def test_a_deny_naming_this_principal_is_refused_as_not_an_allow(self) -> None:
        policy = {
            "Statement": [
                {
                    "Sid": "deny",
                    "Effect": "Deny",
                    "Principal": {"AWS": [PRINCIPAL]},
                    "Action": ["s3:PutObject"],
                    "Resource": [f"arn:aws:s3:::{BUCKET}/dumps/*"],
                }
            ]
        }
        with self.assertRaises(bwp.BackupWorkerPolicyError) as ctx:
            bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)
        self.assertIn("Deny", str(ctx.exception))

    def test_a_resource_naming_a_different_bucket_is_refused(self) -> None:
        policy = {
            "Statement": [
                {
                    "Sid": "wrong-bucket",
                    "Effect": "Allow",
                    "Principal": {"AWS": [PRINCIPAL]},
                    "Action": ["s3:PutObject"],
                    "Resource": ["arn:aws:s3:::some-other-bucket/dumps/*"],
                }
            ]
        }
        with self.assertRaises(bwp.BackupWorkerPolicyError) as ctx:
            bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)
        self.assertIn("not scoped under", str(ctx.exception))

    def test_a_bucket_level_resource_with_no_object_prefix_is_refused(self) -> None:
        """`arn:aws:s3:::bucket` (no trailing `/...`) does not start with
        `arn:aws:s3:::bucket/` -- this credential only ever needs an
        object-level grant, never the bucket resource itself."""
        policy = {
            "Statement": [
                {
                    "Sid": "bucket-level",
                    "Effect": "Allow",
                    "Principal": {"AWS": [PRINCIPAL]},
                    "Action": ["s3:PutObject"],
                    "Resource": [f"arn:aws:s3:::{BUCKET}"],
                }
            ]
        }
        with self.assertRaises(bwp.BackupWorkerPolicyError):
            bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=PRINCIPAL)


if __name__ == "__main__":
    unittest.main()
