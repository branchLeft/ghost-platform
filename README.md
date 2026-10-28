# ghost-platform

The reusable pieces of branchLeft's multi-tenant Ghost hosting platform: the
tenant container image, and the Pulumi infrastructure that runs it.

Ghost runs one site per process, so "multi-tenant" here means one container
per tenant on shared compute — not one process serving many sites. Tenants
share an app host, a MySQL host and an object-storage account; each gets its
own Compose stack under its own UID, its own logical database and DB user, and
its own media bucket.

Nothing in this repo names a tenant. A tenant's identity lives in its own
repo — named `ghost-tenant-<name>`, generated from
[`ghost-platform-tenant-template`](https://github.com/branchLeft/ghost-platform-tenant-template),
and public unless that tenant asked for it to be private. That question is put
to the tenant before their onboarding starts, because a public repo and its
name disclose that they are a customer.

## What's here

**`infra/tenant/`** — the `GhostTenant` Pulumi component, published as
`@branchleft/ghost-platform-tenant`. One instance is one tenant: its Compose
stack on a shared app host, carrying the whole runtime-isolation posture, plus
the Ghost environment, the secrets file and the edge upload limit that go with
it. It declares no cloud resources — see
[`infra/tenant/README.md`](infra/tenant/README.md) for why, for the three
host-side steps it depends on, and for the media isolation the bucket policy
carries.

**`app/`** — the app hosts' own per-tenant step: creating a tenant's Docker
volumes owned by its reserved UID at `0700`, refusing a UID another tenant on
that host already holds. The one control in the tenant path whose absence is
invisible at runtime, which is why it is a named script rather than an
implication of the component.

**`db/`** — the shared MySQL 8 host's service layer: the Compose stack
deployed onto `db1` (created by `infra/hosts`), tenant DB provisioning, and
the encrypted nightly dump and binlog-shipping pipelines. See
[`db/README.md`](db/README.md) for why it sits beside `infra/` rather than
inside it, and [`db/RUNBOOK-db.md`](db/RUNBOOK-db.md) for deploy steps and
the restore drill.

**`RUNBOOK-bucket-fencing.md`** — applying and proving the bucket policy that
restricts an Object Storage bucket to the keys that legitimately use it. Every
Hetzner key pair is valid for every bucket in its own project by default, so a
bucket policy is the whole of that boundary — and it is the one control that
governs the API call that would edit it, which is why the runbook opens on how
to recover from a bucket it locks.

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

pnpm add @branchleft/ghost-platform-tenant
```

## Usage

```ts
import { GhostTenant } from '@branchleft/ghost-platform-tenant';

const config = new pulumi.Config();

const tenant = new GhostTenant('example-news', {
  slug: 'example-news',
  siteUrl: 'https://news.example.org',
  uid: 30001,
  appHostPrivateIp: '10.20.1.100',
  hostPort: 2369,
  database: {
    host: '10.20.1.20',
    password: config.requireSecret('databasePassword'),
  },
  // The bucket and the public base URL are not here: they are derived from
  // the slug, so no stack holds a value that could name another tenant's
  // bucket. This tenant's media is `branchleft-media-example-news`, served
  // from `https://hel1.your-objectstorage.com/branchleft-media-example-news`.
  media: {
    endpoint: 'https://hel1.your-objectstorage.com',
    region: 'hel1',
    accessKeyId: config.requireSecret('mediaAccessKeyId'),
    secretAccessKey: config.requireSecret('mediaSecretAccessKey'),
  },
});

export const composeFile = tenant.composeFile;
export const secretsEnvFile = tenant.secretsEnvFile;
export const provisionVolumes = tenant.hostProvisioningCommand;
```

`slug` must start with a lowercase letter and contain only lowercase letters,
digits and hyphens, and is capped at 26 characters so that `ghost_` plus the
slug fits MySQL's 32-character account-name limit. It is also the Compose
project name, the systemd instance name, the directory under
`/opt/branchleft`, the stem of both files under `/etc/branchleft` and both
volume names — so `website`, `edge`, `db`, `monitoring` and `nextcloud1` are
refused outright, and validation happens at construction rather than at
apply. (`RESERVED_STACK_NAMES` in `infra/tenant/naming.ts` is the source of
that list, with the trade-off it cannot cover — a live tenant's own slug —
recorded on the constant itself.)

`uid` is required rather than derived: it is host state, allocated against
what is already claimed on that host, and a value computed from the slug would
collide the first time two hosts disagreed about who lives where.

Optional: `uploadCeilingMib` (the one number every upload limit derives from),
`rssBudgetMib`, `resourceCaps`, `mail`, `bulkEmail`, `database.port` and
`database.maxUserConnections`.

## Building and running the image

```sh
docker build -t ghost-platform:local .
./scripts/smoke-test.sh ghost-platform:local
```

The base image is pinned by tag and digest, not a floating `6`/`6-alpine`
tag — re-pin deliberately on any bump; the `Dockerfile` comment explains
why.

The smoke test boots the image against SQLite (local only — production
tenants use MySQL, and SQLite has no place in production, where the
container has no durable disk) on port 4200 rather than Ghost's default 2368, which
is what demonstrates the image honours `$PORT`. It waits for a strict
HTTP-200 response rather than a TCP connect: Ghost holds the port open
while it runs migrations, so a connect check passes long before the site
actually serves.

## Environment variables

> The table below is the image's own reference. What a tenant actually receives
> is rendered by `render-core/src/environment.ts`, which is the authority.

All configuration reaches Ghost through `nconf`, which reads `process.env`
directly using `__` as the nesting separator and **no prefix**. None of
these are baked into the image; every tenant's container gets the same
image with a different environment.

### Platform-level (not an `nconf`/Ghost config key)

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `PORT` | Optional | Deploy platform, if it sets one | Consumed by `docker-entrypoint.branchleft.sh`, translated into `server__port`/`server__host`. Defaults to `2368` if unset (matching upstream Ghost's own default), bound to `0.0.0.0`. |
| `SERVER_HOST` | Optional | Deploy config | Escape hatch to override the bind address the wrapper sets; almost never needed — the container must bind `0.0.0.0`. |
| `BRANCHLEFT_ALLOW_LOCAL_STORAGE` | Optional, **local development and the smoke tests only** | Never set in a real deploy | The one way past the storage guard described below. Must be `true` exactly, set deliberately — see "Fail-closed storage guard". |

### Required — site

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `url` | **Required** | Deploy config (per-tenant, not secret) | Must include protocol, e.g. `https://news.example.org`. Ghost refuses to boot without a protocol-qualified URL. |

### Required — database (MySQL in production)

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `database__client` | **Required** | Deploy config | `mysql` in production (auto-aliased to the `mysql2` driver internally). `sqlite3` for local/smoke-test only. |
| `database__connection__host` | **Required** (MySQL) | Deploy config | TCP hostname or IP of the MySQL host on the private network, rendered by `GhostTenant`. Ghost passes `database.connection` straight into `knex()`/mysql2 unmodified, and mysql2 resolves `host` via DNS unless it is literally `'localhost'`, so a socket path or connection name cannot go here. |
| `database__connection__user` | **Required** (MySQL) | Deploy config | One dedicated DB user per tenant, named from the slug. |
| `database__connection__password` | **Required** (MySQL) | Secrets file (`/etc/branchleft/<slug>.env`) | Per-tenant DB password. |
| `database__connection__database` | **Required** (MySQL) | Deploy config | Per-tenant logical database name on the shared instance. |
| `database__connection__filename` | Required (SQLite only) | Deploy config | Local/smoke-test only — a path under the (ephemeral) content dir, e.g. `/var/lib/ghost/content/data/ghost.db`. Never used against production. |

### Required — object storage, wrapped by the scanning decorator

Configured per storage feature (`images`, `media`, `files` — Ghost's own
three separate storage adapters). The table below names `images`; the same
three keys apply identically under `storage__media__*` and
`storage__files__*` — see `adapters/scanning-storage/README.md` for the full
config surface (`quarantinePath`, `refuse`) and why the decorator, not the
adapter it wraps, is what every feature is configured with.

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `storage__images__adapter` | **Required** in production, **enforced at boot** | Deploy config | `ScanningStorageAdapter`. The entrypoint refuses to start Ghost's server process unless this names the decorator — see "Fail-closed storage guard" below. A misconfigured tenant fails to boot instead of silently serving unscanned, or on local disk. |
| `storage__images__wraps` | **Required** in production, **enforced at boot** | Deploy config | `S3Storage`. The adapter the decorator delegates to, resolved by name from the same directory Ghost's own adapter manager resolves any adapter from. |
| `storage__images__wrappedConfig__bucket` | **Required** | Deploy config | This tenant's own bucket, `branchleft-media-<slug>`. One bucket per tenant, fenced by a bucket policy allowlisting this tenant's key — not a prefix in a shared one. |
| `storage__images__wrappedConfig__staticFileURLPrefix` | **Required** | Deploy config | Key prefix under the bucket, e.g. `content/images` (`content/media`, `content/files` for the other two features — `S3Storage` does not infer this from the feature it serves). |
| `storage__images__wrappedConfig__cdnUrl` | **Required** | Deploy config | Public base URL files are served from, e.g. a CDN in front of the bucket, or `https://hel1.your-objectstorage.com/<bucket>` directly. |
| `storage__images__wrappedConfig__multipartUploadThresholdBytes` | **Required** | Deploy config | Platform-wide constant, not per-tenant. Recommend `10485760` (10 MiB). |
| `storage__images__wrappedConfig__multipartChunkSizeBytes` | **Required** | Deploy config | Platform-wide constant. Must be ≥ 5 MiB (`5242880`) — S3Storage enforces this floor itself (S3's own multipart minimum). |
| `storage__images__wrappedConfig__endpoint` | **Required** | Deploy config | The Object Storage endpoint, e.g. `https://hel1.your-objectstorage.com`. |
| `storage__images__wrappedConfig__region` | **Required** | Deploy config | On Hetzner this stops being cosmetic: against Ceph RGW the region is part of the SigV4 credential scope, so a wrong value is a signature mismatch surfacing as an opaque 403. It must name the bucket's own location. |
| `storage__images__wrappedConfig__forcePathStyle` | Set `true` | Deploy config | Path-style addressing against the storage host; the descriptor sets it. |
| `storage__images__wrappedConfig__accessKeyId` | **Required** in production | Secrets file (`/etc/branchleft/<slug>.env`) | Per-tenant Object Storage access key ID. |
| `storage__images__wrappedConfig__secretAccessKey` | **Required** in production | Secrets file (`/etc/branchleft/<slug>.env`) | Per-tenant Object Storage secret key. |
| `storage__images__quarantinePath` | **Required** in production, **enforced by the decorator's own constructor** | Deploy config | Always local disk, e.g. `/var/lib/ghost/content/quarantine` — never the served location, regardless of which adapter is wrapped. |

### Optional — recommended platform-wide defaults

| Variable | Required | Origin | Notes |
|---|---|---|---|
| `privacy__useUpdateCheck` | Optional | Deploy config | Recommend `false`. Ghost pings `explore.ghost.org` on boot by default — worth a deliberate opt-out given the platform's tenants are public-interest news outlets. Not baked into the image, since that is a policy call for the platform operator. |
| `logging__transports` | Optional | Deploy config | The upstream image bakes in `["file", "stdout"]`. The descriptor overrides this to `'["stdout"]'` so stdout is the only sink that matters: file logs are lost when the container is recreated. |
| `mail__transport`, `mail__options__*`, `mail__from` | Optional | Deploy config, except `mail__options__auth__pass` (secrets file) | Wired by `GhostTenant`'s optional `mail` arg -- SMTP host/port/user/from as deploy config, the password via the secrets file, mirroring `database__connection__password`. Omitted entirely (not even `mail__transport`) when `mail` isn't passed; the image boots and serves fine with the upstream `Direct` transport default in that case. |
| `bulkEmail__mailgun__baseUrl` | Optional | Deploy config | Wired by `GhostTenant`'s optional `bulkEmail` arg -- the platform's Mailgun-shim base URL. **All-or-nothing with the other two `bulkEmail__mailgun__*` vars below**: Ghost treats the mere presence of the `bulkEmail.mailgun` config object as "configured" and crashes with `new URL(undefined)` on a partial set, so `GhostTenant` emits all three or none. |
| `bulkEmail__mailgun__domain` | Optional (all-or-nothing, see above) | Deploy config | The shim-side tenant identifier -- not necessarily this tenant's site hostname. |
| `bulkEmail__mailgun__apiKey` | Optional (all-or-nothing, see above) | Secrets file | Per-tenant shim API key, mirroring `mail__options__auth__pass`. Never a plain env value. |

## Fail-closed storage guard

Ghost's compiled defaults set `storage.active` to a local-disk adapter. If a
tenant's deploy config simply omits `storage__images__adapter`, nothing
fails loudly: the container boots, the site serves, an editor's upload
appears to succeed, and the file is gone the next time the
container is recreated — no error, no log line, no alert. Naming a durable
adapter directly (`storage__images__adapter=S3Storage`, with no decorator)
fails the same way in a second, quieter direction: the container boots, the
upload survives, and it is never scanned — with every other check here
passing. Both failure modes present as success, which is why
they are enforced in the image rather than documented here.

`docker-entrypoint.branchleft.sh` checks the `images` feature only (Ghost's
first-boot user creation resolves `storage:images` specifically) and exits 1
before Ghost's server process ever starts when:

- `storage__images__adapter` is unset, or
- `storage__images__adapter` is anything other than `ScanningStorageAdapter`
  (catching a bare `S3Storage` and every bare local adapter alike — a bare
  adapter, durable or not, is unscanned), or
- `storage__images__wraps` is unset, or matches `Local*Storage` (catching
  every local adapter Ghost ships, and staying correct if another appears —
  the decorator does not make local disk durable), or
- `storage__images__wraps=S3Storage` but any field a working upload needs is
  missing (`storage__images__wrappedConfig__bucket`/`staticFileURLPrefix`/
  `cdnUrl`/`multipartUploadThresholdBytes`/`multipartChunkSizeBytes`) — a
  non-local adapter with no bucket just moves the silent failure from "lost
  on recycle" to "never uploaded".

The guard catches *missing* config, not *wrong* config: syntactically
present but invalid values clear it.

**Escape hatch, local development and the smoke tests only:**
`BRANCHLEFT_ALLOW_LOCAL_STORAGE=true`. Deliberately an explicit variable
rather than anything inferred from `NODE_ENV` or the presence of a platform-injected
variable — detecting "not on a platform" is not evidence a deploy is safe,
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

The container has no *durable* disk, but its
filesystem is writable for the lifetime of the container. Two things Ghost
writes locally are genuinely ephemeral-safe:

- **Upload staging** — incoming uploads are staged via
  `multer({dest: os.tmpdir()})` before being handed to the active storage
  adapter's `save()`. `S3Storage.save()` reads that temp file and uploads
  it; the file only needs to survive its own request.
- **Content-directory reseeding** — the upstream entrypoint copies
  `content.orig` (default theme, fixtures) into `$GHOST_CONTENT` on every
  boot if that path is empty, which on a fresh container it always is. That is how
  the container gets a working theme every time, not a sign of data loss.

Nothing else Ghost writes locally is safe to lose, which is why the database
and media adapters are both externalised via the variables above.

## License

Source-available under the PolyForm Shield License 1.0.0. See [LICENSE](LICENSE).
Third-party code under `widgets/dist/` keeps its own MIT licence; see
[widgets/dist/LICENSE](widgets/dist/LICENSE).
