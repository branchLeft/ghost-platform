# production-verdict-client.js

## What it is

`ProductionVerdictClient` implements the existing `getVerdict(key)` seam
against a safety service reached through an injected transport. It owns no
socket, address or credential: the transport is the only thing that dials,
and what it presents when it does is the transport's business.

The transport is `{ connect({ signal }) }`, resolving a connection
`{ ask(key, { signal }), close() }` (`close` is optional). An answer is
`{ classification, matchType? }` in the vocabulary of `verdict-client.md`.

## Failure semantics: no answer is never an allow

`getVerdict` never rejects. Every outcome other than a recognised answer
inside the budget is `unavailable`, which `policy.js` turns into a hold: the
upload is accepted, kept outside the served tree, and promoted only by a later
clean verdict.

| Outcome | Reason in the log line |
| --- | --- |
| connect not complete inside the connect budget | `connect-timeout` |
| no answer inside the total budget (connect included) | `total-timeout` |
| connect or ask rejected, or threw | `transport-error` |
| answer is not a plain object with a known classification | `malformed-answer` |
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

## Logging

One line per hold, on the injected logger's `error` stream:

`ProductionVerdictClient: VERDICT_UNAVAILABLE reason=<reason> key="<key>" error=<message>`

The error text is one line and bounded. A logger that throws changes nothing:
the hold stands.
