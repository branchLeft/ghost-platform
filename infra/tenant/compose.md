# compose.ts

## The Compose stack one tenant runs on a shared app host

One Compose project per tenant, named for the tenant slug, which is what
`branchleft-compose@%i` and `branchleft-deploy` already take as their
instance name. Three properties follow from that and are the reason it is
one project per tenant rather than one project with N services: Docker's
`DOCKER-ISOLATION-STAGE-1/2` chains drop traffic between different
user-defined bridges, so co-tenant containers cannot reach each other over
the network at all; each tenant's secrets stay in its own root-owned env
file rather than in one file every tenant's containers read; and restart,
rollback and failure are per tenant.

Nothing here is optional. The runtime posture is rendered, not documented,
and `assertRuntimePosture` re-reads the finished document so a future edit
to this file that drops a control fails at construction rather than at an
incident.
