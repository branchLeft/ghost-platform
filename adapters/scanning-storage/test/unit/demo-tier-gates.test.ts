// The demo tier's gates, each run green on the channel the demo uses and then
// run again as a control that must go red at that assertion's own id. See
// ../helpers/demo-tier-gates.md.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  ASSERTION_IDS,
  Channel,
  FIXTURES,
  GateFailure,
  Slot,
  StandInService,
  assertAge,
  assertHold,
  assertPromotion,
  assertRefusal,
  keyOf,
  loadEntryAdapter,
  registry,
  type AssertionId,
  type Loaded,
} from '../helpers/demo-tier-gates';

const require = createRequire(import.meta.url);
const SRC = path.resolve(import.meta.dirname, '../../src');
const TIMEOUT = { timeout: 30_000 };

let loaded: Loaded;
beforeAll(() => {
  loaded = loadEntryAdapter(SRC);
});
afterAll(() => loaded.restore());

const channels: Channel[] = [];
const slots: Slot[] = [];
afterEach(async () => {
  await Promise.all([...slots, ...channels].map((thing) => thing.cleanup()));
  slots.length = 0;
  channels.length = 0;
});

async function onChannel() {
  const channel = await Channel.start();
  channels.push(channel);
  const slot = await Slot.build(loaded, { kind: 'channel', channel });
  slots.push(slot);
  return { channel, slot, service: new StandInService(channel) };
}

async function elsewhere(kind: 'allow-all' | 'none') {
  const channel = await Channel.start();
  channels.push(channel);
  const slot = await Slot.build(loaded, { kind });
  slots.push(slot);
  return { channel, slot, service: new StandInService(channel) };
}

// The control passes only when the assertion went red at exactly `id`.
async function expectRed(id: AssertionId, run: () => Promise<unknown>) {
  const error = await run().then(
    () => null,
    (thrown: unknown) => thrown
  );
  expect(error, `${id} did not go red`).toBeInstanceOf(GateFailure);
  expect((error as GateFailure).assertion).toBe(id);
}

describe('refusal on the demo tier, through the real adapter and the real channel', () => {
  it(
    'an upload of the test-classification hash is refused and nothing is served or stored',
    TIMEOUT,
    async () => {
      const { slot, service } = await onChannel();
      service.refuse(keyOf(FIXTURES.testClassification));
      await assertRefusal(slot, service, FIXTURES.testClassification);
    }
  );

  it('control: a service that answers clean leaves the upload accepted', TIMEOUT, async () => {
    const { slot, service } = await onChannel();
    await expectRed('refusal.upload-refused', () =>
      assertRefusal(slot, service, FIXTURES.testClassification)
    );
  });

  it('control: a slot with no scanning accepts it', TIMEOUT, async () => {
    const { slot, service } = await elsewhere('allow-all');
    service.refuse(keyOf(FIXTURES.testClassification));
    await expectRed('refusal.upload-refused', () =>
      assertRefusal(slot, service, FIXTURES.testClassification)
    );
  });

  it('control: bytes that reach the served path after the refusal are seen', TIMEOUT, async () => {
    const { slot, service } = await onChannel();
    service.refuse(keyOf(FIXTURES.testClassification));
    await expectRed('refusal.nothing-served', () =>
      assertRefusal(slot, service, FIXTURES.testClassification, async () => {
        await slot.adapter.wrapped.saveRaw(FIXTURES.testClassification, slot.paths[0] as string);
      })
    );
  });

  it('control: bytes that reach storage anywhere after the refusal are seen', TIMEOUT, async () => {
    const { slot, service } = await onChannel();
    service.refuse(keyOf(FIXTURES.testClassification));
    await expectRed('refusal.nothing-stored', () =>
      assertRefusal(slot, service, FIXTURES.testClassification, async () => {
        await slot.adapter.wrapped.saveRaw(FIXTURES.testClassification, 'stray/leak.png');
      })
    );
  });
});

