# demo_uid_claims.py

## Overview

Run by hand on the demo host, as root, once at host build and before any
slot account or unit exists:

```sh
demo_uid_claims.py
```

Records the seven fixed slot uids (30001-30007) as `demo-0` .. `demo-6` in
`/etc/branchleft/tenant-uids`, the register `app/provision/provision_tenant_volume.py`
keeps for tenant volumes, with the same `slug=` / `uid=` shape. One
mechanism covers both estates, so a second allocation scheme cannot make
two hosts disagree about who owns a uid in the reserved range.

## What it refuses, and why

Nothing is written when any of these hold; each is a state where continuing
could hand one owner another's uid.

- A claim file that cannot be read, is not a regular file, or whose name
  disagrees with its own slug (the register was edited by hand).
- A symlinked claim: claims are opened with `O_NOFOLLOW`.
- A demo slug already claimed at a different uid: changing a uid on a
  provisioned slot is a migration, not an update.
- A slot uid already claimed by another slug.
- A register directory that is not root-owned `0700`. A directory someone
  else can write is one whose claims they can delete, and a deleted claim
  reads as unclaimed.

Re-running is a no-op for claims already present, and fills in any that are
missing. New claims are written to a temporary file and renamed into place,
so a crash never leaves a half-written claim.

## Drift guards

The register path, modes and uid range are duplicated from the tenant-side
script because this file runs alone on the host. `test_demo_uid_claims.py`
imports that script and fails if either copy drifts, and runs its own
register reader over what this one writes. The slot table and uid base come
from `render_slot_sudoers.py` and `branchleft_slot.py`.
