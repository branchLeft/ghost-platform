# render_colour_units.py

## Overview

Run once at demo-host build, as root, then `systemctl daemon-reload`:

```sh
render_colour_units.py --install /etc/systemd/system
```

Writes fourteen drop-ins, `branchleft-compose@demo-<slot>-<colour>.service.d/colour.conf`,
one per (slot, colour). The unit names are exactly what `branchleft_slot.py`
starts and `render_slot_sudoers.py` enumerates; nothing about them changes.

## Why a drop-in

The generic `branchleft-compose@.service` template (in `branchLeft/shared-infra`)
maps an instance name to a directory, an image pin and a whole Compose file.
For `demo-0-a` that resolves to `/opt/branchleft/demo-0-a`, which does not
exist: a slot is one directory shared by both colours, and render-core puts
both Ghosts in one Compose document. Rather than change the template every
host runs, each demo instance overrides only what differs:

- the working directory is the slot's directory;
- the image pin is the slot's own `image.env` (the broker writes it there);
- the secrets file is `/etc/branchleft/demo-<slot>-<colour>.env`, the file
  `reset` removes;
- the pull is dropped (demo1 keeps no registry access);
- start is `docker compose up -d --wait ghost-<colour>` and stop is
  `docker compose stop ghost-<colour>`, so one colour's unit never touches
  the other colour's container. `--remove-orphans` is deliberately absent:
  it would remove the sibling colour.

Every list-valued directive is cleared with an empty assignment before being
set again, because systemd appends otherwise and the template's requirement
for `/etc/branchleft/%i.image.env` would keep failing the unit.

## The colour's drain sidecar

Each drop-in also starts and stops that colour's drain sidecar, through
`/usr/local/lib/branchleft/demo_sidecar.py` (see `demo_sidecar.md`):

- `ExecStartPost=` runs `demo_sidecar.py start <slot> <colour>` once Ghost is up;
- `ExecStop=` and `ExecStopPost=` both run `demo_sidecar.py stop <slot> <colour>`,
  ahead of the Compose stop, as the Ghost stop already is in both;
- `/etc/branchleft/demo-sidecar.image.env` is a required `EnvironmentFile=`
  (and an `AssertPathExists=`): it carries the pinned sidecar digest, so a
  host with no digest file starts no colour at all, rather than a Ghost the
  router would only ever answer 503 for.

The unit itself never runs `docker run`, and render-core's ban on
`network_mode` is untouched: the sidecar joins Ghost's network namespace
by `docker run --network container:<ghost>`, outside the Compose file.

## A failed start still stops the colour

`ExecStop=` runs only after a successful start. If `up -d --wait` fails or
times out the container keeps running and the unit is failed, where
`systemctl stop` does nothing, so a slot reset would wipe the slot under a
live Ghost. The same `docker compose stop ghost-<colour>` therefore also
runs in `ExecStopPost=`, which systemd runs whatever the start's outcome.
Stop, never down. The tests model this from systemd.service(5); it must be
confirmed on a real systemd after delivery (force a failing start, check the
container is gone).

The same holds for the sidecar: if `ExecStartPost=` fails after Ghost came
up, the unit is failed and only `ExecStopPost=` runs, which removes the
sidecar and stops Ghost. `demo_sidecar.py start` also removes any container
it may have created before it reports a failure.
