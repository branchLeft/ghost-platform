import { describe, expect, it } from 'vitest';
import type { TenantUid } from '../src/brand.js';
import { tenantEnvironment } from '../src/environment.js';
import { credentialDomainOf, sendingDomainOf } from '../src/mail.js';
import { secretsEnvPath } from '../src/naming.js';
import { uploadLimits } from '../src/runtime.js';
import { validate } from '../src/validate.js';
import { demoDescriptor, entryTenantDescriptor, tenantDescriptor, TEST_ZONES } from './fixtures.js';

const DEMO_MAIL = TEST_ZONES.demoMailDomain;

function demoSlot(uid: number, localPart: string) {
  const base = demoDescriptor();
  return validate(
    {
      ...base,
      uid: uid as TenantUid,
      mail: { ...base.mail, identity: { kind: 'demo' as const, localPart } },
    },
    TEST_ZONES
  );
}

function envOf(descriptor: ReturnType<typeof demoSlot>) {
  return tenantEnvironment(descriptor, uploadLimits(), secretsEnvPath(descriptor.slug), TEST_ZONES);
}

describe('a demo slot authenticates to the mail spool as its own credential domain', () => {
  const a = envOf(demoSlot(30001, 'demo-1'));
  const b = envOf(demoSlot(30002, 'demo-2'));

  it('two slots render two different SMTP usernames', () => {
    expect(a.mail__options__auth__user).not.toBe(b.mail__options__auth__user);
  });

  it('two slots render two different Mailgun-route domains', () => {
    expect(a.bulkEmail__mailgun__domain).not.toBe(b.bulkEmail__mailgun__domain);
  });

  it('the SMTP username and the Mailgun-route domain stay one value per slot', () => {
    expect(a.mail__options__auth__user).toBe(a.bulkEmail__mailgun__domain);
    expect(b.mail__options__auth__user).toBe(b.bulkEmail__mailgun__domain);
  });

  it('each credential is slot-<uid> under the shared demo mail domain', () => {
    expect(a.mail__options__auth__user).toBe(`slot-30001.${DEMO_MAIL}`);
    expect(b.mail__options__auth__user).toBe(`slot-30002.${DEMO_MAIL}`);
  });

  it('is keyed on the uid, not the local part', () => {
    const sameUidOtherPart = envOf(demoSlot(30001, 'another-part'));
    const otherUidSamePart = envOf(demoSlot(30002, 'demo-1'));
    expect(sameUidOtherPart.mail__options__auth__user).toBe(a.mail__options__auth__user);
    expect(otherUidSamePart.mail__options__auth__user).not.toBe(a.mail__options__auth__user);
  });

  it('the sending address is unchanged: local part per demo, one shared sender domain', () => {
    expect(a.mail__from).toBe(`demo-1@${DEMO_MAIL}`);
    expect(b.mail__from).toBe(`demo-2@${DEMO_MAIL}`);
  });

  it('the password stays a reference to the one operator-written key, never a literal', () => {
    expect(a.mail__options__auth__pass).toMatch(/^\$\{GHOST_BULK_EMAIL_API_KEY:\?/);
    expect(a.bulkEmail__mailgun__apiKey).toMatch(/^\$\{GHOST_BULK_EMAIL_API_KEY:\?/);
  });
});

describe('credentialDomainOf()', () => {
  const demo = { kind: 'demo', localPart: 'demo-1' } as const;
  const tenant = { kind: 'tenant', domain: 'blog.acme.example', dkimSelector: 'bl' } as const;

  it('a demo slot differs from the shared sender domain and sits under it', () => {
    const credential = credentialDomainOf(demo, TEST_ZONES, 30001 as TenantUid);
    expect(credential).not.toBe(sendingDomainOf(demo, TEST_ZONES));
    expect(credential.endsWith(`.${DEMO_MAIL}`)).toBe(true);
  });

  it('is a DNS-safe label for the whole uid range', () => {
    for (const uid of [30000, 30001, 30999]) {
      const label = credentialDomainOf(demo, TEST_ZONES, uid as TenantUid).split('.')[0];
      expect(label).toMatch(/^slot-[0-9]+$/);
    }
  });

  it('a paying tenant is its own sending domain', () => {
    const credential = credentialDomainOf(tenant, TEST_ZONES, 30123 as TenantUid);
    expect(credential).toBe(tenant.domain);
    expect(credential).toBe(sendingDomainOf(tenant, TEST_ZONES));
  });

  it("can never equal a tenant's domain: validate() refuses a tenant under the demo mail domain", () => {
    const credential = credentialDomainOf(demo, TEST_ZONES, 30001 as TenantUid);
    const base = tenantDescriptor();
    expect(() =>
      validate(
        { ...base, mail: { ...base.mail, identity: { ...tenant, domain: credential } } },
        TEST_ZONES
      )
    ).toThrow(/demoMailDomain/);
  });
});

describe("a paying tenant's spool credential is unchanged: its own sending domain", () => {
  it('a queue-transport tenant authenticates as identity.domain on both paths', () => {
    const descriptor = validate(tenantDescriptor(), TEST_ZONES);
    const env = envOf(descriptor);
    expect(env.mail__options__auth__user).toBe('blog.acme.example');
    expect(env.bulkEmail__mailgun__domain).toBe('blog.acme.example');
  });

  it('an smtp-transport tenant keeps its own SMTP user and a bulk domain of identity.domain', () => {
    const descriptor = validate(entryTenantDescriptor(), TEST_ZONES);
    const env = envOf(descriptor);
    expect(env.mail__options__auth__user).toBe('entry-co');
    expect(env.bulkEmail__mailgun__domain).toBe('blog.entry-co.example');
  });
});
