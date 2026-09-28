# provision_tenant_volume.py

## Overview

Run by hand on the app host itself (as root, once per tenant onboarded,
before that tenant's `branchleft-compose@<slug>` unit is enabled):

```sh
provision_tenant_volume.py --uid 30001 blog
```

The app-host analogue of `db/provision/provision_tenant_db.py`, and the one
step in the tenant path whose absence is invisible at runtime. Everything
else in the runtime posture announces a mistake: a wrong capability set
crashes the boot, a missing writable path fails an upload. This one does
not. Without it a tenant container still starts, still serves, and still
runs as its own UID — on a volume Docker seeded from the image, which the
official Ghost image leaves world-writable (`chmod 1777` on the content
directory, because it is built for one site per host). Every co-tenant UID
on the host can then read and write that tenant's content the moment
anything escapes its mount namespace.

Three mechanics this script exists to get right, none of them discoverable
late:

1. **Docker re-applies the image path's ownership and mode to a volume it
   populates itself.** Ownership asserted before a first start is silently
   overwritten by that copy-up, which fires on any *empty* volume. So this
   script drops a seed file in the content volume: a non-empty volume is
   never copied into, the image's `1777` never lands, and Ghost's own
   entrypoint still seeds `content.orig` afterwards — it tests each sub-path
   individually (`[ ! -e "$target" ]`), not the directory as a whole.
   Declaring the volumes `external` in the rendered stack is a separate
   control and only stops Compose *creating* one; it does nothing about
   copy-up.

2. **The UID register lives where the tenant cannot write.**
   `/etc/branchleft/tenant-uids/<slug>`, root-owned `0700` directory, `0600`
   files. It is not in the content volume, because unlink permission is
   governed by the containing directory rather than the file mode, and that
   volume is `0700` owned by the tenant — a claim stored there is a claim
   its own subject can delete, and a deleted claim reads as "unclaimed",
   which never compares equal to a real UID. The register is cross-checked
   against the volumes Docker holds, and a volume with no register entry is
   a refusal rather than a free UID.

3. **A UID change on a provisioned volume is a data loss, not an update.**
   The content is `0700` to the old UID; re-owning it under a different
   tenant hands one tenant another's data, and re-owning it under the same
   tenant with a new number is a migration with a copy step. Either way it
   is refused here rather than performed silently.

**Residual, stated rather than implied.** A tenant can delete the seed file
in its own volume — it owns that directory — which re-arms copy-up on that
one volume and would restore the image's world-writable mode there at the
next start. It cannot free a UID, cannot reach another tenant's volume, and
cannot touch the register. Closing the remainder needs a change to the
ownership shape the runtime posture records, which is a decision rather
than a fix.

## Slug pattern

Mirrors `infra/tenant/naming.ts`'s slug rules, including the reserved names:
a tenant slugged `website` would collide with the marketing site's stack.
The trailing character is restricted to a letter or digit for the same
reason it is there: `infra/tenant/media.ts` turns the same slug into an
S3-compatible bucket name, which must both start and end with one. Nothing
imports the rule across those files, so this copy can drift loose —
accepting a trailing hyphen, say — without any other test going red;
`scripts/assert-slug-pattern-consistency.py` is what compares them.

`blog` is deliberately absent, as it is on the TypeScript side: it is the
live tenant-zero's own slug (this file's own docstring re-runs against it as
ordinary maintenance), not a non-tenant name, so reserving it would refuse
the one tenant that legitimately holds it rather than protect against a
collision.

## UID register

One file per tenant, in a root-owned 0700 directory on the host.
Deliberately NOT inside the tenant's content volume, which an earlier form
of this script used.

Unlink permission is governed by the containing directory, not the file's
own mode, and the content volume is 0700 *owned by the tenant* — so a claim
stored there is a claim the tenant can delete. That is not a theoretical
reach: deleting it makes this script read the slug as unclaimed, and a
missing claim never compares equal to a real UID, so the next tenant
provisioned on that number would have been accepted onto it. The register
has to sit where the subject of the check cannot write.
