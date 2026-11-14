/**
 * The curated lists the front door offers: a theme from the curated set, a
 * font from the subset, an outlet type. A choice is held as its slug. The
 * table fixes only the slug's shape, so membership is enforced by
 * parseDemoRequest in demoRequest.ts.
 *
 * The members below are PLACEHOLDERS until the owner rules on the curated set, the
 * font subset and the outlet types. Every label and the landing text are
 * ALL_CAPS placeholders: no reader-facing wording without the owner's authorisation.
 */

export interface CuratedChoice {
  /** The slug the record holds; it matches the table's slug shape. */
  readonly slug: string;
  /** An ALL_CAPS placeholder until the wording is authorised. */
  readonly label: string;
}

export const CURATED_THEMES: readonly CuratedChoice[] = [
  { slug: 'theme-one', label: 'THEME_ONE_LABEL' },
  { slug: 'theme-two', label: 'THEME_TWO_LABEL' },
];

export const CURATED_FONTS: readonly CuratedChoice[] = [
  { slug: 'font-one', label: 'FONT_ONE_LABEL' },
  { slug: 'font-two', label: 'FONT_TWO_LABEL' },
];

export const CURATED_OUTLET_TYPES: readonly CuratedChoice[] = [
  { slug: 'outlet-type', label: 'OUTLET_TYPE_ONE_LABEL' },
  { slug: 'outlet-type-two', label: 'OUTLET_TYPE_TWO_LABEL' },
];

/** The landing shown after a verified request: placeholder text until the owner authorises the wording. */
export const LANDING_PLACEHOLDER = {
  heading: 'REQUEST_RECEIVED_HEADING',
  body: 'REQUEST_RECEIVED_BODY',
} as const;

/** True only when the slug is one of the list's members. */
export function isListed(list: readonly CuratedChoice[], slug: string): boolean {
  return list.some((choice) => choice.slug === slug);
}
