# Runbook — apply the four-rule media backup lifecycle, then retire the probe bucket

Closes two of branchLeft/workspace#1325's three remaining action items: applying
`db/provision/configure_backup_bucket.py`'s current four-prefix lifecycle
document to the production backup bucket, and deleting the throwaway bucket
the split probe was run against. The third item — recording the probe's PASS
in `14-hetzner-migration-programme.md` §16 — is a separate docs PR, not part
of this runbook.

---

## What is wrong / why now

`branchleft-db-backups` was fenced and given versioning + a lifecycle rule by
`RUNBOOK-bucket-fencing.md` before media backups existed. `configure_backup_bucket.py`
now renders **four** prefix-scoped lifecycle rules — the original `dumps/` and
`binlogs/` rules at 35 days, plus a new `media/` rule (1 day, with
`ExpiredObjectDeleteMarker`) and a new `fence-probe/` rule (1 day) — but that
document has never been *applied*. Until it is, the production bucket still
carries whatever lifecycle document the earlier run wrote, with no rule at all
for `media/`.

Rob ran `check-split` on 2026-09-27 against the throwaway bucket
`branchleft-lifecycle-probe-20260924` and it returned **PASS**
([branchLeft/workspace#1325, issuecomment-5859953732](https://github.com/branchLeft/workspace/issues/1325#issuecomment-5859953732)):
the `media/`-style short rule pruned its own noncurrent versions and delete
marker without touching the `dumps/`-style long rule's content, and Hetzner
honoured `ExpiredObjectDeleteMarker`. That was the last open question standing
between this document and the real bucket. Priority is High: media end-to-end
is explicitly in MVP scope (Rob's ruling, 2026-09-23 13:40 UTC), and no media
backup run may be scheduled (ghost-platform#249, C-refresh) until this lands.

---

## Blast radius

**Changes:** `branchleft-db-backups` gains two lifecycle rules it does not
currently have (`media/`, `fence-probe/`, both 1-day noncurrent expiry, the
`media/` one also carrying `ExpiredObjectDeleteMarker`). Nothing about
`dumps/` or `binlogs/`'s existing 35-day rule changes — `configure_backup_bucket.py`
renders them byte-for-byte the same as before.

**Does not change:** the bucket's fence (re-applied as part of this write, but
identical to what is already live — see step 3) and its versioning (already
`Enabled`, the PUT is a no-op). db1's nightly dump and binlog-ship pipeline
keeps running throughout; nothing here touches db1, and its credential never
had permission to write lifecycle configuration in the first place.

**Irreversible, in two different ways:**
- The lifecycle document itself is not irreversible — a lifecycle PUT simply
  replaces the document, and it can be re-rendered and re-applied if a number
  needs to change later.
- What the lifecycle rule *does*, once it fires, is: a noncurrent version or
  delete marker older than its rule's window is gone for good, on both the
  bucket this runbook touches and (already, today) on any bucket already
  running one. Nothing in this runbook accelerates that.
- Deleting `branchleft-lifecycle-probe-20260924` (section 2) is flatly
  irreversible — see that section.

---

## Before you start

- `branchleft-db-backups` is already fenced and versioned — confirmed by
  `RUNBOOK-bucket-fencing.md` §1e/§1f, already run. This runbook does **not**
  repeat section 0 or step 1c of that file: both test the account's policy
  engine, not this bucket, and both are already settled.
- A checkout of `branchLeft/ghost-platform` on `main` (current enough to
  contain the four-rule `lifecycle_document()` — check with `git log -1
  db/provision/configure_backup_bucket.py`; its docstring should mention
  "FOUR NON-OVERLAPPING PREFIX RULES").
- The **`fence-operator`** Object Storage credential (Hetzner Cloud Console,
  project `15766609`) — this write must run as the operator, because the
  fence already withholds `PutLifecycleConfiguration` from every other key in
  the project, db1's backup key included.
- The **`db-backups`** credential's access key **id** only (not its secret) —
  from `/etc/branchleft/db.env` on db1, the password manager, or Console
  credential `db-backups` directly. It is only used to name the workload in
  the re-rendered fence policy; the render is deterministic, so this
  reproduces the exact document already live.
- The AWS CLI, reachable as `aws`, for the read-back steps only —
  `configure_backup_bucket.py` itself signs its own requests.

---

## 1. Read the two credentials into the shell

Each block below is exactly one line and expects exactly one paste in
response before the next block is sent — a `read` sharing a block with
anything else risks the next block's first line being swallowed as the
value instead of running.

```bash
read -rs FENCE_OPERATOR_ACCESS_KEY_ID; export FENCE_OPERATOR_ACCESS_KEY_ID
```

```bash
read -rs FENCE_OPERATOR_SECRET_ACCESS_KEY; export FENCE_OPERATOR_SECRET_ACCESS_KEY
```

```bash
read -rs DB_BACKUPS_ACCESS_KEY_ID; export DB_BACKUPS_ACCESS_KEY_ID
```

Expected: no output from any of the three — a bare shell prompt back is the
pass condition.

---

## 2. Re-render the fence policy

From the `branchLeft/ghost-platform` checkout, on `main`:

```bash
python3 infra/provisioning/scripts/render-bucket-fence-policy.py \
  --bucket branchleft-db-backups \
  --project-id 15766609 \
  --workload-access-key "$DB_BACKUPS_ACCESS_KEY_ID" \
  --admin-access-key "$FENCE_OPERATOR_ACCESS_KEY_ID" \
  > /tmp/branchleft-db-backups-policy.json
```

Expected: no output, exit code 0. Given the same three inputs the render is
deterministic, so this reproduces the exact document `RUNBOOK-bucket-fencing.md`
already proved safe and already applied — step 3 is not writing a new fence,
only a new lifecycle document alongside the same one.

Read it before going on — it must be a JSON object with a top-level
`Statement` array naming `branchleft-db-backups` and no other bucket:

```bash
cat /tmp/branchleft-db-backups-policy.json
```

---

## 3. Apply — versioning (no-op), the new lifecycle document, the fence (no-op)

> **This pauses for close to two minutes between its two `put-bucket-policy`
> calls.** That is the lockout check working — Hetzner's policy-engine read
> path lags a write by up to 120 seconds, and the second PUT is the only
> signal that exists if the fence's own exemption ever stopped holding. Do
> not interrupt it; it prints progress to stderr while it waits.

```bash
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" \
  python3 db/provision/configure_backup_bucket.py \
  --bucket branchleft-db-backups \
  --endpoint hel1.your-objectstorage.com \
  --region hel1 \
  --policy-file /tmp/branchleft-db-backups-policy.json \
  --engine-diagnostic-passed
```

Expected: exit code 0, and a final line reading (values may wrap):

```
configure_backup_bucket: versioning enabled, 35-day noncurrent expiry set on dumps/ and binlogs/, 1-day noncurrent expiry set on media/ (with ExpiredObjectDeleteMarker) and fence-probe/, and the fence applied on branchleft-db-backups, then re-applied to prove the bucket is still administrable. ...
```

**If it exits non-zero on the second `put-bucket-policy`,** the bucket may be
locked. Do not close this terminal — go straight to `RUNBOOK-bucket-fencing.md`'s
"The lockout, and how to recover from one" section and follow it from there;
that file, not this one, owns the recovery procedure.

---

## 4. Verify — read the live lifecycle configuration back

The authoritative source is the bucket itself, not the script's exit code.

```bash
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=hel1 \
  aws --endpoint-url https://hel1.your-objectstorage.com s3api get-bucket-lifecycle-configuration \
  --bucket branchleft-db-backups
```

Expected: a `Rules` array with exactly these four entries, and nothing else:

| `ID` | `Filter.Prefix` | `NoncurrentVersionExpiration.NoncurrentDays` | Other |
|---|---|---|---|
| `branchleft-db-backups-dumps-noncurrent-expiry` | `dumps/` | 35 | — |
| `branchleft-db-backups-binlogs-noncurrent-expiry` | `binlogs/` | 35 | — |
| `branchleft-db-backups-media-noncurrent-expiry` | `media/` | 1 | `Expiration.ExpiredObjectDeleteMarker: true` |
| `branchleft-db-backups-fence-probe-noncurrent-expiry` | `fence-probe/` | 1 | — |

If any rule is missing, has a different prefix or day count, or the `media/`
rule lacks `ExpiredObjectDeleteMarker`, the PUT did not land as intended —
record the output verbatim and stop rather than re-running blind.

**What becomes true:** the production backup bucket now carries the same
lifecycle document already proven safe against a throwaway bucket
(issuecomment-5859953732) — media backup runs (ghost-platform#249) can be
scheduled once this step's read-back has passed.

Clear the shell:

```bash
unset FENCE_OPERATOR_ACCESS_KEY_ID FENCE_OPERATOR_SECRET_ACCESS_KEY DB_BACKUPS_ACCESS_KEY_ID
rm -f /tmp/branchleft-db-backups-policy.json
```

**Rollback:** none needed for this step in the ordinary sense — a lifecycle
document can be re-rendered and re-applied at will if a number turns out
wrong. There is no rollback for content a rule has already expired once its
window has passed, on this bucket or any other; nothing in this step shortens
any existing window.

---

## 5. Delete the throwaway probe bucket `branchleft-lifecycle-probe-20260924`

> **IRREVERSIBLE. This deletes a bucket and everything in it — every version,
> every delete marker — permanently.** There is no undo, no recycle bin, and
> no lifecycle rule protects it from a direct `delete-object` /
> `delete-bucket` call. Once this section's last command succeeds, the
> bucket and its contents cannot be recovered by any means available inside
> the Hetzner account.

It is safe to delete precisely because it is disposable by construction:
`probe-media-lifecycle-expiration.py` refuses to write anywhere that is not
prefixed `branchleft-lifecycle-probe-`, and this bucket has held nothing but
the `setup-split` canaries and their receipt since 2026-09-24. Its content is
already fully captured in issuecomment-5859953732 and — once the docs PR
lands — in `14-hetzner-migration-programme.md` §16.

### 5a. Read the credential that administers this bucket

The same one used to run `setup-split` / `check-split` — read fresh even if
it is still exported in your shell from that run, so this section does not
depend on state left over from a different one.

```bash
read -rs LAB_ACCESS_KEY_ID; export LAB_ACCESS_KEY_ID
```

```bash
read -rs LAB_SECRET_ACCESS_KEY; export LAB_SECRET_ACCESS_KEY
```

### 5b. Control — confirm the credential can see the bucket, and see only what the probe wrote

```bash
AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api list-object-versions --bucket branchleft-lifecycle-probe-20260924
```

Expected: a listing whose every `Key` is one of `media/control/canary`,
`media/noncurrent/canary`, `media/deleted/canary`, `dumps/control/canary`,
`dumps/noncurrent/canary`, `dumps/deleted/canary` — the six keys
`setup_prefix_split` writes, nothing else. **If any other key appears, stop
before deleting anything** — this bucket may hold something the probe did
not write, and the guard below only checks the bucket's name, not its
contents.

### 5c. Type the bucket name to confirm it, in its own line

Deliberately visible, not `-s`: the whole point of this step is that you see
what you typed before it is checked against the one bucket this section may
touch, so a typo is caught here rather than matched by the guard below.

```bash
read -r CONFIRM_BUCKET
```

Paste exactly: `branchleft-lifecycle-probe-20260924`

### 5d. The guarded delete — refuses on any mismatch, stops on any failure

One block, `&&`-chained throughout, so a failed guard or a failed delete
stops the sequence rather than letting a later command run against a bucket
in an unknown state.

```bash
set -o pipefail && \
[ "$CONFIRM_BUCKET" = "branchleft-lifecycle-probe-20260924" ] || { echo "REFUSING: typed name does not exactly match branchleft-lifecycle-probe-20260924 -- nothing touched" >&2; exit 1; } && \
AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api list-object-versions --bucket "$CONFIRM_BUCKET" --output text --query 'Versions[].[Key,VersionId]' | while read -r key vid; do AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api delete-object --bucket "$CONFIRM_BUCKET" --key "$key" --version-id "$vid" || exit 1; done && \
AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api list-object-versions --bucket "$CONFIRM_BUCKET" --output text --query 'DeleteMarkers[].[Key,VersionId]' | while read -r key vid; do AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api delete-object --bucket "$CONFIRM_BUCKET" --key "$key" --version-id "$vid" || exit 1; done && \
AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api delete-bucket --bucket "$CONFIRM_BUCKET"
```

Expected: the block ends silently and the exit code is 0 — every version and
delete marker removed, then the bucket itself removed. Any non-zero exit
means something stopped partway; re-run `5b`'s listing before trying again,
since a partially emptied bucket is a different state from the one this
block assumed.

### 5e. Verify — the bucket is actually gone

The control in 5b already proved this credential can reach the bucket, so a
denial here would mean something rather than nothing:

```bash
AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api head-bucket --bucket branchleft-lifecycle-probe-20260924
```

Expected: fails with `Not Found` (HTTP 404) — the bucket no longer exists.
A `403 Forbidden` instead means the bucket still exists and is merely
unreadable by this credential; that is not the same finding, and it does not
mean the delete succeeded — stop and check by hand rather than reading it as
"gone".

**Rollback:** none. A deleted bucket cannot be recreated with its history.
This is acceptable here because the bucket was created solely for this probe
and everything it demonstrated is already recorded on the issue and (once
the companion docs PR lands) in doc 14 §16.

Clear the shell:

```bash
unset LAB_ACCESS_KEY_ID LAB_SECRET_ACCESS_KEY CONFIRM_BUCKET
```

---

## After it succeeds

Close branchLeft/workspace#1325 through the `board` skill's decision-only-issue
path (no PR carries a `Closes` trailer here — this is a live console/CLI
change), citing:
- section 4's `get-bucket-lifecycle-configuration` output, showing all four
  rules live on `branchleft-db-backups`;
- section 5e's `404` on `branchleft-lifecycle-probe-20260924`;
- the docs PR recording the probe PASS in `14-hetzner-migration-programme.md`
  §16, once it has merged.

Never quote a secret value in the closing comment. Media backup runs
(ghost-platform#249) are unblocked once section 4 has passed — nothing else
in this runbook gates that.
