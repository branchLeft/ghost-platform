// The tenant tier's gates, each run green through the object-store adapter on
// the channel a paying tenant uses and then run again as a control that must go
// red at that assertion's own id. See ../helpers/tenant-tier-gates.md.
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  Channel,
  FIXTURES,
  Slot as DemoSlot,
  StandInService,
  keyOf,
  loadEntryAdapter,
  type Loaded,
} from '../helpers/demo-tier-gates';
import {
  PAID_TIERS,
  TENANT_ADAPTERS,
  TENANT_ASSERTION_IDS,
  TenantGateFailure,
  TenantSlot,
  assertAge,
  assertDemoTierAlsoRefuses,
  assertHold,
  assertPromotion,
  assertRefusal,
  tenantRegistry,
  type PaidTier,
  type TenantAssertionId,
  type TenantSource,
} from '../helpers/tenant-tier-gates';

const SRC = path.resolve(import.meta.dirname, '../../src');
const TIMEOUT = { timeout: 30_000 };

let loaded: Loaded;
beforeAll(() => {
  loaded = loadEntryAdapter(SRC, TENANT_ADAPTERS);
});
afterAll(() => loaded.restore());

const channels: Channel[] = [];
const cleanups: { cleanup(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all([...cleanups, ...channels].map((thing) => thing.cleanup()));
  cleanups.length = 0;
  channels.length = 0;
});

async function tenant(
  kind: TenantSource['kind'] = 'channel',
  options: { tier?: PaidTier; maskReads?: boolean } = {}
) {
  const channel = await Channel.start();
  channels.push(channel);
  const source: TenantSource = kind === 'channel' ? { kind, channel } : { kind };
  const slot = await TenantSlot.build(loaded, source, {
    tier: options.tier ?? 'professional',
    maskReads: options.maskReads,
  });
  cleanups.push(slot);
  return { channel, slot, service: new StandInService(channel) };
}

async function demo(kind: 'channel' | 'allow-all' = 'channel') {
  const channel = await Channel.start();
  channels.push(channel);
  const slot = await DemoSlot.build(loaded, kind === 'channel' ? { kind, channel } : { kind });
  cleanups.push(slot);
  return { slot, service: new StandInService(channel) };
}

// The control passes only when the assertion went red at exactly `id`.
async function expectRed(id: TenantAssertionId, run: () => Promise<unknown>) {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown
  );
  expect(error, `${id} did not go red`).toBeInstanceOf(TenantGateFailure);
  expect((error as TenantGateFailure).assertion).toBe(id);
}

describe.each(PAID_TIERS)('refusal on the %s tier, through the object-store adapter', (tier) => {
  it(
    'an upload of the test-classification hash is refused, nothing is served, the bucket holds nothing',
    TIMEOUT,
    async () => {
      const { slot, service } = await tenant('channel', { tier });
      service.refuse(keyOf(FIXTURES.testClassification));
      await assertRefusal(slot, service, FIXTURES.testClassification);
    }
  );
});

describe('refusal controls', () => {
  it('control: a service that answers clean leaves the upload accepted', TIMEOUT, async () => {
    const { slot, service } = await tenant();
    await expectRed('refusal.upload-refused', () =>
      assertRefusal(slot, service, FIXTURES.testClassification)
    );
  });

  it('control: a slot with no scanning accepts it', TIMEOUT, async () => {
    const { slot, service } = await tenant('allow-all');
    service.refuse(keyOf(FIXTURES.testClassification));
    await expectRed('refusal.upload-refused', () =>
      assertRefusal(slot, service, FIXTURES.testClassification)
    );
  });

  it('control: bytes that reach a served key after the refusal are seen', TIMEOUT, async () => {
    const { slot, service } = await tenant();
    service.refuse(keyOf(FIXTURES.testClassification));
    await expectRed('refusal.nothing-served', () =>
      assertRefusal(slot, service, FIXTURES.testClassification, () => {
        slot.bucket.plant(slot.uploadedKeys()[0] as string, FIXTURES.testClassification);
      })
    );
  });

  it(
    'control: bytes that reach the bucket under any key after the refusal are seen',
    TIMEOUT,
    async () => {
      const { slot, service } = await tenant();
      service.refuse(keyOf(FIXTURES.testClassification));
      await expectRed('refusal.not-in-bucket', () =>
        assertRefusal(slot, service, FIXTURES.testClassification, () => {
          slot.bucket.plant('content/images/stray/leak.png', FIXTURES.testClassification);
        })
      );
    }
  );
});

