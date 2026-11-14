import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CustomDomainNotAllowedError,
  CustomDomainNotRequestedError,
  CustomDomainOwnedError,
  CustomDomainTakenError,
  DomainProofInvalidError,
  InvalidCustomDomainError,
  TenantDb,
  bindTenant,
  checkCustomDomain,
  verificationRecordName,
  verificationRecordValue,
  type DnsResolver,
  type DomainProof,
  type EdgeTarget,
} from '../src/tenant/index.js';
import { DomainProof as ProofClass } from '../src/domainCheck.js';
import { assertTenantTablesIsolated } from '../src/isolation.js';
import * as schema from '../src/schema.js';
import {
  TENANT_A,
  TENANT_B,
  createFixture,
  rejection,
  rootMessage,
  type Fixture,
} from './helpers.js';

// A second real tenant; TENANT_A is real and TENANT_B is a demo slot.
const TENANT_C = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-11-10T12:00:00Z');
const OWNED = ['platform.example'];
const EDGE: EdgeTarget = { addresses: ['192.0.2.10'], cname: null };
const DOMAIN = 'blog.example.com';

let fixture: Fixture;
let tenant: TenantDb;
const scopeA = bindTenant(TENANT_A);
const scopeB = bindTenant(TENANT_B);
const scopeC = bindTenant(TENANT_C);

beforeAll(async () => {
  fixture = await createFixture();
  await fixture.adminDb
    .insert(schema.tenantRegister)
    .values({ tenantId: TENANT_C, zitadelOrgId: 'org-c', kind: 'REAL' });
  tenant = new TenantDb(fixture.tenant);
});

afterAll(async () => {
  await fixture.close();
});

const connectedRows = async (): Promise<number> =>
  (await fixture.adminDb.select().from(schema.connectedDomain)).length;
const requestRows = async (): Promise<number> =>
  (await fixture.adminDb.select().from(schema.customDomainRequest)).length;

/** A resolver that answers as `fqdn` would once the tenant has set both records. */
function configured(fqdn: string, token: string, a = EDGE.addresses[0]): DnsResolver {
  const missing = Object.assign(new Error('none'), { code: 'ENODATA' });
  return {
    resolve4: () => Promise.resolve([a ?? '192.0.2.10']),
    resolve6: () => Promise.reject(missing),
    resolveCname: () => Promise.reject(missing),
    resolveTxt: (name) =>
      name === verificationRecordName(fqdn)
        ? Promise.resolve([[verificationRecordValue(token)]])
        : Promise.reject(missing),
  };
}

/** A resolver for a domain that was never pointed or never given its record. */
function unconfigured(): DnsResolver {
  const missing = Object.assign(new Error('none'), { code: 'ENOTFOUND' });
  return {
    resolve4: () => Promise.reject(missing),
    resolve6: () => Promise.reject(missing),
    resolveCname: () => Promise.reject(missing),
    resolveTxt: () => Promise.reject(missing),
  };
}

async function proofFor(fqdn: string, token: string, at = NOW): Promise<DomainProof> {
  const result = await checkCustomDomain(configured(fqdn, token), EDGE, { fqdn, token }, at);
  if (!result.ok) throw new Error('the check was expected to pass');
  return result.proof;
}

const ask = (scope: ReturnType<typeof bindTenant>, domain: unknown, at = NOW) =>
  tenant.requestCustomDomain(scope, { domain, ownedDomains: OWNED }, at);

describe('the custom-domain tables', () => {
  it('are covered by the isolation check', () => {
    expect(() => assertTenantTablesIsolated(schema)).not.toThrow();
  });

  it('start empty', async () => {
    expect(await tenant.customDomains(scopeA)).toEqual([]);
  });
});

