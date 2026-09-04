# Runbook — fencing an Object Storage bucket

Applying and proving a bucket policy that restricts a Hetzner Object Storage
bucket to the keys that legitimately use it.

---

**Read the lockout section before running anything.** A bucket policy is not a
configuration that a control reads — it *is* the control, and it governs the
API call that would edit it. A policy that fails to exempt the operator's own
key locks the bucket permanently, and there is no undo inside the account.

---

## The verification tooling's read path is cached — a stale `allowed` is not a fresh one

**On the one configuration measured, this engine enforces a bucket policy: a
single-statement `Deny s3:GetObject` with `Principal: "*"`, on one bucket, read
by a same-project (owner) credential.** An earlier run of this runbook's own
diagnostic read a just-applied `Deny` of that shape as reaching nobody, and
that was recorded — here, in the doc set, and in an operator handover — as
evidence that policies might be inert on this provider. **It was not evidence
of that.** It was evidence of a cache: this endpoint's `GetObject` decision for
that same request can lag a `PUT`/`DELETE` of the bucket policy, and every
probe in `verify-bucket-fence.py` used to take its confirming read inside that
window. Whether the same holds for a narrower `Deny`, a different `Principal`
shape, a different action, or a foreign-project reader is exactly what the
diagnostic modes below still have to settle -- this section is about the
tooling's own timing bug, not a claim that every policy shape on this engine
behaves identically.

Two manual measurements against production `branchleft-db-backups`, using
nothing but `curl --aws-sigv4` — no tooling from this repository involved —
demonstrate the cache on that one configuration:

- **A read taken before the policy exists poisons the window that follows.**
  Read the probe object with no policy on the bucket (`200`). `PUT` a `Deny
  s3:GetObject` naming everybody. Read immediately: `200` — the false result
  this file used to record. Read at t+90s: `403`. `DELETE` the policy;
  `NoSuchBucketPolicy` confirmed.
- **With no such prior read, enforcement is instant.** `PUT` the object, `PUT`
  the same `Deny`, read immediately: `403` at t+0s. `DELETE` the policy, then
  poll: t+0s `403`, t+10s `403`, t+20s `200`.

- **The PUT side, sampled properly.** A `--diagnose-policy-engine` run under
  the 120s dwell polls every 10s and records each attempt, so it measures the
  application lag directly rather than bracketing it. Two
  windows caught it: a `Deny` naming the foreign key was stored and then read
  `allowed` five times before answering `denied` at **t+50s**; a `Deny` naming
  the operator read `allowed` six times before answering `denied` at **t+60s**.

**Read the measurements for what each one actually bounds, not for one combined
figure.** The DELETE-side sequence (measurement 2) was sampled at t+10 and t+20,
so "roughly 15-20 seconds" is a real bound on how long a `denied` reading can
survive a policy's *removal*. **Applying** a policy is three to four times
slower: measurement 3 puts it at 50-60 seconds, and measurement 1's PUT side was
never sampled between t+0 and t+90 so it bounds nothing narrower.

**The two directions are not interchangeable, and the substitution is
expensive.** Carrying the DELETE-side figure over to the PUT side is where an
earlier draft of `db/provision/configure_backup_bucket.py` got its 30-second
dwell. At 30 seconds both denials in measurement 3 would still have read
`allowed` — so the double-PUT lockout guard on the estate's only database
backups would have returned a confident PASS on a bucket it could not have
detected the lockout of. It is 120s now, on both paths, for this reason.

Write-side propagation would have made the `DELETE` release access as fast as
the `PUT` denied it. It did not — the delay sits on the read path, in both
directions. Multiple gateways answer these requests (differing `HostId`
values), so which one serves a given read also matters; a single read is not a
reliable sample regardless of timing.

`verify-bucket-fence.py`'s three diagnostic modes (`--probe-notprincipal`,
`--diagnose-policy-engine`, `--probe-foreign-grant`) and its `--apply` mode now
hold a read that could still be explained by the state before the change — the
direction staleness always favours — for a full dwell (`--dwell-seconds`, 120s
by default) before drawing anything from it, and a read that could not be so
explained counts at once. **Any verdict this runbook or an operator handover
recorded before that fix landed was drawn from reads taken inside the cache
window and does not settle anything** — re-run the relevant step before
relying on it. `db/provision/configure_backup_bucket.py`'s confirming second
`put-bucket-policy` has the same fix, for the same reason: PUTting the policy
twice with no gap authorises the second PUT against the first PUT's own stale
decision, which is a false pass on the one control standing between an
operator and an unrecoverable lockout.

