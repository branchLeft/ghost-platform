# Nightly per-tenant dumps, and the lock-wait signal

`backup_worker.py` is the org/control-side pull: it dials in, runs one
tenant's `db/provision/dump_tenant.py` remotely, encrypts the stream to
that tenant's `age` recipient, and stores it. `nightly_dump_loop.py` is
the scheduled caller that reaches every tenant, one per night, from the
same `run_tenant_dump` call `backup_worker.main()` uses for an on-demand
dump before a Ghost bump — one operation, invoked at a different moment,
never a second code path.

## Serial by construction, refused rather than queued

Two separate guarantees, deliberately kept apart:

1. **Tenants are dumped one at a time.** `run_nightly_loop` is a plain
   sequential `for` loop — nothing spawns a thread, a process pool or an
   async task per tenant, so no code path can run two `run_tenant_dump`
   calls concurrently within one invocation. `SerialExecutionProofTests`
   proves this against real wall-clock behaviour (each fake producer
   records its own start/end interval; no two overlap), with a paired
   control case that calls the same per-tenant function from three
   threads instead of the loop and does overlap — proof the seriality is
   a property of the loop, not an accident of a fast fake producer.
2. **A second, overlapping invocation of the whole script is refused,
   not queued.** `--run-lock-path`, held with a non-blocking `flock` for
   the run's duration. Refusing beats blocking: a second run queued up
   behind a stuck first one would itself run into the same stuck
   condition, and a growing queue of blocked nightly loops is worse than
   one skipped night the next scheduled run corrects.

Both matter because `mysqldump --source-data=2` takes a brief,
server-wide `FLUSH TABLES WITH READ LOCK` per tenant dump — running two
dumps at once would queue two of those locks against each other on top
of whatever ordinary write traffic is already waiting.

No per-tenant identity or registry lives in this repository, so unlike
`db/provision/dump_nightly.py`'s old `--all-databases` shape, the caller
(the scheduler, wherever the tenant registry lives) must name every
tenant explicitly: `--tenant` (repeatable) and/or `--tenants-file` (one
slug per line). The two are additive and de-duplicated.

One tenant's failure — a floor miss, a transport error, an exception
`run_tenant_dump` itself does not catch — never stops the rest of the
run: `_dump_one_tenant` catches broadly, on purpose, and the loop always
continues. The exit code reports whether every tenant succeeded, but
only after every tenant has been attempted.

## The lock-wait signal is a proxy, not a direct read

`_LockWaitTimer` times the gap between dialling in and the producer's
first byte of output. `--source-data=2` writes its binlog-position
comment only once the lock is granted and released, so that gap is
dominated by the wait, not by the dump itself — nothing on this side of
the dial-in call holds a SQL connection of its own to ask MySQL directly
how long a lock wait took.

**This is a proxy, and the non-lock portion of it is unverified.** The
gap also includes dial-in/auth and connection setup before MySQL is even
reached. Today that overhead is measured only against
`LocalProcessTransport` (a same-host subprocess, near-zero dial-in cost)
— the real remote transport is `dial_in_transport.py`'s own open item,
not yet wired (tracked separately from this story). Whether the non-lock
overhead stays small and roughly constant under the real channel, versus
growing under the exact load this alert exists to catch (many tenants
queuing behind write traffic), is not yet checked against anything but
the local stand-in.

`first_byte` stays `None` if the producer never wrote anything at all —
that is "no wait was measured", not "the wait was zero", and callers
must tell the two apart rather than recording a false 0.

## Two independent gauges, two files, two locks

`record_backup_age_metric` and `record_lock_wait_metric` both write a
node_exporter textfile-collector gauge, read-merge-write under an
exclusive `flock`, matching `hetzner/monitoring`'s existing SNDS
collector convention — reused rather than re-derived. They use separate
files and separate locks on purpose: the two are written at different
points in the same run, and merging them into one file would let either
write's failure corrupt the other's already-good value.

The gating differs between them, and the difference is load-bearing.
`record_backup_age_metric` is called only after a floor-verified
success, so a stopped tenant's gauge simply stops advancing rather than
being overwritten with a misleadingly healthy timestamp. The lock-wait
gauge is recorded whenever a wait was measured, regardless of
`result.ok` — the lock is taken (or waited for) before the floor check
or the storage write ever runs, so a tenant whose dump then fails for an
unrelated reason can still be the one whose wait needs to be seen.
`WiringSabotageForLockWaitGatingTests` reproduces the wrong gate
(`result.ok`, the backup-age gauge's own shape) against an identical
failed result and shows the wait would otherwise be silently lost.

## `DB_DUMP_MYSQL_PWD`, under the pull model

The dump account's password lives where this worker's `age` recipients
already live — the password manager, read into org/control's own
environment at run time, never written to any file on the tenant
database host, and never the old push model's on-host `EnvironmentFile`.
`run_tenant_dump` takes it as a plain argument for that reason: the
caller resolves the secret once, and it is handed to
`pull_encrypt_and_store` as a single-purpose env entry, never persisted
anywhere this module touches.

## Loading `db/provision/` by path

`_load_module` imports a `db/provision/` module by file path — the same
technique `shared_objectstorage.py` uses to reach `objectstorage.py` —
so `FLOOR_TABLES` and tenant-name validation stay defined once, on the
producer's own side of the trust boundary, rather than drifting between
two hand-copied constants. `register_as`, when given, also registers the
module in `sys.modules` under a bare name, because `dump_tenant.py` does
`from naming import (...)` as a plain top-level import that only
resolves if something has already put a module named `naming` there —
`db/provision/` is not on this process's `sys.path` by design (see
`db/RUNBOOK-db.md`: that directory is copied to the host and run in
place, never installed as a package).

## The two storage copies

`REQUIRED_COPY_NAMES` (`primary`) must be fully configured or the worker
refuses to run at all; `OPTIONAL_COPY_NAMES` (`secondary`) may be fully
configured or entirely absent, standing in for the off-supplier second
copy the platform's own backup-and-recovery design names, whose provider
is still an open decision. A copy that is *partially* configured — some
but not all of its five credential vars set — is refused either way,
required or optional: that shape is far more likely a typo or a
half-finished rollout than a deliberate choice, and running on it would
silently drop the copy the operator thought they had just configured.

## Test convention — real producer, faked binaries only

`test_backup_worker.py` and `test_nightly_dump_loop.py` run
`run_tenant_dump`/`run_nightly_loop` and, separately, `main()`, against
the real `db/provision/dump_tenant.py` and real `age` — never a fake
standing in for the producer itself. Only `mysql` and `mysqldump` are
faked, as tiny shell scripts placed first on `PATH`, because a real
MySQL instance is the local-container proof this repo's own convention
(`db/provision/test_extract_tenant_binlog.py`) keeps out of the fast,
hermetic unit suite. The storage "copies" are plain local files standing
in for the two cloud buckets — their credentials are not this story's to
provision, see the PR body — and, in the `main()`-wiring tests,
`shared_objectstorage.put_object` itself is mocked, specifically so
`main()`'s real env-parsing and copy-selection logic runs unmocked
against synthetic, dummy credential values, with no real network call.

## Scrape target — still open

Which host in org/control actually runs this worker, and how
node_exporter's textfile-collector scrape target reaches it, is not
decided in this repository. Nothing here assumes a name for it.
