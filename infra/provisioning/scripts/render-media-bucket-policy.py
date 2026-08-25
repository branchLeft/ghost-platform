#!/usr/bin/env python3
"""Render one tenant's media bucket policy, and the commands that apply it.

Each tenant's media lives in its own Object Storage bucket, reached with a
credential allowlisted to that bucket alone. Hetzner has no IAM: the only
scoping mechanism it documents is a *bucket policy* naming access keys as
principals, so this file is the whole of the media isolation boundary. It is
rendered rather than hand-written because three of its four statements are
easy to write in a way that looks right and is not.

WHAT THE POLICY HAS TO ACHIEVE, AND WHY EACH PIECE IS SHAPED AS IT IS.

  1. Public-read but NOT listable. Readers fetch media by URL; nobody may
     enumerate the bucket, because the object names are a tenant's unpublished
     and published filenames and the bucket name is the tenant's own slug.
     Served by an Allow of `s3:GetObject` on the OBJECT path only, never by the
     `public-read` canned bucket ACL -- a bucket ACL of `public-read` grants
     READ on the bucket, which in S3 semantics is LIST.

  2. Credential isolation. Hetzner's default is the opposite of what is
     wanted: "each key pair is automatically valid for every Bucket within the
     same project". An Allow therefore restricts nothing; only an explicit
     Deny does. Hence the two `NotPrincipal` denials below, which is the exact
     shape Hetzner's own documentation gives for restricting a bucket to named
     keys.

  3. Append-only media. `s3:DeleteObject` is deliberately not available to the
     tenant's own key, which is why deletion from Ghost admin returns a 403.
     That is a decision, not a gap.

  4. The bucket must stay administrable. A `NotPrincipal` deny over `s3:*` on
     the bucket resource also denies `PutBucketPolicy` -- so a policy that
     names only the tenant's key locks the bucket permanently, including
     against the account that owns it. The operator's own key is therefore in
     every `NotPrincipal` list here. Hetzner also warns that the Console stops
     being able to list a restricted bucket at all, which is worth knowing
     before an incident rather than during one.

THE ONE PROPERTY THIS FILE CANNOT ESTABLISH. Hetzner documents `NotPrincipal`
verbatim but publishes no list of supported policy Actions, Principal formats
or Conditions, and says nothing about `NotAction`, which the object-level deny
below relies on to leave anonymous reads intact. That is why
RUNBOOK-tenant-onboarding.md verifies the four decisions against the live
bucket before the credential is handed over, rather than treating a successful
`put-bucket-policy` as proof.

Principal syntax is Hetzner's, not AWS's: `arn:aws:iam:::user/p<project>:<key>`
-- three empty colon-separated fields, and a `p` prefix on the project id.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

# Mirrors `MEDIA_BUCKET_PREFIX` in infra/tenant/media.ts. The two derivations
# have to agree: this one runs first, because the bucket must exist before a
# tenant stack does, and the component's is what the container is configured
# with. Tests on both sides assert the same literals.
MEDIA_BUCKET_PREFIX = "branchleft-media-"

# Mirrors `TENANT_SLUG_PATTERN` in infra/tenant/naming.ts, tightened at the
# tail: the slug is the end of a bucket name and S3 requires a bucket name to
# end in a letter or a digit.
SLUG_PATTERN = re.compile(r"\A[a-z][a-z0-9-]*[a-z0-9]\Z|\A[a-z]\Z")

# Refusing anything but alphanumerics is the control, not the format check: a
# colon or a quote in either value lands inside an ARN string and changes which
# principal the policy names.
PROJECT_ID_PATTERN = re.compile(r"\A[0-9]{1,20}\Z")
ACCESS_KEY_PATTERN = re.compile(r"\A[A-Za-z0-9]{16,64}\Z")

# Ghost needs these two to serve media from a versioned bucket: Hetzner's own
# note is that allowing `s3:GetObject` on a bucket with versioning enabled
# requires allowing `s3:GetObjectVersion` alongside it. Anonymous callers still
# cannot enumerate versions, because `ListBucketVersions` is an action on the
# BUCKET resource and the bucket resource is denied to them outright.
PUBLIC_READ_ACTIONS = ["s3:GetObject", "s3:GetObjectVersion"]

# Withheld from the tenant's own key. Lifecycle expiry is performed by the
# storage service rather than by an API caller, so a retention rule still
# works.
DELETE_ACTIONS = ["s3:DeleteObject", "s3:DeleteObjectVersion"]


class PolicyInputError(ValueError):
    """A value that would produce a policy naming the wrong thing."""


def media_bucket_name(slug: str) -> str:
    if not SLUG_PATTERN.match(slug):
        raise PolicyInputError(
            f"tenant slug {slug!r} must be lowercase alphanumeric-hyphen, start with a "
            f"letter and end with a letter or a digit -- it is the tail of the bucket name"
        )
    if len(slug) > 26:
        raise PolicyInputError(
            f"tenant slug {slug!r} is {len(slug)} characters; the platform caps it at 26"
        )
    return f"{MEDIA_BUCKET_PREFIX}{slug}"


def key_principal(project_id: str, access_key: str) -> str:
    if not PROJECT_ID_PATTERN.match(project_id):
        raise PolicyInputError(f"project id {project_id!r} must be digits only")
    if not ACCESS_KEY_PATTERN.match(access_key):
        raise PolicyInputError(
            f"access key {access_key!r} must be 16-64 alphanumerics; anything else would "
            f"change which principal the ARN names"
        )
    return f"arn:aws:iam:::user/p{project_id}:{access_key}"


def render_policy(
    slug: str, project_id: str, tenant_access_key: str, admin_access_key: str
) -> dict:
    """The whole media isolation boundary for one tenant, as one policy."""
    bucket = media_bucket_name(slug)
    tenant = key_principal(project_id, tenant_access_key)
    admin = key_principal(project_id, admin_access_key)
    if tenant == admin:
        raise PolicyInputError(
            "the tenant key and the operator key are the same credential. The tenant key "
            "would then keep the ability to delete its own media and to rewrite this "
            "policy, which is the whole of what these statements withhold."
        )

    # `arn:aws:s3:::<bucket>` and `arn:aws:s3:::<bucket>/*` are two different
    # resources and the distinction carries the public-read-but-not-listable
    # property: object actions match the second, bucket actions the first.
    # Neither is ever written with a trailing `*` directly on the bucket name --
    # `arn:aws:s3:::branchleft-media-blog*` would also match every object in
    # `branchleft-media-blog-archive`.
    bucket_arn = f"arn:aws:s3:::{bucket}"
    objects_arn = f"arn:aws:s3:::{bucket}/*"

    return {
        "Version": "2012-10-17",
        "Id": f"branchleft-media-{slug}",
        "Statement": [
            {
                "Sid": "PublicReadObjectsOnly",
                "Effect": "Allow",
                "Principal": {"AWS": "*"},
                "Action": PUBLIC_READ_ACTIONS,
                "Resource": objects_arn,
            },
            {
                # Everything addressed at the bucket itself -- ListBucket,
                # ListBucketVersions, the policy and lifecycle sub-resources --
                # is denied to everyone but the two named keys. This is what
                # makes the bucket unlistable rather than merely un-granted.
                "Sid": "DenyBucketLevelAccessExceptNamedKeys",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [tenant, admin]},
                "Action": "s3:*",
                "Resource": bucket_arn,
            },
            {
                # Object actions other than the public read. `NotAction` rather
                # than a list of denied actions: a list is a denylist, and an
                # action nobody thought of would fall through it and be allowed
                # by Hetzner's default project-wide key permission.
                "Sid": "DenyObjectAccessExceptPublicReadAndNamedKeys",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [tenant, admin]},
                "NotAction": PUBLIC_READ_ACTIONS,
                "Resource": objects_arn,
            },
            {
                # The append-only decision. The operator keeps deletion, for
                # teardown and for removing something that should never have
                # been uploaded; the tenant's own credential does not, which is
                # what Ghost admin's 403 on media deletion is.
                "Sid": "DenyDeletionExceptOperator",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [admin]},
                "Action": DELETE_ACTIONS,
                "Resource": objects_arn,
            },
        ],
    }


def render_commands(
    slug: str,
    project_id: str,
    tenant_access_key: str,
    admin_access_key: str,
    endpoint: str,
    region: str,
) -> str:
    """The operator sequence, with every value filled in."""
    bucket = media_bucket_name(slug)
    policy = json.dumps(
        render_policy(slug, project_id, tenant_access_key, admin_access_key), indent=2
    )
    return f"""\
