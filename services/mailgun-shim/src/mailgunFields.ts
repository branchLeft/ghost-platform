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

/**
 * Hard ceilings on one send request, so a single tenant cannot exhaust the
 * memory of the process that serves every tenant. Fixed, not configurable;
 * `recipients` is not the SMTP per-message cap. See mailgunFields.md#multipart-limits.
 */
export const MULTIPART_LIMITS = {
  fields: 1100,
  parts: 1200,
  fieldSize: 5 * 1024 * 1024,
  fieldNameSize: 100,
  totalBytes: 10 * 1024 * 1024,
  recipients: 1000,
} as const;

export type MultipartLimitReason = keyof typeof MULTIPART_LIMITS;

export class MultipartLimitError extends Error {
  readonly reason: MultipartLimitReason;
  readonly limit: number;

  constructor(reason: MultipartLimitReason) {
    const limit = MULTIPART_LIMITS[reason];
    super(`Request exceeds the ${reason} limit of ${limit}`);
    this.name = 'MultipartLimitError';
    this.reason = reason;
    this.limit = limit;
  }
}

/**
 * Busboy reports `parts` and `fieldSize` as reached, not exceeded: a body of
 * exactly that many parts, or a value of exactly that many bytes, already
 * trips them. One more is passed so the stated ceilings are the largest
 * accepted values. `fields` fires only on the field after the cap, as is.
 * Busboy 1.x never applies `fieldNameSize`; the name length is checked here.
 */
const BUSBOY_LIMITS = {
  fields: MULTIPART_LIMITS.fields,
  parts: MULTIPART_LIMITS.parts + 1,
  fieldSize: MULTIPART_LIMITS.fieldSize + 1,
} as const;

/** The limit one accepted-looking field breaks, if any; `fieldBytes` already includes this field. */
export function findFieldLimitReason(
  name: string,
  info: { nameTruncated: boolean; valueTruncated: boolean },
  fieldBytes: number
): MultipartLimitReason | null {
  if (info.nameTruncated || Buffer.byteLength(name) > MULTIPART_LIMITS.fieldNameSize) {
    return 'fieldNameSize';
  }
  if (info.valueTruncated) {
    return 'fieldSize';
  }
  return fieldBytes > MULTIPART_LIMITS.totalBytes ? 'totalBytes' : null;
}

/**
 * Splits comma-joined `to` values into trimmed, non-empty recipients, one
 * segment at a time so a field of nothing but commas allocates nothing.
 *
 * Returns null when there are more than MULTIPART_LIMITS.recipients.
 */
function collectRecipients(values: string[]): string[] | null {
  const recipients: string[] = [];
  for (const value of values) {
    let start = 0;
    while (start <= value.length) {
      const comma = value.indexOf(',', start);
      const end = comma === -1 ? value.length : comma;
      const recipient = value.slice(start, end).trim();
      if (recipient) {
        recipients.push(recipient);
        if (recipients.length > MULTIPART_LIMITS.recipients) {
          return null;
        }
      }
      start = end + 1;
    }
  }
  return recipients;
}

/**
 * Reads the multipart body of a Mailgun send request into fields. Files are
 * never read. Refuses past MULTIPART_LIMITS: a field or part over a cap is
 * refused rather than silently dropped or truncated, and the request is
 * unpiped so no more of it is buffered.
 *
 * @throws MultipartLimitError when the body or the recipient list exceeds a limit.
 * @throws Error when the body is malformed or a header-bound field carries
 *   a CR, LF or NUL, or an invalid header name or v:email-id.
 */
export function parseMailgunMessageFields(req: Request): Promise<ParsedMessageFields> {
  return new Promise((resolve, reject) => {
    const fields: Record<string, string | string[]> = {};
    const busboy = Busboy({ headers: req.headers, limits: BUSBOY_LIMITS });
    let isSettled = false;
    let fieldBytes = 0;

    const refuse = (error: Error): void => {
      if (isSettled) {
        return;
      }
      isSettled = true;
      req.unpipe(busboy);
      reject(error);
    };

    busboy.on('fieldsLimit', () => {
      refuse(new MultipartLimitError('fields'));
    });

    busboy.on('partsLimit', () => {
      refuse(new MultipartLimitError('parts'));
    });

    busboy.on('field', (name, value, info) => {
      fieldBytes += Buffer.byteLength(name) + Buffer.byteLength(value);
      const reason = findFieldLimitReason(name, info, fieldBytes);
      if (reason !== null) {
        refuse(new MultipartLimitError(reason));
        return;
      }
      accumulate(fields, name, value);
    });

    busboy.on('error', (err) => {
      refuse(err instanceof Error ? err : new Error(String(err)));
    });

    busboy.on('close', () => {
      const to = collectRecipients(asArray(fields.to));
      if (to === null) {
        refuse(new MultipartLimitError('recipients'));
        return;
      }
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
        to,
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
