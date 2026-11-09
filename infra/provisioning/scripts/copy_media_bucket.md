# copy_media_bucket.py

## Overview

Copies every object in one Object Storage bucket to another bucket, for the
media move off hel1 (the media row of the migration plan). It prints the
object count, the copied and already-identical counts, the total bytes and
the copy duration.

Flags:

- `--dry-run` lists the source and destination, prints what would be copied
  and what is already present, and exits 0 without reading object bytes or
  writing anything. Use it to check the destination before the first write.
- `--allow-empty` accepts an empty source listing as a successful copy. Without
  it, an empty listing exits 1, since a wrong bucket or prefix looks like that.

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

- Each object keeps its stored Content-Type. The source is read with
  `get_object_with_content_type` and the type is passed to `put_object`. A
  copy that stored an image as `application/octet-stream` would not render in a
  browser, so the type is part of the copy, not an extra.
- Every copied object is read back from the destination and its SHA-256 and
  Content-Type are compared with the source. A mismatch fails the run (exit 1).
- A destination object already present with identical bytes and Content-Type is
  skipped, so a re-run after a dropped connection is safe. A destination object
  that differs in either is refused, never overwritten.
- The tool does not retry on its own. Re-run the whole command.
- Each object is held whole in memory, read from the source and then read back.
  That is fine for media-sized objects; a very large object needs a streaming copy.

## Tests

`test_copy_media_bucket.py` runs against in-memory fakes with no network:

```
cd infra/provisioning/scripts && python3 -m unittest test_copy_media_bucket -v
```

The source fake declares no write or delete method and records each call. A
test asserts the copy only lists and reads the source. Sabotage: a
`source.write(key, data)` line added to `copy_bucket` turned the suite red
(6 errors, `AttributeError` on the source), and removing it restored green.

Content-Type sabotage: removing `content_type=obj.content_type` from
`WritableBucket.write` turned the suite red (the adapter test that asserts the
type reaches `put_object` errored), and restoring it returned the suite to 27
green.

## Shared SigV4 client

The list, get and put calls go through `shared_objectstorage.py`, which loads
the one SigV4 implementation in `db/provision/objectstorage.py`. No second
signer is written here.
