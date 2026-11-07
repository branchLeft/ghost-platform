# percona_snapshot_probe.py and prove-percona-snapshot.sh

## Module overview

A proof of whether Percona Server for MySQL, on the tenant database host, can
give a per-tenant `mysqldump --single-transaction --source-data=2` whose
binary-log coordinates match its snapshot **without any lock a tenant's writer
can wait behind**. Oracle MySQL 8.0 cannot: nothing there ties a coordinate
read to a `--single-transaction` snapshot without stopping commits
(`FLUSH TABLES WITH READ LOCK`, or `LOCK TABLES` on every dumped table). Percona
adds the status variables `Binlog_snapshot_file`, `Binlog_snapshot_position`
and `Binlog_snapshot_gtid_executed`, which its own `mysqldump` reads right after
`START TRANSACTION WITH CONSISTENT SNAPSHOT` instead of taking a global lock.
This proof runs that claim.

It runs on **throwaway local containers**: the Percona candidate (the source and
the replica, as the tenant host's replica is Percona), and for its two red cases
db1's pinned stock Oracle MySQL as the source. The stock digest is read from
`db/RUNBOOK-db.md`, never copied; the Percona digest is pinned in
`prove-percona-snapshot.sh` and a test ties it to `.github/image-mirror/images.json`.
The config is `db/stack/conf.d/branchleft.cnf` unchanged (binary log ROW,
`sync_binlog=1`), mounted into every container. Nothing here reaches db1,
the tenant host or any host: no ssh, no ansible, no Docker or mysql against
anything but its own `snapshot-proof-*` containers on a throwaway network, which
the script and `percona_snapshot_probe.py run` both refuse to leave.
Passwords are generated at run time with `openssl rand`, held in a mode-700
temporary directory and removed on exit; none is in a repo file, argv or output.

The schemas are Ghost-shaped, not Ghost's: three tenants, `t1`, `t2` and `t3`,
each the 14-table schema with foreign keys, a trigger and a view that
`snapshot_probe.py` defines (`sp.blog_ddl`), one continuous timed Ghost-like
writer per tenant (`sp.blog_statement`: a multi-table transaction), and one
dump account per tenant (`dump_t1`, ...) holding `SELECT, SHOW VIEW, TRIGGER`
on its own schema and nothing else. Each tenant is dumped separately, so each
dump has its own coordinates. One replica is seeded tenant by tenant, in turn,
from each dump at its recorded coordinates (a runtime `CHANGE REPLICATION
FILTER` to that tenant), caught up to the source's final position and compared
on every table's row count and `CHECKSUM TABLE`.

It reuses `snapshot_probe.py` (the container plumbing, the writers, the lock
sampler, the verdict functions `writer_stall_verdict` and `checksum_verdict`,
the exit-code convention) and `replication_client_probe.py` (`rounds_verdict`,
`replay_verdict`). `snapshot_probe.LockSampler` and `table_sums` gained one
default-preserving parameter each (the account or accounts sampled; the schema
compared). One implementation, so the proof cannot pass on a copy.

## How to run

```sh
db/provision/prove-percona-snapshot.sh
PROOF_CONTROLS="4 5 6" db/provision/prove-percona-snapshot.sh
PROOF_PLATFORM=linux/arm64 db/provision/prove-percona-snapshot.sh
PROOF_SOURCE=stock SABOTAGE=commit-before-coordinates db/provision/prove-percona-snapshot.sh
PROOF_SOURCE=stock SABOTAGE=global-lock db/provision/prove-percona-snapshot.sh
python3 db/provision/percona_snapshot_probe.py --self-test
```

Needs Docker and about 4 GB of memory. The first run pulls the images by
digest. `PROOF_PLATFORM` defaults to `linux/amd64`, the hosts' architecture; on
an arm64 Mac that is emulated, which makes the latency control (2) unreliable:
see the results. `PROOF_SOURCE` is `percona` (default) or `stock`; the
sabotages are defined only on `stock`. The script refuses a set `DOCKER_HOST`
or a Docker context other than `default` or `desktop-linux` (exit 5) before it
starts any container, and refuses an unknown `PROOF_SOURCE`.

| Exit | Meaning                                                                                         |
| ---- | ----------------------------------------------------------------------------------------------- |
| 0    | `ALL PASSED`: controls 1 to 5 pass and control 6 is recorded                                    |
| 1    | a sabotage run went red, as it should                                                           |
| 2    | a sabotage run stayed green: the control cannot see that failure                                |
| 3    | `CANDIDATE INADEQUATE`: a control from 1 to 5 failed with nothing sabotaged                     |
| 4    | the control 6 finding could not be recorded                                                     |
| 5    | refused before any container                                                                    |

## The six controls

1. **Variables, and coordinates consistent with the snapshot.** The server
   exposes `Binlog_snapshot_file`, `_position` and `_gtid_executed`, and runs
   `log_bin=1`, `binlog_format=ROW`, `sync_binlog=1`. Then five rounds. Each round
   starts a writer on every tenant, dumps each tenant as its dump account with
   the Percona `mysqldump --single-transaction --source-data=2 --routines
   --triggers --set-gtid-purged=OFF --no-tablespaces`, stops the writers, and for
   each tenant seeds the replica at that dump's coordinates, replays to the
   source's final position and asserts every table matches on count and
   `CHECKSUM TABLE`, and that the replay applied at least one write the dump did
   not hold (a replay of nothing proves nothing). Round 1 is the long round: a
   long open write transaction (`integrations`) and a `SELECT SLEEP(60)` reading
   `t1.posts` run while the three tenants are dumped over and over; the
   transaction commits after the last dump. When a table differs, the proof
   places each missing `posts` row against the dump and the recorded coordinates
   by reading the **source's own binary log** (`mysqlbinlog` as the replication
   account), an oracle that is not the replica: a row committed before the
   coordinates yet absent from the dump says the coordinates ran ahead of the
   snapshot.
