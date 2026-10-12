# production-verdict-client.js

## What it is

`ProductionVerdictClient` implements the existing `getVerdict(key)` seam
against a safety service reached through an injected transport. It owns no
socket, address or credential: the transport is the only thing that dials,
and what it presents when it does is the transport's business.

The transport is `{ connect({ signal }) }`, resolving a connection
`{ ask(key, { signal }), close() }` (`close` is optional). An answer is
`{ key, classification, matchType? }` in the vocabulary of
`verdict-client.md`.

## Correlation

Correlation belongs to the transport, and the client relies on it. One
`getVerdict` dials one connection, asks it once and closes it; the client
never asks two keys on one connection. A connection's `ask(key)` must settle
only with the service's answer to that same key. An answer to an earlier ask
that timed out or was aborted must be discarded, never handed to a later ask,
whether the transport pools, pipelines or shares a channel.

On a handle borrowed from a pool, `close()` ends this ask's use of it: it
releases the handle and discards any answer still owed to this ask. It does
not close the pool.

The answer must carry the key it answers, copied from the service's reply and
not stamped by the transport from its own bookkeeping. The client holds any
answer whose `key` is absent or differs from the key it asked, as
`malformed-answer`; a transport that stamps the asked key onto whatever
arrives defeats that check, and no client can detect it.

The real transport's own test suite must include: ask key A so that its
answer arrives after the budget, then ask key B, and assert that B's result is
B's answer or `unavailable`, never A's. This module cannot prove that; it is
owed by the story that builds the transport.

## Failure semantics: no answer is never an allow

`getVerdict` never rejects, whatever a transport throws or rejects with,
including values that cannot be turned into text. Every outcome other than a recognised answer
inside the budget is `unavailable`, which `policy.js` turns into a hold: the
upload is accepted, kept outside the served tree, and promoted only by a later
clean verdict.

| Outcome | Reason in the log line |
| --- | --- |
| connect not complete inside the connect budget | `connect-timeout` |
| no answer inside the total budget (connect included) | `total-timeout` |
| connect or ask rejected, or threw | `transport-error` |
| answer is not a plain object with a known classification, or does not carry the asked key | `malformed-answer` |
| the channel itself answers `unavailable` | `channel-unavailable` |
| the key is not a non-empty string (the channel is not dialled) | `invalid-key` |

A known classification is `no-known-match`, `csam`, `harmful-abusive-material`
or `test`. Anything else, including a wrong-case or padded spelling, is
malformed and held, never read as clean and never as a refusal.

An answer that arrives after its budget is ignored. A connection that opens
after its budget is closed unused. On a hold the transport is told to stop
through the `AbortSignal` it was given.

## Budgets

`connectTimeoutMs` bounds the connect; `totalTimeoutMs` bounds connect plus
answer together. Both must be positive finite numbers or construction throws,
so a bad value cannot become an unbounded wait. Defaults sit below the
check's own outer budget (`checks.js`), so this client decides first and
logs; the outer budget remains the backstop.

The connect budget is capped at the total, so a connect that outlasts both
reports `connect-timeout`. Budgets have no upper bound here: a value above
2147483647 makes Node's timer fire at once, and every ask then holds. That
fails closed, and it is a limit.

## Metrics

A hold decided in this client is counted by the check as an `unavailable`
verdict (`scanning_storage_verdicts_total`), not as a verdict error
(`scanning_storage_verdict_errors_total`): only the check's own timeout and
catch are counted there. Until the check counts them, read an outage of this
channel from the `unavailable` classification and the held-age series.

## Logging

One line per hold, on the injected logger's `error` stream:

`ProductionVerdictClient: VERDICT_UNAVAILABLE reason=<reason> key="<key>" error=<message>`

The error text is one line and bounded. A logger that throws changes nothing:
the hold stands.
