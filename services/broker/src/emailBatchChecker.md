# emailBatchChecker.ts

## EmailBatchChecker

Load-bearing: a colour is not stopped while it holds an email or batch in
`submitting` — Ghost promotes an orphaned `submitting` batch to `failed`
rather than resending it, so stopping a colour mid-send costs a reader a
partial newsletter.

A seam (like `AdminApiClient`) rather than a query inlined into `app.ts`, so
`/stop`'s own tests can drive it without a real sudo call.
`createSudoEmailBatchChecker`, below, is the real implementation: the
platform owner's ruling on this seam's open design question was a new
read-only verb in the sudoers-enumerated wrapper
(`demo-host/provision/branchleft_slot.py`'s `email-batches`), never a
second privileged path of the broker's own.

## createSudoEmailBatchChecker

The real `EmailBatchChecker`: one sudo call per check, to the same
enumerated wrapper `wrapper.ts` already calls for `start`/`stop`/`reset`
(reusing its exact `command`/`prefix`/`timeoutMs` shape at the call site is
deliberate — one wrapper, one config).

**Fail-closed on everything, by construction, never by a caller remembering
to catch something.** A non-zero exit, a timeout, or stdout that is not a
bare count (`BARE_COUNT_PATTERN`) all resolve `true` — "assume submitting" —
exactly like `createFailClosedEmailBatchChecker`'s own unconditional
default. Never throws: `attemptStopOldColour` (`app.ts`) awaits this
directly inside its own refusal check, and a rejected promise there would
crash the request instead of refusing it.
