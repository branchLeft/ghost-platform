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
