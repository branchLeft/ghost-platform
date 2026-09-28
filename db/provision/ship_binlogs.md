# ship_binlogs.py

## Module overview

Ships every closed binary log db1 is holding to Object Storage.

Run frequently (every 15 minutes, via `branchleft-db-binlog-ship.timer`) so
the RPO on host loss stays close to that interval rather than the 24h a
dump-only design would otherwise leave. `FLUSH BINARY LOGS` rotates to a
fresh file on every run, so the log that was open a moment ago becomes
closed and shippable on the very next run; nothing here ever reads from the
file MySQL is currently writing.

Connects over the Unix socket bind-mounted out of the mysql container
(`./run/mysqld:/var/run/mysqld` in `db/stack/compose.yml`) as the dedicated
`replicator`@`localhost` account -- never TCP.

A local marker file (`--marker-path`, default under
`/var/lib/branchleft-db-binlog-ship/`) records the server incarnation
(`@@server_uuid`) and name of the last binlog shipped, so a run resumes
exactly where the previous one stopped rather than re-shipping or skipping.
The incarnation is part of the marker, not just the name, because MySQL
mints a fresh `server_uuid` whenever its data directory is created from
scratch, and binlog numbering restarts from `mysql-bin.000001` at the same
time -- a marker naming a log from a *previous* incarnation could otherwise
coincidentally match a same-named log the new incarnation reaches later,
silently skipping everything shipped in between. Object keys carry the same
incarnation prefix for the mirror-image reason: two incarnations' same-named
logs must never resolve to the same object.

`mysqlbinlog --raw --read-from-remote-server` reads the byte-identical file
over the replication protocol, which is what makes this possible with no
filesystem access to the `mysql-data` volume at all -- this script never
runs inside the MySQL container and never needs to.
