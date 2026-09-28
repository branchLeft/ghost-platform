# configure_backup_bucket.py

## Overview

One-time setup of the backup bucket's versioning, lifecycle and fence.

Run once by the platform owner, right after creating the bucket
(`db/RUNBOOK-db.md`'s owner-only bucket step), from a workstation with the
**operator's** S3 credential in the environment — never db1's backup
credential, never from db1, and never by either automated pipeline:

```sh
AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
  configure_backup_bucket.py --bucket branchleft-db-backups \
  --endpoint hel1.your-objectstorage.com --region hel1 \
  --policy-file /tmp/branchleft-db-backups-policy.json
```

The policy is not optional and there is no flag to skip it. Hetzner's
documented default is that every key pair in a project is valid for every
bucket in that project, so a bucket configured without one is readable and
deletable by every credential in its project — including keys minted for
something else entirely, and keys that sit in CI. A bucket fenced later than
it is created has a window; a bucket that can be configured without being
fenced grows a second unfenced bucket the next time someone adds one. Render
the document with `infra/provisioning/scripts/render-bucket-fence-policy.py`
and see `RUNBOOK-bucket-fencing.md` for the ordering and the live
verification.

The credential in the environment must be the operator's because the fence
withholds every bucket-configuration action from db1's backup key: after
this runs, that key can no longer set versioning or lifecycle, which is the
point.

Object keys in this pipeline are already namespaced under MySQL's
`@@server_uuid` (`dump_nightly.py`, `ship_binlogs.py`), which is the primary
defence against a rebuilt db1 overwriting a pre-rebuild archive under a
reused name. Versioning is the second, independent layer required by the
backup design: a bug in the namespacing, a manually re-run dump under a
hand-typed key, or any other write this pipeline did not anticipate still
lands as a new version rather than destroying the object it replaces. The
lifecycle rule bounds how long an older, no-longer-current version survives —
`NoncurrentDays=35` comfortably outlives the 7-day on-host binlog retention
this stack otherwise relies on for recovery, without keeping every
overwritten version forever.

## Four non-overlapping prefix rules, not one bucket-wide rule

This bucket also holds
`infra/provisioning/scripts/media_backup_restore.py`'s generation-based
media backups, under `media/<tenant>/generations/<run id>/`, sharing the
bucket with `dump_nightly.py`'s `dumps/<server_uuid>/`, `ship_binlogs.py`'s
`binlogs/<server_uuid>/` objects, and `verify-bucket-fence.py`'s own
`fence-probe/` control objects. Every backup run deletes older generations
on completion, so `media/` needs its own SHORT noncurrent-version expiry —
the whole point of a short-lived undo window, not a 35-day one that would
leave many generations' worth of every tenant's media billable at once,
indefinitely; `fence-probe/` gets the same short window, since its objects
are throwaway verification writes with no retention argument of their own.
The four rules are scoped by `Filter/Prefix` so they never overlap: `dumps/`
and `binlogs/` keep the original `NoncurrentDays=35`, and `media/` and
`fence-probe/` each get their own short expiry (`--media-noncurrent-days`,
default 1, shared by both). Hetzner's behaviour with OVERLAPPING lifecycle
rules is unproven — see
`infra/provisioning/scripts/probe-media-lifecycle-expiration.py`'s
prefix-split mode — so this is deliberately four prefix-scoped rules, never
one broad rule plus a narrower one layered on top of the same keys.
`media/`'s own rule also carries `ExpiredObjectDeleteMarker`: every deletion
a backup run performs leaves a delete marker behind (a plain `DeleteObject`
on a versioned bucket, never a `DeleteObjectVersion` — see
`lifecycle_document`'s own docstring), and Hetzner's lifecycle how-to
documents this element as supported, so nothing here relies on
`NoncurrentVersionExpiration` alone to eventually clear a key with no
current version left.

## assert_policy_fences_this_bucket

Refuse a policy that names another bucket, locks out the caller, fences
nothing, or fences something other than what matters.

Applying a bucket policy is the one operation here that can be
irreversible. Every `Deny` in the policy governs the very API call that
would edit it, so a `Deny` covering the credential in this environment
leaves nobody able to replace or remove the statement doing the denying —
not another key in the project, which the same statement also denies, and
not `DeleteBucket`, which it denies too. Recovery is a support request
against the storage cluster, with the bucket unreachable meanwhile.

`operator_principal` is the caller's own full ARN, resolved from the live
API rather than assembled from an argument. Matching on the access key
alone would accept an ARN carrying the right key under the wrong account
id, which names a principal that does not exist — a `NotPrincipal`
exemption for nobody, and the one lockout no offline check can see, because
a rendered policy is self-consistent with whatever account id it was built
from.

Reaching a resource is not the same as withholding anything on it. A `Deny`
that reaches the bucket or object resource but is expressed with
`NotAction` fences nothing at all: Hetzner Object Storage accepts, stores
and returns that construct byte-identical to what was sent, and enforces
none of it. And a `Deny` expressed with `Action` still has to actually
cover `CRITICAL_BUCKET_CONFIGURATION_ACTIONS` / `CRITICAL_OBJECT_ACTIONS`
for its resource class — a narrowed list reads as a fence while leaving the
actions it omits to Hetzner's project-wide default, which is allow. Nor may
a `NotPrincipal` exemption name a principal this policy grants no `Allow`
for on the same resource: an exemption nothing else in the document
accounts for reaches this bucket only through that same project-wide
default, invisibly.

Anything this checker cannot bound is refused rather than passed. A `Deny`
with no `Resource`, or with neither `Principal` nor `NotPrincipal`, has a
scope that depends on how the engine reads an absent field, and "probably
fine" is not a basis for an irreversible write.

## lifecycle_document

Four prefix-scoped rules, never one bucket-wide rule — see "Four
non-overlapping prefix rules" above. `noncurrent_days` governs `dumps/` and
`binlogs/` (one rule each, so each carries its own `<ID>` and can be
reasoned about independently even though they share a value today);
`media_noncurrent_days` governs `media/` and `fence-probe/` (also
independent rules, sharing one value since neither has its own retention
argument). `Filter/Prefix` values share no common leading substring by
construction (`dumps/`, `binlogs/`, `media/`, `fence-probe/`), so no two of
these four rules can ever apply to the same key. Only `media/`'s rule
carries `ExpiredObjectDeleteMarker` — see the overview above for why.

## FENCE_ENGINE_DWELL_SECONDS

How long to hold between the fence policy's first PUT and its confirming
second one.

THIS IS NOT A MEASURED TTL — treat it as a floor, not a budget. The two live
measurements behind this figure bound the DELETE-side release at roughly
15-20 seconds (t+10 still denied, t+20 allowed), but the PUT-side sequence
never sampled between t+0 and t+90: the read taken immediately after the PUT
was already stale, and the next sample, at t+90, had already cleared. So the
write-visible-to-read window is bounded only by "cleared by t+90", not
measured down to a smaller figure — and every measurement was a GetObject
read decision, while this dwell guards a PutBucketPolicy authorisation
decision that has never been measured at all. Extrapolating from one to the
other on the path guarding the estate's only database backups is not a
place to assert a number the evidence does not carry, so this matches the
verifier's own `DWELL_SECONDS` rather than undercutting it.

## The fence-apply sequence (configure_backup_bucket)

The fence goes on LAST. It denies every bucket-configuration action to
every key but the operator's, so the versioning and lifecycle calls above
must already have landed rather than depend on that exemption holding. No
`content_md5`: `aws s3api put-bucket-policy` sends none either, and a header
this endpoint does not expect is one more thing that can be rejected on the
one call that must not fail halfway.

The apply happens twice, deliberately, and the second call is the control.
If this engine reads the policy's `NotPrincipal` as naming every principal
rather than exempting the one it lists, the first PUT succeeds and the
bucket is already unrecoverable — `PutBucketPolicy` and `DeleteBucket` both
denied by the statement that would have to be edited. The second PUT is a
no-op when the exemption works and the only signal that exists when it does
not. It lives here rather than only in the runbook because the operator
path for a rebuilt db1 (`db/RUNBOOK-db.md`) runs this script and stops.

THE SECOND PUT IS ONLY A CONTROL ONCE THE DWELL HAS RUN. Sent right after
the first, it is authorised against the same cached pre-PUT decision the
first PUT was — so it returns 2xx whether the lockout landed or not, and an
operator who reads that 2xx as confirmation walks away from a bucket that
locks itself out seconds later. `_await_engine_catchup` is what makes the
second PUT mean anything.

## The engine-diagnostic gate (main)

THIS SCRIPT IS A SECOND PATH TO AN APPLY, and the operator who reaches it is
rebuilding db1 from `db/RUNBOOK-db.md` and never opens
`RUNBOOK-bucket-fencing.md`. A fence that locks the operator out is
unrecoverable from inside the account — a support request against the
storage cluster, with the bucket unreachable meanwhile — so this script does
not let that shape ship on the strength of a rendered document alone. The
flag is a claim the operator makes, not a check this script can run: the
diagnostic needs three credentials and a bucket this script has no business
touching. It exists so that applying a fence is a decision, confirmed once
and deliberately, rather than the default.
