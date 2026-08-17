# infra/

This repo's IaC, split by shape rather than lumped into one program:

- **`platform/`** -- one Pulumi program, one stack (`platform`), for the
  handful of GCP resources that exist exactly once for the whole platform
  and are not specific to any tenant: the shared Cloud SQL instance, the
  tenant image's Artifact Registry repository, the shared media bucket. Also
  holds this repo's CI identity -- a Workload Identity Federation pool and
  provider scoped to this repository, and the deployer service account they
  federate into. Applied by CI on every push to `main`
  (`.github/workflows/infra-platform-ci.yml`), on a cadence closer to
  "rarely" -- it doesn't change per tenant. The one exception is the initial
  bootstrap, which has to run locally because it creates the identity CI
  needs in order to run at all: see
  [`platform/RUNBOOK-bootstrap.md`](platform/RUNBOOK-bootstrap.md).

- **`tenant/`** -- a reusable Pulumi **component** (`GhostTenant`), not a
  stack: the per-tenant resources (a dedicated service account, logical
  database + DB user, storage write-isolation, Cloud Run service) that *do*
  change per tenant. Takes the platform stack's outputs as plain
  constructor args rather than resolving a `StackReference` itself, so it
  stays portable and testable independent of any one caller. Published to
  GitHub Packages as `@branchleft/ghost-platform-tenant` and instantiated
  from one private repo per tenant, generated from
  `ghost-platform-tenant-template`. This repo is public, so it holds the
  reusable component but never a tenant's name, hostname or config -- a
  hostname and Cloud Run service name together are a tenant's identity, and
  a file listing them would be a client roster.

- **`hetzner-host-check/`** -- not a Pulumi program or a stack: a small
  project whose only job is proving `@branchleft/hetzner-host` (published
  from `shared-infra`) installs from the registry here and that its types
  and exports are usable from this repo's own dependency tree. No `.ts` file
  in it declares a resource this repo owns; `Host` is constructed once,
  under Pulumi's test mocks, inside `hetznerHostInstall.test.ts`. The real
  Hetzner host stack -- the thing that will call `Host` to create an actual
  server -- is a future addition here, once one is needed; this directory is
  deliberately not that stack.

Why split at all, rather than one program with a `sites`-style array (the
shape `shared-infra/sites.ts` uses for the edge)? That pattern fits the edge
because every site there shares one load balancer -- the array *is* the
resource graph. It doesn't fit here: `platform/`'s resources exist once,
full stop, while a tenant's resources are a repeated unit instantiated per
tenant from a different repo entirely. A shared array in this repo would
either force tenant identity into a public repo -- the thing the per-tenant
repo split exists to prevent -- or force the reusable component to import a
stack it has no business depending on. Two directories, two different Pulumi
artifact shapes (stack vs. component), keeps that boundary honest.
