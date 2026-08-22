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
  from one repo per tenant, named `ghost-tenant-<name>` and generated from
  `ghost-platform-tenant-template`. That repo is public unless the tenant
  asked for it to be private, which is a question put to them before their
  onboarding starts: the repo and its name disclose that they are a customer.
  This repo is public and holds only the reusable component, so it never
  carries a tenant's name, hostname or config whatever any one tenant chose --
  a hostname and Cloud Run service name together are a tenant's identity, and
  a file listing them here would be a roster of every tenant at once,
  including the ones who chose private.

- **`hetzner-host-check/`** -- not a Pulumi program or a stack: a small
  project whose only job is proving `@branchleft/hetzner-host` (published
  from `shared-infra`) installs from the registry here and that its types
  and exports are usable from this repo's own dependency tree. No `.ts` file
  in it declares a resource this repo owns; `Host` is constructed once,
  under Pulumi's test mocks, inside `hetznerHostInstall.test.ts`. The real
  Hetzner host stack is `hosts/` below; this directory is deliberately not
  that stack, and it stays because it proves the install path with no cloud
  credentials at all, which `hosts/`'s own CI deliberately also avoids.

  **Install requires a token, against `https://npm.pkg.github.com`.** An
  anonymous request -- no `.npmrc` `_authToken`, no `NODE_AUTH_TOKEN` -- gets
  `401 Unauthorized`, even though the package's visibility is public; GitHub
  Packages authenticates every request to that registry regardless of the
  target package's own visibility. A workflow's own `GITHUB_TOKEN`, granted
  nothing beyond this repo's `packages: read`, is sufficient -- no grant on
  `shared-infra`, the publishing repo, is needed, because that identity is
  never checked once the package is public. Locally, any token with
  `read:packages` works the same way (see the repo-root `.npmrc`).

- **`hosts/`** -- one Pulumi program, one stack (`production`), for the
  Hetzner estate's application and database hosts: `app1` and `db1`, created
  together so their colocation with each other and with `edge1` is decided by
  one apply rather than by whatever `cx` stock existed on two different days.
  Consumes `@branchleft/hetzner-host` (exact-pinned) for the create pattern
  and the address plan; reads the `branchleft-hetzner-network` and
  `branchleft-hetzner-estate` stacks (homed in `shared-infra`) for the
  network id and the edge's *applied* location, and refuses to plan if that
  location does not match the address plan's. State lives on the Hetzner
  Object Storage backend under the passphrase provider -- not GCS -- and the
  stack's config carries no salt and no token. CI type-checks and unit-tests
  it (`.github/workflows/infra-hosts-ci.yml`) but does not plan or apply:
  the estate hcloud token and the stack passphrase are owner-held, and the
  apply is a platform-owner action until a gated CI apply path lands. Base
  pattern only: nothing here installs MySQL, Ghost or Compose -- those are
  delivered onto the hosts separately.

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
