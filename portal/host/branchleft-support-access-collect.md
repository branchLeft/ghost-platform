# branchleft-support-access-collect.py

## Overview

Carries each app host's support-access textfile into the portal, once a
minute. Installed on ops1 as `/usr/local/sbin/branchleft-support-access-collect`
(root-owned, mode `0700`) and run by `branchleft-support-access-collect.timer`
through `branchleft-support-access-collect.service`. The installed file is this
program's source, run through its shebang `#!/usr/bin/python3 -I`.

It is the native half of the collector. The other half is the portal's
`dist/collector/main.js` (built from `portal/apps/src/collector/main.ts`), which parses
the text and writes the database. They are two programs because no one place can
do both:

- ops1's `DOCKER-USER` policy drops every packet a container forwards to the
  estate subnet, so a container cannot fetch an app host's exporter. A process
  on the host reaches it over `INPUT`, which the policy does not filter. This is
  also why node_exporter is native.
- The control-plane database publishes no port, so a host process cannot reach
  it, and the collector holds no database credential of its own.

So this program fetches, and hands the text to the collector inside the running
console container with `docker exec -i`, where the console's own database URL
file already is. No new credential, route or port.

## What it does

1. Takes one exporter address per argument, `http://<private IPv4>:<port>/metrics`
   and nothing else: no name, no other scheme, no login, no query. Any other
   argument stops the run, exit `2`, before anything is fetched or run.
2. For each address, fetches the text with one `GET`. No redirect is followed
   and no proxy is used. The status must be `200`, the text at most one
   mebibyte, and the whole fetch at most 10 seconds.
3. Finds the one running container of the Compose project `control-plane` and
   the service `console`, with `docker ps`, once per run. Not exactly one is a
   failed run.
4. Runs `docker exec -i <id> node dist/collector/main.js` with the host's text
   on standard input and an environment of `PATH` alone, limited to 60 seconds.
   The collector's own lines (one per tenant: recorded, or left out and why,
   never a reason, a clock or an id) are passed to the journal.

It runs nothing else: the only calls are `docker ps` and `docker exec`. It reads
no file, writes none, and holds no credential.

## When a host cannot be read

A host that does not answer, answers anything but `200`, sends too much, or is
too slow has nothing handed over, not even empty text. Its tenants keep their
old reading, which the portal reads as `unknown` once it is more than 900
seconds old. The run says `nothing written` for it in the journal, goes on to
the next host, and exits `1` at the end. A silent host is never written as
`closed`: the program has no way to write at all, only to hand a host's own text
to the collector.

## Exit status

`0` when every host was fetched and its hand-over exited `0`. `1` when any was
not. `2` for a missing or unusable address, with nothing run.

## Delivery

Not delivered by this change. The host role must install the program, the
service and the timer on ops1, write
`/etc/branchleft/support-access-collect.env` with the one line
`SUPPORT_ACCESS_EXPORTERS=<address> <address> ...` (the app hosts' exporters, on
the estate subnet), and enable the timer. node_exporter must be on each app host
first, with its textfile directory the writer's. That is a separate gated apply.
