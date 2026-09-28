# naming.ts

## Slug-derived names

Every name this package derives from a tenant slug, in one place, including
the reserved-name list and the MySQL slug-length limit: a wrong slug here is
not harmless the moment a caller picks tenant slugs, so both stay part of
this package's own validation rather than left to a caller. `validate()`
calls `validateSlugAvailability` alongside the grammar check
`brand.ts#validateSlug` already does.
