import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tenants } from '../../src/schema.js';
import { createSqliteStore, TenantRegistrationRefused, type ShimStore } from '../../src/store.js';
import { withFixture } from '../helpers/sqliteFixtures.js';

// Registration refuses two credentials that could act as one: a shared key
// and an overlapping sender address. All keys are test values.
// See store.md#registration-refusals.

const SENDER = 'demo-mail.example.test';
const SLOT_A = `slot-30001.${SENDER}`;
const SLOT_B = `slot-30002.${SENDER}`;

let store: ShimStore;

beforeEach(() => {
  store = createSqliteStore(':memory:');
});

afterEach(() => {
  store.close();
});

function refusal(fn: () => unknown): TenantRegistrationRefused {
  try {
    fn();
  } catch (err) {
    if (err instanceof TenantRegistrationRefused) return err;
    throw err;
  }
  throw new Error('expected the registration to be refused');
}

describe('one key, one credential', () => {
  it("refuses a second credential registered with the first one's key, and writes nothing", async () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');

    const refused = refusal(() => store.registerTenant(SLOT_B, 'key-a', SENDER, 'demo-2'));

    expect(refused.reason).toBe('key-bound-to-another-credential');
    expect(refused.other).toBe(SLOT_A);
    expect(refused.message).not.toContain('key-a');
    expect(store.tenantExists(SLOT_B)).toBe(false);
    await expect(store.verifyTenant(SLOT_A, 'key-a')).resolves.not.toBeNull();
    await expect(store.verifyTenant(SLOT_B, 'key-a')).resolves.toBeNull();
  });

  it('accepts distinct keys for credentials on one sender domain', async () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');
    store.registerTenant(SLOT_B, 'key-b', SENDER, 'demo-2');

    await expect(store.verifyTenant(SLOT_A, 'key-a')).resolves.not.toBeNull();
    await expect(store.verifyTenant(SLOT_B, 'key-b')).resolves.not.toBeNull();
    await expect(store.verifyTenant(SLOT_B, 'key-a')).resolves.toBeNull();
  });

  it("refuses a rotation onto another credential's key, and leaves the old key working", async () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');
    store.registerTenant(SLOT_B, 'key-b', SENDER, 'demo-2');

    expect(refusal(() => store.registerTenant(SLOT_B, 'key-a', SENDER, 'demo-2')).reason).toBe(
      'key-bound-to-another-credential'
    );

    await expect(store.verifyTenant(SLOT_B, 'key-b')).resolves.not.toBeNull();
  });

  it('lets a credential be re-registered with the key it already holds', async () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');
    store.registerTenant(SLOT_B, 'key-b', SENDER, 'demo-2');

    expect(() => store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1')).not.toThrow();
    await expect(store.verifyTenant(SLOT_A, 'key-a')).resolves.not.toBeNull();
  });

  it('refuses a shared key across unrelated sender domains too', () => {
    store.registerTenant('blog.example.com', 'key-a', 'example.com');

    expect(
      refusal(() => store.registerTenant('other.example.org', 'key-a', 'example.org')).reason
    ).toBe('key-bound-to-another-credential');
  });
});

