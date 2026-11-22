# branchleft-health-collect.py

## Overview

Carries each tenant's drain-sidecar health into the portal, once a minute.
Installed on ops1 as `/usr/local/sbin/branchleft-health-collect` (root-owned,
mode `0700`) and run by `branchleft-health-collect.timer` through
`branchleft-health-collect.service`. The installed file is this program's
source, run through its shebang `#!/usr/bin/python3 -I`.

It is the native half of the health collector. The other half is the portal's
`dist/collector/healthMain.js` (built from
`portal/apps/src/collector/healthMain.ts`), which checks the report and calls
`OwnerDb.recordReading`. They are two programs for the reason the support-access
pair is (see `branchleft-support-access-collect.md`): ops1's `DOCKER-USER`
policy drops every packet a container forwards to the estate subnet, so only a
host process can fetch from a tenant host, and the control-plane database
publishes no port, so only the container can write to it. This program fetches
and hands the text over with `docker exec -i` to the console container, where
the database URL file already is. No new credential, route or port.

A sidecar's text names no tenant, so the tenant is this program's own
configuration, never something a host said about itself.

## What it does

1. Takes one argument per tenant, `<slug>=<address>[,<address>]`: the slug the
   tenant is registered under (`OwnerDb.listTenantSlugs`) and the address of
   each colour's sidecar metrics, colour `a` first, each
   `http://<private IPv4>:<port>/metrics` and nothing else (no name, other
   scheme, login, query or fragment). One or two colours. A slug that is not a
   slug, a slug named twice, or any other argument stops the run, exit `2`,
   before anything is fetched or run.
2. Fetches each colour with one `GET`. No redirect is followed and no proxy is
   used. The status must be `200`, the text at most 16 KiB and UTF-8, and the
   whole fetch at most 5 seconds.
3. Builds one report for the whole run and finds the one running container of
   the Compose project `control-plane` and the service `console`, with
   `docker ps`. Not exactly one is a failed run with nothing written.
4. Runs `docker exec -i <id> node dist/collector/healthMain.js` with the report
   on standard input and an environment of `PATH` alone, limited to 60 seconds.
   The collector's own lines (one per tenant: recorded and whether it was read,
   or left out and why; never a scrape, a version or an id) go to the journal.

The report is JSON: `{"tenants":[{"tenant":"<slug>","scrapes":["<text>",null]}]}`,
one scrape per colour in order.

It runs nothing else: the only calls are `docker ps` and `docker exec`. It reads
no file, writes none, and holds no credential.

## When a colour cannot be read

A colour that does not answer, answers anything but `200`, sends too much,
sends text that is not UTF-8, or is too slow is reported as `null`, and the
tenant is still handed over. The collector then writes the tenant as `unknown`
with no scrape at all, replacing the last reading. The colour that did answer
is not used alone: which colour serves is the question, and with one colour
unread the program cannot say the other is the only undrained one. So a stopped
sidecar, a down host or a half-finished cutover reads as `unknown`, never as the
last good reading and never as healthy. The run says which colour was not read,
and exits `1` at the end.

A run that cannot reach the console container writes nothing, and the old
readings stay as they were; the unit fails, which is what shows it.

## Exit status

`0` when every colour was read and the hand-over exited `0`. `1` when any colour
was not read, or the container was not found, or the collector failed. `2` for a
missing or unusable argument, with nothing run.

## Delivery

Not delivered by this change. The host role must install the program, the
service and the timer on ops1, write `/etc/branchleft/health-collect.env` with
the one line `HEALTH_TENANTS=<slug>=<address>[,<address>] ...`, and enable the
timer. The sidecars' `/metrics` must also be reachable from ops1 over the estate
subnet: a demo slot's sidecar answers on a unix socket in a directory only the
slot's health router can enter, so a private address for it is a host change
that is separate work. A tenant host that runs its sidecar with a TCP port is
reachable as it is. That is a separate gated apply.
