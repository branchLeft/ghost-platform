# export-bundler

Calls Ghost's two existing admin exports -- content & settings, and post
analytics -- against a colour started on a tenant's own data with no route
pointed at it, and bundles the result into one archive, encrypted to the
tenant's own `age` recipient, plus a manifest.
Design: `ghost-platform-docs/19-try-it-now-design/08-portal.html` §08b.

`the portal does not build an exporter, it builds a bundler`: this package
owns starting the tenant's image drained, calling the two routes, and
stopping the image again. It does not close the four gaps §08b names
(media, members/subscriptions, comments, analytics beyond the CSV) -- those
are named in the manifest as gaps, not silently absent, and closing them is
a separate piece of work.

## An export is a support grant

An export runs inside a support grant (`05-gate-and-edge.html` §05), in
one of its two lanes:

- **consented** -- the tenant un-suspends the support account in their own
  Staff screen;
- **incident** -- the operator un-suspends it on the tenant host.

The grant is a person's action, before the bundler runs, and so is the
re-suspend after it. **This package never writes the support account's
status.** It takes the grant as input (`--grant-lane`, `--grant-reference`),
and before it sets a drain flag or starts anything it:

1. refuses with `NoSupportGrantError` if no grant is given;
2. reads the support account from the tenant's own database, in a one-shot
   container of the tenant's image through Ghost's own database module (one
   SELECT of its status and roles), and refuses with
   `NotTheSupportAccountError` unless it holds exactly the Administrator
   role -- never the Owner, who is never suspended and so would pass a
   status check with no grant open -- and with
   `SupportAccountNotActiveError` unless Ghost would treat it as active.

The grant's lane and reference, and the support identity used, go into the
audit record.

## Whose data, as whom, to which key: the tenant's own config

None of these is a flag:

- **Environment, image, user and volumes** come from the tenant's rendered
  stack: `<stack-dir>/compose.yml` (default `/opt/branchleft/<slug>`),
  resolved by `docker compose config` against the tenant's secrets env
  (default `/etc/branchleft/<slug>.env`) and image env (default
  `/etc/branchleft/<slug>.image.env`), with PATH as Compose's only ambient
  variable. The export colour boots with the tenant's own environment, as
  the tenant's own user.
- **The support identity** is `adapters__sso__BreakGlassSSO__supportIdentity`
  from that rendered environment -- the identity the tenant's break-glass
  adapter is configured with. When the descriptor carries
  `breakGlass.supportIdentity`, the two must agree.
- **The recipient** is the descriptor's `backup.encryptionRecipient`, the
  tenant's one backup recipient (render-core `BackupSpec`). A descriptor
  with `backup.kind: none` is refused. The operator also states the
  recipient (`--age-recipient`); a mismatch is refused with
  `RecipientMismatchError`.

The descriptor's slug must match the stack's name and the adapter's tenant
audience.

The environment reaches `docker` as an `--env-file` written 0600 in a fresh
0700 directory and removed when the run ends, on every path including
SIGINT and SIGTERM -- never as `-e` values, which `ps` shows.

### Why a break-glass session, not an Admin API key

Ghost's own permission model refuses both `db.exportContent` and
`posts.exportCSV` to a custom integration's Admin API key -- both answer
403 `NoPermissionError`, because "Export database" is not among the
permissions the "Admin Integration" role carries. Only an Administrator or
Owner session can call either route. The support account is that
Administrator, reached through `adapters/sso/README.md`'s break-glass
adapter, and only while a grant has it active.

### The token comes from the operator

The bundler holds no signing key and mints nothing: minting stays where the
key lives. Once the export colour is healthy it prints a prompt on stderr
and reads one token from stdin. It asks only then because the adapter
refuses a token issued before the Ghost process that receives it started.
Mint with a lifetime of 600 seconds or less.

## The archive is encrypted

The archive is a tar, built in memory, handed to `age -r <recipient>` on
stdin, and written to disk only as ciphertext -- the same method as the
tenant's backups (`09-backup-and-recovery.html` §02,
`infra/provisioning/scripts/pull_encrypt_store.py`), to the same per-tenant
recipient. The ciphertext's
header is re-read after encryption and refused unless it names exactly one
recipient. The archive and the manifest beside it are written 0600 in a
0700 directory.

The manifest, inside the archive and as `<name>.manifest.json` beside it,
states `encryption: { encrypted: true, format: "age", recipient,
recipientFingerprint }`, where the fingerprint is the SHA-256 of the
recipient string. The audit record carries the same fingerprint and the
SHA-256 of the ciphertext file, binding the record to one archive.

