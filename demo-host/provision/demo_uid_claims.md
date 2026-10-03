# demo_uid_claims.py

## Overview

Run by hand on the demo host, as root, at host build and before any slot
account or unit exists:

```sh
install -o root -g root -m 0700 demo_uid_claims.py /root/demo_uid_claims.py
/root/demo_uid_claims.py
```

Records the seven fixed slot uids (30001-30007) as `demo-0` .. `demo-6` in
`/etc/branchleft/tenant-uids`, the register `app/provision/provision_tenant_volume.py`
keeps for tenant volumes, with the same `slug=` / `uid=` shape. One
mechanism covers both estates, so a second allocation scheme cannot make
two hosts disagree about who owns a uid in the reserved range.

## How it ships

The script is one file with no imports from this repository: copy that file
alone to the host, nothing beside it. The slot table and uid base it needs
are duplicated into it, and `test_demo_uid_claims.py` fails if either copy
drifts from `render_slot_sudoers.py` or `branchleft_slot.py`. A test also
runs a copy of the file alone in an empty directory, and another fails if
any import is not standard library.

## What it refuses, and why

Nothing is written when any of these hold; each is a state where continuing
could hand one owner another's uid.

- A claim file that cannot be read, is not a regular file (a directory or
  FIFO is refused, never opened for reading), or whose name disagrees with
  its own slug (the register was edited by hand).
- A symlinked claim: claims are opened with `O_NOFOLLOW`.
- A demo slug already claimed at a different uid: changing a uid on a
  provisioned slot is a migration, not an update.
- A slot uid already claimed by another slug.
- A slot uid, for a claim it would newly make, that `/etc/passwd` already
  assigns to an account. The file is read directly, not through NSS. A slug
  already in the register is not re-checked, because by then its slot
  account is expected to exist.
- A register directory that is not root-owned `0700`. A directory someone
  else can write is one whose claims they can delete, and a deleted claim
  reads as unclaimed.
- A second run while another holds the register lock (see below).

## Concurrency and crashes

An exclusive, non-blocking `flock` is held on the register directory for the
whole check-then-write, so two runs cannot both pass the check. The lock is
on the directory because any file added there would be read as a claim. A
concurrent run is refused, not queued. The tenant-side script takes no such
lock, so the register is only serial against this script, not against a
tenant volume being provisioned at the same moment; build the demo host
before any tenant is provisioned on it.

A claim is written to `<slug>.tmp`, fsynced, renamed into place, and the
register directory is then fsynced so the rename survives a power loss. A
crash can leave a `<slug>.tmp` for one of the seven demo slugs; the next run
removes it (reporting it on stderr) before reading the register. Only a
plain file owned by root is removed; a symlink or foreign file under that
name is refused and left for a person. A `.tmp` for any other name is not
this script's and still aborts the run, as an unreadable claim.

Re-running is a no-op for claims already present, and fills in any that are
missing.

## Drift guards

The register path, modes and uid range are duplicated from the tenant-side
script, as are the slot table and uid base. `test_demo_uid_claims.py`
imports each source and fails if a copy drifts, and runs the tenant-side
register reader over what this one writes.