# Run as the operator, with the OPERATOR key in the environment -- never the
# tenant's. Every command below is idempotent except the credential, which is
# created in the Hetzner Console and shown once.
export AWS_ACCESS_KEY_ID='<the operator access key id>'
export AWS_SECRET_ACCESS_KEY='<the operator secret access key>'
export AWS_DEFAULT_REGION='{region}'
S3='aws --endpoint-url {endpoint} s3api'

# 1. The bucket. `--acl private` is stated rather than left to the default:
#    `public-read` is a BUCKET acl and grants LIST, which would publish this
#    tenant's object names and, through the bucket name, the tenant roster.
$S3 create-bucket --bucket {bucket} --acl private \\
  --create-bucket-configuration LocationConstraint={region}

# 2. Versioning, so an overwrite is recoverable and the lifecycle rule in
#    doc 14 section 8 has something to expire.
$S3 put-bucket-versioning --bucket {bucket} \\
  --versioning-configuration Status=Enabled

# 3. The policy. Until this lands the bucket is reachable by EVERY key in the
#    project, because Hetzner's default is project-wide key access -- so do not
#    leave step 3 for later, and do not hand the tenant its key before it.
cat > /tmp/{bucket}-policy.json <<'POLICY'
{policy}
POLICY
$S3 put-bucket-policy --bucket {bucket} --policy file:///tmp/{bucket}-policy.json
rm /tmp/{bucket}-policy.json