describe('hold on the demo tier, through the real adapter and the real channel', () => {
  it(
    'the service not draining: accepted, unserved, nothing at a size, then promoted by a clean verdict',
    TIMEOUT,
    async () => {
      const { slot, service } = await onChannel();
      const stored = await assertHold(slot, FIXTURES.clean);
      await assertPromotion(slot, service, FIXTURES.clean, stored);
    }
  );

  it(
    'the host end stopped: accepted, unserved, and promoted once it is back and the service answers clean',
    TIMEOUT,
    async () => {
      const { channel, slot, service } = await onChannel();
      await channel.stop();
      const stored = await assertHold(slot, FIXTURES.clean);
      await channel.restart();
      await assertPromotion(slot, service, FIXTURES.clean, stored);
    }
  );

  it(
    'control: a slot with no scanner source refuses the upload instead of accepting it',
    TIMEOUT,
    async () => {
      const { slot } = await elsewhere('none');
      await expectRed('hold.upload-accepted', () => assertHold(slot, FIXTURES.clean));
    }
  );

  it('control: a slot with no scanning serves the original at once', TIMEOUT, async () => {
    const { slot } = await elsewhere('allow-all');
    await expectRed('hold.original-not-served', () => assertHold(slot, FIXTURES.clean));
  });

  it(
    'control: a derivative on disk is served even with the original withheld',
    TIMEOUT,
    async () => {
      const { slot } = await onChannel();
      await expectRed('hold.size-request-empty', () =>
        assertHold(slot, FIXTURES.clean, async (phase) => {
          if (phase !== 'after-upload') return;
          await slot.adapter.wrapped.saveRaw(FIXTURES.clean, `size/w600/${slot.paths[0]}`);
        })
      );
    }
  );

  it('control: an original that appears during the retries is seen', TIMEOUT, async () => {
    const { slot } = await onChannel();
    await expectRed('hold.stays-withheld', () =>
      assertHold(slot, FIXTURES.clean, async (phase) => {
        if (phase !== 'after-retries') return;
        await slot.adapter.wrapped.saveRaw(FIXTURES.clean, slot.paths[0] as string);
      })
    );
  });

  it(
    'control: with no verdict from the service the size request never returns the image',
    TIMEOUT,
    async () => {
      const { slot, service } = await onChannel();
      const stored = await assertHold(slot, FIXTURES.clean);
      await expectRed('hold.promoted-on-clean-verdict', () =>
        assertPromotion(slot, service, FIXTURES.clean, stored, { drain: false, timeoutMs: 600 })
      );
    }
  );
});

describe('the host end oldest-unverdicted age, read from the host end', () => {
  it(
    'grows while the service is not draining, survives a host restart, and is zero after the verdict',
    TIMEOUT,
    async () => {
      const { channel, slot, service } = await onChannel();
      await assertAge(slot, channel, service, FIXTURES.other);
    }
  );

  it('control: a hash that never reached the host end has no age to grow', TIMEOUT, async () => {
    const { channel, slot, service } = await elsewhere('allow-all');
    await expectRed('age.grows-while-undrained', () =>
      assertAge(slot, channel, service, FIXTURES.other)
    );
  });

  it('control: a host restart that loses the journal loses the age', TIMEOUT, async () => {
    const { channel, slot, service } = await onChannel();
    await expectRed('age.carries-across-restart', () =>
      assertAge(slot, channel, service, FIXTURES.other, async (phase) => {
        if (phase !== 'before-restart') return;
        await fs.rm(path.join(channel.directory, 'state'), { recursive: true, force: true });
      })
    );
  });

  it(
    'control: a hash still waiting after the drain keeps the age above zero',
    TIMEOUT,
    async () => {
      const { channel, slot, service } = await onChannel();
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

describe('every assertion is paired', () => {
  it('has passed green and been seen red, each at least once', () => {
    const neverGreen = ASSERTION_IDS.filter((id) => !registry.passed.has(id));
    const neverRed = ASSERTION_IDS.filter((id) => !registry.red.has(id));
    expect({ neverGreen, neverRed }).toEqual({ neverGreen: [], neverRed: [] });
  });
});

// The gates run on the adapter's real hash stage: the fixtures are generated
// pictures and the stand-in service is keyed on their real PDQ hashes. This
// holds that: each fixture hashes, to a key of the shape the host end accepts,
// the three are unrelated (a match is at most 31 bits apart), and the hash
// functions the adapter calls are the shipped ones, not replaced by the harness.
describe('the hash stage', () => {
  const { hammingDistance } = require(path.join(SRC, 'pdq-ts')) as {
    hammingDistance: (a: Uint8Array, b: Uint8Array) => number;
  };
  const keys = Object.values(FIXTURES).map((picture) => keyOf(picture));

  it('hashes every fixture to a 32-byte key, each different', () => {
    for (const key of keys) {
      expect(key).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      expect(Buffer.from(key, 'base64')).toHaveLength(32);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps the fixtures unrelated, so one answer never covers another', () => {
    for (let a = 0; a < keys.length; a += 1) {
      for (let b = a + 1; b < keys.length; b += 1) {
        const distance = hammingDistance(
          Buffer.from(keys[a] as string, 'base64'),
          Buffer.from(keys[b] as string, 'base64')
        );
        expect(distance).toBeGreaterThan(31);
      }
    }
  });

  it('is the shipped one: the harness replaces none of the adapter hash functions', () => {
    const pdq = require(path.join(SRC, 'pdq.js'));
    expect(pdq.pdqHashOfImage.name).toBe('pdqHashOfImage');
    expect(pdq.digestBytes.name).toBe('digestBytes');
    expect(pdq.digestBytes(Buffer.from('x'))).toMatch(/^[0-9a-f]{64}$/);
    expect(keyOf(FIXTURES.clean)).not.toBe(pdq.digestBytes(FIXTURES.clean));
  });
});
