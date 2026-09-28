# healthCheck.ts

## createHttpHealthChecker

Mirrors `services/drain-sidecar/src/ghostProbe.ts`'s own posture: a
non-200, a connection failure and a timeout are all just "not healthy" —
`/status` has nothing useful to do with a finer distinction, and folding
them together means a slow or unreachable sidecar reads as unhealthy rather
than throwing out of the handler.

There is one health port per slot, shared by both colours, and
`services/drain-sidecar` answers for whichever single Ghost it was
configured against — it takes no colour parameter, because the router in
front of a slot's two colours (the piece that would make "which colour is
currently live" answerable at this port at all) does not exist yet. This
function calls only the port `app.ts` already derives from the slot, and
cannot itself resolve which colour that answer describes until the router
is built.
