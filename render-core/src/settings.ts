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
 * Members/staff caps map to Ghost's host-limits setting one field at a
 * time; `null` means "no cap" on both sides, matching `LimitsSpec`.
 */

import type { CodeInjectionSpec, LimitsSpec } from './descriptor.js';

export interface CodeInjectionSettings {
  readonly codeinjection_head: string;
  readonly codeinjection_foot: string;
}

export interface HostLimitsSettings {
  readonly limits: {
    readonly members: { readonly max: number | null };
    readonly staff: { readonly max: number | null };
  };
}

export type GhostSettings = CodeInjectionSettings & HostLimitsSettings;

function codeInjectionSettings(codeInjection: CodeInjectionSpec): CodeInjectionSettings {
  if (codeInjection.kind === 'managed') {
    return { codeinjection_head: codeInjection.head, codeinjection_foot: codeInjection.foot };
  }
  return { codeinjection_head: '', codeinjection_foot: '' };
}

function hostLimitsSettings(limits: LimitsSpec): HostLimitsSettings {
  return {
    limits: {
      members: { max: limits.membersCap },
      staff: { max: limits.staffCap },
    },
  };
}

export function renderSettings(descriptor: {
  readonly codeInjection: CodeInjectionSpec;
  readonly limits: LimitsSpec;
}): GhostSettings {
  return {
    ...codeInjectionSettings(descriptor.codeInjection),
    ...hostLimitsSettings(descriptor.limits),
  };
}
