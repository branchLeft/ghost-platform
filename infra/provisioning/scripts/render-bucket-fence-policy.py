#!/usr/bin/env python3
"""Render the fencing policy for one operational bucket, and the commands for it.

See render-bucket-fence-policy.md.
"""

from __future__ import annotations

import argparse
import json
import sys

from bucketpolicy import (
    BUCKET_CONFIGURATION_ACTIONS,
    BUCKET_READ_ACTIONS,
    PUT_ONLY,
    READ_ONLY,
    READ_WRITE,
    RECOVERY_ACTIONS,
    ROLE_BUCKET_ACTIONS,
    ROLE_DENIED_BUCKET_ACTIONS,
    ROLE_DENIED_OBJECT_ACTIONS,
    ROLE_OBJECT_ACTIONS,
    PolicyInputError,
    assert_enforceable,
    decide,
    key_principal,
    validate_bucket_name,
)

# Every bucket-resource action a read-write or read-only key keeps. All reads,
# none of them a disclosure of the fence itself: `GetBucketPolicy` is
# deliberately absent, so a compromised workload key cannot read back which
# other keys are named here.
WORKLOAD_BUCKET_READ_ACTIONS = BUCKET_READ_ACTIONS

# Withheld from every key but the operator's. See render-bucket-fence-policy.md,
# "Operator-only object actions".
OPERATOR_ONLY_OBJECT_ACTIONS = [
    "s3:DeleteObjectVersion",
    "s3:PutObjectAcl",
    "s3:PutObjectVersionAcl",
    "s3:PutObjectRetention",
    "s3:PutObjectLegalHold",
    "s3:BypassGovernanceRetention",
]


def _narrow_role_allows(
    writers: list[str], readers: list[str], bucket_arn: str, objects_arn: str
) -> list[dict]:
    """Exactly each narrow role's own actions, and no `s3:*`.

    Redundant under Hetzner's project default, as the read-write Allows are,
    and kept for the same reason: if that default is ever narrowed, the fence
    must still be what grants the worker its put. An explicit allow of exactly
    the put action, never a deny-everything-except, is the load-bearing shape.
    """
    statements = []
    if writers:
        statements.append({
            "Sid": "AllowPutOnlyKeysPut",
            "Effect": "Allow",
            "Principal": {"AWS": writers},
            "Action": ROLE_OBJECT_ACTIONS[PUT_ONLY],
            "Resource": objects_arn,
        })
    if readers:
        statements.append({
            "Sid": "AllowReadOnlyKeysObjectReads",
            "Effect": "Allow",
            "Principal": {"AWS": readers},
            "Action": ROLE_OBJECT_ACTIONS[READ_ONLY],
            "Resource": objects_arn,
        })
        statements.append({
            "Sid": "AllowReadOnlyKeysBucketReads",
            "Effect": "Allow",
            "Principal": {"AWS": readers},
            "Action": WORKLOAD_BUCKET_READ_ACTIONS,
            "Resource": bucket_arn,
        })
    return statements


def _narrow_role_denies(
    writers: list[str], readers: list[str], bucket_arn: str, objects_arn: str
) -> list[dict]:
    """Every object action a narrow role does not hold, denied by name.

    `Principal`, not `NotPrincipal`, so each statement's reach is the role's
    own keys and nothing else. The put-only keys' bucket listing is also denied
    by the bucket catch-all they are left under; it is stated here as well so
    the denial does not rest on `NotPrincipal` alone.
    """
    statements = []
    if writers:
        statements.append({
            "Sid": "DenyPutOnlyKeysReadsAndRemovals",
            "Effect": "Deny",
            "Principal": {"AWS": writers},
            "Action": ROLE_DENIED_OBJECT_ACTIONS[PUT_ONLY],
            "Resource": objects_arn,
        })
        statements.append({
            "Sid": "DenyPutOnlyKeysListing",
            "Effect": "Deny",
            "Principal": {"AWS": writers},
            "Action": ROLE_DENIED_BUCKET_ACTIONS[PUT_ONLY],
            "Resource": bucket_arn,
        })
    if readers:
        statements.append({
            "Sid": "DenyReadOnlyKeysMutations",
            "Effect": "Deny",
            "Principal": {"AWS": readers},
            "Action": ROLE_DENIED_OBJECT_ACTIONS[READ_ONLY],
            "Resource": objects_arn,
        })
    return statements