describe('requesting a domain', () => {
  it('returns the one record to set and holds the request for the tenant alone', async () => {
    const view = await ask(scopeA, '  Blog.Example.COM. ');
    expect(view).toMatchObject({
      state: 'pending',
      fqdn: DOMAIN,
      recordName: `_publicpress-verify.${DOMAIN}`,
      requestedAt: NOW,
    });
    if (view.state !== 'pending') throw new Error('expected a pending request');
    expect(view.verificationToken).toMatch(/^[a-z2-7]{32}$/);
    expect(view.recordValue).toBe(`publicpress-verify=${view.verificationToken}`);
    expect(await tenant.customDomains(scopeA)).toEqual([view]);
    expect(await tenant.customDomains(scopeC)).toEqual([]);
    // Requesting is not connecting: the edge has nothing to serve.
    expect(await connectedRows()).toBe(0);
  });

  it('returns the same record and token when asked again, and writes no second row', async () => {
    const first = await ask(scopeA, DOMAIN);
    const again = await ask(scopeA, DOMAIN, new Date('2026-11-10T13:00:00Z'));
    expect(again).toEqual(first);
    expect(await requestRows()).toBe(1);
  });

  it('gives another tenant its own token for the same domain, and never blocks it', async () => {
    const mine = await ask(scopeA, DOMAIN);
    const theirs = await ask(scopeC, DOMAIN);
    if (mine.state !== 'pending' || theirs.state !== 'pending') throw new Error('pending expected');
    expect(theirs.verificationToken).not.toBe(mine.verificationToken);
    expect(await tenant.customDomains(scopeC)).toEqual([theirs]);
    expect(await tenant.removeCustomDomain(scopeC, DOMAIN)).toBe(true);
    expect(await requestRows()).toBe(1);
  });

  it.each(['platform.example', 'sites.platform.example', 'PLATFORM.example.'])(
    'refuses %s, which the platform owns',
    async (domain) => {
      expect(await rejection(ask(scopeA, domain))).toBeInstanceOf(CustomDomainOwnedError);
    }
  );

  it.each(['https://blog.example.com', '192.0.2.1', 'blog.example.com/x', '*.example.com', 42])(
    'refuses %j, which is not a domain name',
    async (domain) => {
      expect(await rejection(ask(scopeA, domain))).toBeInstanceOf(InvalidCustomDomainError);
    }
  );

  it('refuses a demo slot, which never has a custom domain', async () => {
    expect(await rejection(ask(scopeB, 'demo.example.com'))).toBeInstanceOf(
      CustomDomainNotAllowedError
    );
    expect(await tenant.customDomains(scopeB)).toEqual([]);
  });

  it('refuses to run without the platform-owned list, rather than assume there is none', async () => {
    const error = await rejection(
      tenant.requestCustomDomain(scopeA, { domain: DOMAIN, ownedDomains: [] }, NOW)
    );
    expect(error).toBeInstanceOf(TypeError);
  });
});

