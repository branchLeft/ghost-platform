# enrol_tenant_backup.py

## Module overview

Enrols one tenant in backups from the control host, by one command run as
root, with no hand step. It does four things in a fixed order and fails
closed:

1. Generates the tenant's own age key pair.
2. Keeps the private half in exactly two places: an age-encrypted spare in
   a private bucket, and the identity file in the identity directory the
   restore drill reads (`root:root` `0700`, files `0600`).
3. Lists the tenant for the backup worker: a line in the tenants file and a
   line in the recipients file, each replaced by write-to-temp-and-rename
   with the old file's owner, group and mode.
4. Has the tenant's first dump taken, then checks that the stored dump
   opens with the tenant's own identity and with no other identity.

```text
enrol_tenant_backup.py --tenant SLUG --tenant-config STACK_FILE
```

`STACK_FILE` is the tenant's own Pulumi stack file. It must hold exactly
one `<project>-infra:slug:` line, and that slug must equal `--tenant` and
pass the repository's one slug rule (`backup_worker.validate_tenant_name`).
Every other path has a root-only default and an override flag; see `--help`.

This is the only enrolment entry point. It has no second dump path: the
first dump is `nightly_dump_loop.py --tenant SLUG`, started in a systemd
unit.

## What it never does

- It never dumps. The nightly loop's run lock lives under a systemd
  `RuntimeDirectory=` and its metrics under a `StateDirectory=`, both owned
  by the `backup-worker` service account. A root-run dump would create lock
  or metrics files that account could not open on its next run. So the first
  dump runs as the service account in
  `branchleft-backup-worker-first-dump@<tenant>.service`, a oneshot template
  with the nightly unit's environment and hardening, its own runtime
  directory and no `[Install]` section. This process only starts it
  (`systemctl start --wait`) and reads the result. It creates no file under
  the run-lock or state directories.
- It never prints, logs or stores the private half anywhere but the one
  identity file. The `age-keygen` output is read from a pipe into memory and
  handed to the other processes on stdin; no argv or environment carries it,
  and every child gets an explicit minimal environment. An unexpected
  exception is reported by class name only.
- It never lists a recipient unless both copies exist and have been read
  back.
- It never overwrites. A tenant that is already enrolled exits 0 without
  minting a second key (that would orphan every existing backup). A
  half-enrolled tenant exits 3 and is not repaired by guessing.
- It never adds a second recipient, an operator recipient or an escrow
  recipient to a dump. The spare's wrapping recipient encrypts only the
  identity.

## Order

The whole run holds a non-blocking exclusive lock, so a second enrolment is
refused rather than interleaved. Everything before step 5 changes nothing.

1. The caller is root; the slug is valid.
2. The slug in the stack file is the one asked for.
3. Configuration is read and checked: the spare configuration (root-owned,
   `0600`, every name set); the worker and drill environment files; the
   identity directory (root-owned, `0700`); both lists; the pinned wrapping
   recipient; that the spare bucket and access key are not any dump copy's;
   that the drill's Get+List credential can list the dump copies.
4. State is classified: nothing present proceeds, everything present is
   "already enrolled", anything in between is exit 3.
5. The key pair is generated, and the recipient derived from it with
   `age-keygen -y` must equal the identity's own public-key comment.
6. The identity is wrapped with `media_backup_restore.encrypt_with_age`
   (one `-r`), put to `spares/<tenant>.key.age` and read back.
7. The identity file is created with `O_EXCL` as a hidden temp file outside
   the drill's `*.key` glob, then hard-linked to `<tenant>.key` (which fails
   rather than overwrite), and read back for mode, owner and bytes.
8. The new recipients text is checked with
   `backup_recipients.parse_recipients` before anything is written, so a
   recipient another tenant holds, a tenant already listed or a malformed
   line refuses the enrolment with the files untouched. Then the
   recipients file is replaced, then the tenants file.
9. Both lists are read back with `load_recipients` and the installer's own
   `recipients_file_problems` and `tenants_file_problems`.
10. The first dump is taken and checked (below).

A failure in steps 5 to 9 removes what this run created, lists first so no
recipient outlives its keys: the list bytes are restored, then the identity
file, then the spare. If any of that cannot be undone the exit is 6.

## The spare, and what "read back" means for it

The spare is the identity encrypted to a wrapping recipient the owner
supplies in the root-only configuration, together with that recipient's
SHA256. The private half of the wrapping key is held off this host, so
production cannot decrypt a spare. "Read back" therefore means the stored
object is byte-identical to what was put, has a single X25519 stanza, and
is not the clear key. That the spare decrypts to the same identity is proved
in the tests, which hold the wrapping private key.

The recipient is pinned: the SHA256 of its text is printed on every run, and
a recipient that does not match the pin, is not a single age public key, or
equals any tenant's recipient is refused.

The spare's credential needs Put, Get, List and Delete (Delete only so a
failed enrolment can remove its own object). The key that erases a spare at
tenant erasure is separate and is not built here; erasure does not yet cover
the spare copy.

## The first dump and its check

1. The existing `dumps/<tenant>/` keys on every configured drill copy are
   listed.
2. If the nightly unit is active the first dump is deferred (exit 5): the
   tenant stays enrolled and the nightly run will dump it.
3. `systemctl start --wait branchleft-backup-worker-first-dump@<tenant>.service`
   runs, bounded by a timeout a little longer than the unit's own.
4. The copies are listed again; the verified object is the newest one that
   was not there before.
5. `restore_drill.check_single_recipient` requires exactly one X25519
   stanza; `age -d` with the tenant's own identity must succeed; `age -d`
   with every other `*.key` in the identity directory must fail with
   `no identity matched`.

A dump that fails this check exits 4: both list lines are retracted through
the same temp-and-rename path and both key copies are kept, so a re-run
exits 3 instead of reporting a false "already enrolled". A failed or timed
out unit, a deferral, or no new object exits 5 with an `ALERT` line; the
tenant stays enrolled and the nightly run retries.

A timer firing while the first dump runs is a residual overlap: the two
units have separate runtime directories, and the dump's own lock wait on the
database is bounded.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Enrolled and the first dump verified, or already enrolled with nothing changed |
| 1 | Refused; nothing changed, or fully rolled back |
| 2 | Usage |
| 3 | Half-enrolled; refused, nothing changed, the output names what is present |
| 4 | The stored first dump does not open with the tenant's own key, or another identity opens it; the listing is retracted |
| 5 | Enrolled, but the first dump failed, was deferred, timed out or produced no new object; `ALERT` on stderr |
| 6 | Rollback incomplete; `ALERT` names what is left behind |

## Seams

`enrol(...)` takes `euid`, `owner_uid`, `group_gid`, `store`, `keygen`,
`runner`, `start_dump` and `dump_reader`, so CI runs it as an ordinary user
against real `age`, in-memory fake buckets and a fake `systemctl`.
`S3SpareStore` is the production store on the repository's one SigV4
implementation. The configuration file is described by
`control/provision/enrol-tenant-backup.env.example`.
