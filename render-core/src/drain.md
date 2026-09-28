# drain.ts

## The drain list

The drain list mx1's collector reads: mx1's drain list is derived from it, so
a host that is not in the descriptor is a host mx1 will not collect mail
from. Unlike `render()`, this operates on a whole fleet at once — a
fleet-level reconciler's job, not the broker's or the Pulumi component's
per-tenant one — so it takes every descriptor the caller currently holds,
not one.

Deliberately narrow: a host with no mail-enabled descriptor must never
appear, so this reads nothing but `appHostIp` and `mail.enabled` from each
descriptor, and returns nothing that was not derived from the list it was
given.
