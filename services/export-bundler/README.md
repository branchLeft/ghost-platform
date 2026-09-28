# export-bundler

Calls Ghost's two existing admin exports -- content & settings, and post
analytics -- against a colour started on a copy of a tenant's database with
no route pointed at it, and bundles the result into one archive, encrypted
to the tenant's own `age` recipient, plus a manifest.
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

## The export colour runs against a copy, never the live database

Owner ruling, 2026-09-27: "the copy". Ghost acts on its database as it
boots. It runs the member welcome-email poll, resumes any newsletter it
finds mid-send, and does clean-up work. None of that has a setting to stop
it. So the export colour never runs against the tenant's live database.
`scratchDatabase.ts` gives each run its own copy:

- **MySQL tier.**
  - A fresh MySQL 8.0 container, the server image `db/RUNBOOK-db.md` pins
    for db1, on the run's own network. It has no published port, and its
    root password reaches it through an env file.
  - `mysqldump --single-transaction` of the tenant's one schema is streamed
    straight into it: from the dump container's stdout, through this
    process, into `mysql` in the scratch container. The dump container runs
    with `--log-driver none`, because Docker's default json-file driver
    would otherwise write the whole stream, uncapped, to /var/lib/docker.
    No dump file exists anywhere. The dump container is named
    `<run>-dump` and registered for cleanup, so a signal mid-dump removes
    it and ends its read of db1.
  - The flags are `db/provision/dump_tenant.py`'s, with two changes. The
    dump runs over TCP as the tenant's own account, because db1's `backup`
    account is socket-only. `--source-data=2` is dropped and
    `--no-tablespaces` added, since that account holds no global privilege.
  - Nothing is created on db1; the dump is a read.
  - The readiness wait (a real `SELECT 1` over TCP) and the
    refuse-a-non-empty-target check mirror `db/recovery/restore_drained.py`.
    The floor check (`users` and `settings` rows must appear in the
    stream) mirrors `dump_tenant.py`. Those modules are Python and this
    package is Node, so they are mirrored, not imported.
- **SQLite tier.**
  - SQLite's online backup API, through the better-sqlite3 in Ghost's own
    image. The tenant's volumes are mounted read-only, and the source file
    is opened read-only.
  - The copy goes into a Docker volume created for the run, not a host
    directory. The tenant's file lives in a Docker volume the host cannot
    read directly, and the colour runs as the tenant's own uid.

**The control.** Before the colour starts, the environment it is about to
be given must point its database at the copy (`assertColourOnScratch`).
After it is healthy and before any export call, the environment Docker
reports for the running colour must too. Otherwise the run refuses with
`LiveDatabaseTargetError`.

**The run network is `--internal`.** The colour and the scratch database
share a network created for the run, with no route off the host. Docker
publishes no port for a container on an internal network, so the colour
publishes nothing. Its one way in is a relay: a container of the tenant's
own image running one fixed script that forwards `127.0.0.1:<port>` to the
colour. The relay is read-only, has all capabilities dropped, and carries no
environment and no volume. The dump container is the only one with a route
to the tenant's database server, and it reads.

**No Docker logs of tenant data.** Every container in a run that can carry
tenant data on stdout or stderr runs with `--log-driver none`: the dump,
the scratch database, the status probe, the SQLite backup, the colour and
the relay. `test/unit/logDriver.test.ts` asserts it for each.

**Cleanup.** Every resource the run creates registers a synchronous
remover with `cleanup.ts`: the colour, the relay and its network, the dump
container, the scratch container and its data, the run network, the volume
and the env files. The normal path removes them in `finally`, colour first.
A colour that is created but fails to start is removed at once. On SIGINT
or SIGTERM the removers run before the process exits.

## The export colour sends nothing and schedules nothing: the second layer

With the copy in place, these switches are a second layer, defence in
depth. Whatever gets past them acts on a copy that is deleted when the run
ends. `colourIsolation.ts` overrides the tenant's environment so that, as
far as Ghost 6.55's own settings allow, the colour acts on nothing:

- **Mail:** `mail__transport=stub`, Ghost's own no-op transport, with every
  `mail__*` key dropped. **Bulk email:** a `bulkEmail__mailgun__*` sink at a
  refused loopback port. Configured bulk email takes precedence over the
  Mailgun settings in the database, so those are never used.
- **Scheduler:** Ghost has no setting that stops it. The platform image ships
  a no-op adapter, `ghost-adapter/SchedulingDisabled.js` (the Dockerfile
  copies it into Ghost's internal scheduling adapters directory), and the
  colour selects it with `adapters__scheduling__active`. It reschedules
  nothing on boot and runs no scheduled job, so no scheduled post or
  scheduled newsletter publishes from the colour. It does not stop Ghost's
  automations poll: that runs at boot and on in-memory timers outside the
  adapter, and the welcome-email step it drives is recorded as sent against
  the stub transport. That is why the copy, not this layer, is the control.
  An image without the adapter fails to boot the colour, so the export fails
  closed.
- **Recurring jobs:** `backgroundJobs__emailAnalytics` and
  `backgroundJobs__clickTrackingLastSeenAtUpdater` are false, and the update
  check is off.
- **Stripe:** `WEBHOOK_SECRET` (random per run) keeps Ghost's webhook manager
  in local mode, so it never touches the tenant's Stripe webhook.
What Ghost still does on the colour's boot, with no setting to stop it, now
happens to the copy only:
- the member welcome-email poll;
- resuming, or failing, any newsletter recorded as mid-send;
- the daily member and gift clean-up jobs and gift reminders;
- the milestone check;
- processing expired gifts;
- reconciling the ActivityPub webhook rows.

One effect still reaches outside the copy: the Stripe billing-portal
configuration is registered with Stripe, as on any colour boot. The rows
those boot paths change on the copy (`emails`, `email_batches`,
`welcome_email_automation_runs`, `automated_email_recipients`) are outside
the table allowlist of Ghost's default content export, so the archive does
not carry them.

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

The live script runs the built CLI on the MySQL tier. It uses a "live"
MySQL (db1's pinned image, TLS required) seeded by a real Ghost, with a
real owner and a real suspended support Administrator, described by a
descriptor and a rendered stack directory. It proves:
- refusal with no grant, with the wrong recipient, with the Owner as the
  rendered support identity, and with the account suspended, each creating
  nothing;
- the colour on the copy, never holding the live password;
- with a due welcome email and a newsletter mid-send seeded on the live
  database, Ghost acting on the copy while the live rows stay
  byte-identical;
- the second layer;
- no secret in any argv;
- an encrypted archive of real content;
- the manifest and the audit record;
- nothing left behind after success or after Ctrl-C.

The SQLite tier is covered by unit tests only.
