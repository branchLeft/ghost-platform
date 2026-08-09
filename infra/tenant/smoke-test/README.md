# `GhostTenant` smoke test

Not part of the reusable component. A disposable Pulumi program that
instantiates `../index.ts`'s `GhostTenant` with placeholder values, so the
component's resource plan can be inspected with `pulumi preview` before any
real tenant repo exists to instantiate it for real.

**Preview only. Never run `pulumi up` from here** -- see the root story's
platform-owner-gated-steps note. This program was used to produce the preview
output quoted in the PR that introduced it.

## Stack

Stack name: `scratch-s8-smoke-test` -- deliberately not `platform` and not a
real tenant name, so it can't be confused with either. Backend:
`gs://branchleft-pulumi-state` (this workspace's configured state backend),
meaning `pulumi stack init` registers real (tiny, metadata-only) state there
even though nothing in this program is ever applied.

**This stack is not self-cleaning.** `pulumi stack rm` is a state-mutating
operation reserved for the platform owner in this programme (see
`ghost-platform-docs`' implementation-loop conventions) -- whoever reads
this after the PR that added it should run:

```sh
pulumi stack rm scratch-s8-smoke-test
```

from this directory once the preview output has been reviewed and this
directory is no longer needed for reference.

## Running it again

```sh
cd infra/tenant/smoke-test
npm install
pulumi stack select scratch-s8-smoke-test   # or: pulumi stack init scratch-s8-smoke-test
pulumi preview
```

Placeholder values in `index.ts` are fake (bogus connection names, a
`gs://` URL that isn't a real bucket, a fake image tag) -- deliberately, so
this can never accidentally resolve to real platform resources.
