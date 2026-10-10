#!/usr/bin/env python3
"""One-time setup of the backup bucket's versioning, lifecycle and fence. See configure_backup_bucket.md."""

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
# longer needs current. Governs the db prefixes (`dumps/`, `binlogs/`) only
# -- see MEDIA_NONCURRENT_VERSION_EXPIRATION_DAYS below for `media/`.
NONCURRENT_VERSION_EXPIRATION_DAYS = 35

# The figure to pass as --db-expiration-days for a bucket whose writer key is
# put-only, so `prune_backups.py` cannot run against it and the bucket's own
# lifecycle has to age out the current versions of `dumps/` and `binlogs/`.
# Same figure as that script's RETENTION_DAYS (a 7-day point-in-time window
# plus 3 days of margin). NEVER a default: where the writer can delete, the
# pruner owns retention, and a lifecycle rule cannot keep the newest object.
# A versioned bucket keeps an expired current dump restorable as a noncurrent
# version for NONCURRENT_VERSION_EXPIRATION_DAYS.
DB_CURRENT_EXPIRATION_DAYS = 10

# What the db prefixes get unless the operator asks for the figure above: no
# current-version expiry at all, only the noncurrent rule.
NO_DB_CURRENT_EXPIRY = 0

# The media backup writes each run as a new dated copy and its key cannot
# delete, so nothing but this bucket's lifecycle ever removes one. A copy
# is current until its expiry (MEDIA_CURRENT_EXPIRATION_DAYS below) and then
# stays as a noncurrent version for this many days, which only needs to
# outlive the delete marker turning into a durable removal. Proven live in
# infra/provisioning/scripts/probe-media-lifecycle-expiration.py's
# prefix-split mode; RUNBOOK-media-backup-lifecycle.md proves the current
# expiry on this prefix.
MEDIA_NONCURRENT_VERSION_EXPIRATION_DAYS = 1

# How long a dated media copy stays current: 28 days, at a weekly backup
# cadence (the owner's ruling), so about four generations exist at once. Dated
# full copies cost retention times the media size. 0 omits the rule and
# leaves media/ unbounded.
MEDIA_CURRENT_EXPIRATION_DAYS = 28

# `verify-bucket-fence.py`'s PROBE_PREFIX: the fence verifier writes tiny
# `fence-probe/*` control objects into THIS bucket to prove the fence policy
# actually fences one key from another, and its own `cleanup()` removes
# versions explicitly -- but when cleanup fails, it says so rather than
# guaranteeing removal, and nothing else in this pipeline's lifecycle
# document used to cover this prefix. Left uncovered, those objects sat
# under the same fate as anything outside every rule: kept forever. Same
# short window as `media/`, since these are throwaway verification objects
# with no retention argument of their own -- never the 35-day dumps/binlogs
# figure, which exists for a real recovery window this prefix has no use for.
FENCE_PROBE_PREFIX = "fence-probe/"

# The four prefixes this bucket's objects are written under -- see "FOUR
# NON-OVERLAPPING PREFIX RULES" above. Trailing slash on each: a prefix
# without one would also match an unrelated key merely starting with the
# same letters (`dumps-archive/...`), which nothing in this pipeline writes
# today but which a Filter/Prefix rule should not silently also cover.
DB_DUMP_PREFIX = "dumps/"
DB_BINLOG_PREFIX = "binlogs/"
MEDIA_OBJECT_PREFIX = "media/"

# A floor, not a measured TTL. See configure_backup_bucket.md, "The fence dwell".
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


