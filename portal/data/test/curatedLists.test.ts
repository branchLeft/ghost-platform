import { describe, expect, it } from 'vitest';
import {
  CURATED_FONTS,
  CURATED_OUTLET_TYPES,
  CURATED_THEMES,
  LANDING_PLACEHOLDER,
  isListed,
  type CuratedChoice,
} from '../src/curatedLists.js';
import {
  InvalidDemoRequestError,
  SLUG_PATTERN,
  parseDemoRequest,
  type DemoRequestInput,
} from '../src/demoRequest.js';

// The three curated lists the front door offers. The table fixes only a slug's
// shape; the record accepts a theme, font or outlet type only when it is a
// member of its own list (parseDemoRequest), so membership is what is tested.

const SLUG = new RegExp(SLUG_PATTERN);
const ALL_CAPS_PLACEHOLDER = /^[A-Z0-9_]+$/;

const BASE: DemoRequestInput = {
  verifiedSubject: 'subject-1',
  verifiedAddress: 'person@example.invalid',
  publicationName: 'PUBLICATION_NAME',
  newToGhost: true,
  outletType: CURATED_OUTLET_TYPES[0]!.slug,
  consentWording: 'CONSENT_CONTACT_WORDING',
  explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
};

function refusedField(input: unknown): string {
  try {
    parseDemoRequest(input as DemoRequestInput);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidDemoRequestError);
    return (error as InvalidDemoRequestError).field;
  }
  throw new Error('the request was not refused');
}

describe('curated lists', () => {
  const lists: [string, readonly CuratedChoice[]][] = [
    ['themes', CURATED_THEMES],
    ['fonts', CURATED_FONTS],
    ['outlet types', CURATED_OUTLET_TYPES],
  ];

  it.each(lists)(
    'the %s list is non-empty, with unique slugs in the table shape',
    (_name, list) => {
      expect(list.length).toBeGreaterThan(0);
      const slugs = list.map((choice) => choice.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
      for (const slug of slugs) expect(SLUG.test(slug)).toBe(true);
    }
  );

  it.each(lists)('every label on the %s list is an ALL_CAPS placeholder', (_name, list) => {
    for (const choice of list) expect(choice.label).toMatch(ALL_CAPS_PLACEHOLDER);
  });

  it('the landing shown after a verified request is an ALL_CAPS placeholder', () => {
    expect(LANDING_PLACEHOLDER.heading).toMatch(ALL_CAPS_PLACEHOLDER);
    expect(LANDING_PLACEHOLDER.body).toMatch(ALL_CAPS_PLACEHOLDER);
  });

  it('isListed is true for a member and false for anything else', () => {
    expect(isListed(CURATED_THEMES, 'theme-one')).toBe(true);
    expect(isListed(CURATED_THEMES, 'theme-not-listed')).toBe(false);
    expect(isListed(CURATED_THEMES, '')).toBe(false);
  });
});

describe('the record accepts only members of each list', () => {
  it.each(CURATED_THEMES.map((c) => [c.slug]))('accepts the theme %s', (slug) => {
    expect(parseDemoRequest({ ...BASE, theme: slug }).theme).toBe(slug);
  });

  it.each(CURATED_FONTS.map((c) => [c.slug]))('accepts the font %s', (slug) => {
    expect(parseDemoRequest({ ...BASE, font: slug }).font).toBe(slug);
  });

  it.each(CURATED_OUTLET_TYPES.map((c) => [c.slug]))('accepts the outlet type %s', (slug) => {
    expect(parseDemoRequest({ ...BASE, outletType: slug }).outletType).toBe(slug);
  });

  it('refuses a well-shaped theme that is not listed, naming the field', () => {
    expect(refusedField({ ...BASE, theme: 'theme-not-listed' })).toBe('theme');
  });

  it('refuses a well-shaped font that is not listed, naming the field', () => {
    expect(refusedField({ ...BASE, font: 'font-not-listed' })).toBe('font');
  });

  it('refuses a well-shaped outlet type that is not listed, naming the field', () => {
    expect(refusedField({ ...BASE, outletType: 'outlet-not-listed' })).toBe('outletType');
  });

  it('refuses a member of another list in the theme field', () => {
    expect(refusedField({ ...BASE, theme: CURATED_FONTS[0]!.slug })).toBe('theme');
  });

  it('refuses a member of another list in the font field', () => {
    expect(refusedField({ ...BASE, font: CURATED_THEMES[0]!.slug })).toBe('font');
  });

  it('still leaves theme and font optional: absent is accepted and stored as null', () => {
    const row = parseDemoRequest(BASE);
    expect(row.theme).toBeNull();
    expect(row.font).toBeNull();
  });
});
