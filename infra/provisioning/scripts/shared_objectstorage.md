# shared_objectstorage.py

## Module overview

`db/provision/objectstorage.py` signs every request db1's backup pipeline
makes against Hetzner Object Storage. `verify-bucket-fence.py` needs exactly
that signing, against exactly that endpoint, and imports it from here rather
than carrying a copy: two copies of a security-sensitive signing
implementation is how one of them silently rots while the tests keep passing
against the other. `media_backup_restore.py` — the org/control-side worker
that pulls a tenant's live media, encrypts it and reads it back on restore —
is the same shape of caller and re-exports the named operations
(`get_object`, `put_object`, `list_objects`, `delete_object`) for the same
reason `verify-bucket-fence.py` re-exports `signed_request`.

It is imported by path rather than moved somewhere both trees can see.
`db/RUNBOOK-db.md` provisions db1 by copying `db/provision/` to the host with
`scp -r` and running the scripts in place; the dump, binlog-shipping and prune
units all import `objectstorage` as a sibling of themselves. Relocating the
file into a shared parent would leave the next copy of that directory shipping
a module whose import is not beside it, and the symptom would be a backup
pipeline that stops at the next redeploy rather than a failure here.

`importlib` rather than a `sys.path` entry, so that importing this module does
not put every other file in `db/provision/` on the import path of a script that
has no business reaching them.
