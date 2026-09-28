# parity.test.ts

## The parity proof

The real tenant-zero parity proof: a real key-by-key diff against
`infra/tenant`'s own renderer, not a substring check against a made-up
fixture claiming parity it never tested.

`INFRA_TENANT_BLOG_ENV` below is not fabricated or hand-typed: it is the
literal, recorded output of `infra/tenant/environment.ts`'s own
`tenantEnvironment()` — the actual module `blog`'s live Pulumi stack imports
as `@branchleft/ghost-platform-tenant` — called directly with
`ghost-tenant-blog`'s real `Pulumi.blog.yaml` config values (secrets
excluded; neither renderer receives one, both emit only a reference),
`render-core/test/runtime.js#uploadLimits()`'s defaults, and
`/etc/branchleft/blog.env` as the secrets path. Recorded rather than called
live at test time because `render-core-ci.yml` runs `npm ci` inside
`render-core/` only (`working-directory: render-core`); a live cross-package
import of `infra/tenant/environment.ts` resolves locally (both packages
checked out in one worktree) but fails in CI, where `infra/tenant`'s own
`node_modules` and `@branchleft/tsconfig` dev dependency are never
installed.

## Known gap keys

The eleven `storage__*` keys are the one remaining gap: `infra/tenant/environment.ts`
still renders bare `storage__active`/`storage__S3Storage__*` (recorded,
frozen, in `INFRA_TENANT_BLOG_ENV` above), because `blog` (tenant-zero) has
not been migrated onto the scanning decorator — that migration is separate
work from shipping the decorator in render-core. `EXTRA_IN_CORE_KEYS` below
names what render-core renders instead. The mail-transport gap
`environment.ts#transportEnvironment`'s own doc comment used to name is
closed — see the known-diverged-keys section for what render-core renders
for those four keys instead of a fifth gap.

## Known diverged keys

Render-core now renders all four sending-identity keys
`transportEnvironment` cannot carry. Two of them,
`bulkEmail__mailgun__domain` and `__apiKey`, match `INFRA_TENANT_BLOG_ENV`
exactly, because both sides derive the domain from the same fact (blog's own
sending domain) and the same secret-reference name — they are ordinary
shared keys, not named here.

The other two are a deliberate, permanent divergence, not a defect:
`INFRA_TENANT_BLOG_ENV` is a recorded snapshot of `infra/tenant`'s
*pre-sending-identity* renderer, which still points Ghost straight at mx1
(`mx1.branchleft.co.uk:8443`) — exactly the "Ghost dials into the main
estate" shape this component exists to correct. Render-core points at the
host's own mail spool instead (`ZONES.mailSpoolBaseUrl` above), so
`bulkEmail__mailgun__baseUrl` can never equal the old snapshot without
reintroducing the violation. `mail__from` diverges too, for a smaller
reason: the snapshot carries a human display name ("branchLeft blog <…>"),
which is prose for the platform owner to write, not a value this package
can synthesise — render-core emits the bare address the sending identity
actually names. `infra/tenant`'s own migration to the spool is separate,
un-scoped work; this test does not assume it has happened.
