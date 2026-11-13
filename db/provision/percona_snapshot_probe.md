# percona_snapshot_probe.py and prove-percona-snapshot.sh

## Module overview

A proof of whether Percona Server for MySQL, on the tenant database host, can
give a per-tenant `mysqldump --single-transaction` whose **GTID set** matches
its snapshot **without any lock a tenant's writer can wait behind**, so that a
replica seeded from the dump and started with `SOURCE_AUTO_POSITION=1` misses
no committed row and applies none twice. Oracle MySQL 8.0 cannot give that:
nothing there ties a coordinate read to a `--single-transaction` snapshot
without stopping commits (`FLUSH TABLES WITH READ LOCK`, or `LOCK TABLES` on
every dumped table). Percona adds the status variables `Binlog_snapshot_file`,
`Binlog_snapshot_position` and `Binlog_snapshot_gtid_executed`, which its own
`mysqldump` reads right after `START TRANSACTION WITH CONSISTENT SNAPSHOT`
instead of taking a global lock. This proof runs that claim.

**File and position coordinates are unsafe on this server, so the proof does not
use them.** The first version of this proof seeded the replica at the
`-- CHANGE MASTER TO MASTER_LOG_FILE=..., MASTER_LOG_POS=...` comment of
`mysqldump --source-data=2`, and the un-sabotaged control lost committed rows.
An isolation run (one Percona 8.0.46-37 container, three tenants, continuous
writers, repeated unprivileged dumps, the source's own binary log as the
oracle) showed why: the recorded position can include a transaction the
snapshot cannot see, so the replay starts after a row the dump never held. It
lost rows in 3 of 5 rounds with one writer per tenant and in 5 of 5 with three
writers per tenant; reading `Binlog_snapshot_*` in the same
`START TRANSACTION WITH CONSISTENT SNAPSHOT` session lost rows too; native
arm64 lost rows too; `binlog_order_commits=0` did not change it. It is a race in
this server version, not the wrong session and not emulation. With
`gtid_mode=ON`, `enforce_gtid_consistency=ON` and the replica seeded from the
dump's GTID set (`mysqldump --set-gtid-purged=ON`), the same harness lost
nothing: 0 rows in 8 rounds (144 consistent-snapshot reads) and 0 in 6 rounds of
the real unprivileged `mysqldump` (108 dumps). A GTID set, unlike a position,
names every transaction by identity, so a transaction that is in the log but
not yet visible to the snapshot is simply not in the set and the replica fetches
it. **The replica must be seeded by GTID set with `SOURCE_AUTO_POSITION=1`.**
`extract_tenant_binlog.py` reads file and position; its GTID support is later
build work and is not part of this proof.

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
`snapshot_probe.py` defines (`sp.blog_ddl`), three continuous timed Ghost-like
writers per tenant (`sp.blog_statement`: a multi-table transaction), and one
dump account per tenant (`dump_t1`, ...) holding `SELECT, SHOW VIEW, TRIGGER`
on its own schema and nothing else. Each tenant is dumped separately, so each
dump has its own GTID set. Both servers run `--gtid_mode=ON
--enforce_gtid_consistency=ON`, set on the command line by the wrapper (the
mounted `branchleft.cnf` is unchanged). One replica is seeded tenant by tenant,
in turn: its own GTID state is cleared (`RESET MASTER`), the dump is loaded
(its `SET @@GLOBAL.GTID_PURGED` line becomes the replica's executed set), a
runtime `CHANGE REPLICATION FILTER` limits it to that tenant, and replication
starts with `SOURCE_AUTO_POSITION=1`. It is caught up to the source's final GTID
set and compared on every table's row count and `CHECKSUM TABLE`.

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
SABOTAGE=gtid-drop-one db/provision/prove-percona-snapshot.sh
SABOTAGE=gtid-extra-one db/provision/prove-percona-snapshot.sh
python3 db/provision/percona_snapshot_probe.py --self-test
```

Needs Docker and about 4 GB of memory. The first run pulls the images by
digest. `PROOF_PLATFORM` defaults to `linux/amd64`, the hosts' architecture; on
an arm64 Mac that is emulated, which makes the latency control (2) unreliable:
see the results. `PROOF_SOURCE` is `percona` (default) or `stock`; each
sabotage runs on one source only (`commit-before-coordinates` and `global-lock`
on `stock`, the two `gtid-*` cases on `percona`) and is refused on the other
(exit 64). The script refuses a set `DOCKER_HOST`
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
| 6    | `host too noisy: inconclusive`: control 2 was the only control to fail, on a host whose own baseline was over the bound (see control 2) |

## The six controls

1. **Variables, and a GTID set consistent with the snapshot.** The server
   exposes `Binlog_snapshot_file`, `_position` and `_gtid_executed`, and runs
   `log_bin=1`, `binlog_format=ROW`, `sync_binlog=1`, `gtid_mode=ON` and
   `enforce_gtid_consistency=ON`. Then five rounds with three writers on every
   tenant. Each round dumps each tenant as its dump account with the Percona
   `mysqldump --single-transaction --routines --triggers --set-gtid-purged=ON
   --no-tablespaces` (no `--source-data`), stops the writers, and for each tenant
   seeds the replica from that dump's GTID set, replays by
   `SOURCE_AUTO_POSITION=1` to the source's final GTID set and asserts every table
   matches on count and `CHECKSUM TABLE`, and that the replay applied at least
   one write the dump did not hold (a replay of nothing proves nothing). Round 1
   is the long round: a long open write transaction (`integrations`) and a
   `SELECT SLEEP(60)` reading `t1.posts` run while the three tenants are dumped
   over and over; the transaction commits after the last dump.
   **The oracle** judges every dump of the round, not only the one the replica
   was seeded from, and it is not the replica: it reads the **source's own
   binary log** (`mysqlbinlog` as the replication account) for the GTID that
   committed each writer's `posts` row. Every committed row must be in the
   snapshot (the dump holds it) or after the seeding set (its GTID is not in the
   dump's `GTID_PURGED` set), and exactly one of the two. In the set but not in
   the dump is a **lost** row (the replica never gets it); in the dump but not in
   the set is a **duplicated** row (the replica applies it twice). A committed
   row the binary log does not place, or a run that only ever saw rows on one
   side of the set, fails the oracle too: it was blind. The replica is asked
   for its executed set after the load and it must equal the set the oracle
   judged.
2. **No tenant's writes stall.** Every tenant's worst write transaction over
   the whole run, the long round included, is under 100 ms (a writer's first
   two statements are dropped as connection warm-up). Each tenant's worst
   statement before the first dump is printed beside it. When that baseline is
   already over the limit the failure says the host's own commit latency may be
   the cause. The limit is never loosened.
   **Host noise.** When control 2 is the only gating control to fail and any
   tenant's baseline is over 50 ms (`HOST_BASELINE_BOUND_SECONDS`), the run
   prints `INCONCLUSIVE control 2` and `host too noisy: inconclusive` and exits 6,
   not 3: the host, not the candidate, broke the limit, so the run is neither a
   pass nor `CANDIDATE INADEQUATE`, and CI stays red until it is re-run on a
   quieter host. The bound is about twice the worst baseline of the native runs
   that passed (8 to 25.7 ms across three runs); the runs a slow shared runner
   failed measured 133 to 213 ms. A pass is never reclassified, a failure of any
   other control keeps exit 3, and a sabotage run keeps exits 1 and 2.
   `percona_snapshot_probe_noisy_host.json` records both kinds of run and
   `test_percona_host_noise.py` runs them.
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
   move with the commit, and the snapshot must not see the row. This is quiet:
   with nothing else committing the coordinates are exact, so it passes on a
   server whose coordinates are wrong under concurrent commits. It says nothing
   about the race control 1 exists for.
6. **Finding, recorded, not gated.** The form of the coordinates comment a dump
   taken with `--source-data=2` emits, and whether
   `extract_tenant_binlog.SOURCE_DATA_PATTERN` parses it. Recorded for that
   extractor only; no replica is ever seeded from these coordinates.

## Red cases

Each goes red and exits 1. The first two run on db1's stock Oracle MySQL
(`PROOF_SOURCE=stock`), the two `gtid-*` cases on the Percona candidate
(`PROOF_SOURCE=percona`, the default).

| `SABOTAGE`                  | What it does                                                                                                                                                                                                                                                  | Turns red |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `commit-before-coordinates` | no lock: `mysqldump --single-transaction` takes the snapshot, a committed transaction is forced into every table of the tenant, and only then is the server's live GTID set read as the replica's start point; the replica is seeded there                     | 1         |
| `global-lock`               | the retired path: the dump account is granted `RELOAD` and `REPLICATION CLIENT` and runs stock `mysqldump --source-data=2` while a `SELECT SLEEP(60)` reads `t1.posts`                                                                                         | 2, 3      |
| `gtid-drop-one`             | the real Percona dump, the real unprivileged account; then exactly one transaction of the tenant (its latest one that the set and the dump both hold) is taken out of the GTID set the replica is seeded with, so the replica applies it a second time           | 1         |
| `gtid-extra-one`            | the same, but exactly one transaction of the tenant (its earliest one that the set and the dump both lack) is added to the set, so the replica never gets it                                                                                                    | 1         |

The two `gtid-*` cases prove the oracle is sensitive to a single transaction. A
`gtid-*` run is red only when the oracle itself saw the change (a duplicated row
for `gtid-drop-one`, a lost one for `gtid-extra-one`); a replica that diverged
while the oracle stayed quiet exits 2, and so does a run that did not complete.

Run the red cases first, then the green one. A sabotage that exits 2 means the
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

### Red cases (final code, run before the green runs)

| Case                        | Source  | Exit | Measured                                                                                                                                                                                                                                                              |
| --------------------------- | ------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commit-before-coordinates` | stock   | 1    | control 1 red: 14 of 14 tables differ on all three tenants (for example `emails` 315 rows on the source, 271 on the replica); the oracle counts 122 committed rows lost                                                                                              |
| `global-lock`               | stock   | 1    | control 2 red: `t1` worst statement 59,677.7 ms (the sleep is 60 s), `t2` 59.4 ms, `t3` 58.6 ms; control 3 red: `COMMIT/SHARED/GRANTED`, `GLOBAL/SHARED/GRANTED` and `GLOBAL/SHARED/PENDING` seen                                                                    |
| `gtid-drop-one`             | Percona | 1    | control 1 red in 2 of 2 rounds: exactly one transaction taken out of each tenant's seeding set (6 in all); the oracle counts 3 rows DUPLICATED per round, one per tenant, and the replica's SQL thread stops with error 1062 on each                                   |
| `gtid-extra-one`            | Percona | 1    | control 1 red in 2 of 2 rounds: exactly one transaction added to each tenant's seeding set (6 in all); the oracle counts 3 rows LOST per round, one per tenant, and every seeded replica is exactly one `posts` row and one `emails` row short                       |

### Green runs, Percona source (final code)

`db/provision/prove-percona-snapshot.sh`, `linux/amd64` on an arm64 Mac, five
rounds (one long, four short), three writers per tenant, all 14 tables of all
three tenants compared on every round.

| Run                                       | Exit | Control 1 (oracle over all rounds)                                                                 |
| ----------------------------------------- | ---- | -------------------------------------------------------------------------------------------------- |
| all controls                              | 3    | PASS: 81 snapshots, 601,096 committed-row checks (353,344 in a snapshot, 247,752 after the seeding set), 0 lost, 0 duplicated |
| `PROOF_CONTROLS="1 3 4 5 6"`              | 0    | PASS: 84 snapshots, 653,377 committed-row checks (382,458 in a snapshot, 270,919 after the seeding set), 0 lost, 0 duplicated |

Across the two runs, 165 snapshots under nine concurrent writers: 0 lost and 0
duplicated, and every replica matched on every table. Exit 3 in the first run
is control 2 alone, below.

| Control | Result  | Measured (first run)                                                                                                                                                                                                  |
| ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1       | PASS    | as above                                                                                                                                                                                                              |
| 2       | FAIL    | worst statement 101.6 ms, 98.2 ms, 102.3 ms over about 8,300 each; the worst before the first dump was 17.9, 19.5 and 27.2 ms: see below                                                                              |
| 3       | PASS    | about 200,000 samples over 81 dumps; `TABLE/SHARED_READ/GRANTED` and others seen; no `GLOBAL`, `COMMIT` or write-blocking `TABLE` lock                                                                                |
| 4       | PASS    | error 1227 on `FLUSH TABLES WITH READ LOCK`, 1044 on `LOCK TABLES`, no global privilege, three dumps succeeded with `--set-gtid-purged=ON` and no `--source-data`                                                      |
| 5       | PASS    | `Binlog_snapshot` stayed at `mysql-bin.000003:18575084` while the live position and `log_status` moved to `:18575436`; the snapshot kept its 8,630 rows                                                              |
| 6       | FINDING | `-- CHANGE MASTER TO MASTER_LOG_FILE=..., MASTER_LOG_POS=...;`; `SOURCE_DATA_PATTERN` parses it, so `extract_tenant_binlog.py` needs no change to read it (it still reads file and position, not the GTID set)        |

### What control 1 found, and what replaced it

The first version of control 1 seeded the replica at the dump's recorded file and
position. Across seven un-sabotaged runs while this proof was built (amd64
emulated and native arm64, 3 to 5 rounds each, one writer per tenant), **10 of 81
tenant checks, in 6 of 7 runs, left the replica exactly one transaction short**:
one `posts` row, one `emails` row. In every one the source's own binary log
placed that transaction before the dump's recorded position, and the dump did
not hold it. The replay starts at the position, so that committed transaction
was in neither the dump nor the replay: silently lost. Native arm64 lost rows
too, so it is not an emulation artifact.

The isolation run (one Percona 8.0.46-37 container, three tenants, continuous
writers, repeated unprivileged dumps, the source's binary log as the oracle)
then narrowed it. File and position lost committed rows in 3 of 5 rounds with
one writer per tenant and in 5 of 5 with three per tenant. Reading
`Binlog_snapshot_*` in the same consistent-snapshot session lost rows too. Native
arm64 lost rows too, and `binlog_order_commits=0` changed nothing. So the
recorded position includes a transaction the snapshot cannot see: a race in this
server version, not the wrong session and not emulation. Seeded by GTID set
(`gtid_mode=ON`, `enforce_gtid_consistency=ON`, `--set-gtid-purged=ON`), the same
harness lost nothing: 0 in 8 rounds (144 snapshots) and 0 in 6 rounds of the real
unprivileged `mysqldump` (108 dumps). The final code above repeats that with an
oracle that is not the replica, 165 snapshots, and two sabotages that show the
oracle sees a single transaction.

Why a GTID set is safe where a position is not is not established here; the
likely reading is that a transaction written to the log but not yet visible to
the snapshot is simply absent from the snapshot's set, so the replica fetches
it. What was ruled out: the replica's applier (a single-threaded replica lost
rows at the same rate), the harness's compare (the source's binary log, not the
replica, places each lost row), and the coordinate source (the general log
shows Percona's `mysqldump` reading `Binlog_snapshot_*` after `START TRANSACTION
WITH CONSISTENT SNAPSHOT`, not `SHOW MASTER STATUS`). Control 5 passes: with
nothing else committing, the coordinates are exact, so the race needs a
concurrent commit.

### What control 2 can and cannot say here

With three writers per tenant (nine in all) control 2 failed in the first green
run on two of three tenants, by 1.6 and 2.3 ms (101.6, 98.2 and 102.3 ms worst, over about
8,300 write transactions each), on a Docker Desktop host running amd64 under
emulation with `sync_binlog=1`. The worst statement before the first dump was
under 28 ms on every tenant, control 3 shows no lock for a writer to wait behind
(no `GLOBAL`, `COMMIT` or write-blocking `TABLE` lock in about 200,000 samples),
and the same host's `global-lock` red case, where a real stall exists, measures
59,677.7 ms. So this is the host's tail latency under a CPU-bound nine-writer
load with dumps running, not a dump-caused stall, and the limit is not loosened.
The native x86_64 run in `snapshot-proof-ci.yml` is the one that can judge
control 2, now under nine writers. The second green run excluded control 2
(`PROOF_CONTROLS="1 3 4 5 6"`) to record the exit 0 of the rest.

## Recorded for whoever builds the dump stories

- **Seed the replica by GTID set, never by file and position.** Both servers
  run `gtid_mode=ON` and `enforce_gtid_consistency=ON` from their first start
  (a new host can; turning it on later is a staged change). Dump with
  `--set-gtid-purged=ON`, clear the replica's own GTID state (`RESET MASTER`),
  load the dump, then `CHANGE REPLICATION SOURCE TO ..., SOURCE_AUTO_POSITION=1`.
  File and position lost committed rows in this proof's isolation runs (see the
  overview) and must not be used on this server version.
- **`extract_tenant_binlog.py` reads file and position.** Its GTID support, so
  that the per-tenant replay starts from the dump's GTID set, is later build
  work. It is not done here.
- **Percona's `mysqldump` needs no `RELOAD`, `LOCK TABLES` or `REPLICATION
  CLIENT`.** The dump account that holds only `SELECT, SHOW VIEW, TRIGGER` on
  its schema dumped every tenant with `--single-transaction
  --set-gtid-purged=ON`, and with `--source-data=2` besides. The stock
  `mysqldump` with the same account cannot use `--source-data`.
- **`--no-tablespaces` is needed** (the account has no `PROCESS`), as in
  `snapshot_probe.DUMP_ARGS`; `dump_tenant.py`'s own account has more.
- **The comment form is unchanged** where `--source-data=2` is still used.
  `-- CHANGE MASTER TO MASTER_LOG_FILE='...', MASTER_LOG_POS=...;` at the top of
  the dump, which `extract_tenant_binlog.py` reads. Percona 8.0.46-37 does not
  use the `CHANGE REPLICATION SOURCE TO` spelling.
- **The stock image has no `mysqlbinlog`.** The Percona image does; the proof
  reads the source's log through the replica's.
- **The configuration mounts at a different path.** `/etc/mysql/conf.d` for
  the stock image, `/etc/my.cnf.d` for Percona.

## Not in scope

The amendment to the backup design document (the chosen mechanism and the
dump/upgrade mutual exclusion), GTID support in `extract_tenant_binlog.py`, the
build stories for the tenant database host's dump path, converging the three places that pin the Percona digest, and
any change to the real dump path are separate work. This proof changes none of
them and takes no decision on whether the mechanism is adequate.
