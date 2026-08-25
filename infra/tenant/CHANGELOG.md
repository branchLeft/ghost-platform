# Changelog

All notable changes to `@branchleft/ghost-platform-tenant` are recorded here.

## 2.0.0

**Breaking: each tenant's media moves to its own Object Storage bucket, and the
component derives where that is instead of taking it as config.** This is
doc 14 §6 candidate (a), decided on 2026-08-25 (branchLeft/workspace#282), and
it replaces one shared bucket with a per-tenant key prefix.

- `GhostTenantMediaArgs` loses `bucket`, `publicBaseUrl` and `tenantPrefix`. It
  now takes `endpoint`, `region` and the key pair only. A caller passing any of
  the three removed fields does not compile.
- `mediaBucketName(slug)` and `mediaPublicBaseUrl(endpoint, slug)` are exported,
  and the component exposes `mediaBucket` and `mediaPublicBaseUrl` as readonly
  properties. Deriving rather than configuring is the isolation control: a value
  a stack can set is a value a stack can set to another tenant's bucket, and the
  bucket boundary is the only media isolation this platform has.
- `storage__S3Storage__tenantPrefix` is no longer emitted. Ghost treats the
  option as optional and stores keys unprefixed without it; a prefix inside a
  bucket holding one tenant's objects would only add a redundant segment to every
  published media URL.
- The endpoint is refused unless it is `https://` and a bare host. It is the stem
  of every media URL Ghost writes into a published post, so a wrong value there
  is not a config error to correct later.
- **The bucket, its versioning and its policy are still created by an operator.**
  Hetzner creates S3 credentials in its Cloud Console and not through any API, so
  nothing automated can mint one. `infra/provisioning/scripts/render-media-bucket-policy.py`
  renders the policy; `RUNBOOK-tenant-onboarding.md` §6 applies and verifies it.
  Media stays append-only by decision — `s3:DeleteObject` is withheld from the
  tenant's own key, which is what Ghost admin's 403 on media deletion is.

## 1.0.0

**Breaking: the component targets Hetzner app hosts and no longer touches
GCP.** `GhostTenant` renders one tenant's Compose stack, its Ghost environment
and its secrets file instead of creating a service account, a Cloud SQL
database and user, a GCS media prefix, Secret Manager secrets and a Cloud Run
service. Every input and output changed and `@pulumi/gcp` and `@pulumi/random`
are gone from the dependency set, so no 0.x caller compiles against this.

- The rendered stack carries the whole runtime-isolation floor with no
  per-tenant opt-out: a distinct non-root UID from a reserved range, a
  read-only rootfs with a sized `/tmp` tmpfs, `cap_drop: [ALL]`,
  `no-new-privileges`, `content/adapters` mounted read-only, PID/memory/CPU/
  descriptor caps, bounded `json-file` logging and publishing to the app
  host's private address alone. `assertRuntimePosture` re-reads the finished
  document, and the tests assert the absence of the Docker socket, `cap_add`,
  `privileged`, `seccomp=unconfined`, a `0.0.0.0` publish and host networking.
- One `uploadCeilingMib` input derives the tmpfs size, the three
  `theme__uploadLimits__*` values and the tenant's edge `request_body` limit,
  so the three limits that must agree cannot drift apart.
- Both volumes are declared `external`, which makes the host-side provisioning
  step (`app/provision/provision_tenant_volume.py`) a precondition that fails
  loudly instead of a step whose absence leaves the tenant on a volume Docker
  re-owned from the image. That script keeps its UID register in a root-owned
  directory on the host rather than in the tenant's own volume, because unlink
  permission follows the containing directory and a tenant can delete anything
  inside a directory it owns.
- `yaml.ts` refuses control characters outright. Quoting is not escaping: a
  single-quoted scalar has one escape and no faithful form for a newline, so a
  config value carrying one would have become document structure — past a
  posture check that runs before serialisation.
- The app host's address and the published host port are validated on their own
  terms, so `0.0.0.0` and a privileged port are refused at render time.
- Reserved stack names (`website`, `edge`, `db`, `monitoring`) are refused: a
  tenant slugged for one of them would land on top of that stack's directory,
  secrets file and systemd unit on the same host.
- `security__allowWebhookInternalIPs` is set explicitly rather than left to
  Ghost's default, so a release that changes the default is a diff here.
- Ships `scripts/assert-no-tenant-deletes.py` inside the package, beside the
  component it guards, rather than in the tenant repo that runs it.

## 0.4.0

- Added an optional `bulkEmail` arg on `GhostTenant`, injecting Ghost's
  Mailgun-compatible bulk-email config (`bulkEmail__mailgun__baseUrl`,
  `bulkEmail__mailgun__domain`, `bulkEmail__mailgun__apiKey`) so a tenant can
  point Ghost at the platform's mail shim. All-or-nothing: the three envs are
  emitted together or not at all. The API key is stored in Secret Manager,
  never a plain env value.

## 0.3.0

- Added an optional `mail` arg on `GhostTenant`, injecting Ghost's SMTP
  transactional-mail config (`mail__transport`, `mail__options__*`,
  `mail__from`). Omitted entirely when `mail` isn't passed. The SMTP
  password is stored in Secret Manager, never a plain env value.

## 0.2.0

- Fixed `GhostTenant`'s container image reference: a digest was joined with
  `:` instead of `@`, which the Cloud Run API rejects outright, so no
  published version before this one could deploy a digest-pinned tenant.
- Extracted every resource name `GhostTenant` derives from `tenantName` into
  `naming.ts`, with tests asserting the media-bucket tenant-isolation
  boundary (the trailing slash on a tenant's object prefix).

## 0.1.1

- Added the `license: MIT` field and a packaged `LICENSE` file; the registry
  had rendered `0.1.0` as Proprietary since the field was missing.

## 0.1.0

- Initial publish of the `GhostTenant` Pulumi component (per-tenant service
  account, Cloud SQL database and DB user, media-bucket storage isolation,
  scale-to-zero Cloud Run service) as `@branchleft/ghost-platform-tenant` on
  GitHub Packages.
