# media_backup_restore.py

## Module overview

Back up one tenant's live media to the backup bucket, and restore it back
-- proving the *bytes*, not that the objects merely exist.

Backup is put-only against the backup bucket. Each run writes a new dated
generation and issues no list, read or delete there, because the backup key
is put-only; old generations are removed by the bucket's lifecycle rule on
`media/`, never by this module. Restore, run with the read-only key, is where
the bytes are proven.

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
healthy backup until someone needs to restore from it. The flag exists for a
brand-new promotion with no previous generation, and the put-only key cannot
list the backup bucket to check that, so the caller carries the whole of that
check. A confirmed-empty copy written for a tenant that does have media would
be the newest complete copy; restore it past by naming an older `--run-id`.

### Dated copies, a completion marker, and no delete

Every run uploads a complete new set under a FRESH generation prefix, then
writes that generation's manifest as the last PUT of the run. The manifest is
the completion marker: it exists only once every object PUT of the run has
returned success, so a generation without one is incomplete (a run that died
or is still uploading) and `restore_tenant_media` never reads it, whether it
asks for the newest or names it with `--run-id`. Nothing is ever deleted: not
an older generation, not a failed run's partial upload, not a stale object.
Two overlapping runs of the same tenant therefore cannot interfere, since
neither removes anything the other wrote, and restore reads the newest
generation that has its marker.

The put-only key also cannot read back, so this module does not re-list the
backup bucket or re-read its own manifest. A PUT that answers 2xx is not
proof of persistence, and that proof now lives in restore, which decrypts
and checksums every object a manifest names; a restore drill with the
read-only key is what shows a copy is whole. A copy whose manifest exists but
whose objects are missing fails that restore, which names the newest older
generation and the command to restore it explicitly.

Storage is bounded by the bucket, not this module: the `media/` lifecycle rule
(`db/provision/configure_backup_bucket.py`) expires current copies after the
retention figure and removes the noncurrent version that leaves behind. Objects
expire individually, a few minutes ahead of their generation's manifest, so a
copy at the very end of its retention can have objects gone while its manifest
remains; restore reports that as a verification failure, never as a success.

Run ids come from the host clock, and restore picks the highest id. A run on a
clock ahead of real time would shadow later correct runs until they overtake
it; the put-only key cannot list to notice, so the restore drill is where it
would show.

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

## backup_tenant_media

Pulls every object in `live_bucket` (with the live credential), encrypts each
to `recipient`, and writes the ciphertext to `backup_bucket` under a fresh
dated generation, then writes the generation's manifest last as its
completion marker. The only calls made against `backup_bucket` are PUTs, so
the put-only key is enough. It never deletes, anywhere.

Refuses -- raising `MediaBackupFloorError` and writing nothing -- if the
live bucket lists zero objects, UNLESS `confirm_tenant_has_no_media` is
explicitly `True`. That flag is not a convenience default: passing it is
how a caller who genuinely knows this tenant has no media (a brand-new
promotion, checked against the promotion record, never inferred from the
listing being empty) says so, and only that assertion is allowed to write a
manifest recording zero objects -- which is also the only kind of empty
manifest `restore_tenant_media` will accept as a real restore rather than
refuse outright.

## restore_tenant_media

By default, restores this tenant's NEWEST complete generation (the
highest-sorting run id with a manifest present; a generation without one is
incomplete and ignored). Pass `run_id` to restore a SPECIFIC
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
