# connectGuardPreload.mjs

## The preload

Loaded via `node --import` into a CHILD process (server.ts's own
startup, not just createApp()) so the patch is in place before ANY of
the target module's top-level code runs. Reports every call to stdout
as a single-line JSON record prefixed with a marker the parent test
process greps for. The parent's own HTTP requests against this child
never touch this file at all (they run in a different process), so
unlike the in-process test, there is no baseline traffic to filter
here: a completely silent child is the whole of what "no outbound
connection" means for this process's entire lifecycle.

Four independent primitives, patched separately, because none of them
routes through the others — verified empirically that each one bypasses
a guard that only patches net.Socket#connect:
  - net.Socket#connect — every TCP/TLS client (nodemailer's SMTP
    transport included: tls.connect constructs a TLSSocket, which
    extends net.Socket and calls this same method).
  - dns.lookup / dns.resolve* (callback and promise forms) — hostname
    resolution alone is a network round trip, and by itself is a
    DNS-exfiltration channel even when nothing after it ever calls
    connect().
  - dgram — UDP has its own send path entirely outside net.Socket.
  - child_process — spawn/exec/execFile can shell out to `curl` or
    anything else and make a network call this process's own patches
    can never see, in a separate process.

Patching a property on the object a default/namespace import gives you
(`import net from 'node:net'; net.X = ...`) does not, by itself, reach
a caller that used a named import instead (`import { X } from
'node:net'`) — Node synthesizes a built-in module's named ESM exports
once, from a snapshot, and a plain property reassignment afterward
never reaches that snapshot. `module.syncBuiltinESMExports()` (called
once, after every patch below) re-syncs that snapshot from the current
property values, closing the gap for every built-in this file patches
at once — verified empirically (see the sabotage tests this guard
backs) rather than assumed from documentation.

## A lookup of a literal IP

`dns.lookup()` on a literal IP resolves synchronously, in-process,
with no libuv/network round trip at all (verified empirically: it
returns before the next tick, where a real resolution is always
async) — Node's own net.Server#listen() calls it internally for
EVERY bind, including a bind to a literal address like '0.0.0.0' or
'127.0.0.1'. That is what the SMTP front door's own listen() does on
startup, not an outbound resolution of anything — flagging it would
make "no outbound connection" fail on every server that binds to an
address, including this one legitimately listening for inbound mail.
Only `lookup()` ever legitimately receives a literal IP this way;
`resolve*()` (RR-type record queries) never does, so they stay
reported unconditionally.
