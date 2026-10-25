import FormData from 'form-data';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { findFieldLimitReason } from '../../src/mailgunFields.js';
import { vi } from 'vitest';
import {
  MULTIPART_LIMITS,
  MultipartLimitError,
  type MultipartLimitReason,
} from '../../src/mailgunFields.js';
import {
  containsHeaderInjectionChars,
  isValidGhostEmailId,
  isValidHeaderFieldName,
  normalizeMailHeaderKey,
  parseMailgunMessageFields,
  resolveRecipientTokens,
  sanitizeRecipientVariables,
} from '../../src/mailgunFields.js';

/** A real Ghost email-id shape — 24 lowercase hex characters, bson-objectid's ObjectId().toHexString(). */
const GHOST_EMAIL_ID = '64f1a2b3c4d5e6f7a8b9c0d1';

/**
 * Builds a real multipart/form-data body via the `form-data` package (the
 * same encoder mailgun.js itself uses under the hood) and exposes it as
 * something `parseMailgunMessageFields` can pipe from — it only reads
 * `req.headers` and calls `req.pipe(busboy)`, both of which a FormData
 * instance already supports.
 */
function multipartRequest(fields: Array<[string, string]>): Request {
  const form = new FormData();
  for (const [name, value] of fields) {
    form.append(name, value);
  }
  const req = form as unknown as Request;
  (req as unknown as { headers: Record<string, string> }).headers = form.getHeaders();
  return req;
}

