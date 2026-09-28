# render-bucket-fence-policy.py

The narrative behind `render-bucket-fence-policy.py`, moved out of the code. Each section is referenced from the line it explains.

## What the fence has to achieve

Render the fencing policy for one operational bucket, and the commands for it.

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

     KEYS HAVE ROLES (`bucketpolicy.ROLES`). `--workload-access-key` is
     read-write, as above. `--writer-access-key` is put-only: an explicit
     Allow of exactly `s3:PutObject`, and every other object action and every
     bucket read explicitly denied to it by name -- the pulling backup worker,
     which must be able to add a backup and never read, list or remove one.
     `--reader-access-key` is read-only: get and list, every mutation denied
     -- the restore drill. The narrow roles are fenced by Deny statements, not
     by absent Allows, because the project default grants every key
     everything; `assert_roles_hold()` evaluates each role both ways before a
     policy is emitted.

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

  4. No `NotAction` anywhere. This engine stores a `NotAction` statement and
     enforces none of it, so the bucket-configuration deny is an enumerated
     `Action` list (see "The bucket-configuration deny" below), and the
     stranger catch-alls use `Action: s3:*`.

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

## Operator-only object actions

Object actions withheld from the workload keys, operator only. Each one
defeats a layer that exists specifically to survive a compromise of the host
holding the workload credential: `DeleteObjectVersion` destroys a version
outright, where a plain `DeleteObject` on a versioned bucket only writes a
delete marker the operator can remove; the retention trio disarms any
object-lock policy; and `PutObjectAcl` publishes a single object without
touching the bucket ACL this policy guards. None of them is used by the
pipelines -- `prune_backups.py` issues a plain delete and relies on the
lifecycle rule for versions -- so withholding them costs nothing.

Enumerated rather than expressed as a `NotAction` catch-all, deliberately:
this statement NARROWS a fence that is already closed to everyone but the
named keys, so an action missing from the list falls back to that fence
rather than to Hetzner's project-wide default.

## The bucket-configuration deny

The operator alone keeps every bucket-configuration action.
An enumerated `Action` list. This statement used to carry a
`NotAction` catch-all, which this engine stores and does not
enforce: with it in place the workload key keeps the ability
to read this policy, rewrite it and change versioning, on a
bucket that reads as fenced. The catch-all property is lost;
`BUCKET_CONFIGURATION_ACTIONS` is kept wider than Hetzner's
supported set to buy some of it back.

Minus the workload's own bucket reads, so this narrows
nothing the pipelines already rely on: `ListBucketVersions`
is in both lists and stays with the workload.
