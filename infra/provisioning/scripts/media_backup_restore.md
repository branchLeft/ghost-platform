# media_backup_restore.py

## Module overview

Back up one tenant's live media to the backup bucket, and restore it back
-- proving the *bytes*, not that the objects merely exist.

### Why byte-level proof, not existence

09-backup-and-recovery.html's own control (a Ghost pointed at an empty
database serves HTTP 200) is the reason this module never treats "the GET
succeeded" as "the restore worked". `restore_tenant_media` decrypts every
object the tenant's manifest names and compares its SHA-256 against the
digest `backup_tenant_media` recorded at backup time -- an object that is
missing, corrupt, or encrypted to a different tenant's recipient fails the
comparison and raises, rather than reporting a restore that silently
recovered nothing.

### Custody and crypto-shredding

Custody mirrors the database dump exactly, because it is the same
crypto-shredding invariant applied to a second dataset: one `age` recipient
per tenant, never a second one, on both the ciphertext objects and the
manifest that names them. `backup_tenant_media` does not trust its own
`encrypt` call to have honoured that: it re-opens every ciphertext's header
and counts the recipient stanzas, and refuses to write anything with a count
other than one. Destroying that tenant's identity then makes every object
this module wrote unreadable and leaves every other tenant's objects
untouched -- `restore_tenant_media` never falls back to a different key, and
a caller that hands it the wrong tenant's identity gets `age`'s own refusal
("no identity matched any of the recipients"), not a wrong answer.

Fails closed per tenant, never per run: one tenant's missing object, corrupt
ciphertext or empty live bucket raises for that tenant alone and never
touches another tenant's backup or restore.

### Generations, not a flat tenant prefix

Every run gets its own, disjoint prefix, named by a sortable run id (a UTC
timestamp plus random suffix -- see `generate_run_id`) that never repeats
and never has to be reasoned about across runs:

```text
media/<tenant>/generations/<run_id>/objects/<random 64-hex-character id>.age
media/<tenant>/generations/<run_id>/manifest.json.age
```

`<tenant>` is validated as a strict slug (lowercase letters, digits and
hyphens, 1-63 characters) at the boundary of both `backup_tenant_media` and
`restore_tenant_media`, before it is used to build a single key -- a `/` or
a `..` in a tenant string can never reach a key, and no tenant's name can
ever be a string-prefix of another tenant's generation keys, because
`generations/` immediately follows the tenant name in every key this module
writes. Object keys are RANDOM, never the live key and never derived from
the plaintext -- both were tried and both leak. The live key is the tenant's
own filename; the plaintext's own SHA-256 is a content fingerprint that
survives the tenant's key being destroyed just as easily, because it is
computed before encryption and needs no key at all to recompute -- anyone
who already knows (or can guess) a piece of content can check a tenant's
backup listing for its hash forever, which is pseudonymisation, not erasure.
A per-tenant HMAC does not fix this either: verifying it needs the HMAC key,
and unless that key is destroyed in lockstep with the tenant's `age`
identity it outlives the erasure the whole scheme exists to provide, which
defeats the point more quietly than the plaintext digest did. So the backup
id carries no relationship to the object's content or its live key at all --
see `generate_backup_object_id` -- and the live-key-to-id mapping, alongside
the plaintext digest restore verification still uses, lives only inside the
encrypted manifest.

### The empty-backup floor

The empty-backup floor is on by default, the same way `dump_tenant.py`'s
row-count floor is not opt-in: a backup that lists zero live objects raises
unless the caller passes `confirm_tenant_has_no_media=True`, an explicit,
one-shot assertion from whatever already knows this tenant genuinely has no
media (never inferred from an empty listing on its own, which is exactly the
signal a misconfigured live-bucket pointer or a broken listing call would
also produce). A confirmed-empty backup is marked as such in the manifest
(`deliberately_empty: true`), and only that mark lets `restore_tenant_media`
treat zero verified objects as success -- an unmarked manifest with no
objects in it is refused the same way a missing or corrupt object is,
because it is the same failure shape 09-backup-and-recovery.html's R4 names:
a technically-valid, encrypted, empty result that looks exactly like a
healthy backup until someone needs to restore from it. That flag is refused
outright -- writing and deleting nothing -- when a previous generation
already holds objects: the flag exists for a brand-new promotion with no
previous generation at all, never to empty a populated one.

