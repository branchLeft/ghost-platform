import { describe, expect, it } from 'vitest';
import { validateConfig } from 'ghost-platform-identity/dist/config.js';
import { desiredState } from 'ghost-platform-identity/dist/desired.js';
import type { OwnerDb } from 'ghost-platform-portal-data/owner';
import type { TenantDb } from 'ghost-platform-portal-data/tenant';
import { createOwnerConsole } from '../src/console/app.js';
import { createTenantPortal } from '../src/tenant/app.js';
import { Browser, serve } from './browser.js';
import { CLIENT_CONSOLE, CLIENT_PORTAL, ISSUER, PROJECT_ID } from './idp.js';

/**
 * What the reconciler registers with the sign-in service is the only return
 * address it will accept, so it must equal, character for character, what each
 * application sends. The reconciler's state is built from a real hostname list,
 * and each application is run on the origin the reconciler's URI names.
 */
const registered = desiredState(
  validateConfig({
    hostnames: {
      console: 'console.example.test',
      portal: 'portal.example.test',
      identity: 'id.example.test',
    },
    tenants: [{ slug: 'alpha', displayName: 'ALPHA' }],
  })
);

const originOf = (uri: string): string => new URL(uri).origin;

async function sentRedirect(path: string, handlerFor: (origin: string) => never): Promise<string> {
  const running = await serve(handlerFor);
  try {
    const reply = await new Browser(running.origin).request(path);
    return new URL(reply.location ?? '').searchParams.get('redirect_uri') ?? '';
  } finally {
    await running.close();
  }
}

describe('the registered return address and the one each application sends', () => {
  it('is identical for the tenant portal', async () => {
    const app = registered.applications.find((a) => a.key === 'portal')!;
    const sent = await sentRedirect('/login', ((origin: string) =>
      createTenantPortal({
        issuer: ISSUER,
        clientId: CLIENT_PORTAL,
        projectId: PROJECT_ID,
        publicOrigin: origin,
        allowedOrgIds: new Set(['org-x']),
        db: {} as TenantDb,
        secureCookies: false,
      })) as never);
    expect(new URL(sent).pathname).toBe(new URL(app.redirectUris[0]!).pathname);
    expect(originOf(app.redirectUris[0]!)).toBe('https://portal.example.test');
  });

  it('is identical for the owner console', async () => {
    const app = registered.applications.find((a) => a.key === 'console')!;
    const sent = await sentRedirect('/login', ((origin: string) =>
      createOwnerConsole({
        issuer: ISSUER,
        clientId: CLIENT_CONSOLE,
        projectId: PROJECT_ID,
        publicOrigin: origin,
        ownerOrgId: 'org-owner',
        db: {} as OwnerDb,
        secureCookies: false,
      })) as never);
    expect(new URL(sent).pathname).toBe(new URL(app.redirectUris[0]!).pathname);
    expect(originOf(app.redirectUris[0]!)).toBe('https://console.example.test');
  });

  it('is served at that address, and at no other callback address', async () => {
    const running = await serve(((origin: string) =>
      createTenantPortal({
        issuer: ISSUER,
        clientId: CLIENT_PORTAL,
        projectId: PROJECT_ID,
        publicOrigin: origin,
        allowedOrgIds: new Set(['org-x']),
        db: {} as TenantDb,
        secureCookies: false,
      })) as never);
    try {
      const path = new URL(registered.applications[1]!.redirectUris[0]!).pathname;
      expect((await new Browser(running.origin).request(`${path}?state=x`)).status).toBe(400);
      expect((await new Browser(running.origin).request('/callback?state=x')).status).toBe(404);
    } finally {
      await running.close();
    }
  });
});
