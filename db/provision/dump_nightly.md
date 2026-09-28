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

`--source-data=2` embeds the binlog file and position current at the start
of the dump as a *comment* -- the uncommented form (`=1`) is rejected by
`--all-databases` outright, and a comment is exactly what the PITR restore
drill needs to find where to resume binlog replay from.

Object keys are namespaced under MySQL's own `@@server_uuid`, which the
server mints fresh whenever its data directory is created from scratch --
exactly the host-loss/rebuild case where binlog and dump numbering would
otherwise restart from the same names an earlier incarnation already used.
Without the namespace, a rebuild's first dump would silently overwrite the
pre-rebuild archive under an identical key.
