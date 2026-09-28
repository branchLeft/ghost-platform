#!/usr/bin/env python3
"""Unit tests for backup_worker_policy.py: it must accept the fence and refuse an allow-only grant."""

from __future__ import annotations

import copy
import unittest

import backup_worker_policy as bwp
import bucketpolicy

PROJECT = "1231234"
BUCKET = "branchleft-backups"
WORKER = "P" * 20
DRILL = "R" * 20
ADMIN = "O" * 20
WORKER_ARN = bucketpolicy.key_principal(PROJECT, WORKER)


def fence() -> dict:
    return bwp.render_backup_worker_put_policy(
        bucket=BUCKET, project_id=PROJECT, worker_access_key=WORKER,
        admin_access_key=ADMIN, drill_access_keys=(DRILL,),
    )


def allow_only() -> dict:
    return {
        "Version": "2012-10-17",
        "Statement": [{
            "Sid": "backup-worker-put-only",
            "Effect": "Allow",
            "Principal": {"AWS": [WORKER_ARN]},
            "Action": ["s3:PutObject"],
            "Resource": [f"arn:aws:s3:::{BUCKET}/dumps/*"],
        }],
    }


def check(policy: dict) -> None:
    bwp.assert_explicit_allow_put_only(policy, bucket=BUCKET, worker_principal=WORKER_ARN)


class TestTheFenceIsAccepted(unittest.TestCase):
    def test_the_rendered_fence_passes(self):
        check(fence())

    def test_it_passes_without_a_drill_key(self):
        check(bwp.render_backup_worker_put_policy(
            bucket=BUCKET, project_id=PROJECT, worker_access_key=WORKER, admin_access_key=ADMIN))

    def test_it_is_the_fence_renderer_output(self):
        policy = fence()
        self.assertIn("AllowPutOnlyKeysPut", [s["Sid"] for s in policy["Statement"]])
        self.assertIn("DenyPutOnlyKeysReadsAndRemovals", [s["Sid"] for s in policy["Statement"]])

    def test_the_allowed_actions_are_the_role_table(self):
        self.assertEqual(bwp.ALLOWED_ACTIONS, ("s3:PutObject",))


class TestAnAllowOnlyGrantIsRefused(unittest.TestCase):
    def test_an_allow_only_document_fences_nothing_and_is_refused(self):
        with self.assertRaises(bwp.BackupWorkerPolicyError) as caught:
            check(allow_only())
        self.assertIn("project default", str(caught.exception))

    def test_the_fence_without_its_worker_deny_is_refused(self):
        policy = fence()
        policy["Statement"] = [
            s for s in policy["Statement"] if s["Sid"] != "DenyPutOnlyKeysReadsAndRemovals"
        ]
        with self.assertRaises(bwp.BackupWorkerPolicyError):
            check(policy)

    def test_the_fence_without_its_listing_deny_and_catch_all_is_refused(self):
        policy = fence()
        policy["Statement"] = [
            s for s in policy["Statement"]
            if s["Sid"] not in ("DenyPutOnlyKeysListing", "DenyBucketAccessExceptNamedKeys")
        ]
        with self.assertRaises(bwp.BackupWorkerPolicyError) as caught:
            check(policy)
        self.assertIn("s3:List", str(caught.exception))


class TestTheGrantMustBeExact(unittest.TestCase):
    def test_no_statement_is_refused(self):
        for policy in ({}, {"Statement": []}):
            with self.assertRaises(bwp.BackupWorkerPolicyError):
                check(policy)

    def test_no_allow_naming_the_worker_is_refused(self):
        policy = fence()
        policy["Statement"] = [s for s in policy["Statement"] if s["Sid"] != "AllowPutOnlyKeysPut"]
        with self.assertRaises(bwp.BackupWorkerPolicyError) as caught:
            check(policy)
        self.assertIn("no Allow", str(caught.exception))

    def test_a_wildcard_or_a_wider_grant_is_refused(self):
        for actions in (["s3:*"], "s3:*", ["s3:PutObject", "s3:GetObject"], ["s3:GetObject"]):
            policy = fence()
            for s in policy["Statement"]:
                if s["Sid"] == "AllowPutOnlyKeysPut":
                    s["Action"] = actions
            with self.subTest(actions=actions), self.assertRaises(bwp.BackupWorkerPolicyError):
                check(policy)

    def test_a_resource_outside_the_bucket_is_refused(self):
        for resource in ("arn:aws:s3:::other-bucket/*", f"arn:aws:s3:::{BUCKET}", None):
            policy = fence()
            for s in policy["Statement"]:
                if s["Sid"] == "AllowPutOnlyKeysPut":
                    s["Resource"] = resource
            with self.subTest(resource=resource), self.assertRaises(bwp.BackupWorkerPolicyError):
                check(policy)

    def test_notaction_is_refused(self):
        policy = copy.deepcopy(fence())
        policy["Statement"].append({
            "Sid": "Inert", "Effect": "Deny", "Principal": {"AWS": [WORKER_ARN]},
            "NotAction": ["s3:PutObject"], "Resource": f"arn:aws:s3:::{BUCKET}/*",
        })
        with self.assertRaises(bwp.BackupWorkerPolicyError) as caught:
            check(policy)
        self.assertIn("NotAction", str(caught.exception))


class TestRenderRefusals(unittest.TestCase):
    def test_bad_input_is_a_worker_policy_error(self):
        for kwargs in ({"worker_access_key": "short"}, {"worker_access_key": ADMIN},
                       {"bucket": "Bad.Bucket"}):
            args = {"bucket": BUCKET, "project_id": PROJECT, "worker_access_key": WORKER,
                    "admin_access_key": ADMIN, **kwargs}
            with self.subTest(kwargs=kwargs), self.assertRaises(bwp.BackupWorkerPolicyError):
                bwp.render_backup_worker_put_policy(**args)


if __name__ == "__main__":
    unittest.main()