def lifecycle_document(
    noncurrent_days: int = NONCURRENT_VERSION_EXPIRATION_DAYS,
    media_noncurrent_days: int = MEDIA_NONCURRENT_VERSION_EXPIRATION_DAYS,
    db_expiration_days: int = NO_DB_CURRENT_EXPIRY,
    media_expiration_days: int = MEDIA_CURRENT_EXPIRATION_DAYS,
) -> bytes:
    """Four non-overlapping prefix rules. See configure_backup_bucket.md, "Lifecycle rules"."""
    if db_expiration_days < 0:
        raise ValueError("db_expiration_days must be 0 (no current-version expiry) or positive")
    if media_expiration_days < 0:
        raise ValueError("media_expiration_days must be 0 (no current-version expiry) or positive")

    def expiry(days: int) -> str:
        return f"<Expiration><Days>{days}</Days></Expiration>" if days else ""

    rules = "".join(
        (
            f"<Rule><ID>branchleft-db-backups-{rule_id}-noncurrent-expiry</ID><Status>Enabled</Status>"
            f"<Filter><Prefix>{prefix}</Prefix></Filter>"
            f"<NoncurrentVersionExpiration><NoncurrentDays>{days}</NoncurrentDays>"
            "</NoncurrentVersionExpiration>"
            f"{current_expiry}"
            "</Rule>"
        )
        for rule_id, prefix, days, current_expiry in (
            ("dumps", DB_DUMP_PREFIX, noncurrent_days, expiry(db_expiration_days)),
            ("binlogs", DB_BINLOG_PREFIX, noncurrent_days, expiry(db_expiration_days)),
            ("media", MEDIA_OBJECT_PREFIX, media_noncurrent_days, expiry(media_expiration_days)),
            ("fence-probe", FENCE_PROBE_PREFIX, media_noncurrent_days, ""),
        )
    )
    return f'<LifecycleConfiguration xmlns="{S3_NS}">{rules}</LifecycleConfiguration>'.encode()


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
    "s3:GetBucketPolicy",
    "s3:PutBucketPolicy",
    "s3:DeleteBucketPolicy",
    "s3:PutBucketAcl",
    "s3:PutLifecycleConfiguration",
    "s3:PutBucketVersioning",
    "s3:DeleteBucket",
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


def _denied_to(statements: list, arn: str, resource: str, *, objects: bool) -> set:
    """The Action patterns some Deny withholds from `arn` on one resource class.

    See configure_backup_bucket.md, "Accounting for an exemption by a Deny".
    """
    withheld: set = set()
    for statement in statements:
        if statement.get("Effect") != "Deny" or "NotAction" in statement:
            continue
        resources = _string_list(statement.get("Resource"))
        if objects:
            reaches = any(r.startswith(resource) for r in resources)
        else:
            reaches = resource in resources
        if not reaches:
            continue
        principals = _principals(statement, "Principal")
        not_principals = _principals(statement, "NotPrincipal")
        if principals is not _MISSING:
            applies = arn in principals or "*" in principals
        elif not_principals is not _MISSING:
            applies = arn not in not_principals
        else:
            applies = False
        if applies:
            withheld.update(_string_list(statement.get("Action")))
    return withheld


