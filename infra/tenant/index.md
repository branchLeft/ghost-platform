# index.ts

## GhostTenantMediaArgs

The platform-wide half of media addressing, plus this tenant's own S3 key
pair.

**The bucket and the public base URL are deliberately not here.** Each tenant
has its own bucket, named from its slug by `media.ts`, so there is no value
for a tenant stack to set — and therefore no value a stack could set to
another tenant's bucket. Both are exported from this component so the
operator who creates the bucket and the container that writes to it read one
derivation.

The key pair lands in the secrets file rather than the Compose file. The key
id is not itself a secret; splitting a credential pair across two files makes
rotating it two edits instead of one.

## GhostTenant

Everything one Ghost tenant needs on a shared Hetzner app host, rendered
rather than created.

**This component declares no cloud resources, and that is the design.** Every
durable thing a tenant uses already exists and is shared: the app host and
the database host come from the estate's own stack, the tenant's database
and DB account are created on `db1` by `db/provision/provision_tenant_db.py`,
and object storage is an account-level service. What is genuinely per-tenant
is *configuration* — a Compose stack carrying a runtime-isolation posture, a
secrets file, a UID, two volumes and a set of Ghost environment variables —
and that is what this produces. The tenant's Pulumi stack is therefore the
versioned, reviewed, passphrase-wrapped record of that configuration, and
its checkpoint is what a delete guard has to protect.

Three steps outside Pulumi have to have happened before the stack this
renders will start, and each fails loudly rather than silently if it has
not: the tenant's database and DB account on `db1`
(`provision_tenant_db.py`), the tenant's two named volumes on the app host
owned by `uid` at `0700` (`app/provision/provision_tenant_volume.py`), and
the secrets file at `/etc/branchleft/<slug>.env`.

## Constructor identity object

Computed before super() and passed as its props rather than `{}`, then
reused (not recomputed) for `this.identity` below: a ComponentResource's
step in a preview is derived from whether its registered inputs changed,
so empty props can never produce a step, and `identity_changes()` in
`scripts/assert-no-tenant-deletes.py` has no step to read a comparison
from. One object rather than two copies of the same fields means the
props super() registers and the output the guard also reads cannot drift
apart — a preview's new-state carries only the registered inputs, never
the computed output (Pulumi does not resolve a component's outputs until
an actual apply), so a mismatch between the two would hide an in-flight
identity change on exactly the run meant to catch it.
