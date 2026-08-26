# Runbook — fencing an Object Storage bucket

Applying and proving a bucket policy that restricts a Hetzner Object Storage
bucket to the keys that legitimately use it.

**Read the lockout section before running anything.** A bucket policy is not a
configuration that a control reads — it *is* the control, and it governs the
API call that would edit it. A policy that fails to exempt the operator's own
key locks the bucket permanently, and there is no undo inside the account.

---

## Why this exists

Hetzner documents that each Object Storage key pair is automatically valid for
every bucket within the same project. An S3 `Allow` therefore narrows nothing,
and an unfenced bucket is readable, writable and deletable by every credential
in its project — including credentials minted for something else entirely, and
credentials that sit in CI or inside a tenant's own container. Only an explicit
bucket-policy `Deny` narrows a key.

These are the estate's operational buckets and the key each one exists for. A
bucket is fenced when its policy names those keys and denies everything else;
the procedure below is how that state is reached and confirmed.

| Bucket | Holds | Key that legitimately uses it |
|---|---|---|
| `branchleft-db-backups` | `age`-encrypted nightly dumps and shipped binlogs | db1's backup credential, from `/etc/branchleft/db.env` |
| `branchleft-tenant-pulumi-state` | every tenant's Pulumi checkpoint | `TENANT_STATE_S3_ACCESS_KEY_ID`, on the `tenant-provisioning` environment |

Section 1c and section 1f both read the live bucket, so the current state of any
bucket is something to check rather than something to read here.

---

## The lockout, and how to recover from one

Every `Deny` in a fence covers `PutBucketPolicy` and `DeleteBucketPolicy` on the
bucket, exempting the operator's key by `NotPrincipal`. If that exemption is
wrong — wrong key id, a key that was rotated, an engine that reads
`NotPrincipal` as naming everybody — then:

- **No other credential can repair it.** The same statement denies every other
  key in the project.
- **The bucket cannot be deleted either.** `DeleteBucket` is denied by the same
  statement.
- **Minting a new credential does not help.** A new key is a new principal that
  the policy also denies.

Recovery is a Hetzner support request to remove the bucket policy at the
storage cluster, and the bucket's contents are unreachable until it completes.
Open it at <https://console.hetzner.com> → Support → New request, against
project `15766609`, stating: *"Object Storage bucket `<bucket>` in project
p15766609 carries a bucket policy that denies `s3:PutBucketPolicy` to every
principal including the bucket owner. Please remove the bucket policy from this
bucket."*

**While a lockout on `branchleft-db-backups` lasts,** the estate's only
remaining recovery material is db1's local binlogs, which are retained for 7
days. Do not rebuild, resize or destroy db1.

**While a lockout on `branchleft-tenant-pulumi-state` lasts,** do not run
`provision-tenant.yml` and do not run `pulumi up` on any tenant stack: both
write to the checkpoint that is unreachable, and a write that half-succeeds is
worse than a blocked one.

Five things reduce the chance of ever getting here. The first is the only one
that tests the live engine rather than a model of it, which is why it runs
first and why nothing below substitutes for it.

1. **Step 1c asks the engine whether `NotPrincipal` exempts, reversibly.**
   Everything else here validates a document against an assumption about how
   S3 policies evaluate. Hetzner does not document that, and if its engine
   matches every principal instead of exempting the named one, then every check
   below passes and the fence still locks the bucket. Step 1c settles it with a
   policy that names no bucket-resource action, so it cannot lock anything, and
   removes it again.
2. `render-bucket-fence-policy.py` re-evaluates every policy it builds and
   refuses to emit one that denies the operator `PutBucketPolicy`.
3. **The pre-flight resolves the account from the credential itself.** Every
   principal in a rendered policy is built from the `--project-id` you typed, so
   the generator's own check compares a fabricated ARN against itself and passes
   for any value at all — while live, an ARN carrying the right access key under
   the wrong account names a principal that does not exist, the operator's
   exemption exempts nobody, and the bucket is gone. One mistyped digit is
   enough.
4. `configure_backup_bucket.py` re-checks the same invariant structurally,
   against the full ARN of the credential in the environment, before it sends
   anything — and refuses a policy that names another bucket, that opens the
   bucket to everyone, or that denies nothing at all.
