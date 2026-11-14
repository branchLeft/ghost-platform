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

The dump is taken one user schema at a time, in name order. Each schema's
snapshot comes from `bounded_snapshot.py`: `LOCK TABLES … READ` on that
schema's base tables and no others, with the wait bounded by the server, the
hold bounded by this script, abort and retry, and a loud failure after the
last retry. See bounded_snapshot.md. Under the lock it reads the binary-log
position and opens `mysqldump --single-transaction --databases <schema>`,
then unlocks; the next schema's snapshot starts when that dump has finished.
`FLUSH TABLES WITH READ LOCK` is never taken: `--source-data` is no longer
passed because it takes it, and a flush stuck behind any tenant's long query
stalls writers on that query's table for as long as the query runs, even
after the flush is killed or times out.

**No lock names tables of two schemas.** One statement over every schema made
every tenant wait for the slowest one, and a retry for any tenant's timeout
re-locked all of them. Now a tenant's tables are locked once per attempt, and
an attempt is repeated only for that tenant's own contention. What this does
not remove: a multi-table write transaction of the schema being locked that
holds a later table and asks for an earlier one is still the deadlock victim
(error 1213) of that schema's own `LOCK TABLES`, because the server locks in
name order and rolls the transaction back, not the lock request. That
exposure is bounded (one schema, up to the attempt limit in
bounded_snapshot.md) and not zero. Removing it needs a snapshot that takes no
table lock at all.

Each section opens with its own resume point, ahead of the schema's dump:
`-- BRANCHLEFT-SECTION CHANGE MASTER TO MASTER_LOG_FILE='…', MASTER_LOG_POS=…;`.
It is not the bare `-- CHANGE MASTER TO …` comment `--source-data=2` wrote, so
a reader that only knows the bare form finds none and refuses, instead of
replaying every schema from the first schema's position. The first section
also carries `mysql`, `sys` and any user schema with no base table, which are
never locked (they have nothing a tenant writes, or nothing to lock), so
those are governed by the first section's position, as they were by the one
position before.

### What a restore can rely on

Kept: every user schema's dump is a consistent snapshot at the binary-log
position written in front of it, so point-in-time recovery of one tenant
works exactly as before, and `extract_tenant_binlog.py` reads that tenant's
own position (the section that declares the schema). A host-loss restore
(load the dump, no binlogs) still brings back every schema in one file under
one object key, with `mysql` and `sys` included. An instance-level
point-in-time restore is `extract_tenant_binlog.py --all-databases`
(`db/RUNBOOK-db.md`, Drill A): an instance pass for the account statements
and the databases created since the dump, which no per-database replay can
carry, then each database from its own position, all to the same stop time.
extract_tenant_binlog.md#the-instance-pass says why it is safe to apply.

Changed: the schemas are no longer all at one instant. Each is consistent
with itself and with its own position; nothing relates one tenant's snapshot
to another's, and no tenant's data spans two schemas. A replay from one
position over every schema, as the single header allowed, would now apply
events a later section already holds, which is why the one shared comment is
gone.

A schema that no longer exists when its turn comes is left out and named on
stderr, but only after the server confirms it is gone; a schema that merely
cannot be locked fails the whole run, as one that could not be locked always
did. A schema created after the run listed them is not in that night's dump,
as one created after a single snapshot never was.

The lock covers user schemas only. `mysql` and `sys` are still dumped from
the first section's snapshot; only an account change made in the instant of
the hold falls outside the position.

The `backup` account needs `LOCK TABLES` (already granted) and
`BACKUP_ADMIN`, and no longer needs `RELOAD`. Without that grant this script
fails loudly at the position read: the grant change and the copy of this
directory to db1 are delivered together, by hand.

Object keys are namespaced under MySQL's own `@@server_uuid`, which the
server mints fresh whenever its data directory is created from scratch --
exactly the host-loss/rebuild case where binlog and dump numbering would
otherwise restart from the same names an earlier incarnation already used.
Without the namespace, a rebuild's first dump would silently overwrite the
pre-rebuild archive under an identical key.

## Metrics

Each run writes `dump_nightly_lock_bound.prom` to `DB_DUMP_METRICS_DIR`
(default `/var/lib/branchleft/backup-worker-exporter`). It uses the same
metric names the control host's worker publishes, under
`tenant="db1-all-databases"`: `backup_worker_lock_wait_seconds`,
`backup_worker_lock_hold_seconds` and the cumulative
`backup_worker_lock_aborts_total`, which a failed run still advances. With
one snapshot per schema, the two gauges are the worst single schema's wait and
hold in the run, and the counter adds up every schema's aborted attempts.
Writing is best-effort: a metrics failure never fails the dump.

### Run status

Each run also writes `dump_nightly_status.prom` to the same directory, through
`record_run_status`, once the run has ended:

| Metric | Meaning |
| --- | --- |
| `db_nightly_dump_last_run_success` | `1` if the latest run stored a dump, `0` if it failed for any reason, including a missing setting or an unexpected error. |
| `db_nightly_dump_last_success_timestamp_seconds` | Unix time the last stored dump finished uploading. A failed run carries the previous value forward; it is absent until a first success. |

The names deliberately differ from the control host's worker series, so that
series can never mask this one's absence. The file is written beside the
lock gauges, not into them, so that writer is untouched.

The write comes after the upload and the `wrote ...` journal line, is
atomic (a temporary file in the same directory, then rename, mode 0644) and
is best-effort: any error is printed to stderr and swallowed, and never
changes the run's exit status. An empty `DB_DUMP_METRICS_DIR` turns it off.

### Who reads it

db1's node_exporter (the `node_exporter` role in shared-infra's `ansible/roles/`) reads this directory through its textfile collector. The install
steps are the ghost-platform-docs page `db1-node-exporter-install-runbook.md`.
The alert rules `DbNightlyDumpFailed`, `DbNightlyDumpStale` and
`DbNightlyDumpMetricAbsent` live in shared-infra's
`hetzner/monitoring/render.ts`. The thresholds there follow the timer: 03:00
UTC plus up to 5 minutes of random delay, and the unit's 30 minute timeout, so
a healthy run finishes by about 03:35 and a metric older than 30 hours means a
night was missed. The rules read these files only once db1's node target
answers; whether it does today is read from Prometheus, not from this file.