describe('parseMailgunMessageFields', () => {
  it('collects repeated "to" fields into an array', async () => {
    const req = multipartRequest([
      ['to', 'member-a@example.com'],
      ['to', 'member-b@example.com'],
      ['from', 'noreply@tenant1.example.com'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.to).toEqual(['member-a@example.com', 'member-b@example.com']);
  });

  it('splits a single comma-joined "to" field into individual trimmed recipients', async () => {
    const req = multipartRequest([['to', 'member-a@example.com, member-b@example.com']]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.to).toEqual(['member-a@example.com', 'member-b@example.com']);
  });

  it('drops empty entries produced by trailing commas or blank segments', async () => {
    const req = multipartRequest([['to', 'member-a@example.com,, ']]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.to).toEqual(['member-a@example.com']);
  });

  it('passes from/subject/html/text through as plain strings', async () => {
    const req = multipartRequest([
      ['from', 'TENANT_1 <noreply@tenant1.example.com>'],
      ['subject', 'Hello %recipient.name%'],
      ['html', '<p>hi</p>'],
      ['text', 'hi'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.from).toBe('TENANT_1 <noreply@tenant1.example.com>');
    expect(parsed.subject).toBe('Hello %recipient.name%');
    expect(parsed.html).toBe('<p>hi</p>');
    expect(parsed.text).toBe('hi');
  });

  it('parses recipient-variables JSON into a nested per-recipient map', async () => {
    const req = multipartRequest([
      ['recipient-variables', JSON.stringify({ 'member-a@example.com': { name: 'Member A' } })],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.recipientVariables).toEqual({ 'member-a@example.com': { name: 'Member A' } });
  });

  it('malformed recipient-variables JSON does not throw and leaves the map empty', async () => {
    const req = multipartRequest([['recipient-variables', '{not valid json']]);
    await expect(parseMailgunMessageFields(req)).resolves.toMatchObject({
      recipientVariables: {},
    });
  });

  it('strips the "h:" prefix from header fields, including Reply-To', async () => {
    const req = multipartRequest([
      ['h:Reply-To', 'replies@tenant1.example.com'],
      ['h:Auto-Submitted', 'auto-generated'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.headers['Reply-To']).toBe('replies@tenant1.example.com');
    expect(parsed.headers['Auto-Submitted']).toBe('auto-generated');
  });

  it('captures v:email-id as a custom var with the "v:" prefix stripped', async () => {
    const req = multipartRequest([['v:email-id', GHOST_EMAIL_ID]]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.customVars['email-id']).toBe(GHOST_EMAIL_ID);
  });

  it('rejects a CR, LF or NUL in v:email-id with a rejected promise, before it is stored', async () => {
    for (const bad of ['a\r\nSender: ceo@evil.com', 'a\nb', 'a\0b']) {
      const req = multipartRequest([['v:email-id', bad]]);
      await expect(parseMailgunMessageFields(req)).rejects.toThrow();
    }
  });

  it('rejects a v:email-id that is not a 24-character lowercase hex Ghost object id, even with no injection characters', async () => {
    for (const bad of [
      'email-record-42',
      GHOST_EMAIL_ID.toUpperCase(),
      GHOST_EMAIL_ID.slice(1),
      `${GHOST_EMAIL_ID}f`,
      '',
    ]) {
      const req = multipartRequest([['v:email-id', bad]]);
      await expect(parseMailgunMessageFields(req)).rejects.toThrow();
    }
  });

  it('rejects a CR, LF or NUL in a v:* value other than email-id, the same as email-id — the check covers every v:* key', async () => {
    const req = multipartRequest([['v:some-other-var', 'a\r\nSender: ceo@evil.com']]);
    await expect(parseMailgunMessageFields(req)).rejects.toThrow();
  });

  it('keeps repeated "o:tag" fields as an array (batch tags) — including a third repeat appended to that array, not just the first pair', async () => {
    const req = multipartRequest([
      ['o:tag', 'bulk-email'],
      ['o:tag', 'ghost-email'],
      ['o:tag', 'weekly-digest'],
      ['o:tracking-opens', 'yes'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.options.tag).toEqual(['bulk-email', 'ghost-email', 'weekly-digest']);
    expect(parsed.options['tracking-opens']).toBe('yes');
  });

  it('a repeated single-value header field (e.g. sent twice) resolves to its first occurrence, not an array', async () => {
    const req = multipartRequest([
      ['h:X-Custom', 'first-value'],
      ['h:X-Custom', 'second-value'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.headers['X-Custom']).toBe('first-value');
  });

  it('ignores fields with no to/from/subject/html/text/recipient-variables/h:/o:/v: shape', async () => {
    const req = multipartRequest([['some-unrelated-field', 'ignored']]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.headers).toEqual({});
    expect(parsed.options).toEqual({});
    expect(parsed.customVars).toEqual({});
  });

  it('drops an h:Sender field before it ever reaches `headers`, whatever its value', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:Sender', 'sender@evil.example'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.headers).toEqual({});
  });

  it('drops every h:* field whose key normalises to Sender — duplicated and differently cased, all at once', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:Sender', 'legit@tenant1.example.com'],
      ['h:sender', 'ceo@evil.example'],
      ['h:SeNdEr', 'also-ceo@evil.example'],
      ['h:X-Custom', 'kept'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.headers).toEqual({ 'X-Custom': 'kept' });
  });

  it('rejects a whitespace-padded h:Sender key outright — a space is not a valid RFC 5322 field-name character at all, so this is caught by field-name validation before the Sender drop ever runs', async () => {
    const trailing = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:Sender ', 'ceo@evil.example'],
    ]);
    await expect(parseMailgunMessageFields(trailing)).rejects.toThrow();

    const leading = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h: Sender', 'ceo@evil.example'],
    ]);
    await expect(parseMailgunMessageFields(leading)).rejects.toThrow();
  });

  it('rejects an h:* field name carrying a colon (e.g. "Sender:") with a rejected promise, before it is stored', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:Sender:', 'ceo@evil.example'],
    ]);
    await expect(parseMailgunMessageFields(req)).rejects.toThrow();
  });

  it('rejects an h:* field name carrying a control character (a tab)', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:Sen\tder', 'ceo@evil.example'],
    ]);
    await expect(parseMailgunMessageFields(req)).rejects.toThrow();
  });

  it('rejects an h:* field name carrying a non-ASCII character (NBSP)', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:\u00a0Sender', 'ceo@evil.example'],
    ]);
    await expect(parseMailgunMessageFields(req)).rejects.toThrow();
  });

  it('rejects an h:* field name carrying a zero-width space, which nodemailer normalisation does not strip', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:\u200bSender', 'ceo@evil.example'],
    ]);
    await expect(parseMailgunMessageFields(req)).rejects.toThrow();
  });

  it('rejects an h:* field name carrying a BOM', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:Sender\ufeff', 'ceo@evil.example'],
    ]);
    await expect(parseMailgunMessageFields(req)).rejects.toThrow();
  });

  it('drops an h:From field before it ever reaches `headers`, whatever its value', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:From', 'ceo@evil.example'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.headers).toEqual({});
    expect(parsed.from).toBe('noreply@tenant1.example.com');
  });

  it('drops every h:* field whose key normalises to From — every case variant, and a %recipient.*% token in the value, all at once', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:From', 'ceo@evil.example'],
      ['h:from', 'also-ceo@evil.example'],
      ['h:FROM', `%recipient.x%`],
      ['h:X-Custom', 'kept'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.headers).toEqual({ 'X-Custom': 'kept' });
    expect(parsed.from).toBe('noreply@tenant1.example.com');
  });

  it('accepts every other h:* header unchanged — validation and the Sender drop are scoped to their own cases, not the whole field', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:List-Unsubscribe', '<mailto:unsub@tenant1.example.com>'],
      ['h:Auto-Submitted', 'auto-generated'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.headers).toEqual({
      'List-Unsubscribe': '<mailto:unsub@tenant1.example.com>',
      'Auto-Submitted': 'auto-generated',
    });
  });

  it("rejects a CR, LF or NUL in 'from' with a rejected promise, before it is stored", async () => {
    for (const bad of ['"x\r\nSender: ceo@evil.com" <blog@tenant1.example.com>', 'a\nb', 'a\0b']) {
      const req = multipartRequest([['from', bad]]);
      await expect(parseMailgunMessageFields(req)).rejects.toThrow();
    }
  });

  it("rejects a CR, LF or NUL in 'subject' with a rejected promise, before it is stored", async () => {
    for (const bad of ['a\r\nSender: ceo@evil.com', 'a\nb', 'a\0b']) {
      const req = multipartRequest([
        ['from', 'noreply@tenant1.example.com'],
        ['subject', bad],
      ]);
      await expect(parseMailgunMessageFields(req)).rejects.toThrow();
    }
  });

  it('rejects a CR, LF or NUL in an h:* value, even for a header name that would otherwise be kept', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['h:X-Foo', 'a\r\nSender: ceo@evil.com'],
    ]);
    await expect(parseMailgunMessageFields(req)).rejects.toThrow();
  });

  it('replaces a CR, LF or NUL inside a recipient-variables value with a space, rather than refusing the request — a member-supplied name is not tenant-authored', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      [
        'recipient-variables',
        JSON.stringify({ 'member@example.com': { x: 'a\r\nSender: ceo@evil.com' } }),
      ],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.recipientVariables).toEqual({
      'member@example.com': { x: 'a  Sender: ceo@evil.com' },
    });
    expect(parsed.recipientVariables['member@example.com']!.x).not.toMatch(/[\r\n\0]/);
  });

  it('replaces a CR, LF or NUL nested two levels deep inside a recipient-variables value — the sanitiser recurses, not just the declared shape', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      [
        'recipient-variables',
        JSON.stringify({
          'member@example.com': { nested: { deeper: ['fine', 'a\nSender: ceo@evil.com'] } },
        }),
      ],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.recipientVariables).toEqual({
      'member@example.com': { nested: { deeper: ['fine', 'a Sender: ceo@evil.com'] } },
    });
  });

  it('never applies the CR/LF/NUL rule to html or text — Ghost legitimately sends multi-line bodies', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      ['subject', 'Weekly digest'],
      ['html', '<p>Line one</p>\r\n<p>Line two</p>\n<p>Line three</p>'],
      ['text', 'Line one\r\nLine two\nLine three'],
    ]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.html).toContain('\r\n');
    expect(parsed.text).toContain('\n');
  });

  it('defaults every field to an empty/absent shape when the body has none of them', async () => {
    // A part-less multipart body is itself malformed (busboy rejects it as
    // "Unexpected end of form"), so this uses one unrelated field to keep
    // the body well-formed while still exercising every field's default.
    const req = multipartRequest([['unrelated', 'ignored']]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed).toEqual({
      to: [],
      from: '',
      subject: '',
      html: '',
      text: '',
      recipientVariables: {},
      headers: {},
      options: {},
      customVars: {},
    });
  });
});

