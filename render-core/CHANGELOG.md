# Changelog

All notable changes to `@branchleft/ghost-platform-render-core` are recorded here.

## Unreleased

**The mail spool can serve the outcomes route.**

- **Additive:** `MailSpoolStackArgs` takes an optional `drainOutcomes`. When
  `true`, `renderMailSpoolStack()` renders `SHIM_DRAIN_OUTCOMES: 'true'` in the
  spool service's `environment:`, straight after `SHIM_DRAIN_HOST`, so the
  shim registers `POST /drain/outcomes` and the collector's dropped-recipient
  reports stop answering 404. Absent or `false`, every spool file is
  byte-identical to 0.4.0 (pinned against the committed demo1 golden).
  `mailSpoolNeedsDrainOutcomes(mails)` is true when any of the host's `mail`
  specs has a `sweego` route. A non-boolean `drainOutcomes` is refused.
- `assertSpoolPosture(document, drainPort, expectOutcomes?)` refuses
  `SHIM_DRAIN_OUTCOMES` as anything but the string `true` (not `True`, `1`, a
  YAML boolean or an empty string) and, when `expectOutcomes` is given, a file
  that disagrees with it. New exports `MAIL_SPOOL_DRAIN_OUTCOMES_KEY`,
  `MAIL_SPOOL_DRAIN_OUTCOMES_VALUE` and `mailSpoolNeedsDrainOutcomes`. See
  src/spool.md#the-outcomes-route.
- **Rollout:** a consumer on an earlier release renders no such key; a host with
  a Sweego tenant needs this release and a call that passes
  `mailSpoolNeedsDrainOutcomes`. No `render()` artefact changes.

## 0.4.0

**The descriptor can name a mail route.**

- **Additive:** `mail.route` is an optional
  `{ primary: "mx1" | "sweego", sweegoAllowance?: integer }`.
  Absent means `mx1`, so every existing descriptor and every rendered
  artefact is unchanged. Any other value, a missing `primary` or an extra key
  is refused, and a demo whose route is `sweego` is refused as a tier
  mismatch. `sweegoAllowance`, the tenant's messages per UTC month through
  Sweego, is a positive integer required when `primary` is `sweego` and
  refused when it is `mx1`. The new types `MailRoute` and `MailRouteSpec` and
  the values `MAIL_ROUTES`, `MAX_SWEEGO_ALLOWANCE`, `DEFAULT_MAIL_ROUTE` and
  `mailRouteOf` are exported. A consumer pinned to an earlier release refuses
  a descriptor that carries one (an unknown key), so write the field only
  once that consumer is upgraded. See src/mail.md#mail-route.

**`render()` can render one running colour.**

- **Additive:** `render(descriptor, zones, themeCsp, { activeColour })` and
  `renderComposeStack({ ..., activeColour })` take an optional `'a'` or `'b'`.
  When given, `compose.yml` carries only that colour's Ghost service and the
  idle colour is omitted. When absent, every artefact is byte-identical to
  0.3.0. A value other than `'a'` or `'b'` is refused. The new type `Colour`
  and interface `RenderOptions` are exported. See
  src/compose.md#one-running-colour.

## 0.3.0

**Each Ghost container gets a 60 second stop grace period.**

- **Changed output:** every rendered `compose.yml` gains
  `stop_grace_period: '60s'` on both `ghost-a` and `ghost-b`, from the new
  constant `GHOST_STOP_GRACE_PERIOD`, so a stop no longer SIGKILLs Ghost after
  Docker's 10 second default in the middle of a send batch. A demo, a paying
  tenant and tenant zero all gain it. The mail spool is not a Ghost service
  and is unchanged. The value is provisional, pending a measured batch.
- `assertRuntimePosture()` refuses a Ghost service with no whole-seconds
  `stop_grace_period`, so dropping the line fails the render. See
  src/compose.md#the-stop-grace-period.

**The mail spool's drain listener binds one fixed address, never every interface.**

- **Changed output:** `renderMailSpoolStack()` renders `SHIM_DRAIN_HOST:
  '10.231.200.2'` in the spool's `environment:`. The drain network gains
  `ipam: {config: [{subnet: '10.231.200.0/29', gateway: '10.231.200.1'}]}`. The
  service's `networks:` changes from a list to a map: the drain network carries
  `ipv4_address: '10.231.200.2'`, and each tenant network carries
  `aliases: ['mail-spool']`. The image line, the ports and every other key are
  unchanged.
