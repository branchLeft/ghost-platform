# rewrite_media_links.py

## Overview

Rewrites every stored media link in one tenant database from the old storage
address (`https://ENDPOINT/BUCKET_NAME/`) to our own media address and the
tenant's folder (`https://MEDIA_HOST/TENANT_FOLDER/`). Ghost writes the
address into post bodies, images, settings and more, so moving media breaks
published images unless the links are rewritten.

Run it only on a drained colour. `--apply` and `--reverse` refuse without
`--confirm-drained`; nothing here can verify the colour is drained.

## Modes

- Default: dry run. Prints every link it would change as
  `table.column [key]: link`, writes nothing. Exit 1 if a blocker exists.
- `--apply --confirm-drained`: writes the backup, rewrites in one
  transaction, then re-scans every text and json column of every table for
  the old address. Any hit fails the run.
- `--reverse --confirm-drained`: restores each recorded original.

Connection: the `mysql` client over the host socket as a dedicated account,
password in `DB_REWRITE_MYSQL_PWD`, never argv. Values travel as hex, so the
bytes written back are the bytes read.

## Once

The new address may not contain the old one or the reverse, so a rewrite
never matches its own output. A second apply finds nothing, writes nothing
and leaves the first backup untouched. An apply that would change rows
refuses to overwrite an existing backup.

## Reversible

The backup is JSON lines: a header, then table, column, key, `before` and
`after` for each touched value. Reverse puts `before` back only where the row
still holds `after`; a row edited since is a conflict and nothing is
restored. A row already holding `before` is skipped, so reversing twice is a
no-op. The backup is created before any write and removed if the apply fails
and rolls back.

## Scope and refusals

Every char, varchar and text-family column of every table is rewritten, not a
fixed list, so revisions and snippets are covered. Refused up front: an old
link in a table without a primary key, or in a `json` column (the server
would reformat it, so byte-for-byte reversal is not possible). Both the plain
and the JSON-escaped (`https:\/\/`) forms are handled. A bucket that only
shares the old bucket's name as a prefix is left alone because the match
includes the trailing `/`.

## What the tests prove

`test_rewrite_media_links.py` runs on a SQLite copy with placeholder data
(`example.invalid`): none remain after apply, apply twice is a no-op, reverse
is byte for byte (full dump compared), rollback on failure, refusals. The
MySQL adapter is tested for the SQL it sends and its environment only; it has
not been run against a server.
