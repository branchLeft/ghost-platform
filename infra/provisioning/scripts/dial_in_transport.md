# dial_in_transport.py

## Module overview

The tenant database host "never initiates outward"; the worker on `ops1`
dials in. This module holds:

  - `DialInTransport`, the interface a caller like `pull_encrypt_store.py`
    depends on, so it never has to know which concrete channel it is
    running over;
  - `LocalProcessTransport`, a local test double that runs a producer as an
    ordinary local subprocess. It stands in for a real dial-in call so the
    pipeline's floor-check, single-recipient and never-put-before-exit-0
    properties can be proven against a real local database and a real
    producer without a remote channel;
  - `RemoteMysqldumpTransport`, the real channel: `mysqldump`, run locally
    on the worker's own host, connecting to the tenant database host's
    existing MySQL port over TLS through a host-restricted backup account.
    No new listener anywhere, and the database host gains no new service.

`bounded_snapshot` is loaded by path from `db/provision/`, the same file
db1's nightly dump runs, so the two paths cannot drift.

## FORBIDDEN_ENV_PREFIXES

Every prefix that names a storage or encryption credential in this
estate's convention (db/provision/dump_tenant.py's own
FORBIDDEN_ENV_PREFIXES, restated here rather than imported: this module
runs on the org/control side of the trust boundary the producer's own
check exists to enforce, and the two sides proving the same property
independently is the point, not a maintenance burden — a caller-side
check that quietly drifted from the producer's would be exactly the kind
of gap this pipeline exists to close). AWS_* / DB_BACKUP_* for the
storage credential and endpoint, AGE_* for the encryption recipient: the
worker holds all three, and none of them may ever reach the environment a
producer command is invoked with.

## LocalProcessTransport

Runs the producer as an ordinary local subprocess.

This is a TEST DOUBLE, not the production channel — see the module
overview above. It exists so the pipeline's controls can be proven end to
end against a real producer talking to a real local database, without a
network hop to the tenant database host.

Streams line-by-line, mirroring `db/provision/dump_tenant.py`'s own
`run_mysqldump`: a caller watching for a floor-table `INSERT` pattern
needs whole lines, and a chunk boundary that split one across two
`stdout.write()` calls would make that watch unreliable for no reason a
real remote channel would ever force on it.

## RemoteMysqldumpTransport

Grants: ghost-platform-docs/backup-worker-account-handover-runbook.md.

Each `run` takes the tenant's snapshot through
`bounded_snapshot.take_bounded_snapshot`, scoped to that tenant's schema
only: a `mysql` coordinator session locks the tenant's tables `READ`
(wait bounded by the server and by a client deadline), reads the
binary-log position, starts `mysqldump -v --single-transaction
--no-tablespaces` and unlocks once mysqldump reports its snapshot open
(hold bounded). No `--source-data`, so no `FLUSH TABLES WITH READ LOCK`
and no lock on any other tenant. See db/provision/bounded_snapshot.md.

The resume-point comment is written to `stdout` first, then mysqldump's
own output streams after it. If no snapshot can be taken after the
retries, nothing is written and `run` returns `SNAPSHOT_FAILED_EXIT_CODE`
(75): an ordinary producer failure, with the reason on stderr.
`last_snapshot` holds the successful attempt's measurements (lock wait,
hold, attempts) and `last_snapshot_aborts` the number of attempts given up
on a bound, success or not; `backup_worker.run_tenant_dump` reads both.

### Snapshot mode

`gtid_snapshot.py` is loaded by path only when the transport is built in
`"gtid"` mode, so a release that lacks it still imports and runs `"bounded"`;
it is in the installer's required release files all the same, with a test that
every `db/provision` module this file loads by path is listed. In `"gtid"`
mode a `mysqldump` that does not name Percona in `--version` is refused before
anything starts, and a malformed or doubled GTID header found mid-stream stops
the dump and returns `SNAPSHOT_FAILED_EXIT_CODE` like any other refusal.

`snapshot=` is `"bounded"` (the default, above) or `"gtid"`, chosen at the
worker by `BACKUP_WORKER_SNAPSHOT_MODE` (an unknown value is refused, never
defaulted). In `"gtid"` mode no coordinator session is opened and nothing is
locked: `gtid_snapshot.take_gtid_snapshot` starts one `mysqldump
--single-transaction --set-gtid-purged=ON` and the transport streams it
through a `PurgedStatementScanner`, which reads the recovery position off the
dump's header. `last_snapshot` is a `GtidSnapshotReport`: its lock wait,
hold and tables-locked are zero, and `recovery_gtid_set` is the tenant's
position, logged, carried in `DumpResult.recovery_gtid_set` and printed by
the worker and the nightly loop. A dump that exits 0 with no GTID statement
returns `SNAPSHOT_FAILED_EXIT_CODE`: a dump with no recovery position is not
a backup, and the caller discards what streamed. The mode needs Percona
Server on the tenant database host **and Percona's `mysqldump` on the worker's
host**: the client is what reads the set atomically with its snapshot. Oracle's
8.0.32+ client takes a global read lock for `--set-gtid-purged=ON`, which the
backup account is not granted, so with the wrong client (or against Oracle
MySQL) the dump fails rather than locking. See db/provision/gtid_snapshot.md.

The password reaches each `mysql` and `mysqldump` child only through an
inherited pipe fd, read once as an option file
(`--defaults-extra-file=/dev/fd/N`): never argv, never the child's
environ, never a file on disk. The child environment is `PATH` only.
