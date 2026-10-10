# break-glass-grant.mjs

## Overview

The two grant lanes and the four-hour clock of LLD-5 section 05, run as root
on the tenant's own app host. The owner ruled on 2026-09-24
(branchLeft/workspace#1245) that grant and revoke are commands the owner runs
over SSH on the tenant host, that the four-hour clock covers both lanes, and
that the clock overrides a tenant's own un-suspend. Only minting is on `ops1`
(`break-glass-mint.md`).

No agent and no LLM runs any of this (D38, D39). The incident lane's
authorisation is the owner's SSH session: nothing in the lane can pass that
stop on the owner's behalf. The host steps are in `ghost-platform-docs`,
`break-glass-runbook.md`.

```sh
branchleft-break-glass grant --lane consented|incident --tenant <slug> \
  --reason <one line> --reference <one line> [--identity <support email>]
branchleft-break-glass revoke --tenant <slug> --reason <one line>
branchleft-break-glass status
```

`branchleft-break-glass` is the host wrapper (`host/branchleft-break-glass.sh`,
installed at `/usr/local/sbin/branchleft-break-glass`). The app host has no
Node: the wrapper and the expire unit run this file inside a pinned Node
container (see "The container"), and `expire` is what the unit runs.

It reaches the tenant's database through the tenant's running Ghost container,
either colour (Compose labels `com.docker.compose.project=<slug>`, service
`ghost-a` or `ghost-b`), with Ghost's own knex. It finds that container and
runs its one step in it through the Docker Engine API on the mounted socket
(`docker-engine.mjs`), so the container needs no `docker` CLI. That is the
same route `provision-support-account.mjs` takes, so it holds no driver and
no credential.

## The account

The only account this tool reads or writes is the one in the tenant's own
config: `adapters:sso:BreakGlassSSO:supportIdentity`, the value the renderer
emits from the descriptor's break-glass triple. It is the same value the
adapter treats as the only valid token subject. The script inside the
container reads it through Ghost's own config module. Nothing from outside
names the account.

`--identity` is an optional cross-check. If it is given and differs from the
configured value, `grant` refuses before it writes anything, so a mistyped or
wrong email can never activate or suspend a tenant's own staff, the Owner or
any other account. A tenant with no configured `supportIdentity` is refused
outright. `revoke` and `expire` take no identity at all.

## The lanes

- **Consented.** The tenant has un-suspended the support account in their own
  Staff screen, and Ghost has written that to their activity log. `grant`
  writes nothing to the tenant's database. It checks that the account is the
  support Administrator and is active, then starts the clock. If the check
  fails, the clock is removed again, because nothing was opened.
- **Incident.** The owner has authorised it. If the tenant deleted the account,
  `grant` recreates it through `provision-support-account.mjs`, which always
  creates it suspended. This is the anti-lockout guarantee, exercised. Then
  `grant` sets the account active. If anything fails part-way, the clock stays,
  so the timer still closes whatever may have opened.

Both lanes also refuse the configured account if it does not hold exactly the
Administrator role, for example after the tenant moved it to Editor.

## The clock

`grant` writes `/var/lib/branchleft/break-glass-grants/<slug>.json` (mode 0600)
with a deadline four hours ahead. It writes that file **before** it touches the
account. The file is written under a temporary name and then hard-linked into
place, so it is never half-written and never overwrites another grant. One
grant per tenant can be open at a time.

`branchleft-break-glass-expire.timer` (`systemd/` beside this file) runs
`expire` every minute, and runs a missed minute at boot (`Persistent=true`). A
clock kept in a file and checked every minute survives a host reboot, which a
transient timer would not. `grant` refuses to open anything unless that timer
is active. The container cannot ask systemd, so the wrapper runs
`systemctl is-active --quiet branchleft-break-glass-expire.timer` on the host
and passes the answer in as `BL_EXPIRE_TIMER_STATE`. Only the exact value
`active` lets a grant open: a missing, empty or any other value refuses it.

`expire` handles each state file on its own, so one failure never stops the
rest. It logs a file it cannot read, or one with no valid deadline, and closes
that tenant at once instead of skipping it. If it cannot close a grant, for
example because the container is down, the state file stays, the run exits 1
so systemd marks it failed, and the next minute retries.

Every Engine API call has a 60-second bound, and the service has a 10-minute
start timeout. One exec (create, start and inspect together) shares one
60-second bound, and the bound is a timer on the socket, so a daemon that
accepts the connection and never answers still ends the call. A wedged exec or
a database lock therefore ends the run rather than holding it open, which
would stop the timer firing again. The tool also exits on SIGTERM and SIGINT,
because it is PID 1 in its container and PID 1 ignores a signal it has no
handler for.

## The container

`grant`, `revoke`, `status` and `expire` run in the same pinned Node image the
`ops1` minter uses (`node:26.5.0-bookworm-slim@sha256:2d49d876…`, as in
`services/drain-sidecar`). The wrapper and the expire unit start it with the
same options, and a unit test holds the two together:

| Option | What it does |
|---|---|
| `--network none` | No network beyond the mounted socket. |
| `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges` | Nothing writable but the two mounted directories, no capabilities. |
| `--pids-limit 64`, `--memory 256m` | A runaway tool cannot take the host. |
| `--pull never` | A missing image fails at once, in the journal, rather than reaching for a registry. B step 1 pulls it. |
| read-only mount of the tool directory | The code that runs is the code that was delivered. |
| mount of `/var/lib/branchleft/break-glass-grants` and `/var/log/branchleft` | The clock and the records, at the paths the tool already used. |
| mount of `/var/run/docker.sock` | The Engine API, for the two calls above. |

The key directory `/etc/branchleft/break-glass` is on `ops1` only and is never
mounted here.

**Security.** Mounting `/var/run/docker.sock` gives the container
root-equivalent power on the app host: whoever controls the process in it
can start a privileged container. That is no wider than before. The tool
already ran as root on this host and called `docker`, and `grant` and
`revoke` still act only on the support account named in the tenant's own
config. The socket must not be mounted into anything else. The wrapper is
root-owned, mode `0700`, and the unit root-owned, mode `0644`, so only root
starts the container. The flags above limit a mistake in the tool and what a
bug in it could reach by accident, not a hostile author of the tool: the image
is pinned by digest and the tool directory is mounted read-only for that
reason.

Two things to know:

- Every run is PID 1 in its own container, so a temporary file named from the
  process id is not unique across two runs started at the same moment. Two
  `grant`s for one tenant in the same second can race on it; `expire` writes
  none. Use one operator session.
- The image is referenced by digest and is not pulled at run time. A
  `docker image prune -a` that removes it stops `expire`, and the unit then
  fails visibly (`systemctl show -p Result`). Never prune images on an app
  host without checking `docker image inspect` for it afterwards.

## Revoke: suspend, purge, wait, again

`revoke` (explicit, or `expire` at the deadline) needs no state file. A lost
or unreadable file still closes the configured account, and the closing record
says so:

1. Sets the account to `inactive` and deletes all of its rows in `sessions`.
2. Waits five seconds.
3. Does both again (adapter review, requirement 1). A session the adapter
   admitted just before the revoke can be written after the first purge.
4. Appends the closing record and removes the state file
   only if it is still the grant it read (a newer grant keeps its clock).

The state is renamed to a private `.<slug>.<pid>.<id>.claim` name first, which
is atomic, so what is compared is exactly what is removed; no lock is taken, so
a stuck process can never stop a later close. A state that turns out to be a
different grant is linked back. If that link fails, the claim file is kept,
`revoke` exits 1 and `status` lists it as `held`. `expire` links a claim older
than a minute back into place, so a held grant's clock runs again. A different
grant already in place is kept and the displaced one is logged.

It runs whatever the account's status is (requirement 2). A tenant who
re-suspended from the Staff screen during the window still leaves the session
row behind. That row would wake on their next un-suspend, up to 180 days
later. The purge removes it. It refuses to touch an account that holds the
Owner role.

## Records

`/var/log/branchleft/break-glass-grants.jsonl` (mode 0600) gets one line when a
grant opens and one when it closes. The closing record carries the lane, the
reference, the reasons, the grant and close times, the cause (`timer` or
`explicit`), whether the account was found, its status before the revoke, and
the sessions purged on each pass. It also records whether the state file was
found, whether it was unreadable, and whether the configured identity changed
during the window.
