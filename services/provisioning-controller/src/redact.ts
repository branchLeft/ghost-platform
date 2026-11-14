/** What a removed value is replaced with. */
export const REDACTED = '[redacted]';

const SECRET_WORD =
  '(?:secret|token|passw(?:or)?d|passphrase|pwd|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key)';
/** The secret words the original single rule knew (no passphrase). */
const LEGACY_WORD =
  '(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key)';
/**
 * A field name: a whole run of name characters that holds a secret word. It starts only at the
 * start of the run and checks for the word once, ahead, so a long run is read a fixed number of
 * times however many secret words or dots it holds. The pattern this replaces, `[\w.-]*WORD[\w.-]*`
 * tried from every word start, read the rest of the run from each one (quadratic). A name only
 * ever ends at the end of its run (a separator or quote follows it, and neither is a name
 * character), so nothing the old pattern matched is missed: only a leading dot or dash, which the
 * old pattern left outside the name, now sits inside it, and every rule here keeps the name.
 */
const fieldName = (word: string): string => `(?<![\\w.-])(?=[\\w.-]*?${word})[\\w.-]+`;
const SECRET_FIELD = fieldName(SECRET_WORD);
const LEGACY_FIELD = fieldName(LEGACY_WORD);
/** The start of another secret field (name, optional closing quote, separator), at a word start. */
const NEXT_FIELD = `${SECRET_FIELD}["']?\\s*[=:]`;
/**
 * A quoted value may hold backslash escapes (\" or \\), but the escape-aware form never runs
 * across the start of another secret field: a value that ends in a backslash
 * (password="ab\" token="x") would otherwise read \" as an escape and swallow the next field.
 * Its closing quote must not run straight into a word (a "," then a key name after an escaped
 * quote is a new field, not the end of this value). When it finds no closing quote, the plain
 * quote-to-quote form takes the whole value, as the original rule did; only an unterminated
 * quote falls to the bare form.
 */
const quoted = (q: string): string => `${q}(?:(?!${NEXT_FIELD})[^${q}\\\\]|\\\\.)*${q}(?!\\w)`;
const VALUE = `${quoted('"')}|${quoted("'")}|"[^"]*"|'[^']*'|[^\\s,;]+`;
/** Auth schemes that stand before the credential in an Authorization header. */
const AUTH_SCHEME = '(?:bearer|basic|token|digest|negotiate|apikey|bot|hmac|oauth)';

/** The characters that end a line: an Authorization value never runs across one. */
const LINE_BREAK = '\\r\\n\\u2028\\u2029\\u0085';
/**
 * What follows an Authorization header name, whatever the scheme: every character to the end of
 * the line, so a comma, semicolon, quote, brace, field name or second scheme inside it is part of
 * the secret and none of them ends it. (A credential is never read word by word: an unknown scheme
 * word, an odd space or an empty first credential cannot hide a later one.)
 */
const BARE_VALUE = `[^${LINE_BREAK}]+`;
/** The same inside quotes: to the closing quote or the end of the line, escapes kept. */
const quotedValue = (q: string): string =>
  `(?:[^\\\\${q}${LINE_BREAK}]|\\\\[^${LINE_BREAK}]|\\\\)+`;

/**
 * Redacts the value of an Authorization or Proxy-Authorization header or key. A known scheme word
 * (and the whitespace after it, of any Unicode kind) stays so the reader can see what failed;
 * nothing after it does, and nothing is kept when the first word is not a known scheme.
 */
function authorizationRule(opening: string, value: string): Rule {
  const rule = new RegExp(
    `\\b(authorization["']?\\s*[=:]\\s*${opening})(?:(${AUTH_SCHEME})([^\\S${LINE_BREAK}]+))?${value}`,
    'gi'
  );
  return (text) =>
    text.replace(
      rule,
      (_all, head: string, scheme: string | undefined, gap: string | undefined) =>
        `${head}${scheme === undefined ? '' : scheme + (gap ?? '')}${REDACTED}`
    );
}
const AUTHORIZATION_RULES: readonly Rule[] = [
  // Not at a quote, and not at whitespace either: the whitespace before the value can give a
  // character back, which would start an unquoted value at the space before an opening quote.
  authorizationRule('(?![\\s"\'])', BARE_VALUE),
  authorizationRule('"', quotedValue('"')),
  authorizationRule("'", quotedValue("'")),
];

/** Token shapes with a fixed prefix; a JWT opens with "eyJ" and is checked by hand below. */
const TOKEN_SHAPE =
  'gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}';

/** A character of a name run: [\w-]. */
const isNameChar = (code: number): boolean =>
  (code >= 48 && code <= 57) ||
  (code >= 65 && code <= 90) ||
  (code >= 97 && code <= 122) ||
  code === 95 ||
  code === 45;

const runEnd = (text: string, from: number): number => {
  let at = from;
  while (at < text.length && isNameChar(text.charCodeAt(at))) at += 1;
  return at;
};