describe('isValidHeaderFieldName', () => {
  it('accepts an ordinary field name', () => {
    expect(isValidHeaderFieldName('Sender')).toBe(true);
    expect(isValidHeaderFieldName('X-Custom-Header')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isValidHeaderFieldName('')).toBe(false);
  });

  it('rejects a colon anywhere in the name', () => {
    expect(isValidHeaderFieldName('Sender:')).toBe(false);
    expect(isValidHeaderFieldName(':Sender')).toBe(false);
  });

  it('rejects a control character (tab)', () => {
    expect(isValidHeaderFieldName('Sen\tder')).toBe(false);
  });

  it('rejects non-ASCII characters (NBSP, ZWSP, BOM)', () => {
    expect(isValidHeaderFieldName(' Sender')).toBe(false);
    expect(isValidHeaderFieldName('​Sender')).toBe(false);
    expect(isValidHeaderFieldName('Sender﻿')).toBe(false);
  });

  it('rejects DEL (0x7f), just past the printable-ASCII upper bound', () => {
    expect(isValidHeaderFieldName('Sender\x7f')).toBe(false);
  });

  it('accepts the printable-ASCII boundary characters themselves (0x21 and 0x7e)', () => {
    expect(isValidHeaderFieldName('\x21\x7e')).toBe(true);
  });
});

