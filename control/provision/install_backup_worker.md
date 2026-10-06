# install_backup_worker.py

## Module overview

Installs the per-tenant backup worker (`nightly_dump_loop.py`, calling
`backup_worker.py`) on the control host. It installs everything that holds
no secret, then turns on the nightly timer only once every input the loop
needs is in place. It is idempotent: a re-run with nothing changed changes
nothing.

It runs as root, from inside a release directory that has already been
staged on the host. That directory holds the subset of this repository the
loop loads at run time: `infra/provisioning/scripts/`, `db/provision/` and
`control/provision/`. `backup_worker.py` loads `db/provision/` modules by
their path relative to itself, so those two directories must stay side by
side, exactly as they sit in this repository.

## Layout on the host

| Path | What |
|---|---|
| `/opt/branchleft/backup-worker/releases/<commit>/` | One staged release per commit, root-owned |
| `/opt/branchleft/backup-worker/current` | Symlink to the release the unit runs, swapped atomically |
| `/etc/systemd/system/branchleft-backup-worker.{service,timer}` | The units, copied from the release when their bytes differ |
| `/etc/branchleft/backup-worker.env` | Credentials and connection settings, `root:root` `0600`; see `backup-worker.env.example` |
| `/etc/branchleft/backup-worker-tenants` | One tenant slug per line, `root:backup-worker` `0640` |
| `/var/lib/branchleft/backup-worker-exporter/` | The textfile-collector directory the worker writes its two gauges to; created by systemd's `StateDirectory=` |
| `/run/branchleft-backup-worker/` | The loop's run lock; created by systemd's `RuntimeDirectory=` |

The metrics directory is `backup_worker.py`'s own default, set explicitly
in the unit as well. The unit test ties the two together, so they cannot
drift apart without a test failing. node_exporter on the same host reads
this directory through its `--collector.textfile.directory` flag.

## What turns the timer on

`systemctl enable --now` runs on the timer only when **all** of these hold.
Otherwise the script installs everything else, lists each missing item by
name (never by value), and exits 2.

- The environment file exists, is a regular file (a symlink is refused),
  is owned by root, has mode `0600`, and sets every name the loop requires.
  `REQUIRED_ENV_NAMES` is tested against the `_require_env` calls in
  `nightly_dump_loop.py` and against `backup_worker.py`'s required copy.
- The database CA it names is an absolute path to a world-readable file.
  The service account has to read it.
- The tenants file is root-owned, writable only by root, readable by the
  service account, and names at least one tenant. It decides whose data is
  dumped, so the account that runs the dump must not be able to edit it.
- The recipients file (`/etc/branchleft/backup-worker-recipients`) is
  root-owned, writable only by root, readable by the service account, and
  gives every tenant in the tenants file a line `tenant age1...` of its
  own. A malformed key, a repeated tenant, or one recipient listed for two
  tenants refuses the install. Each tenant's dump is encrypted to that
  tenant's recipient alone, so no tenant's key can decrypt another
  tenant's dump (LLD-9). Whoever edits this file decides whose key opens
  whose dump, which is why the service account cannot.
- `age` and `mysqldump` are installed, and `mysqldump` reports the `8.0`
  client line. A newer client breaks `--source-data` against an 8.0 server.
  `db/provision/install_host_prereqs.py` installs both.

When the installer refuses, it also **disables** the timer, so a timer
that an earlier install enabled cannot keep running against inputs the
installer now rejects.

The tenants check also runs at **every run**, not only at install. The
unit's `ExecStartPre` calls this script with `--preflight` as the service
account. It re-checks the tenants file (owner, mode, at least one tenant),
and that every tenant has a recipient of its own. A failure refuses the
run before the loop starts. A tenant added by hand with no recipient
therefore stops the backups rather than being encrypted to another
tenant's key. The refused run fails the unit, and `TenantBackupAgeHigh`
fires once the last success is older than 36 hours.

If any other input breaks after the timer is on (a rotated password, a
moved CA), the nightly run itself fails loudly in the same way.

The script never starts the service itself. The first run is a deliberate
operator step, so its output is read rather than assumed.

## Release checks

Before changing anything, the script refuses a release that is not a
direct child of the releases directory, is missing a file the loop loads,
or holds any file or directory that is not root-owned or is writable by
group or others. The service account executes this code, so it must not be
able to change it.

## Unit hardening

The service runs as the unprivileged `backup-worker` account, with an
empty capability set, `NoNewPrivileges`, `ProtectSystem=strict` (writable
paths are only its state and runtime directories) and a private `/tmp`.
`PrivateDevices=` is deliberately absent: the transport passes the
database password to `mysqldump` as `/dev/fd/N`, and the unit must not
depend on a minimal `/dev` keeping that path.

`TimeoutStartSec=6h` bounds the whole serial loop. The transport already
bounds each tenant's dump at 30 minutes.

`MemoryMax=1G` protects the shared host. The worker holds each dump's
ciphertext in memory before uploading it, so a tenant whose dump outgrows
the limit fails its run loudly rather than pressing on Nextcloud's memory.
Raise the limit only with the host's headroom in view.

The tests pin `ProtectSystem=strict`, the empty `CapabilityBoundingSet=`,
`NoNewPrivileges`, `PrivateTmp`, `MemoryMax` and the `ExecStartPre`, so
loosening any of them fails a test.

## Timer

The timer fires at 01:40 UTC, with up to five minutes of random delay.
`Persistent=true` catches up on a night the host was down. The time sits
well clear of db1's own 03:10 UTC all-databases dump, so the two never wait
on each other's read lock.