**The default verify mode (no mode flag, and `--preflight`) does not dwell,
and does not need to, given the ordering below.** `Verifier.check`/`run` take
a single, cached read each — there is no per-read hold in that code path.
`--preflight` is unaffected regardless: it resolves each credential's account
and evaluates the policy document on disk, locally, without reading the
bucket's live policy or any object under it at all, so there is no cache for
it to be stale against. The default mode's object reads (steps 1f, 2d, and
whatever runs after a bare `--apply`) genuinely do read the live bucket, and
would be exposed to the same cache as everything above -- **but every path
that reaches them applies the fence first, through either `--apply` or
`configure_backup_bucket.py`, and both of those now wait a full dwell between
their two PUTs before they exit.** That wait is what makes the default mode
safe to run immediately afterward: by construction, `--dwell-seconds` (or
`FENCE_ENGINE_DWELL_SECONDS`) has already elapsed since the fence was actually
written by the time either apply step prints its result. Do not run the
default verify mode against a fence applied any other way (a bare
`put-bucket-policy` from a second terminal, for instance) without waiting the
same margin by hand first.

**Step 1c's own confirming read holds too, and it is the least clear-cut case
in this file.** The operator's `allowed` is simultaneously the stale pre-change
answer (a read path still serving the no-policy state) and the expected
post-change one (a working `NotPrincipal` exemption) -- the two are
indistinguishable in a single read, so that reading is exactly the one that
must survive the full dwell before it counts. In the ordinary case, where the
exemption works, **step 1c takes close to the full `--dwell-seconds` (about
two minutes, by default) to return.** That is expected, not a hang -- do not
interrupt it. `--diagnose-policy-engine` can hold several readings back to
back this way and normally takes close to eight minutes; `--probe-foreign-grant`
normally takes close to four. Both print progress to stderr while they hold, on
an interactive terminal, so the wait is visible rather than silent.

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
| `branchleft-db-backups` | `age`-encrypted nightly dumps and shipped binlogs | Console credential `db-backups` (project `15766609`); db1 reads it from `/etc/branchleft/db.env` |
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

1. **Section 0 asks whether naming an access key in a statement separates that
   key from another one, reversibly.** Policies are enforced on this engine —
   see "The verification tooling's read path is cached" above — so this is not
   asking whether the engine exists; it is asking whether it discriminates
   between two credentials in the same project, which is the mechanism the
   fence depends on. Three of its five verdicts mean no fence can exist here by
   any document, and every check further down this file passes in all three.
2. **Step 1c asks the narrower question — does `NotPrincipal` exempt.**
   Everything else here validates a document against an assumption about how
   S3 policies evaluate. Hetzner does not document that, and if its engine
   matches every principal instead of exempting the named one, then every check
   below passes and the fence still locks the bucket. Step 1c settles it with a
   policy that names no bucket-resource action, so it cannot lock anything, and
   removes it again. Read its two rows as a pair: the operator's read succeeding
   on its own is consistent with a statement that was ignored entirely, and an
   earlier run that reported `NotPrincipal EXEMPTS the named key — PASS` from
   the operator's row alone, with the foreign key's row not classified, was
   withdrawn for exactly that reason. `--probe-notprincipal` no longer reports
   that row as a pass unless the foreign key was actually denied.
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
6. **Every path that applies a fence PUTs the policy twice, with a dwell in
   between.** The two runbook sections, `configure_backup_bucket.py`, and
   `verify-bucket-fence.py --apply` all wait past this engine's own read-path
   cache (see above) before the confirming PUT, so a green second PUT is
   authorised against the policy actually in force rather than against a
   cached pre-PUT decision. It is a no-op when the exemption works and the
   only warning that exists when it does not, so it belongs in the code rather
   than only in the prose: an operator who rebuilds db1 and follows
   `db/RUNBOOK-db.md` never reads this file.

---

## Order of work

**Section 0 comes before everything, and nothing below it runs until it has
answered.** It asks whether naming an access key in a `Deny` separates it from
another key in the bucket's own project, and three of its five possible
answers mean no fence can be built here by any document. Running section 1
first would apply a control whose discrimination is unproven to the bucket
holding the estate's only offsite backups.

**Section 0b is the other half of that question, and it gates nothing below it.**
It asks whether a policy reaches a principal *outside* the bucket's project, and
its answer decides the replacement architecture rather than any step in this
file — a working cross-project grant says nothing about fencing two keys inside
one project, which is what every apply step here does. Run it once, record the
output, and hand it back.

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

The four `FENCE_*` env vars name the ROLE a credential plays in a given probe,
not the credential itself, and two buckets swap which credential plays
`FENCE_WORKLOAD`/`FENCE_FOREIGN` between section 1 and section 2 (see 2b). Look
the credential up in the Hetzner Cloud Console **by the name in this table**,
not by the env var:

