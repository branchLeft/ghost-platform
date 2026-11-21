# controlPlaneDemoDescriptor.ts

## buildDemoDescriptor

A recorded demo request becomes the demo descriptor the broker reconciles,
built through render-core: every branded field comes from its `validate*`
constructor and the whole is passed to `validate()` with the estate's own
zones, so a descriptor this module returns is one the broker's own check
accepts.

Three things are never taken from the request. The slot's uid and ports come
from `slotAllocation`, the arithmetic the broker checks a descriptor against.
The slug, the data and spool paths and the mail identity come from the slot
alone, so nothing a prospect typed names a path. The hostname is the label the
register allocated, which is random. The prospect's verified address is the
one field that is theirs: it is `ownerEmail`, and it appears nowhere else.

`expiresAt` is the end of the term the database issued on entering
PROVISIONING. This function never computes a term: the seven days are the
database's clock and the lifecycle's rule, carried here unchanged.

`DemoEstate` is the posture that is the same for every demo (image pin, zones,
caps, limits, mail ceilings). It is configuration, supplied by the worker's
wiring, and has no defaults here.

This module, with the three beside it, runs on ops1 and is not reachable from
the demo host's bundle (`controlPlaneDemoIsolation.test.ts`).
