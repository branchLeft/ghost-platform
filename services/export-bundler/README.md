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
2. reads the support account's status from the tenant's own database, in a
   one-shot container of the tenant's image through Ghost's own database
   module, and refuses with `SupportAccountNotActiveError` unless Ghost
   would treat the account as active.

The grant's lane and reference go into the audit record.

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
`infra/provisioning/scripts/pull_encrypt_store.py`). The ciphertext's
header is re-read after encryption and refused unless it names exactly one
recipient. The archive and the manifest beside it are written 0600 in a
0700 directory.

The manifest, inside the archive and as `<name>.manifest.json` beside it,
states `encryption: { encrypted: true, format: "age", recipient,
recipientFingerprint }`, where the fingerprint is the SHA-256 of the
recipient string. The audit record carries the same fingerprint.

## The drained-colour control

`drainGate.ts`'s `assertDrained` refuses to proceed unless the colour's
drain flag reads as set -- LLD-4 §U3b/§U7's invariant: an offline task
never runs against a routed colour. The bundler sets its own flag before
starting its own transient colour, then re-reads it rather than trusting
the write.

## Running it

Inside an open grant, on the host that holds the tenant's content volume:

```sh
npm ci
npm run build
node dist/cli.js \
  --grant-lane consented|incident \
  --grant-reference <where the grant's evidence lives> \
  --tenant-id <tenant> \
  --requested-by <who is asking> \
  --delivered-to <where the archive goes> \
  --image <ghost image tag> \
  --volume <the tenant's content volume> \
  --mount-path /var/lib/ghost/content \
  --age-recipient <the tenant's age recipient> \
  --dest-dir <where to write the archive> \
  --flag-dir <where this run's own drain flag lives> \
  --audit-log <path to the audit JSONL file> \
  --loopback-port <an unused local port> \
  --env url=https://... \
  --env database__client=... \
  --env adapters__sso__BreakGlassSSO__supportIdentity=<support address> \
  [--env KEY=VALUE ...]
```

Every `--env` flag is forwarded verbatim to the status probe and the
tenant's own container: the caller supplies the env the tenant's colour
already boots with (storage config, `url`, database connection, and the
break-glass adapter's settings). The support identity is read from that
env.

## Tests

```sh
npm ci && npm run coverage       # unit, 90% threshold on every metric; needs age and age-keygen
docker build -t ghost-platform:local ../..
./../../scripts/test-export-bundler.sh ghost-platform:local   # real Ghost in Docker
```

The live script runs the built CLI against a real Ghost holding a real
owner and a real suspended support Administrator. It proves: the refusal
with no grant, and with the account suspended, each starting nothing; a
successful export once the account is un-suspended, with the token minted
after the colour is up; an archive on disk that is ciphertext only and
decrypts to real content; the manifest's recipient fingerprint; the audit
record's grant and fingerprint; that the bundler never changes the
account's status; permissions; and cleanup.