## The export colour sends nothing and schedules nothing

The export colour is a second Ghost process on the tenant's live database.
`colourIsolation.ts` overrides the tenant's environment so that, as far as
Ghost 6.55's own settings allow, it acts on nothing:

- **Mail:** `mail__transport=stub`, Ghost's own no-op transport, with every
  `mail__*` key dropped. **Bulk email:** a `bulkEmail__mailgun__*` sink at a
  refused loopback port. Configured bulk email takes precedence over the
  Mailgun settings in the database, so those are never used.
- **Scheduler:** Ghost has no setting that stops it. The platform image ships
  a no-op adapter, `ghost-adapter/SchedulingDisabled.js` (the Dockerfile
  copies it into Ghost's internal scheduling adapters directory), and the
  colour selects it with `adapters__scheduling__active`. It reschedules
  nothing on boot and runs no job, so no scheduled post, scheduled newsletter
  or automation step fires from the colour. An image without the adapter
  fails to boot the colour, so the export fails closed.
- **Recurring jobs:** `backgroundJobs__emailAnalytics` and
  `backgroundJobs__clickTrackingLastSeenAtUpdater` are false, and the update
  check is off.
- **Stripe:** `WEBHOOK_SECRET` (random per run) keeps Ghost's webhook manager
  in local mode, so it never touches the tenant's Stripe webhook.
- **In-flight newsletters:** on every boot, Ghost resumes a newsletter it
  records as mid-send or marks it failed, and no setting stops it. The
  pre-flight therefore refuses with `NewsletterSendInFlightError` while any
  send is in flight.

What Ghost still does on the colour's boot, with no setting to stop it, is
the same as any colour boot on this platform. The daily member and gift
clean-up jobs fire at a random time between 00:00 and 06:00, and could land
inside an export window. There is a one-in-four chance the milestone check
runs at boot. Expired gifts are processed, and the ActivityPub webhook rows
and the Stripe billing-portal configuration are reconciled. Any mail these
paths try to send goes to the stub.

## The audit record

One JSON line per export, written in a single append and fsynced. If it
cannot be written, the archive and its manifest are removed and the run
fails with `AuditWriteError`: an archive never outlives its audit record.

## The drained-colour control

`drainGate.ts`'s `assertDrained` refuses to proceed unless the colour's
drain flag reads as set -- LLD-4 §U3b/§U7's invariant: an offline task
never runs against a routed colour. The bundler sets its own flag before
starting its own transient colour, then re-reads it rather than trusting
the write.

## Running it

Inside an open grant, on the tenant's app host, as a user that can read
the tenant's root-owned secrets env:

```sh
npm ci
npm run build
node dist/cli.js \
  --grant-lane consented|incident \
  --grant-reference <where the grant's evidence lives> \
  --descriptor <the tenant's descriptor JSON> \
  --age-recipient <the recipient you expect; must be the descriptor's> \
  --requested-by <who is asking> \
  --delivered-to <where the archive goes> \
  --dest-dir <where to write the archive> \
  --flag-dir <where this run's own drain flag lives> \
  --audit-log <path to the audit JSONL file> \
  --loopback-port <an unused local port> \
  [--stack-dir /opt/branchleft/<slug>] \
  [--secrets-env /etc/branchleft/<slug>.env] \
  [--image-env /etc/branchleft/<slug>.image.env]
```

The retired flags (`--env`, `--tenant-id`, `--image`, `--volume`,
`--mount-path`, `--break-glass-identity`) are refused by name.

## Tests

```sh
npm ci && npm run coverage       # unit, 90% threshold on every metric; needs age and age-keygen
docker build -t ghost-platform:local ../..
./../../scripts/test-export-bundler.sh ghost-platform:local   # real Ghost in Docker
```

The live script runs the built CLI against a real Ghost holding a real
owner and a real suspended support Administrator, described by a
descriptor and a rendered stack directory. It proves: refusal with no
grant, with the wrong recipient, with the Owner as the rendered support
identity, and with the account suspended, each starting nothing; no tenant
secret in any argv while the colour runs; a successful export once the
account is un-suspended, with the token minted after the colour is up; an
archive on disk that is ciphertext only and decrypts to real content; the
manifest's recipient fingerprint; the audit record's grant, identity,
fingerprint and digest; that the bundler never changes the account's
status; permissions; and cleanup.
