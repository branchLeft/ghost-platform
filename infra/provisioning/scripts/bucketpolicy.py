#!/usr/bin/env python3
"""The pieces every Hetzner Object Storage bucket policy in this estate shares.

Hetzner has no IAM. Its documented default is that each key pair is valid for
every bucket in the same project, so an S3 `Allow` narrows nothing and a
bucket-policy `Deny` is the only mechanism that fences a bucket at all. Two
generators build one -- `render-media-bucket-policy.py` for a tenant's media
bucket, `render-bucket-fence-policy.py` for an operational bucket -- and they
share this module rather than each carrying a copy of the principal syntax and
the evaluation model. A divergence between the two would be a boundary that is
correct in one generator and not the other, with nothing to reveal which.

Principal syntax is Hetzner's, not AWS's: `arn:aws:iam:::user/p<project>:<key>`
-- three empty colon-separated fields, and a `p` prefix on the project id.

`decide()` is a MODEL of S3 policy evaluation, not Hetzner's implementation.
Hetzner documents `NotPrincipal` verbatim but publishes no list of supported
Actions, Principal formats or Conditions. Nothing computed here is evidence
about a live bucket; only the probes in `verify-bucket-fence.py` are.

`NotAction` is the exception, because it is no longer unknown. This engine does
not implement it: a statement carrying `NotAction` is accepted, stored, and
returned by `get-bucket-policy` byte-identical to what was sent, and enforces
nothing. The model below therefore skips such a statement rather than
evaluating it, and `assert_enforceable()` refuses to emit one at all -- a
policy that cannot be modelled honestly must not be written to a bucket.
"""

from __future__ import annotations

import re

# Refusing anything but the documented charset is the control, not a format
# check: a colon or a quote in either value lands inside an ARN string and
# changes which principal the policy names.
PROJECT_ID_PATTERN = re.compile(r"\A[0-9]{1,20}\Z")
ACCESS_KEY_PATTERN = re.compile(r"\A[A-Za-z0-9]{16,64}\Z")

# Same reasoning applied to the resource half of the ARN. Dots are refused
# although S3 permits them: a dotted bucket name falls outside this endpoint's
# one-label wildcard certificate, so path-style requests to it fail TLS
# verification before any policy is consulted.
BUCKET_NAME_PATTERN = re.compile(r"\A[a-z0-9][a-z0-9-]{1,61}[a-z0-9]\Z")


# What each role must still be able to do once a fence is applied. These are
# the questions `decide()` is asked before a policy is written, by the renderer
# on its way out and by `verify-bucket-fence.py`'s pre-flight on its way in.
#
# Whether a credential is locked out is an EVALUATION question, and only
# `decide()` answers it. A structural scan of `NotPrincipal` lists cannot: a
# fence deliberately contains Deny statements that name only the operator --
# `DenyObjectMutationsExceptOperator` withholds the version-destroying actions
# from the workload on purpose -- so "this Deny does not name the workload" is
# what a working fence looks like, not a lockout.
RECOVERY_ACTIONS = ["s3:PutBucketPolicy", "s3:DeleteBucketPolicy"]

# The whole of what a workload key does with its bucket: the two backup
# pipelines write, `prune_backups.py` lists and deletes, a restore reads, and
# Pulumi's S3 backend on the state bucket does the same four. Nothing here
# includes an action the fence withholds by design.
WORKLOAD_BUCKET_ACTIONS = ["s3:ListBucket"]
WORKLOAD_OBJECT_ACTIONS = ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"]


# Every bucket-resource action that reads or rewrites the fence itself, plus
# the version listing, which is a read but enumerates superseded objects.
#
# Enumerated, and that is a REGRESSION accepted rather than a design choice.
# The `NotAction` form these lists replace made an action nobody thought of
# fall closed; a denylist makes it fall open, back to Hetzner's project-wide
# default. The mitigation is breadth, not cleverness: actions Hetzner
# currently documents as unsupported are listed too, because the cost is a
# longer array and the alternative is a hole that opens on the day support
# lands, silently and in every policy already applied.
BUCKET_CONFIGURATION_ACTIONS = [
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
    # Documented by Hetzner as unsupported today. See the note above.
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
]

