import { describe, expect, it } from 'vitest';
import {
  ADDRESS_PATTERN,
  COLOUR_PATTERN,
  InvalidDemoRequestError,
  LOGO_HASH_PATTERN,
  SLUG_PATTERN,
  parseDemoRequest,
  type DemoRequestInput,
} from '../src/demoRequest.js';

// The shapes a request must have, checked before a statement is spent. The
// table repeats every rule as a check (prospectRole.test.ts drives the table
// directly), so this is the typed early refusal, not the control.

const MINIMAL: DemoRequestInput = {
  verifiedSubject: 'subject-1',
  verifiedAddress: 'person@example.invalid',
  publicationName: 'PUBLICATION_NAME',
  newToGhost: true,
  outletType: 'outlet-type',
  consentWording: 'CONSENT_CONTACT_WORDING',
  explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
};

const FULL: DemoRequestInput = {
  ...MINIMAL,
  description: 'DESCRIPTION',
  accentColour: '#0a1b2c',
  theme: 'theme-one',
  font: 'font-one',
  newToGhost: false,
  importSource: 'IMPORT_SOURCE',
  logoHash: 'a'.repeat(64),
};

function fieldOf(input: unknown): string {
  try {
    parseDemoRequest(input as DemoRequestInput);
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidDemoRequestError);
    return (error as InvalidDemoRequestError).field;
  }
  throw new Error('the request was not refused');
}

describe('parseDemoRequest', () => {
  it('turns a minimal request into a row whose optional answers are null, not absent', () => {
    expect(parseDemoRequest(MINIMAL)).toEqual({
      verifiedSubject: 'subject-1',
      verifiedAddress: 'person@example.invalid',
      publicationName: 'PUBLICATION_NAME',
      description: null,
      accentColour: null,
      theme: null,
      font: null,
      newToGhost: true,
      importSource: null,
      outletType: 'outlet-type',
      logoHash: null,
      consentWording: 'CONSENT_CONTACT_WORDING',
      explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
    });
  });

  it('keeps every answer of a full request', () => {
    const row = parseDemoRequest(FULL);
    expect(row).toMatchObject({
      description: 'DESCRIPTION',
      accentColour: '#0a1b2c',
      theme: 'theme-one',
      font: 'font-one',
      newToGhost: false,
      importSource: 'IMPORT_SOURCE',
      logoHash: 'a'.repeat(64),
    });
  });

  it('keeps the wording exactly as shown, line breaks included', () => {
    const wording = 'FIRST_PARAGRAPH\n\nSECOND_PARAGRAPH\n';
    const row = parseDemoRequest({
      ...MINIMAL,
      consentWording: wording,
      explainerWording: wording,
    });
    expect(row.consentWording).toBe(wording);
    expect(row.explainerWording).toBe(wording);
  });

  it.each([
    ['verifiedSubject', { verifiedSubject: '' }],
    ['verifiedSubject', { verifiedSubject: undefined }],
    ['verifiedAddress', { verifiedAddress: 'Person@example.invalid' }],
    ['verifiedAddress', { verifiedAddress: 'person@example' }],
    ['verifiedAddress', { verifiedAddress: 'a b@example.invalid' }],
    ['verifiedAddress', { verifiedAddress: 'a@b@example.invalid' }],
    ['verifiedAddress', { verifiedAddress: `${'a'.repeat(250)}@e.invalid` }],
    ['verifiedAddress', { verifiedAddress: 'person@example.invalid\n' }],
    ['publicationName', { publicationName: '' }],
    ['publicationName', { publicationName: 'x'.repeat(101) }],
    ['publicationName', { publicationName: ' padded' }],
    ['publicationName', { publicationName: 'two\nlines' }],
    ['publicationName', { publicationName: 'nul\u0000byte' }],
    ['publicationName', { publicationName: 42 }],
    ['description', { description: 'x'.repeat(501) }],
    ['description', { description: '' }],
    ['accentColour', { accentColour: '#ABCDEF' }],
    ['accentColour', { accentColour: 'red' }],
    ['theme', { theme: 'Not A Slug' }],
    ['font', { font: 'x'.repeat(41) }],
    ['outletType', { outletType: undefined }],
    ['outletType', { outletType: 'UPPER' }],
    ['importSource', { importSource: 'x'.repeat(101) }],
    ['logoHash', { logoHash: 'a'.repeat(63) }],
    ['logoHash', { logoHash: 'A'.repeat(64) }],
    ['newToGhost', { newToGhost: 'yes' }],
    ['newToGhost', { newToGhost: undefined }],
    ['consentWording', { consentWording: '' }],
    ['consentWording', { consentWording: 'x'.repeat(2001) }],
    ['explainerWording', { explainerWording: undefined }],
  ])('refuses a bad %s and names the field', (field, change) => {
    expect(fieldOf({ ...FULL, ...change })).toBe(field);
  });

  it('never carries the refused value in the message', () => {
    const secret = 'person@UPPER.example.invalid';
    try {
      parseDemoRequest({ ...MINIMAL, verifiedAddress: secret });
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      return;
    }
    throw new Error('the request was not refused');
  });

  it('uses the same patterns as the table, so the two cannot drift apart', () => {
    expect(new RegExp(ADDRESS_PATTERN.replaceAll('[:space:]', '\\s')).test('a@b.c')).toBe(true);
    expect(new RegExp(SLUG_PATTERN).test('ok-1')).toBe(true);
    expect(new RegExp(COLOUR_PATTERN).test('#00ff00')).toBe(true);
    expect(new RegExp(LOGO_HASH_PATTERN).test('0'.repeat(64))).toBe(true);
  });
});