describe.each(PAID_TIERS)('hold on the %s tier, through the object-store adapter', (tier) => {
  it(
    'the service not draining: accepted, unserved, never written to the bucket, then promoted by a clean verdict',
    TIMEOUT,
    async () => {
      const { slot, service } = await tenant('channel', { tier });
      const key = await assertHold(slot, FIXTURES.clean);
      await assertPromotion(slot, service, FIXTURES.clean, key);
    }
  );
});

describe('hold on the tenant tier, with the verdict channel stopped', () => {
  it(
    'accepted, unserved, never written, and promoted once the channel is back and the service answers clean',
    TIMEOUT,
    async () => {
      const { channel, slot, service } = await tenant();
      await channel.stop();
      const key = await assertHold(slot, FIXTURES.clean);
      await channel.restart();
      await assertPromotion(slot, service, FIXTURES.clean, key);
    }
  );
});

describe('hold and promotion controls', () => {
  it(
    'control: a slot with no scanner source refuses the upload instead of accepting it',
    TIMEOUT,
    async () => {
      const { slot } = await tenant('none');
      await expectRed('hold.upload-accepted', () => assertHold(slot, FIXTURES.clean));
    }
  );

  it('control: a slot with no scanning serves the original at once', TIMEOUT, async () => {
    const { slot } = await tenant('allow-all');
    await expectRed('hold.original-not-served', () => assertHold(slot, FIXTURES.clean));
  });

  it(
    'control: a derivative in the bucket is served even with the original withheld',
    TIMEOUT,
    async () => {
      const { slot } = await tenant();
      await expectRed('hold.size-request-empty', () =>
        assertHold(slot, FIXTURES.clean, (phase) => {
          if (phase !== 'after-upload') return;
          const key = slot.uploadedKeys()[0] as string;
          slot.bucket.plant(
            `content/images/size/w600/${key.slice('content/images/'.length)}`,
            FIXTURES.clean
          );
        })
      );
    }
  );

  it(
    'control: an object written then hidden, not absent, is seen by a direct read of the bucket',
    TIMEOUT,
    async () => {
      // The adapter answers not-found for everything, as a write-then-mask
      // adapter would, so the original and the size request look withheld.
      const { slot } = await tenant('channel', { maskReads: true });
      await expectRed('hold.absent-from-bucket', () =>
        assertHold(slot, FIXTURES.clean, (phase) => {
          if (phase !== 'after-upload') return;
          slot.bucket.plant(slot.uploadedKeys()[0] as string, FIXTURES.clean);
        })
      );
    }
  );

  it('control: bytes under another key are not absent either', TIMEOUT, async () => {
    const { slot } = await tenant();
    await expectRed('hold.absent-from-bucket', () =>
      assertHold(slot, FIXTURES.clean, (phase) => {
        if (phase !== 'after-upload') return;
        slot.bucket.plant('content/images/2026/11/elsewhere.png', FIXTURES.clean);
      })
    );
  });

  it('control: an original that appears during the retries is seen', TIMEOUT, async () => {
    const { slot } = await tenant();
    await expectRed('hold.stays-withheld', () =>
      assertHold(slot, FIXTURES.clean, async (phase) => {
        if (phase !== 'after-retries') return;
        await slot.adapter.wrapped.saveRaw(FIXTURES.clean, slot.uploadedKeys()[0] as string);
      })
    );
  });

  it('control: with no verdict from the service nothing is in the bucket', TIMEOUT, async () => {
    const { slot, service } = await tenant();
    const key = await assertHold(slot, FIXTURES.clean);
    await expectRed('promotion.present-in-bucket', () =>
      assertPromotion(slot, service, FIXTURES.clean, key, { drain: false, timeoutMs: 600 })
    );
  });

  it(
    'control: an object in the bucket that is not served after the clean verdict is seen',
    TIMEOUT,
    async () => {
      const { slot, service } = await tenant('channel', { maskReads: true });
      const key = await assertHold(slot, FIXTURES.clean);
      await expectRed('promotion.served', () =>
        assertPromotion(slot, service, FIXTURES.clean, key)
      );
    }
  );
});

