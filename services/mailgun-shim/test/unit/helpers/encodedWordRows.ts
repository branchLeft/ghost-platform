/**
 * Sender strings for the encoded-word pins, as data. Shared by the function
 * test, the HTTP route test and the SMTP front door test, so each route is
 * held to the same rows. Code points are written as escape sequences.
 */

export type Position =
  | 'local part'
  | 'domain'
  | 'address token'
  | 'group name'
  | 'quoted string'
  | 'folded'
  | 'delimiter';

export type Encoding = 'Q lower' | 'Q upper' | 'B lower' | 'B upper' | 'mixed case' | 'none';

export interface EncodedWordRow {
  readonly id: string;
  readonly position: Position;
  readonly encoding: Encoding;
  /** What is submitted as the From value. */
  readonly submitted: string;
  /** The row holds a CRLF fold, which the HTTP route refuses for a different reason. */
  readonly folded: boolean;
  /** The value is a bare address that is also a legal MAIL FROM value. */
  readonly envelope: boolean;
}

export interface AcceptedEncodedWordRow {
  readonly id: string;
  readonly submitted: string;
  /** Queued by the function and the HTTP route. */
  readonly queued: string;
  /** Queued by the SMTP route, which reads the header through its own decoder first. */
  readonly queuedSmtp: string;
}

/** Characters whose encoded form changes how a reader splits an address. */
export const SPECIAL_CHARACTERS: ReadonlyArray<readonly [string, string]> = [
  ['at sign', '@'],
  ['dot', '.'],
  ['less-than', '<'],
  ['greater-than', '>'],
  ['colon', ':'],
  ['semicolon', ';'],
  ['comma', ','],
  ['double quote', '"'],
  ['left parenthesis', '('],
  ['right parenthesis', ')'],
  ['backslash', '\\'],
];

const hex = (character: string) =>
  character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0');

/** The same text as an encoded word in the four spellings of encoding and case. */
function spellings(text: string): ReadonlyArray<readonly [Encoding, string]> {
  const q = text.replace(/[^A-Za-z0-9]/g, (ch) => `=${hex(ch)}`);
  const b = Buffer.from(text, 'utf8').toString('base64');
  return [
    ['Q lower', `=?utf-8?q?${q}?=`],
    ['Q upper', `=?UTF-8?Q?${q}?=`],
    ['B lower', `=?utf-8?b?${b}?=`],
    ['B upper', `=?UTF-8?B?${b}?=`],
    ['mixed case', `=?Utf-8?q?${q.toLowerCase()}?=`],
  ];
}

function row(
  id: string,
  position: Position,
  encoding: Encoding,
  submitted: string,
  options: { folded?: boolean; envelope?: boolean } = {}
): EncodedWordRow {
  return {
    id: `${position}, ${encoding}: ${id}`,
    position,
    encoding,
    submitted,
    folded: options.folded ?? false,
    envelope: options.envelope ?? false,
  };
}

/** Values holding encoded-word text where a reader would take it for part of an address: every one must be refused. */
export function refusedEncodedWordRows(domain: string): EncodedWordRow[] {
  const rows: EncodedWordRow[] = [];
  for (const [encoding, word] of spellings('alice')) {
    rows.push(
      row('bare', 'local part', encoding, `${word}@${domain}`, { envelope: true }),
      row('angle', 'local part', encoding, `<${word}@${domain}>`),
      row('with a name', 'local part', encoding, `NAME_PLACEHOLDER <${word}@${domain}>`),
      row('quoted', 'quoted string', encoding, `"${word}"@${domain}`)
    );
  }
  for (const [encoding, word] of spellings(`alice@${domain}`)) {
    rows.push(
      row('bare', 'address token', encoding, word),
      row('angle', 'address token', encoding, `<${word}>`),
      row('with a name', 'address token', encoding, `NAME_PLACEHOLDER <${word}>`)
    );
  }
  for (const [encoding, word] of spellings(domain)) {
    rows.push(
      row('bare', 'domain', encoding, `alice@${word}`),
      row('angle', 'domain', encoding, `<alice@${word}>`),
      row('after the tenant domain', 'domain', encoding, `alice@${domain}${word}`)
    );
  }
  for (const [encoding, word] of spellings('G')) {
    rows.push(
      row('group name', 'group name', encoding, `${word}: alice@${domain};`),
      row('quoted group name', 'group name', encoding, `"${word}": alice@${domain};`)
    );
  }
  for (const [label, character] of SPECIAL_CHARACTERS) {
    // One Q and one B spelling each: the spellings above already cover the case variants.
    for (const [encoding, word] of spellings(`a${character}b`).filter(
      (_, at) => at === 0 || at === 3
    )) {
      rows.push(
        row(`${label} inside the word`, 'local part', encoding, `${word}@${domain}`, {
          envelope: true,
        }),
        row(`${label} inside the word`, 'group name', encoding, `${word}: alice@${domain};`)
      );
    }
  }
  const [qLower, bLower] = [spellings('ali')[0]![1], spellings('ce')[2]![1]];
  rows.push(
    row(
      'two adjacent words',
      'local part',
      'Q lower',
      `${qLower}${spellings('ce')[0]![1]}@${domain}`
    ),
    row('a word and a plain part', 'local part', 'Q lower', `alice${qLower}@${domain}`, {
      envelope: true,
    }),
    row('Q word then B word', 'local part', 'mixed case', `${qLower}${bLower}@${domain}`),
    row(
      'encoded at sign and a foreign domain',
      'local part',
      'Q lower',
      `${spellings('alice@other.example')[0]![1]}@${domain}`
    ),
    row(
      'encoded at sign and a foreign domain',
      'local part',
      'B lower',
      `${spellings('alice@other.example')[2]![1]}@${domain}`
    ),
    row(
      'a word in the second mailbox',
      'local part',
      'Q lower',
      `alice@${domain}, ${qLower}@${domain}`
    ),
    row(
      'a word that holds an angle address',
      'local part',
      'Q lower',
      `NAME_PLACEHOLDER <${spellings('a<bob@other.example>')[0]![1]}@${domain}>`
    ),
    row(
      'a word spanning the local part and the domain',
      'address token',
      'Q lower',
      `${qLower}${spellings('@')[0]![1]}${spellings(domain)[0]![1]}`
    ),
    row(
      'a name word that holds an angle address',
      'delimiter',
      'none',
      `=?utf-8?q?x<bob@other.example>?= <alice@${domain}>`
    ),
    row('a name word that holds a colon', 'delimiter', 'none', `=?utf-8?q?x:y?= <alice@${domain}>`),
    row('a word opened and never closed', 'delimiter', 'none', `=?utf-8?q?alice@${domain}`, {
      envelope: true,
    }),
    row('a closing mark with no opening', 'delimiter', 'none', `alice?=@${domain}`, {
      envelope: true,
    }),
    row('an opening mark in the local part', 'delimiter', 'none', `a=?b@${domain}`, {
      envelope: true,
    }),
    row('a fold inside the word', 'folded', 'Q lower', `=?utf-8?q?ali\r\n ce?=@${domain}`, {
      folded: true,
    }),
    row('a fold inside the charset', 'folded', 'Q lower', `=?utf-\r\n 8?q?alice?=@${domain}`, {
      folded: true,
    }),
    row(
      'a fold between two words',
      'folded',
      'Q lower',
      `${qLower}\r\n ${spellings('ce')[0]![1]}@${domain}`,
      { folded: true }
    ),
    row(
      'a fold before the address',
      'folded',
      'B lower',
      `NAME_PLACEHOLDER\r\n <${spellings('alice')[2]![1]}@${domain}>`,
      { folded: true }
    ),
    row(
      'a fold in a group name',
      'folded',
      'Q lower',
      `${spellings('G')[0]![1]}:\r\n alice@${domain};`,
      { folded: true }
    )
  );
  return rows;
}

