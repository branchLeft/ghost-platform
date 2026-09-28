# docker-entrypoint.branchleft.sh

## Cloud Run port translation

Cloud Run injects the port to listen on via the `$PORT` environment variable
(defaulting to 8080 if unset, per Cloud Run's contract) and requires the
container to bind all interfaces. Ghost has no native concept of `$PORT` —
it reads `server.port` / `server.host` through nconf — so this wrapper
translates Cloud Run's convention into Ghost's own env-var config keys
(`server__port`, `server__host`; see `README.md` for the full nconf/env-var
mapping) before handing off to the upstream image's entrypoint.

The upstream entrypoint (`docker-entrypoint.sh`, shipped by the base
`ghost:6.55.0-alpine` image) still needs to run first: it steps down from
root to the `node` user via `gosu`, and seeds the (always-empty, since
Cloud Run has no durable volume) content directory from `content.orig` on
every boot — that seeding is what puts the default Casper theme and
fixture settings in place. This wrapper does not reimplement that; it
only sets env vars and execs into it.

## Storage-adapter fail-closed guard

Ghost's compiled defaults (`ghost/core/core/shared/config/defaults.json`)
are `storage.active=LocalImagesStorage`, with `LocalMediaStorage`/
`LocalFilesStorage` for the media/files features — local disk. On Cloud Run,
local disk is not durable: anything written there is not guaranteed to
survive an instance recycle (autoscale, redeploy, crash). If `storage__*`
is left unconfigured, none of that fails loudly — the container boots
cleanly, the site serves fine, an editor's upload appears to work, and the
file is silently gone the next time the instance cycles. No error, no log
line, no alert. That combination — confidently wrong, not loudly wrong —
makes it the platform's single most dangerous failure mode, so it is
refused at boot here rather than merely documented in the README.

Durability is no longer the only property this guard protects.
`adapters/scanning-storage/README.md`'s decorator is the only path a byte
can reach a served location through and still be scanned, so a bare
`S3Storage` boots durably but unscanned, silently, with every other check
here passing. The guard therefore refuses any configuration whose
`images`, `media` or `files` feature is not the decorator itself, checked
independently per feature — per-feature enforcement, not just `images` —
a decorator missing on `media` alone must refuse, even with every other
feature configured correctly — and checks the *wrapped* adapter's own
required fields (`storage__<feature>__wraps` /
`storage__<feature>__wrappedConfig__*`) rather than trusting a bare
adapter name.

Only runs when the container is actually about to start Ghost's server
process (mirrors the same `"$*"` pattern check the upstream entrypoint
itself uses before doing its root-step-down/content-reseed work) —
`docker run <image> sh` for debugging is not blocked by this.

Escape hatch, local development / the SQLite smoke test only:
`BRANCHLEFT_ALLOW_LOCAL_STORAGE=true`. Deliberately just an explicit env
var — never inferred from `NODE_ENV`, and never inferred from the
presence or absence of Cloud Run's own `K_SERVICE` variable. Failing to
detect Cloud Run is not evidence a deploy is safe; a heuristic here would
eventually be wrong in the direction that matters (a real tenant silently
allowed through), so the guard would rather annoy a developer than trust
an inference.

The hatch waives only durability (a wrapped local adapter, and the
`S3Storage` required-field check) — never the decorator requirement
itself. Every kind, demos included, still has to name the decorator and
something for it to wrap; the hatch only lets that "something" be a local
adapter instead of `S3Storage`. That gives the decorator its own
independent layer, never bypassable by the switch that exists for a
different failure mode.

## Required-field check gating

A non-local wrapped adapter configured without the config a working
upload actually needs is only marginally better than a local one — it
just moves the silent failure from "media is lost on recycle" to "media
never uploaded in the first place" (or an opaque runtime error the first
time someone tries). The required `S3Storage` fields are checked
specifically, since that is the adapter this image is built around; a
future non-default wrapped adapter would need its own equivalent check
added here.

Gated on `$wraps`, never on `$adapter` — `$adapter` is always
`ScanningStorageAdapter` by this point, so gating on it here would
silently skip this check for every real config, the exact bug the
pre-decorator guard had, restored and proven in
`scripts/test-storage-guard.sh`'s "old exact-match check" sabotage.
