# Runbook — re-fence `branchleft-db-backups` and apply its four-rule lifecycle

Closes two of branchLeft/workspace#1325's three remaining action items:
applying `db/provision/configure_backup_bucket.py`'s current four-prefix
lifecycle document to the production backup bucket, and deleting the
throwaway bucket the split probe was run against. It also closes the
operational half of branchLeft/workspace#320, left open since 2026-08-28:
`branchleft-db-backups`'s live fence still uses a `NotAction` statement that
this engine does not enforce, so the workload key can currently read,
rewrite or delete that fence and change the bucket's versioning. The third
action item from #1325 — recording the probe PASS in
`14-hetzner-migration-programme.md` §16 — is a separate docs PR, not part of
this runbook.

---

## Open question for Rob — not settled anywhere on `main` or on an issue

**Which Console credential will media backups (ghost-platform#249,
`media_backup_restore.py`) authenticate as?** The code reads
`MEDIA_BACKUP_ACCESS_KEY_ID` / `MEDIA_BACKUP_SECRET_ACCESS_KEY`, but nothing
on `main` — no runbook, no Pulumi config, no issue — says which real Hetzner
credential that is. `media-backup-restore-proof.sh` only ever sets it to a
local MinIO test credential.

The fence this runbook applies names exactly one workload key,
`db-backups`. **If media backups are meant to share that key, say so and
this runbook will add nothing further — the existing `--workload-access-key
db-backups` already covers it. If media backups get their own key, it has
to be added as a second `--workload-access-key` before step 6 renders the
policy, or media backup runs will be denied `s3:*` outright the first time
they try to write.** Until this is answered, this runbook does **not** claim
to unblock ghost-platform#249 — see "After it succeeds" below.

---

## What is wrong / why now

