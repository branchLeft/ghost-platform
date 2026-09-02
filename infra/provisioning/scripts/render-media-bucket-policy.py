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
     That is a decision, not a gap -- and it is worth nothing unless the tenant
     is also kept away from the bucket's *configuration*. A lifecycle rule
     expiring every object destroys media without ever calling `DeleteObject`;
     `PutBucketAcl` re-opens listing without touching this policy; and
     `PutBucketPolicy` replaces the whole fence. The tenant's key therefore gets
     no bucket-resource action beyond three harmless reads.

  4. The bucket must stay administrable. A `NotPrincipal` deny covering
     `PutBucketPolicy` locks the bucket permanently if it does not exempt the
     account that owns it, because the statement that would have to be edited
     is the statement doing the denying. The operator's own key is therefore in
     every `NotPrincipal` list here. Hetzner also warns that the Console stops
     being able to list a restricted bucket at all, which is worth knowing
     before an incident rather than during one.

WHY BOTH BLANKET DENIES ARE ENUMERATED RATHER THAN `NotAction`. They were
`NotAction` until it was established that this engine stores that keyword and
enforces nothing: with it in place, any key in the project can write an object
into a tenant's media bucket, and the tenant's own key can read and rewrite the
policy that constrains it. Enumerating loses the property `NotAction` was
chosen for, that an action nobody thought of falls closed. That loss is real on
the object resource and is bought back only by keeping the lists in
`bucketpolicy.py` wider than today's need. On the bucket resource it is not
lost: `Action: s3:*` is enforced, and nothing anonymous needs exempting
there.

THE PROPERTY THIS FILE STILL CANNOT ESTABLISH. Hetzner publishes no list of
supported policy Actions, Principal formats or Conditions. Every action named
here is believed enforced because a construct of the same shape was observed
working, not because the vendor documents it. That is why
RUNBOOK-tenant-onboarding.md verifies the decisions against the live bucket
before the credential is handed over, rather than treating a successful
`put-bucket-policy` as proof -- a round trip compares what was stored, and
this engine stores what it will not enforce.

