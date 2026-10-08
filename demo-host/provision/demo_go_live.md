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

## What it does not cover

- **Only this step may place the live Caddyfile.** `render_demo_site.py` can
  write a rendered file with `--out`, unchecked, so its output is a candidate
  to hand to this step as `--caddyfile`, never a file to put in the edge's
  directory. Nothing mechanical stops a hand-copy; that is a runbook rule.
- **A broker restarted with stand-ins after the demo is open is not
  re-checked.** The owner's ruling covers the go-live step only; a recurring
  check is a separate piece of work.
- **The optional `BROKER_EMAIL_BATCH_CHECKER_MODULE` plugin is outside
  `seamReadiness`**, so a stand-in loaded there is not reported. The ruling
  names the admin and drain stand-ins only.

## How the real readers are tested

`fetch_status` runs against a real loopback HTTP listener serving the body
`app.ts`'s `handleStatus` sends. `clock_is_synchronised` runs against a stub
`timedatectl` first on PATH that prints `yes`, `no`, exits non-zero, or is
absent, matching `timedatectl show -p NTPSynchronized --value`.
