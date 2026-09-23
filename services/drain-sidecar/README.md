# drain-sidecar

Answers a slot's health port for the broker's drain flag, not for Ghost. See
`ghost-platform-docs/19-try-it-now-design/02-broker-and-slot.html` §01b for
the design this implements.

`GET /health` returns:

- `503` if the drain flag is set, or if this process cannot determine
  whether it is set (an unreadable or missing flag directory, or any other
  stat error). The check fails closed: "absent" and "cannot tell" are
  different answers, and only the first is safe to read as clear.
- `503` if the flag is clear but Ghost's own front page does not answer
  exactly `200`.
- `200` only when both checks pass.

## Runtime user and the flag directory's permissions

The container runs as `node` — uid 1000, the user baked into the
`node:*-bookworm-slim` base image (`USER node` in the Dockerfile). It never
runs as root, and the flag check must never be made to pass by running it
as one.

For the flag check to answer `503`/`200` correctly rather than always
failing closed, the directory holding the flag file must be **readable and
traversable by uid 1000** — mode `0755` (owner: the broker or root; group
and other both get `r-x`) is what this repo's own CI proof
(`scripts/test-drain-sidecar.sh`) sets up, and is the recommended
production arrangement. The flag file's own permissions and owner don't
matter — the sidecar only ever stats the path by name, never opens or
reads it — but the *directory* does: without at least `r-x` for uid 1000,
`stat` fails with `EACCES`, which this service treats as "cannot tell" and
answers `503`, exactly as it would if the flag were actually set.