/**
 * Domains that hold `=` or `?` without being encoded-word text: refused
 * already, by the hostname rule; pinned so that stays so.
 */
export function literalDomainRows(
  domain: string
): ReadonlyArray<{ id: string; submitted: string }> {
  return [
    { id: 'an equals sign inside the domain', submitted: `alice@tenant-a.example=com` },
    { id: 'a question mark after the domain', submitted: `alice@${domain}?x` },
    { id: 'an equals sign after the domain', submitted: `alice@${domain}=` },
  ];
}

/**
 * Senders that must still be accepted: a name, in any of the forms Ghost
 * writes, whatever its characters, and an encoded word in a display name.
 */
export function acceptedEncodedWordRows(domain: string): AcceptedEncodedWordRow[] {
  const q = '=?utf-8?q?NAME=5FPLACEHOLDER?=';
  const b = `=?utf-8?B?${Buffer.from('\u{00DC}n\u{00EF}code', 'utf8').toString('base64')}?=`;
  return [
    {
      id: 'CONTROL: a plain ASCII name',
      submitted: `NAME_PLACEHOLDER <alice@${domain}>`,
      queued: `"NAME_PLACEHOLDER" <alice@${domain}>`,
      queuedSmtp: `"NAME_PLACEHOLDER" <alice@${domain}>`,
    },
    {
      id: 'CONTROL: a quoted ASCII name',
      submitted: `"NAME_PLACEHOLDER" <alice@${domain}>`,
      queued: `"NAME_PLACEHOLDER" <alice@${domain}>`,
      queuedSmtp: `"NAME_PLACEHOLDER" <alice@${domain}>`,
    },
    {
      id: 'CONTROL: a non-ASCII name',
      submitted: `"\u{00DC}n\u{00EF}code" <alice@${domain}>`,
      queued: `"\u{00DC}n\u{00EF}code" <alice@${domain}>`,
      queuedSmtp: `"\u{00DC}n\u{00EF}code" <alice@${domain}>`,
    },
    {
      id: 'CONTROL: a bare address',
      submitted: `alice@${domain}`,
      queued: `alice@${domain}`,
      queuedSmtp: `alice@${domain}`,
    },
    {
      id: 'CONTROL: an encoded word in the display name (Q)',
      submitted: `"${q}" <alice@${domain}>`,
      queued: `"${q}" <alice@${domain}>`,
      queuedSmtp: `"NAME_PLACEHOLDER" <alice@${domain}>`,
    },
    {
      id: 'CONTROL: an encoded word in the display name (B, non-ASCII)',
      submitted: `${b} <alice@${domain}>`,
      queued: `"${b}" <alice@${domain}>`,
      queuedSmtp: `"\u{00DC}n\u{00EF}code" <alice@${domain}>`,
    },
    {
      id: 'CONTROL: an encoded word in the display name, before a plain part',
      submitted: `${q} NAME_PLACEHOLDER <alice@${domain}>`,
      queued: `"${q} NAME_PLACEHOLDER" <alice@${domain}>`,
      queuedSmtp: `"NAME_PLACEHOLDER NAME_PLACEHOLDER" <alice@${domain}>`,
    },
  ];
}
