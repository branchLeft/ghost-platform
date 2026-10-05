# naming.ts

## Slug-derived names

Every name this package derives from a tenant slug, in one place, including
the reserved-name list and the MySQL slug-length limit: a wrong slug here is
not harmless the moment a caller picks tenant slugs, so both stay part of
this package's own validation rather than left to a caller. `validate()`
calls `validateSlugAvailability` alongside the grammar check
`brand.ts#validateSlug` already does.

## RESERVED_STACK_NAMES

`blog` is deliberately absent although a live stack of that name runs on an
app host. It is tenant zero's own slug: the live blog's descriptor must
validate and render, so reserving it would make the package refuse the one
tenant it exists to describe. This matches `infra/tenant/naming.md`, which
leaves it unreserved for the same reason. The list is `infra/tenant`'s floor
plus `mail-spool` (the host spool's stack, rendered by this package);
`naming.test.ts` pins the two together, so a name added to one side alone
fails the build. Slug uniqueness across tenants is a separate problem that
neither list can answer.