describe('normalizeMailHeaderKey', () => {
  it("folds case and whitespace variants of 'Sender' to the same canonical form", () => {
    expect(normalizeMailHeaderKey('sender')).toBe('Sender');
    expect(normalizeMailHeaderKey('SENDER')).toBe('Sender');
    expect(normalizeMailHeaderKey(' Sender')).toBe('Sender');
    expect(normalizeMailHeaderKey('Sender ')).toBe('Sender');
    expect(normalizeMailHeaderKey('SeNdEr')).toBe('Sender');
  });

  it('does not fold a key carrying a trailing colon to Sender — the colon survives normalisation', () => {
    expect(normalizeMailHeaderKey('Sender:')).toBe('Sender:');
  });
});

describe('containsHeaderInjectionChars', () => {
  it('detects a bare CR, a bare LF, and a NUL', () => {
    expect(containsHeaderInjectionChars('a\rb')).toBe(true);
    expect(containsHeaderInjectionChars('a\nb')).toBe(true);
    expect(containsHeaderInjectionChars('a\0b')).toBe(true);
  });

  it('is false for an ordinary value with none of the three', () => {
    expect(containsHeaderInjectionChars('blog@tenant1.example.com')).toBe(false);
    expect(containsHeaderInjectionChars('')).toBe(false);
  });
});

describe('sanitizeRecipientVariables', () => {
  it('replaces a bad character at the top level with a space, one space per character', () => {
    expect(sanitizeRecipientVariables({ a: 'x\r\ny' })).toEqual({ a: 'x  y' });
    expect(sanitizeRecipientVariables({ a: 'x\0y' })).toEqual({ a: 'x y' });
  });

  it('replaces a bad character nested inside an object inside an array', () => {
    expect(sanitizeRecipientVariables({ a: [{ b: 'fine' }, { c: 'x\ny' }] })).toEqual({
      a: [{ b: 'fine' }, { c: 'x y' }],
    });
  });

  it('leaves a clean, deeply-nested structure — including non-string values — unchanged', () => {
    const clean = { a: { b: ['fine', 'also fine'] }, c: 1, d: null };
    expect(sanitizeRecipientVariables(clean)).toEqual(clean);
  });
});

describe('isValidGhostEmailId', () => {
  it('accepts a 24-character lowercase hex string', () => {
    expect(isValidGhostEmailId(GHOST_EMAIL_ID)).toBe(true);
  });

  it('rejects anything else — wrong length, uppercase, non-hex, or empty', () => {
    expect(isValidGhostEmailId(GHOST_EMAIL_ID.slice(1))).toBe(false);
    expect(isValidGhostEmailId(GHOST_EMAIL_ID.toUpperCase())).toBe(false);
    expect(isValidGhostEmailId('email-record-42')).toBe(false);
    expect(isValidGhostEmailId('')).toBe(false);
  });
});

