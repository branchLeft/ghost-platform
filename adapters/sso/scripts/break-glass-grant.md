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
node break-glass-grant.mjs grant --lane consented|incident --tenant <slug> \
  --identity <support email> --reason <one line> --reference <one line>
node break-glass-grant.mjs revoke --tenant <slug> --reason <one line>
node break-glass-grant.mjs status
node break-glass-grant.mjs expire        # what the timer runs
```

It reaches the tenant's database through the tenant's running Ghost container,
either colour (Compose labels `com.docker.compose.project=<slug>`, service
`ghost-a` or `ghost-b`), with Ghost's own knex. That is the same route
`provision-support-account.mjs` takes, so it holds no driver and no credential.

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

Both lanes refuse an account that does not hold exactly the Administrator
role, so a grant can never activate the Owner or any other staff account.

## The clock

`grant` writes `/var/lib/branchleft/break-glass-grants/<slug>.json` (mode 0600)
with a deadline four hours ahead. It writes that file **before** it touches the
account. One grant per tenant can be open at a time.

`branchleft-break-glass-expire.timer` (`systemd/` beside this file) runs
`expire` every minute, and runs a missed minute at boot (`Persistent=true`). A
clock kept in a file and checked every minute survives a host reboot, which a
transient timer would not. `grant` refuses to open anything unless that timer
is active.

If `expire` cannot close a grant, for example because the container is down,
the state file stays, the run exits 1 so systemd marks it failed, and the next
minute retries.

## Revoke: suspend, purge, wait, again

`revoke` (explicit, or `expire` at the deadline):

1. Sets the account to `inactive` and deletes all of its rows in `sessions`.
2. Waits five seconds.
3. Does both again (adapter review, requirement 1). A session the adapter
   admitted just before the revoke can be written after the first purge.
4. Appends the closing record and removes the state file.

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
the sessions purged on each pass.
