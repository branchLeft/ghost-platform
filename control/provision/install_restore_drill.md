# install_restore_drill.py

Installs the weekly restore drill's two units on the control host. Like
`install_backup_worker.py`, it is run as root from inside a staged release
directory, and it is idempotent.

## Order

The backup worker's installer runs first, from the same release. This
installer refuses a release that `/opt/branchleft/backup-worker/current` does
not point at, so the drill never runs code that the worker is not running.
The release must also carry `db/recovery/`, because the drill restores
through `restore_drained.py`. The worker's staged subset did not include
that directory before.

## What turns the timer on

`systemctl enable --now` runs on `branchleft-restore-drill.timer` only when
all of these hold. Otherwise the installer lists each missing item by name
(never by value), disables the timer, and exits 2.

- `/etc/branchleft/restore-drill.env` is a root-owned 0600 regular file. A
  symlink is refused. The file must pass the drill's own reader:
  - the primary copy fully set, and a secondary copy fully set or absent;
  - every image named by digest.
- The worker's tenants file names at least one tenant.
- `/etc/branchleft/restore-drill/identities/` is a root-owned 0700
  directory, and it holds `<tenant>.key` for every tenant. Each key file is
  root-owned, 0600, and holds an age identity.
- `docker` is installed and its daemon answers.

## Why the service runs as root

The drill drives docker. Access to the docker socket is root-equivalent
whichever account holds it, so a separate account in the `docker` group
would add a name, not a boundary. The unit uses the hardening that does not
break that use:

- `NoNewPrivileges`;
- `ProtectSystem=full`;
- kernel and control-group protection.

It deliberately sets no `PrivateTmp`. The docker daemon resolves bind-mount
paths in the host's own mount namespace, so a private `/tmp` would hide the
drain flag and the identities from it.

## Where decrypted data may exist

The decrypted dump is written only under the unit's `RuntimeDirectory`
(`/run/branchleft-restore-drill`), a tmpfs that systemd removes however the
run ends. The drill reads `/proc/mounts` and refuses any work directory
that is not on tmpfs or ramfs. Cleanup happens at three points:

- on SIGTERM, the drill turns the signal into an exception, so its own
  cleanup still runs, and it exits 143;
- `ExecStopPost` runs `restore_drill.py --cleanup` after any stop, a
  SIGKILL at `TimeoutStopSec` included, and removes every labelled
  container and network, with their volumes;
- every run first sweeps `run-*` directories that an earlier run left
  behind.

Every short-lived container that sees plaintext or key material runs with
`--log-driver none`, so Docker keeps no copy of its output under
`/var/lib/docker`: the decrypt, the key generation and encryption, and
every `mysql` client call.

## Timer

Sunday 04:20 UTC, with up to ten minutes of random delay, and
`Persistent=true` so a week the host was down is caught up. That time is
clear of the backup worker's 01:40 UTC loop, and the drill never touches
the tenant database host.