| Placeholder | Console credential | Console project | Where it comes from |
|---|---|---|---|
| `<operator key id>` / `<operator secret>` | `fence-operator` | `15766609` | Hetzner Cloud Console → project `15766609` (the project holding the buckets this runbook fences) → Object Storage → Credentials → `fence-operator`. Secret shown once at creation; from the password manager. Must be a credential that is **not** either workload key. |
| `<db-backups key id>` / `<db-backups secret>` | `db-backups` | `15766609` | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` in `/etc/branchleft/db.env` on db1, the password manager, or Console credential `db-backups` directly |
| `<tenant-state key id>` / `<tenant-state secret>` | `tenant-state` | `15766609` | the values behind `TENANT_STATE_S3_ACCESS_KEY_ID` / `TENANT_STATE_S3_SECRET_ACCESS_KEY` on the `tenant-provisioning` environment (GitHub secrets are write-only, so read them from the password manager), or Console credential `tenant-state` directly |
| `<pulumi-state key id>` / `<pulumi-state secret>` | `pulumi-state` | `15636438` ("branchLeft prod" — a **different** project from the other three) | password manager, or Console credential `pulumi-state` under project `15636438` |

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
printed a verdict.** Bucket policies on this engine are enforced — see "The
verification tooling's read path is cached" above — so this diagnostic is not
asking whether the engine exists. It asks the narrower, still-open question:
does naming one access key in a `Deny` separate that key from another one, or
does every key in the project answer as a single principal. Answering it takes
probes whose result only one engine behaviour could produce.

**If the last run of this step predates the read-path fix above, it has not
answered anything and must be re-run.** Before that fix, `--diagnose-policy-engine`
drew its verdict from a read taken seconds after the `Deny` was applied, with
no dwell to tell a genuine `allowed` apart from a stale one — exactly the
failure mode that produces `BUCKET POLICIES ARE NOT ENFORCED` and `THE
PRINCIPAL ELEMENT IS DECORATION` below from an engine that enforces both.

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
> so if `Resource` scoping is also ignored, then for as long as each window is
> open a `Deny s3:GetObject` applies to **every object in the bucket**, for
> every key. Reads only, and removed either way. But a `mysqlbinlog` fetch or a
> `restore_drill` run in flight would fail while it lasts. Nothing in the tool
> can rule this out, because ruling it out is the same assumption.
>
> **A window can now stay open for minutes, not seconds.** A confirming read
> that matches the pre-change answer is held for up to `--dwell-seconds` (120s
> by default) before the probe policy comes off, so a run that hits that case
> in every window can take close to eight minutes end to end. The tool prints
> progress to stderr while it holds, on an interactive terminal — a long
> silence during this run is not evidence of a hang, but it is still a longer
> exposure window than the seconds this used to take, and the restore
> constraint above scales with it.

It writes no fence, needs no rendered policy, and takes two credentials:

```bash
# FENCE_OPERATOR_* -- Console credential "fence-operator", project 15766609
# FENCE_FOREIGN_*  -- Console credential "tenant-state", project 15766609
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
| `BUCKET POLICIES ARE NOT ENFORCED AGAINST THIS PROJECT'S OWN KEYS` | Every `Deny` was stored verbatim and denied nobody — including one on `Principal: "*"`, which no principal semantics can read as excluding the caller. **Every reader in this mode is a key in the bucket's own project, so that is the whole of what it settles.** | No bucket policy separates two credentials inside one project. Do not apply any fence, and stop reading a successful `PutBucketPolicy` as evidence of anything. Then run **section 0b** — whether policies are evaluated for principals *outside* this project is a different question with a different answer, and this verdict does not touch it. |
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

This tests the **engine**, not the bucket, so its answer holds for every bucket
in this project: it is run once, against `branchleft-db-backups`, and section 2
does not repeat it.

**What it does not test, and cannot.** Every credential it signs with belongs to
the bucket's own project, so its strongest verdict is a statement about *this
project's own keys* and nothing wider. Section 0b asks the other half.

**Do not APPLY A FENCE — do not go on to section 1 — on anything but
`PER-KEY PRINCIPALS RESOLVE ON THIS ENGINE`**, and on that verdict the next step
is still not section 1: the fence this repository renders is built on
`NotPrincipal`, which the same finding says denies nobody, so it has to be
rebuilt out of explicit `Principal` denials first. Hand the output back.

**This stop is about applying a fence, not about stopping altogether.** Section
0b below is read-only and is the sanctioned next step after any verdict here that
is not `PER-KEY PRINCIPALS RESOLVE` — most of all after
`BUCKET POLICIES ARE NOT ENFORCED AGAINST THIS PROJECT'S OWN KEYS`, whose whole
point is that it has NOT settled the account-wide question. Run 0b, record its
output, and hand that back too.

---

