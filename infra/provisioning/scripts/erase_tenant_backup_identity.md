# erase_tenant_backup_identity.py

## Module overview

Erases one tenant's backup identity from the control host, by one command run
as root, with no hand step. It destroys every copy of the tenant's private
age key, takes the tenant off the two lists, then reads every location back
and refuses to report success while any copy remains.

```text
erase_tenant_backup_identity.py --tenant SLUG
```

The slug passes the repository's one slug rule
(`backup_worker.validate_tenant_name`). Every other path has a root-only
default and an override flag; see `--help`.

## Every location of the private half

Enrolment (`enrol_tenant_backup.md`) keeps the private half of the tenant's
key in exactly these places, and erasure covers all of them:

| Location | How it is erased | How the proof reads it back |
|---|---|---|
| `<identity-dir>/<tenant>.key` | zero-filled, synced and unlinked by `restore_drill._destroy_file`; a symlink is unlinked, never written through | full `os.scandir` of the identity directory |
| `<identity-dir>/.<tenant>.key.tmp` (an enrolment that died half way) | the same | the same scan |
| any other regular file in the identity directory whose bytes hold the tenant's secret-key line or its `# public key:` line (a `.bak`, an editor copy, a copy with the comment stripped) | the same | the same scan, by content |
| `spares/<tenant>.key.age` in the spare bucket, every version and every delete marker | each version deleted by its version id | the object listing and the `?versions` listing under `spares/<tenant>.` |
| the tenant's line in the recipients file | `retract_listing`, atomic, owner, group and mode kept | the file re-parsed |
| the tenant's line in the tenants file | the same | the file re-read |

The two list lines are not key copies, but a listed tenant with no identity
breaks the restore drill, so they go first and are proved gone.

The proof is a function of its own, `find_remaining`, which reads every
location from its own source and not from what the destroy step reported.
A proof elsewhere that plants a second copy and expects it to be found calls
it directly, with matchers from `key_matchers`.

## What it never does

- It never reads, fetches or unwraps a spare. The spare is the identity
  encrypted to a wrapping recipient whose private half is held by the
  platform owner, off this host. Erasure deletes the wrapped object and does
  not need that key: no `age` process is started, no child process is run,
  and the store type it uses has no read or write of an object, only list and
  delete. The erase configuration holds no wrapping-key name.
- It never touches another tenant. The spare prefix is `spares/<tenant>.`,
  and a slug holds no dot, so the prefix of `a` cannot match the objects of
  `a-b`. An identity-directory file is touched only when it is this tenant's
  own name or holds this tenant's key bytes.
- It never prints key bytes. An unexpected exception is reported by class
  name only.
- It never restores a key. A failed erasure is run again, not rolled back.

## Order

The whole run holds the enrolment's non-blocking exclusive lock, so an
erasure and an enrolment (or two erasures) cannot interleave. Everything
before step 5 changes nothing.

1. The caller is root; the slug is valid.
2. The erase configuration is read (root-owned, `0600`, every name set), with
   the worker and drill environment files and the identity directory
   (root-owned, `0700`). The erase credential's bucket and access key id must
   not be any dump copy's.
3. The tenant's identity is read into memory to learn its secret-key line
   and public key, and the recipient is taken from the recipients file. These
   are the matchers for stray copies and are never written anywhere. If
   neither can be read the run says so and finds stray copies by file name
   only.
4. The proof is run once before anything is changed. If it finds nothing the
   run says so and exits 0.
5. The tenant is taken off both lists. Then, attempting every step even if one
   fails: each identity-directory entry that is the tenant's own file or holds
   its key is destroyed; each version and delete marker under the spare
   prefix is deleted.
6. The proof is run again. Any remaining copy, and any location that could
   not be read, is listed on standard error as `ALERT` and the run exits 3.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Every location was read back and no copy remains. Also the result of a re-run that finds nothing present. |
| 1 | Refused before anything changed: not root, bad slug, missing or loose erase configuration, the erase bucket or key id is a dump copy's, the lock is held, the identity directory is not private. An unexpected exception before any change also exits 1. |
| 2 | Usage. |
| 3 | The proof is red: a copy remains, or a location could not be read (an unreadable, oversize or non-regular identity-directory entry, a failed listing, a list file that cannot be parsed). An unexpected exception after changes began also exits 3. Run it again. |

## Fail closed

A listing that errors, a listing truncated with no marker to resume from, an
unparseable list file and an identity-directory entry that cannot be judged
are each a red proof, never "gone". The identity directory holds only `.key`
files, so an entry that is a directory or larger than a key file is itself
reported.

## Residual limits

- A copy outside the identity directory (a backup of the host, a copy made
  by hand elsewhere) is out of reach and not looked for.
- Stray copies are found by the tenant's key bytes. If a first run destroyed
  the tenant's own identity and the recipient line but could not destroy a
  stray copy, a later run has no key bytes to match on and finds only the
  tenant's own names.
- Zero-filling a file on a journalled or solid-state filesystem is not a
  physical guarantee that the old blocks are gone.
- The dump ciphertext in the dump copies is left in place by design: it is
  unreadable once the key is gone, and it expires by lifecycle.
- The bucket's behaviour on `?versions` and on delete by version id is that
  of the object store's S3 interface. The first live run is read for its
  exit code and proof lines.

## The erase credential

`/etc/branchleft/erase-tenant-backup.env` (`root:root` `0600`, see
`control/provision/erase-tenant-backup.env.example`) holds the spare bucket,
endpoint, region and a credential that can list and delete, including object
versions, on `spares/`. It is not the enrolment's credential and it needs no
read or write of an object.
