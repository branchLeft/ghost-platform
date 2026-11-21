import { rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { raw } from '../support/mockHarness.js';
import {
  OWNER_CREDENTIAL,
  TENANT_A,
  TENANT_A_CREDENTIAL,
  TENANT_B,
  TENANT_B_CREDENTIAL,
  makeRig,
  type Rig,
  type RunningService,
} from '../support/serviceHarness.js';

/**
 * The credential rules of the real service, call by call. This is the file the
 * auth sabotage proof breaks: a service that let a tenant credential through
 * on an owner call, or one tenant's on another's path, fails here.
 */
let rig: Rig;
let running: RunningService;

const tenant = (credential: string | undefined): Record<string, string> =>
  credential === undefined ? {} : { 'x-tenant-credential': credential };
const owner = (credential: string | undefined): Record<string, string> =>
  credential === undefined ? {} : { 'x-owner-credential': credential };
const JSON_HEADER = { 'content-type': 'application/json' };
const ASK = JSON.stringify({ tier: 'essentials' });

beforeEach(async () => {
  rig = makeRig();
  running = await rig.start();
});
afterEach(async () => {
  await rig.cleanup();
});

/** Every operation, as one request each, for a caller to present headers on. */
function calls(requestId: string): {
  name: string;
  kind: 'tenant' | 'owner';
  method: string;
  path: string;
  body?: string;
}[] {
  return [
    { name: 'getDemo', kind: 'tenant', method: 'GET', path: `/tenants/${TENANT_A}/demo` },
    { name: 'getTenant', kind: 'tenant', method: 'GET', path: `/tenants/${TENANT_A}` },
    {
      name: 'createPromotionRequest',
      kind: 'tenant',
      method: 'POST',
      path: `/tenants/${TENANT_A}/promotion-requests`,
      body: ASK,
    },
    { name: 'listPromotionRequests', kind: 'owner', method: 'GET', path: '/promotion-requests' },
    {
      name: 'approvePromotionRequest',
      kind: 'owner',
      method: 'POST',
      path: `/promotion-requests/${requestId}/approve`,
    },
  ];
}

const REQUEST = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('the real service refuses what the contract says it refuses', () => {
  it('answers 401 to every operation with no credential', async () => {
    for (const call of calls(REQUEST)) {
      const answer = await raw(running.baseUrl, call.method, call.path, {
        headers: JSON_HEADER,
        ...(call.body === undefined ? {} : { body: call.body }),
      });
      expect([call.name, answer.status, answer.json]).toEqual([
        call.name,
        401,
        { code: 'unauthenticated' },
      ]);
    }
  });

  it('answers 401 to a credential nobody issued, in either header', async () => {
    for (const call of calls(REQUEST)) {
      for (const headers of [
        tenant('NOT-ISSUED-TO-ANYONE-12345'),
        owner('NOT-ISSUED-TO-ANYONE-12345'),
      ]) {
        const answer = await raw(running.baseUrl, call.method, call.path, {
          headers: { ...JSON_HEADER, ...headers },
          ...(call.body === undefined ? {} : { body: call.body }),
        });
        expect([call.name, answer.status]).toEqual([call.name, 401]);
      }
    }
  });

  it('refuses a tenant credential on both owner operations (403)', async () => {
    for (const call of calls(REQUEST).filter((c) => c.kind === 'owner')) {
      for (const headers of [tenant(TENANT_A_CREDENTIAL), owner(TENANT_A_CREDENTIAL)]) {
        const answer = await raw(running.baseUrl, call.method, call.path, { headers });
        expect([call.name, answer.status, answer.json]).toEqual([
          call.name,
          403,
          { code: 'forbidden' },
        ]);
      }
    }
  });

  it('refuses the owner credential on all three tenant operations (403)', async () => {
    for (const call of calls(REQUEST).filter((c) => c.kind === 'tenant')) {
      for (const headers of [owner(OWNER_CREDENTIAL), tenant(OWNER_CREDENTIAL)]) {
        const answer = await raw(running.baseUrl, call.method, call.path, {
          headers: { ...JSON_HEADER, ...headers },
          ...(call.body === undefined ? {} : { body: call.body }),
        });
        expect([call.name, answer.status, answer.json]).toEqual([
          call.name,
          403,
          { code: 'forbidden' },
        ]);
      }
    }
  });

  it("refuses one tenant's credential on another tenant's paths (403)", async () => {
    for (const path of [`/tenants/${TENANT_B}/demo`, `/tenants/${TENANT_B}`]) {
      const answer = await raw(running.baseUrl, 'GET', path, {
        headers: tenant(TENANT_A_CREDENTIAL),
      });
      expect([path, answer.status]).toEqual([path, 403]);
    }
    const ask = await raw(running.baseUrl, 'POST', `/tenants/${TENANT_B}/promotion-requests`, {
      headers: { ...JSON_HEADER, ...tenant(TENANT_A_CREDENTIAL) },
      body: ASK,
    });
    expect(ask.status).toBe(403);
    const listed = await raw(running.baseUrl, 'GET', '/promotion-requests', {
      headers: owner(OWNER_CREDENTIAL),
    });
    expect(listed.json).toEqual({ items: [] });
  });

  it("accepts each tenant's own credential and the owner's on the owner calls", async () => {
    expect(
      (
        await raw(running.baseUrl, 'GET', `/tenants/${TENANT_A}/demo`, {
          headers: tenant(TENANT_A_CREDENTIAL),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await raw(running.baseUrl, 'GET', `/tenants/${TENANT_B}/demo`, {
          headers: tenant(TENANT_B_CREDENTIAL),
        })
      ).status
    ).toBe(200);
    expect(
      (
        await raw(running.baseUrl, 'GET', '/promotion-requests', {
          headers: owner(OWNER_CREDENTIAL),
        })
      ).status
    ).toBe(200);
  });

  it('answers /healthz with no credential and nothing else does', async () => {
    expect((await raw(running.baseUrl, 'GET', '/healthz')).status).toBe(200);
    expect((await raw(running.baseUrl, 'GET', '/healthz/extra')).status).not.toBe(200);
  });
});

describe('credentials are files, read on every call', () => {
  it('a credential placed or changed takes effect with no restart', async () => {
    writeFileSync(rig.files.owner, 'A-NEW-OWNER-CREDENTIAL-0123456\n');
    const old = await raw(running.baseUrl, 'GET', '/promotion-requests', {
      headers: owner(OWNER_CREDENTIAL),
    });
    const now = await raw(running.baseUrl, 'GET', '/promotion-requests', {
      headers: owner('A-NEW-OWNER-CREDENTIAL-0123456'),
    });
    expect([old.status, now.status]).toEqual([401, 200]);
  });

  it.each([
    [
      'an empty owner file',
      (r: Rig) => writeFileSync(r.files.owner, ''),
      'owner-credential-too-short',
    ],
    [
      'an owner credential under 16 characters',
      (r: Rig) => writeFileSync(r.files.owner, 'short\n'),
      'owner-credential-too-short',
    ],
    [
      'a tenant file with no line',
      (r: Rig) => writeFileSync(r.files.tenants, '\n'),
      'tenant-credentials-empty',
    ],
    [
      'a tenant line that is not tenant=credential',
      (r: Rig) => writeFileSync(r.files.tenants, 'oops\n'),
      'tenant-credentials-malformed',
    ],
    [
      'a tenant credential under 16 characters',
      (r: Rig) => writeFileSync(r.files.tenants, `${TENANT_A}=short\n`),
      'tenant-credentials-malformed',
    ],
    [
      'a credential given to two tenants',
      (r: Rig) =>
        writeFileSync(
          r.files.tenants,
          `${TENANT_A}=${TENANT_A_CREDENTIAL}\n${TENANT_B}=${TENANT_A_CREDENTIAL}\n`
        ),
      'credentials-not-distinct',
    ],
    [
      'a tenant credential equal to the owner credential',
      (r: Rig) => writeFileSync(r.files.tenants, `${TENANT_A}=${OWNER_CREDENTIAL}\n`),
      'credentials-not-distinct',
    ],
  ])('%s leaves nobody able to call anything', async (_name, damage, code) => {
    damage(rig);
    for (const call of calls(REQUEST)) {
      for (const headers of [
        owner(OWNER_CREDENTIAL),
        tenant(TENANT_A_CREDENTIAL),
        tenant(TENANT_B_CREDENTIAL),
      ]) {
        const answer = await raw(running.baseUrl, call.method, call.path, {
          headers: { ...JSON_HEADER, ...headers },
          ...(call.body === undefined ? {} : { body: call.body }),
        });
        expect([call.name, answer.status]).toEqual([call.name, 401]);
      }
    }
    expect(rig.problems).toContain(code);
    expect(rig.problems.join(' ')).not.toContain(OWNER_CREDENTIAL);
    expect(rig.problems.join(' ')).not.toContain(TENANT_A_CREDENTIAL);
  });

  it('a missing file refuses everything and names the problem by code', async () => {
    rmSync(rig.files.tenants);
    const answer = await raw(running.baseUrl, 'GET', `/tenants/${TENANT_A}/demo`, {
      headers: tenant(TENANT_A_CREDENTIAL),
    });
    expect(answer.status).toBe(401);
    expect(rig.problems).toContain('tenant-credentials-unreadable');
    rmSync(rig.files.owner);
    const listed = await raw(running.baseUrl, 'GET', '/promotion-requests', {
      headers: owner(OWNER_CREDENTIAL),
    });
    expect(listed.status).toBe(401);
    expect(rig.problems).toContain('owner-credential-unreadable');
  });
});
