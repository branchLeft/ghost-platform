# spool.ts

## Overview

LLD-6 §03 puts exactly one mail spool on every tenant host and demo host. It
is the queue Ghost hands mail to on both of its paths, and it never dials out.
ops1's collector drains it and submits what it drains to mx1. This module
renders that spool as its own Compose stack, `mail-spool`, run by the same
`branchleft-compose@` template as every other stack on the host.

The spool is per host, not per tenant, so `render()` (one descriptor, one
tenant) does not emit it. `renderMailSpoolStack` takes the uid of every tenant
or demo slot on the host instead, the same fleet-level shape as
`renderDrainList`.

What it does not touch: mx1, its shim and the blog's mail path. The blog keeps
sending through mx1's shim. Nothing here renders anything for mx1.

## One network per tenant

Each tenant (or demo slot) gets its own internal network,
`branchleft-mail-<uid>`. That tenant's Ghost colours and the spool are on it,
and nothing else is. A single network shared by every tenant would let one
tenant's Ghost open connections to another tenant's Ghost, which the host's
policies otherwise prevent. One network per tenant keeps that boundary, and
the spool, which routes nothing between its interfaces, is the only thing two
tenants' networks have in common.

Every one of these networks is `internal: true`. Docker gives an internal
network no gateway, so the spool's SMTP front door and API have no route off
the host through any network a tenant can reach. The spool stack owns and
creates them, and each Ghost stack names its own one as `external`, so a
Ghost whose spool stack is not up fails to start rather than starting
without mail.

The network is keyed on the uid, never the slug: a demo's slug changes every
lease, and its slot's uid does not.

## The drain port

ops1's collector reaches the spool through an SSH local forward it dials,
which lands on the spool's port on the host's loopback (LLD-6 addendum
`06a-ops1-reaches-spools.md` in `ghost-platform-docs`, the owner's ruling on
ops1's tunnel). That note requires the drain listener to be bound to
`127.0.0.1`, never a public or wildcard address. So the spool publishes
exactly one port, `127.0.0.1:<drainPort>:8080`, and the posture check refuses
any other.

## The drain network

Docker publishes no port for a container whose only networks are internal,
so the published drain port needs one network with a gateway. That network
is `branchleft-mail-spool-drain`, and it is constrained three ways:

- its bridge interface is named `br-mailspool`, so a host policy can match it
  by name. On demo1 it is inside the existing `br-+` egress policy
  (`demo-host/provision/branchleft_demo_egress.sh`), which refuses every
  connection a bridged container opens off its own bridge.
- IP masquerade is off, so a packet the spool sends towards the gateway
  leaves with a container address nothing outside the host routes back to.
- no tenant's Ghost is on it.

On an app host, which has no equivalent of demo1's egress policy, the
"no route off the host" property for this one network rests on a host rule
that does not exist yet. That host's spool must not be delivered until it
does.

## The posture check

`assertSpoolPosture` re-reads the rendered document, the same pattern as
`compose.ts`'s `assertRuntimePosture`, and `renderMailSpoolStack` runs it
before returning. It refuses:

- any network other than the drain network that is not `internal: true`, or
  that the file does not own;
- a missing `networks` list (Compose would join the default network, which
  has egress);
- the drain network without its fixed bridge name or with masquerade on;
- any port other than the one loopback drain port, and any `expose`;
- the drain token as anything but a `${VAR:?...}` reference;
- an ephemeral queue, an overridden SMTP bind, an image not pinned by digest,
  any mount but the spool's own data volume;
- the usual runtime hardening missing (`read_only`, `init`, `cap_drop`,
  `no-new-privileges`, limits).

## What Ghost is given

`environment.ts` points Ghost at the spool from the constants here, so the two
cannot disagree: the bulk sender's Mailgun base URL is `MAIL_SPOOL_BASE_URL`,
and a `queue` transport's SMTP host and port are `MAIL_SPOOL_SERVICE` and
`MAIL_SPOOL_SMTP_PORT`. The SMTP username is the tenant's sending domain and
the password is the same per-tenant key the bulk path already uses, which is
how the spool's SMTP front door authenticates a submitter.
