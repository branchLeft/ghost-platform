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

   A `locked` answer (409, reason `locked`) is not a refusal. The broker holds
   the slot lock for the whole of a reconcile, so a reconcile that outlasts the
   call's own 120 s deadline is still running when it is sent again: the worker
   waits `pollIntervalMs` and sends it again, unchanged, until the original
   finishes (the resend is then the broker's idempotent replay) or
   `provisionTimeoutMs` passes, when the attempt fails as `unanswered`. A reset
   met by the same lock is waited out the same way.
5. Once the slot answers healthy, the arrival mail is sent (`sendArrival`: the
   owner's copy, then the prospect's), still before LIVE. The passphrase is
   held nowhere but the mail, so a demo is never LIVE with a passphrase nobody
   was sent. A mail that cannot be sent fails the attempt (`mail`), and the
   retry carries a fresh passphrase.
6. A failed attempt that can be retried is followed by a full reset and one
   more attempt with a new passphrase (the same descriptor would be refused,
   its hash not having rotated). If the reset does not free the slot, there is
   no retry: FAILED, flagged `slotNeedsAttention`.
7. LIVE on a healthy answer and a sent mail. Otherwise FAILED, the state moving
   first so a page never outlives the truth, then the slot reset and, if it
   was freed, the hostname retired.

A refusal from the broker is final and is never retried or reset: the broker
refuses a slot held by another tenancy, and a reset would destroy it.

A FAILED demo whose slot needs a person (`slotNeedsAttention`) keeps its
hostname unretired. That is what holds the slot: the data layer's
`ProvisionerDb.admit` counts a FAILED demo with an unretired hostname as
holding a slot, so the claim step cannot offer it again. The person frees the
slot and then retires the hostname. A retirement the register would not take
leaves the slot held the same way, and the outcome says `hostnameRetired:
false`.

The step never leaves a demo in PROVISIONING: every path ends LIVE or FAILED,
or throws before PROVISIONING (steps 1 and 3). A throw after PROVISIONING (a
signing key of the wrong length, a database error) is caught: the demo is moved
to FAILED with reason `internal`, the slot flagged for a person and its
hostname left unretired, because its state is unknown. The one exception is a
store that cannot record FAILED either: the original error is then thrown, and
the demo stays PROVISIONING, for the worker's caller to see. A process killed
outright cannot catch anything; a sweep for a stale PROVISIONING is the
worker's loop, which is not built here. A prospect's page shows FAILED as a
failure with a real address and the bookable call.

`LifecycleStore` is the part of the portal data layer's `ProvisionerDb` this
step uses; that class has these methods with these shapes and is passed in as
it is. The broker package does not depend on the portal.

The outcome never carries the passphrase: it goes to `sendArrival` once per
attempt and nowhere else. Logs carry reason codes only, never a passphrase, a
hash, an address or a response body.
