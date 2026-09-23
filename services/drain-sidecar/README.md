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
