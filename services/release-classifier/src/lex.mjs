// Single-pass JavaScript lexer. Every rule in the classifier reads its tokens,
// never raw text. It fails closed: anything it cannot tokenise with certainty
// throws Unlexable and the caller routes consent. See ../README.md, "How a
// file is read", for the list.

export class Unlexable extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

// Longest first, so a longer punctuator wins over its prefix.
const PUNCTUATORS = [
  '>>>=',
  '...',
  '===',
  '!==',
  '**=',
  '<<=',
  '>>=',
  '>>>',
  '&&=',
  '||=',
  '??=',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '<<',
  '>>',
  '**',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  '<',
  '>',
  '+',
  '-',
  '*',
  '%',
  '&',
  '|',
  '^',
  '!',
  '~',
  '?',
  ':',
  '=',
  '.',
];

// A `/` after one of these words starts a regex; after any other word it divides.
const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);
// A `)` closes a regex-allowing position only when its `(` follows one of these.
const CONTROL_WORDS = new Set(['if', 'while', 'for', 'with']);

// A migration is a few KB. Anything far past that is not read.
const MAX_SOURCE = 1_000_000;

const IDENT = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const NUMBER =
  /0[xX][0-9a-fA-F_]+n?|0[oO][0-7_]+n?|0[bB][01_]+n?|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?n?/y;
const LINE_END = new Set(['\n', '\r', '\u2028', '\u2029']);
const SIMPLE_ESCAPES = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

function isIdentChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_$]/.test(ch);
}

// A character outside ASCII, or a backslash, where an identifier could continue.
function foreign(ch) {
  return ch !== undefined && (ch === '\\' || ch.charCodeAt(0) > 0x7f);
}