describe('connecting a domain', () => {
  it('connects on a passing check, and the request is spent', async () => {
    const view = await ask(scopeA, DOMAIN);
    if (view.state !== 'pending') throw new Error('pending expected');
    const connected = await tenant.connectCustomDomain(
      scopeA,
      await proofFor(DOMAIN, view.verificationToken),
      NOW
    );
    expect(connected).toEqual({ state: 'connected', fqdn: DOMAIN, connectedAt: NOW });
    expect(await tenant.customDomains(scopeA)).toEqual([connected]);
    expect(await requestRows()).toBe(0);
    expect(await connectedRows()).toBe(1);
  });

  it('answers a second connect, and a repeat request, with the first connection', async () => {
    const connected = (await tenant.customDomains(scopeA))[0];
    const view = await ask(scopeA, DOMAIN);
    expect(view).toEqual(connected);
    const again = await tenant.connectCustomDomain(
      scopeA,
      await proofFor(DOMAIN, 'a'.repeat(32), new Date('2026-11-10T12:05:00Z')),
      new Date('2026-11-10T12:05:00Z')
    );
    expect(again).toEqual(connected);
    expect(await connectedRows()).toBe(1);
  });

  it('refuses a domain that another tenant has connected, naming neither, and leaves the request', async () => {
    const view = await ask(scopeC, DOMAIN);
    if (view.state !== 'pending') throw new Error('pending expected');
    const error = await rejection(
      tenant.connectCustomDomain(scopeC, await proofFor(DOMAIN, view.verificationToken), NOW)
    );
    expect(error).toBeInstanceOf(CustomDomainTakenError);
    expect((error as Error).message).not.toContain(DOMAIN);
    expect(await tenant.customDomains(scopeC)).toEqual([view]);
    expect(await connectedRows()).toBe(1);
    const owners = await fixture.adminDb.select().from(schema.connectedDomain);
    expect(owners.map((row) => row.tenantId)).toEqual([TENANT_A]);
  });

  it('removing the domain clears the connection and frees it for the other tenant', async () => {
    expect(await tenant.removeCustomDomain(scopeA, DOMAIN)).toBe(true);
    expect(await connectedRows()).toBe(0);
    expect(await tenant.customDomains(scopeA)).toEqual([]);
    expect(await tenant.removeCustomDomain(scopeA, DOMAIN)).toBe(false);

    const view = (await tenant.customDomains(scopeC))[0];
    if (view?.state !== 'pending') throw new Error('pending expected');
    const connected = await tenant.connectCustomDomain(
      scopeC,
      await proofFor(DOMAIN, view.verificationToken),
      NOW
    );
    expect(connected.fqdn).toBe(DOMAIN);
    expect(await tenant.removeCustomDomain(scopeC, DOMAIN)).toBe(true);
    expect(await connectedRows()).toBe(0);
  });

  it('cannot remove, or even see, another tenant’s domain', async () => {
    const view = await ask(scopeA, DOMAIN);
    if (view.state !== 'pending') throw new Error('pending expected');
    await tenant.connectCustomDomain(scopeA, await proofFor(DOMAIN, view.verificationToken), NOW);
    expect(await tenant.removeCustomDomain(scopeC, DOMAIN)).toBe(false);
    expect(await tenant.customDomains(scopeC)).toEqual([]);
    expect(await connectedRows()).toBe(1);
    expect(await tenant.removeCustomDomain(scopeA, DOMAIN)).toBe(true);
  });
});

