# sweegoOutcomes

Carries a delivery provider's final word on each message back to the spool it
was drained from, by reading the provider's sending logs on a timer. It reuses
the hand-over the mx1 path already uses (the spool's outcome route): nothing
here writes to a spool another way, and nothing here talks to Ghost.

This slice holds the provider-neutral core only. There is no provider client,
no credential and no network call: a provider is the `OutcomeProvider`
interface, and the tests use a fake. A real client, the persistent journal and
the wiring into the collector loop are separate slices.

## States

| State          | Meaning                                                                         | Reports to the spool    |
| -------------- | ------------------------------------------------------------------------------- | ----------------------- |
| `submitted`    | Accepted by the provider, no final word yet                                     | nothing                 |
| `deferred`     | The provider is retrying                                                        | nothing                 |
| `delivered`    | The recipient's server accepted it                                              | `delivered`             |
| `bounced-hard` | Permanent failure: needs an explicit hard bounce and, if a code is given, a 5xx | `failed`, `permanent`   |
| `bounced-soft` | Temporary failure; a later delivery or hard bounce still replaces it            | `failed`, `temporary`   |
| `complained`   | The recipient reported it as unwanted                                           | `complained` (held off) |
| `expired`      | No final word within the expiry window, or the provider's retention ran out     | nothing                 |

`step` only moves forward. A hard bounce and a complaint are never overwritten.
`expired` is not a claim about the message, so a late final word replaces it,
and the spool is told nothing when it is set: a message with no proof either
way stays "sent", never "delivered" and never "failed".

## One pass (`poller.ts`)

1. Messages older than the provider's retention are marked lost, not guessed.
2. The log window is read from the oldest message still waiting, one UTC day at
   a time, page by page. A window that could not be read in full is applied as
   nothing and does not move the cursor, so a failed page loses no state.
3. Each record names its message through our own correlation value. A record
   without one, or naming no journal entry, is foreign. A record naming a
   different spool than the journal's is dropped: a tenant's outcome never
   reaches another tenant's spool, whatever the provider returns.
4. The clock expires what is still silent.
5. Owed reports go to the spool, one target at a time, in batches of 200. A
   message counts as reported only after the spool answers `recorded` or
   `alreadyHandled`; `unknown` or a failure keeps it for the next pass, so a
   repeated record or a repeated report never produces a second event.
6. Settled entries are forgotten after a keep window; a late complaint can still
   be placed inside it.

`lastCompleteScanMs` is the cursor. The window itself comes from the journal,
so a restart or a long gap re-reads exactly what is still owed. Its gap since
the last complete scan, compared with the retention, is what a gap alert reads.

Complaints are reported only when `reportComplaints` is set, because the spool
rejects a whole batch holding an outcome it cannot parse; it is turned on only
once the spool accepts a complained outcome.

Logs carry the target id and an error class. They never carry a
credential, an address, a subject or provider text.