2. **No tenant's writes stall.** Every tenant's worst write transaction over
   the whole run, the long round included, is under 100 ms (a writer's first
   two statements are dropped as connection warm-up). Each tenant's worst
   statement before the first dump is printed beside it. When that baseline is
   already over the limit the failure says the host's own commit latency may be
   the cause. The limit is never loosened.
3. **No global or write-blocking lock.** A sampler reads
   `performance_schema.metadata_locks` for the dump accounts' threads, unpaced,
   across the whole run. No `GLOBAL` or `COMMIT` lock and no `TABLE` lock of a
   write-blocking type (`SHARED_READ_ONLY`, `SHARED_NO_WRITE`,
   `SHARED_NO_READ_WRITE`, `EXCLUSIVE`) may appear. A `--single-transaction`
   dump necessarily holds `SHARED_READ` on the tables it reads, which blocks no
   writer, and seeing it is what shows the sampler was not blind. (The ticket
   said "no TABLE lock held by the dump account"; read literally that cannot
   hold for any consistent read, so the assertion is the write-blocking ones.)
4. **No RELOAD and no LOCK TABLES needed.** As the dump account:
   `FLUSH TABLES WITH READ LOCK` gives error 1227, `LOCK TABLES` gives error 1044,
   `SHOW GRANTS` names no global privilege, RELOAD or LOCK TABLES, and the dump
   of every tenant succeeds all the same.
5. **Deterministic discrimination.** With every writer stopped, a consistent
   snapshot is opened, a commit is forced into `t1`, and the snapshot's
   `Binlog_snapshot_*` is read again, beside the live position and
   `performance_schema.log_status`. The snapshot's coordinates must be the
   position when it opened and stay put, the live position and `log_status` must
   move with the commit, and the snapshot must not see the row.
6. **Finding, recorded, not gated.** The form of the coordinates comment the
   dump emits, and whether `extract_tenant_binlog.SOURCE_DATA_PATTERN` parses it.

## Red cases

