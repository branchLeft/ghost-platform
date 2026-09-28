import Busboy from 'busboy';
import type { Request } from 'express';
// nodemailer's own header-key normalisation, reached through its prototype,
// so a header is judged by the name nodemailer will actually emit.
// See mailgunFields.md#header-key-normalisation.
import MimeNode from 'nodemailer/lib/mime-node/index.js';

interface MimeNodePrototypeWithNormalizer {
  _normalizeHeaderKey(key: string): string;
}

/** See the import comment above — this is nodemailer's real normalisation, not a reimplementation. */
export function normalizeMailHeaderKey(key: string): string {
  return (MimeNode.prototype as unknown as MimeNodePrototypeWithNormalizer)._normalizeHeaderKey(
    key
  );
}

/**
 * RFC 5322 field-name grammar: printable US-ASCII except ':'. The whole
 * class is refused, not only the shapes demonstrated so far.
 * See mailgunFields.md#isvalidheaderfieldname.
 */
export function isValidHeaderFieldName(name: string): boolean {
  if (name.length === 0) {
    return false;
  }
  for (let i = 0; i < name.length; i += 1) {
    const code = name.charCodeAt(i);
    if (code < 0x21 || code > 0x7e || code === 0x3a /* ':' */) {
      return false;
    }
  }
  return true;
}

/**
 * CR, LF and NUL let a value escape its header field. Checked on the raw
 * value, before recipient substitution or any MIME decoding.
 * See mailgunFields.md#header-injection-characters.
 */
const HEADER_INJECTION_PATTERN = /[\r\n\0]/;

export function containsHeaderInjectionChars(value: string): boolean {
  return HEADER_INJECTION_PATTERN.test(value);
}

/**
 * Replaces, rather than refuses, CR/LF/NUL in member-supplied values, so
 * one member's name cannot fail a whole batch; walks any JSON shape.
 * See mailgunFields.md#sanitizerecipientvariables.
 */
export function sanitizeRecipientVariables<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(/[\r\n\0]/g, ' ') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry: unknown) => sanitizeRecipientVariables(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      sanitized[key] = sanitizeRecipientVariables(entry);
    }
    return sanitized as T;
  }
  return value;
}

/**
 * Ghost's v:email-id is always a 24-hex ObjectId, never tenant-chosen,
 * so checking the fixed shape loses nothing legitimate.
 * See mailgunFields.md#ghost-email-id.
 */
const GHOST_EMAIL_ID_PATTERN = /^[a-f0-9]{24}$/;

export function isValidGhostEmailId(value: string): boolean {
  return GHOST_EMAIL_ID_PATTERN.test(value);
}

/**
 * The two header names nodemailer's own normalisation folds a tenant-
 * supplied `h:*` key into that this shim never stores, on any spelling —
 * see the doc comment at the drop's call site for why both are dropped
 * unconditionally rather than checked.
 */
const IDENTITY_HEADER_NAMES = new Set(['Sender', 'From']);

export interface ParsedMessageFields {
  to: string[];
  from: string;
  subject: string;
  html: string;
  text: string;
  recipientVariables: Record<string, Record<string, string>>;
  /** h:* fields, key stored without the "h:" prefix. */
  headers: Record<string, string>;
  /** o:* fields, key stored without the "o:" prefix. Arrays survive repeated fields (e.g. o:tag). */
  options: Record<string, string | string[]>;
  /** v:* fields, key stored without the "v:" prefix — carries v:email-id (doc 13 §1.3/§2.4). */
  customVars: Record<string, string>;
}

/**
 * mailgun.js serialises array-valued fields (e.g. `to`, `o:tag`) as
 * repeated multipart fields with the same name, not a joined string —
 * verified against the library's FormDataBuilder.addCommonPropertyToFD,
 * which does `value.forEach(v => form.append(key, v))` for arrays. A
 * single-value field stays a string so callers don't have to unwrap a
 * one-element array everywhere.
 */
function accumulate(fields: Record<string, string | string[]>, name: string, value: string): void {
  const existing = fields[name];
  if (existing === undefined) {
    fields[name] = value;
  } else if (Array.isArray(existing)) {
    existing.push(value);
  } else {
    fields[name] = [existing, value];
  }
}

function asString(value: string | string[] | undefined): string {
  if (Array.isArray(value)) {
    return value[0] ?? '';
  }
  return value ?? '';
}

function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