The principal syntax, the input charset rules and the evaluation model are in
`bucketpolicy.py`, shared with the operational-bucket generator.
"""

from __future__ import annotations

import argparse
import json
import re
import sys

from bucketpolicy import (
    BUCKET_CONFIGURATION_ACTIONS,
    MEDIA_PUBLIC_OBJECT_ACTIONS,
    NON_PUBLIC_OBJECT_ACTIONS,
    PolicyInputError,
    assert_enforceable,
    decide,
    key_principal,
)

# Mirrors `MEDIA_BUCKET_PREFIX` in infra/tenant/media.ts. The two derivations
# have to agree: this one runs first, because the bucket must exist before a
# tenant stack does, and the component's is what the container is configured
# with. Tests on both sides assert the same literals.
MEDIA_BUCKET_PREFIX = "branchleft-media-"

# Mirrors `TENANT_SLUG_PATTERN` in infra/tenant/naming.ts, tightened at the
# tail: the slug is the end of a bucket name and S3 requires a bucket name to
# end in a letter or a digit.
SLUG_PATTERN = re.compile(r"\A[a-z][a-z0-9-]*[a-z0-9]\Z|\A[a-z]\Z")

# Mirrors `RESERVED_STACK_NAMES` in infra/tenant/naming.ts. Refused here as well
# as there because this script is the FIRST thing an operator runs for a new
# tenant -- earlier than the component, earlier than provision-tenant.yml -- and
# it prints commands that create a real bucket. A slug the rest of the platform
# will later refuse must not get a bucket made for it first.
RESERVED_SLUGS = frozenset({"website", "edge", "db", "monitoring"})

# Ghost needs these two to serve media from a versioned bucket: Hetzner's own
# note is that allowing `s3:GetObject` on a bucket with versioning enabled
# requires allowing `s3:GetObjectVersion` alongside it. Anonymous callers still
# cannot enumerate versions, because `ListBucketVersions` is an action on the
# BUCKET resource and the bucket resource is denied to them outright.
PUBLIC_READ_ACTIONS = MEDIA_PUBLIC_OBJECT_ACTIONS

# The only bucket-resource actions the tenant's key keeps. None of them mutates
# anything. None is known to be needed by Ghost either -- `exists()` sends
# `HeadObjectCommand`, an object action, and `S3Storage.ts` issues no
# `ListBucket` anywhere -- so they are retained as AWS-SDK headroom (region
# resolution, multipart enumeration) rather than as a Ghost requirement, and
# they are the first thing to shrink if that headroom proves unnecessary.
TENANT_BUCKET_READ_ACTIONS = [
    "s3:ListBucket",
    "s3:ListBucketMultipartUploads",
    "s3:GetBucketLocation",
]

# Withheld from the tenant's own key. Lifecycle expiry is performed by the
# storage service rather than by an API caller, so a retention rule still
# works.
DELETE_ACTIONS = ["s3:DeleteObject", "s3:DeleteObjectVersion"]


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
    if slug in RESERVED_SLUGS:
        raise PolicyInputError(
            f"tenant slug {slug!r} is reserved -- an app host already runs a Compose stack of "
            f"that name, and the tenant component refuses it. Refused here too, because this "
            f"script runs first and its commands create a real bucket."
        )
    return f"{MEDIA_BUCKET_PREFIX}{slug}"


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

    return assert_enforceable({
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
                # Every bucket-resource action except the three harmless reads,
                # denied to everyone but the OPERATOR -- the tenant included.
                #
                # The tenant's exclusion is the point, and the first draft of
                # this file got it wrong by putting the tenant in this
                # `NotPrincipal` list. Hetzner's project-wide default then
                # applied, so the key sitting in `/etc/branchleft/<slug>.env`
                # inside the tenant's own container could call
                # `PutBucketPolicy` and replace these statements,
                # `PutBucketAcl` and publish the object listing, or
                # `PutLifecycleConfiguration` and expire every object without
                # ever calling `DeleteObject`. "The bucket is the boundary" is
                # only true while the boundary is not writable from inside it.
                #
                # An enumerated `Action` list, NOT the `NotAction` catch-all
                # this statement used to carry. That form is stored and
                # returned verbatim by this engine and enforces nothing: the
                # tenant key read this policy and changed versioning on its own
                # bucket while the statement was in place. `NotAction` costs
                # the property that an unlisted sub-resource falls closed, so
                # `BUCKET_CONFIGURATION_ACTIONS` is deliberately wider than
                # what Hetzner supports today.
                "Sid": "DenyBucketConfigurationExceptOperator",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [admin]},
                "Action": BUCKET_CONFIGURATION_ACTIONS,
                "Resource": bucket_arn,
            },
            {
                # EVERY bucket action, denied to everyone but the tenant and
                # the operator -- not the three reads the statement above
                # exempts. `Action: s3:*` is a construct this engine is
                # observed to enforce, so the catch-all property that
                # `NotAction` was supposed to provide survives here: a bucket
                # sub-resource nobody thought of still falls closed against a
                # stranger. It is affordable on the bucket resource precisely
                # because nothing anonymous has any business there, which is
                # not true one resource down.
                #
                # This also makes the bucket unlistable *explicitly* rather
                # than merely un-granted, and the distinction is load-bearing:
                # an implicit deny is overcome by a `public-read` bucket ACL,
                # an explicit policy Deny is not.
                "Sid": "DenyBucketAccessExceptNamedKeys",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [tenant, admin]},
                "Action": "s3:*",
                "Resource": bucket_arn,
            },
            {
                # Object actions other than the two that serve a browser.
                # This is the statement that was proven inert: written as
                # `NotAction: PUBLIC_READ_ACTIONS`, it let an unrelated key in
                # the same project write an object into a tenant's media
                # bucket. The operational fence never hit this because it has
                # no anonymous reader to exempt and can use `Action: s3:*`;
                # public-read media cannot, so the complement is enumerated.
                "Sid": "DenyObjectAccessExceptPublicReadAndNamedKeys",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [tenant, admin]},
                "Action": NON_PUBLIC_OBJECT_ACTIONS,
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
    })


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
# `s3` is a shell function, not a variable: zsh does not word-split an
# unquoted parameter expansion, so `S3='aws ... s3api'` then `$S3 ...`
# fails there with "no such file or directory".
s3() {{ aws --endpoint-url {endpoint} s3api "$@"; }}

# 1. The bucket. `--acl private` is stated rather than left to the default:
#    `public-read` is a BUCKET acl and grants LIST, which would publish this
#    tenant's object names and, through the bucket name, the tenant roster.
s3 create-bucket --bucket {bucket} --acl private \\
  --create-bucket-configuration LocationConstraint={region}

# 2. Versioning, so an overwrite is recoverable and step 3 has something to
#    expire.
s3 put-bucket-versioning --bucket {bucket} \\
  --versioning-configuration Status=Enabled

# 3. The lifecycle rule doc 14 section 8 specifies. BEFORE the policy, because
#    step 4 denies `PutLifecycleConfiguration` to every key but the operator's
#    and there is no reason to depend on that exemption holding. Hetzner
#    supports only `NoncurrentDays` for NoncurrentVersionExpiration --
#    `NewerNoncurrentVersions` is unavailable -- and days is what section 8
#    wants. `AbortIncompleteMultipartUpload` stops a failed Ghost upload
#    accruing storage nothing will ever complete or bill down.
cat > /tmp/{bucket}-lifecycle.json <<'LIFECYCLE'
{{
  "Rules": [
    {{
      "ID": "branchleft-media-retention",
      "Status": "Enabled",
      "Filter": {{"Prefix": ""}},
      "NoncurrentVersionExpiration": {{"NoncurrentDays": 30}},
      "AbortIncompleteMultipartUpload": {{"DaysAfterInitiation": 7}}
    }}
  ]
}}
LIFECYCLE
s3 put-bucket-lifecycle-configuration --bucket {bucket} \\
  --lifecycle-configuration file:///tmp/{bucket}-lifecycle.json
rm /tmp/{bucket}-lifecycle.json

# 4. The policy. Until this lands the bucket is reachable by EVERY key in the
#    project, because Hetzner's default is project-wide key access -- so do not
#    leave step 4 for later, and do not hand the tenant its key before it.
cat > /tmp/{bucket}-policy.json <<'POLICY'
{policy}
POLICY
s3 put-bucket-policy --bucket {bucket} --policy file:///tmp/{bucket}-policy.json
rm /tmp/{bucket}-policy.json

# 5. Read both back. A put that was accepted and stored something different is
#    the failure worth catching here -- Hetzner is known to accept a
#    configuration and silently drop an element of it.
s3 get-bucket-policy --bucket {bucket} --output text
s3 get-bucket-lifecycle-configuration --bucket {bucket}
"""