- New exports `MAIL_SPOOL_DRAIN_SUBNET`, `MAIL_SPOOL_DRAIN_GATEWAY` and
  `MAIL_SPOOL_DRAIN_ADDRESS`. `assertSpoolPosture()` now also refuses a drain
  port with no host, a wildcard host, any host but the fixed address, an ipam
  pool other than the fixed one, and an `ipv4_address` that differs from the host.
- **Rollout:** move the rendered file and the mailgun-shim image digest together,
  in one gated apply. A shim image built from at least ghost-platform 09a9f61
  refuses to start from a file with no `SHIM_DRAIN_HOST`; an older image ignores
  the host and keeps listening on every interface. Re-rendering with this
  release against the old pinned image is safe but fixes nothing. A deployed
  drain network was created without a fixed pool, so the gated apply has to
  recreate it; that step is not exercised by this change. See
  src/spool.md#the-drain-port.

**A demo slot cannot connect a real Stripe account.**

- **Changed output:** a demo's `environment:` gains
  `hostSettings__limits__limitStripeConnect__disabled: true`, in both colours.
  A paying tenant's output, and tenant zero's, are unchanged.
  `tenantEnvironment()`'s descriptor argument must now carry `kind`.
- **Rollout:** the key is only partial protection without the Ghost image's
  Stripe overlay, and the overlay is inert without the key. Promote the
  rebuilt Ghost image to the demo host first; only then publish this release
  and roll the broker onto it. Never render the key onto an image that lacks
  the overlay. Existing slots pick the key up when re-rendered and recreated.
  See src/environment.md#stripe-connect-limit.

**Each demo slot authenticates to the mail spool as its own credential domain.**

- **Changed output:** a demo's `mail__options__auth__user` and
  `bulkEmail__mailgun__domain` change from the shared `<demoMailDomain>` to
  `slot-<uid>.<demoMailDomain>`. `mail__from`, `members_support_address` and DKIM
  are unchanged. A paying tenant's output is unchanged.
- New export `credentialDomainOf(identity, zones, uid)`. `tenantEnvironment()`'s
  descriptor argument must now carry `uid`.
- **Rollout:** a slot rendered with the new username before its spool row exists
  gets 401 on every send. Before deploying a package carrying this change to a
  demo host, register one row per slot with the shim CLI
  (`register slot-<uid>.<demoMailDomain> --sender-domain <demoMailDomain>`) and
  write each printed key into that slot's `/etc/branchleft/<slug>.env` as
  `GHOST_BULK_EMAIL_API_KEY`. Remove the old shared `<demoMailDomain>` row
  afterwards. See src/mail.md#credential-domain.

**A registered tenant name is taken only by its own repository.**

- **Breaking: `validate()` and `validateTenantStack()` refuse a registered
  tenant name unless the caller says it runs in that name's repository.** They
  take a new third argument, `options.claimantRepo`; omitted, tenant zero's
  slug (`blog`) is refused for a tenant descriptor, and a demo descriptor is
  refused it always. A caller that validates tenant zero must pass
  `{ claimantRepo: 'branchLeft/ghost-tenant-blog' }`. An unregistered slug is
  unaffected, and `render()` has no caller identity so it is unchanged.
- `validateSlugAvailability(slug, claimant?)` takes the same check as an
  optional second argument; without one, behaviour is as before.
- New exports `TENANT_NAME_REGISTER`, `RegisteredName`, `SlugClaimant` and
  `ValidateOptions`. `RESERVED_STACK_NAMES` is now derived from the register's
  infrastructure entries, with the same six names as before. The block in
  `naming.ts` is generated by `scripts/sync-tenant-name-register.py` from
  `registers/tenant-names.json`; do not edit it by hand.

**A paying tenant's scanner health export is switched on, into a volume of its own.**

- **Changed output:** a paying tenant's environment gains six keys:
  `storage__<feature>__metricsTextfilePath` (`/var/lib/ghost/metrics/scanner.prom`)
  and `storage__<feature>__metricsTenant` (the slug), for each of `images`,
  `media` and `files`. A demo gains none.
