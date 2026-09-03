#!/usr/bin/env python3
"""The shared evaluation model, tested where both generators can rely on it.

`decide()` is the reason a wrong policy can pass a decision table: it is what
every self-test and every `assert_recoverable()` call reasons with. When it
modelled `NotAction` as working, a 21-case table certified a media policy whose
object deny was inert on the live bucket. The model's fidelity to THIS engine
is therefore a property worth testing directly, not only through the two
generators that happen to use it.
"""

from __future__ import annotations

import unittest

import bucketpolicy
from bucketpolicy import PolicyInputError, assert_enforceable, decide

PROJECT = "1231234"
KEY = "A" * 20
BUCKET = "arn:aws:s3:::branchleft-media-blog"


def principal(key: str = KEY) -> str:
    return bucketpolicy.key_principal(PROJECT, key)


class TestNotActionIsModelledAsInert(unittest.TestCase):
    """Hetzner's engine stores `NotAction` and does not enforce it.

    Established against a real bucket: in one policy, on one read, the
    `Action` denies held and the `NotAction` denies did nothing. The model has
    to agree, or it will keep certifying boundaries that do not exist.
    """

    def _notaction_deny(self) -> dict:
        return {
            "Statement": [
                {
                    "Sid": "DenyEverythingButReads",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [principal("B" * 20)]},
                    "NotAction": ["s3:ListBucket"],
                    "Resource": BUCKET,
                }
            ]
        }

    def test_a_notaction_deny_decides_nothing(self):
        # NOT "the complement is denied" -- the statement is skipped outright,
        # so the answer falls through to Hetzner's project-wide default, which
        # is allow for any key in the project. That default is the whole reason
        # an unenforced Deny is dangerous rather than merely useless.
        self.assertEqual(decide(self._notaction_deny(), principal(), "s3:PutBucketPolicy", BUCKET), "allow")

    def test_a_notaction_deny_does_not_even_deny_its_own_complement(self):
        self.assertEqual(decide(self._notaction_deny(), principal(), "s3:DeleteBucket", BUCKET), "allow")

    def test_an_equivalent_action_deny_is_enforced(self):
        # The control. Same principal, same resource, same effect -- the only
        # difference is the construct, which is exactly the variable the live
        # probes isolated.
        enforced = {
            "Statement": [
                {
                    "Sid": "DenyConfig",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [principal("B" * 20)]},
                    "Action": ["s3:PutBucketPolicy"],
                    "Resource": BUCKET,
                }
            ]
        }
        self.assertEqual(decide(enforced, principal(), "s3:PutBucketPolicy", BUCKET), "deny")

    def test_a_star_action_deny_is_enforced(self):
        # `Action: s3:*` is the construct that lets the catch-all property
        # survive on the bucket resource. If this stops holding, both
        # generators lose their stranger catch-all.
        star = {
            "Statement": [
                {
                    "Sid": "DenyAll",
                    "Effect": "Deny",
                    "NotPrincipal": {"AWS": [principal("B" * 20)]},
                    "Action": "s3:*",
                    "Resource": BUCKET,
                }
            ]
        }
        self.assertEqual(decide(star, principal(), "s3:SomethingNobodyListed", BUCKET), "deny")


class TestAssertEnforceable(unittest.TestCase):
    def test_refuses_a_notaction_statement(self):
        with self.assertRaises(PolicyInputError) as caught:
            assert_enforceable({"Statement": [{"Sid": "X", "NotAction": ["s3:GetObject"]}]})
        self.assertIn("NotAction", str(caught.exception))

    def test_names_the_offending_statement(self):
        # A policy has five statements and the message is read by someone who
        # did not write it.
        with self.assertRaises(PolicyInputError) as caught:
            assert_enforceable(
                {
                    "Statement": [
                        {"Sid": "Fine", "Action": ["s3:GetObject"]},
                        {"Sid": "DenyObjectAccessExceptPublicReadAndNamedKeys", "NotAction": []},
                    ]
                }
            )
        self.assertIn("DenyObjectAccessExceptPublicReadAndNamedKeys", str(caught.exception))

    def test_an_empty_notaction_is_refused_too(self):
        # `NotAction: []` has a plausible reading under which the statement
        # denies everything, and another under which it denies nothing. Neither
        # matters on an engine that ignores the keyword, but a future reader
        # must not be able to argue the empty case is safe.
        with self.assertRaises(PolicyInputError):
            assert_enforceable({"Statement": [{"Sid": "X", "NotAction": []}]})

    def test_returns_a_clean_policy_unchanged(self):
        clean = {"Statement": [{"Sid": "X", "Effect": "Deny", "Action": ["s3:PutObject"]}]}
        self.assertIs(assert_enforceable(clean), clean)


