# probe-media-lifecycle-expiration.py

## Loading configure_backup_bucket

`configure_backup_bucket.lifecycle_document` is the REAL document this
probe's prefix-split mode exists to prove safe — loaded by path, the same
way `shared_objectstorage.py` loads `db/provision/objectstorage.py`, rather
than reimplementing its rule shape here a second time (a hand-copied shape
can drift — the wrong order, a missing element, a rule count that quietly
stops matching what actually ships — and a probe that tests its own drifted
copy proves nothing about what `configure_backup_bucket.py` will apply to
the real bucket). One-way only: `db/provision/` ships standalone to db1 via
`scp -r` and must never import anything back from here.

## PROBE_BUCKET_PREFIX

The one prefix this script will write under. A structural refusal, not a
reminder: a bucket named anything else — including every tenant's own
`branchleft-media-<slug>` and the operational `branchleft-db-backups` — is
refused before a single request is signed, because the object this script
uploads is deliberately never protected by a bucket policy and the whole
point of the test is to let a lifecycle rule run unopposed on it.

`check()` calls this too, on the bucket named in the RECEIPT rather than an
operator-typed flag — a stale or hand-edited receipt naming a real bucket
is exactly the half-awake, days-later mistake this guard exists to survive,
and `check` only ever reads, so the mistake it prevents is pointing a
credential's read at a bucket it should never have reached at all, days
after the operator's attention was on something else.

## prefix_split_lifecycle_document

The REAL document, built by calling `db/provision/configure_backup_bucket.py`'s
own `lifecycle_document()` directly (loaded by path — see "Loading
configure_backup_bucket" above) rather than a hand-copied reconstruction of
its shape. A copy can drift — the wrong rule order, a missing element, a
rule count that quietly stops matching what actually ships — and a probe
testing its own drifted copy proves nothing about what
`configure_backup_bucket.py` will apply to the real bucket. This now
carries all FOUR of that generator's rules (`dumps/`, `binlogs/`, `media/`
and `fence-probe/`), byte for byte and
in the same order, even though `setup_prefix_split` below only ever
uploads canaries under two of them (`media/` and `dumps/`, the latter
standing in for `dumps/`+`binlogs/` since they carry an identical rule —
see the "Prefix-split mode" section above). The extra two rules being
present and unexercised does not weaken the question this mode answers; it
makes the document under test the one that will actually be applied, not a
closest-effort stand-in for it.

## check-split verdict fields

`control_survives` and `current_of_noncurrent_present` must hold for BOTH
prefixes unconditionally — neither rule's element set predicts removing a
live current object. `delete_marker_present` is different for media/
only on a bucket set up with the earlier document, whose media/ rule
carried `ExpiredObjectDeleteMarker`: once the noncurrent version under a
deleted key was pruned, that element made the now-sole delete marker
itself eligible for removal on a later pass. The document now shipped has
no such element on any rule (a Days expiry cannot share an element with
it), so on a fresh bucket both delete markers survive. The db-style prefix
never carried it, so its own delete marker surviving is unconditional
— its disappearance is not predicted by any reading and is treated as a
missing current object, same as before.

## Module overview

`render-media-bucket-policy.py` emits a lifecycle rule carrying
`NoncurrentVersionExpiration` and `AbortIncompleteMultipartUpload` and
deliberately no current-version `Expiration` element — see that file's
`render_commands()`. A tenant bucket configured with exactly that rule then
had its first upload answered with an `x-amz-expiration` header naming a date
31 days out, attributed to the rule, on the CURRENT version of a freshly
uploaded object. In real S3 semantics a noncurrent-only rule produces no such
header at all. Two readings are open:

  READING A (optimistic, and the likelier one): RGW's header code answers "when
  would this version expire once it becomes noncurrent" from the only day-count
  the rule carries, even though the object is current and lifecycle processing
  itself never touches it. The header is cosmetic noise; nothing is ever
  deleted that the rule did not intend.

  READING B (pessimistic): RGW's lifecycle processing itself has read the
  rule's only day-count as a current-version expiry. Every tenant's media
  bucket then deletes every object `NoncurrentDays` after upload, silently,
  because nothing distinguishes an ordinary upload from one that has since
  been replaced until the storage engine is asked to act on it.

