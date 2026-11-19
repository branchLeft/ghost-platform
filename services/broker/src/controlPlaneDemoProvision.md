# controlPlaneDemoProvision.ts

## provisionDemo

The lifecycle worker's step from CLAIMED to LIVE or FAILED, on ops1. In order:

1. The demo must be CLAIMED and have a recorded request (`DemoNotClaimedError`,
   `DemoRecordMissingError`); nothing is sent otherwise.
2. The hostname is allocated, if it has none, before anything is signed.
3. The demo moves to PROVISIONING, which issues the seven-day term on the
   database's clock. The descriptor's `expiresAt` is that term's end.
4. An attempt: a fresh passphrase, a validated descriptor, a signed reconcile
   (sent again, unchanged, while unanswered, up to `resendLimit`), then a poll
   of `/status` until the slot is `running` and its colour answers healthy.
   The reconcile's own 200 is not success. A slot that goes to `error` or
   `free` fails at once; a status that cannot be read is tried again until
   `provisionTimeoutMs`.
5. A failed attempt that can be retried is followed by a full reset and one
   more attempt with a new passphrase (the same descriptor would be refused,
   its hash not having rotated). If the reset does not free the slot, there is
   no retry: FAILED, flagged `slotNeedsAttention`.
6. LIVE on a healthy answer. Otherwise FAILED, the state moving first so a page
   never outlives the truth, then the slot reset and the hostname retired.

A refusal from the broker is final and is never retried or reset: the broker
refuses a slot held by another tenancy, and a reset would destroy it.

The step never leaves a demo in PROVISIONING: every path ends LIVE or FAILED,
or throws before PROVISIONING (steps 1 and 3). A prospect's page shows FAILED
as a failure with a real address and the bookable call.

`LifecycleStore` is the part of the portal data layer's `ProvisionerDb` this
step uses; that class has these methods with these shapes and is passed in as
it is. The broker package does not depend on the portal.

The outcome carries the passphrase once, for the arrival mail. Logs carry
reason codes only, never a passphrase, a hash, an address or a response body.
