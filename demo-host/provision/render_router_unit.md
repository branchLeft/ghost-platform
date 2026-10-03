# render_router_unit.py

## Overview

Run once at demo-host build, as root:

```sh
render_router_unit.py --install /etc/systemd/system
systemctl daemon-reload
systemctl enable --now branchleft-health-router@{0,1,2,3,4,5,6}
```

Writes the one template unit `branchleft-health-router@.service`; the
instance is the slot. Reconcile never touches it.

## Why it names no colour unit

The router answers for both colours, so it must outlive either. A router
tied to one colour's lifecycle (`PartOf`, `BindsTo`, `Requires`, ordering)
would go dark on an ordinary stop of a colour that is still healthy.
`test_health_router.py` fails if any dependency or ordering directive is
added. It is never stopped, including by a slot reset.

## What the unit confines

Runs as the `demo-router` account with no supplementary groups, so it cannot
reach the container runtime's socket by group (the unit also hides the
socket paths). No capabilities, loopback-only addresses plus unix sockets,
read-only filesystem, private `/tmp` and devices.

## To confirm on the host after delivery

1. `systemd-analyze verify /etc/systemd/system/branchleft-health-router@.service`
   reports nothing, and every directive loads (no "unknown lvalue").
2. Instance start as `demo-router` (uid 30008): `systemctl show -p MainPID,User
   branchleft-health-router@0`, and `ss -ltnp` shows it on 127.0.0.1:9100 only.
3. `ProtectSystem=strict` and `IPAddressDeny=any` still let it connect to a
   unix socket in the socket directory (connect to a real sidecar socket and
   read a 200).
4. Stopping and starting a colour unit leaves the router's `ActiveEnterTimestamp`
   unchanged.
