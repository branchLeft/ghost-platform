# healthCheck.ts

## createHttpHealthChecker

Mirrors `services/drain-sidecar/src/ghostProbe.ts`'s own posture: a
non-200, a connection failure and a timeout are all just "not healthy" --
`/status` has nothing useful to do with a finer distinction, and folding
them together means a slow or unreachable router reads as unhealthy rather
than throwing out of the handler.

There is one health port per slot, shared by both colours. What listens
there is the slot's health router (`demo-host/provision/health_router.py`,
see `health_router.md`), not a sidecar: it answers a colour-named check from
that colour's drain sidecar over a unix socket. `isHealthy(healthPort,
colourAppPort)` therefore names the colour it means, the same way the edge
does.

## Colour header

The check carries `X-Colour-Upstream: 127.0.0.1:<colourAppPort>`. The router
looks the value up whole in a two-entry table (this slot's two app ports), so
the value must be exactly that. A request with no header, or a value that is
not one of the slot's two upstreams, is answered 503, which reads here as
"not healthy".

`app.ts`'s `/status` handler passes the slot's live colour (`state.colour`,
set in `running`) as `slotPort(appPortBase, slot, colour)`, so `healthy`
describes the colour that is live, never the other one. `COLOUR_HEADER` and
`COLOUR_UPSTREAM_ADDR` mirror `health_router.py`'s `COLOUR_HEADER` and
`EDGE_ADDR`. `healthCheck.test.ts` runs the real router, so a drift in either
turns `/status` red there.
