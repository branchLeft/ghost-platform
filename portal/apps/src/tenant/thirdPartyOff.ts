import { escapeHtml } from '../shell/html.js';

/**
 * Why FirstPromoter and Transistor are switched off for a tenant served with
 * its own-origin widgets. The tenant reads it in two places: one block on the
 * Essentials site screen, and one line on the Essentials request screen.
 *
 * Structure only. Every word is an ALL_CAPS placeholder naming a slot; the
 * prose is the owner's and replaces the values in `THIRD_PARTY_OFF_COPY` and
 * nowhere else. A slot still holding its placeholder is never shown to a
 * tenant: unless the deployment says placeholders are wanted
 * (`PORTAL_ALLOW_PLACEHOLDER_COPY=1`, for a ring under inspection), the block
 * and the line are left out, and the process says so once, at start.
 */

export interface ThirdPartyOffCopy {
  readonly heading: string;
  readonly body: string;
  /** The text of the link a tenant follows to ask for one of the two back. */
  readonly linkLabel: string;
  /** The one line on the Essentials request screen. */
  readonly onboardingLine: string;
  /**
   * Where a tenant asks for one of the two back: a path of this portal, an
   * https address or a mailto address. Empty until the owner says, and then
   * there is no link.
   */
  readonly requestRoute: string;
}

export const THIRD_PARTY_OFF_COPY: ThirdPartyOffCopy = {
  heading: 'THIRD_PARTY_OFF_HEADING',
  body: 'THIRD_PARTY_OFF_BODY',
  linkLabel: 'THIRD_PARTY_OFF_LINK_LABEL',
  onboardingLine: 'THIRD_PARTY_OFF_ONBOARDING_LINE',
  requestRoute: '',
};

/** The slot name each field of the copy stands for, for the error line and the tests. */
export const THIRD_PARTY_OFF_SLOTS: Readonly<Record<keyof ThirdPartyOffCopy, string>> = {
  heading: 'THIRD_PARTY_OFF_HEADING',
  body: 'THIRD_PARTY_OFF_BODY',
  linkLabel: 'THIRD_PARTY_OFF_LINK_LABEL',
  onboardingLine: 'THIRD_PARTY_OFF_ONBOARDING_LINE',
  requestRoute: 'THIRD_PARTY_OFF_REQUEST_ROUTE',
};

// Capitals, digits, underscores and spaces only: prose has a lowercase letter or a character outside ASCII.
const PLACEHOLDER = /^[A-Z0-9_ ]+$/;

/** True for an empty value or one that is still an ALL_CAPS placeholder. */
export function isUnfilled(value: string): boolean {
  const text = value.trim();
  return text === '' || PLACEHOLDER.test(text);
}

/**
 * The address a request route names, or undefined when it names none. Only a
 * path of this portal, an https address or a mailto address is a route; a
 * scheme such as `javascript:` is not.
 */
export function routeOf(value: string): string | undefined {
  const text = value.trim();
  if (text === '' || /[\s\\\u0000-\u001f]/u.test(text)) return undefined;
  if (text.startsWith('/')) return text.startsWith('//') ? undefined : text;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' || url.protocol === 'mailto:' ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The slots that keep the block, or the line, from being shown to a tenant: the
 * ones still holding a placeholder (or a route that is not one) that must be
 * filled. Names only, never a value.
 */
export function blockGaps(copy: ThirdPartyOffCopy): string[] {
  const route = routeOf(copy.requestRoute);
  const gaps: string[] = [];
  if (isUnfilled(copy.heading)) gaps.push(THIRD_PARTY_OFF_SLOTS.heading);
  if (isUnfilled(copy.body)) gaps.push(THIRD_PARTY_OFF_SLOTS.body);
  // A route that is set but is not one cannot be shown as a link, and is not left to read as text.
  if (copy.requestRoute.trim() !== '' && route === undefined) {
    gaps.push(THIRD_PARTY_OFF_SLOTS.requestRoute);
  }
  if (route !== undefined && isUnfilled(copy.linkLabel)) gaps.push(THIRD_PARTY_OFF_SLOTS.linkLabel);
  return gaps;
}

export function lineGaps(copy: ThirdPartyOffCopy): string[] {
  return isUnfilled(copy.onboardingLine) ? [THIRD_PARTY_OFF_SLOTS.onboardingLine] : [];
}

/** One line for the process log at start: what is withheld from tenants, by slot name. */
export function withheldLine(copy: ThirdPartyOffCopy = THIRD_PARTY_OFF_COPY): string | undefined {
  const slots = [...blockGaps(copy), ...lineGaps(copy)];
  return slots.length === 0 ? undefined : JSON.stringify({ event: 'portal.copy_withheld', slots });
}

export interface ThirdPartyOffOptions {
  readonly copy?: ThirdPartyOffCopy;
  /** True only where a placeholder may be read by whoever signs in: a ring under inspection. */
  readonly allowPlaceholders?: boolean;
}

export interface ThirdPartyOff {
  /** The block for the site screen, or the empty string when it is refused. */
  block(): string;
  /** The line for the Essentials request screen, or the empty string when it is refused. */
  onboardingLine(): string;
}

/**
 * The two renderings of the copy. The guard sits here, at the one place the
 * slots become markup, so no screen can show a placeholder by forgetting a check.
 */
export function createThirdPartyOff(options: ThirdPartyOffOptions = {}): ThirdPartyOff {
  const copy = options.copy ?? THIRD_PARTY_OFF_COPY;
  const allow = options.allowPlaceholders === true;
  return {
    block() {
      if (blockGaps(copy).length > 0 && !allow) return '';
      const route = routeOf(copy.requestRoute);
      // With no route the label has nothing to link to; a ring under inspection still sees where it goes.
      const link =
        route !== undefined
          ? `<p><a href="${escapeHtml(route)}">${escapeHtml(copy.linkLabel)}</a></p>`
          : allow
            ? `<p data-slot="third-party-off-link-label">${escapeHtml(copy.linkLabel)}</p>`
            : '';
      return (
        '<section data-slot="third-party-off">' +
        `<h2>${escapeHtml(copy.heading)}</h2><p>${escapeHtml(copy.body)}</p>${link}</section>`
      );
    },
    onboardingLine() {
      if (lineGaps(copy).length > 0 && !allow) return '';
      return `<p data-slot="third-party-off-onboarding">${escapeHtml(copy.onboardingLine)}</p>`;
    },
  };
}
