# nextcloud_backup.py

## Module overview

Backs up the Nextcloud stack on the control host (`ops1`), then proves that the
backup restores. It never reads the owner's data. The proof compares two
counts, calendars and calendar objects, between the live database at backup
time and the copy restored from the backup. Nothing it prints, logs or writes
is a row, a name or an address. It prints counts, sizes, digests and paths
only. When docker, psql or tar fails, their output is withheld, because an
error message can quote a row.

The owner runs it by hand on the host. The runbook is in ghost-platform-docs:
`nextcloud-backup-ops1-runbook.md`.

## Commands

| Command | What it does |
|---|---|
| `take` | Dumps the database and archives the app volume into a new directory under `/var/backups/branchleft/nextcloud/` |
| `verify DIR` | Restores `DIR` into throwaway containers and compares the counts |
| `seal DIR --recipient-file F` | Encrypts `DIR` with `age` into `DIR.tar.age` for the off-host copy, and writes its sha256 |
| `run` | Runs `take`, then `verify`, then prunes older on-host copies (`--keep`, default 3). This is the step a later deploy re-runs first. |

Exit codes:

- **0**: the backup was taken and proven.
- **1**: a check failed. This covers a count mismatch, a file that no longer
  matches its recorded digest, a dump or archive that does not read to the
  end, and a restore that loads nothing.
- **2**: a precondition is missing, so nothing was proven. Examples: no single
  database container, too little disk space, or a deploy of the stack
  holding its lock.

## What take records

Each backup directory is `root:root 0700`. It holds:

- `db.sql.gz`: `pg_dump --no-owner --no-acl`, so a fresh server can restore it
  without the live server's roles;
- `app.tar.gz`: the `nextcloud-app` volume, mounted read-only into a
  throwaway container that has no network;
- `manifest.json` (`0600`): the live counts, the number of entries in the
  app volume, the database image id, and the sha256 of both files.

Take counts the live database before and after the dump, and fails if the
counts moved, so the recorded counts are pinned to what the dump holds. If a
take fails partway, it removes its own directory. A half-written copy is
never left to be mistaken for a backup.

Take refuses to start if the backup would leave less than 1 GiB free. It
estimates its size as twice the database size plus twice the volume size.
The backup sits on the same disk as the live volumes, and filling that disk
would stop the live database from writing.

## Locking

`take` and `run` hold `flock` on `/etc/branchleft/<project>.deploy.lock`. That
is the same lock the host's deploy tool takes for this stack (`branchleft_deploy.py`'s
`deploy_lock_path` in shared-infra). A backup and a deploy of this stack
therefore never overlap. If the lock is held, the run exits 2 and does
nothing. This lock does not cover a Pulumi or host-level apply to `ops1`. The
runbook forbids running this script while one is in progress.

## How verify proves it

1. It checks both files against the digests recorded in the manifest.
2. It reads the app archive to the end, which also checks the gzip CRC. It
   then requires `config/config.php` and `data`, and compares the entry count
   with the live count.
3. It starts one throwaway PostgreSQL from the exact image id the live
   database runs. The container has `--network none`, `--log-driver none`, a
   memory cap (`--restore-memory`, default 384m) and a random password passed
   through the environment. It is always removed with `docker rm -f -v`.
4. It waits for readiness over TCP. During its init phase the image listens
   only on the socket, so a socket probe would pass too early.
5. It loads the dump with `ON_ERROR_STOP=1`.
6. It counts in the restore and compares the result with the manifest.

Two controls stop a vacuous pass:

- **An empty restore fails.** With no calendar tables, the count query errors
  and verify exits 1.
- **A live count of zero calendars is refused**, even when the restored
  count is also zero, because equal zeros prove nothing.

## Seal and the off-host copy

`seal` encrypts a backup directory to an `age` recipient file and writes
`<name>.tar.age.sha256` beside it. The off-host copy is that sealed file,
moved from the host by the owner and stored as the runbook describes. It is
proven by downloading it back and matching its sha256 to the sealed file on
the host, which this script has already proven restorable. Pruning removes a
sealed file together with its directory.
