#!/usr/bin/env node
// The live proof LLD-5's own "Done means" asks for: a real Ghost at the
// pinned version with the default theme, a real Caddy in front, a real
// headless Chromium driven through Portal's sign-in flow, with
// `codeinjection_head` carrying the exact attack the spike ran
// (05-gate-and-edge.html §04): <script>document.title="PWNED";
// window.__injectedRan=true;</script>. run-proof.sh calls this once per
// row of the test matrix, with the origin's own CSP header already set (or
// not) by that pass -- this script only observes and reports, it never
// sets the policy itself.
import { chromium } from 'playwright';

const ORIGIN = process.env.PROOF_ORIGIN || 'http://localhost:4310';
const LABEL = process.env.PROOF_LABEL || 'run';

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();

  // Installed before any navigation, so it is present for every page this
  // run visits -- a listener added after the fact would miss violations
  // fired during the initial load.
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspViolations.push({
        directive: e.violatedDirective,
        blockedURI: e.blockedURI,
      });
    });
  });

  // The single page LLD-5's own spike tested against (05-gate-and-edge.html
  // §04): the home page, with Portal's sign-in overlay opened via its
  // documented URL hash. codeinjection_head (site-wide) and the theme's own
  // inline helper/JSON-LD blocks both render here, on one page load, so
  // this run's `securitypolicyviolation` listener (installed above, before
  // any navigation) sees every violation this pass produces.
  await page.goto(`${ORIGIN}/#/portal/signin`, { waitUntil: 'networkidle', timeout: 30000 });
  let portalSignInForm = 'not rendered';
  let emailFields = 0;
  const iframeSelector =
    'iframe[title="portal-popup"], iframe.gh-portal-popup-iframe, iframe[src*="portal"]';
  try {
    await page.waitForSelector(iframeSelector, { timeout: 10000 });
    const frame = page.frameLocator(iframeSelector);
    await frame.locator('input[type="email"]').first().waitFor({ timeout: 10000 });
    emailFields = await frame.locator('input[type="email"]').count();
    portalSignInForm = 'rendered';
  } catch {
    // Recorded below, not fatal -- a blocked policy is expected to break
    // this on the rows this proof means to fail.
  }
  await page.waitForTimeout(1000); // let any deferred CSP reports land

  const title = await page.title();
  const injectedScriptRan = await page.evaluate(() => Boolean(window.__injectedRan));
  const cspViolations = await page.evaluate(() => window.__cspViolations ?? []);

  await browser.close();

  const result = {
    label: LABEL,
    title,
    injectedScriptRan,
    portalSignInForm,
    emailFields,
    cspViolations,
  };
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
