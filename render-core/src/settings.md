# settings.ts

## Ghost settings artefact

The Ghost settings a reconciler applies, and re-applies, through the Admin
API.

"Applied continuously, not once": an *empty* `codeinjection_head`/
`codeinjection_foot` is itself the thing a drift detector watches for, so
`renderSettings` always names both keys — including the empty string —
rather than omitting them when there is nothing to inject. A reconciler
that only wrote a non-empty value would never notice, let alone correct, an
injection added by some other path.

`codeInjection.kind`:
- `"blocked"` / `"granted"` never carry script — `granted` is a
  precondition-checked authorisation to receive a future `"managed"` grant,
  not content of its own (see `descriptor.ts`'s own doc comment) — so both
  render empty head/foot.
- `"managed"` is the one variant that carries script, already checked by
  `validate()`'s `checkCodeInjectionHostnamePrecondition` (a custom domain)
  before a descriptor reaches here.

**Host limits (`members`/`staff` caps) are not rendered here.** Ghost reads
them only from `config.get('hostSettings:limits')` — never from a setting
the Admin API can write — so they render as Compose environment
(`environment.ts#hostLimitsEnvironment`) instead; putting them in this
artefact cannot take effect against Ghost's real source.

**`social_web` is always `false`.** The admin's Network tab is ActivityPub's
surface and no federation service backs it yet. The setting alone does not
hide the tab, and a lock alone does not remove what an existing tenant
already has, so `environment.ts` locks the feature
(`hostSettings__limits__limitSocialWeb__disabled`) and this artefact turns
the setting off. Lifting the hide means removing both.

**`members_support_address` is the one Ghost actually reads before it sends
a member a magic link — `mail__from` (`environment.ts`) is not.** A sender
restriction upstream rejects the two disagreeing as an opaque HTTP 400,
with the real cause visible only in container output, so both are computed
from the same call to `mail.ts#renderSendingAddress` rather than from two
independent readings of the descriptor's sending identity.

**`heading_font` and `body_font` are always `''` ("Theme default").** Ghost's
Design settings font picker writes these two settings, and Ghost's `ghost_head`
helper then puts a stylesheet link to `fonts.bunny.net` (a third-party origin)
into every page of the site, which the platform's rule that a tenant page
requests nothing from another origin forbids. Both are writable through the
Admin API (they are in Ghost's settings-input allowlist), so, like the two
code-injection boxes, they are named on every apply: a font chosen by hand is
cleared again. The platform's own self-hosted fonts are a separate path
(`themes/README.md`, "How the fonts are served").

**`footerCredit` is the default footer credit, the same for every kind and
tier.** Ghost's own "Powered by Ghost" line stays: `keepGhostCredit` is always
`true`, and a theme renders the platform's credit beside Ghost's, never in
its place (Ghost's licence and theme terms keep the Ghost credit). `text` and
`url` are the placeholders `FOOTER_CREDIT_TEXT` and `PUBLICPRESS_MAIN_SITE_URL`
until the owner supplies the wording and the main-site address; the copy is
the owner's, so nothing here writes any. It is its own key, not a code
injection: the code-injection posture stays blocked and empty, and the credit
is not folded into `codeinjection_foot`. Ghost has no setting that holds it, so
this artefact names it and the theme layer renders it; the broker's Admin API
write names only the Ghost keys. Whether a tenant may turn it off, and on which
tier, is the owner's open question on a tracked issue; there is no
off switch and no descriptor field for it until that is answered.