describe('resolveRecipientTokens', () => {
  it('substitutes a %recipient.<var>% token with the matching variable', () => {
    expect(resolveRecipientTokens('Hello %recipient.name%', { name: 'Member A' })).toBe(
      'Hello Member A'
    );
  });

  it('substitutes multiple distinct tokens in the same string', () => {
    const result = resolveRecipientTokens('%recipient.greeting%, %recipient.name%!', {
      greeting: 'Hi',
      name: 'Member A',
    });
    expect(result).toBe('Hi, Member A!');
  });

  it('leaves a token with no matching variable untouched (e.g. click-tracking tokens this shim does not provide)', () => {
    expect(resolveRecipientTokens('%tag_unsubscribe_email%', {})).toBe('%tag_unsubscribe_email%');
  });

  it('returns an empty string unchanged rather than throwing', () => {
    expect(resolveRecipientTokens('', { name: 'Member A' })).toBe('');
  });

  it('does not substitute a variable whose value is falsy-but-present incorrectly (e.g. an empty string value)', () => {
    expect(resolveRecipientTokens('%recipient.name%', { name: '' })).toBe('');
  });
});

const MEBIBYTE = 1024 * 1024;

/**
 * A request stand-in whose body the test controls chunk by chunk — a real
 * Readable, so `pipe` and `unpipe` behave exactly as they do on an
 * IncomingMessage.
 */
function streamRequest(form: FormData): { req: Request; body: Buffer; source: Readable } {
  const body = form.getBuffer();
  const source = new Readable({ read(): void {} });
  Object.assign(source, { headers: form.getHeaders() });
  return { req: source as unknown as Request, body, source };
}

function sendWholeBody(form: FormData): Request {
  const { req, body, source } = streamRequest(form);
  source.push(body);
  source.push(null);
  return req;
}

function formOf(fields: Array<[string, string]>): FormData {
  const form = new FormData();
  for (const [name, value] of fields) {
    form.append(name, value);
  }
  return form;
}

function repeatedFields(name: string, value: string, count: number): Array<[string, string]> {
  return Array.from({ length: count }, (): [string, string] => [name, value]);
}

function recipientAddresses(count: number): string[] {
  return Array.from(
    { length: count },
    (_unused, index) => `recipient-${String(index).padStart(5, '0')}@example.com`
  );
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error
  );
}

async function expectLimitRefusal(req: Request, reason: MultipartLimitReason): Promise<void> {
  const error = await rejectionOf(parseMailgunMessageFields(req));
  expect(error).toBeInstanceOf(MultipartLimitError);
  expect(error).toMatchObject({
    reason,
    limit: MULTIPART_LIMITS[reason],
    message: `Request exceeds the ${reason} limit of ${MULTIPART_LIMITS[reason]}`,
  });
}

describe('MULTIPART_LIMITS', () => {
  it('pins the agreed ceilings, so a loosened constant is a visible change', () => {
    expect(MULTIPART_LIMITS).toEqual({
      fields: 1100,
      parts: 1200,
      fieldSize: 5 * MEBIBYTE,
      fieldNameSize: 100,
      totalBytes: 10 * MEBIBYTE,
      recipients: 1000,
    });
  });
});

