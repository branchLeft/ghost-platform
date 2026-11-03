# snapshot_probe.py and prove-snapshot-locking.sh

## Module overview

A hand-run proof that a snapshot locking only one schema's tables is
available on db1's MySQL version. It is the step-0 evidence for the blog
move: a consistent dump plus the binary-log coordinates it matches, a
replica seeded from the two under continuing writes, and no instance-wide
lock at any point.

It runs on **throwaway local containers of the digest pinned in
`db/RUNBOOK-db.md`** (read from there, never copied) with
`db/stack/conf.d/branchleft.cnf`, a source and a replica, on
`linux/amd64` as the hosts are. Nothing here reaches db1 or any host: no
ssh, no ansible, no Docker or mysql against anything but its own
containers. The snapshot is taken by the real
`bounded_snapshot.take_bounded_snapshot`, its `mysql` and `mysqldump`
clients turned into `docker exec` into the container, so the clients are
the digest's own and the technique has one implementation.

The schemas are Ghost-shaped, not Ghost's: `blog` has 14 tables with
foreign keys, a trigger and a view, enough rows to dump; `other` stands in
for another tenant. The controls depend on table count and in-flight
transactions, not on column fidelity.

The move account is created with `SELECT, LOCK TABLES, SHOW VIEW, TRIGGER`
on `blog.*`, `BACKUP_ADMIN` on `*.*`, and `SELECT` on the single table
`performance_schema.log_status` (see the grant finding below). It never has
`RELOAD`. It has no `EVENT`: no run uses `--events` and no schema has an
event, so nothing needed it. **The runbook's grant list should not include
`EVENT`.** Every password is generated at run time with
`openssl rand`, held in a mode-700 temporary directory and removed on
exit; none is in a repo file, argv or output.

## How to run

```sh
db/provision/prove-snapshot-locking.sh
PROOF_CONTROLS="2 5" db/provision/prove-snapshot-locking.sh
SABOTAGE=old-path db/provision/prove-snapshot-locking.sh
python3 db/provision/snapshot_probe.py --self-test
```

Needs Docker and about 3 GB of memory. The first run pulls the amd64 image.
`PROOF_PLATFORM` defaults to `linux/amd64`, the hosts' architecture. The
script refuses a set `DOCKER_HOST` or a Docker context other than `default`
or `desktop-linux` (exit 5) before it starts any container. So does
`snapshot_probe.py run` when run directly: it also refuses container names
without the `snapshot-proof-` prefix, so it cannot be pointed at a
container that is not this proof's own.

| Exit | Meaning                                                                         |
| ---- | ------------------------------------------------------------------------------- |
| 0    | `ALL PASSED`                                                                    |
| 1    | a sabotage run went red, as it should                                           |
| 2    | a sabotage run stayed green: the control cannot see that failure                |
| 3    | `OPTION (c) UNAVAILABLE`: a control from 1 to 5 failed with nothing sabotaged   |
| 4    | the control 6 finding could not be recorded                                     |
| 5    | refused before any container: `DOCKER_HOST` is set, or the Docker context is not `default` or `desktop-linux` |

Exit 3 is a stop: option (c) is not available on that version, and the
owner is told before any fallback is built.

`SABOTAGE` names: `coordinates-after-write` (control 1), `old-path`
(controls 2 and 3), `reload-grant` (control 4), `no-timeout` (control 5,
parts A and B), `no-deadline` (control 5, part C).

The refusal in `prove-snapshot-locking.sh` (exit 5) is unit-tested in
`test_snapshot_probe.py` against a fake `docker` on `PATH`: a set
`DOCKER_HOST` is refused before any docker call, and a non-local context
before any container. The refusal in `snapshot_probe.py run` is tested the
same way, plus the name prefix. The fixture needs no Docker.

## CI

`.github/workflows/snapshot-proof-ci.yml` runs the full un-sabotaged proof
on a native `ubuntu-latest` runner, which is x86_64 as db1 is, so the
Mac's amd64 emulation is out of the picture. It runs when the proof's
files change, pulls the pinned digest by its digest, and prints each
control's measured values in its log. It fails on any control failure
(exit 3 or 4). It has `contents: read` only and no secrets. The unit
tests still run in `repo-tooling-ci.yml` on every push.

## The six controls

Each is judged by a pure function in `snapshot_probe.py`, and
`test_snapshot_probe.py` runs each against a sabotage fixture that must fail
and a healthy one that must pass, with no Docker.

