# drain-sidecar

Answers a slot's health port for the broker's drain flag, not for Ghost. See
`ghost-platform-docs/19-try-it-now-design/02-broker-and-slot.html` §01b for
the design this implements.

## The health check

A slot's health is the drain flag, not Ghost, so the flag is checked first
and short-circuits to `503` without ever asking Ghost -- a sidecar that
asked Ghost first and used the flag as a tie-breaker would still leak
Ghost's opinion into the drained case on a slow or flaky probe.

`GET /healthz` returns:

- `503` (`{"status":"drained"}`) if the drain flag is set, or if this
  process cannot determine whether it is set (an unreadable or missing flag
  directory, or any other stat error). The check fails closed: "absent" and
  "cannot tell" are different answers, and only the first is safe to read
  as clear.
- `503` (`{"status":"ghost_unhealthy"}`) if the flag is clear but Ghost's
  own front page does not answer exactly `200`.
- `200` (`{"status":"ok"}`) only when both checks pass.

## How the flag is checked

The flag is a file's mere presence, not its contents, and it is owned by
the broker rather than by this process. A stat-and-forget check matches
that contract exactly: no lock, no read, no cached state to fall out of
sync with the file a different process is writing.

`lstat`, not `stat`: presence of the directory entry is the whole
contract, so a dangling symlink -- an entry that exists but resolves
nowhere -- still reads as set. Resolving the link and following `ENOENT`
to "clear" would let a broker action that only ever creates a symlink (or
a target that's gone missing) undrain a slot by accident.

"The flag is absent" and "this process cannot tell" are different
answers, and only the first is safe to read as clear. A stat that fails
with anything other than `ENOENT` against a directory this process can
itself read and traverse -- a permission error, a missing directory, a
path component that isn't one -- is treated as set: a slot that cannot
confirm it is safe must not serve traffic on the strength of a guess.

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

## What "healthy" means to the Ghost probe

Ghost carries no readiness route of its own, so "healthy" here is nothing
more than the ordinary front page answering exactly `200` -- never any
other 2xx, and never a 3xx read on trust, because a redirect can point
anywhere, including at a host this process was never asked to trust.
`redirect: 'manual'` stops `fetch` from ever leaving this origin on the
probe's behalf; a redirect then just fails the `=== 200` check like any
other wrong status, rather than being followed. A non-200 status, a
connection failure and a timeout are all folded into the same `false` --
this probe never rejects, because its one caller has nothing useful to do
with a distinction between "Ghost said no" and "Ghost didn't say".

## `GET /metrics` — per-tenant health and version

Hand-rolled Prometheus text exposition, scraped rather than held — the
estate already scrapes Prometheus targets, so this is that same transport
again, not a new one (see `ghost-platform-docs/19-try-it-now-design/
08-portal.html` §09, and the cross-document review's P2 on not growing a
second transport where one is already named). Not being a held connection
also means this endpoint carries no producer-side age metric of its own
(the estate's held-connection rule doesn't bind it) — a scrape is the
estate pulling a fresh reading each time, never something that can go
silently stale between polls the way a held socket can.

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

This is also the story's control case: a caller that reads the raw
reported version directly instead of `deriveVersionState`'s `reported` --
"answer with whichever colour responds first" -- reintroduces exactly the
bug this exists to prevent. During a legitimate overlap, the retiring
colour's real (and, correctly, mismatching) version would leak through and
get read as a stuck tenant.

## Reading Ghost's own version

Ghost's admin "site" endpoint answers with no authentication at all and
includes the running instance's own version --
`{"site":{"version":"6.55.0", ...}}`. That is the whole point of probing
it rather than reading a version out of the descriptor: the reported
version must come from the instance itself, never from this platform's own
records.

It follows the same never-rejects contract as the health probe above: a
non-200 status, a malformed body and a connection failure are all folded
into the same `null`, because the one caller (this service's `/metrics`
route) has nothing useful to do with a distinction between "Ghost said no"
and "Ghost didn't say".

The intended version comes from `GHOST_INTENDED_VERSION`, an optional
environment variable this service does not set itself — a caller renders
it from the tenant descriptor's own `image` field via render-core's
`intendedGhostVersion()` before starting this process. Unset,
`/metrics` still reports Ghost's own version; it just cannot say whether
that matches anything. This service has no descriptor and no opinion on
how the wiring from descriptor to environment variable reaches it, any
more than it has an opinion on `DRAIN_FLAG_PATH`'s own placement (above)
— that is a slot-placement decision made elsewhere. Ghost's admin site
endpoint is `GHOST_ADMIN_SITE_URL`, defaulting to `/ghost/api/admin/site/`
on `GHOST_HEALTH_URL`'s own origin — the same loopback call `GET
/healthz` already makes to the same Ghost, per this sidecar sharing
Ghost's network namespace rather than reaching it any other way.

## Listening on a unix socket

With `SOCKET_PATH` set, the service listens on that unix socket and opens no
TCP port at all; `PORT` is then ignored. This is how a demo slot's colour
answers the slot's health router: the sidecar shares its Ghost's network
namespace, so a TCP port in it would be reachable by anything else sharing
that namespace, where a socket in a bind-mounted directory is reachable only
by whoever can enter the directory.

- The socket is created under a `0177` umask, so it is `0600` from the
  instant it exists, and the umask is restored straight after.
- A socket already at the path (the residue of a killed container) is
  replaced. Anything else at the path, a file or a directory, is refused
  rather than removed.
- Closing the server removes the socket.

The directory the socket sits in, who owns it and who may enter it are host
decisions made where the container is started, not here.