def _self_test() -> None:
    """Prove the decisions this policy exists to make, not just its shape.

    `bucketpolicy.decide` is a model of S3 policy evaluation -- explicit Deny
    beats Allow beats the platform default -- so the four properties can be
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
        # The tenant must not be able to edit the fence that constrains it.
        # Each of these was `allow` in the first draft.
        (tenant, "s3:PutBucketPolicy", bucket, "deny"),
        (tenant, "s3:DeleteBucketPolicy", bucket, "deny"),
        (tenant, "s3:PutBucketAcl", bucket, "deny"),
        (tenant, "s3:PutLifecycleConfiguration", bucket, "deny"),
        (tenant, "s3:PutBucketVersioning", bucket, "deny"),
        (tenant, "s3:DeleteBucket", bucket, "deny"),
        (tenant, "s3:ListBucketVersions", bucket, "deny"),
        (other, "s3:ListBucket", bucket, "deny"),
        (other, "s3:PutObject", f"{bucket}/x.png", "deny"),
        (other, "s3:DeleteObject", f"{bucket}/x.png", "deny"),
        (admin, "s3:DeleteObject", f"{bucket}/x.png", "allow"),
        (admin, "s3:PutBucketPolicy", bucket, "allow"),
        (admin, "s3:PutBucketVersioning", bucket, "allow"),
        # Decisions the `NotAction` form did not make on this engine. They
        # were in this table then and passed, because `decide()` evaluated the
        # complement of a keyword the engine ignores: a passing table is
        # evidence about the policy only once the model matches the engine.
        (tenant, "s3:GetBucketPolicy", bucket, "deny"),
        (other, "s3:PutObject", f"{bucket}/x.png", "deny"),
        # Enumeration breadth. Each of these is an action a denylist written to
        # the minimum would have let through, and each is a way to take or
        # publish a tenant's media without calling PutObject or DeleteObject.
        (other, "s3:AbortMultipartUpload", f"{bucket}/x.png", "deny"),
        (other, "s3:PutObjectAcl", f"{bucket}/x.png", "deny"),
        (other, "s3:RestoreObject", f"{bucket}/x.png", "deny"),
        ("*", "s3:PutObjectAcl", f"{bucket}/x.png", "deny"),
        ("*", "s3:GetObjectAcl", f"{bucket}/x.png", "deny"),
        ("*", "s3:GetObjectAttributes", f"{bucket}/x.png", "deny"),
        (tenant, "s3:GetBucketVersioning", bucket, "deny"),
        (tenant, "s3:DeleteBucket", bucket, "deny"),
        (tenant, "s3:GetBucketAcl", bucket, "deny"),
        # ...and what the tenant must keep, so the enumeration cannot be
        # widened into an outage. Ghost uploads multipart and must be able to
        # abandon a failed part; `exists()` sends HeadObject, authorised by
        # GetObject.
        (tenant, "s3:AbortMultipartUpload", f"{bucket}/x.png", "allow"),
        (tenant, "s3:ListMultipartUploadParts", f"{bucket}/x.png", "allow"),
        (tenant, "s3:GetObject", f"{bucket}/x.png", "allow"),
        (tenant, "s3:GetBucketLocation", bucket, "allow"),
    ]
    for principal, action, resource, expected in cases:
        got = decide(policy, principal, action, resource)
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

    # Structural, and separate from the decision table on purpose: the table
    # can only ask about actions someone listed. This asks whether the
    # rendered document contains a construct this engine declines to enforce
    # at all, which no enumeration of cases would surface.
    for statement in policy["Statement"]:
        if "NotAction" in statement:
            raise AssertionError(
                f"policy self-test: statement {statement.get('Sid')!r} uses NotAction, "
                f"which this engine stores and does not enforce"
            )
        if statement["Effect"] == "Deny" and "Action" not in statement:
            raise AssertionError(
                f"policy self-test: Deny statement {statement.get('Sid')!r} names no Action"
            )

    try:
        assert_enforceable({"Statement": [{"Sid": "X", "NotAction": ["s3:GetObject"]}]})
    except PolicyInputError:
        pass
    else:
        raise AssertionError("policy self-test: assert_enforceable accepted a NotAction statement")

    print("render-media-bucket-policy self-test: ok", file=sys.stderr)


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
