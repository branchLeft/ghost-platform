# media_backup_held_proof.py

## Module overview

A driver for the held-media backup proof in
`adapters/scanning-storage/test/unit/held-media-backup.test.mjs`. That test
holds, refuses and promotes uploads through the real scanning storage
decorator, with a directory standing in for the live bucket. This driver then
runs the real `backup_tenant_media` and `restore_tenant_media` over that
directory and over two more (the backup bucket and an empty restore target),
with real `age` and a throwaway identity made in `--key-dir`.

It touches no network, bucket or host. The three commands print one JSON
object:

- `backup`: backs up the live directory as a new generation and prints its
  `run_id` and the live keys it backed up.
- `restore`: restores the newest generation (or `--run-id`) into an empty
  directory, checksum-verifying every object, and prints the keys written.
- `inspect`: decrypts every ciphertext under the backup directory, manifests
  included, and prints each one's SHA-256, so a test can search the backup
  itself for a trace and not only what a restore wrote.

## DirectoryObjectStore

The five storage calls `media_backup_restore` makes, over directories. A key
is the file's path under the bucket's directory. Whatever sits under the live
directory is a live object, which is the property the proof leans on: if the
held area were placed under it, the backup would read it.
