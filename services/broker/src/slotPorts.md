# slotPorts.ts

## slotPort

The slot's own fixed port, never whatever a descriptor claims. A slot's
ports are allocated once at host build, and a reconcile that read them from
caller input would let a bug (or a forged descriptor) point the broker's
own Admin API call at a different slot's Ghost over loopback. Mirrors
`config.ts`'s `healthPortBase + Number(slot)` pattern: incidental in the
exact base and arithmetic, load-bearing in that it is computed from the
slot literal alone, never from the request body.