Configuration round trips (`get-lifecycle-configuration` reading back what was
sent) settle NEITHER reading — both a document that is honoured as written and
a document whose only number is misapplied to the wrong version class read
back identically. The two readings differ in what the storage engine DOES
over time, which only elapsed wall-clock time against a real object can show.

### The cheap decisive test, and why it needs two objects not one

Put one "probe" object, under a key the rule's `Filter` covers, into a bucket
carrying this exact rule shape with `NoncurrentDays` set low (default 1, so a
daily lifecycle pass settles it in 24-48h rather than the real 30); never
overwrite it, so it never acquires a noncurrent version under EITHER reading
and the test does not depend on versioning behaving any particular way.
Alongside it, put a "control" object under a key the rule's `Filter` does NOT
cover — so no reading of this rule, optimistic or pessimistic, predicts the
control's removal.

A single object's disappearance is not proof by itself: a 404 is equally
consistent with the bucket having been deleted out from under the probe, a
credential or permission change between the two runs, or unrelated manual
cleanup — exactly the "a negative result cannot identify which boundary
produced it" trap this whole item is about, and a tool meant to resolve that
ambiguity must not reintroduce it. The control is the discriminator:

  - probe gone, control survives -> only the rule could have done that,
    because the control was never in its scope. READING B, confirmed.
  - probe gone, control ALSO gone -> something removed both, and the rule
    only covers one of them — attribute nothing to the rule. INCONCLUSIVE.
  - probe survives -> READING A, regardless of the control (which is expected
    to survive too; if it does not, that is its own anomaly, reported as
    INCONCLUSIVE rather than folded into a verdict about the probe).

### Usage

Two runs against a THROWAWAY bucket — never a tenant's media bucket, never
`branchleft-db-backups`, never anything with real content:

```text
# Day 0. Requires AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the
# environment for a credential that administers throwaway Object Storage
# buckets in this project — the same class of credential already used
# for the branchleft-lab-* buckets documented in the migration programme
# notes. NEVER a tenant's media credential, and never the operator
# credential that is branchleft-db-backups's administrator, because a
# mistake here must not be able to touch either.
python3 infra/provisioning/scripts/probe-media-lifecycle-expiration.py setup \
  --bucket branchleft-lifecycle-probe-<yyyymmdd> \
  --endpoint hel1.your-objectstorage.com --region hel1 \
  --receipt /tmp/media-lifecycle-probe-receipt.json

# The bucket itself must already exist and be empty — this script does
# not create one. aws --endpoint-url https://hel1.your-objectstorage.com
# s3api create-bucket --bucket branchleft-lifecycle-probe-<yyyymmdd> --acl
# private --create-bucket-configuration LocationConstraint=hel1 first, as
# the same operator credential.

# 24-48 hours later, same receipt file, same credential:
python3 infra/provisioning/scripts/probe-media-lifecycle-expiration.py check \
  --receipt /tmp/media-lifecycle-probe-receipt.json

# A SECOND run, against a SEPARATE throwaway bucket, tests the shape
# branchleft-db-backups actually carries — no AbortIncompleteMultipartUpload,
# and its own 35-day NoncurrentDays (the low default is still fine for a
# fast answer; only the ELEMENT SET is what needs to match). See "The
# backup bucket is a separate claim" below for why this is not optional:
python3 infra/provisioning/scripts/probe-media-lifecycle-expiration.py setup \
  --bucket branchleft-lifecycle-probe-<yyyymmdd>-backup-shape \
  --endpoint hel1.your-objectstorage.com --region hel1 \
  --rule-shape backup \
  --receipt /tmp/backup-lifecycle-probe-receipt.json
```

### Interpretation guide