### Generations, the ordering guarantee, and why it survives two runs at once

Mirroring a tenant's media in place -- keeping storage near 1x rather than
growing without bound -- needs to know which backup object belongs to which
live file, so an unchanged file can be skipped and a removed one deleted.
This pipeline cannot know that without either leaking or holding a secret
(see "Generations, not a flat tenant prefix" above: a content- or
filename-derived id leaks, and a per-tenant key to name them safely is a new
secret with its own destruction obligation). `backup_tenant_media` instead
never tries to diff against a previous run at all: every run uploads a
complete new set under a FRESH generation prefix, proves every one of those
objects present in a fresh listing, only THEN writes and verifies its own
manifest there (a manifest existing means the generation it names is
complete -- see "The delete step is trusted with nothing" below), and only
then deletes every key under this tenant's `generations/` prefix whose run
id sorts strictly BEFORE this run's own -- never a key belonging to a run id
that sorts the same or after, whether or not that other run has finished.

That last clause is what makes two overlapping runs of the same tenant safe
with no lock and no new secret. Call the two runs' ids R1 < R2, whichever
order they happen to finish in:

- Whichever run finishes FIRST only ever deletes generations older than ITS
  OWN id -- the other run's id, R1 or R2, is never less than the finishing
  run's own id if it is the smaller one, and a bigger id is never "older"
  regardless of how much of that run has landed. So the still-running or
  not-yet-started run's generation, complete or not, is never touched by the
  other one finishing.
- R2 (the larger id) finishing, whenever that happens, deletes R1's whole
  generation (verified-complete or still partial) along with anything older
  -- R2 is definitionally the newest surviving generation once it completes,
  and `restore_tenant_media` always reads the newest.
- The one edge case -- R2 finishes WHILE R1 is still mid-upload, and R2's
  cleanup removes objects R1 already wrote under R1's own prefix (fair game:
  R1's id sorts before R2's, complete or not) -- is caught by R1's own
  before-any-delete check (see below) rather than silently producing a
  manifest that names objects that are gone: R1 raises and deletes nothing,
  leaving R2 as the sole, correct, fully verified generation.

So there is no interleaving of two same-tenant runs that leaves the
tenant's *current* (highest-id) generation unrestorable -- the losing run
either finishes first (and is left intact by the later one) or finishes
last (and replaces the other), and the one case that could corrupt the winner is
refused by construction rather than merely made unlikely.

### The delete step is trusted with nothing