5. **Every path that applies a fence PUTs the policy twice** — the two runbook
   sections, `configure_backup_bucket.py`, and
   `verify-bucket-fence.py --apply`. The second PUT is a no-op when the
   exemption works and the only warning that exists when it does not, so it
   belongs in the code rather than only in the prose: an operator who rebuilds
   db1 and follows `db/RUNBOOK-db.md` never reads this file.

---

## Order of work

**Fence `branchleft-db-backups` first, and only start the second bucket once
the first has passed verification.** Losing write access to Pulumi state is
worse than losing read access to `age`-encrypted backups: state is where every
tenant's infrastructure is described and where the production hcloud token
lives, and a locked state bucket blocks every tenant deploy. The backup bucket
is the cheaper place to discover that Hetzner's engine does not do what its
documentation implies.

Each bucket's workload key is the other bucket's foreign key, which is what
makes the verification controls work in both directions.

---

## The values you supply

Everything else below is filled in. These are access key **ids** and secrets —
never pasted into a file that gets committed.

| Placeholder | Where it comes from |
|---|---|
| `<operator key id>` | Hetzner Cloud Console → project `15766609` → Object Storage → Credentials. Must be a credential that is **not** either workload key. |
| `<operator secret>` | shown once when that credential was generated; from the password manager |
| `<db1 backup key id>` / `<db1 backup secret>` | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `/etc/branchleft/db.env` on db1, or the password manager |
| `<tenant-state key id>` / `<tenant-state secret>` | the values behind `TENANT_STATE_S3_ACCESS_KEY_ID` / `TENANT_STATE_S3_SECRET_ACCESS_KEY` on the `tenant-provisioning` environment; GitHub secrets are write-only, so read them from the password manager |

**If the operator key and a workload key are the same credential, stop.** The
fence would leave that workload able to rewrite the policy that constrains it,
which is most of what the fence withholds. Both generators refuse this. Mint a
distinct operator credential in the Console first.

`aws` CLI v2 must be on the workstation, and so must `curl` 7.75 or newer
(macOS 14 ships 8.4). Everything here goes to
`https://hel1.your-objectstorage.com`, region `hel1`, through `aws s3api` —
except the object-read probes, which `verify-bucket-fence.py` signs with
`curl --aws-sigv4`. Nothing you type changes.

**The `aws` CLI cannot read this backend's denials, and that limits what
section 1f can currently prove.** The storage engine returns its errors with an
empty `<Message></Message>`, and `aws s3api` v2 exits 255 with a
client-internal message rather than render that — on every operation, for
`AccessDenied` and `InvalidAccessKeyId` alike. The verifier is fail-safe about
it: a response it cannot read is `INCONCLUSIVE`, never a pass. But that means
**every denial probe still on the CLI reports `INCONCLUSIVE`**, so section 1f
will not reach exit code 0 until those probes move onto the signed transport
too. Step 1c is unaffected — its two decisive reads are object reads, and every
other call it makes is one that succeeds.

If `curl` is missing or too old, the object-read rows come back `INCONCLUSIVE`
naming the reason, and never as a pass. There is no pre-flight check for it, so
confirm it before step 1c rather than after:

```bash
curl --version | head -1
```

**Confirm the project id rather than trusting this document.** Every principal
in a rendered policy is built from it, and it is the one value whose being
wrong is unrecoverable. Run this first, as the operator, and use what it
prints:

```bash
AWS_ACCESS_KEY_ID='<operator key id>' AWS_SECRET_ACCESS_KEY='<operator secret>' \
AWS_DEFAULT_REGION=hel1 \
  aws --endpoint-url https://hel1.your-objectstorage.com s3api list-buckets \
  --query Owner.ID --output text
```

It must print `p15766609`. The `--project-id` argument below is that value
**without** the leading `p`. If it prints anything else, stop: the credential
is in a different project from the buckets, and every policy rendered from
`15766609` would name principals that do not exist there.

---

## 1. Fence `branchleft-db-backups`

From a checkout of `branchLeft/ghost-platform` on `main`.

### 1a. Render the policy

```bash
python3 infra/provisioning/scripts/render-bucket-fence-policy.py \
  --bucket branchleft-db-backups \
  --project-id 15766609 \
  --workload-access-key '<db1 backup key id>' \
  --admin-access-key '<operator key id>' \
  > /tmp/branchleft-db-backups-policy.json
```

