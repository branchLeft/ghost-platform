# The backup dump endpoint

`dump_endpoint_server.py` (runs on the tenant database host) and
`infra/provisioning/scripts/dial_in_transport.py`'s `DumpEndpointTransport`
(runs on the org/control-side backup worker) are the two ends of one
channel: `GET /dump/<tenant>`, answered, never dialled out from. LLD-2 §03
names this shape once for the whole estate, bearer-token authenticated,
"answers, never calls" -- `services/mailgun-shim`'s `GET /drain`
(`drainAuth.ts`, `routes/drain.ts`) is the same shape already live for
mail. The owner's `transport=a` ruling settles that the backup worker
reuses this HTTP-and-bearer-token pattern rather than a second kind of
channel.

## Three properties the server holds

1. **Authentication is a constant-time compare.** `hmac.compare_digest`,
   for the same reason `drainAuth.ts` hashes before comparing: a timing
   side-channel on the token would let an attacker narrow it down one
   request at a time.
2. **The tenant id is validated strictly**, against `naming.py`'s own
   pattern -- never a second, looser copy of it.
3. **A caller can never name a path.** The only thing read from a request
   is the tenant slug (a single, `/`-free path segment); it always runs
   `dump_tenant.run_dump` against this module's own fixed `DEFAULT_SOCKET`.
   No parameter, header or body field reaches a filesystem path.

`DB_DUMP_MYSQL_PWD` never lives on this host at rest -- `backup_worker.py`
holds it (from the password manager, at run time) and sends it once, per
request, in the `X-Db-Dump-Mysql-Pwd` header. This server never writes it
to disk, never logs it, and holds it only for the one `run_dump` call it
is used for.

The dump account's password lives in the same place the worker's `age`
recipients already live -- the password manager, read into org/control's
environment at run time, never written to any file on the database host,
and never the push model's on-host `EnvironmentFile`. `run_tenant_dump`
takes it as a plain argument for exactly that reason: the caller (the
nightly loop, or an on-demand invocation) is the one place the secret is
resolved, handed to `pull_encrypt_and_store` as a single-purpose env entry
for one invocation, never persisted anywhere else.

## Why the response is buffered, not streamed live

A caller must be able to trust the status line: 200 means a complete,
floor-checked dump follows. Streaming `dump_tenant.py`'s stdout live into
the response would mean committing to 200 before knowing whether it
finishes cleanly, so a nonzero exit could surface as a truncated 200
instead. Buffering into an anonymous `tempfile.TemporaryFile()` first --
never a named path a second request or a caller could collide with or
choose -- means the status line is only ever written once the real outcome
is known, and `Content-Length` is always exact. `DumpEndpointTransport`
uses that exact length to detect a connection that dropped mid-response,
rather than treating a short body as success.

## Reachability

The database host and the org/control host this worker runs on share one
private network and one Hetzner project (`infra/hosts/index.ts`'s `db1`
and shared-infra's `estate.ts`'s `ops1` both attach to the same
`branchleft-hetzner-network` stack) -- no project boundary is crossed, and
this is not a second inbound path added to a host that already has one:
`db1` runs no other collector channel today. The trusted caller address is
still a required, explicit config value rather than a hardcoded one: which
host in org/control ultimately runs this worker is an operational
decision, not this module's to assume.
