#!/usr/bin/env python3
"""Render the fencing policy for one operational bucket, and the commands for it.

An operational bucket is one the estate itself uses -- the database backups,
the tenant Pulumi state -- as opposed to a tenant's media bucket, which
`render-media-bucket-policy.py` handles and which has an anonymous-read
requirement this one deliberately does not. Everything else about the problem
is the same, and the two generators share `bucketpolicy.py` rather than each
carrying a copy of the principal syntax and the evaluation model.

WHY A POLICY IS THE WHOLE BOUNDARY. Hetzner has no IAM, and each key pair is
valid for every bucket in the same project by default. An `Allow` therefore
narrows nothing, and an unfenced operational bucket is reachable by every
credential in its project -- including one minted for something else entirely
and held by CI, or by a tenant's own container.

WHAT THIS POLICY HAS TO ACHIEVE.

  1. The named workload keys keep exactly the access their job needs: object
     reads and writes, plus the bucket reads that make listing work. They get
     no bucket-CONFIGURATION action at all. A key that can call
     `PutLifecycleConfiguration` can expire every object without ever issuing a
     delete; one that can call `PutBucketPolicy` can replace this fence; one
     that can call `PutBucketVersioning` can suspend the versioning that makes
     an overwrite recoverable. Withholding `DeleteObject` while leaving those
     available buys nothing. They also lose the object actions that defeat
     versioning and object-lock from below -- see
     `OPERATOR_ONLY_OBJECT_ACTIONS`.

     THE WORKLOAD KEY LIST HAS TO BE COMPLETE. A key that legitimately uses the
     bucket and is not named here is denied by the same statements as a
     stranger, and nothing detects it: `verify-bucket-fence.py` proves the keys
     it is given still work, never that no other key was fenced out. When a
     bucket gains a second legitimate consumer -- per-tenant state credentials
     are the live example -- the policy is re-rendered with the full list and
     re-applied, before the new key is used.

  2. Every other principal is denied outright -- other keys in the project, and
     anonymous callers. Expressed as `Deny`, never as an absent `Allow`: an
     absent Allow is overcome by Hetzner's project-wide default, an explicit
     Deny is not.

  3. The bucket stays administrable BY THE OPERATOR, and this is the property
     that can destroy the estate if it is wrong. A `NotPrincipal` deny covering
     `PutBucketPolicy` locks the bucket permanently when it does not exempt the
     operator, because the statement that would have to be edited is the
     statement doing the denying. There is then no second credential to fall
     back on -- every key in the project is denied by the same statement -- and
     no `DeleteBucket` either. Recovery is a Hetzner support request against
     the storage cluster, and until it completes the bucket's contents are
     unreachable. `assert_recoverable()` below therefore re-evaluates every
     rendered policy and refuses to emit one that does not leave the operator
     `PutBucketPolicy` and `DeleteBucketPolicy`.

  4. `NotAction` on the bucket-configuration deny, so a bucket sub-resource
     nobody thought of falls closed rather than open. The object-level deny
     uses `Action: s3:*` instead, because there is nothing to exempt there and
     an empty `NotAction` has a plausible reading -- "no action is excluded
     from the exclusion" -- under which the statement denies nothing at all.

  5. Allow statements alongside the denies, naming the same keys. They are
     redundant under Hetzner's documented default, where the denies alone
     produce the intended outcome. They are not redundant if that default is
     ever narrowed, or if the engine treats the presence of a policy as
     switching the bucket to deny-by-default, as S3 proper does for a
     non-owner. Explicit `Deny` still beats them, so they cannot widen
     anything; they only stop a correct fence from also being an outage.

WHAT THIS FILE CANNOT ESTABLISH. Hetzner documents `NotPrincipal` verbatim but
publishes no list of supported Actions, Principal formats or Conditions, and
says nothing about `NotAction`. No policy of this shape has been observed
working against a live Hetzner bucket. A successful `put-bucket-policy` is not
evidence: an engine that ignores an unsupported element leaves the bucket open
while reporting success, and one that reads a `NotPrincipal` deny as naming
everybody locks it. Both directions are settled only by
`verify-bucket-fence.py` against the live bucket, run before the operator
walks away -- see RUNBOOK-bucket-fencing.md.

Nor can it establish that `--project-id` is the right project. Every principal
here is built from that one value, so `assert_recoverable()` below compares a
fabricated ARN against itself and passes for any project id at all -- while
live, an ARN carrying the right access key under the wrong account names a
principal that does not exist, and the operator's `NotPrincipal` exemption
exempts nobody. That is the one lockout no offline check can see. It is caught
by resolving the account from the credential itself, which
`verify-bucket-fence.py --preflight` and `configure_backup_bucket.py` both do
before anything is written.
"""