describe('one sender address, one credential', () => {
  it('refuses a second unrestricted credential on a sender domain', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER);

    const refused = refusal(() => store.registerTenant(SLOT_B, 'key-b', SENDER));

    expect(refused.reason).toBe('sender-address-claimed');
    expect(refused.other).toBe(SLOT_A);
    expect(store.tenantExists(SLOT_B)).toBe(false);
  });

  it('refuses a second credential for the same local part, whatever its case', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');

    expect(refusal(() => store.registerTenant(SLOT_B, 'key-b', SENDER, 'demo-1')).reason).toBe(
      'sender-address-claimed'
    );
    expect(refusal(() => store.registerTenant(SLOT_B, 'key-b', SENDER, 'DEMO-1')).reason).toBe(
      'sender-address-claimed'
    );
    expect(
      refusal(() => store.registerTenant(SLOT_B, 'key-b', 'DEMO-MAIL.example.test', 'demo-1'))
        .reason
    ).toBe('sender-address-claimed');
  });

  it('refuses an unrestricted credential onto a domain another credential restricts, and the reverse', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');
    expect(refusal(() => store.registerTenant(SLOT_B, 'key-b', SENDER)).reason).toBe(
      'sender-address-claimed'
    );

    store.registerTenant('blog.example.com', 'key-blog', 'example.com');
    expect(
      refusal(() => store.registerTenant('slot.example.com', 'key-c', 'example.com', 'demo-3'))
        .reason
    ).toBe('sender-address-claimed');
  });

  it('accepts distinct local parts, and one unrestricted credential on a domain of its own', () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');
    store.registerTenant(SLOT_B, 'key-b', SENDER, 'demo-2');
    store.registerTenant('blog.example.com', 'key-blog', 'example.com');

    expect(store.listTenants()).toEqual([
      { domain: 'blog.example.com', senderDomain: 'example.com', senderLocalPart: null },
      { domain: SLOT_A, senderDomain: SENDER, senderLocalPart: 'demo-1' },
      { domain: SLOT_B, senderDomain: SENDER, senderLocalPart: 'demo-2' },
    ]);
  });

  it('stores the local part lower-cased and hands it back from verifyTenant', async () => {
    store.registerTenant(SLOT_A, 'key-a', SENDER, 'Demo-1');

    await expect(store.verifyTenant(SLOT_A, 'key-a')).resolves.toEqual({
      domain: SLOT_A,
      senderDomain: SENDER,
      senderLocalPart: 'demo-1',
    });
  });

  it('refuses a local part that cannot be one', () => {
    for (const bad of ['', 'a b', 'a@b', ' a']) {
      expect(() => store.registerTenant(SLOT_A, 'key-a', SENDER, bad), JSON.stringify(bad)).toThrow(
        TypeError
      );
    }
    expect(store.tenantExists(SLOT_A)).toBe(false);
  });

  describe('setSenderLocalPart', () => {
    it('binds an existing credential without touching its key', async () => {
      store.registerTenant(SLOT_A, 'key-a', SENDER);

      expect(store.setSenderLocalPart(SLOT_A, 'demo-1')).toBe(true);

      await expect(store.verifyTenant(SLOT_A, 'key-a')).resolves.toEqual({
        domain: SLOT_A,
        senderDomain: SENDER,
        senderLocalPart: 'demo-1',
      });
    });

    it('is false for an unregistered credential', () => {
      expect(store.setSenderLocalPart(SLOT_A, 'demo-1')).toBe(false);
    });

    it("refuses another credential's address, and changes nothing", async () => {
      store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');
      store.registerTenant(SLOT_B, 'key-b', SENDER, 'demo-2');

      expect(refusal(() => store.setSenderLocalPart(SLOT_B, 'DEMO-1')).reason).toBe(
        'sender-address-claimed'
      );

      await expect(store.verifyTenant(SLOT_B, 'key-b')).resolves.toMatchObject({
        senderLocalPart: 'demo-2',
      });
    });

    it('refuses a move of the sender domain onto an address another credential claims', () => {
      store.registerTenant(SLOT_A, 'key-a', SENDER, 'demo-1');
      store.registerTenant(SLOT_B, 'key-b', 'other.example.test', 'demo-1');

      expect(refusal(() => store.setSenderDomain(SLOT_B, SENDER)).reason).toBe(
        'sender-address-claimed'
      );
      expect(store.listTenants().find((t) => t.domain === SLOT_B)?.senderDomain).toBe(
        'other.example.test'
      );
    });
  });
});

describe('legacy rows that already overlap', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'shim-binding-'));
    dbPath = join(dir, 'shim.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Two rows on one sender domain with no local part: how the demo host's
  // per-slot rows were registered before the binding existed. Written straight
  // into the file, because registration now refuses to create them.
  function openWithLegacyOverlap(): ShimStore {
    createSqliteStore(dbPath).close();
    withFixture(dbPath, ({ db }) => {
      db.insert(tenants)
        .values([
          { domain: SLOT_A, apiKeySalt: 'aa', apiKeyHash: 'aa', senderDomain: SENDER },
          { domain: SLOT_B, apiKeySalt: 'bb', apiKeyHash: 'bb', senderDomain: SENDER },
        ])
        .run();
    });
    return createSqliteStore(dbPath);
  }

  it('can be narrowed one at a time, and rotated unchanged, but never joined by a new claim', async () => {
    const legacy = openWithLegacyOverlap();
    try {
      expect(legacy.setSenderLocalPart(SLOT_A, 'demo-1')).toBe(true);
      expect(legacy.setSenderLocalPart(SLOT_B, 'demo-2')).toBe(true);

      expect(
        refusal(() => legacy.registerTenant('slot-30003.demo-mail.example.test', 'key-c', SENDER))
          .reason
      ).toBe('sender-address-claimed');
      expect(refusal(() => legacy.registerTenant(SLOT_A, 'key-a2', SENDER, 'demo-2')).reason).toBe(
        'sender-address-claimed'
      );

      legacy.registerTenant(SLOT_A, 'key-a3', SENDER, 'demo-1');
      await expect(legacy.verifyTenant(SLOT_A, 'key-a3')).resolves.not.toBeNull();
    } finally {
      legacy.close();
    }
  });

  it('can be rotated while still unrestricted, since the rotation adds no overlap', async () => {
    const legacy = openWithLegacyOverlap();
    try {
      expect(() => legacy.registerTenant(SLOT_A, 'key-a2', SENDER)).not.toThrow();
      await expect(legacy.verifyTenant(SLOT_A, 'key-a2')).resolves.not.toBeNull();
    } finally {
      legacy.close();
    }
  });

  it('treats a legacy row whose stored hash matches nothing as no key collision, not a crash', () => {
    const legacy = openWithLegacyOverlap();
    try {
      expect(() =>
        legacy.registerTenant('slot-30009.demo-mail.example.test', 'key-new', 'x.example.test')
      ).not.toThrow();
    } finally {
      legacy.close();
    }
  });
});
