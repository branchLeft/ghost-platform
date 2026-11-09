# gtid_snapshot.py

## Module overview

A per-tenant dump taken with **no lock**, and the recovery position it
carries. `bounded_snapshot.py` makes a dump consistent by holding
`LOCK TABLES ... READ` on the tenant's tables for a bounded moment, so a
tenant's writers can wait a second or two. This module takes none: one
`mysqldump --single-transaction --set-gtid-purged=ON`, no coordinator
session, no `LOCK TABLES`, no `FLUSH`, nothing to wait for, hold or release.

It is the tenant database host's path (Percona Server for MySQL). db1 stays
on `bounded_snapshot.py` until it is retired.

## Why the recovery position is a GTID set

A position (binary-log file and offset) read next to a snapshot can include a
transaction the snapshot cannot see: a transaction is written to the binary
log (it has its position) a moment before it is committed in the engine (it
is visible). A replay that starts at that position never applies it, and the
dump never held it: a committed row, silently lost. A GTID set names every
transaction by identity, so a transaction that is logged but not yet visible
is simply not in the dump's set, and the replay applies it.

The server-side half of the claim is that Percona's `mysqldump` (the client,
which must be the one on the worker's host; Oracle's 8.0.32+ client takes a
global read lock instead, which the backup account is not granted, so the
wrong client fails the dump rather than locking) reads the set
(`Binlog_snapshot_gtid_executed`, a Percona Server variable) atomically with its
`START TRANSACTION WITH CONSISTENT SNAPSHOT`, without
`FLUSH TABLES WITH READ LOCK`. That is a property of a real server, proved
against one in a container run (it needs Docker), and **a host is switched to
this mode only once that run is green**. What this repository proves in its
own tests is everything around the claim; see "How it is proved".

## What it does

1. `dump_args(db_name)`: `--single-transaction --routines --triggers
   --set-gtid-purged=ON --no-tablespaces --databases <db>`.
2. `assert_lock_free_args`: refuses, by name, `--lock-all-tables`,
   `--lock-tables`, `--source-data`, `--master-data`, `--flush-logs`,
   `--flush-privileges`, the delete-logs options, `-x`, `-l`, `-F`, any
   `--set-gtid-purged` other than `ON`, and a command missing
   `--single-transaction` or `--set-gtid-purged=ON`. A dump that is only
   consistent because something locked is not this module's dump.
3. `take_gtid_snapshot`: starts that one process through `ClientFactory` (the
   password reaches it only by inherited fd, as in `bounded_snapshot.py`).
4. `PurgedStatementScanner`: read as the dump streams, line by line. It reads
   `SET @@GLOBAL.GTID_PURGED=...` (one line or several, with or without the
   `/*!80000 '+'*/` append comment), normalises the set, and **stops at the
   first line of the dump's body** (`CREATE DATABASE`, `USE`, `INSERT`...). A
   row whose text looks like the statement can therefore never forge a
   position. Two statements, an unclosed one or a malformed set are errors.
   An empty set is a valid position (a server that has committed nothing).
   No statement at all is `NoGtidStatement`: the transport then returns a
   failure so the caller discards the dump.
5. `GtidSnapshotReport`: `recovery_gtid_set`, and the same lock fields
   `bounded_snapshot.SnapshotReport` has, all zero, so the worker's metrics
   record no wait and no hold.

`parse_gtid_set`, `format_gtid_set` and `is_subset` are the set arithmetic
`extract_tenant_binlog.py` uses to compare a dump's set with a binlog file's
`Previous-GTIDs`.

## Per-tenant recovery

One dump per tenant, one snapshot per dump, so each tenant has its own
position. The set is server-wide at the instant of the snapshot (it counts
every tenant's transactions); the replay scopes by schema with
`mysqlbinlog --database`, as before. The position is in the dump itself (and
so under the tenant's own `age` recipient), is logged by the transport, is
carried in `DumpResult.recovery_gtid_set`, and is printed per tenant by the
worker and the nightly loop. `extract_tenant_binlog.py` restores from it:
see its "Recovery position" section.

## How it is proved

`infra/provisioning/scripts/test_gtid_recovery.py`, against
`gtid_server_model.py`: an in-process model of a server's commit pipeline
(a transaction is logged, then later committed; a snapshot sees only the
committed ones; the dump header carries the set the snapshot saw) with fakes
for `mysqldump`, `mysqlbinlog` and `mysql`. It models ORDER, not an engine,
and the model encodes the server contract above rather than proving it.

- A backup taken while writes continue (writers commit and submit during the
  dump) restores to the tenant's exact state at a chosen instant, over 150
  seeded schedules and a hand-built case with two logged-not-visible
  transactions.
- **Controls, so the harness is not blind:** the retired file-and-position
  recipe loses or fails to replay in 56 of the same 150 schedules; reading the
  set after the snapshot opened loses a row in the straggler case; a locked
  schema is seen to stall a writer.
- No lock: across a run of three tenants the model records zero lock
  requests, zero global-lock attempts, zero stalled writers, and only
  `mysqldump` ever started. Against a stock server the dump fails on its own.
- Recovery position per tenant: reported, equal to the dump's own header,
  distinct per snapshot and growing.
- `extract_tenant_binlog.py`: other tenants' events never reach the restored
  tenant; a missing early binlog file and binlogs written without GTIDs are
  refused; a restore stopped inside the replay stops there.
- Each of these is proved by sabotage; the red and green runs are in the pull
  request that added this module.

## Not in scope

The container run against a real Percona server, installing Percona's
`mysqldump` on the control host, switching a host to this mode
(`BACKUP_WORKER_SNAPSHOT_MODE=gtid` in the worker's environment file), the restore
drill's scratch server (it must accept the dump's `SET @@GLOBAL.GTID_PURGED`,
so it runs with `gtid_mode=ON`), and the mutual exclusion between a tenant's
dump and its upgrade (a `--single-transaction` dump holds shared metadata
locks until it ends).
