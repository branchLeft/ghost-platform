#!/usr/bin/env python3
"""One-time setup of the backup bucket's versioning, lifecycle and fence.

Run once by the platform owner, right after creating the bucket
(db/RUNBOOK-db.md's owner-only bucket step), from a workstation with the
**operator's** S3 credential in the environment -- never db1's backup
credential, never from db1, and never by either automated pipeline:

    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \\
      configure_backup_bucket.py --bucket branchleft-db-backups \\
      --endpoint hel1.your-objectstorage.com --region hel1 \\
      --policy-file /tmp/branchleft-db-backups-policy.json

The policy is not optional and there is no flag to skip it. Hetzner's
documented default is that every key pair in a project is valid for every
bucket in that project, so a bucket configured without one is readable and
deletable by every credential in its project -- including keys minted for
something else entirely, and keys that sit in CI. A bucket fenced later than
it is created has a window; a bucket that can be configured without being
fenced grows a second unfenced bucket the next time someone adds one. Render
the document with `infra/provisioning/scripts/render-bucket-fence-policy.py`
and see RUNBOOK-bucket-fencing.md for the ordering and the live verification.

The credential in the environment must be the operator's because the fence
withholds every bucket-configuration action from db1's backup key: after this
runs, that key can no longer set versioning or lifecycle, which is the point.

Object keys in this pipeline are already namespaced under MySQL's
`@@server_uuid` (dump_nightly.py, ship_binlogs.py), which is the primary
defence against a rebuilt db1 overwriting a pre-rebuild archive under a
reused name. Versioning is the second, independent layer required by doc 14
§8's own backup design: a bug in the namespacing, a manually re-run dump
under a hand-typed key, or any other write this pipeline did not anticipate
still lands as a new version rather than destroying the object it replaces.
The lifecycle rule bounds how long a *superseded* version survives --
`NoncurrentDays=35` comfortably outlives the 7-day on-host binlog retention
this stack otherwise relies on for recovery, without keeping every
overwritten version forever.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sys
import time

from objectstorage import ObjectStorageError, owner_id, put_bucket_subresource

S3_NS = "http://s3.amazonaws.com/doc/2006-03-01/"

# Comfortably beyond the 7-day on-host binlog window this stack otherwise
# depends on, without an unbounded lifetime for a version this pipeline no
# longer needs current.
NONCURRENT_VERSION_EXPIRATION_DAYS = 35

# How long to hold between the fence policy's first PUT and its confirming
# second one.
#
# THIS IS NOT A MEASURED TTL -- treat it as a floor, not a budget. The two live
# measurements behind this fix bound the DELETE-side release at roughly 15-20
# seconds (t+10 still denied, t+20 allowed), but the PUT-side sequence never
# sampled between t+0 and t+90: the read taken immediately after the PUT was
# already stale, and the next sample, at t+90, had already cleared. So the
# write-visible-to-read window is bounded only by "cleared by t+90", not
# measured down to a smaller figure -- and every measurement was a GetObject
# read decision, while this dwell guards a PutBucketPolicy authorisation
# decision that has never been measured at all. Extrapolating from one to the
# other on the path guarding the estate's only database backups is not a place
# to assert a number the evidence does not carry, so this matches the
# verifier's own DWELL_SECONDS rather than undercutting it.
FENCE_ENGINE_DWELL_SECONDS = 120.0

# Indirected so tests can run the dwell without waiting.
_sleep = time.sleep


def _narrate(message: str) -> None:
    """Reassure an operator watching the dwell that it is waiting, not hung.

    Gated on an interactive stderr so a CI log or a test run does not fill up
    with a line per poll -- the permanent record of what was waited is the
    `_sleep` calls themselves, which the tests assert on directly.
    """
    if sys.stderr.isatty():
        print(message, file=sys.stderr)


class BucketConfigError(Exception):
    """Setup did not complete."""


def versioning_document() -> bytes:
    return f'<VersioningConfiguration xmlns="{S3_NS}"><Status>Enabled</Status></VersioningConfiguration>'.encode()


def lifecycle_document(noncurrent_days: int = NONCURRENT_VERSION_EXPIRATION_DAYS) -> bytes:
    return (
        f'<LifecycleConfiguration xmlns="{S3_NS}">'
        "<Rule><ID>branchleft-db-backups-noncurrent-expiry</ID><Status>Enabled</Status>"
        "<Filter><Prefix></Prefix></Filter>"
        f"<NoncurrentVersionExpiration><NoncurrentDays>{noncurrent_days}</NoncurrentDays>"
        "</NoncurrentVersionExpiration>"
        "</Rule></LifecycleConfiguration>"
    ).encode()


_MISSING = object()


def _string_list(value) -> list[str]:
    """Every place a policy takes "one or many" -- Resource, Action, and the
    `AWS` member of Principal -- accepts a bare string or a list, and the bare
    string is the form most published examples use. Reading only the list form
    silently skips the statement, which for a `Deny` means passing it."""
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str)]
    return []


def _principals(statement: dict, field: str):
    """The principals a statement names, or `_MISSING` when it names no such
    field at all. The distinction matters: an empty list and an absent key are
    the same to `.get`, but a `Deny` with no `Principal` and no `NotPrincipal`
    is a statement whose scope this checker cannot bound, not a statement that
    names nobody."""
    if field not in statement:
        return _MISSING
    principal = statement[field]
    if isinstance(principal, str):
        return [principal]
    if isinstance(principal, dict):
        return _string_list(principal.get("AWS"))
    return []


# The bucket-configuration actions a workload credential must never hold:
# each one alone lets a compromised pipeline credential rewrite this fence,
# publish the bucket ACL, expire the backups via a lifecycle rule, or
# suspend the versioning that makes an overwrite recoverable.
CRITICAL_BUCKET_CONFIGURATION_ACTIONS = [
    "s3:PutBucketPolicy",
    "s3:PutBucketAcl",
    "s3:PutLifecycleConfiguration",
    "s3:PutBucketVersioning",
]

# The whole of what a workload credential legitimately does with an object --
# read, write, delete. This bucket has no anonymous-read requirement, so
# nothing needs a narrower exemption than these three withheld from every
# principal but the operator and the named workload keys.
CRITICAL_OBJECT_ACTIONS = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]


def _action_covers(pattern: str, action: str) -> bool:
    """True if a statement's Action entry `pattern` matches `action`.

    Mirrors infra/provisioning/scripts/bucketpolicy.py's own wildcard
    handling rather than importing across the two scripts' independent
    evaluation models: `s3:*` matches everything after the prefix, anything
    else must match literally.
    """
    return pattern == action or (pattern.endswith("*") and action.startswith(pattern[:-1]))


def _withheld(actions: list[str], required: list[str]) -> set[str]:
    """Which of `required` a Deny naming `actions` actually withholds."""
    return {action for action in required if any(_action_covers(p, action) for p in actions)}


def assert_policy_fences_this_bucket(policy: dict, bucket: str, operator_principal: str) -> None:
    """Refuse a policy that names another bucket, locks out the caller, fences
    nothing, or fences something other than what matters.

    Applying a bucket policy is the one operation here that can be
    irreversible. Every `Deny` in the policy governs the very API call that
    would edit it, so a `Deny` covering the credential in this environment
    leaves nobody able to replace or remove the statement doing the denying --
    not another key in the project, which the same statement also denies, and
    not `DeleteBucket`, which it denies too. Recovery is a support request
    against the storage cluster, with the bucket unreachable meanwhile.

    `operator_principal` is the caller's own full ARN, resolved from the live
    API rather than assembled from an argument. Matching on the access key
    alone would accept an ARN carrying the right key under the wrong account
    id, which names a principal that does not exist -- a `NotPrincipal`
    exemption for nobody, and the one lockout no offline check can see, because
    a rendered policy is self-consistent with whatever account id it was built
    from.

    Reaching a resource is not the same as withholding anything on it. A
    `Deny` that reaches the bucket or object resource but is expressed with
    `NotAction` fences nothing at all: Hetzner Object Storage accepts,
    stores and returns that construct byte-identical to what was sent, and
    enforces none of it. And a `Deny` expressed with `Action` still has to
    actually cover `CRITICAL_BUCKET_CONFIGURATION_ACTIONS` /
    `CRITICAL_OBJECT_ACTIONS` for its resource class -- a narrowed list reads
    as a fence while leaving the actions it omits to Hetzner's project-wide
    default, which is allow. Nor may a `NotPrincipal` exemption name a
    principal this policy grants no `Allow` for on the same resource: an
    exemption nothing else in the document accounts for reaches this bucket
    only through that same project-wide default, invisibly.

    Anything this checker cannot bound is refused rather than passed. A `Deny`
    with no `Resource`, or with neither `Principal` nor `NotPrincipal`, has a
    scope that depends on how the engine reads an absent field, and "probably
    fine" is not a basis for an irreversible write.
    """
    bucket_arn = f"arn:aws:s3:::{bucket}"
    objects_prefix = f"{bucket_arn}/"

    statements = policy.get("Statement", [])

    # Collected in its own pass, from every Allow regardless of where it sits
    # in the document, so a Deny earlier in the list can still be checked
    # against an Allow that appears after it.
    allowed_bucket_principals: set = set()
    allowed_object_principals: set = set()
    for statement in statements:
        if statement.get("Effect") != "Allow":
            continue
        principals = _principals(statement, "Principal")
        if principals is _MISSING:
            continue
        resources = _string_list(statement.get("Resource"))
        if bucket_arn in resources:
            allowed_bucket_principals.update(principals)
        if any(resource.startswith(objects_prefix) for resource in resources):
            allowed_object_principals.update(principals)

    denies_bucket = False
    denies_objects = False
    bucket_actions_withheld: set = set()
    object_actions_withheld: set = set()

    for statement in statements:
        sid = statement.get("Sid", "<no Sid>")

        if "NotAction" in statement:
            raise BucketConfigError(
                f"policy statement {sid!r} uses NotAction. Hetzner Object Storage accepts, "
                f"stores and returns this construct byte-identical to what was sent, and "
                f"enforces none of it -- a statement built on it withholds nothing, however "
                f"complete it reads."
            )

        effect = statement.get("Effect")
        resources = _string_list(statement.get("Resource"))

        if not resources:
            raise BucketConfigError(
                f"policy statement {sid!r} names no Resource. Its scope depends on how the "
                f"engine reads an absent field, so it cannot be applied to {bucket!r}."
            )
        for resource in resources:
            if resource != bucket_arn and not resource.startswith(objects_prefix):
                raise BucketConfigError(
                    f"the policy names resource {resource!r}, which is not {bucket!r}. "
                    f"Applying it here would fence the wrong bucket and leave this one open."
                )

        principals = _principals(statement, "Principal")
        not_principals = _principals(statement, "NotPrincipal")

        if effect == "Allow":
            if principals is not _MISSING and any(arn == "*" for arn in principals):
                raise BucketConfigError(
                    f"policy statement {sid!r} allows every principal on {bucket!r}. This "
                    f"bucket has no anonymous-read requirement, and applying it would "
                    f"publish the bucket rather than fence it."
                )
            continue
        if effect != "Deny":
            raise BucketConfigError(f"policy statement {sid!r} has no usable Effect")

        covers_bucket = bucket_arn in resources
        covers_objects = any(resource.startswith(objects_prefix) for resource in resources)

        if not_principals is not _MISSING:
            allowed_here: set = set()
            if covers_bucket:
                allowed_here |= allowed_bucket_principals
            if covers_objects:
                allowed_here |= allowed_object_principals
            for arn in not_principals:
                if arn != operator_principal and arn not in allowed_here:
                    raise BucketConfigError(
                        f"policy statement {sid!r} exempts {arn!r} from a Deny on "
                        f"{bucket!r}, but no Allow statement in this policy grants that "
                        f"principal access to the same resource. An exemption nothing else "
                        f"in the policy accounts for reaches this bucket only through "
                        f"Hetzner's project-wide default, invisibly."
                    )

        actions = _string_list(statement.get("Action"))
        if covers_bucket:
            denies_bucket = True
            bucket_actions_withheld |= _withheld(actions, CRITICAL_BUCKET_CONFIGURATION_ACTIONS)
        if covers_objects:
            denies_objects = True
            object_actions_withheld |= _withheld(actions, CRITICAL_OBJECT_ACTIONS)

        # Only a Deny reaching the BUCKET resource can withhold
        # `PutBucketPolicy`; a Deny confined to `<bucket>/*` covers object
        # actions and cannot lock anything.
        if not covers_bucket:
            continue

        if not_principals is not _MISSING:
            if operator_principal not in not_principals:
                raise BucketConfigError(
                    f"policy statement {sid!r} denies bucket actions to every principal "
                    f"except {', '.join(not_principals) or '(nobody)'}, and this credential "
                    f"is {operator_principal}. Applying it would lock this bucket "
                    f"permanently. Check the project id the policy was rendered with, and "
                    f"that this is the operator credential the policy exempts."
                )
            continue

        if principals is _MISSING:
            raise BucketConfigError(
                f"policy statement {sid!r} denies bucket actions and names neither Principal "
                f"nor NotPrincipal. If the engine reads that as every principal, applying it "
                f"locks this bucket permanently."
            )
        if any(arn == "*" or arn == operator_principal for arn in principals):
            raise BucketConfigError(
                f"policy statement {sid!r} denies bucket actions to this credential "
                f"({operator_principal}). Applying it would lock this bucket permanently."
            )

    if not denies_bucket or not denies_objects:
        raise BucketConfigError(
            f"the policy denies nothing on the bucket resource, or nothing on its objects. "
            f"Hetzner's default is that every key pair in a project reaches every bucket in "
            f"it, so a policy without both denials leaves {bucket!r} open to every credential "
            f"in the project while reporting success."
        )

    missing_bucket = [a for a in CRITICAL_BUCKET_CONFIGURATION_ACTIONS if a not in bucket_actions_withheld]
    if missing_bucket:
        raise BucketConfigError(
            f"the policy denies something on the bucket resource, but not "
            f"{', '.join(missing_bucket)}. A Deny that reaches this resource without "
            f"withholding these leaves a workload credential able to rewrite the fence, "
            f"widen it, or disable the recovery layers this bucket depends on, while the "
            f"policy still reads as fenced."
        )
    missing_objects = [a for a in CRITICAL_OBJECT_ACTIONS if a not in object_actions_withheld]
    if missing_objects:
        raise BucketConfigError(
            f"the policy denies something on the object resource, but not "
            f"{', '.join(missing_objects)}. This bucket has no anonymous-read requirement, "
            f"so nothing needs a narrower exemption than these withheld from every "
            f"principal but the operator and the named workload keys."
        )


def load_policy(path: str) -> tuple[dict, bytes]:
    with open(path, "rb") as handle:
        body = handle.read()
    try:
        policy = json.loads(body)
    except json.JSONDecodeError as error:
        raise BucketConfigError(f"{path} is not valid JSON: {error}") from error
    if not isinstance(policy, dict) or not policy.get("Statement"):
        raise BucketConfigError(f"{path} carries no policy statements")
    return policy, body


def _await_engine_catchup(dwell_seconds: float) -> None:
    """Hold until the policy engine's read path can no longer be serving the pre-PUT decision.

    Silent for the whole dwell during a production apply reads as a hang, not
    a wait, so this narrates what it is doing and polls in short steps rather
    than sleeping the total in one call.
    """
    if dwell_seconds <= 0:
        return
    _narrate(
        f"configure_backup_bucket: waiting {dwell_seconds:g}s for the policy engine's read "
        f"path to settle before the confirming PUT -- this pause is deliberate, not a hang"
    )
    remaining = dwell_seconds
    elapsed = 0.0
    while remaining > 0:
        step = min(10.0, remaining)
        _sleep(step)
        remaining -= step
        elapsed += step
        _narrate(f"configure_backup_bucket:   {elapsed:g}s of {dwell_seconds:g}s elapsed")


def configure_backup_bucket(
    *,
    bucket: str,
    endpoint: str,
    region: str,
    access_key: str,
    secret_key: str,
    policy_body: bytes,
    noncurrent_days: int = NONCURRENT_VERSION_EXPIRATION_DAYS,
    fence_dwell_seconds: float = FENCE_ENGINE_DWELL_SECONDS,
    put=put_bucket_subresource,
) -> None:
    put(
        bucket=bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        subresource="versioning",
        body=versioning_document(),
    )

    lifecycle_body = lifecycle_document(noncurrent_days)
    content_md5 = base64.b64encode(hashlib.md5(lifecycle_body, usedforsecurity=False).digest()).decode()
    put(
        bucket=bucket,
        endpoint=endpoint,
        region=region,
        access_key=access_key,
        secret_key=secret_key,
        subresource="lifecycle",
        body=lifecycle_body,
        content_md5=content_md5,
    )

    # The fence goes on LAST. It denies every bucket-configuration action to
    # every key but the operator's, so the two calls above must already have
    # landed rather than depend on that exemption holding. No `content_md5`:
    # `aws s3api put-bucket-policy` sends none either, and a header this
    # endpoint does not expect is one more thing that can be rejected on the
    # one call that must not fail halfway.
    #
    # Twice, deliberately, and the second call is the control. If this engine
    # reads the policy's `NotPrincipal` as naming every principal rather than
    # exempting the one it lists, the first PUT succeeds and the bucket is
    # already unrecoverable -- `PutBucketPolicy` and `DeleteBucket` both denied
    # by the statement that would have to be edited. The second PUT is a no-op
    # when the exemption works and the only signal that exists when it does
    # not. It lives here rather than only in the runbook because the operator
    # path for a rebuilt db1 (db/RUNBOOK-db.md) runs this script and stops.
    #
    # THE SECOND PUT IS ONLY A CONTROL ONCE THE DWELL HAS RUN. Sent right after
    # the first, it is authorised against the same cached pre-PUT decision the
    # first PUT was -- so it returns 2xx whether the lockout landed or not, and
    # an operator who reads that 2xx as confirmation walks away from a bucket
    # that locks itself out seconds later. `_await_engine_catchup` is what
    # makes the second PUT mean anything.
    for attempt in range(2):
        if attempt:
            _await_engine_catchup(fence_dwell_seconds)
        put(
            bucket=bucket,
            endpoint=endpoint,
            region=region,
            access_key=access_key,
            secret_key=secret_key,
            subresource="policy",
            body=policy_body,
        )


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--endpoint", required=True, help="e.g. hel1.your-objectstorage.com")
    parser.add_argument("--region", required=True, help="the bucket's own location, e.g. hel1")
    parser.add_argument("--noncurrent-days", type=int, default=NONCURRENT_VERSION_EXPIRATION_DAYS)
    parser.add_argument(
        "--policy-file",
        required=True,
        help="the fence policy, from infra/provisioning/scripts/render-bucket-fence-policy.py",
    )
    parser.add_argument(
        "--engine-diagnostic-passed",
        action="store_true",
        help="confirm verify-bucket-fence.py --diagnose-policy-engine has reported that a "
        "bucket policy can fence one key from another on this account; without it this "
        "script writes nothing",
    )
    args = parser.parse_args(argv)

    # THIS SCRIPT IS A SECOND PATH TO AN APPLY, and the operator who reaches it
    # is rebuilding db1 from db/RUNBOOK-db.md and never opens
    # RUNBOOK-bucket-fencing.md. A fence that locks the operator out is
    # unrecoverable from inside the account -- a support request against the
    # storage cluster, with the bucket unreachable meanwhile -- so this script
    # does not let that shape ship on the strength of a rendered document
    # alone. The flag is a claim the operator makes, not a check this script
    # can run: the diagnostic needs three credentials and a bucket this script
    # has no business touching. It exists so that applying a fence is a
    # decision, confirmed once and deliberately, rather than the default.
    if not args.engine_diagnostic_passed:
        print(
            "configure_backup_bucket: refusing to apply a fence until the engine question is "
            "settled. Applying a bucket policy here is the one step in this pipeline that "
            "cannot be undone from inside the account if this engine does not separate "
            "credentials the way the fence assumes, so it is confirmed once, deliberately, "
            "before any bucket gets one. Run section 0 of RUNBOOK-bucket-fencing.md first:\n\n"
            "    python3 infra/provisioning/scripts/verify-bucket-fence.py "
            "--diagnose-policy-engine --bucket <this bucket>\n\n"
            "It is reversible, writes no fence, and prints a verdict in prose. Re-run this "
            "command with --engine-diagnostic-passed only if that verdict says a bucket "
            "policy can fence one key from another on this account. Nothing has been written: "
            "versioning and the lifecycle rule are not applied either, because a bucket "
            "half-configured by a refused run is worse than one not configured at all.",
            file=sys.stderr,
        )
        return 2

    access_key = os.environ.get("AWS_ACCESS_KEY_ID")
    secret_key = os.environ.get("AWS_SECRET_ACCESS_KEY")
    if not access_key or not secret_key:
        print("AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set.", file=sys.stderr)
        return 2

    try:
        policy, policy_body = load_policy(args.policy_file)
        # Resolved from the live API, never assembled from an argument: the
        # account id in a policy principal is the half no offline check can
        # verify, and getting it wrong exempts nobody.
        account = owner_id(
            endpoint=args.endpoint,
            region=args.region,
            access_key=access_key,
            secret_key=secret_key,
        )
        operator_principal = f"arn:aws:iam:::user/{account}:{access_key}"
        assert_policy_fences_this_bucket(policy, args.bucket, operator_principal)
    except (BucketConfigError, ObjectStorageError, OSError) as exc:
        print(f"configure_backup_bucket: {exc}", file=sys.stderr)
        return 2

    try:
        configure_backup_bucket(
            bucket=args.bucket,
            endpoint=args.endpoint,
            region=args.region,
            access_key=access_key,
            secret_key=secret_key,
            policy_body=policy_body,
            noncurrent_days=args.noncurrent_days,
        )
    except ObjectStorageError as exc:
        print(f"configure_backup_bucket: {exc}", file=sys.stderr)
        return 1

    print(
        f"configure_backup_bucket: versioning enabled, {args.noncurrent_days}-day noncurrent "
        f"expiry set, and the fence applied on {args.bucket}, then re-applied to prove the "
        f"bucket is still administrable. The fence is not proven to FENCE anything until "
        f"verify-bucket-fence.py passes -- run it now, from this terminal."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