Until the new generation is proven durable, on both axes a `2xx` response
cannot cover -- and nothing is trusted with a manifest either, until the
first of those two axes holds. A manifest existing is this module's own
definition of "this generation is complete"; a manifest written before that
was true would let a caught, detected failure still leave behind one that
names an object nobody can find. So the order is: upload every object, THEN
list this tenant's whole `generations/` prefix fresh and refuse -- raising,
writing nothing -- unless every object key this run itself wrote is present
in that listing (an object PUT that answered 2xx without actually
persisting is caught here), THEN write the manifest and read it straight
back with `get_object`, comparing the bytes to what was sent (this
endpoint's own 2xx is not proof THAT write landed either). The presence
check is repeated once more after the manifest write -- an overlapping run
with a larger id can delete this run's own objects, fair game, in the gap
between the two -- and only once every one of these checks holds does
deletion run. Any failure before all of them -- an upload, an encrypt, the
floor, either presence check, or the manifest write or its read-back --
raises first and writes and deletes nothing, so a partial, failed, or
replaced run never produces a manifest that outlives its own missing
objects, and never removes a generation that is still the tenant's newest
verified one. A manifest that DOES get written but fails its own read-back
(the PUT reported success but what is actually stored differs) is the one
failure shape this ordering cannot prevent by itself -- see
`restore_tenant_media`'s `run_id` parameter for how a caller recovers from
that case, since restore never falls back to older data on its own.

### Key-shape validation and orphan reclaim

The same listing these checks read from is also where the delete set comes
from, and every key in it is matched against this module's own exact key
shape (tenant, `generations/<run id>/`, then either `objects/<64 hex>.age`
or `manifest.json.age`) before it is trusted for any of these purposes -- a
listing that somehow returned a key outside that shape (a bug elsewhere, a
forged object, a `prefix` argument silently ignored) aborts the run rather
than being folded into a presence check or a delete decision it was never
meant to answer. That same shape check runs once more, before any of the
above -- right after this run's own id is generated -- so a stray key that
would abort the run anyway is caught before a full copy of the tenant's
media is re-uploaded for nothing; the same pass also reclaims any ORPHANED
generation (objects with no manifest at all, in this listing) that sorts
strictly before the NEWEST generation this same listing already shows a
manifest for -- never merely "older than this run's own id", and nothing at
all when this listing has no manifest anywhere. An orphan can only be ruled
out this way because a newer, already-complete generation exists in the
very same snapshot, so the orphan can never become the tenant's newest
restorable one; sweeping by "older than this run" alone would be wrong,
because this listing is a snapshot; the run that owns an apparent orphan
may write its own manifest, becoming the newest verified generation,
moments after the listing was taken and before this sweep's own deletes
reach the wire.

### The bound on a persistently failing run

This sweep, by itself, does NOT bound a persistently failing run's own
leftover uploads: a run whose live listing keeps refusing the same object
fails every night before it ever writes a manifest, so its own objects
never sort before an existing manifest -- they sort AFTER the newest one,
which is exactly the shape this sweep is built to leave alone. That bound
comes from a separate mechanism instead: any exception from here up to, but
never including, the manifest PUT itself (see `_write_and_verify_manifest`)
deletes -- best effort, logged rather than allowed to replace the failure
that triggered it, and never changing that failure's own non-zero exit --
only the object keys this same run itself already wrote, under its own
`generations/<run id>/objects/` prefix, with a plain `DeleteObject`. With no
manifest, nothing depends on those objects. Once the manifest PUT has been
attempted, this generation may be the one restore reads next, so nothing
past that point ever touches it that way again. The one case neither
mechanism reaches is a process killed outright: a hard crash leaves no code
running to write a manifest OR to clean up after itself, so that
generation's objects sit as a genuine orphan until a later run's own
manifested generation makes them reclaimable by the sweep above. Last,
after this run's own delete step, one final listing checks that no
generation with a manifest still sorts AFTER this run's own id -- if one
does, this run's clock is behind that generation's (or that generation's
clock was ahead of real time), and `restore_tenant_media` would otherwise
keep silently reading that other generation forever. This run's own backup
is complete and durable by that point regardless; this last check only ever
reports which generation restore will pick.

### Deletion is a plain DeleteObject

Never a version-scoped `DeleteObjectVersion`: the workload credential this
pipeline runs under is fenced from that action the same way it is fenced
from every other bucket-administration action (see
`db/provision/configure_backup_bucket.py` and the bucket fence it applies),
so a plain delete -- which a versioned bucket turns into a delete marker
over the still-readable prior version, not a destruction -- is the only
kind of delete this pipeline is even able to issue. The bytes are actually
reclaimed days later by the backup bucket's own short, `media/`-scoped
noncurrent-version-expiry lifecycle rule, not by this pipeline. A delete
that itself fails partway (one key errors, the rest were never attempted)
leaves an orphan that is not a correctness problem: it sits under an older
run id, so the next successful run's own delete step picks it up the same
way.

## generate_backup_object_id

A random id for one object's backup-bucket key, unrelated to its content or
its live key -- see the module overview's "Generations, not a flat tenant
prefix" section for why a content-derived or per-tenant-HMAC-derived id
both leak. `digest` (the object's plaintext SHA-256) is accepted and
IGNORED: the parameter exists so a caller -- in practice, only this
module's own tests -- can inject a deliberately content-derived
replacement and demonstrate exactly what this function refuses to do, not
because the real implementation needs to see it. `secrets.token_hex`, not
`random` or a hash of anything: this value never has to be reproduced from
anything else, only generated once and carried in the manifest, so there
is no argument for it being anything but unpredictable.

## MediaBackupObjectVerificationError

A fresh listing of this tenant's `generations/` prefix, taken right before
the delete step, does not contain every object key this run itself just
wrote. Distinguished from `MediaBackupError` so a caller and a test can
tell this control apart from the manifest's own read-back: this is what
catches an object PUT that answered 2xx without actually persisting, or an
older-but-still-technically-concurrent run's cleanup removing this run's
own objects out from under it -- either way, this run's own manifest cannot
be trusted while any object it names is missing, so nothing is deleted and
the run raises instead.

## MediaBackupClockSkewError

After this run's own delete step, a fresh listing still shows a generation
with a manifest whose run id sorts AFTER this run's own -- this run's clock
is behind that generation's (or that generation's clock was ahead of real
time when it ran). `restore_tenant_media` always reads the newest id, so it
keeps returning that other generation, not this run's own backup, until a
later-dated run finally overtakes it too. Distinguished from
`MediaBackupError` so a caller can tell this specific, otherwise-completely-
silent failure mode apart from every other one: this run's own backup is
NOT lost -- it is simply not the one restore will read, and nothing else in
this module would ever say so.

## count_age_recipient_stanzas

How many recipients an `age` ciphertext's header names, read structurally
rather than trusted from whatever call produced it.

The age format (<https://age-encryption.org/v1>) is textual up to the
header's closing `---` MAC line: one `-> ...` line opens each recipient
stanza, immediately followed by that stanza's base64 body line(s), and the
whole file besides is opaque symmetrically-encrypted payload this function
never touches. Counting `-> ` line prefixes up to the first `---` line is
therefore an exact count of recipients, not a guess -- and it is checked
against real `age` output on both a one-recipient and a two-recipient
ciphertext in this module's own tests, so the count is known to agree with
what `age` itself considers a recipient rather than with an invented
reading of the format.

## `_best_effort_delete_this_runs_own_uploads`

A run that raises before its own manifest PUT has been attempted deletes
the object keys it itself already wrote, under its own
`generations/<run_id>/objects/` prefix -- no listing needed, since `keys`
is exactly what this run's own upload loop tracked. With no manifest,
nothing depends on those objects; leaving them is pure cost, never a safety
concern the way deleting a MANIFESTED generation would be. A plain
`DeleteObject`, the only kind of delete this pipeline can even issue -- see
"Deletion is a plain DeleteObject" above.

Best effort ONLY, and the caller enforces the one rule that matters: this
never runs once `_write_and_verify_manifest` has been called, so it can
never touch a generation that might already be the tenant's restorable one.
A failure deleting one key here is logged and swallowed, not raised -- this
function never replaces or hides the original exception that triggered the
clean-up, and never turns a caller's non-zero exit into anything else. The
one case this cannot reach at all is a process killed outright: nothing
runs to clean up after a hard crash, so that generation's objects sit as a
genuine orphan until a later run's own manifested generation makes them
reclaimable by the sweep above -- a real, named limit, not a claim this
function is complete.

## backup_tenant_media

Pulls every object in `live_bucket`, encrypts each to `recipient`, and
writes the ciphertext to `backup_bucket` under a fresh generation prefix.
Only once a fresh listing proves every one of those objects is actually
present does this run write its own manifest -- a manifest existing means
the generation it names is complete, never merely attempted. That presence
check is repeated once more after the manifest write, for concurrency; only
once BOTH hold does this run delete every generation under this tenant's
own prefix that is strictly older than its own (see the module overview
above for why this mirrors the tenant's media in place without a map, a new
secret, or a lock, and why it stays correct under two overlapping runs of
the same tenant). May also raise `MediaBackupClockSkewError` -- this run's
own backup already succeeded and is durable by that point; that error only
ever reports that some OTHER generation's clock leaves it sorting newer, so
restore will not read this run's backup as the current one.

Refuses -- raising `MediaBackupFloorError` and writing nothing -- if the
live bucket lists zero objects, UNLESS `confirm_tenant_has_no_media` is
explicitly `True`. That flag is not a convenience default: passing it is
how a caller who genuinely knows this tenant has no media (a brand-new
promotion, checked against the promotion record, never inferred from the
listing being empty) says so, and only that assertion is allowed to write a
manifest recording zero objects -- which is also the only kind of empty
manifest `restore_tenant_media` will accept as a real restore rather than
refuse outright. The flag is itself refused -- raising
`MediaBackupConfirmedEmptyConflictError`, writing and deleting nothing -- if
a previous generation for this tenant already holds objects: it is meant
for a tenant with no previous generation at all, not for emptying one that
exists.

## backup_tenant_media: pre-upload orphan sweep

This shape check would abort the run anyway, at the presence checks below
-- checking it now, before uploading anything, means a persistent version
of that failure costs one listing per run, not a full re-upload of the
tenant's media every time it recurs. The same listing also reclaims any
ORPHANED generation (objects with no manifest -- an aborted or a
still-uploading-when-overtaken run) that sorts strictly before the NEWEST
generation this same listing already shows a manifest for -- never merely
"older than this run's own id" (see the module overview's "Generations, the
ordering guarantee" section for why that alone would be unsafe), and
nothing at all when this listing has no manifest anywhere. This sweep alone
does NOT bound a persistently failing run's own leftover uploads: those
sort AFTER the newest manifested generation, not before it, so they are
never this sweep's to reclaim. That bound is this function's own
best-effort clean-up of this run's pre-manifest uploads on failure, below.

An orphan (no manifest in THIS listing) is only reclaimed here when it
sorts before the newest generation this same listing already shows a
manifest for -- such an orphan can never become the tenant's newest
restorable generation, because a newer, already-complete one exists in the
same snapshot. An orphan that does not clear that bar cannot be ruled out
this way: this listing is a snapshot, and the run that owns it may write
its own manifest moments after the listing was taken, becoming the newest
verified generation while this sweep's deletes are still in flight -- so
this listing having no manifest at all means nothing here is reclaimed.

## restore_tenant_media

By default, restores this tenant's NEWEST generation (the highest-sorting
run id with a manifest present). Pass `run_id` to restore a SPECIFIC
generation instead -- the one case this never does on its own: if the
newest generation fails verification, this never silently tries an older
one. Raises `MediaRestoreVerificationError` naming the newest OLDER
generation that has a manifest (if any) and the exact `--run-id` command to
restore from it explicitly; a caller that wants that older data has to ask
for it by name. `run_id` requested explicitly but not found, or no
generation with a manifest at all, both raise the same way. Otherwise
raises -- and returns nothing, the RETURN VALUE never partial -- on the
first object that is missing from the backup bucket, that decrypts to
different bytes than the manifest recorded, or that the given identity
cannot decrypt at all; also raises if the manifest names zero objects
without `deliberately_empty: true`, the same R4 shape as a missing or
corrupt object. When `target_bucket` is given, each object already
verified before a later failure has ALREADY been written there -- a
partial restore on disk is real and intended (the objects that did verify
are genuinely recovered), only the return value and exit code are
all-or-nothing. Each object's backup-bucket key comes from `backup_id` in
the manifest, never derived from the live key here; the live key itself is
only ever used as the write path into `target_bucket`, and is checked by
`_assert_safe_live_key` immediately before that write -- a decrypted
manifest is not thereby a trusted one.
