# provision_socket_dirs.py

## Overview

Run once at demo-host build, as root, in this order:

```sh
demo_uid_claims.py                      # records demo-router = 30008
useradd --system --uid 30008 --user-group --no-create-home \
        --shell /usr/sbin/nologin demo-router
provision_socket_dirs.py
```

Creates `/var/lib/branchleft/demo-router` (root-owned 0755) and below it, per
slot, `<slot>/`, `<slot>/a/` and `<slot>/b/`, each owned by `demo-router`
mode 0700. The slot directory is what makes the tree unenterable by anyone
else; the colour subdirectories are what each sidecar mounts, one each.

## What it refuses

A directory that already exists but is not a directory, not owned as
expected or not exactly the mode above is refused and left as found, never
corrected under whatever may already be in it. The account must exist with
uid 30008; a missing account or another uid is refused, the first with the
`useradd` command to run. Re-running changes nothing.

## Drift guards

The slot table, colour table, account, uid and root are duplicated from
`health_router.py` because this file runs alone; `test_demo_sidecar.py`
fails if any copy drifts.