# Every object-resource action EXCEPT the two that serve a browser. Only the
# media policy needs this split: an operational bucket has no anonymous reader
# to exempt, so its object deny is `Action: s3:*` and needs no enumeration.
# `s3:GetObject` covers `HeadObject`, which is how Ghost's `exists()` probes a
# key, so a tenant excluded from this deny keeps that path.
MEDIA_PUBLIC_OBJECT_ACTIONS = ["s3:GetObject", "s3:GetObjectVersion"]

NON_PUBLIC_OBJECT_ACTIONS = [
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
]


class PolicyInputError(ValueError):
    """A value that would produce a policy naming the wrong thing."""


def key_principal(project_id: str, access_key: str) -> str:
    if not PROJECT_ID_PATTERN.match(project_id):
        raise PolicyInputError(f"project id {project_id!r} must be digits only")
    if not ACCESS_KEY_PATTERN.match(access_key):
        raise PolicyInputError(
            f"access key {access_key!r} must be 16-64 alphanumerics; anything else would "
            f"change which principal the ARN names"
        )
    return f"arn:aws:iam:::user/p{project_id}:{access_key}"


def validate_bucket_name(bucket: str) -> str:
    if not BUCKET_NAME_PATTERN.match(bucket):
        raise PolicyInputError(
            f"bucket name {bucket!r} must be 3-63 lowercase alphanumerics or hyphens, "
            f"starting and ending alphanumeric, with no dots -- anything else either "
            f"changes which resource the ARN names or falls outside the endpoint's "
            f"wildcard certificate"
        )
    return bucket


def matches(pattern, value: str) -> bool:
    values = pattern if isinstance(pattern, list) else [pattern]
    return any(
        p == "*" or p == value or (p.endswith("*") and value.startswith(p[:-1])) for p in values
    )


def decide(policy: dict, principal: str, action: str, resource: str) -> str:
    """Explicit Deny wins; otherwise an Allow, or Hetzner's project default.

    The default is `allow` for any key in the project and `deny` for anonymous,
    because Hetzner grants every key pair read and write on every bucket in its
    own project. Modelling that is the point: without it a reader would
    conclude the Allow statements are what grant a key its access, and would
    then think removing a Deny is safe.
    """
    allowed = False
    for statement in policy["Statement"]:
        if not matches(statement["Resource"], resource):
            continue
        if "NotAction" in statement:
            # Not "evaluate the complement" -- SKIP. This engine does not
            # implement `NotAction`, so a statement carrying it decides
            # nothing, whatever it says. Modelling the complement is what
            # allowed a 21-case decision table to certify a media policy whose
            # object deny was inert on the live bucket. `assert_enforceable()`
            # stops such a policy being written; this stops it being believed.
            continue
        if not matches(statement["Action"], action):
            continue
        if "NotPrincipal" in statement:
            if matches(statement["NotPrincipal"]["AWS"], principal):
                continue
        elif not matches(statement["Principal"]["AWS"], principal):
            continue
        if statement["Effect"] == "Deny":
            return "deny"
        allowed = True
    if allowed:
        return "allow"
    return "allow" if principal.startswith("arn:aws:iam:::user/") else "deny"


def assert_enforceable(policy: dict) -> dict:
    """Refuse a policy whose enforcement this engine will silently decline.

    A `NotAction` statement is accepted by `put-bucket-policy`, stored, and
    returned by `get-bucket-policy` byte-identical to what was sent -- so a
    round-trip comparison, which is the check both runbooks perform, passes on
    a statement that enforces nothing. The failure is visible only to a live
    probe under a credential the statement is supposed to stop, and only in the
    permissive direction, which is the direction nobody looks.

    Called by both generators on the way out, so the shape cannot reach a
    bucket regardless of which one wrote it.
    """
    for statement in policy["Statement"]:
        if "NotAction" in statement:
            raise PolicyInputError(
                f"statement {statement.get('Sid', '<unnamed>')!r} uses NotAction, which this "
                f"engine stores and does not enforce. Express it as an explicit Action list -- "
                f"and widen that list past what is needed today, because the catch-all property "
                f"NotAction was chosen for does not survive the change."
            )
    return policy
