# health_router.py

## Overview

One router per slot, installed at `/usr/local/lib/branchleft/health_router.py`
and run by `branchleft-health-router@<slot>` (see `render_router_unit.md`).
It listens on the slot's one loopback health port (`9100 + slot`) and is the
only thing there. The edge's check is `GET /healthz` with
`X-Colour-Upstream: 127.0.0.1:<colour port>`; the router asks that colour's
drain sidecar over a unix socket and answers 200 only if the sidecar did.

```text
edge -> 127.0.0.1:<health> -> router (uid 30008)
          header names a  -> <root>/<slot>/a/health.sock -> colour a's sidecar
          header names b  -> <root>/<slot>/b/health.sock -> colour b's sidecar
          anything else   -> 503
```

`<root>` is `/var/lib/branchleft/demo-router`.

## What is answered 503, and why

Every one of these is a state where a 200 could describe the wrong colour or
no colour, so none is repaired or guessed past.

- No `X-Colour-Upstream`, more than one, or a value that is not exactly one
  of this slot's two `127.0.0.1:<port>` upstreams. The value is looked up
  whole in a two-entry table; it is never split, joined or turned into a path.
- A socket path on which any link is not what the router trusts: root, slot
  or colour directory that is a symlink, not a directory, not owned by the
  router's uid or not mode 0700; the root writable by anyone but root or the
  router; the socket not a socket (a symlink counts) or not owned by the
  router's uid. Checked on every request, never cached.
- A socket that is missing, refuses the connection (a stale file from a
  stopped sidecar), hangs past 1.5 s, or answers something that is not an
  HTTP status line.
- A sidecar status other than 200.

A path other than `/healthz` is 404.

## What it never does

It holds no state, so a colour's start, stop or failure cannot leave it
wrong: with both colours down every check is 503, the same answer the edge
already treats as unhealthy. It opens no port but the health port, makes no
outbound connection but the two sockets, and has no access to the container
runtime's socket (the unit hides it).

## Drift guards

Ports, header name, address and the slot and colour tables are duplicated
from `render_demo_edge.py` and `render_slot_sudoers.py` because this file
runs alone. `test_health_router.py` fails if any copy drifts.
