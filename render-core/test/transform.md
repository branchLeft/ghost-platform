# transform.test.ts

## The falsifying test

Compares `render(demo)` with `render(transform(demo))`, placement held
fixed. Every difference must be attributable to the five unions --
`database`, `media`, `hostname`, `gate`, `backup` -- or to `limits`, `caps`
and `expiresAt`. A difference in a name, a slug-derived path or a volume
identity fails: those rebuild the tenancy, and the design's own claim is
that promoting a demo is a re-point rather than a migration precisely
because nothing here needs one to.

Run once per paid tier — five is five whichever tier is on the other end —
each time with that tier's own `limits`/`media.resize`/`media.srcsets`
values taken directly from this repo's own
`entryTenantDescriptor()`/`professionalTenantDescriptor()` fixtures --
`transform()` invents no tier policy of its own; see `transform.ts`'s
module doc comment.

## Promotion targets by tier

Deliberately outside every zone `TEST_ZONES` owns and RFC 2606-reserved,
matching `fixtures.ts`'s own test-only-domain convention, for the
operational fields `transform()` has no authority to decide
(`databaseHost`/`databasePort`/`mediaEndpoint`/`mediaRegion`/
`backupEncryptionRecipient`/`mailIdentity`). The tier-differentiated fields
(`limits`/`mediaResize`/`mediaSrcsets`/`mailEnabled`/`mailCeiling`/
`mailEstateCeiling`) are NOT invented here -- they are read straight off
this repo's own pre-existing, unmodified fixtures, so a future change to
what "entry" or "professional" means updates this test for free rather than
silently drifting from it.
