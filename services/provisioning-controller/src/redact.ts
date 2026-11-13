/** What a removed value is replaced with. */
export const REDACTED = '[redacted]';

const SECRET_WORD =
  '(?:secret|token|passw(?:or)?d|passphrase|pwd|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key)';
const SECRET_FIELD = `[\\w.-]*${SECRET_WORD}[\\w.-]*`;
/**
 * A quoted value may hold backslash escapes (\" or \\). When no closing quote follows that way
 * (a value that ends in a backslash), the plain quote-to-quote form still takes the whole value,
 * as the original rule did; only an unterminated quote falls to the bare form.
 */
const VALUE = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|"[^"]*"|\'[^\']*\'|[^\\s,;]+';
/** Auth schemes that stand before the credential in an Authorization header. */
const AUTH_SCHEME = '(?:bearer|basic|token|digest|negotiate|apikey|bot|hmac|oauth)';

/** Each rule keeps what the reader needs (a field name, a scheme) and drops the value. */
const RULES: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, `$1${REDACTED}@`],
  // An Authorization header or JSON key: keep the scheme word, drop the credential after it.
  [
    new RegExp(
      `\\b(authorization["']?\\s*[=:]\\s*["']?)(${AUTH_SCHEME}[ \\t]+)?[^\\s,;"'}]+`,
      'gi'
    ),
    `$1$2${REDACTED}`,
  ],
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // A command-line flag whose value is the next word: --password hunter2. The lookbehind
  // lets only the first dash of a run start a match, which keeps a long dash run linear.
  // A "value" that starts with - = or : is the next flag or a separator (--password = x),
  // which the field rule below handles.
  [
    new RegExp(`((?<![\\w-])--[\\w-]*${SECRET_WORD}[\\w-]*[ \\t]+)(?![-=:])(${VALUE})`, 'gi'),
    `$1${REDACTED}`,
  ],
  // A field name, then an optional closing quote (JSON, Python repr), a separator and a value.
  // (An Authorization scheme already followed by [redacted] is left as the rule above wrote it.)
  [
    new RegExp(
      `\\b(${SECRET_FIELD})(["']?\\s*[=:]\\s*)(?!${AUTH_SCHEME}[ \\t]+\\[redacted\\])(${VALUE})`,
      'gi'
    ),
    `$1$2${REDACTED}`,
  ],
  // A secret word with no separator: only when the next word looks like a credential
  // (six or more characters with a digit), so "invalid token" and "token expired" stay readable.
  [
    new RegExp(`\\b(${SECRET_FIELD}[ \\t]+)(?=[\\w.~+/=-]*\\d)[\\w.~+/=-]{6,}`, 'gi'),
    `$1${REDACTED}`,
  ],
  [
    /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g,
    REDACTED,
  ],
  [/[A-Za-z0-9+/_=-]{32,}/g, REDACTED],
];

/**
 * Removes anything shaped like a secret from text a host adapter produced.
 * It is a backstop for an adapter that leaks, not a licence to: it errs
 * towards removing too much, because the text goes to a file and a console.
 */
export function redactSecrets(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
