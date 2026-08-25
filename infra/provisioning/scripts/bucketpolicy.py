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
Actions, Principal formats or Conditions, and says nothing about `NotAction`,
which both generators rely on. Nothing computed here is evidence about a live
bucket; only the probes in `verify-bucket-fence.py` are.
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
            if matches(statement["NotAction"], action):
                continue
        elif not matches(statement["Action"], action):
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
