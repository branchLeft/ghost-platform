# media_backup_restore_proof_helpers.py

## Module overview

Small object-storage primitives `media-backup-restore-proof.sh` needs and
`media_backup_restore.py` deliberately does not expose -- reading one
object's digest to verify what Ghost itself wrote, corrupting a backup
object in place, counting a bucket's objects for the "genuine destroy" and
"backup skipped media" checks, and reading back the (opaque, RANDOM) backup
key or the decrypted manifest for a live key the proof uploaded -- since the
production module's own key scheme is deliberately unrelated to a live key
or its content -- a content-derived key is a fingerprint that needs no key
to recompute and so survives crypto-shredding -- the proof asks the module
for its own key rather than reimplementing the derivation.

Never imported by `media_backup_restore.py` or by anything that ships:
this is proof-only tooling, kept separate so the production module's own
surface stays exactly what the backup/restore pipeline needs and nothing a
test harness needed instead.
