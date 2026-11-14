# branchleft-break-glass-textfile.py

## Overview

Carries each tenant's support-access state off an app host, as one
node_exporter textfile, for the portal's support-access page. Installed as
`/usr/local/sbin/branchleft-break-glass-textfile` (root-owned, mode `0700`) and
run once a minute by `../systemd/branchleft-break-glass-textfile.timer`. The
installed file is this program's source, run through its shebang
`#!/usr/bin/python3 -I`.

It exists apart from the host wrapper because the wrapper's `report` command
writes nothing, by design and by test (`../break-glass-grant.md`, "The read-only
report"). This program only reads `report`'s output.

## What it does

1. Lists the tenants with a running Ghost container: `docker ps` over the
   Compose labels `com.docker.compose.project` (the slug) and
   `com.docker.compose.service` (`ghost-a` or `ghost-b`). A tenant with both
   colours up is read once. A project name that is not a slug is ignored.
2. For each, runs `/usr/local/sbin/branchleft-break-glass report --tenant <slug>`
   with a 30 second limit and an environment of `PATH` alone.
3. Accepts the output only if it is one line of JSON with exactly the keys
   `tenant`, `state`, `lane`, `grantedAt`, `deadline`, `observedAt`, the tenant
   it was asked for, a state of `open`, `closed` or `unknown`, a lane of
   `consented`, `incident` or `null`, and ISO 8601 UTC times. A closed or
   unknown account must carry no lane and no clock. Anything else is refused
   whole.
4. Writes `support_access.prom` into `/var/lib/branchleft/support-access-exporter/`
   by temporary file, `fsync` and rename, mode `0644`. The directory is made by
   the host role, never by this program.

It reads no file and runs nothing else: the only calls are `docker ps` and the
wrapper's `report`. It never runs `grant`, `revoke`, `expire`, `status` or
`mint`, holds no credential, and takes no flag or environment value.

## The file is the contract

Every series carries the label `tenant` (the slug). All five are gauges.

| Series | Other label | Value | Present |
| --- | --- | --- | --- |
| `branchleft_support_access_state` | `state` = `open`, `closed` or `unknown` | `1` | one per tenant read |
| `branchleft_support_access_lane` | `lane` = `consented` or `incident` | `1` | only when the report gave a lane |
| `branchleft_support_access_granted_timestamp_seconds` | none | Unix seconds, three decimals | only when the report gave `grantedAt` |
| `branchleft_support_access_deadline_timestamp_seconds` | none | Unix seconds, three decimals | only when the report gave `deadline` |
| `branchleft_support_access_observed_timestamp_seconds` | none | Unix seconds, three decimals | one per tenant read |

A reader finds a tenant's state as the one `state` series for that tenant.
`unknown` is also what it means when there is no `state` series for the tenant,
and when the series' `observed` time is older than the reader's freshness limit.
The file is rewritten whole every run, so a stopped tenant's series is gone on
the next run. Series are sorted by tenant. Every metric has its `HELP` and
`TYPE` lines even when it has no sample.

Never in the file: a reason, a reference, a grant id or an identity.

## When a tenant has no series

A tenant has no series in a run when its `report` is refused, fails, times out,
prints anything but the one accepted line, or when the tenant has no running
Ghost container. The program logs the slug and a fixed reason to stderr, never
the report. It never writes `closed` for a tenant it could not read.

## When the run fails

The run exits `1` and the unit fails when the tenants cannot be listed (the file
is then rewritten with no series at all, so nothing stale remains) or when the
file cannot be written (the previous file is removed, so it cannot go stale).
A tenant that cannot be read is not a failed run: it is the ordinary absence
above. With a wrapper that has no `report` command yet, every tenant has no
series and the portal reads `unknown`.

## Delivery

Not delivered by this change. The host role must install the program, the two
units and the directory, and point the host's node_exporter at the directory
(`--collector.textfile.directory`); that is a separate gated apply.
