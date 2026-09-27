import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { HoldRegistry, evaluate } = require('../../src/hold.js');

// Real, short timers rather than vi.useFakeTimers(): the retry loop's own
// cleanup step touches the real filesystem, and a fake clock only fast
// forwards JS timers, not the real I/O a promoted item's housekeeping
// depends on -- mixing the two makes a retry's completion unobservable at
// the exact moment a test's own await resolves.
const RETRY_MS = 20;
const settle = (ms = RETRY_MS * 3) => new Promise((resolve) => setTimeout(resolve, ms));

const ALLOW_CHECK = {
  kind: 'media',
  blocking: true,
  async run() {
    return { classification: 'no-known-match', evidence: 'digest', source: 'test' };
  },
};

function refuseCheck(classification = 'harmful-abusive-material') {
  return {
    kind: 'media',
    blocking: true,
    async run() {
      return { classification, matchType: 'exact', evidence: 'digest', source: 'test' };
    },
  };
}

function unavailableCheck() {
  return {
    kind: 'media',
    blocking: true,
    async run() {
      return { classification: 'unavailable', evidence: 'digest', source: 'test' };
    },
  };
}

// A check that answers 'unavailable' until told otherwise, standing in for
// "a later verdict arrives" with no real channel to model it (D34).
function flippingCheck() {
  let verdict = { classification: 'unavailable', evidence: 'digest', source: 'test' };
  return {
    kind: 'media',
    blocking: true,
    async run() {
      return verdict;
    },
    resolveTo(nextVerdict) {
      verdict = { evidence: 'digest', source: 'test', ...nextVerdict };
    },
  };
}

const ALLOW_POLICY = {
  decide(verdict) {
    if (verdict.classification === 'no-known-match') return 'allow';
    if (verdict.classification === 'unavailable') return 'hold';
    return 'refuse';
  },
};

let tmpDir;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hold-registry-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('evaluate', () => {
  it('returns allow once every blocking check clears', async () => {
    const result = await evaluate([ALLOW_CHECK], ALLOW_POLICY, Buffer.from('x'));
    expect(result.decision).toBe('allow');
  });

  it('returns the first non-allow decision without running later checks', async () => {
    let ranSecond = false;
    const second = {
      kind: 'media',
      blocking: true,
      async run() {
        ranSecond = true;
        return { classification: 'no-known-match', evidence: 'y', source: 'test' };
      },
    };
    const result = await evaluate([refuseCheck(), second], ALLOW_POLICY, Buffer.from('x'));
    expect(result.decision).toBe('refuse');
    expect(ranSecond).toBe(false);
  });
});