// Decodes the escapes in a string body, so a form such as `\x44ROP` is read as
// the text it spells. An unknown escape yields the character itself, as JS does.
export function cook(raw) {
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    const e = raw[i];
    if (e === undefined) break;
    if (e === 'x' && /^[0-9a-fA-F]{2}/.test(raw.slice(i + 1, i + 3))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (e === 'u' && raw[i + 1] === '{') {
      const end = raw.indexOf('}', i);
      const code = end === -1 ? NaN : parseInt(raw.slice(i + 2, end), 16);
      if (Number.isFinite(code) && code <= 0x10ffff) {
        out += String.fromCodePoint(code);
        i = end;
      }
    } else if (e === 'u' && /^[0-9a-fA-F]{4}/.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (e === '\r' && raw[i + 1] === '\n') {
      i += 1;
    } else if (LINE_END.has(e)) {
      // a line continuation spells nothing
    } else if (Object.hasOwn(SIMPLE_ESCAPES, e)) {
      out += SIMPLE_ESCAPES[e];
    } else {
      out += e;
    }
  }
  return out;
}

// A token: t is its kind, v the identifier or punctuator text or the cooked body
// of a string or template chunk, and nl is true when a line break precedes it.
/** @returns {{ t: string, v: string, nl: boolean, pos: number, ctl?: boolean }[]} */
export function lex(source) {
  const src = String(source);
  if (src.length > MAX_SOURCE) throw new Unlexable('unlexable');
  const tokens = [];
  const braces = [];
  const parens = [];
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  let nl = false;

  const push = (t, v, pos, extra) => {
    const tok = { t, v, nl, pos, ...extra };
    tokens.push(tok);
    nl = false;
    return tok;
  };

  // Scans a template chunk starting at src[start], which is a backtick (a new
  // template) or the `}` that closed a substitution.
  const template = (start) => {
    const opening = src[start] === '`';
    let j = start + 1;
    for (;;) {
      const ch = src[j];
      if (ch === undefined) throw new Unlexable('unlexable');
      if (ch === '\\') {
        j += 2;
      } else if (ch === '`') {
        const body = cook(src.slice(start + 1, j));
        push(opening ? 'tmpl' : 'tmplTail', body, start);
        return j + 1;
      } else if (ch === '$' && src[j + 1] === '{') {
        const body = cook(src.slice(start + 1, j));
        push(opening ? 'tmplHead' : 'tmplMid', body, start);
        braces.push('t');
        return j + 2;
      } else {
        j += 1;
      }
    }
  };

  const regexAllowed = () => {
    const last = tokens[tokens.length - 1];
    if (!last) return true;
    switch (last.t) {
      case 'num':
      case 'str':
      case 'tmpl':
      case 'tmplTail':
      case 'regex':
        return false;
      case 'tmplHead':
      case 'tmplMid':
        return true;
      case 'id':
        return REGEX_AFTER_WORD.has(last.v);
      default:
        break;
    }
    if (last.v === ')') return last.ctl === true;
    if (last.v === ']') return false;
    // `}` could end a block or an object literal; `++` could be a prefix or a
    // postfix. Either guess can hide code, so neither is made.
    if (last.v === '}' || last.v === '++' || last.v === '--') {
      throw new Unlexable('unlexable');
    }
    return true;
  };

  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\v' || c === '\f') {
      i += 1;
    } else if (LINE_END.has(c)) {
      nl = true;
      i += 1;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && !LINE_END.has(src[i])) i += 1;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end === -1) throw new Unlexable('unlexable');
      for (const ch of src.slice(i, end)) if (LINE_END.has(ch)) nl = true;
      i = end + 2;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      for (;;) {
        const ch = src[j];
        if (ch === undefined || ch === '\n' || ch === '\r') throw new Unlexable('unlexable');
        if (ch === c) break;
        if (ch === '\\') j += src[j + 1] === '\r' && src[j + 2] === '\n' ? 3 : 2;
        else j += 1;
      }
      push('str', cook(src.slice(i + 1, j)), i);
      i = j + 1;
    } else if (c === '`') {
      i = template(i);
    } else if (c === '}' && braces[braces.length - 1] === 't') {
      braces.pop();
      i = template(i);
    } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (!m) throw new Unlexable('unlexable');
      const next = src[i + m[0].length];
      if (isIdentChar(next) || foreign(next)) throw new Unlexable('unlexable');
      push('num', m[0], i);
      i += m[0].length;
    } else if (/[A-Za-z_$]/.test(c)) {
      IDENT.lastIndex = i;
      const word = IDENT.exec(src)[0];
      if (foreign(src[i + word.length])) throw new Unlexable('non-ascii-identifier');
      push('id', word, i);
      i += word.length;
    } else if (c.charCodeAt(0) > 0x7f || c === '\\') {
      // Any letter outside ASCII could start an identifier. Whatever else it is, the
      // file has a character this lexer does not know.
      const letter = /\p{ID_Start}/u.test(String.fromCodePoint(src.codePointAt(i)));
      throw new Unlexable(letter ? 'non-ascii-identifier' : 'unlexable');
    } else if (c === '/' && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      for (;;) {
        const ch = src[j];
        if (ch === undefined || LINE_END.has(ch)) throw new Unlexable('unlexable');
        if (ch === '\\') j += 2;
        else if (ch === '[') {
          inClass = true;
          j += 1;
        } else if (ch === ']') {
          inClass = false;
          j += 1;
        } else if (ch === '/' && !inClass) break;
        else j += 1;
      }
      j += 1;
      while (isIdentChar(src[j])) j += 1;
      if (foreign(src[j])) throw new Unlexable('non-ascii-identifier');
      push('regex', src.slice(i, j), i);
      i = j;
    } else {
      let found = null;
      for (const p of PUNCTUATORS) {
        if (src.startsWith(p, i)) {
          found = p;
          break;
        }
      }
      // `?.` before a digit is a conditional and a decimal, not an optional chain.
      if (found === '?.' && /[0-9]/.test(src[i + 2] ?? '')) found = '?';
      if (found === null) found = src.startsWith('/=', i) ? '/=' : c === '/' ? '/' : null;
      if (found === null) throw new Unlexable('unlexable');
      if (found === '{') braces.push('b');
      else if (found === '}') braces.pop();
      let controlClose = false;
      if (found === '(') {
        const last = tokens[tokens.length - 1];
        parens.push(last?.t === 'id' && CONTROL_WORDS.has(last.v));
      } else if (found === ')') {
        controlClose = parens.pop() === true;
      }
      push('punct', found, i, found === ')' ? { ctl: controlClose } : undefined);
      i += found.length;
    }
  }
  if (braces.includes('t')) throw new Unlexable('unlexable');
  return tokens;
}
