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

## Runtime user and the flag directory's permissions

The container runs as `node` — uid 1000, the user baked into the
`node:*-bookworm-slim` base image (`USER node` in the Dockerfile). It never
runs as root, and the flag check must never be made to pass by running it
as one.

The flag lives in a directory the broker owns and can write to (mode
`0755`), separate from the root-owned slot directory created once at host
build — the slot's own uids (30001–30007, one per slot) have no write
access to it, or a compromised Ghost process could clear its own drain
flag. The sidecar only ever needs to read: it mounts the directory
**read-only**.

For the flag check to answer `503`/`200` correctly rather than always
failing closed, that directory must be **readable and traversable by uid
1000** — mode `0755` (group and other both get `r-x`) is what this repo's
own CI proof (`scripts/test-drain-sidecar.sh`) sets up, and is the
recommended arrangement. The flag file's own permissions and owner don't
matter — the sidecar only ever `lstat`s the path by name, never opens or
reads it, and never resolves a symlink (a dangling one still counts as
present) — but the *directory*'s permissions do: without at least `r-x`
for uid 1000, the check fails with `EACCES`, which this service treats as
"cannot tell" and answers `503`, exactly as it would if the flag were
actually set.
