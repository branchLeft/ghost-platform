# drain-sidecar

Answers a slot's health port for the broker's drain flag, not for Ghost. See
`ghost-platform-docs/19-try-it-now-design/02-broker-and-slot.html` §01b for
the design this implements.

`GET /healthz` returns:

- `503` (`{"status":"drained"}`) if the drain flag is set, or if this
  process cannot determine whether it is set (an unreadable or missing flag
  directory, or any other stat error). The check fails closed: "absent" and
  "cannot tell" are different answers, and only the first is safe to read
  as clear.
- `503` (`{"status":"ghost_unhealthy"}`) if the flag is clear but Ghost's
  own front page does not answer exactly `200`.
- `200` (`{"status":"ok"}`) only when both checks pass.

## What the sidecar needs from the flag directory

The container runs as `node` — uid 1000, the user baked into the
`node:*-bookworm-slim` base image (`USER node` in the Dockerfile). It never
runs as root, and the flag check must never be made to pass by running it
as one.

Wherever `DRAIN_FLAG_PATH` lives:

- The sidecar only ever needs to read, so its containing directory is
  mounted **read-only** (`scripts/test-drain-sidecar.sh` mounts it `:ro`).
- That directory must be **readable and traversable by uid 1000** (`r-x`)
  for the check to answer `503`/`200` correctly rather than always failing
  closed. Without at least that, the check fails with `EACCES`, which this
  service treats as "cannot tell" and answers `503` — exactly as it would
  if the flag were actually set.
- The flag file's own permissions and owner don't matter — the sidecar
  only ever `lstat`s the path by name, never opens or reads it, and never
  resolves a symlink (a dangling one still counts as present).

Where the flag directory sits, who owns it, and what else can write to it
are host placement decisions this service has no opinion on and makes no
claim about; that is the fixed-slots story's territory, not this one's.

## `GET /metrics` — per-tenant health and version

Hand-rolled Prometheus text exposition, scraped rather than held — the
estate already scrapes Prometheus targets, so this is that same transport
again, not a new one (see `ghost-platform-docs/19-try-it-now-design/
08-portal.html` §09, and the cross-document review's P2 on not growing a
second transport where one is already named).

- `drain_sidecar_drained` — always present: `1` if the drain flag is set,
  `0` otherwise.
- `drain_sidecar_ghost_version_info{version="…"}` — Ghost's own reported
  version (read from its unauthenticated admin site endpoint), present
  **only when this colour is undrained**.
- `drain_sidecar_version_match` — `1`/`0`, present only when this colour is
  undrained *and* both an intended and a reported version are known.

That gating is the whole point: "the reported version is read from the
undrained colour" (LLD-8 §09, load-bearing) is enforced once, in
`versionState.ts`, by never producing a `reported` value at all for a
drained colour — not left to whatever queries these two colours' metrics
later to get right. A mismatch on the drained colour is not a stuck
tenant; it is the definition of "the version being retired", and this
endpoint never reports one.

The intended version comes from `GHOST_INTENDED_VERSION`, an optional
environment variable this service does not set itself — a caller renders
it from the tenant descriptor's own `image` field via render-core's
`intendedGhostVersion()` before starting this process. Unset,
`/metrics` still reports Ghost's own version; it just cannot say whether
that matches anything. Ghost's admin site endpoint is
`GHOST_ADMIN_SITE_URL`, defaulting to `/ghost/api/admin/site/` on
`GHOST_HEALTH_URL`'s own origin — the same loopback call `GET /healthz`
already makes to the same Ghost.
