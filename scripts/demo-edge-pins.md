# demo-edge-pins.mjs

## What this does

Holds the demo-edge image to the pins written in `services/demo-edge/Dockerfile`.
The Dockerfile is the only home of the pins: Caddy `2.11.4` (spelled three times,
in the builder tag, the `xcaddy build` argument and the final tag), the two base
image digests, and the Hetzner DNS module `github.com/caddy-dns/hetzner/v2`
`v2.0.1`. There is no second pins file to drift from it.

```
node scripts/demo-edge-pins.mjs <image> [dockerfile] [--arch amd64]
```

It runs two checks and exits non-zero on any problem.

1. **Static.** The Dockerfile must have exactly two `FROM caddy:...` lines (a
   `-builder-alpine` stage named `builder`, then the plain `-alpine` final), each
   with an `@sha256` digest; exactly one `xcaddy build` with a `vX.Y.Z` Caddy
   argument and nothing but the Hetzner module, pinned to `vX.Y.Z` (not absent,
   not `latest`); and the three Caddy spellings must agree. A deliberate bump
   that moves every spelling together passes.
2. **Binary.** The image is run with `--entrypoint caddy`. `caddy version` must be
   the pinned Caddy, `caddy list-modules --versions` must list
   `dns.providers.hetzner` at the pinned version, `caddy build-info` must show
   both `github.com/caddy-dns/hetzner/v2` and `github.com/caddyserver/caddy/v2`
   at their pinned versions, and the image architecture must be `amd64` (pass
   `--arch arm64` to check a native build on an Apple-silicon Mac).

The binary check is skipped when the static check already failed.

## Exports

`readPins`, `problems` (static) and `compareReports` (pure: takes the observed
outputs as strings) are exported so `workflow-demo-edge-image.test.js` can break
each pin in a copy of the real text and require a named problem.

## Where it runs

`.github/workflows/demo-edge-image.yml` runs it against the built image, runs it
again against a copy of the Dockerfile with the module version bumped (which must
fail, for the module version), and runs it a third time against the image pulled
by digest, with the run's token, after publication.

Node built-ins only; no install. It shells out to `docker` with `execFileSync`
and no shell.
