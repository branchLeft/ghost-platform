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
