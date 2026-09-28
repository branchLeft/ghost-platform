/**
 * The Ghost settings a reconciler applies, and re-applies, through the
 * Admin API. Code injection always names both keys, even empty, so drift
 * detection works; host limits render as environment instead, not here.
 * See settings.md.
 */

import type { CodeInjectionSpec, MailSpec } from './descriptor.js';
import { renderSendingAddress } from './mail.js';
import type { ZoneConfig } from './validate.js';

export interface CodeInjectionSettings {
  readonly codeinjection_head: string;
  readonly codeinjection_foot: string;
}

/**
 * The same text for every tenant on every tier, an administrator meets
 * when they go looking for code injection and find it removed rather than
 * merely defaulted off (LLD-1 §03b: "an administrator who goes looking for
 * it meets an explainer rather than a missing menu"). The owner writes the
 * real copy; this is a placeholder.
 */
export const CODE_INJECTION_EXPLAINER = 'ALL_CAPS_PLACEHOLDER: code injection explainer copy';

export interface GhostSettings extends CodeInjectionSettings {
  readonly codeInjectionExplainer: string;
  readonly members_support_address: string;
}

function codeInjectionSettings(codeInjection: CodeInjectionSpec): CodeInjectionSettings {
  if (codeInjection.kind === 'managed') {
    return { codeinjection_head: codeInjection.head, codeinjection_foot: codeInjection.foot };
  }
  return { codeinjection_head: '', codeinjection_foot: '' };
}

export function renderSettings(
  descriptor: {
    readonly codeInjection: CodeInjectionSpec;
    readonly mail: Pick<MailSpec, 'identity'>;
  },
  zones: Pick<ZoneConfig, 'demoMailDomain'>
): GhostSettings {
  return {
    ...codeInjectionSettings(descriptor.codeInjection),
    codeInjectionExplainer: CODE_INJECTION_EXPLAINER,
    members_support_address: renderSendingAddress(descriptor.mail.identity, zones),
  };
}