The script exits non-zero and writes nothing usable if the policy it built
would deny the operator `PutBucketPolicy`. It cannot check the project id — that
is step 1d.

### 1b. Export the three credentials

Every step from here reads these. Nothing below sets `AWS_ACCESS_KEY_ID`
directly: each tool selects the credential for the role it is probing as, and
sets the region itself, so no step can silently run as whatever key was last
exported or fail on a missing region.

```bash
export FENCE_OPERATOR_ACCESS_KEY_ID='<operator key id>'
export FENCE_OPERATOR_SECRET_ACCESS_KEY='<operator secret>'
export FENCE_WORKLOAD_ACCESS_KEY_ID='<db1 backup key id>'
export FENCE_WORKLOAD_SECRET_ACCESS_KEY='<db1 backup secret>'
export FENCE_FOREIGN_ACCESS_KEY_ID='<tenant-state key id>'
export FENCE_FOREIGN_SECRET_ACCESS_KEY='<tenant-state secret>'
```

### 1c. Ask the engine whether `NotPrincipal` exempts — reversibly

**This is the step that stands between the model and the estate, and it is the
only reversible test of the assumption everything else rests on.** Hetzner does
not document how its engine evaluates `NotPrincipal`. If it matches every
principal rather than exempting the one named, then the real fence's
`DenyBucketConfigurationExceptOperator` denies the operator too — the apply
succeeds, and `branchleft-db-backups` is unrecoverable with `DeleteBucket`
denied by the same statement.

This applies a policy whose only `Deny` is scoped to the `fence-probe/` object
prefix and names no bucket-resource action at all, reads an object back as the
operator, and removes it again. It cannot lock anything: with no statement on
the bucket resource, `PutBucketPolicy` and `DeleteBucketPolicy` stay available
to every key throughout. The script asserts that property before it sends
anything.

```bash
python3 infra/provisioning/scripts/verify-bucket-fence.py --probe-notprincipal \
  --bucket branchleft-db-backups \
  --foreign-control-bucket branchleft-tenant-pulumi-state \
  --policy-file /tmp/branchleft-db-backups-policy.json
```

Both lines must read `PASS`.

- **`NotPrincipal EXEMPTS the named key` — `FAIL`.** Stop. This engine does not
  read `NotPrincipal` as an exemption, and applying the real fence would have
  locked the bucket permanently. Nothing has been applied. Record the output and
  hand it back: bucket policies cannot fence anything in this account, and the
  remaining boundary is separate Hetzner projects.
- **`NotPrincipal DENIES everyone else` — `FAIL`.** The statement is stored and
  not enforced. A fence built from it would fence nothing while every other
  signal said it had worked.
- **`the probe policy is accepted` — `INCONCLUSIVE`.** The engine rejected a
  `NotPrincipal` document outright. Nothing was applied.
- **`THE PROBE POLICY IS REMOVED` — `FAIL`.** The probe is still on the bucket.
  The message carries the exact command to remove it. It denies only reads under
  `fence-probe/`, so nothing real is affected, but do not leave it.

This tests the *engine*, not the bucket, so its answer holds for the whole
account — section 2 does not repeat it.

**The priced alternative, if you would rather not test this on a bucket holding
real backups:** create a throwaway bucket, run the probe against that, and
delete it. That is a new bucket and therefore recurring spend, however briefly,
so it is your decision and not one this runbook takes. The probe above is
designed to make it unnecessary.

### 1d. Pre-flight against the live credentials, before anything is written

This is the check that catches a wrong `--project-id`, and it is the only one
that can: it resolves each credential's own account and confirms the policy
names *those* principals. It writes nothing.

```bash
python3 infra/provisioning/scripts/verify-bucket-fence.py --preflight \
  --bucket branchleft-db-backups \
  --foreign-control-bucket branchleft-tenant-pulumi-state \
  --policy-file /tmp/branchleft-db-backups-policy.json
```

Every line must read `PASS` and the exit code must be 0. **If it prints `DO NOT
APPLY THIS POLICY`, do not apply it** — re-render step 1a with the account id
it printed and run the pre-flight again.

### 1e. Apply versioning, lifecycle and the fence, in that order

Run as the **operator**, not as db1's backup key. The fence withholds every
bucket-configuration action from db1's key, so after this runs that key can no
longer set versioning or lifecycle — which is the point, and which is why the
two configuration calls go on before the fence.

