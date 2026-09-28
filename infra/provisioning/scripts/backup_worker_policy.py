#!/usr/bin/env python3
"""The backup worker's own put credential policy: an explicit ALLOW naming
exactly what the credential may do, never a deny-except. Checks the
opposite side of the bucket from `configure_backup_bucket.py`'s operator
fence — the WORKLOAD credential's own grant, scoped to `s3:PutObject` only.
See backup_worker_policy.md#module-overview.
"""

from __future__ import annotations

ALLOWED_ACTIONS: tuple[str, ...] = ("s3:PutObject",)


class BackupWorkerPolicyError(Exception):
    """The policy does not read as an explicit, minimal allow for this
    credential."""


def render_backup_worker_put_policy(*, bucket: str, prefix: str, worker_principal: str) -> dict:
    """The policy document to apply to the backup-only project's bucket, for
    the workload credential the backup worker itself holds. Provisioning
    the bucket and applying this document is an owner action -- see this
    story's PR body -- this function only renders the document; nothing in
    this repository applies it."""
    if not prefix.endswith("/"):
        raise BackupWorkerPolicyError(
            f"prefix {prefix!r} must end with '/' -- without it, this policy's Resource could "
            "also match an unrelated key that merely starts with the same characters"
        )
    resource = f"arn:aws:s3:::{bucket}/{prefix}*"
    return {
        "Version": "2012-10-17",
        "Statement": [
            {
                "Sid": "backup-worker-put-only",
                "Effect": "Allow",
                "Principal": {"AWS": [worker_principal]},
                "Action": list(ALLOWED_ACTIONS),
                "Resource": [resource],
            }
        ],
    }


def _as_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def assert_explicit_allow_put_only(policy: dict, *, bucket: str, worker_principal: str) -> None:
    """Refuses anything but a policy that names `worker_principal` in an
    explicit `Allow` statement granting exactly `ALLOWED_ACTIONS`, scoped
    under `bucket`. See backup_worker_policy.md#assert_explicit_allow_put_only
    for every refusal case.
    """
    statements = policy.get("Statement")
    if not isinstance(statements, list) or not statements:
        raise BackupWorkerPolicyError(
            "policy carries no Statement -- an absent policy is this provider's project-wide "
            "default allow, not an explicit one, and this credential's access must be explicit"
        )

    matching = []
    for statement in statements:
        if "NotAction" in statement or "NotPrincipal" in statement:
            raise BackupWorkerPolicyError(
                f"statement {statement.get('Sid', '<no Sid>')!r} uses NotAction/NotPrincipal -- "
                "this provider accepts and returns that construct byte-identical to what was "
                "sent and enforces none of it, so it grants or withholds nothing however "
                "complete it reads (the same refusal configure_backup_bucket.py's "
                "assert_policy_fences_this_bucket makes for the operator's fence)"
            )
        principal = statement.get("Principal")
        principal_arns = _as_list(principal.get("AWS") if isinstance(principal, dict) else principal)
        if worker_principal not in principal_arns:
            continue
        matching.append(statement)

    if not matching:
        raise BackupWorkerPolicyError(
            f"no statement names {worker_principal!r} as Principal -- this credential's access "
            "is not explicit anywhere in this policy"
        )

    bucket_resource_prefix = f"arn:aws:s3:::{bucket}/"
    for statement in matching:
        if statement.get("Effect") != "Allow":
            raise BackupWorkerPolicyError(
                f"the statement naming {worker_principal!r} has Effect "
                f"{statement.get('Effect')!r}, not Allow"
            )

        actions = _as_list(statement.get("Action"))
        if any(action in ("*", "s3:*") for action in actions):
            raise BackupWorkerPolicyError(
                f"statement grants {actions!r} to {worker_principal!r} -- a wildcard is not an "
                f"explicit allow of what this credential actually needs ({list(ALLOWED_ACTIONS)})"
            )
        extra = sorted(set(actions) - set(ALLOWED_ACTIONS))
        if extra:
            raise BackupWorkerPolicyError(
                f"statement grants {extra} to {worker_principal!r} beyond {list(ALLOWED_ACTIONS)} "
                "-- refusing to widen this credential's access silently"
            )
        if not set(ALLOWED_ACTIONS) <= set(actions):
            raise BackupWorkerPolicyError(
                f"statement does not grant all of {list(ALLOWED_ACTIONS)} to {worker_principal!r}"
            )

        resources = _as_list(statement.get("Resource"))
        if not resources or not all(
            isinstance(resource, str) and resource.startswith(bucket_resource_prefix)
            for resource in resources
        ):
            raise BackupWorkerPolicyError(
                f"statement's Resource {resources!r} is not scoped under "
                f"{bucket_resource_prefix!r}"
            )
