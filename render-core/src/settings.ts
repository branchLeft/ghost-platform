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

/**
 * The default footer credit every tenant and demo carries, extending Ghost's
 * own "Powered by Ghost" line rather than replacing it. The owner writes the
 * real text and link; both are ALL_CAPS placeholders until then (see
 * settings.md, "Default footer credit").
 */
export const FOOTER_CREDIT_TEXT = 'FOOTER_CREDIT_TEXT';
export const FOOTER_CREDIT_URL = 'PUBLICPRESS_MAIN_SITE_URL';

export interface FooterCreditSettings {
  /** The credit's wording: a placeholder until the owner supplies it. */
  readonly text: string;
  /** Where the credit links: the main site, a placeholder until supplied. */
  readonly url: string;
  /** Always `true`: Ghost's own credit stays and the platform's follows it. */
  readonly keepGhostCredit: true;
}

export interface GhostSettings extends CodeInjectionSettings {
  readonly codeInjectionExplainer: string;
  /** The same default for every kind and tier: see settings.md. */
  readonly footerCredit: FooterCreditSettings;
  readonly members_support_address: string;
  /** Always `''` (Ghost's "Theme default"): see settings.md. */
  readonly heading_font: string;
  /** Always `''` (Ghost's "Theme default"): see settings.md. */
  readonly body_font: string;
  /** Always `false`: see `environment.ts`, where the same feature is locked. */
  readonly social_web: boolean;
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
    footerCredit: { text: FOOTER_CREDIT_TEXT, url: FOOTER_CREDIT_URL, keepGhostCredit: true },
    members_support_address: renderSendingAddress(descriptor.mail.identity, zones),
    heading_font: '',
    body_font: '',
    social_web: false,
  };
}
