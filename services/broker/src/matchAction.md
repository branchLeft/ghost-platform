# matchAction.ts

The control plane's half of what a match does (LLD-7 section 06). The host's
half, withholding and sealing every copy, is the scanning adapter's
(`adapters/scanning-storage/src/policy.md`).

## The tier

`tierOf` is exact + csam (and the `test` classification) for tier two, any
other match for tier one, and nothing for a verdict that is not a match. Only
the exact string `exact` reaches tier two. A missing or oddly-cased
`matchType`, and a classification not known here, are tier one: a perceptual
false positive must never reach an irreversible action. It is a mirror of the
adapter's `policy.js`, and `matchAction.test.ts` runs one table through both.

## The plan

`planMatch(verdict, estate)` reads as facts: `seal` and `startReportingClock`
are tier two; `freeze` is tier one; `killSlot` is tier two on a demo and
nothing else. A tier-one freeze is identical on both estates. A live tenant is
never taken down for one upload: the site keeps serving, and what is withheld
is withheld on the host.

## The kill

`killDemoSlot` sends `POST /freeze`, which detaches the slot's whole held set
(its content volume with the quarantine, the data volume) to the held area and
confirms it, and only on `detached` sends `POST /reset`. The tenancy goes, the
evidence does not. It never resets on `pending`, `locked`, `unanswered` or
`refused`, so a failed detach leaves the slot up and the evidence where it is
(`evidence-not-detached`: the caller pages). A slot that is already free has
nothing to kill. A reset that does not complete after a confirmed detach is
`reset-failed` and is sent again; the evidence is safe either way. Nothing here
returns any wording about why.

## What this does not do

The plain 404 the demo's hostname answers once the slot is free belongs to the
edge and the gate, not here. Nothing calls `actOnMatch` yet: the safety
service's dial-in, which holds a verdict and knows the host, is where it is
called from.