describe('parseMailgunMessageFields multipart limits', () => {
  it('refuses one field more than the field cap, naming the fields limit', async () => {
    const req = sendWholeBody(formOf(repeatedFields('o:tag', 'x', MULTIPART_LIMITS.fields + 1)));
    await expectLimitRefusal(req, 'fields');
  });

  it('accepts exactly the field cap', async () => {
    const req = sendWholeBody(formOf(repeatedFields('o:tag', 'x', MULTIPART_LIMITS.fields)));
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.options.tag).toHaveLength(MULTIPART_LIMITS.fields);
  });

  it('refuses more parts than the part cap with the parts limit, when file parts keep the field count low', async () => {
    const form = new FormData();
    for (let index = 0; index <= MULTIPART_LIMITS.parts; index += 1) {
      form.append('attachment', Buffer.from('x'), { filename: `file-${index}.txt` });
    }
    await expectLimitRefusal(sendWholeBody(form), 'parts');
  });

  it('accepts exactly the part cap, files being counted but never read', async () => {
    const form = new FormData();
    form.append('to', 'member-a@example.com');
    for (let index = 1; index < MULTIPART_LIMITS.parts; index += 1) {
      form.append('attachment', Buffer.from('x'), { filename: `file-${index}.txt` });
    }
    const parsed = await parseMailgunMessageFields(sendWholeBody(form));
    expect(parsed.to).toEqual(['member-a@example.com']);
  });

  it('refuses a single field one byte over the field size cap, naming the fieldSize limit', async () => {
    const req = sendWholeBody(formOf([['html', 'a'.repeat(MULTIPART_LIMITS.fieldSize + 1)]]));
    await expectLimitRefusal(req, 'fieldSize');
  });

  it('accepts a single field of exactly the field size cap, untruncated', async () => {
    const value = 'a'.repeat(MULTIPART_LIMITS.fieldSize);
    const parsed = await parseMailgunMessageFields(sendWholeBody(formOf([['html', value]])));
    expect(parsed.html).toHaveLength(MULTIPART_LIMITS.fieldSize);
  });

  it('refuses a field name one byte over the name cap, naming the fieldNameSize limit', async () => {
    const req = sendWholeBody(formOf([['n'.repeat(MULTIPART_LIMITS.fieldNameSize + 1), 'v']]));
    await expectLimitRefusal(req, 'fieldNameSize');
  });

  it('measures a field name in bytes, not characters', async () => {
    const name = 'é'.repeat(MULTIPART_LIMITS.fieldNameSize / 2 + 1);
    await expectLimitRefusal(sendWholeBody(formOf([[name, 'v']])), 'fieldNameSize');
  });

  it('accepts a field name of exactly the name cap', async () => {
    const req = sendWholeBody(formOf([['n'.repeat(MULTIPART_LIMITS.fieldNameSize), 'v']]));
    await expect(parseMailgunMessageFields(req)).resolves.toBeDefined();
  });

  it('refuses fields that are each under the size cap but together over the byte total, naming totalBytes', async () => {
    const value = 'a'.repeat(4 * MEBIBYTE);
    const req = sendWholeBody(
      formOf([
        ['html', value],
        ['text', value],
        ['o:first', value],
      ])
    );
    await expectLimitRefusal(req, 'totalBytes');
  });

  it('counts field bytes as UTF-8, not as string length', async () => {
    const value = 'é'.repeat(2 * MEBIBYTE);
    const req = sendWholeBody(
      formOf([
        ['html', value],
        ['text', value],
        ['o:first', value],
      ])
    );
    await expectLimitRefusal(req, 'totalBytes');
  });

  it('counts the field name towards the byte total: exactly the total passes, one more byte is refused', async () => {
    const half = MULTIPART_LIMITS.totalBytes / 2;
    const atTotal = formOf([
      ['html', 'a'.repeat(half - 'html'.length)],
      ['text', 'a'.repeat(half - 'text'.length)],
    ]);
    await expect(parseMailgunMessageFields(sendWholeBody(atTotal))).resolves.toBeDefined();

    const overTotal = formOf([
      ['html', 'a'.repeat(half - 'html'.length)],
      ['text', 'a'.repeat(half - 'text'.length)],
      ['a', ''],
    ]);
    await expectLimitRefusal(sendWholeBody(overTotal), 'totalBytes');
  });

  it('refuses 1001 repeated "to" fields, naming the recipients limit', async () => {
    const req = sendWholeBody(
      formOf(recipientAddresses(MULTIPART_LIMITS.recipients + 1).map((address) => ['to', address]))
    );
    await expectLimitRefusal(req, 'recipients');
  });

  it('refuses one "to" field of 1001 comma-joined addresses, counted after the split', async () => {
    const joined = recipientAddresses(MULTIPART_LIMITS.recipients + 1).join(', ');
    await expectLimitRefusal(sendWholeBody(formOf([['to', joined]])), 'recipients');
  });

  it('refuses recipients spread over repeated and comma-joined "to" fields together', async () => {
    const addresses = recipientAddresses(MULTIPART_LIMITS.recipients + 1);
    const req = sendWholeBody(
      formOf([
        ['to', addresses.slice(0, 500).join(',')],
        ['to', addresses.slice(500).join(',')],
      ])
    );
    await expectLimitRefusal(req, 'recipients');
  });

  it('accepts exactly 1000 recipients with recipient-variables, the real newsletter batch shape', async () => {
    const addresses = recipientAddresses(MULTIPART_LIMITS.recipients);
    const variables: Record<string, { name: string }> = {};
    for (const address of addresses) {
      variables[address] = { name: 'Member' };
    }
    const req = sendWholeBody(
      formOf([
        ...addresses.map((address): [string, string] => ['to', address]),
        ['from', 'noreply@tenant1.example.com'],
        ['recipient-variables', JSON.stringify(variables)],
      ])
    );
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.to).toHaveLength(MULTIPART_LIMITS.recipients);
    expect(Object.keys(parsed.recipientVariables)).toHaveLength(MULTIPART_LIMITS.recipients);
  });

  it('does not count empty segments from stray commas towards the recipient cap', async () => {
    const joined = `${recipientAddresses(MULTIPART_LIMITS.recipients).join(',')},, ,`;
    const parsed = await parseMailgunMessageFields(sendWholeBody(formOf([['to', joined]])));
    expect(parsed.to).toHaveLength(MULTIPART_LIMITS.recipients);
  });

  it('leaves the existing malformed-body and header-injection rejections as plain errors, not limit refusals', async () => {
    const malformed = new Readable({ read(): void {} });
    Object.assign(malformed, {
      headers: { 'content-type': 'multipart/form-data; boundary=XBOUNDARYX' },
    });
    malformed.push('this is not a multipart body');
    malformed.push(null);
    const malformedError = await rejectionOf(
      parseMailgunMessageFields(malformed as unknown as Request)
    );
    expect(malformedError).toBeInstanceOf(Error);
    expect(malformedError).not.toBeInstanceOf(MultipartLimitError);

    const injected = formOf([['from', 'a\r\nSender: ceo@evil.com']]);
    const injectedError = await rejectionOf(parseMailgunMessageFields(sendWholeBody(injected)));
    expect(injectedError).toBeInstanceOf(Error);
    expect(injectedError).not.toBeInstanceOf(MultipartLimitError);
  });
});

