# test_media_backup_restore.py

## Module overview

Unit tests for media_backup_restore.py.

No real network here -- `list_objects` / `get_object_with_content_type` /
`get_object` / `put_object` / `delete_object` are injected as fakes, so
these tests pin the module's own logic (the floor, the checksum comparison,
per-tenant isolation, key-opacity, the recipient-count guard, the
dated-generation layout, the put-only no-delete rule and the completion marker) rather than
re-proving the SigV4 signer (`test_objectstorage.py` already does that).
`age` itself IS real in `RecipientStanzaCountTests` -- the count this
module trusts is checked against real `age` output, not only against a
value this file invents -- and in `EncryptWithAgeArgvTests`, which captures
the real argv a fake `run` receives. The full chain -- real MinIO, real
Ghost, the CLI's own exit code, and a live reproduction of a
second-recipient ciphertext -- is proven by `media-backup-restore-proof.sh`.

## PutOnlyBackupTests

Backup runs through the REAL signing and request code against a fake S3
endpoint patched in for `urllib.request.urlopen`, where the backup bucket
answers 403 to anything but a PUT, as the put-only key's fence does. Every
request is recorded, so the tests can say that no DELETE is issued to any
bucket however a delete would be routed, that the backup bucket sees only
PUTs, and that the manifest is the last PUT of a run. A control test shows
the fake really refuses a delete, so a delete reintroduced into the job
fails here instead of passing unnoticed.

## NewestCompleteCopyRestoreTests

Restore picks the newest dated copy that has its completion marker (the
manifest) and ignores any copy without one, whether the copy is missing its
manifest or died after its first object. A named incomplete copy is refused,
and a complete but unreadable newest copy names the older one and the exact
`--run-id` command, never falling back on its own.
