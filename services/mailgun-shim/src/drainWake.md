# drainWake.ts

## DrainWake

Wakes a held `GET /drain` request the instant something is enqueued,
rather than making it wait out its own poll interval. Without this, "a
message enqueued ... is handed over on a waiting drain request within a
second of enqueue" (the story's Done sentence) would only be true by
coincidence of the poll interval chosen; with it, the wait is bounded by
how fast this process can run a query, not by a timer.

Deliberately not a queue of payloads — a waiter that wakes re-queries the
store itself (claimForDrain), so a wake is a pure "something might be
available now" signal, never a delivery mechanism in its own right. That
keeps this module tiny and keeps the store as the single source of truth
for what is actually claimable, which matters once every route that
enqueues mail calls notify() after its own enqueue, not just this one.