def assert_roles_hold(
    policy: dict, principals: dict[str, list[str]], bucket_arn: str, objects_arn: str
) -> None:
    """Refuse a policy under which any key cannot do its job, or can do more.

    Evaluated, like `assert_recoverable`, on the way out of every render: a
    put-only key that can read, or a drill key that cannot list, is a fence
    that reads correctly and is wrong.
    """
    an_object = objects_arn[:-1] + "dumps/any-object"
    for role, role_principals in principals.items():
        expectations = [
            *((a, an_object, "allow") for a in ROLE_OBJECT_ACTIONS[role]),
            *((a, bucket_arn, "allow") for a in ROLE_BUCKET_ACTIONS[role]),
            *((a, an_object, "deny") for a in ROLE_DENIED_OBJECT_ACTIONS.get(role, [])),
            *((a, bucket_arn, "deny") for a in ROLE_DENIED_BUCKET_ACTIONS.get(role, [])),
        ]
        for principal in role_principals:
            for action, resource, expected in expectations:
                got = decide(policy, principal, action, resource)
                if got != expected:
                    raise PolicyInputError(
                        f"refusing to emit a policy under which the {role} key {principal} "
                        f"gets {got} for {action} on {resource}; that role must get {expected}."
                    )


def render_policy(
    bucket: str,
    project_id: str,
    workload_access_keys: list[str],
    admin_access_key: str,
    *,
    writer_access_keys: list[str] = (),
    reader_access_keys: list[str] = (),
) -> dict:
    """The whole fence for one operational bucket, as one policy.

    `workload_access_keys` are read-write, `writer_access_keys` put-only and
    `reader_access_keys` read-only -- see `bucketpolicy.ROLES`. With no writer
    or reader keys the document is exactly the read-write fence it always was,
    so re-rendering an existing bucket's policy changes nothing on it.
    """
    validate_bucket_name(bucket)
    given = {
        READ_WRITE: list(workload_access_keys),
        PUT_ONLY: list(writer_access_keys),
        READ_ONLY: list(reader_access_keys),
    }
    if not any(given.values()):
        raise PolicyInputError(
            "no workload key given. A fence naming only the operator denies the bucket to "
            "the pipeline that uses it, which is an outage rather than a boundary -- and "
            "on the backup bucket it is a silent one until the next restore."
        )

    # One key, one role. A key named twice would be granted by one role's Allow
    # and denied by the other's Deny, and the Deny wins -- so a put-only key
    # also listed as read-write silently loses its writes, and the reverse
    # listing would read as a narrowing it is not.
    seen: dict[str, str] = {}
    for role, access_keys in given.items():
        for access_key in access_keys:
            if access_key in seen:
                raise PolicyInputError(
                    f"workload key {access_key!r} was given twice"
                    + ("" if seen[access_key] == role else f", as {seen[access_key]} and {role}")
                )
            seen[access_key] = role

    principals = {
        role: [key_principal(project_id, access_key) for access_key in access_keys]
        for role, access_keys in given.items()
    }
    workloads = principals[READ_WRITE]
    writers = principals[PUT_ONLY]
    readers = principals[READ_ONLY]
    admin = key_principal(project_id, admin_access_key)
    if admin in workloads + writers + readers:
        raise PolicyInputError(
            "the operator key and a workload key are the same credential. The fence would "
            "then leave the workload able to rewrite the policy that constrains it, which "
            "is most of what these statements withhold. Mint a distinct operator "
            "credential before fencing this bucket."
        )

    named = workloads + [admin]
    # Exempt from the object catch-all: every role touches objects. Exempt from
    # the bucket catch-all: everyone but the put-only keys, which need no
    # bucket-resource action at all -- leaving them under it denies every
    # bucket action, listing included, without depending on an enumeration.
    named_objects = workloads + writers + readers + [admin]
    named_bucket = workloads + readers + [admin]

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
            *_narrow_role_allows(writers, readers, bucket_arn, objects_arn),
            {
                # An enumerated Action list, never NotAction, which is stored and not
                # enforced. See render-bucket-fence-policy.md, "The bucket-configuration deny".
                "Sid": "DenyBucketConfigurationExceptOperator",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": [admin]},
                "Action": [
                    a for a in BUCKET_CONFIGURATION_ACTIONS
                    if a not in WORKLOAD_BUCKET_READ_ACTIONS
                ],
                "Resource": bucket_arn,
            },
            {
                # The reads the statement above exempts, denied to everyone but
                # the named keys. This is what makes the bucket unlistable
                # *explicitly* rather than merely un-granted.
                # `Action: s3:*`, not the enumerated read list: a construct
                # this engine is observed to enforce, and the one place the
                # catch-all property lost from the statement above can be had
                # back. A bucket sub-resource nobody thought of falls closed
                # against a stranger; only the named keys are exempt, and what
                # THEY may do to the bucket is narrowed by the statement above.
                "Sid": "DenyBucketAccessExceptNamedKeys",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": named_bucket},
                "Action": "s3:*",
                "Resource": bucket_arn,
            },
            {
                # No public read on an operational bucket, so this one takes
                # every object action and needs no `NotAction` exemption.
                "Sid": "DenyObjectAccessExceptNamedKeys",
                "Effect": "Deny",
                "NotPrincipal": {"AWS": named_objects},
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
            *_narrow_role_denies(writers, readers, bucket_arn, objects_arn),
        ],
    }

    assert_recoverable(policy, admin, bucket_arn)
    assert_roles_hold(policy, principals, bucket_arn, objects_arn)
    # After assert_recoverable, not before: recoverability is evaluated with
    # `decide()`, which now SKIPS a NotAction statement rather than evaluating
    # its complement. A policy that only stays administrable because of a
    # statement this engine ignores must fail the recoverability check on its
    # own terms first, and be refused here second.
    return assert_enforceable(policy)


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
    *,
    writer_access_keys: list[str] = (),
    reader_access_keys: list[str] = (),
) -> str:
    """The operator sequence, with every value filled in."""
    policy = json.dumps(
        render_policy(
            bucket,
            project_id,
            workload_access_keys,
            admin_access_key,
            writer_access_keys=writer_access_keys,
            reader_access_keys=reader_access_keys,
        ),
        indent=2,
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
  --versioning-configuration Status=Enabled\n\n"""
    )
    step = 2 if bucket_exists else 4
    return f"""\
# Run as the OPERATOR, with the operator key in the environment. Every command
# below is idempotent.
#
# `s3` is a shell function, not a variable: zsh does not word-split an
# unquoted parameter expansion, so `S3='aws ... s3api'` followed by `$S3 ...`
# fails there with "no such file or directory: aws --endpoint-url ...".

printf 'Access key id: '; read -r AWS_ACCESS_KEY_ID; export AWS_ACCESS_KEY_ID

printf 'Secret access key (hidden): '; read -rs AWS_SECRET_ACCESS_KEY; echo; export AWS_SECRET_ACCESS_KEY

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

rm /tmp/{bucket}-policy.json /tmp/{bucket}-policy.previous.json\n"""


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

    writer = "D" * 20
    reader = "E" * 20
    roles = render_policy(
        "branchleft-backups", project, [], admin,
        writer_access_keys=[writer], reader_access_keys=[reader],
    )
    writer_arn = key_principal(project, writer)
    reader_arn = key_principal(project, reader)
    objects = "arn:aws:s3:::branchleft-backups/dumps/x.sql.age"
    role_bucket = "arn:aws:s3:::branchleft-backups"
    for principal, action, resource, expected in [
        (writer_arn, "s3:PutObject", objects, "allow"),
        (writer_arn, "s3:GetObject", objects, "deny"),
        (writer_arn, "s3:DeleteObject", objects, "deny"),
        (writer_arn, "s3:DeleteObjectVersion", objects, "deny"),
        (writer_arn, "s3:ListBucket", role_bucket, "deny"),
        (reader_arn, "s3:GetObject", objects, "allow"),
        (reader_arn, "s3:ListBucket", role_bucket, "allow"),
        (reader_arn, "s3:PutObject", objects, "deny"),
        (reader_arn, "s3:DeleteObject", objects, "deny"),
    ]:
        got = decide(roles, principal, action, resource)
        if got != expected:
            raise AssertionError(
                f"fence self-test: {principal} {action} on {resource} -> {got}, expected {expected}"
            )

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
        help="a READ-WRITE key (put, get, list, delete) that uses this bucket; repeatable",
    )
    parser.add_argument(
        "--writer-access-key",
        action="append",
        default=[],
        metavar="ACCESS_KEY_ID",
        help="a PUT-ONLY key: may add objects, never read, list or delete them; repeatable",
    )
    parser.add_argument(
        "--reader-access-key",
        action="append",
        default=[],
        metavar="ACCESS_KEY_ID",
        help="a READ-ONLY key: get and list, nothing else; repeatable",
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
    if not (args.workload_access_key or args.writer_access_key or args.reader_access_key):
        missing.append("workload_access_key")
    if missing:
        parser.error(
            "missing required arguments: " + ", ".join("--" + m.replace("_", "-") for m in missing)
        )

    roles = {
        "writer_access_keys": args.writer_access_key,
        "reader_access_keys": args.reader_access_key,
    }
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
                    **roles,
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
                        **roles,
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
