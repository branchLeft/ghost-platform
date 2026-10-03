# The nightly per-tenant dump loop

`nightly_dump_loop.py` is the scheduled caller that reaches every tenant,
one per night, from the same `run_tenant_dump` call `backup_worker.main()`
uses for an on-demand dump before a Ghost bump — one operation, invoked
at a different moment, never a second code path. `backup_worker.py`'s own
docstrings point into `backup_worker.md` beside it; this file covers only
what is specific to the loop.

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

## Metrics: the same functions, per tenant

The loop calls `backup_worker.record_lock_wait_metric` and
`backup_worker.record_backup_age_metric` directly — the SAME functions
`backup_worker.main()` uses for the on-demand path, so the two callers
can never drift into writing a metric two different ways. See
`backup_worker.md#lock-wait-metric-file` and
`backup_worker.md#record_backup_age_metric` for the metrics themselves,
including the lock-wait gauge's proxy nature under
`RemoteMysqldumpTransport`, the real transport both callers now share.

## Where it runs

The loop runs on the control host, under `branchleft-backup-worker.timer`,
from a staged release. `control/provision/install_backup_worker.md`
describes the install. That host's native node_exporter reads the metrics
directory as its textfile-collector directory.
