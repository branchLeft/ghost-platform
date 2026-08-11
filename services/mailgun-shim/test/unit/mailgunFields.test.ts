import FormData from 'form-data';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { parseMailgunMessageFields, resolveRecipientTokens } from '../../src/mailgunFields.js';

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
