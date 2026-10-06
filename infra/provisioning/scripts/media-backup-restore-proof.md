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
- `DATED-1` a second backup run adds a new dated generation and deletes
  nothing: the first generation's ciphertext is still in the bucket, the
  object count grows, and restore still verifies with two copies present
- `DATED-2` a newer copy whose completion marker (the manifest) is missing
  is ignored: restore reads the newest complete copy, and succeeds again
  once a clean run writes a new one

Plus one direct check outside the RED/GREEN frame: restoring with a
different tenant's identity is refused (the crypto-shredding property).

Local-sandbox simplifications, never production shape: one MinIO root
credential stands in for the live/backup/target custody split
`render-media-bucket-policy.py` enforces for real (IAM scoping is that
script's own proof, not this one's); MinIO's self-signed TLS cert is
trusted via `SSL_CERT_FILE` rather than a real CA, because
`db/provision/objectstorage.py`'s `request_url` is deliberately hardcoded
to `https` (Hetzner's endpoint always is) and this proof exercises that
same unmodified code, not a plaintext-HTTP shortcut. The backup job never
deletes, so this proof exercises no deletion by it (its own `delete`
helper only simulates a missing marker or destroys the live bucket); expiry
of old copies is the bucket lifecycle's job, proven against real Hetzner
Object Storage by `RUNBOOK-media-backup-lifecycle.md`.

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