1. **Consistent snapshot and coordinates.** Writers keep running on `blog`
   and `other`. The module snapshots `blog`; the dump, with the module's
   `-- CHANGE MASTER TO ...` first line (asserted to parse with
   `extract_tenant_binlog.SOURCE_DATA_PATTERN`), is loaded into the
   replica, which starts at those coordinates with `SOURCE_SSL=1`. After
   catch-up every table's row count and `CHECKSUM TABLE` match.
   _Sabotage:_ a blog write is injected after the unlock and the
   coordinates are read after it. The replica misses those writes.
2. **Another schema is not blocked.** A `SELECT SLEEP(10)` holds
   `other.posts` while the module snapshots `blog`; `other`'s writer's worst
   statement stays under 100 ms. _Sabotage:_ the old path, `RELOAD` plus
   `mysqldump --source-data=2`. Its plain `FLUSH TABLES` waits for the long
   reader and every writer to that table queues behind it for about 10 s,
   which proves the probe can see a stall.
3. **No global metadata lock.** A sampler reads
   `performance_schema.metadata_locks` for the move account's threads as fast
   as one session can, across repeated snapshots. No `GLOBAL` or `COMMIT`
   row may appear, and the sampler must have seen granted table locks (a
   blind sampler is a fail). _Sabotage:_ the old path, whose
   `FLUSH TABLES WITH READ LOCK` shows `GLOBAL` and `COMMIT` shared locks.
   Recorded alongside: `LOCK INSTANCE FOR BACKUP` shows only a `BACKUP LOCK`
   row.
4. **Scoped grants.** The account reading `other` gets error 1142,
   `FLUSH TABLES WITH READ LOCK` gets error 1227, the clone plugin is absent
   from `information_schema.PLUGINS`, and `BACKUP_ADMIN` is its only global
   privilege. _Sabotage:_ grant `RELOAD`, and the flush is accepted.
5. **Bounded wait.** Three parts.
   _A, direct:_ a blog write transaction is held open 3 s. `LOCK TABLES`
   under the module's `lock_wait_timeout` gives error 1205 at about 1 s.
   _B, through the module:_ a blog write transaction is held open 10 s.
   The attempt aborts, backs off and retries; the snapshot succeeds only
   after the transaction ends. Blog writers (one each on `posts`,
   `members`, `settings`, and a Ghost-like multi-table transaction) never
   wait past the bound below.
   _C, two blocked tables:_ `LOCK TABLES` is granted on `members` after
   0.5 s and then waits on `posts`. The server gives each wait 1 s, so the
   client's 1.2 s deadline fires first, and the retry succeeds once `posts`
   is released. The first abort must name the deadline.
   _Sabotage:_ `no-timeout` (a year as the lock timeout, and no client
   deadline) turns A red, because the direct wait runs to the 3 s release,
   and B red, because a `members` writer waits the full 10 s. `no-deadline`
   (no client deadline) turns C red: the server's 1205 on `posts` fires
   first, at about 1.5 s.
6. **DDL behaviour, a finding and not a gate.** See below.

### The wait bound: 1 s in the code, 2 s in the design

The design this proof was written for says the lock wait is 2 s. The shipped
module uses `LOCK_WAIT_TIMEOUT_SECONDS = 1`, a client deadline of 1.2 s and a
hold bound of 0.6 s, so a writer that arrives as the lock is requested waits
at most 1.8 s (`bounded_snapshot.md#the-bounds`). **The shipped 1 s stays.**
It is stricter, and was chosen so wait plus hold stays under two seconds.
Control 5 asserts both: no queued writer waits more than the module's 1.8 s,
and none more than the design's 2 s, each with a 0.25 s allowance for timing
across `docker exec` pipes. A test pins that the module's bound sits inside
the design's.

## Findings

Recorded by the proof, for whoever builds the seeding stories. None is a
reason option (c) is unavailable.

- **The grant list is one table short.** `SELECT` on the schema plus
  `BACKUP_ADMIN` is not enough: reading `performance_schema.log_status`
  gives error 1142, because `log_status` is a table and needs its own
  `SELECT`. The nightly paths hold `SELECT` on `*.*`, so they never hit it.
  A schema-scoped account needs `SELECT` on
  `performance_schema.log_status`, one table, which holds binary-log
  and engine positions and no tenant data. Control 4 records the error with the
  design's grant list, and asserts that `BACKUP_ADMIN` is still the only
  global privilege.
