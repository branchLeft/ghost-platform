# ghost-platform

Reusable, public-facing pieces of branchLeft's multi-tenant Ghost hosting
platform: the tenant container image (this repo, today), and eventually
Pulumi components, the base theme, and shared Handlebars partials.

This repo is engineered as if it were already public — no secrets, no
tenant names, no internal-only shorthand — even while it's still private.

## What's here today

One deliverable: **the tenant Ghost container image** — a `Dockerfile`
building on the official `ghost` image, pinned to an explicit version and
digest, with no tenant-specific configuration baked in. Every tenant runs
the *same* image; everything that differs between tenants (database
credentials, site URL, storage bucket prefix, ...) is supplied at deploy
time via environment variables. Provisioning that infrastructure (Pulumi,
Cloud SQL, GCS, Secret Manager, Artifact Registry) is a later story — this
repo does not touch GCP.

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
| `storage__active` | **Required** in production | Deploy config | `S3Storage`. Leaving this unset falls back to Ghost's default `LocalImagesStorage`/`LocalMediaStorage`/`LocalFilesStorage` — **local disk, which is a correctness bug on Cloud Run**, not just a suboptimal default. |
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
  upstream entrypoint.
- `scripts/smoke-test.sh` — local/CI smoke test (see above).
- `.github/workflows/build.yml` — builds the image and runs the smoke test
  on every PR. **Does not push anywhere and does not authenticate to
  GCP** — there's no Workload Identity Federation set up for this repo yet;
  registry push and provisioning are later stories.
- `LICENSE` — MIT.

## License

MIT — see [`LICENSE`](./LICENSE).
