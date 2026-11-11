# compose.ts

## Two services, not one

`TenantDescriptor.ports` is a `PortTriple` rather than a single port because
two Ghosts run over one SQLite file with no contention, so blue/green applies
everywhere, demos included. Every kind gets a colour pair (`ports.a`,
`ports.b`) so a reconciler can start the new colour, verify it and only then
retire the old one — this module renders both services from one descriptor
rather than one service per render call, so a single `render()` output is a
complete, swappable stack.

`ports.health` is not a Compose port at all: the drain-flag health sidecar is
a separate, already-shipped process the edge probes directly, not a service
this file defines.

## Demo bind address

A demo binds to loopback, never `appHostIp`. Publishing the slots on a
non-loopback address would put every demo's Ghost on the shared demo host's
network, around the gate. A paying tenant keeps publishing on `appHostIp` —
`infra/tenant`'s existing, unchanged posture, needed because a tenant's app
host and edge host are different machines reached over the private network.
A demo's broker, edge and Ghost all run on the same host, so loopback is both
sufficient and the thing that keeps every demo's Ghost from being reachable
at all except through the gate (and the broker's own `adminApi.configure`
call, `services/broker/src/app.ts`, which is itself a loopback call for
exactly this reason).

This makes render's output for a "tenant zero"-equivalent descriptor
structurally different from what `infra/tenant/compose.ts` renders today
(one service, one port). See `render.ts`'s own note on that conflict, which
is called out there rather than silently resolved here.

## The mail network

With mail enabled, both colours join two networks: the stack's own `default`
network, which carries their published port as before, and the host spool's
internal network for this tenant (`spool.ts#mailSpoolNetworkName`). The mail
network is `external` here because the spool's own stack creates and owns it.
So a Ghost started before its host's spool fails to start, rather than
starting with nowhere to send mail. `default` has to be named once any
network is listed, or Compose drops it and the published port with it.

## The metrics volume

A paying tenant mounts a third named volume, `ghost-<slug>-metrics`
(`naming.ts#metricsVolumeName`), read-write at `/var/lib/ghost/metrics` in
both `ghost-a` and `ghost-b`, and declares it `external`. It is the
directory the scanning adapter writes its Prometheus textfile into
(`environment.md#scanner-metrics-export`). The container root is read-only,
so the adapter needs a writable mounted volume to write at all. It is a
named volume of the tenant's own, never a shared directory and never a host
path: a shared directory would let one tenant overwrite another's file, and
`assertRuntimePosture` refuses a host path.

The tenant writes the volume and the host only reads it. A demo mounts
nothing there: the condition is `kind !== 'demo'`, the same one that
selects the object-storage environment that names the file.

**Rollout hazard.** The volume is `external`, so on a host where it does not
exist Compose refuses to start the stack. Before a render containing this
volume is deployed to a host, run `app/provision/provision_tenant_volume.py`
again for each existing tenant on it. The script is idempotent and creates
only the missing volume. The tenant image must carry the adapter's
unique-temporary-name write (`adapters/scanning-storage/src/metrics.md`) with
or before that render, because both colours now write into one directory.

## The stop grace period

Each Ghost service sets `stop_grace_period` to `GHOST_STOP_GRACE_PERIOD`
(60 seconds). Without it Docker waits 10 seconds after SIGTERM and then sends
SIGKILL, which can cut a send batch in half. The value is provisional: the
issue names no batch duration, so 60 seconds is an assumption, six times
Docker's default. The two-instance harness measures the real batch, and that
measurement replaces this constant.

`assertRuntimePosture` refuses a Ghost service without a whole-seconds
`stop_grace_period`, so dropping the line fails the render rather than
shipping a stack that is killed mid-batch.

Every tenant rendered by this module gets the setting: the entry and
professional tenants, tenant zero, and each demo slot. The mail spool is not
a Ghost service and keeps its own stop behaviour.

## One running colour

`activeColour` (`'a'` or `'b'`) is an optional input. When present, the
document carries only that colour's Ghost service; the idle colour is omitted
outright, not parked behind a Compose profile, because a profile still leaves
the service one flag away from starting beside the other. The shared volumes,
the mail network and every posture control are unchanged. When absent, the
output is byte-identical to a render that never knew the option, which is what
every existing golden pins.

The option is deploy-time state, so it is an input to `render()` (a fourth
argument, `{ activeColour }`) rather than a descriptor field: the descriptor
stays the tenant's desired state and the broker's request schema does not
change. A value other than `'a'` or `'b'` is refused with a named error.

Why it makes one Ghost run at a time: the generic unit runs
`docker compose up -d --remove-orphans --wait` with no service name. On a
one-service document that starts the named colour and stops and removes the
other colour's container as an orphan, with no change to the unit.

What this does not do: it does not refuse a second simultaneous start. That
refusal is the broker's apply step, which is not built here. A caller that
names a service on the command line (the demo host's per-colour drop-ins run
`up -d --wait ghost-<colour>`) must keep rendering both colours.