describe('the pair: neither tier can pass alone', () => {
  it(
    'the same test-classification upload is refused through the tenant tier and the demo tier',
    TIMEOUT,
    async () => {
      const t = await tenant();
      t.service.refuse(keyOf(FIXTURES.testClassification));
      await assertRefusal(t.slot, t.service, FIXTURES.testClassification);
      const d = await demo();
      d.service.refuse(keyOf(FIXTURES.testClassification));
      await assertDemoTierAlsoRefuses(d.slot, d.service, FIXTURES.testClassification);
    }
  );

  it(
    'control: a demo tier that accepts the upload fails the pair while the tenant tier refuses',
    TIMEOUT,
    async () => {
      const t = await tenant();
      t.service.refuse(keyOf(FIXTURES.testClassification));
      await assertRefusal(t.slot, t.service, FIXTURES.testClassification);
      const d = await demo('allow-all');
      d.service.refuse(keyOf(FIXTURES.testClassification));
      await expectRed('pair.demo-tier-refuses', () =>
        assertDemoTierAlsoRefuses(d.slot, d.service, FIXTURES.testClassification)
      );
    }
  );

  it(
    'control: a tenant tier that accepts the upload fails while the demo tier refuses',
    TIMEOUT,
    async () => {
      const d = await demo();
      d.service.refuse(keyOf(FIXTURES.testClassification));
      await assertDemoTierAlsoRefuses(d.slot, d.service, FIXTURES.testClassification);
      const t = await tenant('allow-all');
      t.service.refuse(keyOf(FIXTURES.testClassification));
      await expectRed('refusal.upload-refused', () =>
        assertRefusal(t.slot, t.service, FIXTURES.testClassification)
      );
    }
  );
});

describe('the tenant host end oldest-unverdicted age, read from the host end', () => {
  it('grows while the service is not draining and is zero after the verdict', TIMEOUT, async () => {
    const { channel, slot, service } = await tenant();
    await assertAge(slot, channel, service, FIXTURES.other);
  });

  it('control: a hash that never reached the host end has no age to grow', TIMEOUT, async () => {
    const { channel, slot, service } = await tenant('allow-all');
    await expectRed('age.grows-while-undrained', () =>
      assertAge(slot, channel, service, FIXTURES.other)
    );
  });

  it(
    'control: a hash still waiting after the drain keeps the age above zero',
    TIMEOUT,
    async () => {
      const { channel, slot, service } = await tenant();
      await expectRed('age.returns-to-zero', () =>
        assertAge(slot, channel, service, FIXTURES.other, async (phase) => {
          if (phase !== 'before-zero') return;
          await slot.upload('waiting.png', FIXTURES.testClassification);
          channel.advance(5000);
        })
      );
    }
  );
});

describe('every tenant assertion is paired', () => {
  it('has passed green and been seen red, each at least once', () => {
    const neverGreen = TENANT_ASSERTION_IDS.filter((id) => !tenantRegistry.passed.has(id));
    const neverRed = TENANT_ASSERTION_IDS.filter((id) => !tenantRegistry.red.has(id));
    expect({ neverGreen, neverRed }).toEqual({ neverGreen: [], neverRed: [] });
  });
});
