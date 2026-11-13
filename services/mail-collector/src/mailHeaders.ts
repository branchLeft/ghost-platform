/**
 * The one place a header block is read and our own MTA's Authentication-Results
 * header is found. Shared by the ARF reader (arf/arfReader.ts) and the DSN
 * path (dsn.ts) so the two cannot drift: a trust rule fixed in one is fixed in
 * both. Pure and linear in the input: no regex backtracking over message text.
 * See ./arf/README.md for the fail-closed rules and what is still unproven.
 */

export const MAX_HEADERS = 200;

export type Headers = Array<[string, string]>;

/** Header lines to name/value pairs, or null on anything the grammar does not allow. Expects LF line ends. */
export function parseHeaders(raw: string): Headers | null {
  const out: Headers = [];
  // The newline before a delimiter belongs to the delimiter, not to the block.
  const block = raw.replace(/\n+$/, '');
  if (block === '') {
    return out;
  }
  for (const line of block.split('\n')) {
    if (/^[ \t]/.test(line)) {
      const last = out[out.length - 1];
      if (!last) {
        return null;
      }
      last[1] = `${last[1]} ${line.trim()}`;
      continue;
    }
    const match = /^([!-9;-~]+):[ \t]*(.*)$/.exec(line);
    if (!match) {
      return null;
    }
    out.push([match[1]!.toLowerCase(), match[2]!.trim()]);
    if (out.length > MAX_HEADERS) {
      return null;
    }
  }
  return out;
}

export function splitBlock(text: string): { head: string; body: string } {
  if (text.startsWith('\n')) {
    return { head: '', body: text.slice(1) };
  }
  const at = text.indexOf('\n\n');
  return at < 0 ? { head: text, body: '' } : { head: text.slice(0, at), body: text.slice(at + 2) };
}

export const values = (headers: Headers, name: string): string[] =>
  headers.filter(([n]) => n === name).map(([, v]) => v);

/** Removes RFC 5322 comments in one pass. Null if parentheses do not balance. */
export function stripComments(value: string): string | null {
  let out = '';
  let depth = 0;
  for (let i = 0; i < value.length; i += 1) {
    const c = value[i]!;
    if (depth === 0) {
      if (c === ')') {
        return null;
      }
      if (c === '(') {
        depth = 1;
        out += ' ';
      } else {
        out += c;
      }
    } else if (c === '\\') {
      // A quoted-pair inside a comment: the next character is text, never a boundary.
      i += 1;
    } else if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
    }
  }
  return depth === 0 ? out : null;
}

/** The raw first token of a header value, before any space, semicolon or comment. Empty if the value opens with one of those. */
export const leadingToken = (raw: string): string => /^[^\s;(]*/.exec(raw)![0].toLowerCase();

/** A lower-cased authserv-id, or a TypeError if it is not a plain host name. */
export function normaliseAuthservId(id: string): string {
  const lowered = id.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(lowered)) {
    throw new TypeError('trustedAuthservId must be a host name');
  }
  return lowered;
}

/**
 * The result clauses of the one Authentication-Results header our own MTA
 * wrote: everything after the authserv-id, split at semicolons, comments
 * removed. Null unless there is exactly one such header and it is well formed.
 * A header that names another host up front is skipped before any stripping,
 * so a forged header for another id cannot hide ours or break it; a second
 * header carrying our id, an unbalanced comment in ours, or a malformed id
 * clause all give null. `trustedId` must already be normalised.
 */
export function trustedAuthResults(headers: Headers, trustedId: string): string[] | null {
  let matched = 0;
  let clauses: string[] = [];
  for (const raw of values(headers, 'authentication-results')) {
    const token = leadingToken(raw);
    if (token !== '' && token !== trustedId) {
      continue;
    }
    const value = stripComments(raw);
    if (value === null) {
      return null;
    }
    const pieces = value.split(';');
    const lead = pieces[0]!.trim().split(/\s+/);
    if (lead[0]!.toLowerCase() !== trustedId) {
      continue;
    }
    if (lead.length > 2 || (lead.length === 2 && !/^[0-9]+$/.test(lead[1]!))) {
      return null;
    }
    matched += 1;
    clauses = pieces.slice(1);
  }
  return matched === 1 ? clauses : null;
}