- **Changed output:** a paying tenant's `compose.yml` gains the service volume
  `ghost-<slug>-metrics:/var/lib/ghost/metrics` (read-write) on both `ghost-a`
  and `ghost-b`, and declares that volume `external: true`. A demo gains neither.
- **Changed output:** the `provision.sh` comment of a paying tenant says "three
  named volumes" instead of "two". The command line is unchanged.
- New export `metricsVolumeName(slug)` (`ghost-<slug>-metrics`).
- **Rollout:** the volume is `external`, so a host without it cannot start the
  stack. Before a package carrying this change is deployed to a host, re-run
  `app/provision/provision_tenant_volume.py` for each existing tenant on it
  (idempotent; it creates only the missing volume). The tenant image must carry
  the adapter's unique temporary-name write with or before that deploy, because
  both colours write into this one directory.

**The Network tab is hidden on every tenant.**

- **Changed output:** every rendered `compose.yml` gains
  `hostSettings__limits__limitSocialWeb__disabled: true`, which locks Ghost's
  ActivityPub setting.
- **Changed output:** `ghost-settings.json` gains `social_web: false`, and
  `GhostSettings` gains the `social_web` field.

**Changed output:** a `queue`-transport tenant or demo with mail enabled gains
three Ghost mail environment keys (`mail__options__connectionTimeout`,
`mail__options__greetingTimeout`, `mail__options__socketTimeout`; 5000, 5000
and 10000 milliseconds), so a silent mail spool fails a reader's request in
seconds instead of minutes. `smtp` transport output is unchanged.

**The mail spool serves `/drain` on its own listener, not the one tenants reach.**

- **Changed output:** the spool service's environment gains
  `SHIM_DRAIN_PORT: 8081` beside `PORT: 8080`, and its published port is
  `127.0.0.1:<drainPort>:8081` instead of `127.0.0.1:<drainPort>:8080`.
- New export `MAIL_SPOOL_DRAIN_CONTAINER_PORT` (8081).
- `assertSpoolPosture` refuses a spool whose `PORT` is not 8080 or whose
  `SHIM_DRAIN_PORT` is not 8081, so `/drain` can never stay on the
  tenant-facing listener. The digest-pin rule is unchanged.
- Needs a mailgun-shim image that reads `SHIM_DRAIN_PORT`; pin one built from
  `12e983d` or later.

## 0.2.0

**A paying tenant's owner address reaches the host only through the secrets
file, never through a descriptor a tenant repository commits.**

- New `TenantStackDescriptor`: `TenantDescriptor` without `ownerEmail`. It is
  what a paying tenant's repository commits and the Pulumi component takes.
- New `validateTenantStack(descriptor, zones)`: `validate()` for that shape.
  It refuses a descriptor that still carries `ownerEmail`, without echoing
  the value, and refuses any kind but `tenant`.
- New `validateOwnerEmailSecret(value)`: the address's shape check for a
  value that arrives as a secret. A refusal names the key and withholds the
  value, because a deploy log prints it in plain text.
- **Changed output:** `SECRET_ENV_KEYS` gains `ownerEmail`
  (`GHOST_OWNER_EMAIL`), and a `tenant`-kind `secrets.env` template names it
  last. Compose never references it, so it stays in the root-only secrets
  file and never reaches a container. A demo's template is unchanged.
- `render()` and `renderSecretsTemplate()` take a `TenantStackDescriptor`. A
  full `TenantDescriptor` is still accepted, and renders identically.
- `validate()` and `TenantDescriptor` are unchanged. A demo keeps its owner
  address inline, held by the broker.
- A sentinel test checks that no artefact of any kind contains the owner
  address.

## 0.1.1

**`blog`, tenant zero's own slug, is no longer a reserved stack name, so the
live blog's descriptor validates and renders.**

- `RESERVED_STACK_NAMES` no longer contains `blog`. 0.1.0 reserved it, so
  `validate()` and `render()` refused the live blog's slug, which
  `infra/tenant/naming.md` says must stay unreserved. No other name changed:
  `website`, `edge`, `db`, `monitoring`, `nextcloud1` and `mail-spool` are
  still refused.
- The list is pinned by a test to `infra/tenant`'s own list plus `mail-spool`.

## 0.1.0

First release: the tenant descriptor, its validation and the renderers.