describe('HoldRegistry', () => {
  function buildRegistry(checks) {
    return new HoldRegistry({
      checks,
      policy: ALLOW_POLICY,
      quarantinePath: path.join(tmpDir, 'quarantine'),
      retryIntervalMs: RETRY_MS,
    });
  }

  it('quarantines the bytes by digest as soon as it is held, exactly as a refusal does', async () => {
    const registry = buildRegistry([unavailableCheck()]);
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url',
      onAllow: async () => {},
      onRefuse: async () => {},
    });
    const quarantined = await fs.readFile(path.join(tmpDir, 'quarantine', 'digest'));
    expect(quarantined.toString()).toBe('bytes');
  });

  it('masks the url/path keys immediately, before any retry has run', async () => {
    const registry = buildRegistry([unavailableCheck()]);
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url',
      pathKey: 'path',
      onAllow: async () => {},
      onRefuse: async () => {},
    });
    expect(registry.isHeldUrl('url')).toBe(true);
    expect(registry.isHeldPath('path')).toBe(true);
  });

  it('a held item that keeps failing to get a verdict is never unmasked', async () => {
    const registry = buildRegistry([unavailableCheck()]);
    const onAllow = vi.fn();
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url',
      onAllow,
      onRefuse: vi.fn(),
    });

    await settle(RETRY_MS * 5);

    expect(onAllow).not.toHaveBeenCalled();
    expect(registry.isHeldUrl('url')).toBe(true);
    registry.stopAll();
  });

  it('promotes on a later allow: calls onAllow, then unmasks', async () => {
    // The check re-runs on every retry; flip it to allow to simulate "a
    // clean verdict arrives later" with no real channel to model.
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    const onAllow = vi.fn(async () => {});
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url',
      onAllow,
      onRefuse: vi.fn(),
    });

    check.resolveTo({ classification: 'no-known-match' });
    await settle();

    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(registry.isHeldUrl('url')).toBe(false);
  });

  it('a later refuse calls onRefuse but never unmasks -- a held object that clears to a match stays hidden', async () => {
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    const onRefuse = vi.fn(async () => {});
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url',
      onAllow: vi.fn(),
      onRefuse,
    });

    check.resolveTo({ classification: 'harmful-abusive-material', matchType: 'exact' });
    await settle();

    expect(onRefuse).toHaveBeenCalledTimes(1);
    expect(registry.isHeldUrl('url')).toBe(true);
  });

  it('deletes the quarantine copy once promoted', async () => {
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url',
      onAllow: async () => {},
      onRefuse: vi.fn(),
    });

    check.resolveTo({ classification: 'no-known-match' });
    await settle();

    await expect(fs.readFile(path.join(tmpDir, 'quarantine', 'digest'))).rejects.toThrow();
  });

  it('the same digest held twice before either resolves shares one retry loop and unmasks both on promotion', async () => {
    // A real case, not a contrived one: an unresized derivative save can
    // re-hash to the exact bytes of a still-unverified original (measured
    // against a real Ghost 6.55.0 with resize disabled).
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    const firstOnAllow = vi.fn(async () => {});
    const secondOnAllow = vi.fn(async () => {});

    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url-1',
      pathKey: 'path-1',
      onAllow: firstOnAllow,
      onRefuse: vi.fn(),
    });
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url-2',
      pathKey: 'path-2',
      onAllow: secondOnAllow,
      onRefuse: vi.fn(),
    });

    expect(registry.isHeldUrl('url-1')).toBe(true);
    expect(registry.isHeldUrl('url-2')).toBe(true);

    check.resolveTo({ classification: 'no-known-match' });
    await settle();

    expect(firstOnAllow).toHaveBeenCalledTimes(1);
    expect(secondOnAllow).toHaveBeenCalledTimes(1);
    expect(registry.isHeldUrl('url-1')).toBe(false);
    expect(registry.isHeldUrl('url-2')).toBe(false);
  });

  it('a path key is matched with a leading slash stripped, on either side', async () => {
    const registry = buildRegistry([unavailableCheck()]);
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url',
      pathKey: '2026/09/held.png',
      onAllow: vi.fn(),
      onRefuse: vi.fn(),
    });

    expect(registry.isHeldPath('/2026/09/held.png')).toBe(true);
    expect(registry.isHeldPath('2026/09/held.png')).toBe(true);
  });

  it('a retry whose onAllow throws is rescheduled rather than crashing the process', async () => {
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    let attempts = 0;
    const onAllow = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('simulated promotion failure');
      }
    });
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url',
      onAllow,
      onRefuse: vi.fn(),
    });

    check.resolveTo({ classification: 'no-known-match' });
    await settle();

    expect(onAllow.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(registry.isHeldUrl('url')).toBe(false);
  });

  it('keeps the quarantine copy of a digest that resolves to a later refuse', async () => {
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    await registry.hold('digest', Buffer.from('bytes'), {
      urlKey: 'url',
      onAllow: vi.fn(),
      onRefuse: async () => {},
    });

    check.resolveTo({ classification: 'harmful-abusive-material', matchType: 'exact' });
    await settle();

    const quarantined = await fs.readFile(path.join(tmpDir, 'quarantine', 'digest'));
    expect(quarantined.toString()).toBe('bytes');
  });
});
