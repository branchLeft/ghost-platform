# backup_worker_policy.py

## Module overview

This property is load-bearing: the worker's put credential is an explicit
allow, never a deny-except. `configure_backup_bucket.py`'s
`assert_policy_fences_this_bucket` checks the OPERATOR's fence — a Deny
withholding bucket-configuration actions from every credential but the
operator's. This module checks the opposite side of the same bucket: the
WORKLOAD credential's own grant, which must say what it may do rather than
rely on Hetzner's (or an off-supplier's) project-wide default of "every key
reaches every bucket unless denied" — the same default
`configure_backup_bucket.py`'s own docstring names as the reason a bucket
left unfenced is wide open.

Scoped to `s3:PutObject` only: this worker writes backups, it never lists,
reads or deletes anything in the bucket it puts to (a separate,
narrower-still recovery-read credential lives with the drill runner per
the estate's own custody figure — "the recovery read credential is
separate and lives with the drill runner").

## assert_explicit_allow_put_only

Refuses anything but a policy that names `worker_principal` in an explicit
`Allow` statement granting exactly `ALLOWED_ACTIONS`, scoped under
`bucket`. Refuses, rather than passing silently, when:

  - the policy carries no Statement at all (an absent policy is Hetzner's
    project-wide default allow, not an explicit one);
  - any statement uses `NotAction`/`NotPrincipal` — the same construct
    `configure_backup_bucket.py`'s own fence check refuses, because this
    provider accepts and returns it byte-identical without enforcing it,
    so it grants or withholds nothing however complete it reads;
  - no statement names this principal at all;
  - the statement naming this principal is not `Effect: Allow`;
  - its `Action` is a wildcard, or grants anything beyond
    `ALLOWED_ACTIONS`, or does not grant all of it;
  - its `Resource` is not scoped under this bucket.
