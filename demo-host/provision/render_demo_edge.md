# render_demo_edge.py

## Module overview

Render the demo host's edge upstream block from the slot table. Prints the
generated Caddyfile fragment to stdout, or writes it atomically to
`--out` (see `write_generated_file`).

## What this generates, and what it deliberately does not

LLD-4 §U3b's own snippet has no site address at all -- just the global
`admin off` option and a bare `reverse_proxy` block -- because a slot's
colour pair is one thing every demo slot needs regardless of which
hostname currently occupies it, and a hostname is exactly what changes on
every `/reconcile` (a demo is reused, never re-provisioned: LLD-1 §04). So
each slot gets a named snippet here, `(slot<N>-upstream)`, holding only
what LLD-2 §01 allocates once at host build and `reconcile` never touches:
the colour pair's own two app ports and the slot's one shared health port.
Whatever binds the slot's *current* hostname -- built from `render-core`'s
`renderEdgeSiteBlock` (gate, CSP, body-size limit), which changes on every
reconcile and is out of this generator's scope -- `import`s that snippet
alongside its own, per-tenant directives. Caddy's `import` is exactly the
seam this needs: address-less, reusable, and it costs this generator
nothing to keep static.

## Why write_generated_file has no visudo-equivalent syntax check

A malformed sudoers file can leave `sudo` refusing every invocation
system-wide until an operator fixes it by hand at the console, which is
why `render_slot_sudoers.py` insists on `visudo -c -f` before anything is
written. A malformed Caddyfile fails to start (or fails to reload) exactly
one process, recoverable by re-running this generator and restarting it --
this host has no local `caddy` binary to validate against in any case,
since the edge itself runs as a container per LLD-4 §U3b's own
measurements. `scripts/test-colour-swap.sh` is the syntax proof that
matters: a real Caddy container loading this exact generated output.

## Load-bearing values

LLD-4 §U3b, §08: `lb_policy first`, `health_uri /healthz`,
`health_interval 2s` and the `X-Colour-Upstream` header name are pinned
constants, not configuration -- changing any of them changes what "the
edge's static upstream block" means, and none of the four is this
generator's to tune per host.
