# scratch_preflight.py

The first part of the pre-swap scratch-copy gate. Before a tenant's colour is
swapped, the gate restores that tenant's newest backup into a throwaway MySQL
server and proves the restored database equals what the backup recorded about
itself. It exits nonzero, and prints `REFUSED`, unless every check passes. A
caller that runs the gate treats any nonzero exit as "do not continue".

It is deterministic software. No agent takes part in it.

## What it never does

It holds no address for the tenant's database host and takes no argument that
could name one. Its only input is a backup object in the copy's bucket, read
with the drill's Get+List credential, and its only database is a server it
starts itself. A test collects every `--host` it passes to a `mysql` client and
requires that to be the scratch server alone.

It never writes to the tenant's database, the bucket or any other server, and
it never reads the tenant's live data.

## One run

1. **Pick the backup.** The newest `<UTC timestamp>.sql.age` object for the
   tenant on the primary copy (`--copy` names another). It is refused if it is
   older than the age bound: `BACKUP_DRILL_MAX_BACKUP_AGE_HOURS` (default 48),
   tightened with `--max-age-hours`.
2. **Verify the backup**, before any database exists:
   - the age header names exactly one recipient, an X25519 key;
   - the tenant's own identity decrypts it (`age` in the pinned recovery image,
     no network, no container log);
   - it carries the backup worker's manifest (`backup_manifest.md`), recorded
     cleanly, naming a site title and a staff user.

   The manifest was read from the dump's own bytes at backup time, so it is the
   source's account of itself, never the restore's.
3. **Write the plaintext** to a 0600 file in a 0700 directory under the work
   directory, which must be tmpfs (the check has no environment switch). The
   directory is named `preflight-run-<id>`, so the drill's own sweep of `run-*`
   never touches it, and this gate's sweep never touches the drill's.
4. **Start the scratch server.** A container of db1's pinned server image,
   named by digest, on a Docker network created with `--internal`, so neither
   the server nor the clients that talk to it have a route out of the host. Its
   datadir is a bounded tmpfs, so the restored data is in memory and goes with
   the container. Its root password is random and crosses to Docker as an
   environment value, never argv. Every container and network carries the label
   `branchleft.scratch-preflight`.
5. **Restore.** `db/recovery/restore_drained.py`'s `restore_only`: readiness
   (a real `SELECT 1`), the refusal to import onto a server that already holds
   any non-system database, then the import. A nonzero exit from the import is a
   refusal, whatever the content looks like afterwards.
6. **Compare with the backup.** The restored database's site title, staff user
   count, published post count, member count and newest post title must equal
   the manifest's. Ghost's install defaults, an empty restore, or a partial one
   all fail here.
7. **Discard.** Whatever happened, the server, the network and the plaintext
   are removed. Only a passing run asked to `keep` the server skips the
   removal, and then its caller owns `ScratchMysql.discard()`.

`ok` is set only after step 6.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The restore passed every check. |
| 1 | Refused: a check failed, or something the gate needs (Docker, an image, the bucket, the key) was unavailable. The reason is the last line on stderr. |
| 2 | Not run: no `--tenant`, a malformed environment or option, or another gate run holds the lock. |
| 143 | Stopped by SIGTERM; cleanup ran first. |

## Configuration

The gate reads the drill's environment file (`BACKUP_DRILL_*`, see
`restore_drill.md`) through the drill's own `config_from_env`: the copies, the
images by digest, the identity directory and the work directory. It uses the
recovery and MySQL images; the Ghost and sidecar names are read, as the drill
reads them, for the parts of the gate that start a colour.

```
scratch_preflight.py --tenant TENANT [--copy NAME] [--max-age-hours N]
scratch_preflight.py --cleanup
```

`--cleanup` removes every labelled server and network and every
`preflight-run-*` directory a killed run left behind. It is the step to run
after any stop, a SIGKILL included.

`--allow-disk-work-dir` skips the tmpfs check for a local proof. The
environment cannot.

## As a library

`run_gate(config=, tenant=, hooks=, copy_name=, keep=)` returns a `GateReport`
and never raises. With `keep=True` and a pass, `report.scratch` is the running
`ScratchMysql` (container, network, password) for a caller that goes on to start
a colour against the restored copy; that caller must call `discard()`. On any
failure the server is already gone and `report.scratch` is `None`.

## What the tests prove, and what they do not

`test_scratch_preflight.py` runs the restore for real: every `mysql` call the
gate makes lands on a throwaway MySQL server the test starts (a local `mysqld`
on a temporary datadir, or a container of db1's pinned image in CI), loaded
with a miniature Ghost schema through a dump in mysqldump's form. Each control
is a real restore that must not pass:

| Control | Why it matters |
|---|---|
| The import exits nonzero after every watched table has loaded | The content equals the manifest, so only the import's exit status can refuse it. With that status swallowed the same backup passes. |
| A dump that does not parse | An import that fails outright. |
| A restore whose content differs from its backup | The manifest says another title. With the comparison removed it passes. |
| A dump that creates the database and nothing else | An empty restore, backed up as a real site. |
| A server that already holds the tenant's database | The import must not run into it; the pre-existing rows are untouched. |

`age` is the real local binary on real ciphertext. Docker is faked, so the
tests do not prove the container wiring: that the pinned images start, that the
internal network lets the clients reach the server, that the recovery image's
`mysql` client behaves as the local one does. That proof is one run of the gate
on the control host against a real backup, which needs the host.
