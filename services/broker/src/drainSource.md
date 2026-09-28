# drainSource.ts

## DrainSource

What `GET /drain` hands over: the payload is "queued mail and media hashes",
but where it comes from is not this endpoint's job. Both are owned by
components outside this module: the mail spool has its own "spool never
dials out" contract, a different mechanism from this endpoint — the mail
exchange host drains the spool directly over its own connection — and
nothing here defines what produces a media-hash record for hand-over. The
consumer named in the design ("reaper") is not built either. This is the
same kind of seam as `Renderer`: the long-poll mechanics below are real and
proven; what feeds them is wired in by whichever component builds the spool
and the reaper.

## poll

Host-wide, not per-slot: `/drain` takes no slot argument (a bare `GET
/drain`, unlike `GET /status/<slot>`), and each returned item carries its
own `slot` so a caller sweeping the whole host in one poll can still
attribute what it received. Resolves once there is something to hand over,
or never resolves at all if nothing arrives — the caller (`app.ts`) races
this against its own timeout and aborts `signal` when the poll should give
up. Never rejects on "nothing yet"; a genuine failure to reach the
underlying source should reject so the caller can tell that apart from an
empty queue.
