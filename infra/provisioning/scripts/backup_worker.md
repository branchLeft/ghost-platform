# backup_worker.py

## Module overview

`run_tenant_dump` is the single-tenant, on-demand call an upgrade pipeline
needs before bumping a tenant's Ghost: it returns a `DumpResult` carrying
the dump's FLOOR result (which floor tables the worker itself watched go
past, independent of the producer's own exit code), not just an exit code
— see `_FloorWatcher` below for why this worker keeps its own copy of
that check rather than only trusting the producer's.

This module owns nothing about *how* the worker reaches every tenant on a
schedule — that is the nightly loop's job, built from the same
`run_tenant_dump` call, one invocation per tenant, exactly as
`db/provision/dump_tenant.py`'s own docstring says: "usable both as the
nightly per-tenant loop's one step and as the on-demand dump the upgrade
ring needs before a bump: the same operation, invoked at a different
moment, never a second code path."

Where `DB_DUMP_MYSQL_PWD` comes from under the pull model: the dump
account's password lives in the SAME place this worker's `age` recipients
already live — the password manager, read into org/control's own
environment at run time, never written to any file on the tenant database
host, and never the push model's on-host EnvironmentFile.
`run_tenant_dump` takes it as a plain argument for exactly that reason: the
caller (the nightly loop, or an on-demand invocation) is the one place
that secret is resolved, and it is handed to `pull_encrypt_and_store` as a
single-purpose env entry for one invocation, never persisted anywhere this
module touches. `db/provision/dump_tenant.py`'s own docstring already
anticipated this and left the question open for this module to close;
this is that closure.

## _load_module

Imports a `db/provision/` module by path, the same technique
`shared_objectstorage.py` uses to reach `objectstorage.py` — so
`FLOOR_TABLES` and tenant-name validation stay defined once, on the
producer's own side of the trust boundary, rather than drifting between
two hand-copied constants.

`register_as`, when given, also registers the loaded module in
`sys.modules` under that bare name — `dump_tenant.py` does `from naming
import (...)` as a plain top-level import, which only resolves if
something has already put a module named exactly `naming` in
`sys.modules` (db/provision/ is not on this process's `sys.path`, by
design: db/RUNBOOK-db.md copies that whole directory to the host with
`scp -r` and runs scripts in place, never as an installed package).

## run_tenant_dump

The single-tenant, on-demand call. `dump_tenant_path` and `socket_path`
are real filesystem paths for `dial_in_transport.LocalProcessTransport`
only — `RemoteMysqldumpTransport` reads the tenant slug out of `command`
and ignores the rest, since it runs `mysqldump` itself rather than that
argv.

`env` carries exactly one entry, `DB_DUMP_MYSQL_PWD` — never
`AWS_*`/`DB_BACKUP_*`/`AGE_*`, per the per-tenant dump producer's own
caller contract. Every one of the parameters that WOULD carry a storage
credential (`age_recipient`, `copies`) is consumed by
`pull_encrypt_and_store` on this side of the dial-in call, never forwarded
across it.

## Copy-name tiers

The two copies' env-var prefixes. "primary" is the backup-only Hetzner
project the platform owner has ruled this bucket belongs in — provisioning
it is an owner action, and it is REQUIRED: main() refuses to run at all
without it. "secondary" is the off-supplier second copy the estate's
custody figure names ("Second copy, off-supplier — survives losing the
account, not merely losing a host"); which provider holds it is a still-open
decision this module does not make, so it is OPTIONAL until that decision
names one — entirely absent, this worker still runs with the primary copy
alone, which is the interim plan. A copy that is PARTIALLY configured (some
but not all of its five credential vars set) is never accepted either way,
required or optional: that shape is far more likely to be a typo or a
half-finished rollout than a deliberate choice, and running on it would
silently drop the copy the operator thought they had just configured.

## _copy_target_from_env

Builds one `CopyTarget` from `BACKUP_WORKER_COPY_<NAME>_*` env vars,
or returns `None` for an OPTIONAL copy that is entirely unconfigured.
This function is the only place in this module that reads a storage
credential, and it never returns it — `put` below closes over it and
the credential itself is never stored on the `CopyTarget` or logged.

Three outcomes, never a fourth: every credential var present (a
`CopyTarget`); none of them present and `required=False` (`None`, this
copy is skipped); anything else — a required copy missing any of its
vars, or an optional copy with SOME but not all of them set — refuses
outright, naming exactly which vars are missing.

## Backup-age metric directory

The monitored signal is "the age of the newest successful backup, per
tenant, reported by the side that would notice it stopping" — this worker,
on the org/control side, never the tenant host, which under the pull model
holds no way to report anything about its own backups at all.
hetzner/monitoring already has one collector shaped exactly like this one
needs to be (snds-collector: a node_exporter textfile-collector file,
written atomically, read back and merged rather than overwritten) — reused
here rather than re-derived. Outside /opt/branchleft/ for the same reason
that collector's own output directory is: a directory under /opt/branchleft/
is what a stack's own `--delete` rsync deploy can wipe.

## write_textfile_atomically

Matches hetzner/monitoring's own snds collector: node_exporter's
`--collector.textfile.directory` polls this directory and can scrape a
non-atomic write mid-write, as a truncated or malformed file. Writing to
a sibling temp file and `os.replace`-ing it into place is atomic on the
same filesystem.

The temp name is unique per call (`tempfile.mkstemp`, not a fixed
`<name>.tmp`) — a fixed name is safe only for a single writer at a
time, and this file is written by `record_backup_age_metric` under a
lock that already serialises writers, but a lock one caller forgot to
take (or a future second caller of this same helper) must not then be
able to have two `.tmp` files collide and rename whichever one lost the
race into place. A unique name removes that failure mode regardless of
what does or does not protect the call above this one.

## record_backup_age_metric

Records `tenant`'s last-good-backup timestamp, merged with every OTHER
tenant this module has previously recorded into the same file. Called
from `main()` only after a floor-verified, `ok=True` result — never for a
run that failed, so a stopped tenant's gauge simply stops advancing rather
than being overwritten with a fresh, misleadingly healthy-looking
timestamp.

The read, the merge and the write are one critical section, held under an
exclusive `fcntl.flock` on a sibling lock file for the whole duration.
Without it, two tenants completing a floor-verified dump close together
can both read the same prior file, and whichever writes second silently
reverts the other's fresh, real success back to its stale value — turning
a HEALTHY tenant's gauge stale, which is the opposite failure from the one
this signal exists to catch (see `BackupAgeMetricConcurrencyTests` for a
deterministic, forced reproduction of exactly that loss).

`_use_lock` and `_after_read` exist only for that test's forced interleave
— `main()` never passes either, so every real caller always takes the
lock and never pauses mid-critical-section.

Best-effort and never raises: a metrics-directory or lock-file write
failure must never turn an already-successful, already-stored dump into a
failed run — the backup itself is good whether or not this exporter can
report it, and a metric that stops advancing because this call itself
keeps failing is caught by the same growing-age alert as a worker that has
stopped running at all.