```bash
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" \
  python3 db/provision/configure_backup_bucket.py \
  --bucket branchleft-db-backups \
  --endpoint hel1.your-objectstorage.com \
  --region hel1 \
  --policy-file /tmp/branchleft-db-backups-policy.json
```

It refuses, before sending anything, if the policy names a different bucket, if
it would lock out the key in the environment, or if it fences nothing. It then
applies the policy **twice** — the second call is a no-op when the operator's
exemption works, and the only signal that exists when it does not. A non-zero
exit on the second PUT means the bucket is locked: go to "The lockout" above and
do not close this terminal.

### 1f. Verify both directions against the live bucket

`branchleft-tenant-pulumi-state` is still unfenced at this point, which is what
makes it a valid control bucket for the tenant-state key. The credentials are
already exported from step 1b.

`--versioning-already-enabled` is safe here and only here: step 1e enabled
versioning on this bucket, so the probe that tries to set it is a genuine
no-op. It is left off in section 2, where nothing has asserted that state.

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

python3 infra/provisioning/scripts/verify-bucket-fence.py \
  --bucket branchleft-db-backups \
  --foreign-control-bucket branchleft-tenant-pulumi-state \
  --policy-file /tmp/branchleft-db-backups-policy.json \
  --versioning-already-enabled
```

The target is every line `PASS` and exit code 0, and that includes
`the stored policy is the one that was sent` — the backend has previously
accepted a configuration and silently dropped part of it, and every other probe
would still pass on a bucket storing a different fence.

**It cannot reach that today.** Every denial probe here except
`foreign key cannot read an object` still runs through the `aws` CLI, which
cannot render this backend's `AccessDenied` at all (see "The values you supply"
above), so each of them reports `INCONCLUSIVE` on a bucket that is correctly
fenced. The verifier is behaving as designed — it refuses to call an unreadable
response a pass — but the run cannot be clean until those probes move onto the
signed transport. Until then this step proves the *allow* direction and the
object-read denial, and nothing more; treat the remaining denials as unproven
rather than as either passed or failed, and **do not proceed to section 2 on
the strength of it.**

- **`FAIL`** — the fence is not doing what it must. Do not proceed to the
  second bucket.
- **`INCONCLUSIVE`** — the probe proved nothing. It is **not** a pass:
  recording an inconclusive denial as proof is what produced this work in the
  first place. Distinguish the two causes from the reason printed beside it — a
  control probe on the same credential that did not succeed is something to fix
  and re-run; `no S3 error code in the CLI output` is the client limitation
  above and is not fixable from here.

### 1g. Confirm db1's own pipeline still works

The verifier proves the backup key can still put, get, list and delete against
the bucket. This proves the real pipeline does, end to end, with the real
object keys and the real encryption step. `<edge1-ipv4>` is edge1's public
address, from the Hetzner Cloud Console.

```bash
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@<edge1-ipv4>"
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@10.20.1.20 '
  systemctl start branchleft-db-binlog-ship.service &&
  systemctl start branchleft-db-dump.service &&
  systemctl is-failed branchleft-db-binlog-ship.service branchleft-db-dump.service;
  journalctl -u branchleft-db-dump.service -n 20 --no-pager
'
```

Both units must report `inactive` from `is-failed` (a oneshot that succeeded)
and the dump log must end in a successful upload.

Finally, clear the shell:

```bash
unset FENCE_OPERATOR_ACCESS_KEY_ID FENCE_OPERATOR_SECRET_ACCESS_KEY \
      FENCE_WORKLOAD_ACCESS_KEY_ID FENCE_WORKLOAD_SECRET_ACCESS_KEY \
      FENCE_FOREIGN_ACCESS_KEY_ID FENCE_FOREIGN_SECRET_ACCESS_KEY
rm -f /tmp/branchleft-db-backups-policy.json
```

---

## 2. Fence `branchleft-tenant-pulumi-state`

**Only after section 1 has passed in full.** This bucket has no
`configure_backup_bucket.py` equivalent, because it carries no lifecycle
policy of its own, so the commands are rendered directly.

### 2a. Render the policy and the sequence

```bash
python3 infra/provisioning/scripts/render-bucket-fence-policy.py \
  --bucket branchleft-tenant-pulumi-state \
  --project-id 15766609 \
  --workload-access-key '<tenant-state key id>' \
  --admin-access-key '<operator key id>' \
  > /tmp/branchleft-tenant-pulumi-state-policy.json