class TestTheEnumeratedListsCoverWhatTheyMustCover(unittest.TestCase):
    """Breadth is the entire mitigation for the lost catch-all, so it is the
    thing worth asserting -- not the presence of a keyword."""

    def test_the_public_reads_are_absent_from_the_object_denylist(self):
        # Their presence would 404 every image on every tenant blog.
        for action in bucketpolicy.MEDIA_PUBLIC_OBJECT_ACTIONS:
            self.assertNotIn(action, bucketpolicy.NON_PUBLIC_OBJECT_ACTIONS)

    def test_the_object_denylist_covers_every_way_to_write_or_publish(self):
        for action in (
            "s3:PutObject",
            "s3:DeleteObject",
            "s3:DeleteObjectVersion",
            "s3:PutObjectAcl",
            "s3:PutObjectVersionAcl",
            "s3:AbortMultipartUpload",
            "s3:BypassGovernanceRetention",
            "s3:RestoreObject",
        ):
            self.assertIn(action, bucketpolicy.NON_PUBLIC_OBJECT_ACTIONS)

    def test_the_configuration_denylist_covers_every_way_to_unfence_a_bucket(self):
        # Each of these replaces, relaxes or empties the fence without ever
        # calling the next one along.
        for action in (
            "s3:PutBucketPolicy",
            "s3:DeleteBucketPolicy",
            "s3:PutBucketAcl",
            "s3:PutLifecycleConfiguration",
            "s3:PutBucketVersioning",
            "s3:DeleteBucket",
            "s3:PutBucketPublicAccessBlock",
        ):
            self.assertIn(action, bucketpolicy.BUCKET_CONFIGURATION_ACTIONS)

    def test_reading_the_fence_is_denied_not_just_writing_it(self):
        # `GetBucketPolicy` tells a compromised key which other keys are
        # named, so reading the fence is withheld as well as writing it.
        self.assertIn("s3:GetBucketPolicy", bucketpolicy.BUCKET_CONFIGURATION_ACTIONS)

    def test_the_object_denylist_is_pinned_member_by_member(self):
        # A DUPLICATE of the constant, deliberately. Normally two copies of a
        # rule are a defect -- but the mitigation for losing the `NotAction`
        # catch-all is the BREADTH of this list, and a subset assertion cannot
        # defend breadth: removing an unnamed member leaves every other test
        # green. Pinning the whole set forces a removal to be an explicit edit
        # here, where a reviewer sees the action being given away.
        self.assertEqual(
            set(bucketpolicy.NON_PUBLIC_OBJECT_ACTIONS),
            {
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:DeleteObjectVersion",
                "s3:GetObjectAcl",
                "s3:PutObjectAcl",
                "s3:GetObjectVersionAcl",
                "s3:PutObjectVersionAcl",
                "s3:GetObjectTagging",
                "s3:PutObjectTagging",
                "s3:DeleteObjectTagging",
                "s3:GetObjectVersionTagging",
                "s3:PutObjectVersionTagging",
                "s3:DeleteObjectVersionTagging",
                "s3:GetObjectRetention",
                "s3:PutObjectRetention",
                "s3:GetObjectLegalHold",
                "s3:PutObjectLegalHold",
                "s3:BypassGovernanceRetention",
                "s3:AbortMultipartUpload",
                "s3:ListMultipartUploadParts",
                "s3:RestoreObject",
                "s3:GetObjectAttributes",
                "s3:GetObjectVersionAttributes",
                "s3:GetObjectTorrent",
                "s3:GetObjectVersionTorrent",
                "s3:ReplicateObject",
                "s3:ReplicateDelete",
                "s3:ReplicateTags",
                "s3:GetObjectVersionForReplication",
                "s3:ObjectOwnerOverrideToBucketOwner",
            },
        )

    def test_the_configuration_denylist_is_pinned_member_by_member(self):
        # Same reasoning. The "documented as unsupported today, listed anyway"
        # half is the part most likely to be trimmed as dead weight, and it is
        # exactly the half that opens a hole on the day support ships.
        self.assertEqual(
            set(bucketpolicy.BUCKET_CONFIGURATION_ACTIONS),
            {
                "s3:GetBucketPolicy",
                "s3:PutBucketPolicy",
                "s3:DeleteBucketPolicy",
                "s3:GetBucketPolicyStatus",
                "s3:GetBucketAcl",
                "s3:PutBucketAcl",
                "s3:GetBucketPublicAccessBlock",
                "s3:PutBucketPublicAccessBlock",
                "s3:DeleteBucketPublicAccessBlock",
                "s3:GetLifecycleConfiguration",
                "s3:PutLifecycleConfiguration",
                "s3:GetBucketVersioning",
                "s3:PutBucketVersioning",
                "s3:GetBucketObjectLockConfiguration",
                "s3:PutBucketObjectLockConfiguration",
                "s3:GetBucketCORS",
                "s3:PutBucketCORS",
                "s3:GetEncryptionConfiguration",
                "s3:PutEncryptionConfiguration",
                "s3:CreateBucket",
                "s3:DeleteBucket",
                "s3:ListBucketVersions",
                "s3:GetBucketNotification",
                "s3:PutBucketNotification",
                "s3:GetReplicationConfiguration",
                "s3:PutReplicationConfiguration",
                "s3:DeleteReplicationConfiguration",
                "s3:GetBucketLogging",
                "s3:PutBucketLogging",
                "s3:GetBucketTagging",
                "s3:PutBucketTagging",
                "s3:DeleteBucketTagging",
                "s3:GetBucketWebsite",
                "s3:PutBucketWebsite",
                "s3:DeleteBucketWebsite",
                "s3:GetAccelerateConfiguration",
                "s3:PutAccelerateConfiguration",
                "s3:GetBucketRequestPayment",
                "s3:PutBucketRequestPayment",
                "s3:GetBucketOwnershipControls",
                "s3:PutBucketOwnershipControls",
                "s3:DeleteBucketOwnershipControls",
                "s3:GetAnalyticsConfiguration",
                "s3:PutAnalyticsConfiguration",
                "s3:GetInventoryConfiguration",
                "s3:PutInventoryConfiguration",
                "s3:GetMetricsConfiguration",
                "s3:PutMetricsConfiguration",
                "s3:GetIntelligentTieringConfiguration",
                "s3:PutIntelligentTieringConfiguration",
            },
        )

    def test_no_action_is_listed_twice(self):
        for name in ("BUCKET_CONFIGURATION_ACTIONS", "NON_PUBLIC_OBJECT_ACTIONS"):
            actions = getattr(bucketpolicy, name)
            self.assertEqual(len(actions), len(set(actions)), name)


if __name__ == "__main__":
    unittest.main()
