/**
 * The Ghost settings a reconciler applies, and re-applies, through the
 * Admin API — a **new** artefact per LLD-1 §04.
 *
 * "Applied continuously, not once": F11 established that an *empty*
 * `codeinjection_head`/`codeinjection_foot` is itself the thing a drift
 * detector watches for, so `renderSettings` always names both keys —
 * including the empty string — rather than omitting them when there is
 * nothing to inject. A reconciler that only wrote a non-empty value would
 * never notice, let alone correct, an injection added by some other path.
 *
 * `codeInjection.kind`:
 * - `"blocked"` / `"granted"` never carry script — `granted` is a
 *   precondition-checked authorisation to receive a future `"managed"`
 *   grant, not content of its own (see `descriptor.ts`'s own doc comment) —
 *   so both render empty head/foot.
 * - `"managed"` is the one variant that carries script, already checked by
 *   `validate()`'s `checkCodeInjectionHostnamePrecondition` (a custom
 *   domain) before a descriptor reaches here.
 *
 * **Host limits (`members`/`staff` caps) are not rendered here.** Ghost
 * reads them only from `config.get('hostSettings:limits')` — never from a
 * setting the Admin API can write — so they render as Compose environment
 * (`environment.ts#hostLimitsEnvironment`) instead; putting them in this
 * artefact (LLD-1 §04's own diagram box) cannot take effect against
 * Ghost's real source and was corrected on review.
 */

import type { CodeInjectionSpec } from './descriptor.js';

export interface CodeInjectionSettings {
  readonly codeinjection_head: string;
  readonly codeinjection_foot: string;
}

/**
 * The same text for every tenant on every tier, an administrator meets
 * when they go looking for code injection and find it removed rather than
 * merely defaulted off (LLD-1 §03b: "an administrator who goes looking for
 * it meets an explainer rather than a missing menu"). Prose is Rob's to
 * write; this is a placeholder for the real copy.
 */
export const CODE_INJECTION_EXPLAINER = 'ALL_CAPS_PLACEHOLDER: code injection explainer copy';

export interface GhostSettings extends CodeInjectionSettings {
  readonly codeInjectionExplainer: string;
}

function codeInjectionSettings(codeInjection: CodeInjectionSpec): CodeInjectionSettings {
  if (codeInjection.kind === 'managed') {
    return { codeinjection_head: codeInjection.head, codeinjection_foot: codeInjection.foot };
  }
  return { codeinjection_head: '', codeinjection_foot: '' };
}

export function renderSettings(descriptor: {
  readonly codeInjection: CodeInjectionSpec;
}): GhostSettings {
  return {
    ...codeInjectionSettings(descriptor.codeInjection),
    codeInjectionExplainer: CODE_INJECTION_EXPLAINER,
  };
}