## 0b. Settle whether a policy reaches a principal outside this project

**Section 0 answers what a bucket policy does to the keys in the bucket's own
project. This answers whether it does anything to a key outside it — and the two
answers are independent.** An engine that evaluates policies for foreign and
anonymous callers while bypassing evaluation for the bucket owner's own keys
produces section 0's loudest verdict word for word, so "no shape constrains our
keys" and "policies are off" are one observation from inside the project and two
different worlds outside it.

Hetzner's own documentation says the second world is the likely one, and both
pages are worth reading before the run:

- The [S3 credentials FAQ](https://docs.hetzner.com/storage/object-storage/faq/s3-credentials/)
  documents cross-project grants as a supported approach, with the note that in
  `arn:aws:iam:::user/p<project_id>:<access_key>` you *"Replace `<project_id>`
  with the ID of the project with your S3 credentials — not the project that
  contains your Buckets."* That is a documented feature no engine that ignored
  policies could offer.
- The [buckets & objects FAQ](https://docs.hetzner.com/storage/object-storage/faq/buckets-objects/)
  says a public bucket is one where *"we create and apply the access policies for
  you"*, granting anonymous read while *"file listing remains denied"* — a live
  policy evaluated for a principal that is not merely foreign but
  unauthenticated.

**Which world we are in decides the replacement architecture**, so this runs
before any decision about per-tenant isolation and before any media design.

### 0b-i. The grantee credential

The grantee is the Object Storage credential named **`pulumi-state`** in the
Hetzner Cloud Console, under project **`15636438`** ("branchLeft prod") — a
**different** project from the `15766609` that holds the buckets this runbook
fences, and from the `branchleft-tenant-pulumi-state` *bucket* section 2 fences
(a bucket name and a credential name that happen to echo each other, in
different projects). Read the secret from the password manager. There is zero
third-party exposure by construction: the key that gains access is ours.

Confirm it resolves to a different project before anything else. This writes
nothing:

```bash
FENCE_OPERATOR_ACCESS_KEY_ID='<operator key id>' \
FENCE_OPERATOR_SECRET_ACCESS_KEY='<operator secret>' \
FENCE_GRANTEE_ACCESS_KEY_ID='<pulumi-state key id>' \
FENCE_GRANTEE_SECRET_ACCESS_KEY='<pulumi-state secret>' \
  python3 infra/provisioning/scripts/verify-bucket-fence.py --show-account
```

The operator row must print `p15766609`. **The grantee row must print something
else.** If both print the same account, stop and find the right credential: a
grantee inside the bucket's own project re-creates the exact blind spot this
section exists to close, and the probe refuses to run on it — but finding that
out from `--show-account` costs nothing and finding it out from the probe costs a
round trip.

**Then confirm the grantee row against the Console.** The grantee's ARN is built
as `arn:aws:iam:::user/p<project_id>:<access_key>`, and the `<project_id>` is
read from the grantee's own `ListAllMyBuckets` owner id — which is *assumed* to
equal the Console project number, proven for the bucket project but not for this
one. Open the Hetzner Cloud Console, select the project that holds the grantee
credential, and confirm its project number matches the digits the grantee row
printed after the `p`. This one glance is the control for the whole run: if the
number is wrong, both windows will deny and the tool will read that as the
provider failing to honour its own documented grant, when the real cause is an
ARN that named a principal that does not exist. There is no way to check this
from inside the tool — the Console is the control.

### 0b-ii. The run

```bash
# FENCE_OPERATOR_* -- Console credential "fence-operator", project 15766609
# FENCE_GRANTEE_*  -- Console credential "pulumi-state", project 15636438
#                     ("branchLeft prod" -- a DIFFERENT project from the one above)
export FENCE_OPERATOR_ACCESS_KEY_ID='<operator key id>'
export FENCE_OPERATOR_SECRET_ACCESS_KEY='<operator secret>'
export FENCE_GRANTEE_ACCESS_KEY_ID='<pulumi-state key id>'
export FENCE_GRANTEE_SECRET_ACCESS_KEY='<pulumi-state secret>'

python3 infra/provisioning/scripts/verify-bucket-fence.py --probe-foreign-grant \
  --bucket branchleft-db-backups --grantee-is-ours
```

Add `--dry-run` to print both documents, sending nothing and reading no
credential. Run it that way first: the second document is the one worth looking
at before agreeing to it.

`--grantee-is-ours` is required, and without it the probe stops after printing
the grantee's ARN and writing nothing. **What you are acknowledging is *who*, not
*whether*.**

**What each window grants, and what the worst case is.**

| Window | Document | Worst case if the engine ignores `Resource` scoping |
|---|---|---|
| `G1` | `Allow s3:GetObject` to the grantee's ARN on `arn:aws:s3:::branchleft-db-backups/fence-probe/*` | our own `pulumi-state` key can read every object in our own backup bucket, for up to `--dwell-seconds` (120s by default) per window, not merely the seconds a plain PUT-then-DELETE would take |
| `G2` | Hetzner's documented shape verbatim — principal as a **string**, `s3:*`, and **both** `arn:aws:s3:::branchleft-db-backups` and `.../*` | nothing worse: `G2` already names the whole bucket, so `Resource` scoping is not what is holding it back. It grants our own `pulumi-state` key full control of the backup bucket for up to that same window |

**`G2` is acceptable for one reason: the grantee is our own key.** Point it at a
third party's ARN and the same document hands them the bucket. The tool refuses
any principal that is not the ARN it resolved from the grantee credential itself,
so this is enforced in code as well as stated here — but do not weaken that guard
to run the probe against somebody else's key. Each window's document is removed at the
end of that window, before the next one goes on, and each removal is verified by
re-reading as the grantee.

**Neither document can expose the bucket publicly, and that is checked twice.**
Structurally, a `Principal` of `*` and an `Allow` carrying `NotPrincipal` are
both refused outright — the second because on an `Allow` it grants every
principal *except* the one named, which includes the anonymous caller. Then the
whole document is evaluated through `bucketpolicy.decide` and refused if the
anonymous caller gains read, list or `PutBucketPolicy` on the bucket, on a probe
object, or on a real backup object under `dumps/`. The two checks are deliberate
duplication: a structural rule nobody thought to write catches nothing, and the
evaluator asks who can actually do what rather than what the document says.

> **Do not run this during a restore, a restore drill, or the nightly backup
> window** — the same caveat as section 0, for the same reason. These documents
> grant rather than deny, so they cannot break a read in flight; but the run
> writes probe objects, lists object versions and deletes them, and a run
> competing with `prune_backups.py` is noise nobody needs while reading evidence.
>
> **This run normally takes close to four minutes, holding a live `Allow` to a
> foreign-project credential on the production backup bucket for most of it.**
> A confirming or baseline reading that matches the pre-change answer is held
> for up to `--dwell-seconds` (120s by default) before it counts, which is what
> the "for up to 120s per window" column above means in practice. The tool
> prints progress to stderr while it holds, on an interactive terminal — a long
> silence is not a hang, but do not walk away from the terminal while a live
> grant to another project's key sits on this bucket.

**Copy the whole output — the `RAW EVIDENCE` block included — onto
[branchLeft/workspace#304](https://github.com/branchLeft/workspace/issues/304).**
Access key ids are printed by their last four characters only, so the block names
no identifier and is safe to paste anywhere. Recording it is what closes the
issue; there is no PR to carry a trailer.

### 0b-iii. The verdicts

| Verdict | What it means | What happens next |
|---|---|---|
| `A BUCKET POLICY REACHES A PRINCIPAL OUTSIDE THIS BUCKET'S PROJECT` | Both shapes granted. Policies **are** evaluated for non-owner principals, and the engine is not merely matching one published template. | Read it next to section 0 rather than instead of it — both hold: evaluation happens, and the bucket owner's own keys bypass it. A project per tenant with a cross-project grant is a documented mechanism that works as deployed, and native public-bucket visibility is the anonymous-read half of the same machinery. **Choosing it is the platform owner's decision.** Nothing here rehabilitates fencing two keys inside one project. |
| `ONLY THE DOCUMENTED GRANT SHAPE REACHES A FOREIGN PRINCIPAL` | The narrow `Allow s3:GetObject` was inert; Hetzner's documented document granted. The implementation is honouring the **template**, not the semantics. | Every policy written for this provider must be the documented shape verbatim, and a document that merely means the same thing is inert. Which element carries it — principal form, action wildcard, or resource pair — is worth one more experiment before anything is built on it. |
| `A NARROW GRANT REACHES A FOREIGN PRINCIPAL AND THE DOCUMENTED SHAPE DOES NOT` | The reverse: the narrow grant worked and Hetzner's own published example did not. | Policies are evaluated for foreign principals, so the account-wide "not enforced" claim is wrong — and Hetzner's published example does not work as deployed. Raise it with them carrying this output verbatim. Treat the narrow shape as the only one demonstrated. |
| `NO CROSS-PROJECT GRANT REACHED THIS BUCKET, IN EITHER SHAPE` | Both documents were stored verbatim, confirmed live, removed — and the grantee was denied throughout. | **First rule out the ARN.** Two causes fit: the provider does not honour its own documented grant, OR the grantee ARN did not resolve because the account id read from `ListAllMyBuckets` is not the Console project number (0b-i's Console glance is exactly this control). Only once the ARN is confirmed right does the finding stand: taken with section 0, no shape this estate has tried separates a credential *outside* the bucket's own project either — a narrower claim than "no bucket policy does anything," which the wildcard `Deny` measured directly against the owner project already contradicts (see "The verification tooling's read path is cached" above). Native public-bucket visibility becomes **unproven** rather than assumed on this finding — test it directly before any media design depends on it. Record verbatim: with the ARN confirmed, this is the reproduction a support request needs. |
| `THE PROJECT BOUNDARY THIS PROBE ASSUMES DOES NOT EXIST` | With **no** policy on the bucket, a credential in a different account read an object in this one. No window was sent. | The most consequential line in this file if it holds. Check the grantee credential is the one you meant — both accounts are printed above and they differ — and that the object read was this run's own probe object. Do not provision a tenant on the assumption that a project separates anything until it is reproduced or explained. |
| `THIS RUN PROVED NOTHING ABOUT A CROSS-PROJECT GRANT` | A window produced no readable evidence: the document was refused, the stored document was not the one sent, two reads disagreed, or the document would not come off. | **An unproven run is not a negative result.** The rows say which failure it was. If a probe document is still on the bucket, that row carries the command that removes it and it comes first — a leftover document from this mode is a **grant**. |

Rows that stop it before it reaches a verdict, or that fire mid-run — every one
this mode can print, so a row you meet under pressure is one you can look up:

- **`operator|grantee credential resolves its account` — `INCONCLUSIVE`.** A
  `ListAllMyBuckets` did not return an owner id — a bad key, a wrong secret, or a
  request the endpoint saw as unsigned. Nothing was written. Re-read the
  credential and re-run.
- **`the grantee is in a DIFFERENT account from the bucket` — `FAIL`.** Both
  credentials resolve to the same account. Nothing was written. Go back to
  0b-i.
- **`the grantee is acknowledged as ours` — `INCONCLUSIVE`.** `--grantee-is-ours`
  was not passed. The row prints the ARN this run would grant to; confirm it is
  a credential in this estate and re-run with the flag. Nothing was written.
- **`the leftover GRANT is removed before anything is measured` — `PASS` or
  `INCONCLUSIVE`.** A previous run left its own grant document on the bucket, so
  a foreign key held access until this removal. `PASS` means it came off cleanly
  and the run continues; `INCONCLUSIVE` means it would not, and the run stops so
  it does not measure a bucket that still carries a grant.
- **`the probe object for window <G1|G2> is written` — `INCONCLUSIVE`.** The
  operator could not write the object each window reads. Nothing further was
  applied. Check the operator credential and re-run.
- **`the baseline reads are attributable` — `INCONCLUSIVE`.** With nothing on the
  bucket, the operator must read every probe object, and the grantee's answer
  must classify as allowed or denied even after being held against a stale
  `allowed` for the full dwell. One did not, so a read under a grant would be
  unattributable. Nothing further was applied.
- **`probe <G1|G2>: the bucket stores the document that was sent` — `FAIL`.** The PUT
  returned 2xx and what came back off the bucket is not what went on it. This backend is
  on record accepting a configuration and silently dropping part of it, so no read taken
  under that document means anything. No verdict is reported and none should be inferred.
- **`probe <G1|G2>: the grant is gone once its document is removed` — `FAIL`.**
  The grantee still read the object after the document came off, so whatever
  allowed the read was not the grant and the window shows nothing.
- **`the probe policy is accepted (probe <G1|G2>)` — `INCONCLUSIVE`.** The engine
  rejected the grant document outright (`MalformedPolicy` or similar). Nothing
  was applied and nothing deleted; the bucket is clean, so the other window
  still runs. **This is expected for G1 if the engine only honours the
  documented shape — it is why G2 still runs.**
- **`THE PROBE POLICY IS REMOVED (probe <G1|G2>)` — `FAIL`.** A **grant** document
  is still on the bucket. That is a credential in another project holding access
  it should not have: act on that row before anything else. It carries the exact
  `delete-bucket-policy` command and the document's `Id`.
- **`THE PROBE POLICY'S FATE IS UNKNOWN (probe <G1|G2>)` — `INCONCLUSIVE`.** The
  PUT of a **grant** document got no response, so it may or may not be on the
  bucket, and nothing was deleted (a blind DELETE would remove whatever is there).
  Check by hand with `get-bucket-policy`; a policy whose `Id` is
  `foreign-grant-probe-branchleft-db-backups` is this probe, and because it is a
  grant, removing it is urgent. The run stops — the bucket is not verified clean.
- **`the bucket carries no policy to displace` — `INCONCLUSIVE`.** A leftover from
  any of this file's three probe modes carries an `Id` the tool recognises and is
  cleared by re-running with `--replace-existing-policy`. A leftover whose `Id` is
  `foreign-grant-probe-branchleft-db-backups` is a **grant** and the message says
  so.

**Nothing in this section applies a fence, and no verdict here licenses one.** A
working cross-project grant is good news for a per-tenant architecture and says
nothing about separating two keys inside one project, which section 0 already
settled.

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
  --workload-access-key '<db-backups key id>' \
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
# For THIS bucket (branchleft-db-backups):
# FENCE_OPERATOR_* -- Console credential "fence-operator", project 15766609
# FENCE_WORKLOAD_* -- Console credential "db-backups", project 15766609
# FENCE_FOREIGN_*  -- Console credential "tenant-state", project 15766609
export FENCE_OPERATOR_ACCESS_KEY_ID='<operator key id>'
export FENCE_OPERATOR_SECRET_ACCESS_KEY='<operator secret>'
export FENCE_WORKLOAD_ACCESS_KEY_ID='<db-backups key id>'
export FENCE_WORKLOAD_SECRET_ACCESS_KEY='<db-backups secret>'
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

**This command normally takes close to two minutes, not seconds — that is
expected, do not interrupt it.** The operator's own reading has to survive a
full dwell before it counts (see "The verification tooling's read path is
cached" above), and in the ordinary case where the exemption works, that
reading is `allowed` from the first attempt, which is exactly the one that has
to wait out the whole window. `--dwell-seconds` shortens this for a fast-path
re-run once the engine's behaviour is already known.

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
the withdrawn conclusion described in "Six things reduce the chance of ever
getting here," above.

- **`NotPrincipal EXEMPTS the named key` — `FAIL`.** Stop. This engine does not
  read `NotPrincipal` as an exemption — it denied the operator, whom the
  statement names as exempt — so applying the **`NotPrincipal`-based** fence
  would have locked the bucket permanently. Nothing has been applied. Record the
  output and hand it back. **Do not read this as "no fence is possible":** a
  `Deny` that reached the operator is an *enforced* deny, which is evidence the
  engine evaluates policies against a named key at all — the `PER-KEY PRINCIPALS
  RESOLVE` world, where a fence rebuilt from explicit `Principal` denials could
  still work. Which world this is, section 0 decides; this row only rules out
  the `NotPrincipal` shape.
- **`NotPrincipal EXEMPTS the named key` — `INCONCLUSIVE`.** The operator's read
  succeeded and so did the foreign key's. Three worlds produce that: the
  exemption works, the statement is ignored entirely, or both reads were served
  from the read-path cache and neither saw the statement at all. This row cannot
  separate them. **The 2026-08-27 run produced this, before the dwell above
  existed — so it is not evidence for any of the three.** Section 0 is what
  separates them.
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
0: only whether `NotPrincipal` exempts, which is what the fence this repository
renders today is built on. Section 0 asks whether a principal-based `Deny`
discriminates between two keys in this project at all, and its answer is the
one that decides whether a fence can exist here in any form.

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
> unreachable until section 0 has printed `PER-KEY PRINCIPALS RESOLVE ON THIS
> ENGINE`, re-run under the current tool if the last run predates the read-path
> fix above, *and* step 1c has confirmed `NotPrincipal` genuinely exempts —
> also re-run if it predates the fix, since it is the least-dwelled read in
> this file. If 1c shows `NotPrincipal` does not exempt, the fence has to be
> rebuilt out of explicit `Principal` denials first, because the document
> `render-bucket-fence-policy.py` emits today fences by `NotPrincipal` alone.
> **Section 0's own verdict table is the authority on what every other verdict
> means** — most of them mean no bucket policy can fence anything here by any
> document, but `A NAMED PRINCIPAL MATCHES NOBODY` means only that this
> repository's ARN form specifically is not resolving, worth one more
> experiment before concluding the same; read the table rather than assuming
> every non-passing verdict is identical. A green section 1c and a green 1d do
> **not** substitute for section 0: both validate a document against a model of
> S3 evaluation, and the question section 0 answers is what this engine
> actually does.

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
  --policy-file /tmp/branchleft-db-backups-policy.json \
  --engine-diagnostic-passed
```

`--engine-diagnostic-passed` is the gate above, asserted on the command line.
The script cannot run section 0 itself — that needs three credentials and a
bucket this script has no business touching — so the flag is a claim the
operator makes, and without it the script writes nothing and exits 2. Pass it
only once section 0 has actually printed `PER-KEY PRINCIPALS RESOLVE ON THIS
ENGINE` under the current tool. **This step also pauses for a full dwell
between its two policy PUTs**, so expect it to sit for two minutes after the
first one; that pause is the lockout check working, and interrupting it is the
one thing that turns a recoverable state into an unclear one.

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
object keys and the real encryption step. `db1` has no public address, so
this goes through edge1, the same jump host every other remote command in
this repo uses.

```bash
JUMP="ssh -i ~/.ssh/id_ed25519_hetzner -W %h:%p root@46.225.95.167"
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
`branchleft-db-backups`, which section 1 fenced and which names it. Same
project (`15766609`) as section 1b, same three credentials — only which
`FENCE_*` role each plays has swapped:

```bash
# For THIS bucket (branchleft-tenant-pulumi-state), the roles have swapped:
# FENCE_OPERATOR_* -- Console credential "fence-operator", project 15766609 (unchanged)
# FENCE_WORKLOAD_* -- Console credential "tenant-state", project 15766609 (was FOREIGN in 1b)
# FENCE_FOREIGN_*  -- Console credential "db-backups", project 15766609 (was WORKLOAD in 1b)
export FENCE_OPERATOR_ACCESS_KEY_ID='<operator key id>'
export FENCE_OPERATOR_SECRET_ACCESS_KEY='<operator secret>'
export FENCE_WORKLOAD_ACCESS_KEY_ID='<tenant-state key id>'
export FENCE_WORKLOAD_SECRET_ACCESS_KEY='<tenant-state secret>'
export FENCE_FOREIGN_ACCESS_KEY_ID='<db-backups key id>'
export FENCE_FOREIGN_SECRET_ACCESS_KEY='<db-backups secret>'
```

Neither section 0 nor step 1c repeats here. Both test the engine — what a bucket
policy does, and what `NotPrincipal` does — which is a property of the account
rather than of a bucket, and section 1 settled both.

### 2c. Pre-flight and apply, in one command

> **GATE — the same one as 1e, and this is the bucket where getting it wrong
> stops every tenant deploy.** This step does not run until section 0 has
> printed `PER-KEY PRINCIPALS RESOLVE ON THIS ENGINE` (re-run under the current
> tool if the last run predates the read-path fix above), the fence has been
> rebuilt out of explicit `Principal` denials if step 1c required that, and
> section 1 has passed in full against the rebuilt document. Section 0's own
> verdict table decides what every other verdict means for this step, and most
> of them — but not all identically, see 1e's gate above — mean it does not
> run.

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

Hetzner documents `NotPrincipal` verbatim but publishes no list of supported
Actions, Principal formats or Conditions, and says nothing about `NotAction`.
There are **four** ways it can go wrong, and they are listed worst first. Which
of them is live is what section 0 and step 1c settle — provided their reads are
taken past this engine's read-path cache; see "The verification tooling's read
path is cached" above before trusting either of their past runs.

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
all. Every signal except the probes says the bucket is fenced. **A run of step
1c reported exactly this before the read-path cache above was understood and
fixed, on a read taken with no dwell at all — so that run does not settle
anything on its own. Re-run 1c under the current tool before treating it as
settled.** When it is genuinely this case, step 1c catches it as `NotPrincipal DENIES everyone else — FAIL`, and
section 1f catches it after the fact — but neither says *why*, and the two
possible reasons have opposite consequences. If the
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
as section 1f does, with fresh exports for this bucket -- **do not reuse
section 2's exports if this follows it in the same shell: section 2 swapped
which credential plays `FENCE_WORKLOAD`/`FENCE_FOREIGN`, and running this step
under that swap verifies the wrong workload and reports `PASS` on a bucket that
is not actually proven.**

```bash
export FENCE_OPERATOR_ACCESS_KEY_ID='<operator key id>'
export FENCE_OPERATOR_SECRET_ACCESS_KEY='<operator secret>'
export FENCE_WORKLOAD_ACCESS_KEY_ID='<the key that will use the new bucket>'
export FENCE_WORKLOAD_SECRET_ACCESS_KEY='<its secret>'
export FENCE_FOREIGN_ACCESS_KEY_ID='<db-backups key id>'
export FENCE_FOREIGN_SECRET_ACCESS_KEY='<db-backups secret>'

python3 infra/provisioning/scripts/verify-bucket-fence.py \
  --bucket <new bucket name> \
  --foreign-control-bucket branchleft-db-backups \
  --policy-file <the rendered policy file> \
  --versioning-already-enabled
```

`branchleft-db-backups` and the credential named **`db-backups`** in the
Hetzner Console (project `15766609`) are the foreign role and its control
bucket, since that pair is fenced and proven and so its denials and its control
both mean something. `--versioning-already-enabled` is passed because the
rendered sequence enables versioning before the fence. Step 1c is not
repeated: it tests the account's engine, not the bucket.

A tenant's media bucket is a different shape — public read on the object path,
append-only for the tenant — and is handled by
`infra/provisioning/scripts/render-media-bucket-policy.py` and
`RUNBOOK-tenant-onboarding.md` section 6.