from __future__ import annotations

import argparse
import json
import sys

from bucketpolicy import (
    RECOVERY_ACTIONS,
    PolicyInputError,
    decide,
    key_principal,
    validate_bucket_name,
)

# Every bucket-resource action a workload key keeps. All reads, none of them a
# disclosure of the fence itself: `GetBucketPolicy` is deliberately absent, so
# a compromised workload key cannot read back which other keys are named here.
WORKLOAD_BUCKET_READ_ACTIONS = [
    "s3:ListBucket",
    "s3:ListBucketVersions",
    "s3:ListBucketMultipartUploads",
    "s3:GetBucketLocation",
]

# Object actions withheld from the workload keys, operator only. Each one
# defeats a layer that exists specifically to survive a compromise of the host
# holding the workload credential: `DeleteObjectVersion` destroys a version
# outright, where a plain `DeleteObject` on a versioned bucket only writes a
# delete marker the operator can remove; the retention trio disarms any
# object-lock policy; and `PutObjectAcl` publishes a single object without
# touching the bucket ACL this policy guards. None of them is used by the
# pipelines -- `prune_backups.py` issues a plain delete and relies on the
# lifecycle rule for versions -- so withholding them costs nothing.
#
# Enumerated rather than expressed as a `NotAction` catch-all, deliberately:
# this statement NARROWS a fence that is already closed to everyone but the
# named keys, so an action missing from the list falls back to that fence
# rather than to Hetzner's project-wide default.
OPERATOR_ONLY_OBJECT_ACTIONS = [
    "s3:DeleteObjectVersion",
    "s3:PutObjectAcl",
    "s3:PutObjectVersionAcl",
    "s3:PutObjectRetention",
    "s3:PutObjectLegalHold",
    "s3:BypassGovernanceRetention",
]


def render_policy(
    bucket: str, project_id: str, workload_access_keys: list[str], admin_access_key: str
) -> dict:
    """The whole fence for one operational bucket, as one policy."""
    validate_bucket_name(bucket)
    if not workload_access_keys:
        raise PolicyInputError(
            "no workload key given. A fence naming only the operator denies the bucket to "
            "the pipeline that uses it, which is an outage rather than a boundary -- and "
            "on the backup bucket it is a silent one until the next restore."
        )

    seen: list[str] = []
    for access_key in workload_access_keys:
        if access_key in seen:
            raise PolicyInputError(f"workload key {access_key!r} was given twice")
        seen.append(access_key)

    workloads = [key_principal(project_id, access_key) for access_key in workload_access_keys]
    admin = key_principal(project_id, admin_access_key)
    if admin in workloads:
        raise PolicyInputError(
            "the operator key and a workload key are the same credential. The fence would "
            "then leave the workload able to rewrite the policy that constrains it, which "
            "is most of what these statements withhold. Mint a distinct operator "
            "credential before fencing this bucket."
        )

    named = workloads + [admin]

    # `arn:aws:s3:::<bucket>` and `arn:aws:s3:::<bucket>/*` are two different
    # resources: object actions match the second, bucket actions the first.
    # Neither is ever written with a trailing `*` directly on the bucket name --
    # `arn:aws:s3:::branchleft-db-backups*` would also match every object in
    # `branchleft-db-backups-archive`.
    bucket_arn = f"arn:aws:s3:::{bucket}"
    objects_arn = f"arn:aws:s3:::{bucket}/*"

    policy = {
        "Version": "2012-10-17",
        "Id": f"fence-{bucket}",
        "Statement": [
            {
                "Sid": "AllowOperatorFullControl",
                "Effect": "Allow",
                "Principal": {"AWS": [admin]},
                "Action": "s3:*",
                "Resource": [bucket_arn, objects_arn],
            },
            {
                "Sid": "AllowNamedKeysObjectAccess",
                "Effect": "Allow",
                "Principal": {"AWS": named},
                "Action": "s3:*",
                "Resource": objects_arn,
            },
            {
                "Sid": "AllowNamedKeysBucketReads",
                "Effect": "Allow",
                "Principal": {"AWS": named},
                "Action": WORKLOAD_BUCKET_READ_ACTIONS,
                "Resource": bucket_arn,
            },
            {
                # The operator alone keeps every bucket-configuration action.
                # `NotAction` rather than an enumerated denylist, so an action
                # nobody thought of falls closed.
                "Sid": "DenyBucketConfigurationExceptOperator",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [admin]},
                "NotAction": WORKLOAD_BUCKET_READ_ACTIONS,
                "Resource": bucket_arn,
            },
            {
                # The reads the statement above exempts, denied to everyone but
                # the named keys. This is what makes the bucket unlistable
                # *explicitly* rather than merely un-granted.
                "Sid": "DenyBucketReadsExceptNamedKeys",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": named},
                "Action": WORKLOAD_BUCKET_READ_ACTIONS,
                "Resource": bucket_arn,
            },
            {
                # No public read on an operational bucket, so this one takes
                # every object action and needs no `NotAction` exemption.
                "Sid": "DenyObjectAccessExceptNamedKeys",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": named},
                "Action": "s3:*",
                "Resource": objects_arn,
            },
            {
                "Sid": "DenyObjectMutationsExceptOperator",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [admin]},
                "Action": OPERATOR_ONLY_OBJECT_ACTIONS,
                "Resource": objects_arn,
            },
        ],
    }

    assert_recoverable(policy, admin, bucket_arn)
    return policy


