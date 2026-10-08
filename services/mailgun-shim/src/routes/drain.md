# drain.ts

## The drain contract

The mail class of the drain contract LLD-2 §03 names once for the whole
estate ("GET /drain — long-poll, held ~30s — hands over queued mail and
media hashes — initiate anything: it answers, never calls") and the
cross-document review (P2) asks to be written down in exactly one place
so the backup and safety workers can reuse the shape rather than each
re-deriving it. This is that place, for mail:

- **`GET /drain`** — long-poll, held up to `holdMs`. Responds `{ messages }`,
  `[]` if nothing became due before the hold expired. Every message carries a
  stable `id` and the `drainCount` this hand-over was made under; claiming it
  moves the row to a leased `held` state (`claimForDrain`) rather than
  removing it — a crash before the matching ack causes it to be re-offered
  under the same id, at the next `drainCount`, once the lease lapses. If the
  client disconnects while this request is held open, the loop notices before
  its next claim attempt and stops without claiming anything on that
  abandoned connection's behalf — see
  [a held request whose client has gone](#a-held-request-whose-client-has-gone).
- **`POST /drain/ack`** — body `{ acks: [{ id, drainCount }] }`. Marks every
  id whose message this drainer actually took delivery of, provided the
  `drainCount` named still matches the row's current one — an ack naming a
  `drainCount` the row has since moved past (the lease lapsed and it was
  re-offered, to this drainer again or to another one, in between) is a late
  ack from an outdated claim, and is reported `unknown` rather than accepted.
  A message leaves the queue for good only here. Acking an id twice at its
  current generation, or one that's stale, is reported back rather than
  erroring — `alreadyHandled` / `unknown` — so a drainer that crashed between
  receiving a batch and acking it can find out what actually landed rather
  than guessing.

- **`POST /drain/outcomes`** — opt-in, off by default
  (`SHIM_DRAIN_OUTCOMES=true`; when off the route is not registered and answers
  404, so a shim that has not opted in behaves exactly as it did before). Body
  `{ outcomes: [{ id, drainCount, outcome: "delivered" | "failed", severity?,
  code?, message? }] }`, 1 to 200 entries. The drainer reports what the
  receiving MTA finally did with messages it already acked. `severity`
  (`permanent` | `temporary`) is required for `failed` and never defaulted,
  since a default would either suppress an address on a transient fault or hide
  a real bounce. The answer is `{ recorded, alreadyHandled, unknown }`; what each
  outcome does to the row, the events and the suppression list is in
  [store.md](../store.md#outcomes-come-back-after-the-ack).

Every route here requires requireDrainToken — the collector's only credential.
Neither route ever opens an outbound connection: this module only reads
from and writes to `store`, and answers the request already open. Making
that true is what the rest of this story's changes (removing worker.ts
and smtp.ts's outbound transport entirely) exist to guarantee — this
route could not dial out even if it tried, because nothing importable
from here can construct an outbound transport any more.

## A held request whose client has gone

A held GET can outlive its own client: the collector crashes, the
network drops, or it simply gives up. Without this, the loop below
would still call claimForDrain() on its next wake and lease a
message that can never be delivered on this connection — spending
a throttle token and a lease for nothing (the row does eventually
come back once the lease lapses, but only after sitting uselessly
"drained" the whole time). `req.on('close', ...)` fires on a
genuine client disconnect as well as on normal completion, so the
flag is only trusted before a response has actually been sent —
checked, never written to after headersSent, which res.json()
below sets synchronously in the same tick it writes.
Not airtight against the OS's own reporting delay — a message
that becomes available in the narrow window between the actual
disconnect and Node learning about it can still be claimed once
before this catches up. What it does close is the case that
otherwise never recovers on its own within the hold: an
already-known-gone connection's loop waking on a later
wake()/poll and claiming regardless.
