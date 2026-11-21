import { describe, expect, it } from 'vitest';
import {
  EXTENSION_CONSENT_WORDING,
  FIELDS,
  parseExtensionForm,
  renderExtensionForm,
  renderExtensionGranted,
  type ExtensionChoices,
} from '../src/frontdoor/extensionPage.js';
import { ContactConfigError } from '../src/frontdoor/provisionPage.js';

const CONTACT = { address: 'hello@example.test', bookingUrl: 'https://book.example.test/call' };
const CHOICES: ExtensionChoices = {
  audienceSizes: [{ slug: 'audience-small', label: 'AUDIENCE_SMALL_LABEL' }],
  moveWhen: [{ slug: 'move-soon', label: 'MOVE_SOON_LABEL' }],
};

const FULL = {
  [FIELDS.stillEvaluating]: 'EVALUATING_ANSWER',
  [FIELDS.whatIsMissing]: 'MISSING_ANSWER',
  [FIELDS.audienceSize]: 'audience-small',
  [FIELDS.chargesReaders]: 'yes',
  [FIELDS.moveWhen]: 'move-soon',
  [FIELDS.consent]: 'yes',
};

describe('parseExtensionForm', () => {
  it('reads a full form', () => {
    expect(parseExtensionForm(FULL)).toEqual({
      ok: true,
      answers: {
        stillEvaluating: 'EVALUATING_ANSWER',
        whatIsMissing: 'MISSING_ANSWER',
        audienceSize: 'audience-small',
        chargesReaders: true,
        moveWhen: 'move-soon',
        consent: true,
      },
    });
  });

  it('treats a blank optional answer as absent', () => {
    const parsed = parseExtensionForm({ ...FULL, [FIELDS.whatIsMissing]: '   ' });
    expect(parsed.ok && parsed.answers.whatIsMissing).toBeUndefined();
  });

  it.each([undefined, '', 'no', 'on', 'true', 'YES'])(
    'is not consent when the box says %j: it names consent first',
    (value) => {
      const result = parseExtensionForm({
        ...FULL,
        [FIELDS.consent]: value,
        [FIELDS.moveWhen]: '',
      });
      expect(result).toEqual({ ok: false, field: 'consent' });
    }
  );

  it('refuses a form with no answer about charging readers, or nothing being evaluated', () => {
    expect(parseExtensionForm({ ...FULL, [FIELDS.chargesReaders]: undefined })).toEqual({
      ok: false,
      field: 'chargesReaders',
    });
    expect(parseExtensionForm({ ...FULL, [FIELDS.stillEvaluating]: ' ' })).toEqual({
      ok: false,
      field: 'stillEvaluating',
    });
  });
});

describe('renderExtensionForm', () => {
  const page = renderExtensionForm(CONTACT, CHOICES);

  it('asks every question, shows the consent wording and offers the call and the address together', () => {
    for (const name of Object.values(FIELDS)) expect(page).toContain(`name="${name}"`);
    expect(page).toContain(EXTENSION_CONSENT_WORDING);
    expect(page).toContain('href="https://book.example.test/call"');
    expect(page).toContain('href="mailto:hello@example.test"');
    expect(page).toContain('EXTENSION_BOOK_CALL_LABEL');
  });

  it('leaves the consent box unchecked and carries no copy that is not a placeholder', () => {
    expect(page).not.toMatch(/name="consent"[^>]*checked/);
    const words = page
      .replace(/<[^>]*>/g, ' ')
      .split(/\s+/)
      .filter((w) => w !== '');
    const loose = words.filter(
      (w) => !/^[A-Z][A-Z0-9_]*$/.test(w) && !w.includes('@') && !w.includes('.')
    );
    expect(loose).toEqual([]);
  });

  it('says a refusal with a placeholder and shows no answer back', () => {
    expect(renderExtensionForm(CONTACT, CHOICES, 'consent')).toContain(
      'EXTENSION_CONSENT_REQUIRED_MESSAGE'
    );
    expect(renderExtensionForm(CONTACT, CHOICES, 'moveWhen')).toContain(
      'EXTENSION_FIELD_REFUSED_MESSAGE'
    );
  });

  it('is not built without a real address and a bookable call', () => {
    expect(() => renderExtensionForm({ ...CONTACT, bookingUrl: '' }, CHOICES)).toThrow(
      ContactConfigError
    );
    expect(() => renderExtensionGranted({ ...CONTACT, address: '' })).toThrow(ContactConfigError);
  });

  it('escapes the contact it is given', () => {
    const odd = renderExtensionGranted({
      address: 'a&b@example.test',
      bookingUrl: 'https://book.example.test/?x=1&y="2"',
    });
    expect(odd).toContain('a&amp;b@example.test');
    expect(odd).not.toContain('"2"');
  });
});
