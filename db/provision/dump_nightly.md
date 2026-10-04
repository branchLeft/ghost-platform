# dump_nightly.py

## Overview

Nightly logical dump of every database on db1, encrypted client-side and
shipped to Object Storage.

Run by `branchleft-db-dump.timer` via `branchleft-db-dump.service`, as root
on db1. Reads `DB_DUMP_MYSQL_PWD`, `AGE_RECIPIENT_PUBLIC_KEY`,
`DB_BACKUP_BUCKET`, `DB_BACKUP_ENDPOINT`, `DB_BACKUP_REGION`,
`AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` from the environment --
`/etc/branchleft/db.env` via the unit's `EnvironmentFile`.

Connects over the Unix socket bind-mounted out of the mysql container
(`./run/mysqld:/var/run/mysqld` in `db/stack/compose.yml`) as the dedicated
`backup`@`localhost` account -- never TCP, so this never depends on
`bind-address` covering a loopback or private address for this account.

The dump lands in a directory `tempfile` deletes on the way out, on every
exit path including a failure partway through: nothing this script writes
to disk is ever the encryption key or an unencrypted dump that outlives the
run. Object Storage is the only place a dump persists -- there is no "last
dump" kept locally to fall back on, so a failed run is retried whole by the
next scheduled one rather than resumed.

## The snapshot

The dump's first line is the binary-log resume point, in the commented
form `--source-data=2` used to write and the PITR restore drill reads:
`-- CHANGE MASTER TO MASTER_LOG_FILE='…', MASTER_LOG_POS=…;`.
`--source-data` itself is no longer passed: it takes
`FLUSH TABLES WITH READ LOCK`, and a flush stuck behind any tenant's long
query stalls writers on that query's table for as long as the query runs,
even after the flush is killed or times out. The snapshot and its
position come from `bounded_snapshot.py` instead: `LOCK TABLES … READ` on
every base table of every user schema, with the wait bounded by the
server, the hold bounded by this script, abort and retry, and a loud
failure after the last retry. See bounded_snapshot.md.

The lock covers user schemas only. `mysql` and `sys` are still dumped
from the same snapshot; only an account change made in the instant of the
hold falls outside the position.

The `backup` account needs `LOCK TABLES` (already granted) and
`BACKUP_ADMIN`, and no longer needs `RELOAD`. Until db1's grant is
changed, this script fails loudly at the position read: the grant change
and the copy of this directory to db1 are delivered together, by hand.

Object keys are namespaced under MySQL's own `@@server_uuid`, which the
server mints fresh whenever its data directory is created from scratch --
exactly the host-loss/rebuild case where binlog and dump numbering would
otherwise restart from the same names an earlier incarnation already used.
Without the namespace, a rebuild's first dump would silently overwrite the
pre-rebuild archive under an identical key.
