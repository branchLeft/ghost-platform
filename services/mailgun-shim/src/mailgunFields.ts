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
 * the exact shapes a past review happened to try, is what closes it against
 * a shape nobody has tried yet.
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
          // Sender is never taken from the tenant, on any spelling
          // nodemailer will later fold into one: Ghost's own request always
          // carries 'h:Sender' equal to its own From (mailgun-client.js:65,71,
          // forks/Ghost tag v6.55.0 — `from: message.from` and
          // `'h:Sender': message.from` are the same value), and `from` is
          // still checked (routes/messages.ts, senderBelongsToTenant), so
          // nothing legitimate is ever lost by dropping this unconditionally
          // — the value is never inspected, because there is nothing a
          // dropped header could still do. This runs at parse time, before
          // a batch is ever enqueued — the one point every HTTP-side
          // delivery mechanism this shim could route a message through has
          // to pass, so the guarantee "no tenant-supplied Sender is ever
          // stored" doesn't depend on which one is currently wired up.
          if (normalizeMailHeaderKey(fieldName) === 'Sender') {
            continue;
          }
          headers[fieldName] = asString(value);
        } else if (key.startsWith('o:')) {
          options[key.slice(2)] = value;
        } else if (key.startsWith('v:')) {
          customVars[key.slice(2)] = asString(value);
        }
      }

      resolve({
        to: asArray(fields.to)
          .flatMap((v) => v.split(',').map((e) => e.trim()))
          .filter(Boolean),
        from: asString(fields.from),
        subject: asString(fields.subject),
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
