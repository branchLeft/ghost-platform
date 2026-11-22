// Cookie tossing: a reader signed in to tenant A browses tenant B, whose owner
// is the attacker, and returns to A. Two measurements.
//
// The verdict is the real route: every vector the attacker has on B (the
// injected scripts, the uploaded script, the planted post) writes cookies for the
// shared parent domain, and the suite reads what A would now be sent.
//
// The residual assumes the control failed: a script is already running on B, run
// here through the browser's own debugging channel so no content policy can stop
// it, and the suite reads whether the browser accepts a write to the shared
// domain and who it would then reach. Only a Public Suffix List entry changes that.

import { jarFor, mergeMarks, signedInVictim, victimContext, visit } from '../browser.ts';
import type { CookieView, TossObservation, TossResidual } from '../observations.ts';
import { tossAssignments, tossNames } from '../payloads.ts';
import type { World } from '../world.ts';

export function sessionCookieOf(
  jar: readonly CookieView[],
  name: string,
  host: string
): string | null {
  const own = jar.find((c) => c.name === name && c.domain === host);
  return own === undefined ? null : own.value;
}

async function measureResidual(
  world: World,
  context: Awaited<ReturnType<typeof victimContext>>
): Promise<TossResidual> {
  const page = await context.newPage();
  await page.goto(`${world.b.origin}/`, { waitUntil: 'load', timeout: 30_000 });
  await page.evaluate((writes: string[]) => {
    for (const write of writes) document.cookie = write;
  }, tossAssignments(world.attacker));
  await page.close();
  const all = await context.cookies();
  const names = tossNames(world.attacker);
  const mine = all.filter((c) => names.includes(c.name) && c.value.includes(world.attacker.value));
  const forShared = mine.filter((c) => c.domain.replace(/^\./, '') === world.attacker.sharedDomain);
  const forA = await jarFor(context, `${world.a.origin}/ghost/`);
  const forPortal = await jarFor(context, `${world.portal.origin}/`);
  return {
    sharedDomainWriteAccepted: forShared.length > 0,
    seenByOtherTenant: forA.some(
      (c) => names.includes(c.name) && c.value.includes(world.attacker.value)
    ),
    seenByPortal: forPortal.some(
      (c) => names.includes(c.name) && c.value.includes(world.attacker.value)
    ),
  };
}

export async function attackCookieTossing(world: World): Promise<TossObservation> {
  const session = world.a.admin.session;
  const context = await signedInVictim(world.browser, world.a.host, session, world.a.secure);
  try {
    await visit(context, `${world.a.origin}/`);
    const sessionBefore = sessionCookieOf(
      await jarFor(context, `${world.a.origin}/ghost/`),
      session.name,
      world.a.host
    );
    if (sessionBefore === null)
      throw new Error("the victim's own session cookie was not in its browser before the attack");
    const marks: Record<string, boolean> = {};
    let pagesVisited = 0;
    const pages = [
      `${world.b.origin}/`,
      `${world.b.origin}${world.planted.inlinePostPath}`,
      ...(world.planted.uploadPostPath === null
        ? []
        : [`${world.b.origin}${world.planted.uploadPostPath}`]),
    ];
    for (const url of pages) {
      const result = await visit(context, url);
      mergeMarks(marks, result.marks);
      pagesVisited += 1;
    }
    await visit(context, `${world.a.origin}/`);

    const victimJar = await jarFor(context, `${world.a.origin}/ghost/`);
    const sessionAfter = sessionCookieOf(victimJar, session.name, world.a.host);
    const residual = await measureResidual(world, context);

    return {
      pagesVisited,
      scriptRan: marks['toss'] === true,
      victimJar,
      attackerNames: tossNames(world.attacker),
      attackerValue: world.attacker.value,
      sessionBefore,
      sessionAfter,
      residual,
      psl: world.psl,
    };
  } finally {
    await context.close();
  }
}
