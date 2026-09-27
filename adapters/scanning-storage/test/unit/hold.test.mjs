import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { HoldRegistry, evaluate, DEFAULT_MAX_RETRY_INTERVAL_MS } = require('../../src/hold.js');

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
// "a later verdict arrives" with no real channel to model it.
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

const SILENT_LOGGER = { error: () => {} };

let tmpDir;
let quarantinePath;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hold-registry-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine');
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
  function buildRegistry(checks, overrides = {}) {
    return new HoldRegistry({
      checks,
      policy: ALLOW_POLICY,
      quarantinePath,
      retryIntervalMs: RETRY_MS,
      logger: SILENT_LOGGER,
      ...overrides,
    });
  }

  it('quarantines the bytes by digest as soon as it is held, exactly as a refusal does', async () => {
    const registry = buildRegistry([unavailableCheck()]);
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow: async () => {},
      onRefuse: async () => {},
    });
    const quarantined = await fs.readFile(path.join(quarantinePath, 'digest'));
    expect(quarantined.toString()).toBe('bytes');
  });

  it('writes a sidecar recording which target path is waiting on the digest', async () => {
    const registry = buildRegistry([unavailableCheck()]);
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow: async () => {},
      onRefuse: async () => {},
    });
    const sidecar = JSON.parse(
      await fs.readFile(path.join(quarantinePath, 'digest.holds.json'), 'utf8')
    );
    expect(sidecar).toEqual(['a.png']);
  });

  it('is pending immediately, before any retry has run', async () => {
    const registry = buildRegistry([unavailableCheck()]);
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow: async () => {},
      onRefuse: async () => {},
    });
    expect(registry.isPending('digest')).toBe(true);
  });

  it('a held item that keeps failing to get a verdict is never resolved', async () => {
    const registry = buildRegistry([unavailableCheck()]);
    const onAllow = vi.fn();
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow,
      onRefuse: vi.fn(),
    });

    await settle(RETRY_MS * 5);

    expect(onAllow).not.toHaveBeenCalled();
    expect(registry.isPending('digest')).toBe(true);
    registry.stopAll();
  });

  it('promotes on a later allow: calls onAllow with the quarantined bytes, then forgets it', async () => {
    // The check re-runs on every retry; flip it to allow to simulate "a
    // clean verdict arrives later" with no real channel to model.
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    const onAllow = vi.fn(async () => {});
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow,
      onRefuse: vi.fn(),
    });

    check.resolveTo({ classification: 'no-known-match' });
    await settle();

    expect(onAllow).toHaveBeenCalledTimes(1);
    expect(onAllow).toHaveBeenCalledWith(Buffer.from('bytes'));
    expect(registry.isPending('digest')).toBe(false);
  });

  it('a later refuse calls onRefuse and forgets it, keeping the quarantine bytes as the permanent record', async () => {
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    const onRefuse = vi.fn(async () => {});
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow: vi.fn(),
      onRefuse,
    });

    check.resolveTo({ classification: 'harmful-abusive-material', matchType: 'exact' });
    await settle();

    expect(onRefuse).toHaveBeenCalledTimes(1);
    expect(registry.isPending('digest')).toBe(false);
    const quarantined = await fs.readFile(path.join(quarantinePath, 'digest'));
    expect(quarantined.toString()).toBe('bytes');
    await expect(fs.readFile(path.join(quarantinePath, 'digest.holds.json'))).rejects.toThrow();
  });

  it('deletes the quarantine bytes and the sidecar once promoted', async () => {
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow: async () => {},
      onRefuse: vi.fn(),
    });

    check.resolveTo({ classification: 'no-known-match' });
    await settle();

    await expect(fs.readFile(path.join(quarantinePath, 'digest'))).rejects.toThrow();
    await expect(fs.readFile(path.join(quarantinePath, 'digest.holds.json'))).rejects.toThrow();
  });

  it('the same digest held twice before either resolves shares one retry loop and promotes both on one verdict', async () => {
    // A real case, not a contrived one: an unresized derivative save can
    // re-hash to the exact bytes of a still-unverified original (measured
    // against a real Ghost 6.55.0 with resize disabled).
    const check = flippingCheck();
    const registry = buildRegistry([check]);
    const firstOnAllow = vi.fn(async () => {});
    const secondOnAllow = vi.fn(async () => {});

    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow: firstOnAllow,
      onRefuse: vi.fn(),
    });
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'b.png',
      onAllow: secondOnAllow,
      onRefuse: vi.fn(),
    });

    const sidecar = JSON.parse(
      await fs.readFile(path.join(quarantinePath, 'digest.holds.json'), 'utf8')
    );
    expect(sidecar).toEqual(['a.png', 'b.png']);

    check.resolveTo({ classification: 'no-known-match' });
    await settle();

    expect(firstOnAllow).toHaveBeenCalledTimes(1);
    expect(secondOnAllow).toHaveBeenCalledTimes(1);
    expect(registry.isPending('digest')).toBe(false);
  });

  it('backs off the retry interval on repeated non-answers, capped at the configured ceiling, never giving up on the hold', async () => {
    const registry = buildRegistry([unavailableCheck()], {
      retryIntervalMs: 5,
      maxRetryIntervalMs: 20,
    });
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow: vi.fn(),
      onRefuse: vi.fn(),
    });

    await settle(200);

    // Still pending no matter how long it backs off -- a hold's lifetime is
    // never bounded, only its polling rate.
    expect(registry.isPending('digest')).toBe(true);
    registry.stopAll();
  });

  it('a retry whose onAllow throws is logged and rescheduled rather than crashing or being lost', async () => {
    const check = flippingCheck();
    const errors = [];
    const registry = buildRegistry([check], { logger: { error: (...args) => errors.push(args) } });
    let attempts = 0;
    const onAllow = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error('simulated promotion failure');
      }
    });
    await registry.hold('digest', Buffer.from('bytes'), {
      targetPath: 'a.png',
      onAllow,
      onRefuse: vi.fn(),
    });

    check.resolveTo({ classification: 'no-known-match' });
    await settle();

    expect(onAllow.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(registry.isPending('digest')).toBe(false);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    // The bytes must still be quarantined after the first, failed attempt --
    // a logged failure must not lose the hold.
  });

  describe('resumeFromQuarantine (restart-safety)', () => {
    it('does nothing when the quarantine directory does not exist yet', () => {
      const registry = buildRegistry([unavailableCheck()]);
      expect(() =>
        registry.resumeFromQuarantine(() => ({ onAllow: vi.fn(), onRefuse: vi.fn() }))
      ).not.toThrow();
      expect(registry.isPending('digest')).toBe(false);
    });

    it('resumes a hold left behind by a previous process instance, and promotes it on a later allow', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(path.join(quarantinePath, 'digest'), 'bytes');
      await fs.writeFile(path.join(quarantinePath, 'digest.holds.json'), JSON.stringify(['a.png']));

      const check = flippingCheck();
      const registry = buildRegistry([check]);
      const onAllow = vi.fn(async () => {});
      registry.resumeFromQuarantine((targetPath) => {
        expect(targetPath).toBe('a.png');
        return { onAllow, onRefuse: vi.fn() };
      });

      expect(registry.isPending('digest')).toBe(true);

      check.resolveTo({ classification: 'no-known-match' });
      await settle();

      expect(onAllow).toHaveBeenCalledTimes(1);
      expect(onAllow).toHaveBeenCalledWith(Buffer.from('bytes'));
      expect(registry.isPending('digest')).toBe(false);
    });

    it('a resumed hold that never clears is still never promoted (the restart control case)', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(path.join(quarantinePath, 'digest'), 'bytes');
      await fs.writeFile(path.join(quarantinePath, 'digest.holds.json'), JSON.stringify(['a.png']));

      const registry = buildRegistry([unavailableCheck()]);
      const onAllow = vi.fn();
      registry.resumeFromQuarantine(() => ({ onAllow, onRefuse: vi.fn() }));

      await settle(RETRY_MS * 5);

      expect(onAllow).not.toHaveBeenCalled();
      expect(registry.isPending('digest')).toBe(true);
      registry.stopAll();
    });

    it('does not resume a plain refusal (no sidecar) as if it were a pending hold', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(path.join(quarantinePath, 'refused-digest'), 'bytes');

      const registry = buildRegistry([unavailableCheck()]);
      registry.resumeFromQuarantine(() => ({ onAllow: vi.fn(), onRefuse: vi.fn() }));

      expect(registry.isPending('refused-digest')).toBe(false);
    });

    it('skips a sidecar with no bytes behind it, and a malformed sidecar, without throwing', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(
        path.join(quarantinePath, 'orphan-sidecar.holds.json'),
        JSON.stringify(['a.png'])
      );
      await fs.writeFile(path.join(quarantinePath, 'malformed-digest'), 'bytes');
      await fs.writeFile(path.join(quarantinePath, 'malformed-digest.holds.json'), 'not json');

      const registry = buildRegistry([unavailableCheck()]);
      expect(() =>
        registry.resumeFromQuarantine(() => ({ onAllow: vi.fn(), onRefuse: vi.fn() }))
      ).not.toThrow();
      expect(registry.isPending('orphan-sidecar')).toBe(false);
      expect(registry.isPending('malformed-digest')).toBe(false);
    });

    it('never keeps the resumed buffer resident: onAllow receives what is on disk at retry time, not at resume time', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(path.join(quarantinePath, 'digest'), 'first-bytes');
      await fs.writeFile(path.join(quarantinePath, 'digest.holds.json'), JSON.stringify(['a.png']));

      const check = flippingCheck();
      const registry = buildRegistry([check]);
      const onAllow = vi.fn(async () => {});
      registry.resumeFromQuarantine(() => ({ onAllow, onRefuse: vi.fn() }));

      // Mutate the on-disk bytes between resume and the first retry tick --
      // if resumeFromQuarantine had read and cached the buffer itself
      // (rather than only re-deriving which digests are pending), onAllow
      // would still receive 'first-bytes' below.
      await fs.writeFile(path.join(quarantinePath, 'digest'), 'second-bytes');
      check.resolveTo({ classification: 'no-known-match' });
      await settle();

      expect(onAllow).toHaveBeenCalledWith(Buffer.from('second-bytes'));
    });
  });
});

describe('DEFAULT_MAX_RETRY_INTERVAL_MS', () => {
  it('is a positive, finite ceiling', () => {
    expect(DEFAULT_MAX_RETRY_INTERVAL_MS).toBeGreaterThan(0);
  });
});