# 4. Read it back. A put that was accepted and stored something different is
#    the failure worth catching here.
$S3 get-bucket-policy --bucket {bucket} --output text
"""


def _self_test() -> None:
    """Prove the decisions this policy exists to make, not just its shape.

    `_decide` is a model of S3 policy evaluation -- explicit Deny beats Allow
    beats the platform default -- written here so the four properties can be
    stated as a decision table rather than as assertions about JSON. It is a
    model: what Hetzner's implementation actually does is verified against a
    live bucket in RUNBOOK-tenant-onboarding.md, and nothing here substitutes
    for that.
    """
    policy = render_policy("blog", "1231234", "A" * 20, "B" * 20)
    tenant = key_principal("1231234", "A" * 20)
    admin = key_principal("1231234", "B" * 20)
    other = key_principal("1231234", "C" * 20)
    bucket = "arn:aws:s3:::branchleft-media-blog"

    cases = [
        # (principal, action, resource, expected)
        ("*", "s3:GetObject", f"{bucket}/content/images/x.png", "allow"),
        ("*", "s3:ListBucket", bucket, "deny"),
        ("*", "s3:ListBucketVersions", bucket, "deny"),
        ("*", "s3:PutObject", f"{bucket}/x.png", "deny"),
        ("*", "s3:GetBucketPolicy", bucket, "deny"),
        (tenant, "s3:PutObject", f"{bucket}/x.png", "allow"),
        (tenant, "s3:ListBucket", bucket, "allow"),
        (tenant, "s3:DeleteObject", f"{bucket}/x.png", "deny"),
        (tenant, "s3:DeleteObjectVersion", f"{bucket}/x.png", "deny"),
        (tenant, "s3:PutBucketPolicy", bucket, "allow"),
        (other, "s3:ListBucket", bucket, "deny"),
        (other, "s3:PutObject", f"{bucket}/x.png", "deny"),
        (other, "s3:DeleteObject", f"{bucket}/x.png", "deny"),
        (admin, "s3:DeleteObject", f"{bucket}/x.png", "allow"),
        (admin, "s3:PutBucketPolicy", bucket, "allow"),
    ]
    for principal, action, resource, expected in cases:
        got = _decide(policy, principal, action, resource)
        if got != expected:
            raise AssertionError(
                f"policy self-test: {principal} {action} on {resource} -> {got}, expected {expected}"
            )

    for bad in ["blog-", "Blog", "blog/../other", "1blog", ""]:
        try:
            media_bucket_name(bad)
        except PolicyInputError:
            continue
        raise AssertionError(f"policy self-test: slug {bad!r} was accepted")

    for bad_key in ["short", "has:colon0000000", 'has"quote00000000']:
        try:
            key_principal("1231234", bad_key)
        except PolicyInputError:
            continue
        raise AssertionError(f"policy self-test: access key {bad_key!r} was accepted")

    print("render-media-bucket-policy self-test: ok", file=sys.stderr)


def _matches(pattern, value: str) -> bool:
    values = pattern if isinstance(pattern, list) else [pattern]
    return any(p == "*" or p == value or (p.endswith("*") and value.startswith(p[:-1])) for p in values)


def _decide(policy: dict, principal: str, action: str, resource: str) -> str:
    """Explicit Deny wins; otherwise an Allow, or Hetzner's project default.

    The default is `allow` for any key in the project and `deny` for anonymous,
    because Hetzner grants every key pair read and write on every bucket in its
    own project. Modelling that is the point: without it a reader would
    conclude the Allow statements are what grant the tenant its access, and
    would then think removing a Deny is safe.
    """
    allowed = False
    for statement in policy["Statement"]:
        if not _matches(statement["Resource"], resource):
            continue
        if "NotAction" in statement:
            if _matches(statement["NotAction"], action):
                continue
        elif not _matches(statement["Action"], action):
            continue
        if "NotPrincipal" in statement:
            if _matches(statement["NotPrincipal"]["AWS"], principal):
                continue
        elif not _matches(statement["Principal"]["AWS"], principal):
            continue
        if statement["Effect"] == "Deny":
            return "deny"
        allowed = True
    if allowed:
        return "allow"
    return "allow" if principal.startswith("arn:aws:iam:::user/") else "deny"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--slug", help="the tenant's slug")
    parser.add_argument("--project-id", help="Hetzner project id holding the credentials")
    parser.add_argument("--tenant-access-key", help="this tenant's Object Storage access key id")
    parser.add_argument("--admin-access-key", help="the operator's Object Storage access key id")
    parser.add_argument(
        "--endpoint",
        default="https://hel1.your-objectstorage.com",
        help="platform-wide Object Storage endpoint",
    )
    parser.add_argument("--region", default="hel1", help="platform-wide Object Storage location")
    parser.add_argument(
        "--commands",
        action="store_true",
        help="print the operator command sequence instead of the bare policy",
    )
    parser.add_argument("--self-test", action="store_true", help="prove the decision table")
    args = parser.parse_args(argv)

    if args.self_test:
        _self_test()
        return 0

    missing = [
        name
        for name in ("slug", "project_id", "tenant_access_key", "admin_access_key")
        if not getattr(args, name)
    ]
    if missing:
        parser.error("missing required arguments: " + ", ".join("--" + m.replace("_", "-") for m in missing))

    try:
        if args.commands:
            print(
                render_commands(
                    args.slug,
                    args.project_id,
                    args.tenant_access_key,
                    args.admin_access_key,
                    args.endpoint,
                    args.region,
                ),
                end="",
            )
        else:
            print(
                json.dumps(
                    render_policy(
                        args.slug,
                        args.project_id,
                        args.tenant_access_key,
                        args.admin_access_key,
                    ),
                    indent=2,
                )
            )
    except PolicyInputError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
