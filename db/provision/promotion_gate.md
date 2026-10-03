# promotion_gate.py

## Overview

The cutover's go/no-go for promoting a replica. A cutover script calls it after
freezing the tenant's writes on the source. It passes in the source's frozen
coordinates and a command that prints the replica's `SHOW REPLICA STATUS`
vertically (`\G`). The gate answers **PROMOTE** (exit 0) or **DO NOT PROMOTE**
(exit 1, or 2 for a usage error). Anything other than exit 0 means do not
promote: take the cutover's abandon branch.

It compares positions and thread states. **It never reads
`Seconds_Behind_Source`.** A replica whose IO thread is `Connecting` receives
nothing, so its SQL thread is never behind anything it has received, and it
reports zero lag. Promoting on lag alone would lose every write made during
the outage. LLD-10 measured exactly that in its spike. On 8.0.46, stock MySQL
and Percona Server alike, the live proof below sees `Seconds_Behind_Source` as `NULL` rather
than 0 for a replica whose IO thread was restarted into `Connecting`. A
lag check that reads `NULL` as "no lag" fails the same way. The value
depends on version and on how the connection was lost, which is one more
reason the gate does not read it.

## Inputs

- **Frozen coordinates.** `--source-uuid`, `--source-log-file` and
  `--source-log-position` come from one read of `performance_schema.log_status`
  on the source, taken by the session holding the tenant's table lock:
  `SERVER_UUID`, `LOCAL->>'$.binary_log_file'` and
  `LOCAL->>'$.binary_log_position'`. The position is the end of the last event
  written, which is where the next event would start.
- **Replica status.** Everything after `--` is run as a command, once per poll.
  It must print `SHOW REPLICA STATUS` vertically. A nonzero exit, a hang
  beyond the read bound, or text the parser cannot read is a refusal.
- **`--timeout`** (required) bounds how long the gate waits for a replica that
  is behind. **`--poll`** (default 1 s) is the interval between readings.

## Decision table

Each reading gives one of three verdicts. `WAIT` polls again. A `WAIT` still
standing at the timeout becomes `ABANDON`. The rules apply in this order.

| Reading | Verdict |
|---|---|
| The status read fails, or is unparsable | ABANDON |
| Not exactly one replication channel | ABANDON |
| Any field the gate reads is missing, or a number is not a number | ABANDON |
| `Source_UUID` differs from the frozen `SERVER_UUID` | ABANDON (coordinates mismatch) |
| `Last_SQL_Errno` is not 0 | ABANDON, naming the error |
| `Replica_SQL_Running` is not `Yes` | ABANDON |
| `Replica_IO_Running` is neither `Yes` nor `Connecting` | ABANDON |
| `Relay_Source_Log_File`'s base name differs from the frozen file's | ABANDON (coordinates mismatch) |
| Executed position is past the frozen coordinates | ABANDON |
| Executed position is before the frozen coordinates | WAIT |
| Positions equal, IO thread `Connecting` or `Last_IO_Errno` not 0 | WAIT |
| Positions equal, both threads `Yes`, no errors | **PROMOTE** |

The executed position is `(Relay_Source_Log_File, Exec_Source_Log_Pos)`, the
source coordinates of the last event the SQL thread applied. File names
compare by numeric sequence, so `.1000000` sorts after `.999999`.

**Why "past the frozen coordinates" refuses.** The tenant's tables are locked,
so nothing of the tenant's can follow the frozen position. Under the stop
condition in the migration design, no other tenant schema is on the source
either. A replica past the frozen position therefore means something wrote on
the source after the freeze, or the coordinates are stale. Either way they no
longer describe the frozen state, so the gate refuses rather than guesses. A
benign source of this is a binary log rotation inside the freeze window. The
binlog-ship timer runs `FLUSH BINARY LOGS` every 15 minutes, so the cutover
should start just after a ship run. A refusal from a rotation is safe: unfreeze
and retry.

**The multi-threaded applier.** MySQL 8.0.27 and later default to four applier
workers. With them, `Exec_Source_Log_Pos` is the low-water mark: every
transaction before it has committed. Equality with the frozen position
therefore still proves every frozen-side transaction has applied. The live
proof runs with the default workers.

## Versions

The gate reads the column names MySQL 8.0.22 introduced. An older server's
`Slave_*`/`Master_*` names are missing fields, so the gate refuses. The
frozen coordinates need `performance_schema.log_status`, which is 8.0.14 or
later. `db1`'s pinned image is 8.0.46.

The tenant database host runs **Percona Server for MySQL 8.0**, so the
replica side is Percona and the source side, `db1`, is stock MySQL. Percona
prints the same `SHOW REPLICA STATUS` columns and has the same `log_status`
table, so the gate parses and decides identically against either. The live
proof below runs with a Percona 8.0.46-37 replica, and passed with a stock
MySQL 8.0.46 replica too. The gate uses no Percona-only feature. Percona's `Binlog_snapshot_file` and
`Binlog_snapshot_position` status variables give a dump coordinates
consistent with its snapshot without a lock. They do not apply here: the
cutover freezes writes anyway, and the gate compares against that freeze.

## Live proof

`prove-promotion-gate.sh` builds the source from `db1`'s pinned stock MySQL
image and the replica from a pinned Percona Server 8.0 image, each with
`db/stack/conf.d/branchleft.cnf`. Set `REPLICA_IMAGE` to run the replica on
another image, such as `db1`'s own. It sets up TLS
replication filtered to the blog's schema, as the migration design
specifies. Every scenario holds `LOCK TABLES … READ` on the blog's table in
one session, reads the frozen coordinates inside that lock, and runs the
gate as a cutover script would.

1. A healthy replica under a continuous writer: PROMOTE. The replica's row
   count equals the count read inside the freeze.
2. A wrong source UUID, a wrong binary log name, and frozen coordinates the
   replica has already passed: each refused.
3. The replica disconnected (IO thread `Connecting`), a post published during
   the outage, then the freeze: refused. The script prints the replica's
   `Seconds_Behind_Source` for the record and asserts the post is absent.
   Reconnected, the replica then promotes with the post present.
4. The replica held behind by `SOURCE_DELAY` with both threads `Yes`: refused
   at the timeout.
5. A duplicate-key conflict stops the SQL thread: refused at once, well inside
   the timeout.

Run it from the repo root with `db/provision/prove-promotion-gate.sh`. It
needs Docker and about 3 GB of memory. On Apple silicon the amd64 image runs
under emulation and the run takes a few minutes. Containers and the network
are removed on exit. It prints `ALL PASSED` last. It touches no host.
