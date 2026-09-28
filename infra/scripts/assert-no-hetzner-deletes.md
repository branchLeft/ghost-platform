# assert-no-hetzner-deletes.py

Refuses a Pulumi plan that destroys a protected Hetzner resource.

```text
assert-no-hetzner-deletes.py <preview.json>
assert-no-hetzner-deletes.py --self-test
assert-no-hetzner-deletes.py --verify-coverage <program-dir>
```

It exits with one of three codes:

- **0:** the plan destroys nothing protected.
- **1:** it found something, or it could not read or understand an input.
- **2:** a usage error.

## Where it comes from

It is ported from shared-infra's guard of the same name. The ghost-platform
host stacks (`infra/hosts`, `infra/demo-host`) apply from CI, and this gives
them the same gate as the estate stacks they build on. The coverage map is
this repository's own. Merging the two copies is part of the shared guard
packaging, which is tracked on the board.

## What it cannot prove

Both limits are real.

1. **It checks against state, not against Hetzner.** `pulumi preview`
   compares the program with Pulumi's state, never with what is live in
   Hetzner. A resource someone deleted out of band still reads as unchanged.
   So this gate answers "will this apply destroy something", not "is the
   estate intact".
2. **A moved resource leaves the map stale.** If a resource migrates out of a
   program directory, the plan check still works, but the coverage map here
   no longer describes it. `--verify-coverage` fails until someone updates the
   map deliberately. That makes the move a reviewed edit, not a silent
   erosion.