python3 infra/provisioning/scripts/render-bucket-fence-policy.py \
  --commands existing-bucket \
  --bucket branchleft-tenant-pulumi-state \
  --project-id 15766609 \
  --workload-access-key '<tenant-state key id>' \
  --admin-access-key '<operator key id>'
```

The second command prints the apply sequence with every value in place,
including the double `put-bucket-policy`. Read it before running it.

### 2b. Export the three credentials — the roles swap

db1's backup key is now the foreign key, and its control bucket is
`branchleft-db-backups`, which section 1 fenced and which names it.

```bash
export FENCE_OPERATOR_ACCESS_KEY_ID='<operator key id>'
export FENCE_OPERATOR_SECRET_ACCESS_KEY='<operator secret>'
export FENCE_WORKLOAD_ACCESS_KEY_ID='<tenant-state key id>'
export FENCE_WORKLOAD_SECRET_ACCESS_KEY='<tenant-state secret>'
export FENCE_FOREIGN_ACCESS_KEY_ID='<db1 backup key id>'
export FENCE_FOREIGN_SECRET_ACCESS_KEY='<db1 backup secret>'
```

Step 1c does not repeat here. It tests the engine's `NotPrincipal` semantics,
which is a property of the account rather than of a bucket, and section 1
settled it.

### 2c. Pre-flight and apply, in one command

**This bucket is the more dangerous of the two, so its apply gets the stronger
guard, not the weaker one.** `--apply` runs the pre-flight and the two policy
PUTs in a single process: the PUT is unreachable unless the pre-flight passed,
and the second PUT — the proof that the bucket is still administrable — cannot
be the step an operator skips because it sat below a scroll-back and two
credential blocks. It sets its own region and selects the operator credential
itself, so there is no exported `AWS_ACCESS_KEY_ID` to be stale and no
`NoRegionError` to be misread as a lockout.

```bash
python3 infra/provisioning/scripts/verify-bucket-fence.py --apply \
  --bucket branchleft-tenant-pulumi-state \
  --foreign-control-bucket branchleft-db-backups \
  --policy-file /tmp/branchleft-tenant-pulumi-state-policy.json
```

Every line `PASS`, exit code 0.

- **`DO NOT APPLY THIS POLICY`** — the pre-flight failed and nothing was
  written. Re-render 2a against the account id it printed.
- **`THE BUCKET IS STILL ADMINISTRABLE` — `FAIL`** — go to "The lockout" above
  and stay in this terminal.

### 2d. Verify both directions

No `--versioning-already-enabled` here: nothing in this repo enables or asserts
versioning on this bucket, and a probe that succeeded would turn it on. This
bucket has no lifecycle rule, so that would retain every overwritten checkpoint
indefinitely — storage growth caused by the verification rather than found by
it.

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

python3 infra/provisioning/scripts/verify-bucket-fence.py \
  --bucket branchleft-tenant-pulumi-state \
  --foreign-control-bucket branchleft-db-backups \
  --policy-file /tmp/branchleft-tenant-pulumi-state-policy.json
```

Every line `PASS`, exit code 0 — including `the stored policy is the one that
was sent`. The CLI limitation described under section 1f applies here
identically: the denial probes still on the `aws` CLI report `INCONCLUSIVE`
against a correctly fenced bucket, and section 1f is the gate for reaching this
step at all.

### 2e. Confirm CI still reaches its own state

The verifier proves the tenant-state key can put, read back, list and delete
objects in the bucket, which is the whole of what Pulumi's S3 backend does. The
end-to-end confirmation is a `pulumi preview` against a tenant stack, and it
runs at the next `provision-tenant.yml` dispatch — there is no tenant stack to
preview before then. Until that run has succeeded, treat CI's access as proven
by the verifier and not by production traffic.

**When a second key legitimately needs this bucket, re-fence it first.** Giving
each tenant its own state credential is planned work; on the day it lands,
every tenant key that is not named in this policy is denied by exactly the
statements that fence out a stranger, and every tenant deploy stops. Nothing
detects that in advance — the verifier proves the keys it is given still work,
never that no other key was fenced out. Re-render section 2a with the full list
of `--workload-access-key` values and re-apply before the new keys are used.

