// Finds the magic link in a message the spool kept. The spool stores the SMTP
// DATA as sent: headers, MIME parts, quoted-printable or base64 bodies. A link
// is a long line, so Ghost's mail library soft-wraps it (`=` at a line end) and
// escapes its `=` signs (`=3D`); reading the raw text would return a broken URL.
// Types only erase at run time: Node strips them, so this file runs as written.

export interface SpooledMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

interface Part {
  readonly headers: ReadonlyMap<string, string>;
  readonly body: string;
}

function splitPart(raw: string): Part {
  const normalised = raw.replace(/\r\n/g, '\n');
  const cut = normalised.indexOf('\n\n');
  const head = cut < 0 ? normalised : normalised.slice(0, cut);
  const body = cut < 0 ? '' : normalised.slice(cut + 2);
  const headers = new Map<string, string>();
  // A header continues on the next line when that line starts with whitespace.
  for (const line of head.replace(/\n[ \t]+/g, ' ').split('\n')) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { headers, body };
}

export function decodeQuotedPrintable(text: string): string {
  return text
    .replace(/=\n/g, '')
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16))
    );
}

function decodeBody(part: Part): string {
  const encoding = (part.headers.get('content-transfer-encoding') ?? '').toLowerCase();
  if (encoding === 'quoted-printable') return decodeQuotedPrintable(part.body);
  if (encoding === 'base64')
    return Buffer.from(part.body.replace(/\s+/g, ''), 'base64').toString('utf8');
  return part.body;
}

/** Every text body in a message, decoded, one entry per leaf MIME part. */
export function decodedBodies(raw: string): string[] {
  const part = splitPart(raw);
  const type = part.headers.get('content-type') ?? '';
  const boundary = /boundary="?([^";\s]+)"?/i.exec(type)?.[1];
  if (/^multipart\//i.test(type) && boundary !== undefined) {
    return part.body
      .split(`--${boundary}`)
      .slice(1)
      .filter((piece) => !piece.startsWith('--'))
      .flatMap((piece) => decodedBodies(piece.replace(/^\n/, '')));
  }
  return [decodeBody(part)];
}

/** The first `<origin>/members/?token=...` link in the message, or null. */
export function findMagicLink(raw: string, origin: string): string | null {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}/members/\\?[^\\s"'<>]+`);
  for (const body of decodedBodies(raw)) {
    const found = pattern.exec(body);
    if (found !== null) return found[0].replace(/&amp;/g, '&');
  }
  return null;
}
