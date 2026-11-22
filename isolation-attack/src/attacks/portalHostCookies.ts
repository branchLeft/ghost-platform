// Portal cookies: the portal sits under the registrable domain above the
// tenants' shared domain, so without a list entry a tenant's origin may write a
// cookie the portal is sent. The control tested here is the browser-enforced
// `__Host-` prefix on the portal's own cookies, so this case assumes the
// attacker's script is already running on a tenant (through the browser's
// debugging channel, past any content policy) and reads whether any of the
// attacker's writes can replace, duplicate or shadow a portal cookie.

import { victimContext } from '../browser.ts';
import type { PortalCookieObservation, PortalCookieProbe } from '../observations.ts';
import type { World } from '../world.ts';

const HOST_PREFIX = '__Host-';

interface Writes {
  readonly assignments: string[];
  readonly twins: string[];
}

function writesFor(
  name: string,
  attacker: string,
  rootDomain: string,
  paths: readonly string[],
  secure: boolean
): Writes {
  const flag = secure ? '; Secure' : '';
  const assignments: string[] = [];
  for (const path of paths) {
    // Wider: the registrable domain, on every path the portal answers (a longer path sorts first).
    assignments.push(`${name}=${attacker}; Domain=${rootDomain}; Path=${path}${flag}`);
  }
  // Narrower: host-only on the attacker's own tenant, which the portal is never sent.
  assignments.push(`${name}=${attacker}; Path=/${flag}`);
  const twins: string[] = [];
  if (name.startsWith(HOST_PREFIX)) {
    const twin = name.slice(HOST_PREFIX.length);
    twins.push(twin);
    for (const path of paths)
      assignments.push(`${twin}=${attacker}; Domain=${rootDomain}; Path=${path}`);
  }
  return { assignments, twins };
}

export async function attackPortalHostCookies(world: World): Promise<PortalCookieObservation> {
  const { portal, attacker } = world;
  const context = await victimContext(world.browser);
  try {
    const paths = [
      '/',
      portal.loginPath,
      ...(portal.whoamiPath === null ? [] : [portal.whoamiPath]),
    ];
    const urls = paths.map((p) => `${portal.origin}${p}`);

    const portalPage = await context.newPage();
    await portalPage.goto(`${portal.origin}${portal.loginPath}`, {
      waitUntil: 'load',
      timeout: 30_000,
    });
    if (portal.signedInPath !== null) {
      await portalPage.goto(`${portal.origin}${portal.signedInPath}`, {
        waitUntil: 'load',
        timeout: 30_000,
      });
    }
    const genuine = (await context.cookies(portal.origin)).map((c) => ({ ...c }));

    const twinsTried: string[] = [];
    const attackPage = await context.newPage();
    await attackPage.goto(`${world.b.origin}/`, { waitUntil: 'load', timeout: 30_000 });
    for (const cookie of genuine) {
      const writes = writesFor(
        cookie.name,
        attacker.value,
        attacker.rootDomain,
        paths,
        cookie.secure
      );
      twinsTried.push(...writes.twins);
      await attackPage.evaluate((list: string[]) => {
        for (const write of list) document.cookie = write;
      }, writes.assignments);
    }

    const probes: PortalCookieProbe[] = [];
    for (const cookie of genuine) {
      const values = new Set<string>();
      for (const url of urls) {
        for (const c of await context.cookies(url)) if (c.name === cookie.name) values.add(c.value);
      }
      probes.push({
        name: cookie.name,
        genuineValue: cookie.value,
        jarValues: [...values],
        secure: cookie.secure,
        path: cookie.path,
        hostOnly: !cookie.domain.startsWith('.'),
        attackerValueInJar: [...values].some((v) => v.includes(attacker.value)),
      });
    }

    const twinsAccepted: string[] = [];
    for (const url of urls) {
      for (const c of await context.cookies(url)) {
        if (
          twinsTried.includes(c.name) &&
          c.value.includes(attacker.value) &&
          !twinsAccepted.includes(c.name)
        ) {
          twinsAccepted.push(c.name);
        }
      }
    }

    let sessionRead: PortalCookieObservation['sessionRead'] = null;
    if (portal.whoamiPath !== null) {
      await portalPage.goto(`${portal.origin}${portal.whoamiPath}`, {
        waitUntil: 'load',
        timeout: 30_000,
      });
      const body = JSON.parse(await portalPage.evaluate(() => document.body.innerText)) as {
        session: string | null;
      };
      const session = genuine.find((c) => c.name.endsWith('_session'));
      sessionRead = { seen: body.session, genuine: session === undefined ? '' : session.value };
    }
    return { probes, sessionRead, twinsAccepted };
  } finally {
    await context.close();
  }
}
