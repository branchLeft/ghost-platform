/**
 * Sender strings for the bound-value pins, as data. Shared by the function
 * test, the SMTP front door test and the HTTP route test, so each route is
 * held to the same rows. Code points are written as escape sequences.
 */

export interface AcceptedRow {
  readonly id: string;
  /** What is submitted as the From value. */
  readonly submitted: string;
  /** What must be queued: the bound normal form. */
  readonly queued: string;
}

export interface RefusedRow {
  readonly id: string;
  readonly submitted: string;
}

/** Whitespace code points a header line can be folded at. */
export const WHITESPACE: ReadonlyArray<readonly [string, string]> = [
  ['space', ' '],
  ['tab', '\t'],
  ['no-break space', '\u{00A0}'],
  ['em space', '\u{2003}'],
  ['ideographic space', '\u{3000}'],
  ['line separator', '\u{2028}'],
  ['byte order mark', '\u{FEFF}'],
];

/** Control code points the address parser keeps rather than drops. */
export const KEPT_CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['next line', '\u{0085}'],
  ['delete', '\u{007F}'],
  ['C1 control', '\u{0090}'],
];

/** Values the gate accepts, with the value that must be queued. */
export function acceptedRows(domain: string): AcceptedRow[] {
  const rows: AcceptedRow[] = [
    {
      id: 'ordinary named sender',
      submitted: `Name <alice@${domain}>`,
      queued: `"Name" <alice@${domain}>`,
    },
    {
      id: 'one trailing dot, name holding an @',
      submitted: `"x@other.example" <alice@${domain}.>`,
      queued: `"x@other.example" <alice@${domain}>`,
    },
    {
      id: 'two trailing dots, name holding an @',
      submitted: `"x@other.example" <alice@${domain}..>`,
      queued: `"x@other.example" <alice@${domain}>`,
    },
    {
      id: 'one trailing dot, plain name',
      submitted: `"Boss" <alice@${domain}.>`,
      queued: `"Boss" <alice@${domain}>`,
    },
    {
      id: 'upper-case domain',
      submitted: `alice@${domain.toUpperCase()}`,
      queued: `alice@${domain}`,
    },
    {
      id: 'control code point the parser drops',
      submitted: `"a\u{0001}b"@${domain}`,
      queued: `ab@${domain}`,
    },
  ];
  for (const [label, ws] of WHITESPACE) {
    // Unquoted, the whitespace ends the name and the address that follows is bound.
    rows.push({
      id: `unquoted ${label} before the address`,
      submitted: `a${ws}b@${domain}`,
      queued: `"a" <b@${domain}>`,
    });
  }
  return rows;
}

export interface BackslashRow extends AcceptedRow {
  /** The name ends in a backslash (or only whitespace after it) before it is bound. */
  readonly endsInBackslash: boolean;
}

/**
 * Display names carrying a backslash. A name that ends in one is queued
 * without it. The SMTP route reads the header through its own parser first and
 * refuses the three that end in a backslash; the function and the HTTP route
 * queue the normal form.
 */
export function backslashNameRows(domain: string): BackslashRow[] {
  return [
    {
      id: 'display name ending in a backslash',
      submitted: `"Name\\\\" <alice@${domain}>`,
      queued: `"Name" <alice@${domain}>`,
      endsInBackslash: true,
    },
    {
      id: 'display name ending in a backslash and a space',
      submitted: `"Name\\\\ " <alice@${domain}>`,
      queued: `"Name" <alice@${domain}>`,
      endsInBackslash: true,
    },
    {
      id: 'display name that is only a backslash',
      submitted: `"\\\\" <alice@${domain}>`,
      queued: `alice@${domain}`,
      endsInBackslash: true,
    },
    {
      id: 'display name with a backslash inside, as Ghost writes it',
      submitted: `"A\\\\B" <alice@${domain}>`,
      queued: `"A\\\\B" <alice@${domain}>`,
      endsInBackslash: false,
    },
  ];
}

/** Values that must be refused: whitespace or a kept control inside a quoted local part. */
export function refusedRows(domain: string): RefusedRow[] {
  const rows: RefusedRow[] = [];
  for (const [label, ws] of [...WHITESPACE, ...KEPT_CONTROLS]) {
    rows.push({ id: `${label} inside a quoted local part`, submitted: `"a${ws}b"@${domain}` });
  }
  rows.push({
    id: 'unterminated bracket then a second mailbox',
    submitted: `[ ( ] <alice@${domain}> ) <bob@other.example>`,
  });
  return rows;
}

/** MAIL FROM values for a message with no header From: accepted, with the value queued. */
export function fallbackAcceptedRows(domain: string): AcceptedRow[] {
  return [
    { id: 'plain address', submitted: `alice@${domain}`, queued: `alice@${domain}` },
    { id: 'quoted local part', submitted: `"alice"@${domain}`, queued: `alice@${domain}` },
    {
      id: 'upper-case domain',
      submitted: `alice@${domain.toUpperCase()}`,
      queued: `alice@${domain}`,
    },
  ];
}

/** The sender domain and MAIL FROM value of the fallback row the gate must refuse. */
export const FALLBACK_REFUSED = {
  domain: 'localhost',
  submitted: '[""%"\u{202E}]alice\\)(c)(%2e\u{FF03}@localhost',
} as const;
