import Busboy from 'busboy';
import type { Request } from 'express';

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
          headers[key.slice(2)] = asString(value);
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
