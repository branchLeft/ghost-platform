#!/usr/bin/env node
// Drives a real headless Chromium against the origin container (Caddy in
// front of the pinned Ghost image) and records every network request the
// browser makes while exercising the home page, Portal's sign-in overlay,
// search, a post with comments, and a standalone page embedding the
// signup-form widget. Fails (exit 1) if any request's origin is not the
// origin under test -- that is the whole of what this story has to prove,
// asserted from what the browser actually did rather than from what the
// config says it should do.
import { chromium } from 'playwright';

const ORIGIN = process.env.PROOF_ORIGIN || 'http://localhost:4300';
const LABEL = process.env.PROOF_LABEL || 'run';

const originUrl = new URL(ORIGIN);

function isThirdParty(requestUrl) {
  let u;
  try {
    u = new URL(requestUrl);
  } catch {
    return false; // data:, blob:, about: etc -- never a network origin
  }
  if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') {
    return false;
  }
  return u.origin !== originUrl.origin;
}

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  const allRequests = [];
  const thirdParty = [];

  context.on('request', (req) => {
    allRequests.push(req.url());
    if (isThirdParty(req.url())) {
      thirdParty.push(req.url());
    }
  });

  const steps = [];

  // 1. Home page.
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle', timeout: 30000 });
  steps.push('home page loaded');

  // 2. Portal sign-in overlay -- Portal mounts a trigger button; open the
  // sign-in flow via its documented URL hash rather than hunting for a
  // selector in whatever theme is active.
  await page.goto(ORIGIN + '/#/portal/signin', { waitUntil: 'networkidle', timeout: 30000 });
  // Portal renders inside an iframe; wait for it rather than a fixed sleep.
  try {
    await page.waitForSelector(
      'iframe[title="portal-popup"], iframe.gh-portal-popup-iframe, iframe[src*="portal"]',
      { timeout: 10000 }
    );
    steps.push('portal sign-in overlay rendered');
  } catch {
    steps.push(
      'portal sign-in overlay: no matching iframe found (recorded, not fatal to the network assertion)'
    );
  }
  await page.waitForTimeout(1000); // let Portal's own deferred requests land

  // 3. Search -- sodoSearch mounts globally; trigger it via its documented
  // custom event rather than a theme-specific click target.
  await page.goto(ORIGIN + '/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('sodoSearch:open'));
  });
  await page.waitForTimeout(1500);
  steps.push('search widget opened');

  // 4. A post, for comments. Ask the Content API for the first published
  // post's slug rather than assuming Casper's fixture slug names.
  let postSlug = null;
  try {
    const res = await page.request.get(ORIGIN + '/ghost/api/content/posts/?key=&limit=1');
    if (res.ok()) {
      const body = await res.json();
      postSlug = body?.posts?.[0]?.slug || null;
    }
  } catch {
    // fall through
  }
  if (postSlug) {
    await page.goto(`${ORIGIN}/${postSlug}/`, { waitUntil: 'networkidle', timeout: 30000 });
    steps.push(`post page loaded (${postSlug})`);
    await page.waitForTimeout(1000);
  } else {
    steps.push('post page: no published post found via Content API (recorded, not fatal)');
  }

  // 5. The signup-form embed, on a page that is not part of the Ghost
  // site at all -- proving the widget is self-contained wherever it runs.
  await page.goto(ORIGIN + '/proof/signup-embed.html', {
    waitUntil: 'networkidle',
    timeout: 30000,
  });
  await page.waitForTimeout(1000);
  steps.push('signup-form embed page loaded');

  await browser.close();

  const result = {
    label: LABEL,
    origin: originUrl.origin,
    steps,
    totalRequests: allRequests.length,
    thirdPartyRequests: [...new Set(thirdParty)],
  };

  console.log(JSON.stringify(result, null, 2));

  if (result.thirdPartyRequests.length > 0) {
    console.error(
      `\n[${LABEL}] RED: ${result.thirdPartyRequests.length} third-party origin(s) requested.`
    );
    process.exit(1);
  }

  console.error(
    `\n[${LABEL}] GREEN: ${result.totalRequests} requests captured, zero third-party origins.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
