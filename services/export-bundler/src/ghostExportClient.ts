import type { BreakGlassMinter } from './breakGlassToken.js';

export interface ExportFile {
  readonly filename: string;
  readonly contentType: string;
  readonly body: Buffer;
}

/**
 * LLD-8 §08b: "the portal does not build an exporter, it builds a
 * bundler. It calls Ghost's two existing exports as the administrator."
 * The two routes are Ghost's own, verified in the fork rather than
 * assumed: `GET /ghost/api/admin/db/` (`db.exportContent`, content &
 * settings JSON) and `GET /ghost/api/admin/posts/export/`
 * (`posts.exportCSV`, filed under the "Post analytics" CSV name --
 * core/core/server/api/endpoints/posts.js calls
 * `getCSVExportFileName('analytics')`).
 */
export interface GhostExportClient {
  fetchContentAndSettings(baseUrl: string): Promise<ExportFile>;
  fetchPostAnalytics(baseUrl: string): Promise<ExportFile>;
}

export class GhostExportError extends Error {
  constructor(
    readonly route: string,
    readonly status: number,
    body: string
  ) {
    super(`Ghost admin export ${route} answered ${status}: ${body.slice(0, 500)}`);
    this.name = 'GhostExportError';
  }
}

export class BreakGlassSessionError extends Error {
  constructor(status: number, body: string) {
    super(`break-glass session request answered ${status}: ${body.slice(0, 500)}`);
    this.name = 'BreakGlassSessionError';
  }
}

function filenameFromDisposition(header: string | null, fallback: string): string {
  const match = header?.match(/filename="([^"]+)"/i);
  return match?.[1] ?? fallback;
}

// This colour is never routed (drainGate.ts's whole point), so it is only
// ever reached over plain loopback HTTP -- but the tenant's own `url`
// config is https (real tenants always are), and Ghost redirects (301,
// or refuses a Secure-flagged cookie) any request it considers insecure.
// Carrying the same header the real edge sets on every request it
// forwards is what makes Ghost treat this request as the secure one it
// actually is, on a real path production traffic also takes. Mirrors
// ghostProbe.ts's identical reasoning for the health check.
const FORWARDED_PROTO_HEADERS = { 'X-Forwarded-Proto': 'https' };

/**
 * Ghost's own permission model refuses both export routes to a custom
 * integration's Admin API key (verified against a real container: both
 * answer 403 `NoPermissionError`, because "Export database" is not among
 * the "Admin Integration" role's permissions -- only Administrator/Owner
 * carries it). So this authenticates the way `adapters/sso/README.md`'s
 * break-glass adapter does: mint a token, spend it on `/ghost/` to open
 * an Administrator session, then carry that session's cookie on both
 * export requests. See breakGlassToken.ts's own comment for why this is
 * the platform's existing mechanism rather than a new one.
 */
async function openBreakGlassSession(
  baseUrl: string,
  minter: BreakGlassMinter,
  timeoutMs: number
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = new URL('/ghost/', baseUrl);
    url.searchParams.set('bl_break_glass', minter.mint());
    const response = await fetch(url, {
      signal: controller.signal,
      headers: FORWARDED_PROTO_HEADERS,
      redirect: 'manual',
    });
    const setCookie = response.headers.get('set-cookie');
    // A 2xx/3xx with no session cookie is not a session -- the adapter
    // fails closed to the login page on every refusal, which still
    // answers successfully as far as HTTP is concerned.
    if (!setCookie) {
      const body = await response.text();
      throw new BreakGlassSessionError(
        response.status,
        body || '(no Set-Cookie header; token likely refused)'
      );
    }
    response.body?.cancel().catch(() => undefined);
    // Only the name=value pair travels on to the next request -- the
    // attributes (Path, Secure, SameSite, Expires) are for a browser's
    // cookie jar, not for the manual Cookie header this client sends.
    return setCookie.split(';', 1)[0]!;
  } finally {
    clearTimeout(timer);
  }
}

async function get(
  baseUrl: string,
  path: string,
  cookie: string,
  fallbackFilename: string,
  timeoutMs: number
): Promise<ExportFile> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, baseUrl), {
      headers: { Cookie: cookie, ...FORWARDED_PROTO_HEADERS },
      signal: controller.signal,
      redirect: 'manual',
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (response.status !== 200) {
      throw new GhostExportError(path, response.status, body.toString('utf8'));
    }
    return {
      filename: filenameFromDisposition(
        response.headers.get('content-disposition'),
        fallbackFilename
      ),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      body,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One export, one administrator session: the cookie is opened at most
 * once per client and reused for both routes, the same way a person
 * signed in to Ghost's admin would call both without logging in twice --
 * not two independent break-glass spends for what LLD-8 §08b treats as
 * one audited action.
 */
export function createHttpGhostExportClient(
  minter: BreakGlassMinter,
  timeoutMs: number
): GhostExportClient {
  let sessionPromise: Promise<string> | undefined;
  function session(baseUrl: string): Promise<string> {
    sessionPromise ??= openBreakGlassSession(baseUrl, minter, timeoutMs);
    return sessionPromise;
  }

  return {
    fetchContentAndSettings: async (baseUrl) =>
      get(baseUrl, '/ghost/api/admin/db/', await session(baseUrl), 'ghost.json', timeoutMs),
    fetchPostAnalytics: async (baseUrl) =>
      get(
        baseUrl,
        '/ghost/api/admin/posts/export/',
        await session(baseUrl),
        'ghost.analytics.csv',
        timeoutMs
      ),
  };
}
