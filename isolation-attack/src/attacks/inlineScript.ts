// Inline script: the attacker injects script into tenant B's own pages the three
// ways Ghost allows (the site-wide head and foot injection, and an HTML card
// in a post), plus an event-handler attribute. The content policy must refuse
// all of them while the page's own sign-in keeps working.

import { mergeMarks, victimContext, visit } from '../browser.ts';
import type { InlineScriptObservation, Violation } from '../observations.ts';
import type { World } from '../world.ts';

const PORTAL_FRAME =
  'iframe[title="portal-popup"], iframe.gh-portal-popup-iframe, iframe[src*="portal"]';

export async function attackInlineScript(world: World): Promise<InlineScriptObservation> {
  const context = await victimContext(world.browser);
  try {
    const marks: Record<string, boolean> = {};
    const violations: Violation[] = [];
    let pagesVisited = 0;

    // The home page, with Portal's sign-in opened, carries the head and foot injection.
    const home = await context.newPage();
    await home.goto(`${world.b.origin}/#/portal/signin`, { waitUntil: 'load', timeout: 30_000 });
    let rendered = false;
    let emailFields = 0;
    try {
      await home.waitForSelector(PORTAL_FRAME, { timeout: 10_000 });
      const frame = home.frameLocator(PORTAL_FRAME);
      await frame.locator('input[type="email"]').first().waitFor({ timeout: 10_000 });
      emailFields = await frame.locator('input[type="email"]').count();
      rendered = true;
    } catch {
      // Recorded below: a policy that breaks the sign-in is itself a failure.
    }
    await home.waitForTimeout(1000);
    const read = await home.evaluate((prefix: string) => {
      const found: Record<string, boolean> = {};
      const w = window as unknown as Record<string, unknown>;
      for (const key of Object.keys(w))
        if (key.startsWith(prefix) && w[key] === true) found[key.slice(prefix.length)] = true;
      return { found, violations: window.__violations ?? [] };
    }, '__ran_');
    mergeMarks(marks, read.found);
    violations.push(...read.violations);
    pagesVisited += 1;
    await home.close();

    const post = await visit(context, `${world.b.origin}${world.planted.inlinePostPath}`);
    mergeMarks(marks, post.marks);
    violations.push(...post.violations);
    pagesVisited += 1;

    return { marks, violations, portalSignIn: { rendered, emailFields }, pagesVisited };
  } finally {
    await context.close();
  }
}