- **BACKUP_ADMIN is needed to read `log_status`.** The same account without
  `BACKUP_ADMIN` (`SELECT` and `LOCK TABLES` on `blog.*`, `SELECT` on
  `log_status`) gets `ERROR 1227 (42000): Access denied; you need (at least
  one of) the BACKUP_ADMIN privilege(s) for this operation`. Control 4
  records it on every run, so the coordinate read needs `BACKUP_ADMIN`.
  `BACKUP_ADMIN` also lets the account take `LOCK INSTANCE FOR BACKUP`,
  which blocks DDL on every schema while it is held; control 6 measured one
  `ALTER` on the other schema waiting about 4 s. A weaker alternative for the
  owner to weigh: `REPLICATION CLIENT` with `SHOW MASTER STATUS`, which
  gives a position consistent while the blog tables are locked. That
  alternative is not measured here. The production grant list is the
  owner's to decide; this proof does not change it.
- **LOCK TABLES can roll back an in-flight write transaction.** Measured, the
  server takes the table locks one at a time in name order: while the request
  waits on `posts`, a `members` writer queues (its table is already held) and
  a `settings` writer does not (not yet requested).
  A write transaction that has touched a table the request waits for, and
  then writes one it already holds, deadlocks with it, and the server picks
  the write as the victim: error 1213, rolled back. The write fails with
  1213 unless the application retries it; nothing here shows Ghost does. The design's
  "writes queue behind it" is true for writers whose first table is held;
  for a multi-table transaction already underway it is a rollback instead.
  The proof counts these (a Ghost-like transaction writer sees some during
  controls 1 and 5) and reproduces one deterministically. The shipped
  module has the same property on the nightly path.
- **DDL under `LOCK INSTANCE FOR BACKUP` (control 6).** Measured: held by
  the move account with no DDL running, DML on every schema stalls at worst
  a few tens of milliseconds, which is noise: it blocks no reads and no
  writes. Measured: one `ALTER TABLE` on the other schema, issued during the
  hold, waits for the rest of it. DML on the table being altered, on that
  schema's other tables and on the blog does **not** queue behind that
  waiting `ALTER`. Not measured: a DDL already running when the instance
  lock is requested. This proof did not try that case, so nothing here says
  how it behaves. Account management was not measured either. The shipped
  module deliberately does not take the instance lock
  (`bounded_snapshot.md#what-is-not-locked`), and this proof makes no
  decision about the move path.
- **The old path's stall comes from `FLUSH TABLES`, before the global lock.**
  `mysqldump --source-data=2` issues a plain `FLUSH TABLES` first; it waits
  for the long reader, and everything queues behind it. The global lock is
  only reached once that returns, which is why control 3's sabotage runs the
  old path without the long reader.

## Results, linux/amd64

`mysqld  Ver 8.0.46 for Linux on x86_64 (MySQL Community Server - GPL)`,
source and replica, the pinned digest. The measured column is one healthy
run; the red column is the matching sabotage run. Values vary from run to
run; the verdicts do not.

| Control | Measured                                                                                           | Sabotaged (red)                                                       |
| ------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1       | 14 tables match on count and checksum; lock wait 12 ms, hold 242 ms                                | 2 of 14 tables differ (13 and 14 rows short)                          |
| 2       | worst `other` statement 64.8 ms over 268 (limit 100 ms)                                            | 9384 ms                                                               |
| 3       | granted table locks seen, no `GLOBAL` or `COMMIT`; `LOCK INSTANCE` shows `BACKUP LOCK` only         | `GLOBAL/SHARED` and `COMMIT/SHARED` granted                           |
| 4       | error 1142 and 1227, no clone plugin, `BACKUP_ADMIN` only                                          | `FLUSH TABLES WITH READ LOCK` accepted (error 0)                      |
| 5       | direct error 1205 at 1.04 s; 3 aborts then success; worst writer wait 1099 ms (`members`)          | worst writer wait 10102 ms                                            |
| 6       | ALTER waited 4.13 s; DML on the altered table at worst 98 ms, did not queue                        | not applicable                                                        |

## Not in scope

Creating the move account on db1, reading db1's schema list, and seeding the
replica are the owner's, in the runbook in `ghost-platform-docs`, not here.
No fallback to a global read lock is built: if a control from 1 to 5 fails
with nothing sabotaged, the proof stops with `OPTION (c) UNAVAILABLE`.