describe('parseMailgunMessageFields refusal handling', () => {
  it('unpipes the request from the parser on refusal, so no further data is read for it', async () => {
    const { req, body, source } = streamRequest(formOf(repeatedFields('o:tag', 'x', 1200)));
    source.push(body);
    await expectLimitRefusal(req, 'fields');
    expect(source.listenerCount('data')).toBe(0);
    expect(source.listenerCount('end')).toBe(0);
  });

  it('settles once: a chunk that trips two limits unpipes once and keeps the first reason', async () => {
    const { req, body, source } = streamRequest(
      formOf(repeatedFields('o:tag', 'x', MULTIPART_LIMITS.parts + 100))
    );
    const unpipeSpy = vi.spyOn(source, 'unpipe');
    source.push(body);
    await expectLimitRefusal(req, 'fields');
    expect(unpipeSpy).toHaveBeenCalledTimes(1);
  });

  it('survives data arriving after the refusal without throwing or changing the outcome', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const { req, body, source } = streamRequest(formOf(repeatedFields('o:tag', 'x', 1200)));
      source.push(body);
      await expectLimitRefusal(req, 'fields');
      source.push(Buffer.from('a'.repeat(64 * 1024)));
      source.push(null);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('stops a flood across many chunks at the first limit, never reading the rest', async () => {
    const { req, body, source } = streamRequest(formOf(repeatedFields('o:tag', 'x', 5000)));
    const chunkSize = 4096;
    let offset = 0;
    const outcome = rejectionOf(parseMailgunMessageFields(req));
    while (offset < body.length && source.listenerCount('data') > 0) {
      source.push(body.subarray(offset, offset + chunkSize));
      offset += chunkSize;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(await outcome).toBeInstanceOf(MultipartLimitError);
    expect(offset).toBeLessThan(body.length);
  });
});

describe('findFieldLimitReason', () => {
  const untruncated = { nameTruncated: false, valueTruncated: false };

  it('refuses a name Busboy reports as truncated, even when the visible name is short', () => {
    expect(findFieldLimitReason('to', { ...untruncated, nameTruncated: true }, 2)).toBe(
      'fieldNameSize'
    );
  });

  it('refuses a value Busboy reports as truncated', () => {
    expect(findFieldLimitReason('html', { ...untruncated, valueTruncated: true }, 4)).toBe(
      'fieldSize'
    );
  });

  it('refuses a running total over the cap and passes one at it', () => {
    expect(findFieldLimitReason('a', untruncated, MULTIPART_LIMITS.totalBytes)).toBeNull();
    expect(findFieldLimitReason('a', untruncated, MULTIPART_LIMITS.totalBytes + 1)).toBe(
      'totalBytes'
    );
  });
});
