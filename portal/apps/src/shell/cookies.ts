/** Reads a Cookie header into name/value pairs; the first occurrence of a name wins. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name === '') continue;
    if (!cookies.has(name)) cookies.set(name, part.slice(at + 1).trim());
  }
  return cookies;
}

export interface CookieOptions {
  /** Seconds; zero or less clears the cookie. */
  readonly maxAge: number;
  /** Sent only over TLS, and the `__Host-` prefix is added to the name. */
  readonly secure: boolean;
}

/**
 * What a `cookiePrefix` may be: a lowercase letter, then lowercase letters,
 * digits and hyphens, at most 32 characters. The prefix becomes part of a cookie
 * name written straight into a `Set-Cookie` header, so a `;`, `=`, space or line
 * break in it would add attributes or headers of its own. An underscore is
 * refused so `<prefix>_session` and `<prefix>_login` cannot collide with another
 * prefix, and a leading `_` so no prefix can begin `__Host-` or `__Secure-`.
 */
const COOKIE_PREFIX = /^[a-z][a-z0-9-]{0,31}$/;

/** Throws unless `prefix` is a safe cookie-name prefix. The value is not echoed back. */
export function assertCookiePrefix(prefix: unknown): asserts prefix is string {
  if (typeof prefix !== 'string' || !COOKIE_PREFIX.test(prefix)) {
    throw new TypeError(
      'cookiePrefix must be 1 to 32 characters: a lowercase letter, then lowercase letters, digits or hyphens'
    );
  }
}

/** The cookie's name as sent: `__Host-` pins it to this host and path. */
export function cookieName(base: string, secure: boolean): string {
  return secure ? `__Host-${base}` : base;
}

export function setCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}