describe('a domain that is never connected', () => {
  it('has no proof to present when it is not pointed or lacks its record', async () => {
    const view = await ask(scopeA, DOMAIN);
    if (view.state !== 'pending') throw new Error('pending expected');
    const result = await checkCustomDomain(
      unconfigured(),
      EDGE,
      { fqdn: DOMAIN, token: view.verificationToken },
      NOW
    );
    expect(result.ok).toBe(false);
    expect(await connectedRows()).toBe(0);
  });

  it('is refused for an object that only looks like a proof', async () => {
    const view = await ask(scopeA, DOMAIN);
    if (view.state !== 'pending') throw new Error('pending expected');
    const forged = { fqdn: DOMAIN, token: view.verificationToken, checkedAt: NOW };
    const error = await rejection(tenant.connectCustomDomain(scopeA, forged as never, NOW));
    expect(error).toBeInstanceOf(DomainProofInvalidError);
    expect(await connectedRows()).toBe(0);
  });

  it('is refused for a proof that is too old, or dated ahead of now', async () => {
    const view = await ask(scopeA, DOMAIN);
    if (view.state !== 'pending') throw new Error('pending expected');
    const old = await proofFor(DOMAIN, view.verificationToken, new Date('2026-11-10T11:49:59Z'));
    expect(await rejection(tenant.connectCustomDomain(scopeA, old, NOW))).toBeInstanceOf(
      DomainProofInvalidError
    );
    const ahead = await proofFor(DOMAIN, view.verificationToken, new Date('2026-11-10T12:00:01Z'));
    expect(await rejection(tenant.connectCustomDomain(scopeA, ahead, NOW))).toBeInstanceOf(
      DomainProofInvalidError
    );
    expect(await connectedRows()).toBe(0);
  });

  it('is refused for a proof made with a token the tenant was not given', async () => {
    const proof = await proofFor(DOMAIN, 'b'.repeat(32));
    expect(await rejection(tenant.connectCustomDomain(scopeA, proof, NOW))).toBeInstanceOf(
      CustomDomainNotRequestedError
    );
    expect(await connectedRows()).toBe(0);
  });

  it('is refused for a proof of a domain the tenant never requested', async () => {
    const proof = await proofFor('never-asked.example.com', 'c'.repeat(32));
    expect(await rejection(tenant.connectCustomDomain(scopeA, proof, NOW))).toBeInstanceOf(
      CustomDomainNotRequestedError
    );
    expect(await connectedRows()).toBe(0);
  });

  it('is refused for another tenant’s request, whose token a proof carries', async () => {
    const mine = await ask(scopeA, DOMAIN);
    if (mine.state !== 'pending') throw new Error('pending expected');
    const proof = await proofFor(DOMAIN, mine.verificationToken);
    expect(await rejection(tenant.connectCustomDomain(scopeC, proof, NOW))).toBeInstanceOf(
      CustomDomainNotRequestedError
    );
    expect(await connectedRows()).toBe(0);
    expect(await tenant.removeCustomDomain(scopeA, DOMAIN)).toBe(true);
  });

  it('cannot be built into a proof by calling the constructor', () => {
    expect(() => new ProofClass(Symbol('mint'), DOMAIN, 'd'.repeat(32), NOW)).toThrow(TypeError);
  });
});

describe('what the tables themselves refuse', () => {
  it('refuses a second tenant’s connected row for one domain, to a statement that skips the code', async () => {
    await fixture.adminDb
      .insert(schema.connectedDomain)
      .values({ fqdn: DOMAIN, tenantId: TENANT_A, connectedAt: NOW });
    const error = await rejection(
      fixture.adminDb
        .insert(schema.connectedDomain)
        .values({ fqdn: DOMAIN, tenantId: TENANT_C, connectedAt: NOW })
    );
    expect(rootMessage(error)).toContain('connected_domain_pkey');
    await fixture.adminDb.delete(schema.connectedDomain);
  });

  it('refuses a name that is not a plain domain, and a token that is not a token', async () => {
    for (const fqdn of ['Upper.example.com', 'example', '1.2.3.4', 'a_b.example.com']) {
      const error = await rejection(
        fixture.adminDb
          .insert(schema.connectedDomain)
          .values({ fqdn, tenantId: TENANT_A, connectedAt: NOW })
      );
      expect(rootMessage(error)).toContain('connected_domain_fqdn_shape');
    }
    const error = await rejection(
      fixture.adminDb.insert(schema.customDomainRequest).values({
        tenantId: TENANT_A,
        fqdn: DOMAIN,
        verificationToken: 'short',
        requestedAt: NOW,
      })
    );
    expect(rootMessage(error)).toContain('custom_domain_request_token_shape');
  });

  it('refuses the tenant role a row for another tenant, and an edit of its own', async () => {
    const other = await rejection(
      tenant.run(scopeA, (tx) =>
        tx
          .insert(schema.connectedDomain)
          .values({ fqdn: DOMAIN, tenantId: TENANT_C, connectedAt: NOW })
      )
    );
    expect(rootMessage(other)).toContain('row-level security');
    const edit = await rejection(
      tenant.run(scopeA, (tx) => tx.update(schema.connectedDomain).set({ fqdn: DOMAIN }))
    );
    expect(rootMessage(edit)).toContain('permission denied');
    expect(await connectedRows()).toBe(0);
  });
});
