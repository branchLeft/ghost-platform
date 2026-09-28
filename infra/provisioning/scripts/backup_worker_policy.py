#!/usr/bin/env python3
"""The backup worker's put-only credential, as the bucket fence renders and checks it.

One source of truth: the document comes from `render-bucket-fence-policy.py`
and the role table from `bucketpolicy.py`. See render-bucket-fence-policy.md.
"""

from __future__ import annotations

import importlib.util
import pathlib

from bucketpolicy import (
    PUT_ONLY,
    ROLE_DENIED_BUCKET_ACTIONS,
    ROLE_DENIED_OBJECT_ACTIONS,
    ROLE_OBJECT_ACTIONS,
    PolicyInputError,
    assert_enforceable,
    decide,
)

_spec = importlib.util.spec_from_file_location(
    "render_bucket_fence_policy", pathlib.Path(__file__).with_name("render-bucket-fence-policy.py")
)
assert _spec is not None and _spec.loader is not None
_fence = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_fence)

ALLOWED_ACTIONS: tuple[str, ...] = tuple(ROLE_OBJECT_ACTIONS[PUT_ONLY])


class BackupWorkerPolicyError(Exception):
    """The policy does not hold the worker's credential to put-only."""


def render_backup_worker_put_policy(
    *,
    bucket: str,
    project_id: str,
    worker_access_key: str,
    admin_access_key: str,
    drill_access_keys: tuple[str, ...] = (),
) -> dict:
    """The whole fence for the backup bucket, with the worker as its put-only key.

    Raises BackupWorkerPolicyError for any input the fence renderer refuses.
    """
    try:
        return _fence.render_policy(
            bucket, project_id, [], admin_access_key,
            writer_access_keys=[worker_access_key],
            reader_access_keys=list(drill_access_keys),
        )
    except PolicyInputError as error:
        raise BackupWorkerPolicyError(str(error)) from error


def _as_list(value) -> list:
    if value is None:
        return []
    return value if isinstance(value, list) else [value]


def _names(statement: dict, principal: str) -> bool:
    field = statement.get("Principal")
    return principal in _as_list(field.get("AWS") if isinstance(field, dict) else field)


def assert_explicit_allow_put_only(policy: dict, *, bucket: str, worker_principal: str) -> None:
    """Refuse a policy that does not hold `worker_principal` to put-only on `bucket`.

    Two halves, both required. The grant is an explicit Allow of exactly
    `ALLOWED_ACTIONS`, never a wildcard. And every other action is explicitly
    denied, evaluated through `decide()`: an allow-only document fences
    nothing on an engine whose project default grants every key everything.
    Raises BackupWorkerPolicyError.
    """
    statements = policy.get("Statement")
    if not isinstance(statements, list) or not statements:
        raise BackupWorkerPolicyError("policy carries no Statement, so nothing here is explicit")
    try:
        assert_enforceable(policy)
    except PolicyInputError as error:
        raise BackupWorkerPolicyError(str(error)) from error

    objects = f"arn:aws:s3:::{bucket}/"
    allows = [s for s in statements if s.get("Effect") == "Allow" and _names(s, worker_principal)]
    if not allows:
        raise BackupWorkerPolicyError(f"no Allow names {worker_principal!r}")
    for statement in allows:
        actions = _as_list(statement.get("Action"))
        if sorted(actions) != sorted(ALLOWED_ACTIONS):
            raise BackupWorkerPolicyError(
                f"the Allow naming {worker_principal!r} grants {actions!r}; it must grant "
                f"exactly {list(ALLOWED_ACTIONS)}"
            )
        resources = _as_list(statement.get("Resource"))
        if not resources or not all(
            isinstance(r, str) and r.startswith(objects) for r in resources
        ):
            raise BackupWorkerPolicyError(
                f"the Allow's Resource {resources!r} is not scoped under {objects!r}"
            )

    an_object = f"{objects}dumps/any-object"
    expectations = [(a, an_object, "allow") for a in ALLOWED_ACTIONS]
    expectations += [(a, an_object, "deny") for a in ROLE_DENIED_OBJECT_ACTIONS[PUT_ONLY]]
    expectations += [
        (a, f"arn:aws:s3:::{bucket}", "deny") for a in ROLE_DENIED_BUCKET_ACTIONS[PUT_ONLY]
    ]
    for action, resource, expected in expectations:
        got = decide(policy, worker_principal, action, resource)
        if got != expected:
            raise BackupWorkerPolicyError(
                f"under this policy {worker_principal!r} gets {got} for {action}; a put-only "
                f"key must get {expected}. An action no Deny names reaches the bucket through "
                f"the project default."
            )
