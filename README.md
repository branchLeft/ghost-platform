# ghost-platform

Reusable, public-facing pieces of branchLeft's multi-tenant Ghost hosting
platform: the tenant container image, the shared-platform and per-tenant
Pulumi infrastructure (`infra/`), and eventually the base theme and shared
Handlebars partials.

This repo is engineered as if it were already public — no secrets, no
tenant names, no internal-only shorthand — even while it's still private.

## What's here today

**The tenant Ghost container image** — a `Dockerfile` building on the
official `ghost` image, pinned to an explicit version and digest, with no
tenant-specific configuration baked in. Every tenant runs the *same* image;
everything that differs between tenants (database credentials, site URL,
storage bucket prefix, ...) is supplied at deploy time via environment
variables (see the table below).

**The infrastructure that provisions it** — see [`infra/README.md`](infra/README.md)
for the split between the shared platform stack (`infra/platform/`: the
Cloud SQL instance, the tenant image's Artifact Registry repository, the
shared media bucket) and the reusable per-tenant component
(`infra/tenant/`: a tenant's dedicated service account, logical database,
storage write-isolation, and Cloud Run service). Actually instantiating
that component for a real tenant — the `ghost-platform-tenants` repo and
Workload Identity Federation for CI — is still a later story; nothing in
this repo pushes an image anywhere or applies infrastructure to GCP on its
own.

Ghost runs one site per process. "Multi-tenant" here means one container
per tenant on shared compute, not one process serving many sites — see
[`ghost-platform-docs/06-runtime-research-findings.md`](../ghost-platform-docs/06-runtime-research-findings.md)
for how that was confirmed against Ghost's source.

## Storage adapter — verified against source, not assumed

The platform's architecture doc
([`09-backup-restore-and-media-storage.md`](../ghost-platform-docs/09-backup-restore-and-media-storage.md))
claims Ghost ships a built-in S3-compatible storage adapter. That claim is
**confirmed correct**, checked directly against the Ghost source in this
org's fork and against the actual published `ghost:6.55.0-alpine` image
(not against documentation or memory):

- `ghost/core/core/server/adapters/storage/S3Storage.ts` exists in the fork
  alongside `LocalImagesStorage.ts`, `LocalMediaStorage.ts`,
  `LocalFilesStorage.ts`, and `LocalStorageBase.ts` — it is one of Ghost's
  own shipped storage adapters, not a third-party package.
- It's built on `@aws-sdk/client-s3` (a direct dependency of `ghost/core`'s
  `package.json`), and validates its config with a `zod` schema that
  requires `bucket`, `staticFileURLPrefix`, `cdnUrl`,
  `multipartUploadThresholdBytes`, `multipartChunkSizeBytes`, and accepts
  optional `region`, `endpoint`, `forcePathStyle`, `accessKeyId`,
  `secretAccessKey`, `sessionToken`, `tenantPrefix` — i.e. a generic
  S3-compatible client, not hardcoded to AWS.
- Confirmed **inside the actual published image**, not just the source
  tree: `docker run --rm ghost:6.55.0-alpine sh -c "ls
  /var/lib/ghost/current/core/server/adapters/storage"` lists
  `S3Storage.js` next to the `Local*Storage.js` files, and
  `/var/lib/ghost/current/node_modules/@aws-sdk/client-s3` exists. Every
  official Ghost 6.55.0 image already ships this adapter and its
  dependency — **no package install and no adapter-registration step is
  needed in this Dockerfile.** Activating it is pure configuration (see
  the env var table below).