def assert_policy_fences_this_bucket(policy: dict, bucket: str, operator_principal: str) -> None:
    """Refuse a policy that names another bucket, locks out the caller, fences
    nothing, or fences something other than what matters. Raises BucketConfigError.

    See configure_backup_bucket.md, "What the apply-time policy check refuses".
    """
    bucket_arn = f"arn:aws:s3:::{bucket}"
    objects_prefix = f"{bucket_arn}/"

    statements = policy.get("Statement", [])

    # Collected in its own pass, from every Allow regardless of where it sits
    # in the document, so a Deny earlier in the list can still be checked
    # against an Allow that appears after it.
    # principal -> the Action patterns some Allow grants it on that resource
    # class. Actions are kept, not just the principal: an exemption is only
    # accounted for if the Allow covers the actions being exempted, and an
    # unrelated low-value Allow on the same resource must not launder one.
    allowed_bucket_principals: dict = {}
    allowed_object_principals: dict = {}
    for statement in statements:
        if statement.get("Effect") != "Allow":
            continue
        principals = _principals(statement, "Principal")
        if principals is _MISSING:
            continue
        resources = _string_list(statement.get("Resource"))
        actions = _string_list(statement.get("Action"))
        if bucket_arn in resources:
            for arn in principals:
                allowed_bucket_principals.setdefault(arn, set()).update(actions)
        if any(resource.startswith(objects_prefix) for resource in resources):
            for arn in principals:
                allowed_object_principals.setdefault(arn, set()).update(actions)

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
            if not_principals is not _MISSING:
                raise BucketConfigError(
                    f"policy statement {sid!r} is an Allow carrying NotPrincipal, which "
                    f"grants every principal it does not name. That is the same exposure as "
                    f"Principal \"*\" written the other way round, and it reaches every "
                    f"credential in the project through Hetzner's project-wide default."
                )
            continue
        if effect != "Deny":
            raise BucketConfigError(f"policy statement {sid!r} has no usable Effect")

        covers_bucket = bucket_arn in resources
        covers_objects = any(resource.startswith(objects_prefix) for resource in resources)

        if not_principals is not _MISSING:
            required_here: set = set()
            if covers_bucket:
                required_here |= set(CRITICAL_BUCKET_CONFIGURATION_ACTIONS)
            if covers_objects:
                required_here |= set(CRITICAL_OBJECT_ACTIONS)
            for arn in not_principals:
                if arn == operator_principal:
                    continue
                granted: set = set()
                if covers_bucket:
                    granted |= allowed_bucket_principals.get(arn, set())
                    granted |= _denied_to(statements, arn, bucket_arn, objects=False)
                if covers_objects:
                    granted |= allowed_object_principals.get(arn, set())
                    granted |= _denied_to(statements, arn, objects_prefix, objects=True)
                unaccounted = {
                    action
                    for action in required_here
                    if not any(_action_covers(p, action) for p in granted)
                }
                if unaccounted:
                    raise BucketConfigError(
                        f"policy statement {sid!r} exempts {arn!r} from a Deny on "
                        f"{bucket!r}, but no Allow in this policy grants that principal "
                        f"{sorted(unaccounted)} on the same resource. An exemption nothing "
                        f"else in the policy accounts for reaches this bucket only through "
                        f"Hetzner's project-wide default, invisibly -- and an Allow for "
                        f"some unrelated action does not account for it."
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
    media_noncurrent_days: int = MEDIA_NONCURRENT_VERSION_EXPIRATION_DAYS,
    db_expiration_days: int = NO_DB_CURRENT_EXPIRY,
    media_expiration_days: int = MEDIA_CURRENT_EXPIRATION_DAYS,
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

    lifecycle_body = lifecycle_document(
        noncurrent_days, media_noncurrent_days, db_expiration_days, media_expiration_days
    )
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

    # The fence goes on last, and twice: the second PUT, after the dwell, is the
    # lockout control. See configure_backup_bucket.md, "Applying the fence".
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
        "--media-noncurrent-days",
        type=int,
        default=MEDIA_NONCURRENT_VERSION_EXPIRATION_DAYS,
        help="the media/ prefix's own, shorter noncurrent-version expiry -- see the module "
        "docstring's FOUR NON-OVERLAPPING PREFIX RULES section (shared with fence-probe/)",
    )
    parser.add_argument(
        "--db-expiration-days",
        type=int,
        default=NO_DB_CURRENT_EXPIRY,
        help="current-version expiry on dumps/ and binlogs/, written ONLY when this flag is "
        "given, for a bucket whose writer key is put-only and so cannot delete. Without it "
        "only the noncurrent rule is written and the bucket's own pruner keeps retention. "
        "See DB_CURRENT_EXPIRATION_DAYS for the decided figure",
    )
    parser.add_argument(
        "--media-expiration-days",
        type=int,
        default=MEDIA_CURRENT_EXPIRATION_DAYS,
        help="how long a dated media copy stays current before the bucket expires it, since "
        "the media backup key cannot delete; the default is 28; 0 omits it and media/ then "
        "grows without bound. See MEDIA_CURRENT_EXPIRATION_DAYS",
    )
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
            media_noncurrent_days=args.media_noncurrent_days,
            db_expiration_days=args.db_expiration_days,
            media_expiration_days=args.media_expiration_days,
        )
    except ObjectStorageError as exc:
        print(f"configure_backup_bucket: {exc}", file=sys.stderr)
        return 1

    media_expiry = (
        f"{args.media_expiration_days}-day current-version expiry"
        if args.media_expiration_days
        else "NO current-version expiry (media/ grows without bound until one is applied)"
    )
    db_expiry = (
        f"and {args.db_expiration_days}-day current-version expiry set on dumps/ and binlogs/"
        if args.db_expiration_days
        else "set on dumps/ and binlogs/, NO current-version expiry on dumps/ and binlogs/ "
        "(not asked for: pass --db-expiration-days to write one)"
    )
    print(
        f"configure_backup_bucket: versioning enabled, {args.noncurrent_days}-day noncurrent "
        f"expiry {db_expiry}, {media_expiry} and {args.media_noncurrent_days}-day noncurrent expiry "
        f"set on media/, {args.media_noncurrent_days}-day noncurrent expiry set on fence-probe/, and the fence applied "
        f"on {args.bucket}, then re-applied to prove the "
        f"bucket is still administrable. The fence is not proven to FENCE anything until "
        f"verify-bucket-fence.py passes -- run it now, from this terminal. The media/ expiry is "
        f"not proven to actually expire anything until "
        f"probe-media-lifecycle-expiration.py's prefix-split check comes back PASS -- run its "
        f"setup-split against a throwaway bucket, wait 24-48 hours, then run check-split."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
