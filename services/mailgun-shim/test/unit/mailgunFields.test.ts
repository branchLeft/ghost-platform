import FormData from 'form-data';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
  containsHeaderInjectionChars,
  findHeaderInjectionInRecipientVariables,
  isValidHeaderFieldName,
  normalizeMailHeaderKey,
  parseMailgunMessageFields,
  resolveRecipientTokens,
} from '../../src/mailgunFields.js';

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
    const req = multipartRequest([['v:email-id', 'email-record-42']]);
    const parsed = await parseMailgunMessageFields(req);
    expect(parsed.customVars['email-id']).toBe('email-record-42');
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

  it('rejects a CR, LF or NUL inside a recipient-variables value', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      [
        'recipient-variables',
        JSON.stringify({ 'member@example.com': { x: 'a\r\nSender: ceo@evil.com' } }),
      ],
    ]);
    await expect(parseMailgunMessageFields(req)).rejects.toThrow();
  });

  it('rejects a CR, LF or NUL nested two levels deep inside a recipient-variables value — the check recurses, not just the declared shape', async () => {
    const req = multipartRequest([
      ['from', 'noreply@tenant1.example.com'],
      [
        'recipient-variables',
        JSON.stringify({
          'member@example.com': { nested: { deeper: ['fine', 'a\nSender: ceo@evil.com'] } },
        }),
      ],
    ]);
    await expect(parseMailgunMessageFields(req)).rejects.toThrow();
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

describe('findHeaderInjectionInRecipientVariables', () => {
  it('finds a bad character at the top level', () => {
    expect(findHeaderInjectionInRecipientVariables({ a: 'x\r\ny' })).toBe(true);
  });

  it('finds a bad character nested inside an object inside an array', () => {
    expect(findHeaderInjectionInRecipientVariables({ a: [{ b: 'fine' }, { c: 'x\ny' }] })).toBe(
      true
    );
  });

  it('is false for a clean, deeply-nested structure', () => {
    expect(
      findHeaderInjectionInRecipientVariables({ a: { b: ['fine', 'also fine'] }, c: 1, d: null })
    ).toBe(false);
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
