# restore_drill.py

The weekly restore drill. It runs on the control host, where the backup worker
runs, from `branchleft-restore-drill.timer`. Its design is LLD-9
(`ghost-platform-docs/19-try-it-now-design/09-backup-and-recovery.html`),
§07c, §08 and R9. The owner's rulings of 2026-10-04 settle where it restores
(temporary containers on the control host) and how it proves erasure (a
throwaway tenant on each run).

It is deterministic scheduled software. No agent takes part in it.

## One run

1. **Choose.** The run picks one tenant from the worker's tenants file, and
   one copy from the copies configured in its environment. Both rotate by
   whole weeks since the epoch, so consecutive weekly runs alternate between
   two copies. An ISO week number would not do that across a 53-week year.
   With only the primary copy configured (the owner's `copy2=c` ruling), every
   run restores from it. Once a secondary copy is configured, the runs
   alternate between the two with no code change. `--tenant` and `--copy`
   override the week's choice for a hand-run drill.
2. **Check every recipient.** For every tenant in the tenants file, the run
   reads the age header of every object under `dumps/<tenant>/` on the chosen
   copy, using a ranged GET of the first 4 KiB. Each header must name exactly
   one recipient, and that recipient must be an X25519 key. A second
   recipient is the defect LLD-9 §02 names: it leaves every test green while
   removing the ability to erase anyone. The restored object also has to
   decrypt with the tenant's own key (step 5). Together, the two checks show
   that its one recipient is that tenant's key.
3. **Pick the newest backup.** The newest `<UTC timestamp>.sql.age` object
   for the tenant. A run fails if that object is older than
   `BACKUP_DRILL_MAX_BACKUP_AGE_HOURS` (default 48).
4. **Prove erasure.** The run makes a throwaway age key pair in the pinned
   recovery image. It encrypts a synthetic one-table dump to that key and
   proves the key opens it. It then destroys the key: the file is
   overwritten, fsynced and unlinked. Finally it asks every key the drill
   holds, read at that moment, to decrypt the synthetic dump.
   - **Right reason:** the attempt fails with age's own `no identity matched
     any of the recipients`. The run records that line.
   - **Erasure broken:** the attempt succeeds. The run fails with
     `ErasureBrokenError`.
   - **Wrong reason:** the attempt fails with any other error. The run fails
     with `ErasureWrongReasonError`.

   The check that the key opened the dump before destruction is what makes
   the later failure mean "the key is gone", not "the blob was bad".
5. **Restore.** The tenant's newest object is decrypted with that tenant's
   own key, inside the recovery image with no network and no container log.
   The backup worker's manifest is read from the plaintext's last line
   (`backup_manifest.md`): the title, counts and newest post as they were at
   backup time, from the dump's own bytes. A backup with no manifest, a
   manifest the worker could not record cleanly, or one naming no title or
   staff user fails the run. The plaintext is written to a 0600 file in a 0700
   run directory on tmpfs; the drill refuses any other filesystem. Then
   `db/recovery/restore_drained.py`'s `restore_only` runs readiness, the
   refusal to import onto a non-empty target, and the import. It runs against
   a fresh MySQL container of the pinned server digest, and every `mysql`
   call runs inside the recovery image.
6. **Compare the restore with its backup, before any Ghost exists.** The run
   reads the site title, staff user count, published post count, member
   count and newest published post title from the restored database. Each
   must equal the manifest's value (`compare_with_manifest`). Ghost's own
   install defaults, an empty restore, or a partial one all fail here, before
   a colour starts. Expectations are never taken from the restored database
   alone, because whatever a restore produced would agree with itself
   (LLD-9 R4).
7. **Verify on a drained colour.** The drain flag is set first. Then the run
   starts the tenant image's Ghost on the restored database, with the drain
   sidecar sharing its network namespace, both published on loopback only.
   The sidecar must answer `503` (drained), and Ghost must answer `200`.
   The rendered homepage must then carry the **manifest's** site title and
   newest post title, compared as unescaped text. Only after that is the
   flag cleared, and the sidecar must then answer `200`. A failure at any
   step leaves the colour drained.
8. **Remove.** Whatever happened, the run removes the containers and their
   volumes (`docker rm -f -v`), the network, the decrypted dump and the flag.
   Every container and network carries the `branchleft.restore-drill` label,
   and each run first removes anything with that label that a crashed run
   left behind.

## What it exports

`restore_drill.prom`, in the same textfile-collector directory as the
worker's own gauges, written atomically:

- `restore_drill_last_success_timestamp_seconds`: the signal to alert on.
  It advances only on a passing run, so a drill that fails, or stops
  running, shows as a growing age. This is the same silence-as-failure shape
  as the backup age.
- `restore_drill_last_run_timestamp_seconds` and
  `restore_drill_last_run_success`.
- From the last run: restore and verify durations, plaintext bytes recovered,
  backup object age, and objects audited. These are the numbers LLD-9 §08
  says every drill reports.
- `restore_drill_last_run_info{tenant,copy}`.

## Images

Every image is named by digest in the environment file. A tag is refused,
because a tag can move between the run that verified it and the run that
needs it. An image already present locally at that digest is not pulled
again.

## Credentials

The drill holds three things, and nothing else:

- The copy's Get+List key, from the owner's `fence=a` ruling.
- One age identity per tenant, in `/etc/branchleft/restore-drill/identities/`
  (root, 0700 directory, 0600 files).
- A random MySQL root password for its own throwaway server. The password
  crosses to docker as an environment value, never on a command line.

The drill never connects to the tenant database host.

## Where decrypted data may exist

Only in memory-backed storage, and never in a log:

- **Every short-lived container that sees plaintext or key material** runs
  with `--log-driver none`: the decrypt, the key generation and encryption,
  and every `mysql` client call. Otherwise Docker's json-file log keeps their
  stdout under `/var/lib/docker`.
- **The decrypted dump** lives only under the unit's tmpfs
  `RuntimeDirectory`, which systemd removes however the run ends.
- **On SIGTERM**, the drill turns the signal into an exception so its own
  cleanup runs. It then exits 143 and exports the run as failed.
- **After any stop**, a SIGKILL included, `--cleanup` (the unit's
  `ExecStopPost`) removes every labelled container and its volumes.
- **At the start of every run**, any `run-*` directory an earlier run left
  behind is swept.

The restore MySQL server keeps its data in an anonymous Docker volume, which
`docker rm -v` removes with the container.

## What it costs the host

Up to two containers capped at `BACKUP_DRILL_MYSQL_MEMORY` and
`BACKUP_DRILL_GHOST_MEMORY` (default `1g` each), for the length of one run, on
Sunday night. The decrypted dump exists on disk for the same window.
LLD-9 §10 names this weekly plaintext event and bounds it; it belongs on the
platform DPIA.

## The local proof

`prove-restore-drill.sh` runs the whole chain in Docker, with nothing
mocked:

- the pinned MySQL server, the published recovery image, the tenant image and
  the drain sidecar image, all by digest;
- a local S3 gateway (versitygw) that verifies SigV4 and serves TLS;
- a synthetic tenant: a real Ghost with an owner, a site title, a named post
  and a member;
- the backup worker's real `nightly_dump_loop.py`, which dumps that tenant
  over TLS with a backup account carrying the control host's grants, encrypts
  it to the tenant's own key and stores both copies.

Before the drill runs, the source database and its Ghost are deleted, so
the drill has only the backup to work from.

| Case | Expected |
|---|---|
| GREEN, primary copy | PASS; the restore matches the worker's manifest (title, named post, member); erasure refused for the right reason; metrics exported; nothing left behind |
| GREEN, secondary copy | PASS |
| CONTROL: an empty backup object, newest | FAIL, the backup carries no manifest; last success unchanged |
| CONTROL: a backup that restores nothing, carrying the real tenant's manifest | FAIL, no Ghost schema to compare |
| SABOTAGE: comparison removed | still FAIL: Ghost boots its install defaults, and the page lacks the backed-up title |
| SABOTAGE: comparison removed and expectations taken from the restore | wrongly PASSES on Ghost's defaults (the red this control exists to prevent) |
| Revert | FAIL again |
| CONTROL: an older object with two recipients | FAIL, `names 2 recipients` |
| SABOTAGE: recipient check loosened to `< 1` | wrongly PASSES |
| Revert | FAIL again |
| SABOTAGE: the destroyed key is kept where the drill holds keys | FAIL, `ErasureBrokenError` |
| Revert | PASS |

The proof runs on a workstation's temporary directory, so it sets
`BACKUP_DRILL_REQUIRE_VOLATILE_WORK_DIR=0`. The tmpfs refusal itself is
unit-tested, and so is the SIGTERM path, with a real signal sent to a real
process holding a decrypted dump.

The sabotages edit `restore_drill.py` in place and restore it on exit,
whatever happens.