/**
 * Removes the token shapes: one match at a time, left to right, exactly as the single pattern
 *   gh[pousr]_… | github_pat_… | sk-… | xox…-… | AKIA… | eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*
 * did, but a JWT is checked by hand. As a pattern, each "eyJ" in a long run of name characters
 * read the whole rest of the run looking for the first dot (quadratic over glued "eyJ"s). Every
 * "eyJ" in one run reads the same two dots, so the run is read once and the answer reused.
 */
function redactTokenShapes(text: string): string {
  const shapes = new RegExp(`${TOKEN_SHAPE}|eyJ`, 'g');
  // The run last read: where it was read from, where it ends, and the end of the JWT it closes.
  let from = -1;
  let end = -1;
  let jwtEnd = -1;
  let out = '';
  let copied = 0;
  for (let hit = shapes.exec(text); hit !== null; hit = shapes.exec(text)) {
    let stop = hit.index + hit[0].length;
    if (hit[0] === 'eyJ') {
      if (stop < from || stop > end) {
        from = stop;
        end = runEnd(text, stop);
        jwtEnd = -1;
        const second = end + 1;
        if (text[end] === '.') {
          const secondEnd = runEnd(text, second);
          if (secondEnd - second >= 10 && text[secondEnd] === '.') {
            jwtEnd = runEnd(text, secondEnd + 1);
          }
        }
      }
      // The first part, from after the eyJ to the end of the run, needs ten characters.
      if (jwtEnd < 0 || end - stop < 10) continue;
      stop = jwtEnd;
    }
    out += text.slice(copied, hit.index) + REDACTED;
    copied = stop;
    shapes.lastIndex = stop;
  }
  return out + text.slice(copied);
}

type Rule = readonly [RegExp, string] | ((text: string) => string);

/** Each rule keeps what the reader needs (a field name, a scheme) and drops the value. */
const RULES: readonly Rule[] = [
  [/-----BEGIN [A-Z ]*-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g, REDACTED],
  // A URL password. The scheme is looked for backwards from the "://", so a long run of dotted
  // words is not rescanned from each word start.
  [/(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, `${REDACTED}@`],
  // An Authorization or Proxy-Authorization header or JSON key: keep a known scheme word, drop
  // the whole value after it (to the end of the line or the closing quote).
  ...AUTHORIZATION_RULES,
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // The original field rule, unchanged, runs before the wider rules below so that nothing it
  // removed can be left readable by them: a new rule must never read a glued field name or a
  // quote as part of an earlier value (password":x token="y"). The wider field rule below
  // then finishes what this one cannot see (JSON keys, passphrase, escaped quotes).
  [
    new RegExp(
      `(${LEGACY_FIELD})(\\s*[=:]\\s*)(?!${AUTH_SCHEME}[ \\t]+\\[redacted\\])("[^"]*"|'[^']*'|[^\\s,;]+)`,
      'gi'
    ),
    `$1$2${REDACTED}`,
  ],
  // Token shapes and long opaque runs follow the original field rule, as they always did, and
  // go before the wider rules below, which would otherwise cut a long run in two.
  redactTokenShapes,
  [/[A-Za-z0-9+/_=-]{32,}/g, REDACTED],
  // A command-line flag whose value is the next word: --password hunter2. The lookbehind
  // lets only the first dash of a run start a match, which keeps a long dash run linear.
  // A "value" that starts with - = or : is the next flag or a separator (--password = x),
  // which the field rule below handles.
  [
    new RegExp(`((?<![\\w-])--(?=[\\w-]*?${SECRET_WORD})[\\w-]+[ \\t]+)(?![-=:])(${VALUE})`, 'gi'),
    `$1${REDACTED}`,
  ],
  // A field name, then an optional closing quote (JSON, Python repr), a separator and a value.
  // (An Authorization scheme already followed by [redacted] is left as the rule above wrote it.)
  [
    new RegExp(
      `(${SECRET_FIELD})(["']?\\s*[=:]\\s*)(?!${AUTH_SCHEME}[ \\t]+\\[redacted\\])(${VALUE})`,
      'gi'
    ),
    `$1$2${REDACTED}`,
  ],
  // A secret word with no separator: only when the next word looks like a credential
  // (six or more characters with a digit), so "invalid token" and "token expired" stay readable.
  [new RegExp(`(${SECRET_FIELD}[ \\t]+)(?=[\\w.~+/=-]*\\d)[\\w.~+/=-]{6,}`, 'gi'), `$1${REDACTED}`],
];

/**
 * Removes anything shaped like a secret from text a host adapter produced.
 * It is a backstop for an adapter that leaks, not a licence to: it errs
 * towards removing too much, because the text goes to a file and a console.
 */
export function redactSecrets(text: string): string {
  return RULES.reduce(
    (out, rule) => (typeof rule === 'function' ? rule(out) : out.replace(rule[0], rule[1])),
    text
  );
}
