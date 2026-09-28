# media-backup-restore-proof.sh

## Header overview

Live proof that media backup/restore round-trips real bytes: a real,
pinned Ghost 6.55.0 container (this repo's own image, its built-in
S3Storage adapter, no mocks) uploads a real image to a real S3-compatible
store; media_backup_restore.py's real CLI entry points back it up,
encrypted to a real `age` identity, and restore it after the source is
genuinely destroyed; a fresh SHA-256 of the restored bytes is compared
against the original upload's digest.

09-backup-and-recovery.html's own control (a Ghost pointed at an empty
database serves HTTP 200) is why this proof never treats "the restore
command exited 0" as the assertion -- every round below checks the
recovered bytes' digest, and every sabotage checks that the wrong outcome
is caught rather than reported as success.

Nine rounds:

- `GREEN-1` real backup + restore, genuine destroy in between, digest match
- `RED-1` a corrupted backup object must fail the restore -> repaired
- `RED-2` a missing backup object must fail the restore -> repaired
- `RED-3` a backup that captures zero objects must refuse BY DEFAULT;
  only an explicit, loudly-named flag allows a genuinely empty tenant
  through, and restoring THAT stays a legitimate success
- `RED-4` the CLI's own exit code, disconnected from the verification it
  just ran, must be caught as a wiring defect -> reverted
- `RED-5` a second age recipient in a ciphertext's own header must be
  refused, even though `encrypt_with_age`'s argv never carries one ->
  reverted
- `RED-6` a backup id derived from the plaintext digest -- a content
  fingerprint that survives crypto-shredding, since it needs no key to
  recompute -- must not appear in the backup bucket's listing -> reverted
- `C-REFRESH-1` a second backup run replaces the first: a fresh random
  key, the first generation's ciphertext genuinely gone (not merely
  unreferenced), object count never grows across a run, and restore still
  verifies afterwards
- `C-REFRESH-2` an upload failing partway through a run must leave the
  PREVIOUS generation's objects untouched and still restorable --
  sabotage the module's own upload call to fail on the second object ->
  reverted
- `CONCURRENT-1` two REAL, overlapping CLI `backup` invocations against
  the same tenant, launched as genuinely parallel OS processes against
  the same live Ghost/MinIO sandbox -- nothing is deleted out from under
  a still-restorable generation, and restore succeeds afterwards
  regardless of which process actually finished last
- `LOSSY-PUT` an object PUT that answers success without the object
  actually landing must be caught, before this run's own manifest is
  ever written -- so a default restore afterwards still succeeds,
  reading the untouched previous generation
- `MANIFEST-MISMATCH` the one failure the `LOSSY-PUT` ordering cannot
  itself prevent: a manifest PUT that reports success but stores
  different bytes. The torn manifest key DOES exist, so a default restore
  must refuse it rather than invent a fallback -- and must name the
  newest OLDER generation and the exact `--run-id` command that recovers
  it, which this round then runs for real

Plus one direct check outside the RED/GREEN frame: restoring with a
different tenant's identity is refused (the crypto-shredding property).

Local-sandbox simplifications, never production shape: one MinIO root
credential stands in for the live/backup/target custody split
`render-media-bucket-policy.py` enforces for real (IAM scoping is that
script's own proof, not this one's); MinIO's self-signed TLS cert is
trusted via `SSL_CERT_FILE` rather than a real CA, because
`db/provision/objectstorage.py`'s `request_url` is deliberately hardcoded
to `https` (Hetzner's endpoint always is) and this proof exercises that
same unmodified code, not a plaintext-HTTP shortcut. C-refresh's own
delete step is a plain `DELETE` against MinIO too -- MinIO turns that into
a delete marker on a versioned bucket the same way Hetzner does, but this
proof does not itself enable bucket versioning on `backup`/MinIO, so here
it is a genuine removal; the noncurrent-version survival window is what
`probe-media-lifecycle-expiration.py`'s prefix-split mode proves against
real Hetzner Object Storage instead.

Prerequisites on the workstation running this: `docker`, `age`
(`age-keygen`), `openssl`, `curl`, `jq`, `python3`, `comm` (present in
every base macOS/Linux install). Pulls `quay.io/minio/minio` and
`quay.io/minio/mc` (Docker Hub's `minio/minio` now refuses anonymous
pulls).

Usage: `./infra/provisioning/scripts/media-backup-restore-proof.sh` -- run
from anywhere, it cds to the repo root itself.

## resolve_run_id

Every run gets its own generation prefix
(`media/tenant-a/generations/<run id>/`), and backup ids are RANDOM within
it -- see media_backup_restore.md#module-overview. Re-running a backup --
every "repairing" step below does exactly that -- gives the SAME live
object a DIFFERENT generation and a DIFFERENT backup key each time. A
`BACKUP_KEY` (or a run id) computed once at the top of this script would go
stale the moment the first repair ran, silently sabotaging every sabotage
after it: corrupting or deleting a key from a generation that has since been replaced
touches nothing the CURRENT manifest points at, and the restore that
follows "passes" for the wrong reason. Resolved fresh, from the NEWEST
generation's manifest, immediately before each use instead.
