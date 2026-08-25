# `@branchleft/ghost-platform-tenant`

The `GhostTenant` Pulumi component: everything one Ghost tenant needs on a
shared Hetzner app host.

## What it produces, and what it does not

**This component declares no cloud resources.** Every durable thing a tenant
uses already exists and is shared — the app host and the database host come
from the estate's own stack, object storage is an account-level service — so
what is genuinely per-tenant is *configuration*, and configuration is what this
renders:

| Output | Goes to |
|---|---|
| `composeFile` | `/opt/branchleft/<slug>/compose.yml` on the app host |
| `secretsEnvFile` (a Pulumi secret) | `/etc/branchleft/<slug>.env`, root-owned `0600` |
| `hostProvisioningCommand` | run as root on the app host, before the unit is enabled |
| `edgeRequestBodyMaxSize` | the tenant's site block in the edge's site registry |
| `composeUnit`, `stackDirectory`, `imageEnvPath` | the deploy path |
| `databaseName`, `databaseUser` | `db/provision/provision_tenant_db.py` |
| `identity` | read by `scripts/assert-no-tenant-deletes.py` |

A tenant's Pulumi stack is therefore the versioned, reviewed,
passphrase-wrapped record of that configuration, and its checkpoint is what the
delete guard protects.

## Three steps outside Pulumi

Each fails loudly rather than silently when it has not been done:

1. **The database.** `provision_tenant_db.py <slug>` on `db1`, as root. It
   prints the tenant's DB password once; that value is the component's
   `database.password` input and belongs in the tenant stack's own encrypted
   config, never in a plain config value.
2. **The volumes.** `provision_tenant_volume.py --uid <uid> <slug>` on the app
   host, as root. `--list-claims` reports which UIDs that host has already
   handed out. The rendered stack declares both volumes `external`, so a tenant
   whose volumes have not been provisioned fails to start rather than coming up
   on a volume Docker seeded — and re-owned — from the image.

   The UID register lives at `/etc/branchleft/tenant-uids/<slug>`, root-owned
   `0700`, deliberately **not** inside the tenant's content volume: unlink
   permission is governed by the containing directory rather than the file
   mode, and that volume is `0700` owned by the tenant, so a claim stored there
   is a claim its own subject can delete. The register is cross-checked against
   the volumes Docker holds, and a volume with no register entry is a refusal
   rather than a free UID.
3. **The secrets file.** Written by an operator from `secretsEnvFile`. No
   automated path may write it; `branchleft-deploy` writes only
   `/etc/branchleft/<slug>.image.env`.

## The runtime posture

Every tenant container carries the same floor, rendered by this component
rather than left to a hand-written Compose file: a distinct non-root UID from a
reserved range with its content volume owned to it at `0700`, `cap_drop: [ALL]`,
`no-new-privileges`, a read-only rootfs with `/tmp` as the only writable path
outside the content volume, `content/adapters` mounted read-only,
`pids_limit`/`mem_limit`/`memswap_limit`/`cpus`/`cpu_shares`/`ulimits`, bounded
`json-file` logging, and publishing to the app host's private address alone.

`assertRuntimePosture` re-reads the finished document inside
`renderComposeStack`, so there is no rendered stack that reaches a host without
having passed it, and the unit tests assert the *absence* of the Docker socket,
`cap_add`, `privileged`, `seccomp=unconfined`, a `0.0.0.0` publish and host
networking. A posture with no test for its absence is a comment.

Two things that check is careful about, because both were wrong in an earlier
draft. The app host's address is validated as an address — private IPv4 range,
no loopback, no leading-zero octet — rather than compared against the rendered
port string it produced, since a check whose expectation comes from its subject
cannot fail. And the posture check runs over the object *before* serialisation,
so it cannot see a value that only becomes document structure once written out;
the refusal for that lives in `yaml.ts`, which throws on any control character
rather than emitting a single-quoted scalar it cannot round-trip.

**What is asserted here is what the component renders, not what is on a host.**
Nothing in this package observes a running container's UID, volume mode, seccomp
state or AppArmor profile. Those are live checks that belong to the parity gate
and the host provisioning path.

Two controls in the same design are deliberately **not** this component's:

- The `DOCKER-USER` egress policy on each app host is host provisioning and
  lives in `branchLeft/shared-infra`'s `hetzner/provision/`.
- Kernel-level sandboxing (`runsc`/Kata) is a named escalation path, deferred
  on measurement rather than rejected.

## One number drives every upload limit

`uploadCeilingMib` (default 128) derives the `/tmp` tmpfs `size=`, the three
`theme__uploadLimits__*` values, the tenant's Caddy `request_body` limit at the
edge, and the tmpfs half of `mem_limit`. They are derived rather than set
independently because three limits that must agree is exactly the kind of thing
that drifts — and none of them substitutes for another:

- Only `theme__uploadLimits__*` bounds theme *extraction*: they are what Ghost
  hands to `gscan.checkZip`, and a proxy in front cannot see how far a
  compressed archive expands.
