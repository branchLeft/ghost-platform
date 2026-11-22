# demo_verdict_evidence.py

## What it does

The owner's ruling of 10 October 2026: the demo is not opened to visitors with
an upload route that scans nothing, and no checkpoint evidence includes an
upload, until a production verdict source is wired for it. This is the check
that makes that mechanical outside the go-live step.

It reads the broker's `GET /status/<slot>` for every slot and requires
`productionVerdictSource` to be exactly `true`. The broker computes that from
the `compose.yml` render-core rendered into the slot's directory
(`services/broker/src/verdictSourceReport.md`), so no caller can set it.

- Wired on every slot: exit 0 and `VERDICT SOURCE WIRED: slots 0, 1, ...`.
  Evidence that names an upload cites this line.
- Anything else: exit 1 and one `REFUSED:` line naming every slot that is not
  wired. Evidence that includes an upload while this refuses is not evidence.

`demo_go_live.py` runs the same check (`check_verdict_source`, inside
`check_seams`), so opening the demo refuses on the same grounds.

## Fails closed

An unreachable broker, a body that is not an object, a status with no
`productionVerdictSource`, and any value but a JSON `true` (`false`, `"true"`,
`1`, `null`) are refusals. Today render-core renders no verdict source for a
demo (`render-core/src/environment.md#verdict-source`), so every slot reads
`false` and this refuses; the demo upload route stays refusing as well.

## Sabotage

`sabotage_demo_go_live.py` drops the verdict check from each of the two
callers and from the evidence step in a scratch copy; the suite goes red for
each and green on the real copy.