```bash
unset FENCE_OPERATOR_ACCESS_KEY_ID FENCE_OPERATOR_SECRET_ACCESS_KEY \
      FENCE_WORKLOAD_ACCESS_KEY_ID FENCE_WORKLOAD_SECRET_ACCESS_KEY \
      FENCE_FOREIGN_ACCESS_KEY_ID FENCE_FOREIGN_SECRET_ACCESS_KEY
rm -f /tmp/branchleft-tenant-pulumi-state-policy.json
```

---

## If Hetzner's engine does not do what its documentation implies

No policy of this shape has been observed working against a live Hetzner
bucket. Hetzner documents `NotPrincipal` verbatim but publishes no list of
supported Actions, Principal formats or Conditions, and says nothing about
`NotAction`. There are **four** ways it can go wrong. They are listed worst
first, because the worst one is the one you will be reading this under.

**1. `NotPrincipal` is enforced against everybody, including the operator.**
This is the one that ends the estate: the fence applies cleanly, and the bucket
is immediately unrecoverable — `PutBucketPolicy` denied to every key in the
project by the statement that would have to be edited, and `DeleteBucket`
denied by the same one. Recovery is a Hetzner support request and nothing else.

Step 1c exists to make this outcome unreachable. It asks exactly this question
with a policy that names no bucket-resource action, so the answer costs
nothing, and a `FAIL` there stops the sequence before any fence is applied. **If
you are reading this because step 2c, 1f or 2d reported `THE BUCKET IS STILL
ADMINISTRABLE — FAIL`, or because step 1e exited non-zero on its second
`put-bucket-policy`, then step 1c was skipped or its result was overridden.**
Go to "The lockout" above, open the support request, and do not touch the second
bucket.

**2. The PUT succeeds, the stored document matches, and the foreign probes
still succeed.** The engine stores `NotPrincipal` and does not enforce it at
all. Every signal except the probes says the bucket is fenced. Step 1c catches
this too, as `NotPrincipal DENIES everyone else — FAIL`, and section 1f catches
it after the fact. Bucket policies then cannot fence anything in this account,
and the remaining boundary is putting the buckets in separate Hetzner projects,
where the project boundary is enforced. That is a different decision with its
own migration and is not part of this work; file it and stop.

**3. The PUT succeeds but the stored document differs.** Reported by section 1f
or 2d as `the stored policy is the one that was sent — FAIL`. The engine
dropped an element. The fence is whatever was stored, not what was sent, so
treat the bucket as unfenced and stop.

**4. The PUT is rejected** — `MalformedPolicy`, `InvalidPolicyDocument`, or an
HTTP 400. The least bad outcome: nothing was applied and the bucket is exactly
as it was. Record the verbatim error. Do not retry with elements removed until
the call succeeds — a shape that gets accepted by deletion is a shape nobody has
reasoned about, and the most likely thing to drop first is the `NotAction`
catch-all that makes an unenumerated action fall closed.

---

## Adding a new operational bucket later

Fence it at creation, not afterwards. A bucket created unfenced is reachable by
every key in the project for as long as the gap lasts, and a bucket that *can*
be created without a fence is how the next unfenced bucket appears.

**Creating a bucket is recurring spend and is the platform owner's decision
alone.** The sequence below is rendered, never run by an agent.

```bash
python3 infra/provisioning/scripts/render-bucket-fence-policy.py \
  --commands new-bucket \
  --bucket <new bucket name> \
  --project-id 15766609 \
  --workload-access-key '<the key that will use it>' \
  --admin-access-key '<operator key id>'
```

That prints one sequence covering creation, versioning, the fence and the
double PUT. Apply it with `verify-bucket-fence.py --apply` rather than by hand,
so the pre-flight and the second PUT cannot be skipped, then verify it exactly
as section 1f does — with `branchleft-db-backups` as
`--foreign-control-bucket` and the db1 backup credential as the foreign role,
since that pair is fenced and proven and so its denials and its control both
mean something. Pass `--versioning-already-enabled`, because the rendered
sequence enables versioning before the fence. Step 1c is not repeated: it tests
the account's engine, not the bucket.

A tenant's media bucket is a different shape — public read on the object path,
append-only for the tenant — and is handled by
`infra/provisioning/scripts/render-media-bucket-policy.py` and
`RUNBOOK-tenant-onboarding.md` section 6.
