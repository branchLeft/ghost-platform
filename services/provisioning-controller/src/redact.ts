/** What a removed value is replaced with. */
export const REDACTED = '[redacted]';

const SECRET_WORD =
  '(?:secret|token|passw(?:or)?d|passphrase|pwd|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key)';
const SECRET_FIELD = `[\\w.-]*${SECRET_WORD}[\\w.-]*`;
/** The secret words the original single rule knew (no passphrase). */
const LEGACY_FIELD =
  '[\\w.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key)[\\w.-]*';
/** The start of another secret field (name, optional closing quote, separator), at a word start. */
const NEXT_FIELD = `(?<![\\w.-])${SECRET_FIELD}["']?\\s*[=:]`;
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

/** Each rule keeps what the reader needs (a field name, a scheme) and drops the value. */
const RULES: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, `$1${REDACTED}@`],
  // An Authorization header or JSON key: keep the scheme word, drop the credential after it.
  // The credential stops before a glued secret field name, which the field rules then handle.
  [
    new RegExp(
      `\\b(authorization["']?\\s*[=:]\\s*["']?)(${AUTH_SCHEME}[ \\t]+)?(?:(?!${NEXT_FIELD})[^\\s,;"'}])+`,
      'gi'
    ),
    `$1$2${REDACTED}`,
  ],
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // The original field rule, unchanged, runs before the wider rules below so that nothing it
  // removed can be left readable by them: a new rule must never read a glued field name or a
  // quote as part of an earlier value (password":x token="y"). The wider field rule below
  // then finishes what this one cannot see (JSON keys, passphrase, escaped quotes).
  [
    new RegExp(
      `\\b(${LEGACY_FIELD})(\\s*[=:]\\s*)(?!${AUTH_SCHEME}[ \\t]+\\[redacted\\])("[^"]*"|'[^']*'|[^\\s,;]+)`,
      'gi'
    ),
    `$1$2${REDACTED}`,
  ],
  // Token shapes and long opaque runs follow the original field rule, as they always did, and
  // go before the wider rules below, which would otherwise cut a long run in two.
  [
    /gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]*/g,
    REDACTED,
  ],
  [/[A-Za-z0-9+/_=-]{32,}/g, REDACTED],
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
];

/**
 * Removes anything shaped like a secret from text a host adapter produced.
 * It is a backstop for an adapter that leaks, not a licence to: it errs
 * towards removing too much, because the text goes to a file and a console.
 */
export function redactSecrets(text: string): string {
  return RULES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}
