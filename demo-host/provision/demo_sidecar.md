# demo_sidecar.py

## Overview

Called by a colour's unit (see `render_colour_units.md`), as root, installed
at `/usr/local/lib/branchleft/demo_sidecar.py`:

```sh
demo_sidecar.py start <slot> <colour>   # ExecStartPost
demo_sidecar.py stop  <slot> <colour>   # ExecStop and ExecStopPost
```

`start` runs one container, `demo-<slot>-<colour>-sidecar`, from the image
pinned in `DEMO_SIDECAR_IMAGE` (read from `/etc/branchleft/demo-sidecar.image.env`
by the unit), with `docker run --network container:<that colour's Ghost>`. It
runs as the router's uid (30008), read-only, all capabilities dropped,
`no-new-privileges`, never pulling, and opens no port: it listens on
`/run/sidecar/health.sock` inside the colour's own directory.

## What start mounts

- `<root>/<slot>/<colour>` at `/run/sidecar`, read-write. Nothing else of the
  socket tree: colour a's sidecar never sees `b/` or the slot directory.
- the drain-flag directory at `/run/drain`, read-only, with
  `DRAIN_FLAG_PATH` naming this colour's own flag.

`<root>` is `/var/lib/branchleft/demo-router`; `provision_socket_dirs.py`
creates it.

## What start refuses, creating nothing

- an image that is not `name@sha256:<64 hex>`: a tag can be moved after it
  was approved, a digest cannot;
- a slot or colour directory that is a symlink, missing, not owned by uid
  30008 or not exactly mode 0700;
- a Ghost that is not exactly one running container of this slot's Compose
  project for this colour, so the sidecar can never join another Ghost's
  network namespace.

## A failed start leaves nothing running

Once a container may exist, any failure (non-zero `docker run`, timeout,
interrupt) removes it before the error is reported, and the unit's
`ExecStopPost=` removes it again. `stop` treats an absent container as
success and a present one it cannot remove as a failure.

## What it does not do

It does not fetch or load the image: `--pull never`, so the digest must
already be present on the host. Image delivery is tracked separately. It
does not touch the router, and nothing here is reachable from the router's
unit, which never sees the container runtime's socket.