- How adapters are resolved: `ghost/core/core/server/services/adapter-manager/index.ts`
  registers `internalAdaptersPath: core/server/adapters/` as one of the
  paths `AdapterManager` searches (`adapter-manager.ts`'s `loadAdapter`),
  and resolves the active class from config key `storage.active` (i.e. env
  var `storage__active=S3Storage`) plus a per-class config block
  (`storage.S3Storage`, i.e. `storage__S3Storage__*` env vars). A *custom*
  (non-built-in) adapter would instead go under Ghost's content path —
  `<contentPath>/adapters/storage/<ClassName>/` — but that path isn't
  needed here since `S3Storage` is already internal.

**Doc 09's other claim — that `@tryghost/gcs-adapter` is deprecated with no
maintained successor — was not independently re-verified here** (out of
scope for this story; doc 09 already cites the npm deprecation notice).
It doesn't matter for this image either way, since the built-in adapter is
what's used.

### A correction to the doc set: no `GHOST_` env var prefix

The story brief (and
[`03-onboarding-and-repo-strategy.md`](../ghost-platform-docs/03-onboarding-and-repo-strategy.md),
which states `GHOST_DATABASE__CONNECTION__HOST`-style env vars) both assume
Ghost's env-var config keys are `GHOST_`-prefixed. **This is incorrect.**
Verified two ways:

1. Source: `ghost/core/core/shared/config/loader.ts` calls
   `nconf.env({separator: '__', parseValues: true})` with no `prefix`
   option. Reading `nconf`'s own `Env` store source
   (`lib/nconf/stores/env.js`, `loadEnv()`): prefix-stripping only happens
   if `this.prefix` is set, and it isn't set here — so nconf reads
   `process.env` keys **exactly as they appear**, case included, with `__`
   as the only nesting transform.
2. Confirmed against Ghost's own published docs
   (`docs.ghost.org/config/`): the documented examples are
   `database__connection__host`, `url`, `logging__transports` —
   **lowercase, no `GHOST_` prefix.**

This image, its README, and its smoke test use the *correct* convention
(`database__connection__host`, not `GHOST_DATABASE__CONNECTION__HOST`).
`ghost-platform-docs` doc 03 should be corrected in a follow-up — flagging
here rather than editing that repo, which is out of scope for this
worktree.

## Building and running locally

```sh
docker build -t ghost-platform:local .
```

Base image: `ghost:6.55.0-alpine`, pinned by tag **and digest**
(`sha256:de23ea18e09f1f6e94dd323c831c3821494fa054b7a55984a5bd0b817fcab918`
as resolved on 2026-08-04 — re-pin deliberately on any base image bump, the
Dockerfile comment explains why). Not `latest`, not a bare `6`/`6-alpine`
floating tag.

### Smoke test

```sh
./scripts/smoke-test.sh ghost-platform:local
```

Boots the image against SQLite (**local/dev/smoke-test only** — production
tenants use Cloud SQL MySQL; SQLite has no place on Cloud Run, which has no
durable local disk), on a deliberately non-default port (4200, both as the
host port and as the container's `$PORT`) to demonstrate the image honours
`$PORT` rather than assuming Ghost's upstream default of 2368. Waits for a
strict HTTP-200 check — not just a TCP connect, which doc 06's retraction
note explains is a real trap with Ghost's migration lock — then reports
boot time and idle memory.

### Observed results (this run, 2026-08-04, macOS + Docker Desktop 27.0.3)

| Metric | Doc 06 baseline | Observed here |
|---|---|---|
| Idle memory | ~179–184 MiB | **171.3 MiB** (settled, 15s after ready) — matches |
| Fresh-SQLite boot incl. migrations | ~3.1s | **~2.2–4s** across two runs (0.2s/0.5s poll granularity) — matches |
| Warm cold start (pre-migrated DB) | ~1.0s | **~2.0s** (bind-mounted SQLite file reused across two container runs) — **roughly 2x doc 06's figure** |

The warm-start discrepancy is flagged, not papered over: doc 06 doesn't
state its test OS, and this run was on macOS Docker Desktop, where
bind-mounted volume I/O goes through a VM/virtiofs layer with materially
higher latency than native Linux (which Cloud Run and any CI runner would
be). That's a plausible, not confirmed, explanation — re-measuring on
native Linux (a GitHub Actions runner, for instance) would settle it. Not
treating either number as ground truth beyond what's actually been
measured.

`curl -i` confirming `$PORT` honoured on a non-default port:

```
$ curl -i http://localhost:4200/
HTTP/1.1 200 OK
X-Powered-By: Express
Cache-Control: public, max-age=0
Content-Type: text/html; charset=utf-8
Content-Length: 17157
...
```

`docker history` on the built image shows only two added layers beyond the
upstream base — copying and `chmod +x` on the ~1.15KB entrypoint wrapper
script. Nothing else is added, so there is nothing tenant-specific or
secret to find there.

## Environment variables

All configuration reaches Ghost through `nconf`, which reads `process.env`
directly using `__` as the nesting separator and **no prefix** (see the
correction above). None of these are baked into the image; every tenant's
container gets the same image with a different environment.

### Platform-level (not an `nconf`/Ghost config key)

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `PORT` | Optional | Deploy platform (Cloud Run injects this automatically) | Consumed by `docker-entrypoint.branchleft.sh`, translated into `server__port`/`server__host`. Defaults to `2368` if unset (matching upstream Ghost's own default), bound to `0.0.0.0`. |
| `SERVER_HOST` | Optional | Deploy config | Escape hatch to override the bind address the wrapper sets; almost never needed — Cloud Run always wants `0.0.0.0`. |
| `BRANCHLEFT_ALLOW_LOCAL_STORAGE` | Optional, **local development and the smoke tests only** | Never set in a real deploy | The one way past the storage guard described below. Must be `true` exactly, set deliberately — see "Fail-closed storage guard". |

### Required — site

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `url` | **Required** | Deploy config (per-tenant, not secret) | Must include protocol, e.g. `https://news.example.org`. Ghost refuses to boot without a protocol-qualified URL. |

### Required — database (Cloud SQL MySQL in production)

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `database__client` | **Required** | Deploy config | `mysql` in production (auto-aliased to the `mysql2` driver internally). `sqlite3` for local/smoke-test only. |
| `database__connection__host` | **Required** (MySQL) | Deploy config | Cloud SQL host or Unix socket path. |
| `database__connection__user` | **Required** (MySQL) | **Secret Manager** | Per doc 02: one dedicated DB user per tenant. |
| `database__connection__password` | **Required** (MySQL) | **Secret Manager** | Per-tenant DB password. |
| `database__connection__database` | **Required** (MySQL) | Deploy config | Per-tenant logical database name (shared instance, per doc 09). |
| `database__connection__filename` | Required (SQLite only) | Deploy config | Local/smoke-test only — a path under the (ephemeral) content dir, e.g. `/var/lib/ghost/content/data/ghost.db`. Never used against production. |

### Required — object storage (GCS via the S3-compatible XML API)

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `storage__active` | **Required** in production, **enforced at boot** | Deploy config | `S3Storage`. The entrypoint refuses to start Ghost's server process if this is unset or names a `Local*Storage` adapter — see "Fail-closed storage guard" below. This is not just documentation; a misconfigured tenant fails to boot instead of silently serving on local disk. |
| `storage__S3Storage__bucket` | **Required** | Deploy config | The shared platform bucket (doc 09: one bucket, tenant-prefixed paths — not one bucket per tenant). |
| `storage__S3Storage__staticFileURLPrefix` | **Required** | Deploy config | Key prefix under the bucket, e.g. `content/images`. |
| `storage__S3Storage__cdnUrl` | **Required** | Deploy config | Public base URL files are served from, e.g. a CDN in front of the bucket, or `https://storage.googleapis.com/<bucket>` directly. |
| `storage__S3Storage__multipartUploadThresholdBytes` | **Required** | Deploy config | Platform-wide constant, not per-tenant. Recommend `10485760` (10 MiB). |
| `storage__S3Storage__multipartChunkSizeBytes` | **Required** | Deploy config | Platform-wide constant. Must be ≥ 5 MiB (`5242880`) — S3Storage enforces this floor itself (GCS's own multipart minimum). |
| `storage__S3Storage__endpoint` | **Required** for GCS | Deploy config | `https://storage.googleapis.com`. |
| `storage__S3Storage__region` | Required by the AWS SDK client, functionally unused by GCS | Deploy config | The client requires *some* region string even though GCS's XML API doesn't use it meaningfully. **Not independently verified against a live GCS bucket in this story** (out of scope — no GCP resources here); confirm the right placeholder value in the provisioning story. |
| `storage__S3Storage__forcePathStyle` | Recommended `true` for GCS | Deploy config | Based on GCS's published S3-interoperability guidance, not exercised against a real bucket in this story — re-verify when the provisioning story wires up an actual GCS bucket. |
| `storage__S3Storage__tenantPrefix` | Optional | Deploy config | Per-tenant prefix within the shared bucket, per doc 09's bucket-structure decision. |
| `storage__S3Storage__accessKeyId` | **Required** in production | **Secret Manager** | Per-tenant GCS HMAC key (doc 09). |
| `storage__S3Storage__secretAccessKey` | **Required** in production | **Secret Manager** | Per-tenant GCS HMAC secret. |

### Optional — recommended platform-wide defaults

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `privacy__useUpdateCheck` | Optional | Deploy config | Recommend `false`. Ghost pings `explore.ghost.org` on boot by default (doc 06 finding #4) — worth a deliberate opt-out given the platform's tenants are public-interest news outlets. Not wired into the image by default, since that's a policy call for the platform team, not something to bake in silently. |
| `logging__transports` | Optional | Deploy config | The upstream image bakes in `["file", "stdout"]`. File logs are lost on every Cloud Run restart (ephemeral disk) — not a correctness problem (nothing depends on them surviving), but consider overriding to `'["stdout"]'` so Cloud Logging is the only log sink that matters. |
| `mail__transport`, `mail__options__*` | Not required to boot | Deploy config / Secret Manager (for SMTP credentials) | Needed for staff invites, password resets, and member magic links to actually send. Out of scope for this story (image boots and serves fine with the upstream `Direct` transport default); a real transport is needed before onboarding real tenants. |

## Fail-closed storage guard

Ghost's compiled defaults
(`ghost/core/core/shared/config/defaults.json`) are
`storage.active=LocalImagesStorage` (`LocalMediaStorage`/`LocalFilesStorage`
for the media/files features) — local disk. If a tenant's deploy config
simply omits `storage__active`, nothing about that fails loudly on its own:
the container boots cleanly, the site serves, an editor's upload appears to
succeed, and the file is silently gone the next time the Cloud Run instance
recycles (autoscale, redeploy, crash) — no error, no log line, no alert.
That's arguably the platform's most dangerous failure mode precisely
because it presents as success, so it's enforced in the image, not just
described here.

`docker-entrypoint.branchleft.sh` refuses to start Ghost's server process
(`exit 1`, before `docker-entrypoint.sh`/`node` ever runs) when, for the
actual server-start command:

- `storage__active` is unset, or
- `storage__active` matches `Local*Storage` (catches
  `LocalImagesStorage`/`LocalMediaStorage`/`LocalFilesStorage` and stays
  correct if a future local-disk-shaped adapter shows up under a different
  name), or
- `storage__active=S3Storage` but any of the fields a working upload
  actually needs are missing (`bucket`, `staticFileURLPrefix`, `cdnUrl`,
  `multipartUploadThresholdBytes`, `multipartChunkSizeBytes`) — a non-local
  adapter with a missing bucket is only marginally better than a local one,
  it just moves the silent failure from "lost on recycle" to "never
  uploaded, or an opaque runtime error the first time someone tries".

**Escape hatch, local development and the smoke tests only:**
`BRANCHLEFT_ALLOW_LOCAL_STORAGE=true`. Deliberately just an explicit env
var that has to be set on purpose — never inferred from `NODE_ENV`, and
never inferred from the presence or absence of Cloud Run's own `K_SERVICE`
variable. Detecting "not Cloud Run" isn't evidence a deploy is safe; a
heuristic here would eventually be wrong in the one direction that
matters — a real tenant let through silently — so the guard would rather
annoy a developer than trust an inference. `scripts/smoke-test.sh` sets it
explicitly for exactly this reason.

The guard only runs for the actual server-start command (mirrors the same
pattern check the upstream entrypoint itself uses before its own
root-step-down/content-reseed work), so `docker run <image> sh` for
debugging isn't blocked by it.

### Proof: blocked without config, boots with it

`scripts/test-storage-guard.sh` is the regression test — five scenarios,
run against a real build, checked both directions (three that must be
blocked, two that must be allowed to boot):

```sh
docker build -t ghost-platform:local .
./scripts/test-storage-guard.sh ghost-platform:local
```

Actual output from a real run (2026-08-04):

```
--- no storage__active set, no escape hatch (expect: blocked) ---
FATAL: storage__active is not set.
Ghost defaults to local-disk storage (LocalImagesStorage /
LocalMediaStorage / LocalFilesStorage), which is silently lost on
every Cloud Run instance recycle -- no error, no warning, just gone
media. Set storage__active=S3Storage plus the storage__S3Storage__*
variables documented in README.md for any real deploy.

Local development / smoke tests only: set
BRANCHLEFT_ALLOW_LOCAL_STORAGE=true to bypass this check.
PASS: no storage__active set, no escape hatch (exit 1, guard message present)

--- storage__active explicitly set to a local adapter (expect: blocked) ---
FATAL: storage__active=LocalImagesStorage is a local-disk adapter.
...
PASS: storage__active explicitly set to a local adapter (exit 1, guard message present)

--- storage__active=S3Storage with required fields missing (expect: blocked) ---
FATAL: storage__active=S3Storage but required config is missing:
  - storage__S3Storage__staticFileURLPrefix
  - storage__S3Storage__cdnUrl
  - storage__S3Storage__multipartUploadThresholdBytes
  - storage__S3Storage__multipartChunkSizeBytes
See README.md's environment variable table for what each one means.
PASS: storage__active=S3Storage with required fields missing (exit 1, guard message present)

--- escape hatch set, no storage config (local dev) (expect: boots, HTTP 200) ---
PASS: escape hatch set, no storage config (local dev) (HTTP 200 on port 4220)

--- fully-configured S3Storage, no escape hatch (production shape) (expect: boots, HTTP 200) ---
PASS: fully-configured S3Storage, no escape hatch (production shape) (HTTP 200 on port 4221)

All storage-guard checks passed.
```

The fifth scenario used fake bucket/CDN/credential values (`fake-bucket`,
`FAKEKEY`, ...) — the guard only validates that the *fields are present*,
not that they resolve against a real GCS bucket, since `S3Storage`'s own
`validate()` is a `zod` schema check with no network call, and this story
has no GCP resources to test against for real. That means the guard cannot
false-positive on a well-formed-but-wrong credential (a real credential
issue would surface later, at first upload, not at boot) — but it also
means a correctly-configured tenant with all five fields present will
always clear the guard, regardless of whether those values are actually
valid. Worth being explicit about that boundary: this guard catches
*missing* config, not *wrong* config.

### New risk introduced by this guard, stated plainly

A guard that blocks a correctly-configured tenant is its own incident — in
the wrong direction, a false positive here means a legitimate deploy never
boots. The two ways that could happen with this implementation:

1. **A future non-`S3Storage` non-local adapter.** The specific
   required-field check only runs for `storage__active=S3Storage`; any
   other adapter name that doesn't match `Local*Storage` sails through with
   no field validation at all (silently permissive, not silently
   blocking — the safer failure direction, but still worth flagging: if the
   platform ever adopts a second non-local adapter, its required fields
   need the same explicit check added here, or misconfiguration of *that*
   adapter goes uncaught).
2. **The `Local*Storage` glob.** If Ghost ever ships a *non-local* adapter
   whose class name happens to match `Local*Storage` (unlikely, but not
   impossible), the guard would incorrectly block it. Given Ghost's own
   naming convention — every actual local-disk adapter is named exactly
   this way — this is a low-probability, easy-to-notice-and-fix failure
   (the FATAL message names the exact adapter class it rejected), not a
   silent one.

Neither risk is symmetrical with the one this guard fixes: both failure
modes here are loud (a deploy that doesn't boot, with a clear log message)
rather than silent (media quietly disappearing weeks later). That
asymmetry is deliberate — a loud failure that wastes a few minutes of a
deploy is a much smaller problem than the one being guarded against.

## What Ghost still writes to local disk (and why it's safe)

Cloud Run gives the container no *durable* local disk, but the container
filesystem itself is writable for the lifetime of a single instance. Two
things Ghost writes locally are genuinely ephemeral-safe — neither needs to
survive a restart:

- **Upload staging**: `ghost/core/core/server/web/api/middleware/upload.js`
  stages incoming file uploads via `multer({dest: os.tmpdir()})` before
  handing them to the active storage adapter's `save()`. `S3Storage.save()`
  reads that temp file and uploads it to GCS — the temp file only needs to
  survive the single request it belongs to.
- **Content-directory reseeding**: the upstream
  `docker-entrypoint.sh` copies `content.orig` (bundled default theme,
  fixtures) into `$GHOST_CONTENT` on every boot if that path is empty —
  which on Cloud Run it always will be, since there's no volume. This is
  by design: it's how the container gets a working default theme every
  single time, not a sign of data loss.

Nothing else Ghost writes locally is safe to lose — which is exactly why
the database and media adapters are both externalized via the env vars
above.

## Repo scaffold

- `Dockerfile` — the tenant image.
- `docker-entrypoint.branchleft.sh` — Cloud Run `$PORT` wrapper around the
  upstream entrypoint, plus the fail-closed storage guard.
- `scripts/smoke-test.sh` — local/CI smoke test (see above).
- `scripts/test-storage-guard.sh` — regression test for the storage guard
  (see "Fail-closed storage guard" above).
- `.github/workflows/build.yml` — builds the image and runs both scripts
  on every PR. **Does not push anywhere and does not authenticate to
  GCP** — there's no Workload Identity Federation set up for this repo yet;
  registry push and provisioning are later stories.
- `LICENSE` — MIT.

## License

MIT — see [`LICENSE`](./LICENSE).
