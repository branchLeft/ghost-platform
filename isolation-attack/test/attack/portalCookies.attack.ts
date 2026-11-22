import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { attackPortalHostCookies } from '../../src/attacks/portalHostCookies.ts';
import { ROOT_DOMAIN, SHARED_DOMAIN } from '../../src/rig/localRig.ts';
import {
  PORTAL_LOGIN_PATH,
  PORTAL_SIGNED_IN_PATH,
  PORTAL_WHOAMI_PATH,
  startEvilServer,
  startPortalStub,
  type EvilServer,
  type PortalStub,
} from '../../src/rig/servers.ts';
import { judgePortalHostCookies } from '../../src/verdicts.ts';
import type { World } from '../../src/world.ts';

// The portal case needs a browser and the portal stand-in and nothing else, so
// it runs here without Docker. It is also the case's own sabotage proof: the
// production wiring (every cookie __Host- prefixed) must hold, and the same
// stand-in with the prefix removed must be breached.

let browser: Browser;
let stub: PortalStub;
let tenant: EvilServer;

beforeAll(async () => {
  browser = await chromium.launch();
  stub = await startPortalStub({ hostPrefixed: true });
  // Any page on a tenant host will do: the attack only needs a document to run in.
  tenant = await startEvilServer();
});

afterAll(async () => {
  await browser.close();
  await stub.close();
  await tenant.close();
});

function worldFor(): World {
  return {
    browser,
    b: {
      host: `b.${SHARED_DOMAIN}`,
      origin: `http://b.${SHARED_DOMAIN}:${tenant.port}`,
      secure: false,
    },
    portal: {
      host: `portal.${ROOT_DOMAIN}`,
      origin: `http://portal.${ROOT_DOMAIN}:${stub.port}`,
      loginPath: PORTAL_LOGIN_PATH,
      signedInPath: PORTAL_SIGNED_IN_PATH,
      whoamiPath: PORTAL_WHOAMI_PATH,
    },
    attacker: {
      value: 'attacker-test',
      sharedDomain: SHARED_DOMAIN,
      rootDomain: ROOT_DOMAIN,
      sessionName: 'ghost-admin-api-session',
    },
  } as unknown as World;
}

describe('portal cookies against the portal stand-in', () => {
  it('hold with the __Host- prefix the portal ships', async () => {
    stub.setHostPrefixed(true);
    const observed = await attackPortalHostCookies(worldFor());
    expect(observed.probes.map((p) => p.name).sort()).toEqual([
      '__Host-portal_login',
      '__Host-portal_session',
    ]);
    const judged = judgePortalHostCookies(observed);
    expect(judged.verdict, JSON.stringify(judged.vectors)).toBe('held');
    expect(observed.twinsAccepted.length).toBeGreaterThan(0);
  });

  it('are breached when the prefix is removed', async () => {
    stub.setHostPrefixed(false);
    const judged = judgePortalHostCookies(await attackPortalHostCookies(worldFor()));
    expect(judged.verdict, JSON.stringify(judged.vectors)).toBe('breached');
  });
});
