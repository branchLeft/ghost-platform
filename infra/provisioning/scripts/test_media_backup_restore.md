# test_media_backup_restore.py

## Module overview

Unit tests for media_backup_restore.py. The module-level `backup_tenant_media`
and `restore_tenant_media` here wrap the real ones with a fake manifest signer,
so the older cases keep testing what they were written for.

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

## ManifestAuthenticityTests

The control for branchLeft/workspace#1346. A generation is forged the way a
holder of only the bucket put credential can: the attacker's own bytes encrypted
to the tenant's recipient, and a manifest with the right tenant, a fresh run id
and a digest that agrees with them. Restore must refuse it, and write nothing to
the serving bucket, when the manifest is unsigned and when it is signed with
another key; it must also refuse a genuine manifest edited after signing, one
with its signature stripped, one that is not a string, and an authentic older
manifest replayed under a newer generation. A separate test shows the
signature is checked before any other field of the manifest is acted on, and
another that neither entry point has a default for the key, so skipping the
signature is a `TypeError`. The signer is a fake that models an asymmetric
pair; the next class uses the real one.

## RealSshKeygenSignatureTests

The same property against the real `ssh-keygen -Y` binary: a signature verifies
only for its own public key, over its exact bytes, in this module's namespace,
and the public key file is refused unless it is one plain ed25519 key. One
end-to-end test runs real `age` and real signatures together. Skipped only when
`ssh-keygen` is absent.

## PutOnlyBackupTests

Backup runs through the REAL signing and request code against a fake S3
endpoint patched in for the shared opener's `open` (`_OPENER` in
`objectstorage.py`), where the backup bucket answers 403 to anything but a
PUT, as the put-only key's fence does. Every
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
