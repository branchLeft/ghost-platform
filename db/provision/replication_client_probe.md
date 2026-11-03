# replication_client_probe.py and prove-replication-client.sh

## Module overview

A proof of whether an account holding `REPLICATION CLIENT` alone, with no
`BACKUP_ADMIN` and no `RELOAD`, gets binary-log coordinates that match its
snapshot. It decides the blog move account's grant list: if it passes, the
account does not need `BACKUP_ADMIN`, and with it loses `LOCK INSTANCE FOR
BACKUP`, which blocks DDL on every schema while held
(`snapshot_probe.md`, control 6). If it fails on the correct ordering,
`BACKUP_ADMIN` stays.

The method is the shipped `bounded_snapshot.take_bounded_snapshot`, run as
that account with `coordinates="master_status"`: `LOCK TABLES … READ` on
just the blog's tables, then `SHOW MASTER STATUS` under the lock, then the
`mysqldump --single-transaction` snapshot, then `UNLOCK TABLES`. The
default, `coordinates="log_status"`, is unchanged and is what both nightly
paths still use. One implementation, so the proof cannot pass on a copy of
the technique.

It runs on the same throwaway local containers as `snapshot_probe.py` (the
digest pinned in `db/RUNBOOK-db.md`, `linux/amd64`, a source and a replica)
and refuses the same ambient Docker targets. Nothing here reaches db1 or
any host. `prove-replication-client.sh` is a wrapper that selects this probe
in `prove-snapshot-locking.sh`; passwords are generated at run time and
never in a repo file, argv or output.

## How to run

```sh
db/provision/prove-replication-client.sh
PROOF_CONTROLS="1" db/provision/prove-replication-client.sh
SABOTAGE=coordinates-before-lock db/provision/prove-replication-client.sh
python3 db/provision/replication_client_probe.py --self-test
```

| Exit | Meaning                                                                          |
| ---- | -------------------------------------------------------------------------------- |
| 0    | `ALL PASSED`: `REPLICATION CLIENT` is enough                                     |
| 1    | a sabotage run went red, as it should                                            |
| 2    | a sabotage run stayed green: the control cannot see that failure                 |
| 3    | `REPLICATION CLIENT NOT ADEQUATE`: a control failed with nothing sabotaged; `BACKUP_ADMIN` stays |
| 5    | refused before any container                                                     |

## The three controls

1. **Coordinates consistent with the snapshot.** Four rounds. Each round
   starts a Ghost-like multi-table writer on `blog` and a writer on `other`
   (another tenant), takes the snapshot as the account, loads the dump into
   the replica, starts the replica at the coordinates, and lets it catch up
   to the source. It then asserts, for that round: every table matches on
   row count and `CHECKSUM TABLE`; `posts` by title and `emails` by post have
   no key lost and none duplicated; and the replay applied at least one blog
   write the dump did not hold (a replay of nothing proves nothing). A
   duplicated write also stops the replica's SQL thread on the unique slug,
   and that stop is a failure. The control first checks the account's global
   privileges are exactly `REPLICATION CLIENT`.
2. **Another tenant is not blocked.** A `SELECT SLEEP(10)` holds
   `other.posts` while the blog is snapshotted repeatedly; `other`'s writer's
   worst statement stays under 100 ms. In a second phase a sampler reads
   `performance_schema.metadata_locks` for the account's threads across ten
   snapshots: no `GLOBAL` or `COMMIT` lock may appear, a blind sampler is a
   fail, and a blog writer's worst wait stays inside the module's 1.8 s
   bound (and the 2 s design ceiling), each with the 0.25 s measurement
   allowance of `snapshot_probe.md`.
3. **Scoped grants.** The account reading `other` gets error 1142,
   `FLUSH TABLES WITH READ LOCK` and `LOCK INSTANCE FOR BACKUP` get error
   1227, `SHOW MASTER STATUS` is allowed, and `REPLICATION CLIENT` is the
   only global privilege. Recorded: reading `performance_schema.log_status`.

## Red cases

Each goes red and exits 1. The orderings are the failures the control
exists to see.

| `SABOTAGE`                 | What it does                                                                     | Turns red |
| -------------------------- | -------------------------------------------------------------------------------- | --------- |
| `coordinates-before-lock`  | reads `SHOW MASTER STATUS` 0.5 s before the module takes its lock; the replica replays writes the dump already holds | 1 |
| `coordinates-after-unlock` | reads it 0.5 s after the module has released; the replica misses writes the dump lacks | 1 |
| `backup-admin-grant`       | grants the account `BACKUP_ADMIN`, so a pass would not show `REPLICATION CLIENT` is enough | 1, 3 |
| `reload-grant`             | grants `RELOAD`; `FLUSH TABLES WITH READ LOCK` is accepted                       | 3 |
| `old-path`                 | `RELOAD` plus `mysqldump --source-data=2`: its `FLUSH TABLES` waits for the long reader and `other`'s writes queue behind it | 2 |

## Why the ordering is consistent

While the coordinator holds `READ` on every blog table, no blog transaction
can be in flight or start. `LOCK TABLES` is granted only after each blog
transaction that held a lock has committed, and a commit is in the binary log
before it returns. So a position read under the lock is after every
committed blog write and before any later one, and the dump's snapshot opens
under the same lock. Other tenants' writes move the position too, and the
replica's filter drops them. `SHOW MASTER STATUS` takes no table lock, no
flush and no global lock of its own.

## Results, linux/amd64

`mysqld  Ver 8.0.46 for Linux on x86_64`, the pinned digest. Local runs are
on a Mac under amd64 emulation, which `snapshot_probe.md` already shows is
not a fair stand-in for control 2's 100 ms limit; the native x86_64 CI job
is the reference for control 2's timing.

| Control | Measured, correct ordering                                                                                  | Sabotaged (red)                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1       | 4 of 4 rounds clean: 14 tables match, no key lost or duplicated, 94 to 108 blog rows replayed past each dump; lock wait 3 to 13 ms, hold 151 to 394 ms | before the lock: 4 of 4 rounds red, replica SQL thread stopped on error 1062 (duplicate); after the unlock: 4 of 4 rounds red, 5 to 8 blog rows lost each; with `BACKUP_ADMIN` held: red on the privilege check |
| 2       | CI is the reference (see below)                                                                              | CI is the reference (see below)                                                                      |
| 3       | error 1142 on `other`, 1227 on FTWRL and on `LOCK INSTANCE FOR BACKUP`, `SHOW MASTER STATUS` allowed, `REPLICATION CLIENT` the only global privilege | `LOCK INSTANCE FOR BACKUP` accepted (error 0) and `BACKUP_ADMIN` listed                              |

On the correct ordering `SHOW MASTER STATUS` under the table lock gave
coordinates that, replayed into a fresh replica under continuing writes to
the blog and to another schema, lost nothing and duplicated nothing, on every
round. The account never held `BACKUP_ADMIN` or `RELOAD`.

## Not in scope

Changing the grants on db1 or any host, and wiring the nightly paths to
`coordinates="master_status"`. Those are separate, hand-delivered changes.
`SHOW BINARY LOG STATUS` replaces `SHOW MASTER STATUS` from MySQL 8.4; db1
runs 8.0, so this proof and the module use the older statement.
