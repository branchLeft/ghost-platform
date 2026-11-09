# copy_media_bucket.py

## Overview

Copies every object in one Object Storage bucket to another bucket, for the
media move off hel1 (branchLeft/workspace#1606, media row of the migration
in LLD-10). It prints the object count, the copied and already-identical
counts, the total bytes and the copy duration.

## Read-only source, by construction

- The source is wrapped in `ReadOnlyBucket`, which has `list_keys` and `read`
  and no write or delete method. The copy function is typed against a
  `SourceStore` protocol that declares only those two methods.
- The destination is `WritableBucket`: list, read and put. Nothing in this
  module deletes anything.
- Credentials come from the environment (`COPY_SOURCE_ACCESS_KEY_ID`,
  `COPY_SOURCE_SECRET_ACCESS_KEY`, `COPY_DEST_ACCESS_KEY_ID`,
  `COPY_DEST_SECRET_ACCESS_KEY`), never from argv. The secret is excluded from
  the address `repr`.
- The same bucket name on the same endpoint is refused as source and destination.

## Checksums and re-runs

- Every copied object is read back from the destination and its SHA-256 is
  compared with the source bytes. A mismatch fails the run.
- A destination object already present with identical bytes is skipped, so a
  re-run after a dropped connection is safe. A destination object that differs
  is refused, never overwritten.
- The tool does not retry on its own. Re-run the whole command.

## Tests

`test_copy_media_bucket.py` runs against in-memory fakes with no network:

```
cd infra/provisioning/scripts && python3 -m unittest test_copy_media_bucket -v
```

The source fake declares no write or delete method and records each call. A
test asserts the copy only lists and reads the source. Sabotage: a
`source.write(key, data)` line added to `copy_bucket` turned the suite red
(6 errors, `AttributeError` on the source), and removing it restored green.

## Shared SigV4 client

The list, get and put calls go through `shared_objectstorage.py`, which loads
the one SigV4 implementation in `db/provision/objectstorage.py`. No second
signer is written here.
