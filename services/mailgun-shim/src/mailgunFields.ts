import Busboy from 'busboy';
import type { Request } from 'express';
// nodemailer's own header-key normalisation, not reimplemented. Any h:* key
// this shim later stores as a header reaches nodemailer's mail-composer via
// addHeader, which keys each custom header by this same normalisation before
// appending it — verified against the installed package
// (nodemailer/lib/mime-node/index.js, MimeNode.prototype._normalizeHeaderKey:
// strips control characters, trims (which also removes NBSP/BOM — both are
// ECMAScript whitespace — but not a zero-width space, which is not), then
// lower/upper-cases into nodemailer's canonical form; 'sender', 'SENDER',
// ' Sender' and 'Sender ' all normalise to 'Sender'). The method reads only
// its `key` argument, so calling it straight off the prototype needs no
// MimeNode instance. `@types/nodemailer`'s own .d.ts for this path declares
// the public shape only — `_normalizeHeaderKey` is private/undocumented — so
// it is reached through a narrow local cast rather than a `declare module`
// augmentation, which would have to redeclare (and could drift from) that
// published type.
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
 * RFC 5322's field-name grammar: one or more printable US-ASCII characters
 * (33-126) other than ':', the character that ends a field name on the
 * wire. An `h:*` multipart field name that fails this can't be emitted as a
 * real header line at all (a literal colon reads as the name/value
 * separator to any RFC 5322 parser, so `h:Sender:` becomes the line
 * `Sender:: value`, which a parser reads as field name `Sender`), or
 * normalises inconsistently across parsers (a control character, NBSP,
 * ZWSP or BOM in the name) — refusing the whole class up front, rather than
 * only the specific shapes demonstrated so far, is what closes it against a
 * shape nobody has tried yet.
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
 * CR, LF and NUL are the three characters that let one header-bound value
 * escape its own field: RFC 5322 forbids a bare CR or LF inside a field
 * body (folding whitespace is CRLF *followed by* WSP, a well-formed shape
 * nothing in this shim produces — an unfolded, bare CR or LF is always
 * either a second header line or a truncated one), and a downstream
 * C-string-based consumer can treat an embedded NUL as an early
 * terminator. Checked on the raw value the caller sent, before
 * %recipient.*% substitution (routes/drain.ts's toWireMessage) or any MIME
 * decoding a downstream renderer might still apply to it — the SMTP front
 * door (smtpFrontDoor.ts) reuses this same check on mailparser's already
 * MIME-decoded values, since an encoded-word can decode to a CRLF that was
 * never literally on the wire.
 */
const HEADER_INJECTION_PATTERN = /[\r\n\0]/;

export function containsHeaderInjectionChars(value: string): boolean {
  return HEADER_INJECTION_PATTERN.test(value);
}

/**
 * recipient-variables carries member-supplied data (a signup name, not
 * anything the tenant wrote), and Ghost does not sanitise it before it
 * reaches here — a member's own `name` comes straight from their signup
 * request body (members-api/controllers/router-controller.js:1046,
 * forks/Ghost tag v6.55.0) with no CR/LF/NUL stripping on that path. From,
 * subject and every h:* value are refused outright on the same characters
 * (containsHeaderInjectionChars, above) because those are tenant-authored
 * and a tenant can simply be asked to resend a corrected request — but
 * refusing here would fail an entire Ghost newsletter batch (real Mailgun's
 * batch size is 1,000 recipients) over one member's uncontrolled name, and
 * Ghost retries the batch a fixed number of times before giving up
 * (email-service/batch-sending-service.js:43's MAILGUN_API_RETRY_CONFIG)
 * rather than dropping just that recipient. Replacing the character instead
 * keeps the rest of the batch delivering, and is still safe against
 * injection: the sanitised value is what %recipient.*% substitution
 * (routes/drain.ts's toWireMessage) later splices into subject, html, text
 * or a header, so nothing it produces can carry a CR, LF or NUL through to
 * become a second header line.
 *
 * recipient-variables is also caller-controlled JSON (`JSON.parse` on an
 * untrusted string), so its shape is not guaranteed to match
 * ParsedMessageFields' declared `Record<string, Record<string, string>>` —
 * a value can be a nested object or array with a string somewhere inside
 * it. This walks whatever JSON.parse actually returned, recursively, so a
 * string buried under an extra level of nesting is still sanitised rather
 * than silently passed through because it didn't match the declared shape.
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
 * Ghost's own `v:email-id` is always the Email model's row id, a
 * MongoDB-style ObjectId minted by bson-objectid's
 * `ObjectId().toHexString()` on create — every Bookshelf model's `id` is
 * assigned this way (forks/Ghost tag v6.55.0,
 * models/base/utils.js:38, models/base/plugins/events.js:260) — and
 * threaded through unchanged from there (batch-sending-service.js's
 * `emailId: email.id` → mailgun-email-provider.js's `id: emailId` →
 * mailgun-client.js's `messageData['v:email-id'] = message.id`, only ever
 * set when `message.id` is present). It is always exactly 24 lowercase hex
 * characters, never anything a tenant chooses, so checking the fixed shape
 * (rather than only refusing the three injection characters) loses nothing
 * legitimate.
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
          // Neither Sender nor From is ever taken from the tenant, on any
          // spelling nodemailer will later fold into one of those two names:
          // Ghost's own request always carries 'h:Sender' equal to its own
          // From (mailgun-client.js:65,71, forks/Ghost tag v6.55.0 —
          // `from: message.from` and `'h:Sender': message.from` are the same
          // value), and the top-level `from` field is the one checked
          // identity (routes/messages.ts, senderBelongsToTenant) — an h:From
          // is never itself a candidate to become the visible sender, so
          // nothing legitimate is ever lost by dropping both unconditionally.
          // The value is never inspected past the injection check above,
          // because there is nothing a dropped header could still do. This
          // runs at parse time, before a batch is ever enqueued — the one
          // point every HTTP-side delivery mechanism this shim could route a
          // message through has to pass, so the guarantee "no tenant-supplied
          // Sender or From header is ever stored" doesn't depend on which
          // one is currently wired up.
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