- Only the edge limit bounds the image, media, file and content-import paths,
  because Ghost's generic upload middleware sets no limit on those at all.
- The tmpfs `size=` is the backstop under both. A write past it fails one
  upload with `ENOSPC` rather than taking the host down.

`edgeRequestBodyMaxSize` is emitted in `MiB`, not `MB`: Caddy reads `MB` as a
power of ten while every other value here is a power of two, and a ~4.4%
disagreement in a set of numbers whose stated purpose is that they cannot
disagree is still a disagreement. **The component emits the value; nothing yet
carries it into the edge's site registry**, which lives in a different
repository — so today it is an output an operator has to place by hand.

`mem_limit` is the RSS budget **plus** the tmpfs ceiling, because tmpfs pages
are charged to the container's own memory cgroup. A tenant sitting at its RSS
budget with a full `/tmp` is OOM-killed; that is bounded and tenant-local by
construction, and it is why the two upload ceilings are set well below the sum.

## Media isolation — bucket per tenant, decided 2026-08-25

Each tenant's media lives in **its own Object Storage bucket**, reached with a
credential allowlisted by bucket policy to that bucket alone. That is candidate
(a) of the migration programme's doc 14 §6, chosen because its isolation
primitive is the one that has been demonstrated: a credential allowlisted to one
bucket in this account returned `AccessDenied` against another on a `list-type=2`
request — per-bucket key allowlisting working, and failing closed on
`ListBucket`. The alternative shape, one shared bucket with a per-key object
prefix, needs a policy `Condition` that Hetzner documents nowhere and nobody has
tested.

**What the component therefore does not take as input.** `bucket` and
`publicBaseUrl` are derived from the slug and the endpoint by `media.ts`, not
configured. A value a stack can set is a value a stack can set to another
tenant's bucket, and this is the platform's only isolation boundary for media —
so the safest configuration surface for it is none. `endpoint` and `region` stay
inputs: one Object Storage location holds every tenant's bucket.

There is no `tenantPrefix`. It separated tenants inside one shared bucket, and
it went with the shared bucket; Ghost treats the option as optional and stores
keys unprefixed without it. Keeping it would put a redundant path segment into
every published media URL for no isolation gain.

**Three properties this component depends on and does not create.** The bucket,
its versioning and its policy are made by an operator before a tenant stack
exists — Hetzner creates S3 credentials in its Cloud Console and not through any
API, so no automated path can do it. `render-media-bucket-policy.py` in this
repository renders the policy and the exact commands, and
`RUNBOOK-tenant-onboarding.md` §6 verifies them against the live bucket:

1. **Public-read but NOT listable.** Served by a bucket **policy** granting
   `s3:GetObject` on `<bucket>/*`, plus an explicit `Deny` of everything on the
   bucket resource itself. Never the `x-amz-acl: public-read` canned ACL — READ
   on a *bucket* is LIST in S3 semantics, so that would publish this tenant's
   object names and, through the bucket name, that the tenant exists. It fails
   silently: every image still loads.
2. **Append-only.** `s3:DeleteObject` is withheld from the tenant's own key by
   decision, not by omission, which is why media deletion from Ghost admin
   returns a 403. The property is load-bearing for restore simplicity. The
   operator's key keeps deletion, for teardown.
3. **A bucket with no policy is open to every key in its project.** Hetzner's
   default is that each key pair is valid for every bucket in the same project,
   so the policy is what creates the boundary rather than tightening one.

**The standing cost, and the horizon it binds at.** One bucket and one
credential per tenant, against account-wide caps of 100 buckets and 200 S3
credentials *across all projects* — so rotation, which needs two credentials for
one tenant briefly, sits on the credential cap near 100 tenants. Whether the
caps are raisable has never been asked; branchLeft/workspace#176 is that support
ticket, and a positive answer removes the constraint outright. The platform is
at one tenant.

## Breaking changes in 2.0.0

`GhostTenantMediaArgs` loses `bucket`, `publicBaseUrl` and `tenantPrefix`; the
component derives the first two from the slug and the endpoint. A 1.x caller
passing any of the three does not compile. `storage__S3Storage__tenantPrefix` is
no longer emitted, so a tenant that had media under a key prefix in a shared
bucket does not find it after upgrading — moving that media is a migration, not
an upgrade.

## Breaking changes in 1.0.0

The 0.x component targeted GCP: a per-tenant service account, a Cloud SQL
database and DB user, a GCS media prefix with IAM-condition write isolation,
Secret Manager secrets and a scale-to-zero Cloud Run service. None of that
exists here. Every input and every output changed, `@pulumi/gcp` and
`@pulumi/random` are no longer dependencies, and a 0.x caller does not compile
against 1.0.0. There is no migration path in code: a tenant moves by being
rebuilt on the new platform, which is the migration the programme is running
anyway.
