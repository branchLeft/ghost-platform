# assert-slug-pattern-consistency.py

## Why this check exists

The same charset-and-length rule is written four times in this repository,
because the tenant slug becomes a Compose project name, a systemd instance
name, a MySQL identifier, a Docker volume name and an S3-compatible bucket
name, and each of those is checked by code that runs on a different host or
from a different workstation, with no shared import between them:

- `infra/tenant/naming.ts` (Pulumi, TS)
- `db/provision/naming.py` (db1, hand-run)
- `infra/provisioning/scripts/render-media-bucket-policy.py` (operator workstation)
- `app/provision/provision_tenant_volume.py` (app1, hand-run)

A fifth copy, in the sibling template repository, was found to have drifted
to a looser pattern than these four -- and nothing had ever verified these
four agreed with each other in the first place; the third of them was found
to match only "by luck", after a reviewer checked it by hand once the other
two had changed. This script is that missing verification, run on every
push.

It does not (and cannot, without a JS runtime it would then have to trust)
reach into the sibling tenant-template repository, whose own CI instead
executes this repository's *published* `@branchleft/ghost-platform-tenant`
package and checks its behaviour against that template's copy directly.

## Reserved-name probe scope

`db/provision/naming.py` is deliberately not checked against
`RESERVED_PROBES`: by the time DB provisioning ever runs against a slug,
`infra/tenant`'s `GhostTenant` component has already refused a reserved one
during `pulumi up`, so that module was never given the reserved-name check.
Excluding it from that one probe set is a recorded scope decision, not an
oversight this script failed to catch -- conflating it with a real charset
divergence would make this gate cry wolf on every future intentional
layering choice.