def assert_recoverable(policy: dict, admin: str, bucket_arn: str) -> None:
    """Refuse a policy that the operator could not replace once it is applied.

    This runs on the way out of every render, not as a test, because the
    failure it guards against is unrecoverable by any means this repository
    controls. `configure_backup_bucket.py` re-checks the same invariant from
    the opposite direction -- structurally, against the key actually in the
    environment -- immediately before the PUT. Two independent checks of one
    invariant is the intent, not an accident.
    """
    for action in RECOVERY_ACTIONS:
        if decide(policy, admin, action, bucket_arn) != "allow":
            raise PolicyInputError(
                f"refusing to emit a policy that denies the operator {action}. Applying it "
                f"would lock the bucket permanently: the statement that would have to be "
                f"edited is the statement doing the denying, and no other key in the "
                f"project is exempt either."
            )


def render_commands(
    bucket: str,
    project_id: str,
    workload_access_keys: list[str],
    admin_access_key: str,
    endpoint: str,
    region: str,
    bucket_exists: bool,
) -> str:
    """The operator sequence, with every value filled in."""
    policy = json.dumps(
        render_policy(bucket, project_id, workload_access_keys, admin_access_key), indent=2
    )
    create = (
        ""
        if bucket_exists
        else f"""\
# 2. The bucket. Creating one is a spend decision and is the platform owner's
#    alone. `--acl private` is stated rather than left to the default:
#    `public-read` is a BUCKET acl and grants LIST, which would publish the
#    object names of an estate bucket to anyone who guesses its name.
s3 create-bucket --bucket {bucket} --acl private \\
  --create-bucket-configuration LocationConstraint={region}

# 3. Versioning, so an overwrite or a mistaken delete is recoverable. Applied
#    BEFORE the policy, because the policy denies `PutBucketVersioning` to
#    every key but the operator's and there is no reason to depend on that
#    exemption holding.
s3 put-bucket-versioning --bucket {bucket} \\
  --versioning-configuration Status=Enabled

"""
    )
    step = 2 if bucket_exists else 4
    return f"""\
# Run as the OPERATOR, with the operator key in the environment. Every command
# below is idempotent.
#
# `s3` is a shell function, not a variable: zsh does not word-split an
# unquoted parameter expansion, so `S3='aws ... s3api'` followed by `$S3 ...`
# fails there with "no such file or directory: aws --endpoint-url ...".
export AWS_ACCESS_KEY_ID='<the operator access key id>'
export AWS_SECRET_ACCESS_KEY='<the operator secret access key>'
export AWS_DEFAULT_REGION='{region}'
s3() {{ aws --endpoint-url {endpoint} s3api "$@"; }}

# 1. CONFIRM THE POLICY NAMES THE ACCOUNT THIS CREDENTIAL IS IN. Every
#    principal in the document below was built from the --project-id passed to
#    the generator, and nothing offline can check that value. An ARN carrying
#    the right access key under the wrong account names a principal that does
#    not exist, so the operator's exemption exempts nobody and the fence locks
#    the bucket. This must print the same id the policy's ARNs carry.
s3 list-buckets --query Owner.ID --output text

{create}\
# {step}. Keep whatever policy is there now. On a bucket that has never carried
#    one this prints NoSuchBucketPolicy, which is the expected result and is
#    itself the finding that this fence exists to close.
s3 get-bucket-policy --bucket {bucket} --query Policy --output text \\
  > /tmp/{bucket}-policy.previous.json || true

# {step + 1}. The fence.
cat > /tmp/{bucket}-policy.json <<'POLICY'
{policy}
POLICY
s3 put-bucket-policy --bucket {bucket} --policy file:///tmp/{bucket}-policy.json

# {step + 2}. PROVE THE BUCKET IS STILL ADMINISTRABLE, before anything else and
#    before leaving the terminal. Re-PUTting the identical document is a no-op
#    if it succeeds and the only warning you will get if it does not: a policy
#    that denies the operator `PutBucketPolicy` cannot be edited or removed by
#    any key in the project, and recovery is a Hetzner support request against
#    the storage cluster.
s3 put-bucket-policy --bucket {bucket} --policy file:///tmp/{bucket}-policy.json

# {step + 3}. Prove both directions against the live bucket, now, in this
#    terminal. A successful put is not evidence that the fence works, and a
#    single AccessDenied is not evidence either: it is returned both by a
#    working fence and by a key that reaches nothing at all. The verifier pairs
#    every denial with a control probe on the same credential, compares the
#    STORED policy against this document, and reports INCONCLUSIVE rather than
#    PASS when a control does not succeed. Credentials come from its own
#    environment variables, not from the exported operator key above -- run it
#    exactly as RUNBOOK-bucket-fencing.md states.

rm /tmp/{bucket}-policy.json /tmp/{bucket}-policy.previous.json
"""


