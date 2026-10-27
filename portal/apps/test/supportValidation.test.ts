import { describe, expect, it } from 'vitest';
import {
  assertHeaderValue,
  MAX_CONTACT_LENGTH,
  MAX_MESSAGE_CHARACTERS,
  validateContact,
  validateMessage,
} from '../src/tenant/supportValidation.js';
import { SupportTicketError, type SupportTicketRefusal } from '../src/tenant/supportTicketError.js';

/** Characters other than CR and LF that some mail software also treats as a line end. */
const LINE_BREAK_SIBLINGS = [
  ['a next line (U+0085)', '\u0085'],
  ['a line separator (U+2028)', '\u2028'],
  ['a paragraph separator (U+2029)', '\u2029'],
] as const;

function refusalOf(run: () => unknown): SupportTicketRefusal | 'NOT_REFUSED' {
  try {
    run();
  } catch (error) {
    if (error instanceof SupportTicketError) return error.reason;
    throw error;
  }
  return 'NOT_REFUSED';
}

describe('the contact address', () => {
  it('is trimmed and returned', () => {
    expect(validateContact('  someone@example.org  ')).toBe('someone@example.org');
  });

  it.each([
    ['a line feed in the middle', 'a@example.org\nbcc: x@example.org'],
    ['a carriage return in the middle', 'a@example.org\rbcc: x@example.org'],
    ['a trailing CRLF, which must not be trimmed away', 'a@example.org\r\n'],
    ['a trailing line feed', 'a@example.org\n'],
    ['a NUL', 'a@example.org\0'],
    ['a leading NUL', '\0a@example.org'],
  ])('is refused with %s', (_name, value) => {
    expect(refusalOf(() => validateContact(value))).toBe('INVALID_CONTACT');
  });

  it.each(LINE_BREAK_SIBLINGS)(
    'is refused with %s, in the middle or trailing, which trimming must not hide',
    (_name, character) => {
      expect(refusalOf(() => validateContact(`a@example.org${character}bcc: x@example.org`))).toBe(
        'INVALID_CONTACT'
      );
      expect(refusalOf(() => validateContact(`a@example.org${character}`))).toBe('INVALID_CONTACT');
    }
  );

  it.each([
    ['no @', 'example.org'],
    ['two @', 'a@b@example.org'],
    ['an empty local part', '@example.org'],
    ['an empty domain', 'someone@'],
    ['an inner space', 'some one@example.org'],
    ['a comma-separated list', 'a@example.org,b@example.org'],
    ['a semicolon-separated list', 'a@example.org;b@example.org'],
    ['angle brackets', 'Someone <a@example.org>'],
    ['a double quote', '"a"@example.org'],
    ['a backslash', 'a\\b@example.org'],
    ['nothing', ''],
    ['only spaces', '   '],
  ])('is refused with %s', (_name, value) => {
    expect(refusalOf(() => validateContact(value))).toBe('INVALID_CONTACT');
  });

  it('is bounded in length', () => {
    const local = 'a'.repeat(MAX_CONTACT_LENGTH - '@example.org'.length);
    expect(validateContact(`${local}@example.org`)).toHaveLength(MAX_CONTACT_LENGTH);
    expect(refusalOf(() => validateContact(`${local}a@example.org`))).toBe('INVALID_CONTACT');
  });

  it('never puts the refused value in the error', () => {
    try {
      validateContact('secret@@example.org');
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret');
    }
  });
});

describe('the message', () => {
  it('is trimmed and keeps its inner line breaks', () => {
    expect(validateMessage('  LINE_1\nLINE_2  ')).toBe('LINE_1\nLINE_2');
  });

  it.each([
    ['nothing', ''],
    ['only whitespace', ' \n\t '],
  ])('is refused when it is %s', (_name, value) => {
    expect(refusalOf(() => validateMessage(value))).toBe('EMPTY_MESSAGE');
  });

  it('is bounded: the limit is accepted and one more is refused', () => {
    expect(validateMessage('m'.repeat(MAX_MESSAGE_CHARACTERS))).toHaveLength(
      MAX_MESSAGE_CHARACTERS
    );
    expect(refusalOf(() => validateMessage('m'.repeat(MAX_MESSAGE_CHARACTERS + 1)))).toBe(
      'MESSAGE_TOO_LONG'
    );
  });

  it('counts the limit after trimming', () => {
    expect(() => validateMessage(` ${'m'.repeat(MAX_MESSAGE_CHARACTERS)} `)).not.toThrow();
  });

  it('is refused when it holds a NUL', () => {
    expect(refusalOf(() => validateMessage('A\0B'))).toBe('INVALID_MESSAGE');
  });
});

describe('a header value', () => {
  it('passes when it is a plain non-empty line', () => {
    expect(() => assertHeaderValue('SUPPORT_TICKET abc')).not.toThrow();
  });

  it.each([
    ['a line feed', 'A\nB'],
    ['a carriage return', 'A\rB'],
    ['a NUL', 'A\0B'],
    ['nothing', ''],
  ])('is refused with %s', (_name, value) => {
    expect(refusalOf(() => assertHeaderValue(value))).toBe('INVALID_HEADER_VALUE');
  });

  it.each(LINE_BREAK_SIBLINGS)('is refused with %s', (_name, character) => {
    expect(refusalOf(() => assertHeaderValue(`A${character}B`))).toBe('INVALID_HEADER_VALUE');
  });
});