Each goes red and exits 1, run on db1's stock Oracle MySQL (`PROOF_SOURCE=stock`).

| `SABOTAGE`                  | What it does                                                                                                                                                        | Turns red |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `commit-before-coordinates` | no lock: `mysqldump --single-transaction` takes the snapshot, a committed transaction is forced into every table of the tenant, and only then is `log_status` read as the coordinates; the replica is seeded there | 1         |
| `global-lock`               | the retired path: the dump account is granted `RELOAD` and `REPLICATION CLIENT` and runs stock `mysqldump --source-data=2` while a `SELECT SLEEP(60)` reads `t1.posts` | 2, 3      |

Run the red case first, then the green one. A sabotage that exits 2 means the
control could not have failed. This happened once while building this proof: a
lock sampler paced at 20 ms missed the global lock the sabotage takes for
milliseconds and exited 2, so the sampler runs unpaced.

## Results

Images, as pulled by digest and run, `linux/amd64` unless stated.

| Image                     | Index digest                                                              | amd64 manifest                                                            | `mysqld --version`                                                           |
| ------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| db1's pinned stock MySQL  | `sha256:7dcddc01f13bab2f15cde676d44d01f61fc9f99fe7785e86196dfc07d358ae2b` | `sha256:62fb722c78b24245ddff1796a0fcee4a49cc5b87e0aaaf20c92d1da9e0a2497b` | `Ver 8.0.46 for Linux on x86_64 (MySQL Community Server - GPL)`              |
| Percona candidate         | `sha256:a4ba7d1afd325f40bc6d65b6455fb4f15388638dfa39e3b85f9755755fd9ec2d` | `sha256:2fb8f1c992bc86f0bf4fa0aa174bbb1946f8867a7518278beec801a0bd2bf9e3` | `Ver 8.0.46-37 for Linux on x86_64 (Percona Server (GPL), Release 37, Revision 39e2b60e)` |

The Percona index also holds `linux/arm64/v8` manifest
`sha256:6ad92144acf2fc99728a8280d0921865e5fba05a10d8a9fbd20292749554cd75`,
which the native runs below used.

### Red cases (stock source, final code)

