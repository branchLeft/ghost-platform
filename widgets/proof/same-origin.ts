// Loads a site's public pages in a real headless Chromium and fails if any
// request leaves the site's own origin, or if a widget file the site should
// be serving itself is not served. Read-only: it signs in to nothing, posts
// nothing and needs no setup, so it can be pointed at a live tenant.
// See ../README.md#same-origin-proof.
//
// Run: PROOF_ORIGIN=https://example.test node widgets/proof/same-origin.ts
//   PROOF_PATHS          comma-separated paths to load (default "/")
//   PROOF_ALLOW_ORIGINS  comma-separated origins a page may also call, each
//                        a deliberate and named exception (default none)
//   PROOF_EXPECT_ASSETS  comma-separated /bl-assets/ files that must be
//                        requested and answered 200 (default portal and search)
// Exit 0 proven, 1 a foreign request or a missing widget, 2 bad usage.
import { chromium } from 'playwright';

const ASSET_PREFIX = '/bl-assets/';
const DEFAULT_EXPECTED = 'portal.min.js,sodo-search.min.js';

interface Seen {
  readonly url: string;
  readonly type: string;
  readonly page: string;
}

function list(value: string | undefined, fallback: string): string[] {
  return (value ?? fallback)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** The origin of a network request, or undefined for data:, blob: and about:,
 * which never leave the browser. */
export function networkOrigin(requestUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol === 'data:' || parsed.protocol === 'blob:' || parsed.protocol === 'about:') {
    return undefined;
  }
  return parsed.origin;
}

export function foreignRequests(
  seen: readonly Seen[],
  origin: string,
  allowed: ReadonlySet<string>
): Seen[] {
  return seen.filter((request) => {
    const requestOrigin = networkOrigin(request.url);
    return requestOrigin !== undefined && requestOrigin !== origin && !allowed.has(requestOrigin);
  });
}

async function main(): Promise<number> {
  const rawOrigin = process.env.PROOF_ORIGIN;
  if (rawOrigin === undefined || rawOrigin === '') {
    console.error('usage: PROOF_ORIGIN=https://site.example node widgets/proof/same-origin.ts');
    return 2;
  }
  const origin = new URL(rawOrigin).origin;
  const paths = list(process.env.PROOF_PATHS, '/');
  const allowed = new Set(list(process.env.PROOF_ALLOW_ORIGINS, ''));
  const expected = list(process.env.PROOF_EXPECT_ASSETS, DEFAULT_EXPECTED);

  const seen: Seen[] = [];
  const assetStatus = new Map<string, number>();

  const browser = await chromium.launch();
  try {
    for (const path of paths) {
      const page = await browser.newPage();
      page.on('request', (request) => {
        seen.push({ url: request.url(), type: request.resourceType(), page: path });
      });
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.origin === origin && url.pathname.startsWith(ASSET_PREFIX)) {
          assetStatus.set(url.pathname.slice(ASSET_PREFIX.length), response.status());
        }
      });
      await page.goto(new URL(path, origin).toString(), { waitUntil: 'networkidle' });
      await page.close();
    }
  } finally {
    await browser.close();
  }

  const foreign = foreignRequests(seen, origin, allowed);
  const missing = expected.filter((file) => assetStatus.get(file) !== 200);

  console.log(
    JSON.stringify(
      {
        origin,
        paths,
        requests: seen.length,
        widgetFiles: Object.fromEntries(assetStatus),
        foreignRequests: foreign,
        missingWidgetFiles: missing,
      },
      null,
      2
    )
  );

  if (foreign.length > 0) {
    console.error(`FAILED: ${foreign.length} request(s) left ${origin}`);
  }
  if (missing.length > 0) {
    console.error(`FAILED: not served 200 from ${origin}${ASSET_PREFIX}: ${missing.join(', ')}`);
  }
  if (foreign.length === 0 && missing.length === 0) {
    console.log(`OK: every request on ${paths.length} page(s) stayed on ${origin}`);
    return 0;
  }
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main();
}
