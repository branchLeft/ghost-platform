# falsifying.test.ts

The render core's falsifying test (LLD-1 §06) compares `render(demo)` with
`render(transform(demo))`, placement held fixed, and requires every
difference to be attributable to the five unions or to `limits`, `caps` and
`expiresAt`. A difference in a name, a slug-derived path or a volume identity
fails, because those rebuild the tenancy.

This file runs that test against the rewired component rather than against
`render()` alone:

1. `transform()` promotes a demo, and `assertAttributablePromotionDiff` accepts
   the result.
2. `GhostTenant` accepts the promoted descriptor, and each artefact output is
   byte-identical to `render()` of it, so the component adds nothing a
   reviewer of the render core did not already see.
3. The component's identity keeps every slug- and placement-derived value of
   the demo, and its `image.env` is the demo's.
4. **Control case:** hand-edit one extra field (`appHostIp`) after the
   promotion, and the diff is rejected with an error naming that field.

The component takes no secret. The demo's owner address comes out of the
promoted descriptor before it is handed over, as a real promotion must do
before the descriptor is committed to a tenant repository, and it reaches the
host through the secrets file (index.md#the-owner-address).