Read from `check`'s own printed verdict. Each names exactly what it does and
does not rule out — there is no ETag or version-id comparison anywhere in
this script: `signed_request`'s transport returns only `(status, body)`, no
headers, so nothing here claims to verify object identity beyond "a HEAD to
this key returned 200 or 404". The control object is what supplies the
missing discriminator instead.

  SURVIVES (probe HTTP 200) — READING A. The rule shape under test does not
  expire a current object that has never been overwritten. Record this in the migration
  programme's own register as Observed for the rule shape tested (media or
  backup, per the receipt); the register's own words already say this needs
  exactly this kind of run to close. No code change is implied. Does NOT by
  itself rule out some other object-identity mixup (there is no version id
  or ETag check here) — it rules out the object at this key being gone.

  GONE, CONTROL SURVIVES (probe HTTP 404, control HTTP 200) — READING B,
  CONFIRMED. The control was never in the rule's `Filter` scope under either
  reading, so its survival while the probe vanished attributes the loss to
  this rule specifically, not to the bucket, credential or account in
  general. Every bucket carrying the SAME rule shape (media or backup, named
  in the receipt) is losing content on the same schedule, right now. Stop
  provisioning new tenants under this rule shape and escalate to the platform
  owner before touching any live bucket — freezing or replacing the
  lifecycle rule on a live bucket is itself a production infrastructure
  change, outside what this script or its author may do unattended.

  GONE, CONTROL ALSO GONE (both HTTP 404) — INCONCLUSIVE, not READING B.
  Something removed both objects, but the rule under test only covers the
  probe's key — its scope cannot explain the control's disappearance, so
  this result cannot be attributed to the rule. Investigate the bucket
  itself (deleted? a broader credential change? manual cleanup?) before
  drawing any conclusion, and re-run once that is understood.

  PROBE SURVIVES, CONTROL GONE (probe 200, control 404) — INCONCLUSIVE. No
  reading of this rule predicts the control disappearing while the probe
  does not; this pattern does not match the question this script asks.
  Investigate rather than trust either half.

  ANYTHING ELSE (a transport error, a non-200/404 status on either key, a
  credential that cannot reach the bucket) — INCONCLUSIVE. Report the raw
  status and body for both keys; do not guess.

### The backup bucket is a separate claim, not an assumed transfer

