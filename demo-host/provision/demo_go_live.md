# demo_go_live.py

## What it does

The step that opens the demo: it places the rendered Caddyfile where the edge
reads it, and only after two checks pass. On any refusal it exits non-zero,
prints one `REFUSED:` line and writes nothing (a previous file is untouched).

1. **No test stand-in is loaded.** For every slot it reads the broker's
   `GET /status/<slot>` and requires both `notReal` and `interim` to be present
   lists and empty. The broker builds `notReal` in `seamReadiness.ts`: a seam
   module counts as real only with an exact `real: true`, so
   `noop-admin-api.mjs` and `noop-drain-source.mjs` (which carry none) are
   reported, and so is any hand-written module that forgot the marker.
2. **The host clock is synchronised** (`timedatectl`'s `NTPSynchronized`),
   because gate cookies and break-glass tokens both expire.

## Fails closed

An unreachable broker, a body that is not an object, a missing or malformed
list, or a stand-in on any one of the seven slots is a refusal. Nothing here
assumes clean.

## Sabotage

`sabotage_demo_go_live.py` drops each refusal in a scratch copy; the suite must
go red for every one, and green on the real copy.
