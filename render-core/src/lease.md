# lease.ts

## The lease

Which visitor currently holds a demo slot.

Runtime state, not intent, so it is deliberately not a descriptor field —
the descriptor says what a tenant was promised and changes on a decision;
the lease changes on every recycle and is written by machinery. The broker
writes one lease record per slot whenever it reconciles or resets that slot,
and every consumer that must forget the previous visitor keys on the same id
from the same record: the demo edge's gate refuses a cookie issued against
any other lease, and the mail spool purges the queue of a lease that is no
longer current. Both read it through `parseSlotLeaseRecord`, so there is one
definition of the id and one of where it lives.

**The broker's contract on recycle** (both required, the second enforced by
`hashId` below rather than trusted):

(a) The slot's `argon2id` hash must be replaced on every recycle. A lease
    that outlives the passphrase it was issued under is not a recycle at
    all — the previous visitor, and anyone they shared the passphrase with,
    simply logs in again. Nothing downstream of the broker can detect an
    unrotated hash; this is a broker-discipline requirement, not a
    checkable invariant.
(b) The new hash and the new lease record name the same tenancy. The slots
    file (the hash) and a slot's lease record live in two files the broker
    writes independently, at different moments, with no shared transaction
    between them. Writing the hash before the lease record is good
    practice, but the gate does not rely on that order: it relies on
    `hashId` instead. Every lease record the broker writes on recycle must
    carry `hashIdOf(the hash it just wrote for this tenancy)`, computed
    with this module's own function so the tag means the same thing
    everywhere it is checked. A reader that sees a hash and a lease record
    whose `hashId` fields disagree has caught two different tenancies
    mid-transition and must treat neither as current — see
    `services/demo-gate/src/app.ts`'s `login()`, which is exactly that
    reader.

## hashIdOf

A deterministic correlation tag for one `argon2id` PHC string. Not a
security boundary of its own — the hash it tags already sits in the slots
file, which is no more sensitive than this record — its only job is to let
a hash and a lease record written independently, at different times, be
recognised as belonging to the same recycle without requiring their writes
to be atomic or ordered with each other; 64 bits of collision resistance is
not remotely the limiting factor for that. Both the broker (writing) and
the gate (reading) must compute it with this same function.
