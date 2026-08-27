# Runbook — fencing an Object Storage bucket

Applying and proving a bucket policy that restricts a Hetzner Object Storage
bucket to the keys that legitimately use it.

---

## STOP — do not apply a fence from this runbook yet

**A bucket policy this repository wrote was accepted by the endpoint and then
enforced against nobody.** Its single statement was a `Deny s3:GetObject` under
the probe prefix, exempting the operator by `NotPrincipal`. The operator read
the object — and so did a key that statement should have denied. The `Deny`
reached neither of them.

**Whether a bucket policy can fence anything at all on this provider is
therefore an open question**, and until section 0 below has answered it, every
apply step in this runbook is a step that may write a control that controls
nothing. Sections 1e, 2c and "Adding a new operational bucket later" are gated
on it explicitly.

**Three other paths reach an apply, and only one of them is gated.**

- `db/RUNBOOK-db.md`'s "The backup bucket" step is gated, with the same gate.
  An operator rebuilding db1 follows that file and never opens this one.
- `db/provision/configure_backup_bucket.py` refuses to apply until it is told
  the diagnostic has run, and prints this file's section 0 when it refuses.
- **`RUNBOOK-tenant-onboarding.md`'s media-bucket policy is NOT gated.** It
  still walks an operator through applying a policy built on the same
  mechanism, and this runbook cannot gate a file it does not own without
  widening the change that carries it. Tracked on
  [branchLeft/workspace#292](https://github.com/branchLeft/workspace/issues/292),
  which also has to have its framing inverted: as filed it describes a lockout
  risk, and the live evidence points the opposite way — an applied policy that
  fences nothing while every signal says otherwise.

**A prior conclusion is withdrawn.** An earlier run of the same probe reported
`NotPrincipal EXEMPTS the named key — PASS`, and that was recorded — here, in
the doc set and in an operator handover — as proof that Hetzner honours
`NotPrincipal`. **It was never proof.** A statement the engine ignores
*entirely* produces exactly that observation: the operator's read succeeds
either way. Only the pair of reads discriminates, and the second half of the
pair could not be classified on that run. The probe was right to report
`INCONCLUSIVE`; reading the other row as an answer was the mistake, and
`--probe-notprincipal` no longer reports that row as a pass unless the foreign
key was actually denied.

**Nothing here is deleted, because the fencing procedure becomes correct again
under one of the possible answers.** If section 0 finds that this engine
resolves per-key principals and only `NotPrincipal` is unimplemented, a fence is
rebuildable out of explicit `Principal` denials and everything below applies to
it with the rendered documents changed. If it finds anything else, no bucket
policy can separate two credentials inside a Hetzner project, and the boundary
becomes a separate project — which is an architecture decision for the platform
owner, not a change to make in this file.

Tracked as branchLeft/workspace#301.

---

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

Section 0, section 1c and section 1f all read the live bucket, so the current
state of any bucket is something to check rather than something to read here.

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

Six things reduce the chance of ever getting here. The first two are the only
ones that test the live engine rather than a model of it, which is why they run
first and why nothing below substitutes for either.

1. **Section 0 asks what a bucket policy does on this engine at all,
   reversibly.** Whether one is enforced, and whether naming an access key in a
   statement separates that key from another one. Three of its five verdicts
   mean no fence can exist here by any document, and every check further down
   this file passes in all three.
2. **Step 1c asks the narrower question — does `NotPrincipal` exempt.**
   Everything else here validates a document against an assumption about how
   S3 policies evaluate. Hetzner does not document that, and if its engine
   matches every principal instead of exempting the named one, then every check
   below passes and the fence still locks the bucket. Step 1c settles it with a
   policy that names no bucket-resource action, so it cannot lock anything, and
   removes it again. Read its two rows as a pair: the operator's read succeeding
   on its own is consistent with a statement that was ignored entirely, and
   reading it otherwise is the withdrawn conclusion at the top of this file.
3. `render-bucket-fence-policy.py` re-evaluates every policy it builds and
   refuses to emit one that denies the operator `PutBucketPolicy`.
4. **The pre-flight resolves the account from the credential itself.** Every
   principal in a rendered policy is built from the `--project-id` you typed, so
   the generator's own check compares a fabricated ARN against itself and passes
   for any value at all — while live, an ARN carrying the right access key under
   the wrong account names a principal that does not exist, the operator's
   exemption exempts nobody, and the bucket is gone. One mistyped digit is
   enough.
5. `configure_backup_bucket.py` re-checks the same invariant structurally,
   against the full ARN of the credential in the environment, before it sends
   anything — and refuses a policy that names another bucket, that opens the
   bucket to everyone, or that denies nothing at all.
6. **Every path that applies a fence PUTs the policy twice** — the two runbook
   sections, `configure_backup_bucket.py`, and
   `verify-bucket-fence.py --apply`. The second PUT is a no-op when the
   exemption works and the only warning that exists when it does not, so it
   belongs in the code rather than only in the prose: an operator who rebuilds
   db1 and follows `db/RUNBOOK-db.md` never reads this file.

---

## Order of work

**Section 0 comes before everything, and nothing below it runs until it has
answered.** It asks whether a bucket policy on this engine does anything at all,
and three of its five possible answers mean no fence can be built here by any
document. Running section 1 first would apply a control whose effect is unknown
to the bucket holding the estate's only offsite backups.

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

Everything here goes to `https://hel1.your-objectstorage.com`, region `hel1`,
and nothing you type changes. **`python3` is the only tool the fencing and
verification steps need.** `verify-bucket-fence.py` and
`configure_backup_bucket.py` sign and send every request themselves, from the
standard library — no `aws` CLI, no `curl`, and no credential written to a
temporary file for either. The `aws` CLI is still what the rendered
`--commands` sequences print (section 2a, and "Adding a new operational bucket
later"), and creating a bucket is the one operation nothing here performs for
you.

**Why the verifier signs its own requests rather than shelling out to
`aws s3api`.** This backend's storage engine returns its error documents with
an empty `<Message></Message>`, and `aws s3api` v2 exits 255 printing a
client-internal message rather than render one — on every operation, for
`AccessDenied` and `InvalidAccessKeyId` alike. What renders is the gateway's
own `NoSuchBucket`, which carries a real message, which is why the failure
looked at first like one broken command. A client that cannot render a denial
cannot prove a fence: every denial probe running through it came back
`INCONCLUSIVE` — fail-safe, and useless as evidence. The verifier now reads
each verdict out of the returned document itself, and never out of the HTTP
status: `AccessDenied`, `InvalidAccessKeyId` and `SignatureDoesNotMatch` are
all 403 here, so a status-only reading would turn a dead credential into a
proven fence.

**Confirm the project id rather than trusting this document.** Every principal
in a rendered policy is built from it, and it is the one value whose being
wrong is unrecoverable. Run this first, and use what it prints:

```bash
FENCE_OPERATOR_ACCESS_KEY_ID='<operator key id>' \
FENCE_OPERATOR_SECRET_ACCESS_KEY='<operator secret>' \
  python3 infra/provisioning/scripts/verify-bucket-fence.py --show-account
```

It writes nothing, and it must print `PASS` with `p15766609` beside it. The
`--project-id` argument below is that value **without** the leading `p`. If it
prints anything else, stop: the credential is in a different project from the
buckets, and every policy rendered from `15766609` would name principals that
do not exist there.

Three answers that are not the project id, and what each means. None of them is
a statement about the buckets:

- **`InvalidAccessKeyId`** — the key id does not exist in this account. Re-read
  it from the Console.
- **`SignatureDoesNotMatch`** — the key id exists and the secret does not match
  it. Re-read the secret from the password manager; it is shown once at
  creation, so a stale copy is the usual cause.
- **`the endpoint saw this request as unsigned`** — a request went out with no
  `Authorization` header at all, which nothing here does; treat it as a bug
  rather than a credential problem and record the output. The check exists
  because this endpoint answers an unsigned `ListAllMyBuckets` with HTTP 200
  and an owner of `anonymous` rather than refusing, and `anonymous` is a
  principal that cannot exist — so it must never reach a rendered policy.

A missing or empty variable does not reach the endpoint at all: the script
exits 2 with `no credentials in the environment` before sending anything.

---

## 0. Settle what a bucket policy does on this engine

**This is the gate for the whole runbook. Nothing below it runs until it has
printed a verdict.** It asks the two questions everything else assumes the
answers to — is a bucket policy enforced here at all, and does naming one access
key in a statement separate that key from another one — and it answers them with
probes whose result only one engine could produce.

It is reversible by construction, and it is the same safety property as before:
each of its documents carries one `Deny`, on `s3:GetObject` only, confined to
the `fence-probe/` object prefix, and **no statement names the bucket
resource** — so `PutBucketPolicy` and `DeleteBucketPolicy` stay available to
every key throughout and no probe can lock a bucket. The script asserts that of
every document before it writes anything at all.

It sends up to four documents, each in its own window, and takes each one off
again before the next goes on. Three of them name a principal — the foreign
key, the operator, and a key that does not exist in an account that is not ours
— and it is the combination of what happens to the foreign key under those three
that decides the answer. **The fourth names every principal, including the
operator's, and is sent only in the one reading whose answer turns on it**: it is
the only document that denies the operator by construction, so it is not spent
for corroboration. When it is skipped the report says so.

> **Do not run this during a restore, a restore drill, or the nightly backup
> window.** The reversibility argument above assumes the engine honours
> `Resource`, and this engine's handling of `Principal` is the open question —
> so if `Resource` scoping is also ignored, then for the seconds each window is
> open a `Deny s3:GetObject` applies to **every object in the bucket**, for every
> key. Reads only, and removed either way. But a `mysqlbinlog` fetch or a
> `restore_drill` run in flight would fail while it lasts. Nothing in the tool
> can rule this out, because ruling it out is the same assumption.

It writes no fence, needs no rendered policy, and takes two credentials:

```bash
export FENCE_OPERATOR_ACCESS_KEY_ID='<operator key id>'
export FENCE_OPERATOR_SECRET_ACCESS_KEY='<operator secret>'
export FENCE_FOREIGN_ACCESS_KEY_ID='<tenant-state key id>'
export FENCE_FOREIGN_SECRET_ACCESS_KEY='<tenant-state secret>'

python3 infra/provisioning/scripts/verify-bucket-fence.py --diagnose-policy-engine \
  --bucket branchleft-db-backups
```

Add `--dry-run` to that command to print the three documents it would send,
sending nothing and reading no credential.

**Copy the whole output — the `RAW EVIDENCE` block included — onto
branchLeft/workspace#301.** Access key ids are printed by their last four
characters only, so the block names no identifier and is safe to paste
anywhere. This is a question about the account that gets asked once; the run
that is not recorded is a run that gets repeated against a production bucket.

The last block of the output is the verdict, in prose, and it says what to do
next. There are six, and they are not degrees of the same answer:

| Verdict | What it means | What happens next |
|---|---|---|
| `PER-KEY PRINCIPALS RESOLVE ON THIS ENGINE` | A `Deny` naming one key denied that key, left the other one reading, and a `Deny` naming a principal in another account denied nobody. | A fence is rebuildable — out of explicit `Principal` denials, which is **not** the document `render-bucket-fence-policy.py` emits today. Hand this back; do not apply the current fence. |
| `EVERY CREDENTIAL IN THIS PROJECT IS ONE PRINCIPAL` | A `Deny` naming **one** of this project's keys denied **both** of them, and one naming another account's principal denied neither. The name resolves — to the single storage user every key in the project shares. | No bucket policy separates two credentials inside one project, so neither the fence nor the tenant media policy protects anything. A principal deny **does** still discriminate across projects, so a project per tenant is the mechanism that remains — an architecture decision for the platform owner. |
| `THE PRINCIPAL ELEMENT IS DECORATION ON THIS ENGINE` | The subject key was denied whether the statement named it, named the other key, or named a principal in an account that is not ours. | No principal-based control works at any scope, so a project per tenant does not rescue this either. A fence aimed at a stranger takes the workload down with it. Do not apply any fence. |
| `A NAMED PRINCIPAL MATCHES NOBODY ON THIS ENGINE` | `Principal: "*"` denied the subject key, so policies are enforced — but **no** ARN denied anybody, including the ARN of the key doing the reading. | The ARN form this repo builds is not being resolved. Do not apply any fence. Worth one more experiment on the principal **spelling** before per-tenant projects are treated as the only option. |
| `BUCKET POLICIES ARE NOT ENFORCED ON THIS ACCOUNT` | Every `Deny` was stored verbatim and denied nobody — including one on `Principal: "*"`, which no principal semantics can read as excluding the caller. | Nothing a bucket policy says is enforced here. Do not apply any fence, and stop reading a successful `PutBucketPolicy` as evidence of anything. |
| `THIS ENGINE MATCHES THE COMPLEMENT OF THE PRINCIPAL IT IS GIVEN` | A `Deny` naming the subject key left **that** key reading, and denying anyone else denied it. | Not a documented S3 behaviour, and nothing may be built on it. Do not apply any policy to any bucket — a fence written against this reading inverts the day the engine is fixed. Record the output verbatim. |
| `NO SINGLE READING EXPLAINS WHAT THIS ENGINE DID` | The observations fit none of the above. | Nothing was applied. Record the evidence and stop — an engine answering incoherently is itself the finding, and guessing which world it is is the exact mistake this diagnostic exists to prevent. |

Rows that stop it before it reaches a verdict, and what each means:

- **`both keys read the probe objects with NO policy in force` — `INCONCLUSIVE`.**
  With nothing on the bucket, both keys must be able to read the objects the run
  just wrote. One of them could not, so a denial under a probe policy would be
  unattributable — the key, the object, the endpoint and the policy would be one
  observation, which is the substitution this whole tool exists to prevent.
  Nothing further was applied. Check the credentials and re-run.
- **`probe <A|B|C>: the bucket stores the document that was sent` — `FAIL` or
  `INCONCLUSIVE`.** The PUT returned 2xx and what came back off the bucket is
  not what went on it. This backend is on record accepting a configuration and
  silently dropping part of it, so no read taken under that document means
  anything. No verdict is reported and none should be inferred.
- **`the probe policy is accepted` — `INCONCLUSIVE`.** The engine rejected the
  document outright. Nothing was applied, and nothing was deleted either —
  deleting after a refused PUT would remove a policy this run never displaced.
- **`THE PROBE POLICY IS REMOVED (probe <A|B|C>)` — `FAIL`.** A probe document is
  still on the bucket and the run stopped there rather than putting another one
  on top of it. It denies only reads under `fence-probe/`, so nothing real is
  affected, but do not leave it: that row carries the exact command.
- **`THE PROBE POLICY'S FATE IS UNKNOWN` — `INCONCLUSIVE`.** The PUT got no
  response, so the document may or may not have reached the engine. Nothing was
  deleted, because a delete here removes whatever is on the bucket rather than
  only the probe. Check by hand before anything else; a policy whose `Id` is
  `engine-diagnostic-probe-branchleft-db-backups` is this probe and is safe to
  delete.
- **`both credentials are in one account` — `FAIL`.** The two keys are in
  different projects, so every denial below would be the project boundary rather
  than the policy. Nothing was written.
- **`the bucket carries no policy to displace` — `INCONCLUSIVE`.** Read it
  exactly as section 1c below says to. A leftover document from this diagnostic
  carries the `Id` above and is cleared by re-running with
  `--replace-existing-policy`; anything else is refused whether or not that flag
  is passed.

This tests the **engine**, not the bucket, so its answer holds for the whole
account: it is run once, against `branchleft-db-backups`, and section 2 does not
repeat it.

**Do not go past this section on anything but
`PER-KEY PRINCIPALS RESOLVE ON THIS ENGINE`** — and on that verdict the next
step is still not section 1: the fence this repository renders is built on
`NotPrincipal`, which the same finding says denies nobody, so it has to be
rebuilt out of explicit `Principal` denials first. Hand the output back.

---

## 1. Fence `branchleft-db-backups`

**Gated on section 0.** Every step from 1a on assumes a bucket policy can fence
one credential from another on this provider, which is the question section 0
answers and which is currently open.

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

Both lines must read `PASS`, **and neither one is an answer on its own.** The
first row reports `PASS` only when the operator's read succeeded *and* the
foreign key's read was denied. An operator allowed alongside a foreign key that
was also allowed is `INCONCLUSIVE` — because a statement the engine ignores
entirely produces that exact operator read, and reading it as an exemption is
the withdrawn conclusion at the top of this file.

- **`NotPrincipal EXEMPTS the named key` — `FAIL`.** Stop. This engine does not
  read `NotPrincipal` as an exemption, and applying the real fence would have
  locked the bucket permanently. Nothing has been applied. Record the output and
  hand it back: bucket policies cannot fence anything in this account, and the
  remaining boundary is separate Hetzner projects.
- **`NotPrincipal EXEMPTS the named key` — `INCONCLUSIVE`.** The operator's read
  succeeded and so did the foreign key's, so the statement reached nobody and
  this row cannot tell an exemption from an ignored statement. **This is what
  the live run produced.** Section 0 is what separates them.
- **`NotPrincipal DENIES everyone else` — `FAIL`.** The statement is stored and
  not enforced. A fence built from it would fence nothing while every other
  signal said it had worked. Which of the engines in section 0's table this is
  decides whether any fence is possible; run section 0 before concluding
  anything from it.
- **`the probe policy is accepted` — `INCONCLUSIVE`.** The engine rejected a
  `NotPrincipal` document outright. Nothing was applied.
- **`THE PROBE POLICY IS REMOVED` — `FAIL`.** The probe is still on the bucket.
  The message carries the exact command to remove it. It denies only reads under
  `fence-probe/`, so nothing real is affected, but do not leave it.
- **`the bucket carries no policy to displace` — `INCONCLUSIVE`.** The bucket
  already has a policy, and applying the probe would replace it. **Nothing
  restores a displaced document** — the probe is applied and then deleted, so
  whatever it replaced is gone and the bucket is left with no policy at all.
  The message says which policy it found, and there are only two cases:

  - **This step's own probe, left behind by an interrupted run.** It denies
    only reads under `fence-probe/` and constrains nothing else, so replacing
    it costs nothing. Re-run the command above with `--replace-existing-policy`
    added, and it is removed at the end of the run:

    ```bash
    python3 infra/provisioning/scripts/verify-bucket-fence.py --probe-notprincipal \
      --bucket branchleft-db-backups \
      --foreign-control-bucket branchleft-tenant-pulumi-state \
      --policy-file /tmp/branchleft-db-backups-policy.json \
      --replace-existing-policy
    ```

  - **Any other document.** Refused, and `--replace-existing-policy` does not
    override it — the flag cannot make the removal reversible. There is also
    nothing to learn: the engine question is a property of the account and this
    step settles it once, so a bucket that is already fenced does not need it.
    If you genuinely mean to run it here, remove that policy by hand first and
    keep a copy of it.

- **`the bucket's current policy is known` — `INCONCLUSIVE`.** The policy read
  did not succeed, so whether the bucket carries one is unknown. This step
  replaces whatever is there and removes it afterwards, so it will not run
  without an affirmative `NoSuchBucketPolicy` — an unreadable answer is not an
  empty bucket. Nothing was written. Re-run once the endpoint answers; if it
  keeps refusing the operator's `get-bucket-policy`, that refusal is itself the
  finding and the bucket is not in the state this section assumes.
- **`THE PROBE POLICY'S FATE IS UNKNOWN` — `INCONCLUSIVE`.** The PUT of the
  probe policy got no response, so it may or may not have reached the engine.
  Nothing was deleted, because a delete here removes whatever is on the bucket
  rather than only the probe. **Check by hand before doing anything else**, and
  a policy whose `Id` is `notprincipal-probe-branchleft-db-backups` is the
  probe and is safe to delete:

  ```bash
  AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" \
  AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" \
  AWS_DEFAULT_REGION=hel1 \
    aws --endpoint-url https://hel1.your-objectstorage.com s3api get-bucket-policy \
    --bucket branchleft-db-backups
  ```

This tests the *engine*, not the bucket, so its answer holds for the whole
account — section 2 does not repeat it. It asks a narrower question than section
0: only whether `NotPrincipal` behaves, which is what the fence this repository
renders today is built on. Section 0 asks whether any principal-based policy
behaves at all, and its answer is the one that decides whether a fence can exist
here in any form.

**The priced alternative, if you would rather not test this on a bucket holding
real backups:** create a throwaway bucket, run the probe against that, and
delete it. That is a new bucket and therefore recurring spend, however briefly,
so it is your decision and not one this runbook takes. The probe above is
designed to make it unnecessary.

### 1d. Pre-flight against the live credentials, before anything is written

This is the check that catches a wrong `--project-id`, and it is the only one
that can: it resolves each credential's own account, builds the ARN from it,
and then *evaluates* the policy against that ARN — asking whether the operator
can still replace the document and whether the workload can still put, get,
delete and list. It writes nothing.

It asks that as an evaluation rather than by reading `NotPrincipal` lists,
because a correct fence contains Deny statements that name only the operator:
`DenyObjectMutationsExceptOperator` withholds the version-destroying actions
from the workload deliberately. "This Deny does not name the workload" is the
fence doing its job, not a lockout.

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

> **GATE — this step writes the fence, and it does not run yet.** It is
> unreachable until section 0 has printed
> `PER-KEY PRINCIPALS RESOLVE ON THIS ENGINE` *and* the fence has been rebuilt
> out of explicit `Principal` denials, because the document
> `render-bucket-fence-policy.py` emits today fences by `NotPrincipal` and
> `NotPrincipal` was observed live denying nobody. On any other section 0
> verdict, no bucket policy can fence anything here and this step never runs at
> all. A green section 1c and a green 1d do **not** substitute: both validate a
> document against a model of S3 evaluation, and the question is what this
> engine does.

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

Every line must read `PASS` and the exit code must be 0, and that includes
`the stored policy is the one that was sent` — the backend has previously
accepted a configuration and silently dropped part of it, and every other probe
would still pass on a bucket storing a different fence. **Do not proceed to
section 2 on anything less.**

- **`FAIL`** — the fence is not doing what it must. Do not proceed to the
  second bucket.
- **`INCONCLUSIVE`** — the probe proved nothing. It is **not** a pass:
  recording an inconclusive denial as proof is what produced this work in the
  first place. The reason printed beside it says which of these it is:
  - *the control probe on the same credential did not succeed* — that key
    reaches nothing, so its denial here says nothing about the fence. Check the
    credential and the control bucket, then re-run.
  - *`InvalidAccessKeyId` / `SignatureDoesNotMatch`* — a wrong key id or a
    wrong secret. Not a statement about the policy.
  - *`<Code>: not a denial and not a success`* — the engine refused with a code
    this file does not classify. Every denial code it knows was captured from
    an *unsigned* request, so a refusal aimed at a live-but-fenced key could
    arrive as something else. **Record the code verbatim and hand it back**
    before re-running: it is a one-line addition to `DENIAL_CODES`, and
    guessing at it instead is how a code that is not a denial becomes one.
  - *`no S3 error document to read a code from`*, or *the request did not
    complete* — the response could not be interpreted, so no verdict exists.
    Re-run; if it persists, record the output verbatim and stop.

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

Neither section 0 nor step 1c repeats here. Both test the engine — what a bucket
policy does, and what `NotPrincipal` does — which is a property of the account
rather than of a bucket, and section 1 settled both.

### 2c. Pre-flight and apply, in one command

> **GATE — the same one as 1e, and this is the bucket where getting it wrong
> stops every tenant deploy.** This step does not run until section 0 has
> printed `PER-KEY PRINCIPALS RESOLVE ON THIS ENGINE`, the fence has been
> rebuilt out of explicit `Principal` denials, and section 1 has passed in full
> against the rebuilt document. On any other section 0 verdict this step never
> runs.

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
was sent`. Read an `INCONCLUSIVE` here exactly as section 1f says to, and note
that section 1f passing in full is the gate for reaching this step at all.

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

No policy of this shape has been observed working against a live Hetzner bucket,
and **one has been observed doing nothing at all** — see the finding at the top
of this file. Hetzner documents `NotPrincipal` verbatim but publishes no list of
supported Actions, Principal formats or Conditions, and says nothing about
`NotAction`. There are **four** ways it can go wrong. They are listed worst
first, because the worst one is the one you will be reading this under. Which of
them is live is what section 0 settles, and it is the only thing that does.

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
all. Every signal except the probes says the bucket is fenced. **This is the one
that has been observed live.** Step 1c catches it as `NotPrincipal DENIES
everyone else — FAIL`, and section 1f catches it after the fact — but neither
says *why*, and the two possible reasons have opposite consequences. If the
engine simply does not implement `NotPrincipal`, a fence is rebuildable out of
explicit `Principal` denials. If no named principal resolves at all, bucket
policies cannot fence anything in this account and the remaining boundary is
putting the buckets in separate Hetzner projects, where the project boundary is
enforced — a different decision with its own migration, which is not part of
this work. **Section 0 is what tells the two apart.** Do not decide it from a
step-1c FAIL.

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

**Gated on section 0, exactly as 1e and 2c are.** A bucket created with a policy
that fences nothing is an unfenced bucket that reads as fenced, which is worse
than one nobody claimed anything about.

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
