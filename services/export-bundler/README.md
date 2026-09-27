# export-bundler

Calls Ghost's two existing admin exports -- content & settings, and post
analytics -- against a colour started on a tenant's own data with no route
pointed at it, and bundles the result into one archive plus a manifest.
Design: `ghost-platform-docs/19-try-it-now-design/08-portal.html` §08b.

`the portal does not build an exporter, it builds a bundler`: this package
owns starting the tenant's image drained, calling the two routes, and
stopping the image again. It does not close the four gaps §08b names
(media, members/subscriptions, comments, analytics beyond the CSV) -- those
are named in the manifest as gaps, not silently absent, and closing them is
a separate piece of work.

## Why "as the administrator" means break-glass SSO, not an Admin API key

Ghost's own permission model refuses both `db.exportContent` and
`posts.exportCSV` to a custom integration's Admin API key -- verified
against a real container while building this: both answer 403
`NoPermissionError`, because "Export database" is not among the
permissions the "Admin Integration" role carries. Only a session
authenticated as Administrator or Owner can call either route.

So this authenticates the way `adapters/sso/README.md`'s break-glass
adapter does: mint a short-lived signed token, spend it once on `/ghost/`
to open an Administrator session, then carry that session's cookie on both
export requests. That mechanism already exists on this platform for
exactly this kind of access -- LLD-5 §05's support grant -- and LLD-8 §08b
frames an export as carrying "the same weight as a support grant", so this
reuses it rather than adding a second way to become an administrator.

## The drained-colour control

`drainGate.ts`'s `assertDrained` refuses to proceed unless the colour's
drain flag reads as set -- LLD-4 §U3b/§U7's invariant, generalised from the
bake it was built for: an offline task never runs against a routed colour,
because it can neither be reached by a reader nor compete with one. This
export bundler always sets its own flag before starting its own transient
colour (LLD-4 §U7: "an export colour is additional... and transient, not a
ring member"), then re-reads it rather than trusting the write, so the
refusal path in `exportRunner.ts` is exercised by the same check a stray
live colour would fail.

## Running it

```sh
npm ci
npm run build
node dist/cli.js \
  --tenant-id <tenant> \
  --requested-by <who is asking> \
  --delivered-to <where the archive goes> \
  --image <ghost image tag> \
  --volume <the tenant's content volume> \
  --mount-path /var/lib/ghost/content \
  --break-glass-private-key <base64url, 32 raw bytes> \
  --break-glass-tenant <tenant> \
  --break-glass-identity <the account break-glass is configured to open> \
  --dest-dir <where to write the archive> \
  --flag-dir <where this run's own drain flag lives> \
  --audit-log <path to the audit JSONL file> \
  --loopback-port <an unused local port> \
  --env url=https://... \
  --env database__client=... \
  [--env KEY=VALUE ...]
```

Every `--env` flag is forwarded verbatim to the tenant's own container --
this package renders no compose file and has no opinion on a tenant's
storage tier, so the caller supplies whatever env the tenant's colour
already boots with in production (storage config, `url`, database
connection, and the break-glass adapter's own three settings).

## Tests

```sh
npm ci && npm run coverage       # unit, 90% threshold on every metric
docker build -t ghost-platform:local ../..
./../../scripts/test-export-bundler.sh ghost-platform:local   # real Ghost in Docker
```

The live script proves the real lifecycle against a real Ghost container:
a fresh Ed25519 keypair per run, a seeded owner account, the export
starting the tenant's own volume on a colour published only on
`127.0.0.1`, real content and analytics coming back, the archive and its
directory never world- or group-readable, the audit record, and cleanup
(no leftover container, drain flag cleared). The "refused while undrained"
control case is proven by sabotage at the unit level, against the real
entry point (`runExport`) -- see `test/unit/exportRunner.test.ts`.
