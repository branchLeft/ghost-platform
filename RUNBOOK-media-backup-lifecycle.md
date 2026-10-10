# Runbook — apply the backup bucket's lifecycle (db and media current-version expiry), prove it, retire the probe bucket

Target: bucket `branchleft-tenant-backups`, `fsn1`, Hetzner project `16139785`.
The earlier hel1 target was ruled out by the owner on 2026-09-29 (hel1 drops
about 27% of connections; every bucket leaves hel1), so nothing here touches
hel1 except the throwaway probe bucket in step 9 and its deletion in step 10.

## What is already true, and what this changes

- **Already live on `branchleft-tenant-backups`:** versioning, the four-rule
  lifecycle (35-day noncurrent expiry on `dumps/` and `binlogs/`, 1-day on
  `media/` and `fence-probe/`) and the role-aware fence, with the put-only
  writer key and the read-only drill key. The fence passed
  `probe-backup-role-fence.py` live (evidence on branchLeft/workspace#1550).
- **Why that is not enough:** the writer key is put-only, so nothing deletes.
  `prune_backups.py` cannot run against this bucket any more, and the rules
  above only age out *noncurrent* versions. Current `dumps/` and `binlogs/`
  objects were never removed, so the bucket grew without bound
  (branchLeft/workspace#1554).
- **What this applies:** the same lifecycle document with one more element on
  `dumps/` and `binlogs/`: `<Expiration><Days>10</Days></Expiration>`, the
  same 10 days `prune_backups.py` kept (7-day point-in-time window plus 3 days
  of margin). The put-only key never needs to delete.
- **The trade you are accepting:** `prune_backups.py` refused to drop the
  retained set below the 7-day window; a lifecycle rule cannot. The bucket is
  versioned, so a dump that expires is not destroyed: it stays as a noncurrent
  version for 35 days and can be restored with the read-only key. The real
  protection is the merged per-tenant 36-hour dump freshness alert.
- **Delete markers accumulate.** Each expiry leaves a zero-byte delete marker
  under `dumps/`, `binlogs/` and, after this change, `media/`. No rule carries
  `ExpiredObjectDeleteMarker`. They cost nothing but clutter listings; adding
  the element in a rule of its own is a separate change, once overlapping rules
  are proven on this engine.
- **Media, by the owner's ruling (branchLeft/workspace#1325):** the media backup job never
  deletes. Each run writes a new dated copy under
  `media/<tenant>/generations/<UTC run id>/` and the job keeps the put-only
  key. This applies the bucket's half: a current-version expiry on `media/`
  so old copies leave by themselves, in the same single rule as the
  1-day noncurrent expiry. The `media/` rule no longer carries
  `ExpiredObjectDeleteMarker`: a Days expiry cannot share an element with it,
  and a second rule on the same prefix is unproven on this engine. The cost is
  one zero-byte delete marker left per expired object, as on `dumps/`.
- **The retention figure is the owner's, and none is ruled.** Dated full copies
  cost the retention in days times the tenant's media size. The owner withdrew
  the earlier ten-day figure on cost, and the 1-day figure belonged to the
  design that deleted. Do not run step 5 until step 2b has a figure.

## Prerequisite

The owner has ruled a retention figure, in days, for dated media copies. If
not, stop here: step 5 would leave `media/` unbounded.

The per-tenant 36-hour dump freshness alert must be live on edge1 before, or
with, the worker writing to this bucket. Confirm it is firing-capable before
step 5; without it a stalled dump pipeline is silent until the 35-day
noncurrent tail runs out.

## 1. Confirm the checkout

From a checkout of `branchLeft/ghost-platform` on `main`, current enough that
`db/provision/configure_backup_bucket.py` accepts `--media-expiration-days`:

```bash
python3 db/provision/configure_backup_bucket.py --help | grep -c media-expiration-days
```

Expected: `2` (the usage line and the option line). Anything else means the checkout is stale: stop.

## 2. Read the credentials into the shell

One block, one paste each. The length echo catches a read that captured nothing.

```bash
read -rs PROBE_OPERATOR_ACCESS_KEY_ID; export PROBE_OPERATOR_ACCESS_KEY_ID; echo "${#PROBE_OPERATOR_ACCESS_KEY_ID} chars read"
```

```bash
read -rs PROBE_OPERATOR_SECRET_ACCESS_KEY; export PROBE_OPERATOR_SECRET_ACCESS_KEY; echo "${#PROBE_OPERATOR_SECRET_ACCESS_KEY} chars read"
```

```bash
read -rs PROBE_WRITER_ACCESS_KEY_ID; export PROBE_WRITER_ACCESS_KEY_ID; echo "${#PROBE_WRITER_ACCESS_KEY_ID} chars read"
```

```bash
read -rs PROBE_WRITER_SECRET_ACCESS_KEY; export PROBE_WRITER_SECRET_ACCESS_KEY; echo "${#PROBE_WRITER_SECRET_ACCESS_KEY} chars read"
```

```bash
read -rs PROBE_READER_ACCESS_KEY_ID; export PROBE_READER_ACCESS_KEY_ID; echo "${#PROBE_READER_ACCESS_KEY_ID} chars read"
```

```bash
read -rs PROBE_READER_SECRET_ACCESS_KEY; export PROBE_READER_SECRET_ACCESS_KEY; echo "${#PROBE_READER_SECRET_ACCESS_KEY} chars read"
```

The writer is the put-only backup key (the db-backups key, which media backups
also use per the owner's 2026-09-28 decision). The reader is the restore
drill's read-only key. Expected each time: a non-zero count.

### 2b. Read the media retention figure

Type the number of days the owner ruled (a whole number, 1 or more), then check
it echoed back as that number:

```bash
read -r MEDIA_RETENTION_DAYS; export MEDIA_RETENTION_DAYS; echo "media copies expire after $MEDIA_RETENTION_DAYS days"
```

## 3. Save the live lifecycle for rollback

```bash
ROLLBACK_DIR="$HOME/branchleft-runbook-backup-lifecycle-rollback"; mkdir -p "$ROLLBACK_DIR"; AWS_ACCESS_KEY_ID="$PROBE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$PROBE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=fsn1 aws --endpoint-url https://fsn1.your-objectstorage.com s3api get-bucket-lifecycle-configuration --bucket branchleft-tenant-backups | tee "$ROLLBACK_DIR/live-lifecycle.json"
```

Expected: four rules; `dumps/` and `binlogs/` show `NoncurrentVersionExpiration`
35 days and `Expiration.Days` 10 (already applied) or none; `media/` shows
`ExpiredObjectDeleteMarker`.

## 4. Render the fence policy

`configure_backup_bucket.py` always re-applies the fence, so render the same
role-aware one that is live:

```bash
POLICY_FILE=$(mktemp -t branchleft-tenant-backups-policy); python3 infra/provisioning/scripts/render-bucket-fence-policy.py --bucket branchleft-tenant-backups --project-id 16139785 --writer-access-key "$PROBE_WRITER_ACCESS_KEY_ID" --reader-access-key "$PROBE_READER_ACCESS_KEY_ID" --admin-access-key "$PROBE_OPERATOR_ACCESS_KEY_ID" --endpoint fsn1.your-objectstorage.com --region fsn1 > "$POLICY_FILE"; echo "exit $?"
```

Expected: `exit 0`. Compare it with the live policy; the expected result is no
difference at all, and any difference is a stop:

```bash
AWS_ACCESS_KEY_ID="$PROBE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$PROBE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=fsn1 aws --endpoint-url https://fsn1.your-objectstorage.com s3api get-bucket-policy --bucket branchleft-tenant-backups --query Policy --output text | python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin), sort_keys=True))' > /tmp/live-policy.norm; python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1])), sort_keys=True))' "$POLICY_FILE" > /tmp/new-policy.norm; diff /tmp/live-policy.norm /tmp/new-policy.norm && echo "policies identical"
```

## 5. Apply

Run as the operator. This pauses about two minutes between its two policy PUTs;
that pause is the lockout check, so do not interrupt it.

```bash
AWS_ACCESS_KEY_ID="$PROBE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$PROBE_OPERATOR_SECRET_ACCESS_KEY" python3 db/provision/configure_backup_bucket.py --bucket branchleft-tenant-backups --endpoint fsn1.your-objectstorage.com --region fsn1 --policy-file "$POLICY_FILE" --db-expiration-days 10 --media-expiration-days "$MEDIA_RETENTION_DAYS" --engine-diagnostic-passed
```

`--db-expiration-days 10` is explicit on purpose: without it the script writes no current-version expiry on `dumps/` and `binlogs/`.

Expected last line: `configure_backup_bucket: versioning enabled, 35-day noncurrent expiry and 10-day current-version expiry set on dumps/ and binlogs/, <MEDIA_RETENTION_DAYS>-day current-version expiry and 1-day noncurrent expiry set on media/, ...` with your number in place of `<MEDIA_RETENTION_DAYS>`.
If it says `NO current-version expiry` for `media/`, step 2b was skipped: stop.
An HTTP 503 on the policy PUT is a fence the engine could not store: stop and report it.

## 6. Read the lifecycle back

Policy and lifecycle changes cache for about 15 to 20 seconds; wait a minute first.

```bash
AWS_ACCESS_KEY_ID="$PROBE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$PROBE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=fsn1 aws --endpoint-url https://fsn1.your-objectstorage.com s3api get-bucket-lifecycle-configuration --bucket branchleft-tenant-backups
```

| Rule ID | Prefix | Noncurrent days | Expiration |
|---|---|---|---|
| `branchleft-db-backups-dumps-noncurrent-expiry` | `dumps/` | 35 | `Days: 10` |
| `branchleft-db-backups-binlogs-noncurrent-expiry` | `binlogs/` | 35 | `Days: 10` |
| `branchleft-db-backups-media-noncurrent-expiry` | `media/` | 1 | `Days:` your figure from step 2b |
| `branchleft-db-backups-fence-probe-noncurrent-expiry` | `fence-probe/` | 1 | none |

Any other shape, or any `ExpiredObjectDeleteMarker`: roll back (below) and report.

## 7. Re-run the fence probe

The re-applied fence is not proven until the probe passes again, after the cache window:

```bash
python3 infra/provisioning/scripts/probe-backup-role-fence.py --bucket branchleft-tenant-backups --endpoint https://fsn1.your-objectstorage.com --region fsn1
```

Expected last line: `RESULT: PASS -- every allow and every deny held, in both passes`.
The script reads the six `PROBE_*` variables read in step 2; see `probe-backup-role-fence.md`.

## 8. Read the probe bucket's lab credential

Steps 9 and 10 both need it:

```bash
read -rs LAB_ACCESS_KEY_ID; export LAB_ACCESS_KEY_ID; echo "${#LAB_ACCESS_KEY_ID} chars read"
```

```bash
read -rs LAB_SECRET_ACCESS_KEY; export LAB_SECRET_ACCESS_KEY; echo "${#LAB_SECRET_ACCESS_KEY} chars read"
```

---

## 9. Prove current-version expiry, and the media/ rule shape, on this engine

Hetzner honoured noncurrent expiry and `ExpiredObjectDeleteMarker` in the 2026-09-27
probe. Current-version `Expiration/Days` has not been proven, and neither has
the shape `media/` now has: ONE rule holding both `Expiration/Days` and
`NoncurrentVersionExpiration`, beside another prefix's Days rule and a control
rule. Current-version expiry is the one element here that deletes the only copy
of something, so prove it on the throwaway bucket (step 10 deletes it
afterwards), with the lab credential from step 8, not on the real one. The
bucket is in hel1, so retry any dropped connection.

The three probe prefixes share no leading text, and none of them is the real
bucket's `media/`, so the rule set mirrors the real one without overlapping
itself:

- `expiry-probe/`: a Days rule alone, as on `dumps/` and `binlogs/`.
- `media-probe/`: the `media/` shape, `Expiration/Days` 1 and `NoncurrentDays` 1 in one rule.
- `control-keep/`: a long noncurrent rule only, which must never act.

```bash
printf 'expiry probe\n' > "$HOME/expiry-probe-body.txt"; export AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1; aws --endpoint-url https://hel1.your-objectstorage.com s3api put-bucket-lifecycle-configuration --bucket branchleft-lifecycle-probe-20260924 --lifecycle-configuration '{"Rules":[{"ID":"expiry-probe","Status":"Enabled","Filter":{"Prefix":"expiry-probe/"},"Expiration":{"Days":1}},{"ID":"media-probe","Status":"Enabled","Filter":{"Prefix":"media-probe/"},"Expiration":{"Days":1},"NoncurrentVersionExpiration":{"NoncurrentDays":1}},{"ID":"keep-control","Status":"Enabled","Filter":{"Prefix":"control-keep/"},"NoncurrentVersionExpiration":{"NoncurrentDays":35}}]}'
```

The `media-probe/` canary is written twice, so it starts with one noncurrent
version as well as a current one, which is the state a real media copy reaches
once its expiry has acted:

```bash
for key in expiry-probe/canary media-probe/canary media-probe/canary control-keep/canary; do aws --endpoint-url https://hel1.your-objectstorage.com s3api put-object --bucket branchleft-lifecycle-probe-20260924 --key "$key" --body "$HOME/expiry-probe-body.txt"; done; date -u
```

This overwrites the lifecycle on the probe bucket, which is fine: it holds only
canaries and its earlier PASS is already recorded. Wait 72 hours, then check
with the versions listing, which cannot confuse a hidden object with a deleted one:

```bash
for prefix in expiry-probe/ media-probe/ control-keep/; do echo "== $prefix"; aws --endpoint-url https://hel1.your-objectstorage.com s3api list-object-versions --bucket branchleft-lifecycle-probe-20260924 --prefix "$prefix" --query '{versions: Versions[].[Key,IsLatest], markers: DeleteMarkers[].[Key,IsLatest]}'; done
```

Expected, per prefix:

| Prefix | Object versions | Delete markers |
|---|---|---|
| `expiry-probe/` | exactly one, `IsLatest` false | exactly one, `IsLatest` true |
| `media-probe/` | at 72 hours the first (overwritten) version is gone and the expired one may remain, `IsLatest` false; by 96 hours none | exactly one, `IsLatest` true (nothing here removes it, since no rule carries `ExpiredObjectDeleteMarker`) |
| `control-keep/` | exactly one, `IsLatest` true | none |

That is the PASS for `media-probe/`: the Days expiry acted on the current
version, the noncurrent expiry acted on the versions beneath it, and both ran
from one rule. A `media-probe/` listing with the current version still
`IsLatest` true after 96 hours means the combined rule is not honoured on this
engine. A `media-probe/` delete marker that is missing is not a failure, only a
note to send back: it means something cleaned it up. A listing for
`expiry-probe/` showing no versions at all would mean the object was truly
deleted, not expired by this rule: not a PASS. If either probe is still current
after 72 hours (the lifecycle pass can lag, so re-check at 72, and again at 96
for `media-probe/`, before concluding), or the control changed, **step 5 must
not stay applied**: roll back with the rollback below and report. Do the proof
before step 5 if you prefer to wait before touching the real bucket; the result
is required before media copies or dumps are relied on to age out.

Clear the shell:

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_DEFAULT_REGION; rm -f "$HOME/expiry-probe-body.txt"
```

## Rollback

Only the lifecycle document changes meaning here, and the fence is byte-identical.
To restore the saved lifecycle (needs the operator credential from step 2):

```bash
AWS_ACCESS_KEY_ID="$PROBE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$PROBE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=fsn1 aws --endpoint-url https://fsn1.your-objectstorage.com s3api put-bucket-lifecycle-configuration --bucket branchleft-tenant-backups --lifecycle-configuration "file://$ROLLBACK_DIR/live-lifecycle.json"
```

Objects already expired by the 10-day rule are not restored by this: they sit as
noncurrent versions for 35 days and can be copied back by version id until then.

## 10. Delete the throwaway probe bucket `branchleft-lifecycle-probe-20260924`

> **IRREVERSIBLE. This deletes a bucket and everything in it — every version,
> every delete marker — permanently.** There is no undo, no recycle bin, and
> no lifecycle rule protects it from a direct `delete-object` /
> `delete-bucket` call. Once this section's last command succeeds, the
> bucket and its contents cannot be recovered by any means available inside
> the Hetzner account.

It is safe to delete precisely because it is disposable by construction:
`probe-media-lifecycle-expiration.py` refuses to write anywhere that is not
prefixed `branchleft-lifecycle-probe-`, and this bucket holds nothing but
the `setup-split` canaries and their receipt. Its content is already fully
captured on the issue and — once the docs PR lands — in
`14-hetzner-migration-programme.md` §16.

**Run this section as the lab credential that created this bucket, never as `PROBE_OPERATOR_*`.** The typed name has to match exactly before anything is deleted, and `probe-media-lifecycle-expiration.py` only ever writes to buckets prefixed `branchleft-lifecycle-probe-`.

### 10a. Read the credential that administers this bucket

The same one used to run `setup-split` / `check-split` — read fresh even if
it is still exported in your shell from that run, so this section does not
depend on state left over from a different one.

```bash
read -rs LAB_ACCESS_KEY_ID; export LAB_ACCESS_KEY_ID; echo "${#LAB_ACCESS_KEY_ID} chars read"
```

```bash
read -rs LAB_SECRET_ACCESS_KEY; export LAB_SECRET_ACCESS_KEY; echo "${#LAB_SECRET_ACCESS_KEY} chars read"
```

### 10b. Control — confirm the credential can see the bucket, and see only what the probe wrote

```bash
AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api list-object-versions --bucket branchleft-lifecycle-probe-20260924
```

Expected: a listing whose every `Key` is one of `media/control/canary`,
`media/noncurrent/canary`, `media/deleted/canary`, `dumps/control/canary`,
`dumps/noncurrent/canary`, `dumps/deleted/canary` — the six keys
`setup_prefix_split` writes — plus the three keys step 9 writes,
`expiry-probe/canary` and `media-probe/canary` (each with a delete marker and
versions) and `control-keep/canary`, nothing else. **If any other key appears, stop
before deleting anything** — this bucket may hold something the probe did
not write, and the guard below only checks the bucket's name, not its
contents.

### 10c. Type the bucket name to confirm it, in its own line

Deliberately visible, not `-s`: the whole point of this step is that you see
what you typed before it is checked against the one bucket this section may
touch, so a typo is caught here rather than matched by the guard below.

```bash
read -r CONFIRM_BUCKET
```

Paste exactly: `branchleft-lifecycle-probe-20260924`

### 10d. The guarded delete — refuses on any mismatch, and stops on the first failure

The whole sequence runs inside `( … )` with `set -eo pipefail`, as a **plain
statement** — deliberately with no `&&` or `||` immediately after the
closing `)`. Both bash and zsh ignore `errexit` for everything inside a
subshell that is itself the left operand of `&&`/`||` (the earlier draft of
this step had exactly that shape, and it was inert — a failing command
inside it did not stop the sequence). Written as a plain statement instead,
`set -e` genuinely stops the subshell at the first failing command,
including one inside the `while` loop bodies. The one gap: neither shell
stops on a failing *listing* on the left of a pipe (the `s3api
list-object-versions` calls) — that stays safe here only because a failing
listing deletes nothing, so the final `delete-bucket` then fails on a
non-empty bucket and the sequence still reports failure rather than a false
`bucket deleted`.

```bash
(
  set -eo pipefail
  [ "$CONFIRM_BUCKET" = "branchleft-lifecycle-probe-20260924" ] || { echo "REFUSING: typed name does not exactly match branchleft-lifecycle-probe-20260924 -- nothing touched" >&2; exit 1; }
  AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api list-object-versions --bucket "$CONFIRM_BUCKET" --output text --query 'Versions[].[Key,VersionId]' |
  while read -r key vid; do
    [ "$key" = "None" ] && continue
    AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api delete-object --bucket "$CONFIRM_BUCKET" --key "$key" --version-id "$vid"
  done
  AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api list-object-versions --bucket "$CONFIRM_BUCKET" --output text --query 'DeleteMarkers[].[Key,VersionId]' |
  while read -r key vid; do
    [ "$key" = "None" ] && continue
    AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api delete-object --bucket "$CONFIRM_BUCKET" --key "$key" --version-id "$vid"
  done
  AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api delete-bucket --bucket "$CONFIRM_BUCKET"
  echo "bucket deleted"
)
DELETE_STATUS=$?
[ "$DELETE_STATUS" -eq 0 ] || echo "ABORTED before or during deletion (exit=$DELETE_STATUS) -- see the message above; your shell is unaffected. Re-run 10b before trying again, since a partially emptied bucket is a different state from the one this block assumed." >&2
```

Expected: prints `bucket deleted`. Any other outcome means something stopped
partway — re-run 10b's listing before trying again.

### 10e. Verify — the bucket is actually gone

`aws s3api` has been observed on this provider rendering a denial as an
uninformative error with no code, so a per-bucket `head-bucket` read is not
trusted here. `list-buckets` is: the call succeeding is its own control (the
credential still works), and the probe bucket's absence from the result is
the proof, with no per-bucket error to misclassify.

```bash
AWS_ACCESS_KEY_ID="$LAB_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$LAB_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api list-buckets --query 'Buckets[].Name' --output text
```

Expected: the call succeeds and prints a list of bucket names that does
**not** include `branchleft-lifecycle-probe-20260924`. If the call itself
fails, that says something about the credential, not the bucket — fix that
before drawing any conclusion from the list's contents. **If the name is
still listed,** re-read once after 60 seconds before re-running 10d — this
account's listings have been observed lagging a write briefly (see
`RUNBOOK-bucket-fencing.md`'s note on the read-path cache) — and only treat
it as a real leftover if it is still there after that wait.

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

Close nothing from here by hand. Cite on branchLeft/workspace#1554: step 6's
lifecycle read-back, step 7's PASS, and step 9's listings. Cite the same on
branchLeft/workspace#1325 together with step 10e's `list-buckets` output.

## What this does not unblock

The media backup job itself is now put-only and deletes nothing, but nothing
schedules it yet, and it must not be scheduled before:

1. the owner has ruled the media retention figure and step 5 has applied it;
2. step 9's `media-probe/` result is a PASS;
3. a restore drill with the read-only key has restored a real tenant's media
   from the newest complete copy, since the put-only job cannot read back what
   it wrote and the restore is where the bytes are proven.

The hel1 bucket this runbook originally named is out of scope; see the top.
