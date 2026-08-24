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

## Media isolation — what is settled and what is not

The component takes media storage as explicit inputs (`endpoint`, `region`,
`bucket`, `tenantPrefix`, `publicBaseUrl`, and the key pair) rather than
deriving them, and that shape is deliberate: **the platform's per-tenant media
isolation mechanism is not decided**, and the two live candidates produce
different values for the same fields.

What the supplier evidence established, and it cuts against the earlier
preference order rather than confirming it:

- Buckets are free at the margin — Object Storage is priced per account
  "regardless of how many Buckets you have" — but the account is capped at
  **100 buckets and 200 S3 credentials across all projects**. A bucket per
  tenant therefore consumes the entire published bucket allowance at 100
  tenants and sits on the credential cap during rotation. Whether those caps
  are raisable on request is not established, and it is the question that
  decides the candidate.
- Credential scoping is achievable **by bucket policy, not at key creation**,
  and both documented routes scope a key to a *whole bucket* — which is the
  bucket-per-tenant mechanism. Scoping a key to an object *prefix* inside a
  shared bucket is documented nowhere and has been tested by nobody, so the
  candidate that fits the caps is the one whose isolation primitive is
  undemonstrated.
- Public-read-but-not-listable must come from a bucket **policy** granting
  `s3:GetObject` on `<bucket>/*` and nothing on the bucket resource itself.
  The obvious `x-amz-acl: public-read` grants READ *on the bucket*, which in S3
  semantics is LIST — a listable bucket publishes the tenant roster, and it
  would fail silently because every image would still work.

Two consequences for this component, both of them present in the code rather
than left as a caveat:

1. `publicBaseUrl` is an explicit input, not derived from `endpoint` and
   `bucket`. Bucket-per-tenant and shared-bucket-with-prefix serve media from
   different URLs, and deriving one would hardcode the undecided answer.
2. Media deletion stays **append-only** by decision, not by omission — the
   property is load-bearing for restore simplicity and is kept rather than
   "fixed" during the migration.

The decision is not needed while one tenant is on the platform. It is needed
before a second, and the component does not need to change when it lands.

## Breaking changes in 1.0.0

The 0.x component targeted GCP: a per-tenant service account, a Cloud SQL
database and DB user, a GCS media prefix with IAM-condition write isolation,
Secret Manager secrets and a scale-to-zero Cloud Run service. None of that
exists here. Every input and every output changed, `@pulumi/gcp` and
`@pulumi/random` are no longer dependencies, and a 0.x caller does not compile
against 1.0.0. There is no migration path in code: a tenant moves by being
rebuilt on the new platform, which is the migration the programme is running
anyway.