- **The live fence predates the renderer it came from.** `branchleft-db-backups`
  was fenced on 2026-08-28 (workspace#286) by the `render-bucket-fence-policy.py`
  of that day, which built its bucket-configuration deny as a `NotAction`
  statement. workspace#320 proved on 2026-09-02 that this engine does not
  enforce `NotAction` at all — it is stored and does nothing. The renderer has
  since been corrected three times, all merged to `main`: #150 (2026-09-03,
  explicit `Action` lists), #171 (2026-09-04, `configure_backup_bucket.py`
  now refuses to emit or accept any `NotAction` statement), and #157
  (2026-09-10, fixed 12 action names this engine's parser was silently
  rejecting — the prerequisite workspace#320 named for re-fencing at all).
  **workspace#320 is still open**, waiting on exactly this operational
  re-fence. This runbook is that re-fence.
- **The live lifecycle is one whole-bucket rule, not the four-rule document.**
  The rule applied alongside that same 2026-08-28 fence (commit `8edfcfe`) is
  a single rule, `branchleft-db-backups-noncurrent-expiry`, `Filter/Prefix`
  empty, 35 days — it covers every object in the bucket, `media/` included,
  today. `configure_backup_bucket.py`'s `lifecycle_document()` has since
  grown to four prefix-scoped rules, but that document has never been
  applied to this bucket.
- **The split probe validated the document's mechanics, not this bucket.**
  Rob ran `check-split` on 2026-09-27 against the throwaway bucket
  `branchleft-lifecycle-probe-20260924` and it returned **PASS**
  ([branchLeft/workspace#1325, issuecomment-5859953732](https://github.com/branchLeft/workspace/issues/1325#issuecomment-5859953732)):
  the `media/`-style short rule pruned its own noncurrent content
  independently of the `dumps/`-style long rule, and Hetzner honoured
  `ExpiredObjectDeleteMarker`. That settled the open question about the
  document's *shape*. It touched neither the fence nor the lifecycle rule
  actually live on `branchleft-db-backups`.

Priority is High: media end-to-end is explicitly in MVP scope (Rob's ruling,
2026-09-23 13:40 UTC), and no media backup run may be scheduled
(ghost-platform#249, C-refresh) until the lifecycle document lands — separately
from the open credential question above.

---

## Blast radius

**The fence on `branchleft-db-backups` WILL change, and this is not a no-op.**
Step 6 replaces the live `NotAction`-based statement with an explicit
`Action`-list + `NotPrincipal` one. Step 4 below renders it and diffs it
against what step 3 reads live, specifically so this is seen before it is
applied rather than asserted.

**The lifecycle rule WILL change from one whole-bucket rule to four
prefix-scoped ones.** `dumps/` and `binlogs/` keep the same 35-day figure,
but as their own rules rather than as part of today's bucket-wide default;
`media/` and `fence-probe/` get a new 1-day rule. **Anything written under a
fifth prefix would silently lose its expiry entirely** — step 3 lists the
bucket's actual top-level prefixes before anything is written, specifically
to catch that before it happens rather than discover it later.

**Does not change:** db1's nightly dump and binlog-ship pipeline keeps
running throughout — its own object keys, under `dumps/` and `binlogs/`,
are the two prefixes whose rule content does not change. Step 7b proves this
with a live run, not an assumption.

**Irreversible, in four different ways:**
- **Step 6 puts the first *enforced* `Deny` on this bucket's own policy.**
  The 2026-08-28 statement was `NotAction`, and workspace#320 proved that
  construct inert — so nothing has actually withheld `PutBucketPolicy` from
  anyone on this bucket, ever, until step 6 runs. If the new statement's
  `NotPrincipal` exemption is wrong for any reason, the operator is locked
  out permanently: recovery is a Hetzner support request, with the backups
  unreachable meanwhile, and **not** the "Rollback" section below — a
  rollback PUT needs exactly the access a lockout removes. 1c's PASS on
  2026-08-28 and step 6's own dwelled double-PUT make this unlikely, not
  impossible. See "Before you start" for what to have ready.
- Short of a lockout, the fence and lifecycle documents themselves are
  recoverable — each is a PUT that replaces what was there, and step 3
  saves the current ones precisely so "Rollback" below can put them back.
- **Two lifecycle windows genuinely shorten.** Every noncurrent version
  under `media/` and `fence-probe/` is on today's whole-bucket 35-day clock;
  after step 6, both prefixes are on a 1-day clock instead (`media/` also
  gains `ExpiredObjectDeleteMarker`). At the first lifecycle pass after the
  PUT, anything under those prefixes whose noncurrent version is already
  more than a day old is deleted for good — this is a real, immediate
  effect of step 6, not a hypothetical one. Step 3's listing shows whether
  `media/` currently holds anything; `fence-probe/` is expected to hold only
  verifier debris.
- Deleting `branchleft-lifecycle-probe-20260924` (section 9) is flatly
  irreversible — see that section.

---

## Before you start

**Have this ready in case step 6 locks the bucket** (see "Blast radius"
above — unlikely, given 1c's PASS, but this is the first time an enforced
Deny governs this bucket's own policy, so it is possible for the first
time). `RUNBOOK-bucket-fencing.md`'s "The lockout, and how to recover from
one" is the only recovery path; it is a Hetzner support request, not
anything runnable from this terminal:
- The bucket name (`branchleft-db-backups`) and project id (`p15766609`).
- The exact wording that runbook gives: *"Object Storage bucket
  `branchleft-db-backups` in project p15766609 carries a bucket policy that
  denies `s3:PutBucketPolicy` to every principal including the bucket
  owner. Please remove the bucket policy from this bucket."*
- The Hetzner Cloud Console open to Support → New request
  (<https://console.hetzner.com>).
- This run's terminal output from step 4 (the diff) and step 6, to attach —
  it is the fastest way to show Hetzner support what was sent.

- A checkout of `branchLeft/ghost-platform` on `main`, current enough to
  contain the four-rule `lifecycle_document()` and the `PARSER_REJECTS`
  guard in `bucketpolicy.py` (both merged; #157 was the last of the three,
  2026-09-10).
- `branchleft-db-backups` is already versioned (2026-08-28) — that PUT stays
  a no-op. It is **not** already fenced with the corrected document, and its
  lifecycle rule is **not** already the four-rule one — see "What is wrong"
  above.
- Section 0 and step 1c of `RUNBOOK-bucket-fencing.md` are **not** repeated
  here: both test the account's policy engine (whether a `Deny` separates
  two keys at all, and whether `NotPrincipal` exempts), which is a property
  of the account, not of this bucket, and both were already settled on
  2026-08-28 (workspace#286).
- Three credentials, all Hetzner Console, project `15766609`:
  - **`fence-operator`** — this write must run as the operator throughout.
  - **`db-backups`** — id and secret. The id names the workload in the
    rendered policy; the secret is needed for step 7a's verify, which logs
    in as the workload to prove it can still read/write/list/delete.
  - **`tenant-state`** — id and secret, needed only for step 7a, as the
    foreign key whose *denial* proves the fence discriminates.
- The AWS CLI, reachable as `aws`, for every read-back and the rollback.
  `configure_backup_bucket.py` and `verify-bucket-fence.py` sign their own
  writes and denial probes; `aws s3api` is used here only for plain reads
  and for the two rollback PUTs, neither of which needs to classify a
  denial.

---

## 1. Confirm the checkout

```bash
cd ~/branchLeft/ghost-platform && git switch main && git pull --ff-only
```

Expected: `Already up to date.` or a fast-forward summary, exit code 0.

---

## 2. Read the three credentials into the shell

Each block is exactly one line and expects exactly one paste in response
before the next block is sent — combining a `read` with anything else risks
the next block's first line being swallowed as the value instead of running.
The length echo is the one check that catches a `read -rs -p` that silently
captured nothing.

```bash
read -rs FENCE_OPERATOR_ACCESS_KEY_ID; export FENCE_OPERATOR_ACCESS_KEY_ID; echo "${#FENCE_OPERATOR_ACCESS_KEY_ID} chars read"
```

```bash
read -rs FENCE_OPERATOR_SECRET_ACCESS_KEY; export FENCE_OPERATOR_SECRET_ACCESS_KEY; echo "${#FENCE_OPERATOR_SECRET_ACCESS_KEY} chars read"
```

```bash
read -rs FENCE_WORKLOAD_ACCESS_KEY_ID; export FENCE_WORKLOAD_ACCESS_KEY_ID; echo "${#FENCE_WORKLOAD_ACCESS_KEY_ID} chars read"
```

```bash
read -rs FENCE_WORKLOAD_SECRET_ACCESS_KEY; export FENCE_WORKLOAD_SECRET_ACCESS_KEY; echo "${#FENCE_WORKLOAD_SECRET_ACCESS_KEY} chars read"
```

```bash
read -rs FENCE_FOREIGN_ACCESS_KEY_ID; export FENCE_FOREIGN_ACCESS_KEY_ID; echo "${#FENCE_FOREIGN_ACCESS_KEY_ID} chars read"
```

```bash
read -rs FENCE_FOREIGN_SECRET_ACCESS_KEY; export FENCE_FOREIGN_SECRET_ACCESS_KEY; echo "${#FENCE_FOREIGN_SECRET_ACCESS_KEY} chars read"
```

Expected each time: a non-zero character count. Zero means the read captured
nothing — re-run that one block before going on.

---

## 3. Save the live policy and lifecycle, and list what the bucket actually holds

This is the rollback copy, taken before anything is written, and the check
that catches a prefix this document does not know about.

```bash
SAVED_POLICY_FILE=$(mktemp -t branchleft-db-backups-live-policy)
echo "Saved live policy to: $SAVED_POLICY_FILE"
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api get-bucket-policy --bucket branchleft-db-backups --query Policy --output text > "$SAVED_POLICY_FILE" && cat "$SAVED_POLICY_FILE"
```

**Write down the printed path.** If the terminal is lost later — plausible
on the lockout path above — `$SAVED_POLICY_FILE` dies with it, and the path
is the only way to find the file again.

Expected: the live policy JSON, printed. Read it now — its bucket-configuration
`Deny` statement is expected to carry `NotAction`, per workspace#320 and the
2026-08-28 apply. **If it does not contain `NotAction` anywhere, this bucket
has already been re-fenced by someone else since — stop and find out when
and by whom before going any further, because step 4's diff assumes this
starting point.**

```bash
SAVED_LIFECYCLE_FILE=$(mktemp -t branchleft-db-backups-live-lifecycle)
echo "Saved live lifecycle to: $SAVED_LIFECYCLE_FILE"
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api get-bucket-lifecycle-configuration --bucket branchleft-db-backups | tee "$SAVED_LIFECYCLE_FILE"
```

Expected: one rule, `branchleft-db-backups-noncurrent-expiry`, `Filter.Prefix`
empty, `NoncurrentDays: 35`, `Status: Enabled` — the whole-bucket rule from
`8edfcfe`. **If it already shows four prefix-scoped rules, this write has
already happened — stop, do not run step 6 again.** Write down the printed
path, for the same reason as `$SAVED_POLICY_FILE` above.

**This has to see noncurrent versions and delete markers, not only current
objects.** A prefix whose objects were all later deleted or overwritten
holds nothing but noncurrent versions and delete markers — exactly what
today's whole-bucket rule expires and what a new document that omits that
prefix would stop expiring — and a current-objects-only listing
(`list-objects-v2`) would never show it. `list-object-versions` covers both,
and also lists root-level keys (no `/` at all) directly rather than folding
them into a prefix:

```bash
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api list-object-versions --bucket branchleft-db-backups --delimiter / --query '[CommonPrefixes[].Prefix, Versions[].Key, DeleteMarkers[].Key]' --output text
```

Expected: three groups of output. The first (`CommonPrefixes`) is some
subset of `dumps/`, `binlogs/`, `media/`, `fence-probe/`, and nothing else —
those are the only prefixes the new lifecycle document covers. The second
and third (bare `Key`s under `Versions`/`DeleteMarkers`, from root-level
objects with no `/`) should print `None` — an empty group prints as the
literal word `None`, not as nothing at all, so `None` here means "no such
key", not an error. **If any other prefix appears in the first group, or
anything other than `None` appears in the second or third, stop.** Whether
to add a fifth rule or why that content does not need one is a decision for
Rob, not something to guess past; do not proceed to step 6 until it is
answered. **If `media/` appears in the first group:** step 6 will shorten
its noncurrent-version expiry from today's 35 days to 1 — see "Blast
radius" above for what that does at the next lifecycle pass.

---

## 4. Render the new fence policy and diff it against the live one

From the checkout, on `main`:

```bash
POLICY_FILE=$(mktemp -t branchleft-db-backups-new-policy)
python3 infra/provisioning/scripts/render-bucket-fence-policy.py \
  --bucket branchleft-db-backups \
  --project-id 15766609 \
  --workload-access-key "$FENCE_WORKLOAD_ACCESS_KEY_ID" \
  --admin-access-key "$FENCE_OPERATOR_ACCESS_KEY_ID" \
  > "$POLICY_FILE"
```

Expected: no output, exit code 0.

```bash
diff <(python3 -m json.tool "$SAVED_POLICY_FILE") <(python3 -m json.tool "$POLICY_FILE")
```

Expected: a **real diff**, not an empty one. At minimum, every `NotAction`
key on the live side is gone on the rendered side, replaced by an explicit
`Action` array plus a `NotPrincipal` naming the operator — this is exactly
what closes workspace#320's operational gap. **Read it before going on.**

- If the diff is **empty**: either this bucket was already re-fenced with
  the current renderer (stop; nothing to do), or the checkout in step 1 is
  stale and picked up the old renderer (check `git log`). Either way, do not
  proceed on an empty diff without knowing which.
- **State plainly to yourself here: the fence on `branchleft-db-backups`
  is about to change. Step 6 is not a no-op.**

---

## 5. §1c is not repeated

`NotPrincipal` exempting the operator is an account-wide engine property,
already confirmed PASS on 2026-08-28 (workspace#286) and unaffected by the
renderer fixes above — those changed which statements carry `NotAction` vs
`Action`, not how `NotPrincipal` itself is read. Re-testing it here would
tell you nothing you do not already know.

---

## 6. Apply — versioning (no-op), the new lifecycle document, the new fence

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
  --policy-file "$POLICY_FILE" \
  --engine-diagnostic-passed
```

Expected: exit code 0, and a final line reading (values may wrap):

```
configure_backup_bucket: versioning enabled, 35-day noncurrent expiry set on dumps/ and binlogs/, 1-day noncurrent expiry set on media/ (with ExpiredObjectDeleteMarker) and fence-probe/, and the fence applied on branchleft-db-backups, then re-applied to prove the bucket is still administrable. ...
```

**If it exits non-zero on the second `put-bucket-policy`,** the bucket may be
locked. Do not close this terminal — go straight to `RUNBOOK-bucket-fencing.md`'s
"The lockout, and how to recover from one" section and follow it from there;
that file, not this one, owns the recovery procedure, and "Rollback" below
does not apply to a locked bucket.

---

## 7. Verify — mandatory, not optional

The script's own success line says "The fence is not proven to FENCE anything
until `verify-bucket-fence.py` passes — run it now, from this terminal."
Steps 7a and 7b are that instruction, plus the pipeline check
`RUNBOOK-bucket-fencing.md` §1g requires after any fence change on this
bucket. **Do not treat step 8's lifecycle read-back as sufficient on its own
— it proves the lifecycle document, not that the fence still lets the real
pipeline work.**

### 7a. Both directions, against the live bucket (§1f)

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY

python3 infra/provisioning/scripts/verify-bucket-fence.py \
  --bucket branchleft-db-backups \
  --foreign-control-bucket branchleft-tenant-pulumi-state \
  --policy-file "$POLICY_FILE" \
  --versioning-already-enabled
```

Expected: every line `PASS`, exit code 0, including `the stored policy is the
one that was sent`. **Do not go on to step 7b or step 8 on anything less** —
read a `FAIL` or `INCONCLUSIVE` exactly as `RUNBOOK-bucket-fencing.md` §1f
describes (cited rather than re-derived here). Two rows route differently
from the rest, exactly as that file says:

- **`THE BUCKET IS STILL ADMINISTRABLE` — `FAIL`,** or the operator's own
  read in this step erroring rather than printing a clean result (for
  example `AccessDenied` reading the policy back as operator): this is the
  lockout described in "Blast radius" above. **Do not attempt "Rollback"
  below** — a rollback PUT uses this same operator credential, so it would
  be denied for the same reason. Go straight to "Before you start"'s Hetzner
  support request.
- **`the stored policy is the one that was sent` — `FAIL`:** the engine
  accepted and stored a different document than the one sent. Treat the
  bucket as unfenced and stop — go to "Rollback" below.
- **Any other `FAIL` or `INCONCLUSIVE`** (a foreign-key or workload-key
  check, world-readability): the operator remains administrable — step 6
  already proved that with its own dwelled second PUT — so this is a
  content problem, not a lockout. Go to "Rollback" below.

### 7b. Confirm db1's own pipeline still works (§1g)

`db1` has no public address; this goes through `edge1`, the same jump host
every other remote command in this repo uses.

```bash
EDGE1_IPV4=$(hcloud server describe edge1 -o json | python3 -c "import json, sys; print(json.load(sys.stdin)['public_net']['ipv4']['ip'])")
DB1_PRIVATE_IP=$(hcloud server describe db1 -o json | python3 -c "import json, sys; print(json.load(sys.stdin)['private_net'][0]['ip'])")
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@$EDGE1_IPV4"
ssh -i ~/.ssh/id_ed25519_hetzner -o ProxyCommand="$JUMP" root@"$DB1_PRIVATE_IP" '
  systemctl start branchleft-db-binlog-ship.service &&
  systemctl start branchleft-db-dump.service &&
  systemctl is-failed branchleft-db-binlog-ship.service branchleft-db-dump.service;
  journalctl -u branchleft-db-dump.service -n 20 --no-pager
'
```

Expected: both units report `inactive` from `is-failed` (a oneshot that
succeeded) and the dump log ends in a successful upload. **If either unit is
`failed`, go to "Rollback" below** — the new fence withheld something the
real pipeline needs, and that is exactly the failure scenario this step
exists to catch before it is discovered by someone needing a restore.

---

## 8. Verify — read the live lifecycle configuration back

The authoritative source is the bucket itself, not step 6's exit code.

```bash
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" \
AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" \
AWS_DEFAULT_REGION=hel1 \
  aws --endpoint-url https://hel1.your-objectstorage.com s3api get-bucket-lifecycle-configuration \
  --bucket branchleft-db-backups
```

Expected: a `Rules` array with exactly these four entries, and nothing else:

| `ID` | `Filter.Prefix` | `NoncurrentVersionExpiration.NoncurrentDays` | `Status` | Other |
|---|---|---|---|---|
| `branchleft-db-backups-dumps-noncurrent-expiry` | `dumps/` | 35 | `Enabled` | — |
| `branchleft-db-backups-binlogs-noncurrent-expiry` | `binlogs/` | 35 | `Enabled` | — |
| `branchleft-db-backups-media-noncurrent-expiry` | `media/` | 1 | `Enabled` | `Expiration.ExpiredObjectDeleteMarker: true` |
| `branchleft-db-backups-fence-probe-noncurrent-expiry` | `fence-probe/` | 1 | `Enabled` | — |

If any rule is missing, has a different prefix, day count or `Status`, or the
`media/` rule lacks `ExpiredObjectDeleteMarker`, the PUT did not land as
intended. Before concluding that, re-read once more after 60 seconds — a
read taken too soon after the PUT can still reflect the prior document. If
it still does not match, record the output verbatim and stop rather than
re-running blind.

Clear the shell:

```bash
unset FENCE_OPERATOR_ACCESS_KEY_ID FENCE_OPERATOR_SECRET_ACCESS_KEY FENCE_WORKLOAD_ACCESS_KEY_ID FENCE_WORKLOAD_SECRET_ACCESS_KEY FENCE_FOREIGN_ACCESS_KEY_ID FENCE_FOREIGN_SECRET_ACCESS_KEY
rm -f "$POLICY_FILE" "$SAVED_POLICY_FILE" "$SAVED_LIFECYCLE_FILE"
```

(Skip the `rm` if step 7 or 6 sent you to "Rollback" below — the saved files
are what it uses.)

---

## Rollback — for steps 6 or 7 failing, when the operator is still administrable

**Do not use this for a lockout** (`THE BUCKET IS STILL ADMINISTRABLE — FAIL`,
or the operator's own read erroring) — go to "Before you start"'s Hetzner
support request instead; a rollback PUT needs exactly the access a lockout
removes.

**This re-exposes workspace#320's operational gap** — the restored fence is
the same `NotAction` one that does not withhold bucket-configuration access
from the workload key. Use it only for a content problem (step 7a `FAIL` on
a check other than administrability or the stored-policy match, or step 7b's
pipeline check failing), and re-open workspace#320 if you do.

**Before running the lifecycle PUT below, open `$SAVED_LIFECYCLE_FILE` and
read it.** It was captured by `get-bucket-lifecycle-configuration`, and that
call's JSON shape is not proven to round-trip into
`put-bucket-lifecycle-configuration` unchanged — a newer AWS CLI can add a
field (for example `TransitionDefaultMinimumObjectSize`) to the *get* output
that the *put* shape rejects. If the put below fails on an unrecognised
field, strip it from the saved file and retry.

```bash
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api put-bucket-policy --bucket branchleft-db-backups --policy "file://$SAVED_POLICY_FILE"
```

```bash
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api put-bucket-lifecycle-configuration --bucket branchleft-db-backups --lifecycle-configuration "file://$SAVED_LIFECYCLE_FILE"
```

Read both back to confirm the restore actually landed — do not trust either
PUT's exit code; `aws s3api` has been observed on this provider returning an
uninformative error on a denial, so a clean exit is not proof and neither is
a failure necessarily the whole story:

```bash
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api get-bucket-policy --bucket branchleft-db-backups --query Policy --output text
```

```bash
AWS_ACCESS_KEY_ID="$FENCE_OPERATOR_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$FENCE_OPERATOR_SECRET_ACCESS_KEY" AWS_DEFAULT_REGION=hel1 aws --endpoint-url https://hel1.your-objectstorage.com s3api get-bucket-lifecycle-configuration --bucket branchleft-db-backups
```

Both should match `$SAVED_POLICY_FILE` and `$SAVED_LIFECYCLE_FILE`. Once
confirmed, clear the shell as step 8 says.

**If a lockout happens later and Hetzner support removes the policy
entirely:** the bucket is then left with no fence at all, which is worse
than the inert `NotAction` one it had before. Re-PUT `$SAVED_POLICY_FILE`
(the command above) as soon as support confirms the removal, so the bucket
is not left open to every credential in the project while a proper fence is
worked out.

---

## 9. Delete the throwaway probe bucket `branchleft-lifecycle-probe-20260924`

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

**This section's name-guard is deliberately a second, independent layer on
top of the production fence above.** 9d runs as the lab/administrative
credential that created this bucket, and it must **never** run as
`FENCE_OPERATOR_*` or any credential named in section 2. Two layers have to
both be satisfied before anything is deleted: the typed name has to match
exactly, **and** the credential running the delete has to be one this
bucket's own guard (`PROBE_BUCKET_PREFIX`) and the production fence both
leave able to act on it. Once step 6 has run, the production fence denies
the lab credential `s3:*` on `branchleft-db-backups` outright — so even a
correctly-typed name would still be refused if 9a's credential were
mistakenly the operator's instead of the lab one.

### 9a. Read the credential that administers this bucket

The same one used to run `setup-split` / `check-split` — read fresh even if
it is still exported in your shell from that run, so this section does not
depend on state left over from a different one.

```bash
read -rs LAB_ACCESS_KEY_ID; export LAB_ACCESS_KEY_ID; echo "${#LAB_ACCESS_KEY_ID} chars read"
```

```bash
read -rs LAB_SECRET_ACCESS_KEY; export LAB_SECRET_ACCESS_KEY; echo "${#LAB_SECRET_ACCESS_KEY} chars read"
```

### 9b. Control — confirm the credential can see the bucket, and see only what the probe wrote

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

### 9c. Type the bucket name to confirm it, in its own line

Deliberately visible, not `-s`: the whole point of this step is that you see
what you typed before it is checked against the one bucket this section may
touch, so a typo is caught here rather than matched by the guard below.

```bash
read -r CONFIRM_BUCKET
```

Paste exactly: `branchleft-lifecycle-probe-20260924`

### 9d. The guarded delete — refuses on any mismatch, and stops on the first failure

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
[ "$DELETE_STATUS" -eq 0 ] || echo "ABORTED before or during deletion (exit=$DELETE_STATUS) -- see the message above; your shell is unaffected. Re-run 9b before trying again, since a partially emptied bucket is a different state from the one this block assumed." >&2
```

Expected: prints `bucket deleted`. Any other outcome means something stopped
partway — re-run 9b's listing before trying again.

### 9e. Verify — the bucket is actually gone

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
still listed,** re-read once after 60 seconds before re-running 9d — this
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

The lifecycle document is proven live once step 8 passes, and the fence is
proven live once step 7a passes — those two, together with step 7b, are what
close workspace#320's operational half and this runbook's share of
branchLeft/workspace#1325. The probe bucket's deletion is #1325's other
remaining action item, proven by step 9e.

**Media backup runs (ghost-platform#249) are not unblocked by this alone.**
The open question at the top of this file — which credential
`MEDIA_BACKUP_ACCESS_KEY_ID` actually is, and whether it needs adding to the
fence's `--workload-access-key` list — is still open. If it turns out to be
a new key, re-run steps 4–8 with both `--workload-access-key` values before
scheduling anything.

Close branchLeft/workspace#1325 through the `board` skill's decision-only-issue
path (no PR carries a `Closes` trailer here — this is a live console/CLI
change), citing:
- step 4's diff, showing the fence actually changed;
- step 7a and 7b's PASS output;
- step 8's `get-bucket-lifecycle-configuration` output, showing all four
  rules live;
- step 9e's `list-buckets` output, showing the probe bucket gone;
- the docs PR recording the probe PASS in `14-hetzner-migration-programme.md`
  §16, once it has merged.

Comment on workspace#320 citing step 4's diff and step 7a's PASS as the
operational close, separately from #1325.

Never quote a secret value in either closing comment.
