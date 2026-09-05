# Changelog

All notable changes to `@branchleft/ghost-platform-tenant` are recorded here.

## 4.0.0

**Every tenant's healthcheck followed Ghost's HTTPS redirect and could never
pass, so every tenant deploy reported failure for a tenant that was serving.**
Observed on the first Hetzner-native tenant: Ghost booted in 20.3s and answered
the public hostname with 200, while `docker ps` held the container `unhealthy`
indefinitely and `branchleft-compose@<slug>` — whose `ExecStart` is
`docker compose up -d --wait` — failed the deploy job with it.

- The probe now sends `X-Forwarded-Proto: https`. Ghost's
  `getFrontendRedirectUrl` 301s any request where the configured `url` is
  HTTPS and `req.secure` is false, and its only case is that one — there is no
  host check. Express derives `req.secure` from the header, and Ghost's
  `shared/express.js` trusts a loopback peer on both branches of its config
  test (`usingLoopbackReverseProxy` defaults false, so the app enables
  trust-all; the other branch is `'loopback'`). This is the header the edge
  proxy sets on every real request, so the probe now takes the path production
  traffic takes rather than one picked for not redirecting.
- **The redirect target was local, not remote.** Ghost redirects to
  `https://<requested host>`, which for a loopback probe is
  `https://127.0.0.1:2368` — TLS against a plaintext port. The probe therefore
  failed on every app host regardless of egress policy, rather than only on one
  with restricted egress.
- **Breaking: `assertRuntimePosture` refuses documents it previously
  accepted** — a service whose healthcheck is absent, empty, `[NONE]`, or
  malformed, and a `ghost` service whose probe does not bind that header to
  `--header`. A probe that cannot pass is worse than no probe: `--wait` fails
  on it, so the deploy signal stops carrying information. Nothing asserted the
  probe at all before this, which is why one that could never pass shipped and
  reached a host.

  Called breaking on this repo's own precedent, where 3.0.0 was labelled so for
  a break that stayed dormant until a pin moved. The blast radius here is
  nil: `GhostTenant` and `renderComposeStack` both render a conforming probe,
  and neither consumer calls `assertRuntimePosture` on a document of its own.
- The check reads all four shapes Compose accepts for `test` — a bare string
  (implicit `CMD-SHELL`), `CMD`, `CMD-SHELL`, and `[NONE]`. A check reading
  only the `CMD` array rejects a stack Docker would run perfectly, which is a
  worse failure than the one it guards against.
- It checks the *binding*, not the presence, of the header. `['CMD', 'wget',
  '-U', 'X-Forwarded-Proto: https', url]` sends the value as the user agent and
  Ghost redirects exactly as before; a membership test on the argv certifies
  that as fixed. In the shell forms the value must additionally be quoted,
  because unquoted the shell splits it into `--header`, `X-Forwarded-Proto:`
  and a bare `https` the client reads as a URL.
- The header requirement applies to the `ghost` service alone. A future sidecar
  still has to declare a probe that works; it must not have to carry this one.
- Nothing in this release changes a running tenant. The rendered `compose.yml`
  is written to the app host by an operator (`RUNBOOK-tenant-onboarding.md`
  §8c), so a tenant keeps its old probe until that file is re-placed from
  `pulumi stack output composeFile` and its stack restarted.

## 3.0.0

**Breaking: `GhostTenant` registered no inputs (`{}`), so the delete guard's
identity comparison matched no step in any plan.** `identity_changes()` in
`scripts/assert-no-tenant-deletes.py` reads a tenant's `uid`, `stackName`,
`contentVolume`, `adaptersVolume`, `databaseName` and `appHostPrivateIp` from
the component's own state, but a `ComponentResource` with unchanged registered
inputs produces no step at all for a preview to compare — so a changed `uid`
or `appHostPrivateIp` reached `pulumi up` as a clean `update` with a green
guard, and the container started as a user that could not read its own
`0700` content volume. Reproduced locally against the published `2.0.0`
before fixing it, not assumed from the report.

- The component now passes its identity fields as its actual registered props
  to `super(...)`, so a change to any of them surfaces as a real `update` step
  and `identity_changes()` has something to compare.
- The guard refuses a plan carrying no step at all for the component
  (`component_is_present()`), rather than treating "nothing to compare" the
  same as "nothing changed" — those were previously indistinguishable, which
  is exactly how the original defect passed silently.
- **This breaks every existing caller's CI, not just on upgrade but the first
  time it previews any change that does not touch an identity field** (media
  config, mail config, `siteUrl`, resource caps, an image digest bump — most
  real tenant changes). `component_is_present()` needs the preview captured
  with `pulumi preview --json --show-sames`: without that flag Pulumi omits a
  genuinely unchanged component from `steps` entirely, indistinguishable from
  the original defect, and the new check refuses the plan unconditionally.
  **branchLeft/workspace#290 tracks adding `--show-sames` to both current
  callers (`ghost-platform-tenant-template` and `ghost-tenant-blog`) and must
  land in both before either repo's pin moves to `3.0.0`.** Nothing is broken
  today — both pin an exact version and neither has Dependabot watching
  it — so this is dormant until the pin moves, which is exactly why the
  version says "breaking" rather than "safe to take."
- The guard's `identity_changes()` also failed closed in only one direction: a
  field present in the old identity but absent from the new one produced no
  finding at all. Not reachable from this version's `index.ts`, which
  registers every field unconditionally, but closed anyway as the same class
  of silent vacuity this release exists to eliminate.
- `verify_coverage()` (`--verify-coverage`) previously checked the
  `this.identity = pulumi.output({...})` *output* assignment, which a preview
  never reads to decide whether a step exists at all — a component with fully
  empty `super()` props and a fully-populated output block passed this check
  outright. It now reads the object actually passed to `super()`.
- The guard's self-test fixtures for the identity comparison are now trimmed
  from real `pulumi preview --json` captures against this component (taken
  against both the broken `2.0.0` behaviour and the fix), replacing shapes
  that had only ever been assumed.
- `validateTenantSlug`/`validateTenantUid` now run before `super()` rather
  than after, so an invalid slug or uid is never registered with the engine
  at all, not even transiently.
- **Operational note:** an existing tenant's next `pulumi up` after upgrading
  will show a one-time `update` step for the `GhostTenant` resource even with
  no configuration change, because its registered inputs go from `{}` to the
  identity object. This step itself is harmless (a `ComponentResource` has no
  provider to call, and the guard passes it cleanly since the underlying
  values are unchanged) — the break above is about every *subsequent*
  preview, not this one.

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
