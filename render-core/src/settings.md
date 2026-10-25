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
