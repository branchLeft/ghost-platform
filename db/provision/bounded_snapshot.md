# bounded_snapshot.py

## Module overview

Every nightly backup needs two things at one instant: a consistent
snapshot of the data, and the binary-log position that snapshot matches,
so point-in-time replay knows where to start. `mysqldump --source-data=2`
gets both by taking `FLUSH TABLES WITH READ LOCK`, an instance-wide lock.
This module gets both without it, and without any lock whose wait or hold
can stall a writer for more than two seconds.

It is the one implementation of the snapshot. Both nightly paths run it:

- the per-tenant path on the control host
  (`branchleft-backup-worker.timer` → `nightly_dump_loop.py` →
  `RemoteMysqldumpTransport`), which locks one tenant's tables;
- db1's own all-databases dump (`branchleft-db-dump.timer` →
  `dump_nightly.py`), which locks every user schema's tables.

## Why not FLUSH TABLES WITH READ LOCK, even with a timeout

Measured on the pinned server digest (8.0.46) with
`db/stack/conf.d/branchleft.cnf`: a `SELECT SLEEP(15)` reading one table,
then `SET lock_wait_timeout = 1; FLUSH TABLES WITH READ LOCK` from another
session. The flush gave up after 1.35 s, as configured. A writer on a
second schema stalled 0.99 s. **A writer on the table the long query was
reading stalled 12.06 s, after the flush had already given up.** The flush
marks the table's open instance as old before it waits; every later
statement on that table then waits for the long query to close it, whatever
became of the flush. Killing the flush has the same effect. So a watchdog
or a timeout on `FLUSH TABLES` bounds the global lock but not the stall,
and this module never issues `FLUSH TABLES` of any kind.

## The technique

One coordinator session (a `mysql` client this module drives over its
stdin) and one dump session (`mysqldump`), both as the backup account.

1. Coordinator: `SET SESSION lock_wait_timeout = 1` and
   `SET SESSION wait_timeout = 2`, then `SELECT CONNECTION_ID()`.
2. Coordinator: list the base tables to lock from
   `information_schema.TABLES`: one tenant's schema, or every schema except
   `mysql`, `sys`, `performance_schema` and `information_schema`.
3. Coordinator: `LOCK TABLES … READ` on exactly those tables. This takes
   no flush. A long-running read does not block it, because a read lock
   and a running read are compatible. It waits only for write
   transactions in flight on those tables, and while it waits, new writes
   to them queue behind it. That wait is what the bounds below limit.
4. Under the lock: list the tables again (a mismatch aborts the attempt),
   then read `SELECT LOCAL FROM performance_schema.log_status` for the
   binary-log file and position.
5. Start `mysqldump -v --single-transaction …` with no `--source-data`,
   no `--flush-logs` and no `--lock-*` option: it then issues no flush
   and takes no lock. `-v` makes it print `-- Setting savepoint...` on
   stderr straight after its `START TRANSACTION WITH CONSISTENT SNAPSHOT`
   has returned, before it reads any table. That line is the positive
   signal the snapshot is open; nothing here sleeps and hopes.
6. Coordinator: `UNLOCK TABLES`, then the session ends. The dump carries
   on inside its snapshot with no lock held.
7. The caller writes `-- CHANGE MASTER TO MASTER_LOG_FILE='…',
   MASTER_LOG_POS=…;` as the first line of the dump: the exact form
   `extract_tenant_binlog.py`'s `SOURCE_DATA_PATTERN` parses.

**Why it is consistent:** while the coordinator holds `READ` on every
locked table, no transaction that writes them can be in flight or start.
`LOCK TABLES` is granted only once each such transaction has committed,
and with `sync_binlog = 1` a commit is in the binary log before it
returns. The dump's snapshot opens while the lock is held, so for the
locked tables it equals the state at the position read in step 4. Tables
outside the lock (another tenant's, on the per-tenant path) may move on,
and point-in-time replay filters them out by schema.

## The bounds

| Bound | Value | Enforced by |
|---|---|---|
| Wait for the lock, per table | 1 s | the server: `lock_wait_timeout`, error 1205 |
| Wait for the lock, overall | 1.2 s | this module: `KILL CONNECTION <coordinator id>` |
| Hold, grant to confirmed unlock | 0.6 s | this module: abort and `KILL CONNECTION <coordinator id>` |
| Hold if this process vanishes | 2 s | the server: the coordinator's `wait_timeout` |

A writer that arrives just as the lock is requested waits at most the
overall wait plus the hold: 1.8 s. Every abort ends the coordinator
session, then backs off (1, 2, 4, 8 s) and retries, up to five attempts,
and then fails loudly. Nothing is written to the dump before an attempt
succeeds, so a retry never leaves a partial dump behind.

The `KILL` names the coordinator's own connection id, read from the
coordinator itself, and nothing else: never a thread matched by user or
statement text. Connection ids are not reused while the server runs, so a
`KILL` sent after the session already ended finds nothing (error 1094,
treated as released). Every kill call has its own timeout. If a kill can
neither be confirmed nor be shown unnecessary, the run stops instead of
retrying. The server still drops the session after two idle seconds.

The values are incidental; `test_the_default_bounds_keep_a_writer_under_two_seconds`
pins the relationship between them.

## What is not locked

- **`mysql`, `sys` and the two virtual schemas.** Account changes made in
  the instant of the hold are not covered by the position. The dump still
  reads them from its snapshot.
- **DDL after the unlock.** `LOCK INSTANCE FOR BACKUP` is not taken, so
  no tenant's DDL, such as a Ghost upgrade's migration, ever waits on a
  backup. A table altered or dropped while mysqldump is reading makes
  mysqldump fail ("Table definition has changed"), which fails that dump
  loudly. A table created in the dumped schema between the lock and the
  end of the dump is the residual case.

## Grants

`SELECT`, `LOCK TABLES`, `SHOW VIEW` and `TRIGGER` on what is dumped, and
`BACKUP_ADMIN` for `performance_schema.log_status`. `RELOAD` is no longer
needed, so neither backup account can take a global read lock at all.
`PROCESS` is not needed on the per-tenant path, which passes
`--no-tablespaces`. Changing the grants on db1 is a hand-delivered step;
its commands live in the ghost-platform-docs runbook, not here.
