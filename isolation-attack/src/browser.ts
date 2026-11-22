// Shared browser plumbing: a victim's browser context that records content
// policy violations from the first byte of every page, and readers for the
// marks the attacker's scripts leave behind.

import type { Browser, BrowserContext, Cookie, Page } from 'playwright';
import { MARK_PREFIX } from './payloads.ts';
import type { CookieView, Violation } from './observations.ts';

declare global {
  interface Window {
    __violations?: { directive: string; blockedURI: string }[];
  }
}

export async function victimContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Installed before any navigation, so violations fired during the first load
  // are not missed by a listener added afterwards.
  await context.addInitScript(() => {
    window.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__violations?.push({ directive: e.violatedDirective, blockedURI: e.blockedURI });
    });
  });
  return context;
}

export interface Visit {
  readonly status: number | null;
  readonly marks: Record<string, boolean>;
  readonly violations: Violation[];
}

/** Opens a URL in a fresh page of the context and reads what the page did. */
export async function visit(context: BrowserContext, url: string, settleMs = 1000): Promise<Visit> {
  const page = await context.newPage();
  try {
    const response = await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => null);
    await page.waitForTimeout(settleMs);
    return { status: response === null ? null : response.status(), ...(await readPage(page)) };
  } finally {
    await page.close().catch(() => undefined);
  }
}

export async function readPage(
  page: Page
): Promise<{ marks: Record<string, boolean>; violations: Violation[] }> {
  return page
    .evaluate((prefix: string) => {
      const marks: Record<string, boolean> = {};
      const w = window as unknown as Record<string, unknown>;
      for (const key of Object.keys(w)) {
        if (key.startsWith(prefix) && w[key] === true) marks[key.slice(prefix.length)] = true;
      }
      return { marks, violations: window.__violations ?? [] };
    }, MARK_PREFIX)
    .catch(() => ({ marks: {}, violations: [] }));
}

export function mergeMarks(into: Record<string, boolean>, from: Record<string, boolean>): void {
  for (const [key, value] of Object.entries(from)) if (value) into[key] = true;
}

export function viewOf(cookie: Cookie): CookieView {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
}

/** The cookies the browser would send with a request to this URL. */
export async function jarFor(context: BrowserContext, url: string): Promise<CookieView[]> {
  return (await context.cookies(url)).map(viewOf);
}

/** Total bytes of name=value across the cookies. */
export function cookieBytes(cookies: readonly CookieView[]): number {
  return cookies.reduce((sum, c) => sum + c.name.length + c.value.length + 1, 0);
}

/** Signs the victim in to its tenant by giving the browser the session cookie Ghost issued. */
export async function signedInVictim(
  browser: Browser,
  host: string,
  session: { name: string; value: string },
  secure: boolean
): Promise<BrowserContext> {
  const context = await victimContext(browser);
  await context.addCookies([
    {
      name: session.name,
      value: session.value,
      domain: host,
      path: '/ghost',
      httpOnly: true,
      secure,
      sameSite: 'Lax',
    },
  ]);
  return context;
}
