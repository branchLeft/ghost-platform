# infra/

This repo's IaC, split by shape rather than lumped into one program:

- **`platform/`** -- one Pulumi program, one stack (`platform`), for the
  handful of GCP resources that exist exactly once for the whole platform
  and are not specific to any tenant: the shared Cloud SQL instance, the
  tenant image's Artifact Registry repository, the shared media bucket.
  Applied by a human from a workstation, on a cadence closer to "rarely" --
  it doesn't change per tenant.

- **`tenant/`** (not yet created -- lands in the next story) -- a reusable
  Pulumi **component**, not a stack: the per-tenant resources (a tenant's
  logical database, DB user, HMAC key, Cloud Run service) that *do* change
  per tenant, parameterized and instantiated once per tenant by the private
  `ghost-platform-tenants` repo's stack configs (see
  `ghost-platform-docs/03-onboarding-and-repo-strategy.md`'s repo-split
  decision -- this repo is public and stays public, so it can hold the
  reusable component, but never a tenant's actual name, hostname, or
  config, which live in the private tenants repo instead).

Why split at all, rather than one program with a `sites`-style array (the
shape `shared-infra/sites.ts` uses for the edge)? That pattern fits the edge
because every site there shares one load balancer -- the array *is* the
resource graph. It doesn't fit here: `platform/`'s resources exist once,
full stop, while a tenant's resources are a repeated unit instantiated per
tenant from a different repo entirely. A shared array in this repo would
either force tenant identity into a public repo (the thing doc 03's repo
split exists to prevent) or force the reusable component to import a stack
it has no business depending on. Two directories, two different Pulumi
artifact shapes (stack vs. component), keeps that boundary honest.
