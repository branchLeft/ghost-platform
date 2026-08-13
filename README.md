# ghost-platform

The reusable pieces of branchLeft's multi-tenant Ghost hosting platform: the
tenant container image, and the Pulumi infrastructure that runs it.

Ghost runs one site per process, so "multi-tenant" here means one container
per tenant on shared compute — not one process serving many sites. Tenants
share a Cloud SQL instance, a media bucket and an image registry; each gets
its own database, service account, storage prefix and Cloud Run service.

Nothing in this repo names a tenant. A tenant's identity lives in its own
private repo, generated from
[`ghost-platform-tenant-template`](https://github.com/branchLeft/ghost-platform-tenant-template).

## What's here

**`infra/tenant/`** — the `GhostTenant` Pulumi component, published as
`@branchleft/ghost-platform-tenant`. One instance is one tenant: a dedicated
service account, a logical database and DB user, prefix-scoped storage
write-isolation, and a Cloud Run service.

**`infra/platform/`** — the shared platform stack, applied by CI on every
push to `main`: the Cloud SQL instance, the media bucket, the tenant image's
Artifact Registry repository, and the CI deployer identity. See
[`infra/README.md`](infra/README.md) for why these are split by shape (stack
vs. component), and
[`infra/platform/RUNBOOK-bootstrap.md`](infra/platform/RUNBOOK-bootstrap.md)
for the one-time bootstrap that has to happen before CI can take over.

**`Dockerfile` + `docker-entrypoint.branchleft.sh`** — the tenant image.
Built on the official `ghost` image, pinned by tag *and* digest, with no
tenant-specific configuration baked in. Every tenant runs the same image;
everything that differs arrives as environment variables.

## Install

```sh
# One-time: point the @branchleft scope at GitHub Packages and provide a
# token with `read:packages` scope in your user-level ~/.npmrc:
#   @branchleft:registry=https://npm.pkg.github.com
#   //npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT

npm install @branchleft/ghost-platform-tenant
```

## Usage

```ts
import * as pulumi from '@pulumi/pulumi';
import { GhostTenant } from '@branchleft/ghost-platform-tenant';

// The component takes the platform stack's outputs as plain args rather
// than resolving a StackReference itself, so the caller decides where they
// come from.
const platform = new pulumi.StackReference('organization/branchleft-ghost-platform/platform');

const tenant = new GhostTenant('example-news', {
  tenantName: 'example-news',
  siteUrl: 'https://news.example.org',
  imageDigestOrTag: 'sha256:...',
  platform: {
    dbInstanceConnectionName: platform.requireOutput('dbInstanceConnectionName'),
    tenantImageRepositoryDockerPath: platform.requireOutput('tenantImageRepositoryDockerPath'),
    mediaBucketUrl: platform.requireOutput('mediaBucketUrl'),
  },
});

export const url = tenant.cloudRunServiceUri;
```

`tenantName` must start with a lowercase letter and contain only lowercase
letters, digits and hyphens, and is capped at 17 characters — it has to fit
inside GCP's 30-character service-account-ID limit alongside the
`ghost-tenant-` prefix the component adds. It also derives the logical
database and DB-user names (hyphens folded to underscores), the storage
prefix and the Cloud Run service name, so it is validated at construction
time rather than at apply time.

Optional: `region` (defaults to the platform region), `maxInstanceCount`,
`maxUserConnections`.

## Building and running the image

```sh
docker build -t ghost-platform:local .
./scripts/smoke-test.sh ghost-platform:local
```

The base image is pinned by tag and digest, not a floating `6`/`6-alpine`
tag — re-pin deliberately on any bump; the `Dockerfile` comment explains
why.

The smoke test boots the image against SQLite (local only — production
tenants use Cloud SQL MySQL, and SQLite has no place on Cloud Run, which
has no durable disk) on port 4200 rather than Ghost's default 2368, which
is what demonstrates the image honours `$PORT`. It waits for a strict
HTTP-200 response rather than a TCP connect: Ghost holds the port open
while it runs migrations, so a connect check passes long before the site
actually serves.

## Environment variables

All configuration reaches Ghost through `nconf`, which reads `process.env`
directly using `__` as the nesting separator and **no prefix**. None of
these are baked into the image; every tenant's container gets the same
image with a different environment.

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
| `database__connection__host` **or** `database__connection__socketPath` | **Exactly one required** (MySQL) | Deploy config | **Not interchangeable — pick the one matching how this tenant reaches Cloud SQL, never both.** `host` is a TCP hostname/IP (e.g. a private-IP/VPC-connector path, not used by `GhostTenant` today). `socketPath` is a Unix domain socket path (`/cloudsql/PROJECT:REGION:INSTANCE`, what `GhostTenant`'s Cloud Run service uses, paired with a `cloudSqlInstance` volume mount at `/cloudsql`). Ghost passes `database.connection` straight into `knex()`/mysql2 unmodified, and mysql2 treats `host` as a TCP hostname to resolve via DNS unless it is literally `'localhost'` — so a Cloud SQL connection-name-shaped string set as `host` fails with `ENOTFOUND` rather than opening the socket. |
| `database__connection__user` | **Required** (MySQL) | **Secret Manager** | One dedicated DB user per tenant. |
| `database__connection__password` | **Required** (MySQL) | **Secret Manager** | Per-tenant DB password. |
| `database__connection__database` | **Required** (MySQL) | Deploy config | Per-tenant logical database name on the shared instance. |
| `database__connection__filename` | Required (SQLite only) | Deploy config | Local/smoke-test only — a path under the (ephemeral) content dir, e.g. `/var/lib/ghost/content/data/ghost.db`. Never used against production. |

### Required — object storage (GCS via the S3-compatible XML API)

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `storage__active` | **Required** in production, **enforced at boot** | Deploy config | `S3Storage`. The entrypoint refuses to start Ghost's server process if this is unset or names a `Local*Storage` adapter — see "Fail-closed storage guard" below. A misconfigured tenant fails to boot instead of silently serving on local disk. |
| `storage__S3Storage__bucket` | **Required** | Deploy config | The shared platform bucket — one bucket, tenant-prefixed paths, not one bucket per tenant. |
| `storage__S3Storage__staticFileURLPrefix` | **Required** | Deploy config | Key prefix under the bucket, e.g. `content/images`. |
| `storage__S3Storage__cdnUrl` | **Required** | Deploy config | Public base URL files are served from, e.g. a CDN in front of the bucket, or `https://storage.googleapis.com/<bucket>` directly. |
| `storage__S3Storage__multipartUploadThresholdBytes` | **Required** | Deploy config | Platform-wide constant, not per-tenant. Recommend `10485760` (10 MiB). |
| `storage__S3Storage__multipartChunkSizeBytes` | **Required** | Deploy config | Platform-wide constant. Must be ≥ 5 MiB (`5242880`) — S3Storage enforces this floor itself (GCS's own multipart minimum). |
| `storage__S3Storage__endpoint` | **Required** for GCS | Deploy config | `https://storage.googleapis.com`. |
| `storage__S3Storage__region` | Required by the AWS SDK client, functionally unused by GCS | Deploy config | The client requires *some* region string even though GCS's XML API does not use it meaningfully. |
| `storage__S3Storage__forcePathStyle` | Recommended `true` for GCS | Deploy config | Per GCS's published S3-interoperability guidance. |
| `storage__S3Storage__tenantPrefix` | Optional | Deploy config | Per-tenant prefix within the shared bucket. |
| `storage__S3Storage__accessKeyId` | **Required** in production | **Secret Manager** | Per-tenant GCS HMAC key. |
| `storage__S3Storage__secretAccessKey` | **Required** in production | **Secret Manager** | Per-tenant GCS HMAC secret. |

### Optional — recommended platform-wide defaults

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `privacy__useUpdateCheck` | Optional | Deploy config | Recommend `false`. Ghost pings `explore.ghost.org` on boot by default — worth a deliberate opt-out given the platform's tenants are public-interest news outlets. Not baked into the image, since that is a policy call for the platform operator. |
| `logging__transports` | Optional | Deploy config | The upstream image bakes in `["file", "stdout"]`. File logs are lost on every Cloud Run restart (ephemeral disk) — not a correctness problem, but consider overriding to `'["stdout"]'` so Cloud Logging is the only sink that matters. |
| `mail__transport`, `mail__options__*`, `mail__from` | Optional | Deploy config, except `mail__options__auth__pass` (**Secret Manager**) | Wired by `GhostTenant`'s optional `mail` arg -- SMTP host/port/user/from as deploy config, the password via a per-tenant Secret Manager secret, mirroring `database__connection__password`. Omitted entirely (not even `mail__transport`) when `mail` isn't passed; the image boots and serves fine with the upstream `Direct` transport default in that case. |
| `bulkEmail__mailgun__baseUrl` | Optional | Deploy config | Wired by `GhostTenant`'s optional `bulkEmail` arg -- the platform's Mailgun-shim base URL. **All-or-nothing with the other two `bulkEmail__mailgun__*` vars below**: Ghost treats the mere presence of the `bulkEmail.mailgun` config object as "configured" and crashes with `new URL(undefined)` on a partial set, so `GhostTenant` emits all three or none. |
| `bulkEmail__mailgun__domain` | Optional (all-or-nothing, see above) | Deploy config | The shim-side tenant identifier -- not necessarily this tenant's site hostname. |
| `bulkEmail__mailgun__apiKey` | Optional (all-or-nothing, see above) | **Secret Manager** | Per-tenant shim API key, mirroring `mail__options__auth__pass`. Never a plain env value. |

## Fail-closed storage guard

Ghost's compiled defaults set `storage.active` to a local-disk adapter. If a
tenant's deploy config simply omits `storage__active`, nothing fails
loudly: the container boots, the site serves, an editor's upload appears to
succeed, and the file is gone the next time the Cloud Run instance recycles
— no error, no log line, no alert. That failure mode presents as success,
which is why it is enforced in the image rather than documented here.

`docker-entrypoint.branchleft.sh` exits 1 before Ghost's server process ever
starts when:

- `storage__active` is unset, or
- `storage__active` matches `Local*Storage` (catching every local adapter
  Ghost ships, and staying correct if another appears), or
- `storage__active=S3Storage` but any field a working upload needs is
  missing (`bucket`, `staticFileURLPrefix`, `cdnUrl`,
  `multipartUploadThresholdBytes`, `multipartChunkSizeBytes`) — a non-local
  adapter with no bucket just moves the silent failure from "lost on
  recycle" to "never uploaded".

The guard catches *missing* config, not *wrong* config: syntactically
present but invalid values clear it.

**Escape hatch, local development and the smoke tests only:**
`BRANCHLEFT_ALLOW_LOCAL_STORAGE=true`. Deliberately an explicit variable
rather than anything inferred from `NODE_ENV` or the presence of Cloud Run's
`K_SERVICE` — detecting "not Cloud Run" is not evidence a deploy is safe,
and a heuristic would eventually be wrong in the one direction that matters.

It only runs for the actual server-start command, mirroring the check the
upstream entrypoint uses for its own work, so `docker run <image> sh` is not
blocked.

Both ways this guard can be wrong — a future non-`S3Storage` adapter
sailing through unvalidated, or a non-local adapter whose name happens to
match `Local*Storage` being blocked — fail loudly, with the rejected adapter
class named in the message. That asymmetry against the silent failure it
prevents is the point.

`scripts/test-storage-guard.sh` is the regression test: five scenarios
against a real build, three that must be blocked and two that must boot.

```sh
docker build -t ghost-platform:local .
./scripts/test-storage-guard.sh ghost-platform:local
```

## What Ghost still writes to local disk (and why it is safe)

Cloud Run gives the container no *durable* disk, but the container
filesystem is writable for the lifetime of an instance. Two things Ghost
writes locally are genuinely ephemeral-safe:

- **Upload staging** — incoming uploads are staged via
  `multer({dest: os.tmpdir()})` before being handed to the active storage
  adapter's `save()`. `S3Storage.save()` reads that temp file and uploads
  it; the file only needs to survive its own request.
- **Content-directory reseeding** — the upstream entrypoint copies
  `content.orig` (default theme, fixtures) into `$GHOST_CONTENT` on every
  boot if that path is empty, which on Cloud Run it always is. That is how
  the container gets a working theme every time, not a sign of data loss.

Nothing else Ghost writes locally is safe to lose, which is why the database
and media adapters are both externalised via the variables above.

## License

MIT — see [`LICENSE`](./LICENSE).