def _self_test() -> None:
    """Prove the decisions this policy exists to make, not just its shape."""
    project = "1231234"
    workload = "A" * 20
    admin = "B" * 20
    other = "C" * 20
    policy = render_policy("branchleft-db-backups", project, [workload], admin)
    workload_arn = key_principal(project, workload)
    admin_arn = key_principal(project, admin)
    other_arn = key_principal(project, other)
    bucket = "arn:aws:s3:::branchleft-db-backups"

    cases = [
        # (principal, action, resource, expected)
        (workload_arn, "s3:PutObject", f"{bucket}/dumps/x.sql.age", "allow"),
        (workload_arn, "s3:GetObject", f"{bucket}/dumps/x.sql.age", "allow"),
        (workload_arn, "s3:DeleteObject", f"{bucket}/dumps/x.sql.age", "allow"),
        (workload_arn, "s3:ListBucket", bucket, "allow"),
        (workload_arn, "s3:ListBucketVersions", bucket, "allow"),
        # A plain delete on a versioned bucket writes a marker the operator can
        # remove; destroying the version outright is the operator's alone.
        (workload_arn, "s3:DeleteObjectVersion", f"{bucket}/dumps/x.sql.age", "deny"),
        (workload_arn, "s3:PutObjectAcl", f"{bucket}/dumps/x.sql.age", "deny"),
        (workload_arn, "s3:BypassGovernanceRetention", f"{bucket}/dumps/x.sql.age", "deny"),
        (admin_arn, "s3:DeleteObjectVersion", f"{bucket}/dumps/x.sql.age", "allow"),
        # The workload must not be able to edit the fence that constrains it,
        # nor destroy the bucket's contents through its configuration.
        (workload_arn, "s3:PutBucketPolicy", bucket, "deny"),
        (workload_arn, "s3:DeleteBucketPolicy", bucket, "deny"),
        (workload_arn, "s3:GetBucketPolicy", bucket, "deny"),
        (workload_arn, "s3:PutBucketAcl", bucket, "deny"),
        (workload_arn, "s3:PutLifecycleConfiguration", bucket, "deny"),
        (workload_arn, "s3:PutBucketVersioning", bucket, "deny"),
        (workload_arn, "s3:DeleteBucket", bucket, "deny"),
        # The finding this fence exists to close: another key in the same
        # project reaching the bucket at all.
        (other_arn, "s3:ListBucket", bucket, "deny"),
        (other_arn, "s3:GetObject", f"{bucket}/dumps/x.sql.age", "deny"),
        (other_arn, "s3:PutObject", f"{bucket}/dumps/x.sql.age", "deny"),
        (other_arn, "s3:DeleteObject", f"{bucket}/dumps/x.sql.age", "deny"),
        (other_arn, "s3:PutBucketPolicy", bucket, "deny"),
        ("*", "s3:GetObject", f"{bucket}/dumps/x.sql.age", "deny"),
        ("*", "s3:ListBucket", bucket, "deny"),
        # The operator keeps the bucket administrable, and keeps the data.
        (admin_arn, "s3:PutBucketPolicy", bucket, "allow"),
        (admin_arn, "s3:DeleteBucketPolicy", bucket, "allow"),
        (admin_arn, "s3:PutLifecycleConfiguration", bucket, "allow"),
        (admin_arn, "s3:GetObject", f"{bucket}/dumps/x.sql.age", "allow"),
    ]
    for principal, action, resource, expected in cases:
        got = decide(policy, principal, action, resource)
        if got != expected:
            raise AssertionError(
                f"fence self-test: {principal} {action} on {resource} -> {got}, expected {expected}"
            )

    for bad_bucket in ["Bucket", "b", "has.dot", "trailing-", "../etc"]:
        try:
            render_policy(bad_bucket, project, [workload], admin)
        except PolicyInputError:
            continue
        raise AssertionError(f"fence self-test: bucket {bad_bucket!r} was accepted")

    for bad_key in ["short", "has:colon0000000", 'has"quote00000000']:
        try:
            render_policy("branchleft-db-backups", project, [bad_key], admin)
        except PolicyInputError:
            continue
        raise AssertionError(f"fence self-test: access key {bad_key!r} was accepted")

    try:
        render_policy("branchleft-db-backups", project, [admin], admin)
    except PolicyInputError:
        pass
    else:
        raise AssertionError("fence self-test: operator key accepted as its own workload key")

    print("render-bucket-fence-policy self-test: ok", file=sys.stderr)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bucket", help="the operational bucket to fence")
    parser.add_argument("--project-id", help="Hetzner project id holding the credentials")
    parser.add_argument(
        "--workload-access-key",
        action="append",
        default=[],
        metavar="ACCESS_KEY_ID",
        help="an access key id that legitimately uses this bucket; repeatable",
    )
    parser.add_argument("--admin-access-key", help="the operator's Object Storage access key id")
    parser.add_argument(
        "--endpoint",
        default="https://hel1.your-objectstorage.com",
        help="platform-wide Object Storage endpoint",
    )
    parser.add_argument("--region", default="hel1", help="platform-wide Object Storage location")
    parser.add_argument(
        "--commands",
        choices=("new-bucket", "existing-bucket"),
        help="print the operator command sequence instead of the bare policy",
    )
    parser.add_argument("--self-test", action="store_true", help="prove the decision table")
    args = parser.parse_args(argv)

    if args.self_test:
        _self_test()
        return 0

    missing = [name for name in ("bucket", "project_id", "admin_access_key") if not getattr(args, name)]
    if not args.workload_access_key:
        missing.append("workload_access_key")
    if missing:
        parser.error(
            "missing required arguments: " + ", ".join("--" + m.replace("_", "-") for m in missing)
        )

    try:
        if args.commands:
            print(
                render_commands(
                    args.bucket,
                    args.project_id,
                    args.workload_access_key,
                    args.admin_access_key,
                    args.endpoint,
                    args.region,
                    bucket_exists=args.commands == "existing-bucket",
                ),
                end="",
            )
        else:
            print(
                json.dumps(
                    render_policy(
                        args.bucket,
                        args.project_id,
                        args.workload_access_key,
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