A run of this script proves a result about the rule shape it actually
applied. `branchleft-db-backups` (`db/provision/configure_backup_bucket.py`)
carries `NoncurrentVersionExpiration` alone, at 35 days, with NO
`AbortIncompleteMultipartUpload` element — a narrower rule than the media
default this script applies. `--rule-shape backup` reproduces that narrower
shape (element set only; `--noncurrent-days` is still yours to lower for a
fast answer). Whether `AbortIncompleteMultipartUpload`'s mere presence
changes how RGW's lifecycle engine reads the sibling
`NoncurrentVersionExpiration` element is not established either way by a
single run — it is a small, plausible-sounding claim ("an unrelated sibling
element changes this one's interpretation") that nobody has tested, so it is
not assumed here. A media-shape SURVIVES or GONE verdict is evidence, not
proof, about the backup bucket; run `--rule-shape backup` separately for a
claim about it specifically. This matters because that bucket's
current-object retention already depends on `prune_backups.py`'s own
pruning running before anything else deletes the object it is about to
evaluate.

### Why this script uses no vocabulary beyond what is already proven

Both rule shapes here use only elements `render-media-bucket-policy.py` or
`configure_backup_bucket.py` already have accepted: `NoncurrentVersionExpiration`,
`AbortIncompleteMultipartUpload`, `Filter`/`Prefix`, `ID`, `Status`. Adding a
current-version `Expiration` element to "help" would answer a different
question — whether an EXPLICIT current-version expiry is honoured, which
nobody doubts — not whether the ambiguous rule this platform actually ships
is safe. Inventing any element or action name not already proven acceptable
elsewhere in this repository is exactly the mistake that made a bucket policy
unrenderable in a previous incident here.

### Why this script never runs itself

It is written to be executed by a human with a live credential and a
throwaway bucket, on a 24-48h cadence it cannot schedule itself; nothing in
this repository's CI reaches Hetzner Object Storage with a credential that
could run it, and it must not gain that ability, because `check`'s only
destructive potential — misreading a transport failure as READING B — is
exactly the failure mode an unattended retry would make more likely, not
less.

### Prefix-split mode (setup-split / check-split): a different question

Everything above answers "does a noncurrent-only rule expire a CURRENT
object" for one rule applied to a whole bucket. The media backup pipeline's
C-refresh design needs a second, separate question answered: given TWO rules
on the SAME bucket, each scoped to its own `Filter/Prefix` — `media/` with a
short expiry, a database-backup-style prefix with the existing long one —
does each rule act ONLY within its own prefix, leaving the other's content
alone? Hetzner's behaviour with overlapping or multiple lifecycle rules on
one bucket is exactly as unproven as the single-rule current-vs-noncurrent
question the rest of this script answers, and a config that assumes prefix
scoping "obviously" works is the same unproven-assumption shape this whole
tool exists to replace with a real answer.

This mode applies the literal two-rule shape
`db/provision/configure_backup_bucket.py`'s `lifecycle_document()` renders
for its `media/` and database prefixes (one database-style prefix stands in
for both `dumps/` and `binlogs/`: both carry the identical rule, so the
mechanism under test — a prefix-scoped `NoncurrentVersionExpiration` — does
not depend on which literal database prefix string is used). Under each
prefix it creates THREE objects: a `control/` object that is never touched
again (must survive under every reading, on both prefixes, forever); a
`noncurrent/` object, uploaded twice so the first upload becomes a
noncurrent version (the everyday "someone re-uploaded this file" case); and
a `deleted/` object, uploaded once then deleted, so a delete marker becomes
current and the original content becomes a noncurrent version (the
everyday "someone removed this file" case C-refresh itself produces on
every run). `setup-split` records each of the two noncurrent-making
objects' NONCURRENT version id immediately, via `?versions` — the only way
to see a version id a later lifecycle pass may since have pruned, because a
bare GET/HEAD only ever answers about whatever is CURRENT at a key.

`check-split`, run 24-48h later, re-lists both prefixes' versions and
requires ALL of the following to report PASS — anything else is FAIL or
INCONCLUSIVE, the same discipline as `check` above:

  - every CURRENT object on both prefixes still answers (both controls, the
    post-overwrite current version of both `noncurrent/` objects, and both
    delete markers) — if any current object is gone, something removed it
    that neither reading of either rule predicts, so nothing is attributed
    to the rule;
  - `media/`'s two recorded NONCURRENT version ids are no longer present in
    a `media/`-scoped version listing (the short rule pruned them); and
  - the database-style prefix's two recorded NONCURRENT version ids ARE
    still present (the long rule has not, and must not have, expired them
    early — proving the two rules stayed independent, not just that the
    short one eventually fires).

A media-side PASS this early (before `earliest_decisive_check`) is not
decisive, exactly as with `check` above; a database-side PASS is decisive
at any time after setup, because nothing legitimate removes it sooner than
its own 35-day rule allows.

Usage:

```text
python3 infra/provisioning/scripts/probe-media-lifecycle-expiration.py setup-split \
  --bucket branchleft-lifecycle-probe-$PROBE_DATE \
  --endpoint hel1.your-objectstorage.com --region hel1 \
  --receipt ~/branchleft-probe-receipts/media-lifecycle-split-$PROBE_DATE.json
# optional: --media-noncurrent-days (default 1) --db-noncurrent-days (default 35)

# 24-48 hours later:
python3 infra/provisioning/scripts/probe-media-lifecycle-expiration.py check-split \
  --receipt ~/branchleft-probe-receipts/media-lifecycle-split-$PROBE_DATE.json
```