export function parseMailgunMessageFields(req: Request): Promise<ParsedMessageFields> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string | string[]> = {};
    const busboy = Busboy({ headers: req.headers });

    busboy.on('field', (name, value) => {
      accumulate(fields, name, value);
    });

    busboy.on('error', (err) => {
      reject(err instanceof Error ? err : new Error(String(err)));
    });

    busboy.on('close', () => {
      let recipientVariables: Record<string, Record<string, string>> = {};
      const rawRecipientVariables = asString(fields['recipient-variables']);
      if (rawRecipientVariables) {
        try {
          recipientVariables = JSON.parse(rawRecipientVariables);
        } catch {
          // Malformed recipient-variables is a caller bug, not ours to fix
          // silently — leave it empty so token resolution just no-ops
          // rather than crash the whole batch.
        }
      }
      // Replaced, not refused — see sanitizeRecipientVariables' own doc
      // comment for why member-supplied recipient-variables get different
      // treatment from every other header-bound field below. Walked on
      // whatever JSON.parse actually returned, not on the declared
      // Record<string, Record<string, string>> shape. A malformed-JSON
      // caller never reaches here: the catch above already left
      // recipientVariables at {}, which has nothing to sanitize.
      recipientVariables = sanitizeRecipientVariables(recipientVariables);

      const from = asString(fields.from);
      if (containsHeaderInjectionChars(from)) {
        reject(new Error("'from' contains a CR, LF or NUL character"));
        return;
      }

      const subject = asString(fields.subject);
      if (containsHeaderInjectionChars(subject)) {
        reject(new Error("'subject' contains a CR, LF or NUL character"));
        return;
      }

      const headers: Record<string, string> = {};
      const options: Record<string, string | string[]> = {};
      const customVars: Record<string, string> = {};

      for (const [key, value] of Object.entries(fields)) {
        if (key.startsWith('h:')) {
          const fieldName = key.slice(2);
          if (!isValidHeaderFieldName(fieldName)) {
            reject(new Error(`Invalid header field name: ${JSON.stringify(fieldName)}`));
            return;
          }
          const headerValue = asString(value);
          if (containsHeaderInjectionChars(headerValue)) {
            reject(new Error(`h:${fieldName} value contains a CR, LF or NUL character`));
            return;
          }
          // Sender and From are dropped on any spelling nodemailer folds into them;
          // From is the one checked identity, and nothing legitimate is lost.
          // See mailgunFields.md#sender-and-from-are-never-taken-from-the-tenant.
          if (IDENTITY_HEADER_NAMES.has(normalizeMailHeaderKey(fieldName))) {
            continue;
          }
          headers[fieldName] = headerValue;
        } else if (key.startsWith('o:')) {
          options[key.slice(2)] = value;
        } else if (key.startsWith('v:')) {
          const varName = key.slice(2);
          const varValue = asString(value);
          // v:* is tenant-authored (Ghost's own request only ever sets
          // v:email-id), not member-supplied like recipient-variables, so
          // it gets the same refuse-outright treatment as from/subject/h:*
          // rather than sanitizeRecipientVariables' replacement — see
          // containsHeaderInjectionChars' own doc comment. Today only
          // email-id reaches a header (routes/drain.ts's
          // headers['X-Ghost-Email-Id']); this check covers every v:* key
          // so a future one that starts flowing into a header is already
          // closed.
          if (containsHeaderInjectionChars(varValue)) {
            reject(new Error(`v:${varName} value contains a CR, LF or NUL character`));
            return;
          }
          if (varName === 'email-id' && !isValidGhostEmailId(varValue)) {
            reject(new Error('v:email-id must be a 24-character lowercase hex Ghost object id'));
            return;
          }
          customVars[varName] = varValue;
        }
      }

      resolve({
        to: asArray(fields.to)
          .flatMap((v) => v.split(',').map((e) => e.trim()))
          .filter(Boolean),
        from,
        subject,
        html: asString(fields.html),
        text: asString(fields.text),
        recipientVariables,
        headers,
        options,
        customVars,
      });
    });

    req.pipe(busboy);
  });
}

/**
 * Resolves Mailgun's `%recipient.<var>%` template syntax
 * (mailgun-client.js:56-70) against one recipient's variables. Applied to
 * subject/html/text and to headers — real Mailgun resolves these tokens
 * anywhere they appear, which matters for e.g. `h:List-Unsubscribe`
 * carrying a per-recipient unsubscribe URL. Tokens with no matching
 * variable (e.g. Mailgun's own `%tag_unsubscribe_email%`, a
 * platform-hosted-click-tracking feature this shim doesn't provide) are
 * left untouched rather than resolved to an empty string.
 */
export function resolveRecipientTokens(content: string, variables: Record<string, string>): string {
  if (!content) {
    return content;
  }
  return content.replace(/%recipient\.([^%]+)%/g, (match, varName: string) => {
    return Object.prototype.hasOwnProperty.call(variables, varName) ? variables[varName]! : match;
  });
}
