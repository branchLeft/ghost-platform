# demoPromotion.ts

## Overview

The swap that turns an approved demo into a paying tenant, as a pure step. It
takes a request and a set of injected effects and touches no host, database or
clock of its own. A caller wires the effects to the real systems.

## Preconditions

Every precondition is checked before the first write. A refusal leaves the demo
exactly as it was. The checks run in this order:

1. The demo is in a state PROMOTING can be entered from (LIVE, EXTENDED or EXPIRING).
2. An approval is recorded.
3. A consent is recorded.
4. Every promotion target is supplied by name. A field left out is refused by its name.
5. The export of the demo content is done.
6. The demo's drain flag is set.
7. The gate answers PROMOTE. WAIT and ABANDON both refuse.

## The path

PROMOTING, the swap, the check that a post, a member and an image arrived, the
first dump, a second read of the drain flag, then PROMOTED, then the hostname is
retired. PROMOTED is recorded only after the dump exists.

## Failure after PROMOTING

The outcome is `incomplete`, never `promoted`. The swap is put back if it had
committed, and the demo returns to the state it came from. If the swap cannot be
put back, the demo stays PROMOTING, which the reaper skips, so nothing is purged
under a half-promoted record. A failed hostname retirement after PROMOTED is a
follow-up on a complete promotion.

## What it does not do

It does not run the export or the import, take the dump, read the gate or write
the record. Each is an effect. The effect that leaves PROMOTING must also move
the term to at least the notice lead from now, and the promotion timeout is the
caller's.
