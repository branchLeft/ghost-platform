/** What a removed value is replaced with. */
export const REDACTED = '[redacted]';

const SECRET_FIELD =
  '[\\w.-]*(?:secret|token|passw(?:or)?d|pwd|api[_-]?key|credential|authorization|private[_-]?key|access[_-]?key)[\\w.-]*';

/** Each rule keeps what the reader needs (a field name, a scheme) and drops the value. */
const RULES: readonly (readonly [RegExp, string])[] = [
  [/-----BEGIN [A-Z ]*-----[\s\S]*?(?:-----END [A-Z ]*-----|$)/g, REDACTED],
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, `$1${REDACTED}@`],
  [/\b(bearer|basic)\s+[\w.~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  [
    new RegExp(`\\b(${SECRET_FIELD})(\\s*[=:]\\s*)("[^"]*"|'[^']*'|[^\\s,;]+)`, 'gi'),
    `$1$2${REDACTED}`,
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
