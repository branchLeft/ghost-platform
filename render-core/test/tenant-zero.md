# tenant-zero.test.ts

## Tenant zero as a descriptor

`test/tenant-zero/blog.descriptor.json` is the live blog written as the
document the render core accepts: a `TenantStackDescriptor` (no owner address,
no secret), read from disk as JSON and passed to `validateTenantStack()` with
the blog's own repository as the claimant, because its slug is in the tenant
name register. The test renders the seven artefacts from it and pins each to
`test/golden/tenant-zero.*`.

Every plain value in the blog's stack configuration (`Pulumi.blog.yaml` in its
tenant repository) is checked against the descriptor field that now holds it,
using `test/tenant-zero/tenant-5.0.0/stack-config.json`. The stack's secrets
are not in that file.

The control case is the same descriptor with one thing wrong: an unknown field
at the top level or inside `ports` or `database`, a stray `ownerEmail`, a port
below 1024 or above 65535, a repeated port, a uid outside 30000 to 30999, the
name claimed by another repository or by none, and one breach each of INV-1,
INV-2 and INV-3. Each is refused.

## The reviewed difference

The running configuration was rendered by tenant component 5.0.0 from the
blog's tenant repository and placed on the app host by hand. Agents have no
shell on that host, so the comparison is against what 5.0.0 renders, not
against the files on disk there.

`test/tenant-zero/tenant-5.0.0/` is that render, recorded: the component's
`v5.0.0` source was compiled and run under Pulumi's mocks with the blog's stack
configuration and placeholder secrets. It holds `compose.yml`, `secrets.env`,
`identity.json` and `scalars.json` (the component's other outputs), plus
`live-edge-entry.json`, the blog's entry in the edge site registry and Caddy
block in `branchLeft/shared-infra` (`sites.ts`, `hetzner/edge/stack/Caddyfile`).
It is recorded rather than re-rendered because two versions of the component
cannot be installed together here. Regenerate it by compiling the `v5.0.0`
sources (`infra/tenant/*.ts` at that tag, their only dependency being
`@pulumi/pulumi`), constructing `GhostTenant` under mocks with
`stack-config.json`'s values, and writing out `composeFile`, `secretsEnvFile`,
`identity` and the scalar outputs.

`test/tenant-zero/diff.ts` flattens both sides into paths and lists every path
that was added, removed or changed. Before comparing:

- 5.0.0's one `ghost` service is read as `ghost-a`, and `ghost-b` must be its
  exact twin apart from the published port, or the test fails.
- 5.0.0's plain `S3Storage` settings are carried to the key that now holds each
  one under the scanning adapter, for images, media and files, so a changed
  value shows as a change and not as a removal beside an unrelated addition.
- Secret values are compared as present or absent; the recorded baseline holds
  placeholders only.

`test/tenant-zero/reviewed-diff.json` is the list. Each entry is a group of
paths, a status (`intended` or `defect`) and a one-line reason. The test fails
on a difference no entry covers, on an entry that matches nothing, and on a
difference two entries cover. The drift cases in the last block change the
database host, the media endpoint, the SMTP user and the published port, and
require each to come out unjudged: that is the control case for the list
itself.

`defect` means the render is as designed but the difference must not reach the
live host until something outside this package is done (a DNS record, a
mailbox, a host-side object). It does not mean the render core is wrong.
Neither `defect` entry has been resolved; both are live-step items.

## What this does not prove

- The files on the app host. Whether the compose placed there is byte-for-byte
  what 5.0.0 renders, and what Ghost's own settings currently hold, needs a
  read-only look on the host: `ghost-platform-docs`,
  `tenant-zero-descriptor-readonly-check.md`.
- The platform's real zones. The test uses the fixture zones, with the blog's
  domain outside every domain they own. Whether the production zones also keep
  `branchleft.co.uk` outside `ownedDomains` is settled where those zones are
  configured.
- `backup.encryptionRecipient` is a clearly marked placeholder. No artefact
  renders it (the test checks), and the real public recipient is read from the
  backup worker's recipients file, not guessed.
- `mail.ceiling`, `mail.estateCeiling` and `mail.identity.dkimSelector` are
  carried but rendered into no artefact here, so the comparison cannot show
  them. They are settled with the sending identity.
- `hostname.verifiedAt` is the instant the hostname was observed answering over
  HTTPS when this was written. It gates nothing for a blocked code-injection
  posture.

## The pickup premise

LLD-10 section 05 says the blog's tenant repository is the source of its theme
and content files. It is not. `ghost-tenant-blog` holds the stack
configuration and its CI and nothing else. A theme is uploaded through Ghost
admin and written into the tenant's content volume, posts are rows in the
tenant's database, and media is objects in its bucket. The descriptor therefore
cannot re-render a theme or content from a repository, and the estate
migration's "re-rendered from the tenant repository" row needs correcting at
source.