| Case                        | Exit | Measured                                                                                                                                                                                                                      |
| --------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit-before-coordinates` | 1    | control 1 red: 14 of 14 tables differ on all three tenants (for example `emails` 113 rows on the source, 94 on the replica); every forced row and many writer rows are committed before the coordinates and absent from the dump |
| `global-lock`               | 1    | control 2 red: `t1` worst statement 59,888 ms (the sleep is 60 s), `t2` 105 ms, `t3` 118 ms; control 3 red: `COMMIT/SHARED/GRANTED`, `COMMIT/SHARED/PENDING` and `GLOBAL/SHARED/GRANTED` seen                                |

### Green run, Percona source (final code)

`db/provision/prove-percona-snapshot.sh`, amd64 under emulation on an arm64
Mac: **exit 3, `CANDIDATE INADEQUATE`**.

| Control | Result  | Measured                                                                                                                                                                                                                            |
| ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | FAIL    | variables exist, `log_bin=1`, ROW, `sync_binlog=1`; 14 of 15 tenant checks matched on every table; in round 5, `t3` was one `posts` row and one `emails` row short, the row committed at binlog position 5804128, before the recorded coordinates 5804657, absent from the dump |
| 2       | FAIL    | worst statement 169 ms, 176 ms, 179 ms over about 2,500 each; the baseline before the first dump was 109, 104, 113 ms: this host cannot judge the limit                                                                            |
| 3       | PASS    | about 110,000 samples over 78 dumps; `TABLE/SHARED_READ/GRANTED` and others seen; no `GLOBAL`, `COMMIT` or write-blocking `TABLE` lock                                                                                              |
| 4       | PASS    | error 1227 on `FLUSH TABLES WITH READ LOCK`, 1044 on `LOCK TABLES`, no global privilege, three dumps succeeded                                                                                                                       |
| 5       | PASS    | `Binlog_snapshot` stayed at `mysql-bin.000003:5821113` while the live position and `log_status` moved to `:5821465`; the snapshot kept its 2,800 rows                                                                              |
| 6       | FINDING | `-- CHANGE MASTER TO MASTER_LOG_FILE=..., MASTER_LOG_POS=...;`; `SOURCE_DATA_PATTERN` parses it, so `extract_tenant_binlog.py` needs no change                                                                                       |

### What control 1 found

Across seven un-sabotaged runs while this proof was built (amd64 emulated and
native arm64, 3 to 5 rounds each), **10 of 81 tenant checks, in 6 of 7 runs, left
the replica exactly one transaction short**: one `posts` row, one `emails` row.
In every one the source's own binary log places that transaction before the
dump's recorded coordinates, and the dump does not hold it. The replay starts at
the coordinates, so that committed transaction is in neither the dump nor the
replay: silently lost. Observed on native arm64 as well as under emulation, so it
is not an emulation artifact. The lost transaction is always the one just before
the coordinates.

Not established: why. A hypothesis, untested: `Binlog_snapshot_position` can
include a transaction that has been written to the binary log but is not yet
visible to a new read view (the gap between the log write and the engine
commit), a window that `sync_binlog=1` makes as wide as a log fsync, which is
long on Docker Desktop and short on real disk. The proof does not show that, nor
that a native x86_64 host would lose less. The rate here (about 1 dump in 8, under
roughly a dozen commits a second per tenant) is a measure of this harness on
this host, not of production.

What was ruled out: the replica's applier (a single-threaded replica lost rows
at the same rate), the harness's compare (the source's binary log, not the
replica, places each lost row), and the coordinate source (the general log shows
Percona's `mysqldump` reading `Binlog_snapshot_*` after `START TRANSACTION WITH
CONSISTENT SNAPSHOT`, not `SHOW MASTER STATUS`). Control 5 passes: with nothing
else committing, the coordinates are exact, so the race needs a concurrent
commit.

### What control 2 cannot say here

The 100 ms limit is exceeded before any dump has run (baselines of 93 to 160
ms on this host, emulated or native), because Docker Desktop's commit latency
with `sync_binlog=1` and three writers is itself near the limit. So a failure
here is not evidence of a dump-caused stall: control 3 shows no lock for a
writer to wait behind, and the same run's `global-lock` red case, where a real
stall exists, measures 59,888 ms. A host whose baseline is under the limit
(`snapshot-proof-ci.yml` runs this on a native x86_64 runner) is the run that
can judge control 2.

## Recorded for whoever builds the dump stories

- **Percona's `mysqldump` needs no `RELOAD`, `LOCK TABLES` or `REPLICATION
  CLIENT`.** The dump account that holds only `SELECT, SHOW VIEW, TRIGGER` on
  its schema dumped every tenant with `--single-transaction --source-data=2`.
  The stock `mysqldump` with the same account cannot use `--source-data`.
- **`--no-tablespaces` is needed** (the account has no `PROCESS`), as in
  `snapshot_probe.DUMP_ARGS`; `dump_tenant.py`'s own account has more.
- **The comment form is unchanged.** `-- CHANGE MASTER TO MASTER_LOG_FILE='...',
  MASTER_LOG_POS=...;` at the top of the dump, which `extract_tenant_binlog.py`
  reads. Percona 8.0.46-37 does not use the `CHANGE REPLICATION SOURCE TO`
  spelling.
- **The stock image has no `mysqlbinlog`.** The Percona image does; the proof
  reads the source's log through the replica's.
- **The configuration mounts at a different path.** `/etc/mysql/conf.d` for
  the stock image, `/etc/my.cnf.d` for Percona.

## Not in scope

The amendment to the backup design document (the chosen mechanism and the
dump/upgrade mutual exclusion), the build stories for the tenant database
host's dump path, converging the three places that pin the Percona digest, and
any change to the real dump path are separate work. This proof changes none of
them and takes no decision on whether the mechanism is adequate.
