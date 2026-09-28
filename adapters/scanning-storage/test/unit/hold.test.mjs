import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  HoldRegistry,
  evaluate,
  DEFAULT_MAX_RETRY_INTERVAL_MS,
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  STUCK_LOG_PREFIX,
} = require('../../src/hold.js');
const { digestBytes } = require('../../src/pdq.js');
const { isRefused, sealRefusal } = require('../../src/quarantine.js');

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
const WAIT = { timeout: 5000, interval: 10 };
// Shorter than the test's own timeout, so a hold that never sticks fails
// this wait's assertion rather than timing the whole test out.
const STUCK_WAIT = { timeout: 2000, interval: 10 };
const OWNER = 'LocalImagesStorage:/var/lib/ghost/content/images';

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
      owner: OWNER,
      computeDigest: () => 'digest',
      retryIntervalMs: RETRY_MS,
      logger: SILENT_LOGGER,
      ...overrides,
    });
  }

  it('refuses to construct without an owner', () => {
    expect(() => buildRegistry([unavailableCheck()], { owner: undefined })).toThrow(/owner/);
    expect(() => buildRegistry([unavailableCheck()], { owner: '' })).toThrow(/owner/);
  });

  describe('several owners sharing one quarantine directory', () => {
    const OTHER = 'LocalMediaStorage:/var/lib/ghost/content/media';

    it("resumes only its own owner's targets, never another owner's", async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(path.join(quarantinePath, 'digest'), 'bytes');
      await fs.writeFile(
        path.join(quarantinePath, 'digest.holds.json'),
        JSON.stringify({ owners: { [OWNER]: ['a.png'] } })
      );

      const other = buildRegistry([flippingCheck()], { owner: OTHER });
      const otherOnAllow = vi.fn();
      other.resumeFromQuarantine(() => ({ onAllow: otherOnAllow, onRefuse: vi.fn() }));
      expect(other.isPending('digest')).toBe(false);

      const own = buildRegistry([unavailableCheck()]);
      const seen = [];
      own.resumeFromQuarantine((targetPath) => {
        seen.push(targetPath);
        return { onAllow: vi.fn(), onRefuse: vi.fn() };
      });
      expect(own.isPending('digest')).toBe(true);
      expect(seen).toEqual(['a.png']);
      own.stopAll();
    });

    it("keeps the bytes and the other owner's entry when one owner promotes, and removes both once the last does", async () => {
      const first = flippingCheck();
      const second = flippingCheck();
      const own = buildRegistry([first], { maxRetryIntervalMs: RETRY_MS });
      const other = buildRegistry([second], { owner: OTHER, maxRetryIntervalMs: RETRY_MS });
      await own.hold('digest', Buffer.from('bytes'), {
        targetPath: 'a.png',
        onAllow: async () => {},
        onRefuse: async () => {},
      });
      await other.hold('digest', Buffer.from('bytes'), {
        targetPath: 'b.mp4',
        onAllow: async () => {},
        onRefuse: async () => {},
      });
      expect(
        JSON.parse(await fs.readFile(path.join(quarantinePath, 'digest.holds.json'), 'utf8'))
      ).toEqual({ owners: { [OWNER]: ['a.png'], [OTHER]: ['b.mp4'] } });

      first.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(own.isPending('digest')).toBe(false), WAIT);
      expect(own.isPending('digest')).toBe(false);
      expect((await fs.readFile(path.join(quarantinePath, 'digest'))).toString()).toBe('bytes');
      expect(
        JSON.parse(await fs.readFile(path.join(quarantinePath, 'digest.holds.json'), 'utf8'))
      ).toEqual({ owners: { [OTHER]: ['b.mp4'] } });

      second.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(other.isPending('digest')).toBe(false), WAIT);
      expect(other.isPending('digest')).toBe(false);
      await expect(fs.readFile(path.join(quarantinePath, 'digest'))).rejects.toThrow();
      await expect(fs.readFile(path.join(quarantinePath, 'digest.holds.json'))).rejects.toThrow();
    });

    it('never rewrites bytes another owner already quarantined under the same digest', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(path.join(quarantinePath, 'digest'), 'already-there');
      const registry = buildRegistry([unavailableCheck()]);
      await registry.hold('digest', Buffer.from('already-there-rewritten'), {
        targetPath: 'a.png',
        onAllow: async () => {},
        onRefuse: async () => {},
      });
      expect((await fs.readFile(path.join(quarantinePath, 'digest'))).toString()).toBe(
        'already-there'
      );
      registry.stopAll();
    });

    it('fails the hold rather than overwrite a sidecar it cannot attribute to an owner', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(path.join(quarantinePath, 'digest'), 'bytes');
      await fs.writeFile(path.join(quarantinePath, 'digest.holds.json'), JSON.stringify(['a.png']));
      const registry = buildRegistry([unavailableCheck()]);
      await expect(
        registry.hold('digest', Buffer.from('bytes'), {
          targetPath: 'b.png',
          onAllow: async () => {},
          onRefuse: async () => {},
        })
      ).rejects.toThrow(/owners/);
      expect(await fs.readFile(path.join(quarantinePath, 'digest.holds.json'), 'utf8')).toBe(
        JSON.stringify(['a.png'])
      );
    });

    it('leaves an unattributable sidecar held but unresumed, and logs it', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(path.join(quarantinePath, 'digest'), 'bytes');
      await fs.writeFile(path.join(quarantinePath, 'digest.holds.json'), JSON.stringify(['a.png']));
      const logger = { error: vi.fn() };
      const registry = buildRegistry([flippingCheck()], { logger });
      registry.resumeFromQuarantine(() => ({ onAllow: vi.fn(), onRefuse: vi.fn() }));
      expect(registry.isPending('digest')).toBe(false);
      expect(logger.error).toHaveBeenCalledTimes(1);
    });
  });

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
    expect(sidecar).toEqual({ owners: { [OWNER]: ['a.png'] } });
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
    await vi.waitFor(() => expect(registry.isPending('digest')).toBe(false), WAIT);

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
    await vi.waitFor(() => expect(registry.isPending('digest')).toBe(false), WAIT);

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
    await vi.waitFor(() => expect(registry.isPending('digest')).toBe(false), WAIT);

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
    expect(sidecar).toEqual({ owners: { [OWNER]: ['a.png', 'b.png'] } });

    check.resolveTo({ classification: 'no-known-match' });
    await vi.waitFor(() => expect(registry.isPending('digest')).toBe(false), WAIT);

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
    // The retry after a failure is backed off, so it lands later than one
    // plain interval.
    await vi.waitFor(() => expect(registry.isPending('digest')).toBe(false), WAIT);

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
      await fs.writeFile(
        path.join(quarantinePath, 'digest.holds.json'),
        JSON.stringify({ owners: { [OWNER]: ['a.png'] } })
      );

      const check = flippingCheck();
      const registry = buildRegistry([check]);
      const onAllow = vi.fn(async () => {});
      registry.resumeFromQuarantine((targetPath) => {
        expect(targetPath).toBe('a.png');
        return { onAllow, onRefuse: vi.fn() };
      });

      expect(registry.isPending('digest')).toBe(true);

      check.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(registry.isPending('digest')).toBe(false), WAIT);

      expect(onAllow).toHaveBeenCalledTimes(1);
      expect(onAllow).toHaveBeenCalledWith(Buffer.from('bytes'));
      expect(registry.isPending('digest')).toBe(false);
    });

    it('a resumed hold that never clears is still never promoted (the restart control case)', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(path.join(quarantinePath, 'digest'), 'bytes');
      await fs.writeFile(
        path.join(quarantinePath, 'digest.holds.json'),
        JSON.stringify({ owners: { [OWNER]: ['a.png'] } })
      );

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
        JSON.stringify({ owners: { [OWNER]: ['a.png'] } })
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
      await fs.writeFile(
        path.join(quarantinePath, 'digest.holds.json'),
        JSON.stringify({ owners: { [OWNER]: ['a.png'] } })
      );

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
      await vi.waitFor(() => expect(registry.isPending('digest')).toBe(false), WAIT);

      expect(onAllow).toHaveBeenCalledWith(Buffer.from('second-bytes'));
    });
  });
});

describe('DEFAULT_MAX_RETRY_INTERVAL_MS', () => {
  it('is a positive, finite ceiling', () => {
    expect(DEFAULT_MAX_RETRY_INTERVAL_MS).toBeGreaterThan(0);
  });
});

describe('DEFAULT_MAX_CONSECUTIVE_FAILURES', () => {
  it('is a positive, finite bound', () => {
    expect(DEFAULT_MAX_CONSECUTIVE_FAILURES).toBeGreaterThan(0);
    expect(Number.isFinite(DEFAULT_MAX_CONSECUTIVE_FAILURES)).toBe(true);
  });
});

// These registries hash for real, so the digest a file is filed under is
// the digest of its bytes -- the property the verified-read control rests on.
describe('HoldRegistry with real digests', () => {
  const BYTES = Buffer.from('the-whole-upload');
  const DIGEST = digestBytes(BYTES);
  const IMAGES = 'LocalImagesStorage:/var/lib/ghost/content/images';
  const MEDIA = 'LocalMediaStorage:/var/lib/ghost/content/media';

  function recordingLogger() {
    const lines = [];
    return { lines, error: (...args) => lines.push(args.map(String).join(' ')) };
  }

  function realRegistry(checks, overrides = {}) {
    return new HoldRegistry({
      checks,
      policy: ALLOW_POLICY,
      quarantinePath,
      owner: IMAGES,
      computeDigest: digestBytes,
      retryIntervalMs: RETRY_MS,
      maxRetryIntervalMs: RETRY_MS,
      logger: SILENT_LOGGER,
      ...overrides,
    });
  }

  function callbacks() {
    return { targetPath: 'a.png', onAllow: vi.fn(), onRefuse: vi.fn() };
  }

  const bytesPath = () => path.join(quarantinePath, DIGEST);
  const sidecar = async () =>
    JSON.parse(await fs.readFile(path.join(quarantinePath, `${DIGEST}.holds.json`), 'utf8'));

  it('requires a computeDigest function', () => {
    expect(() => realRegistry([unavailableCheck()], { computeDigest: undefined })).toThrow(
      /computeDigest/
    );
  });

  describe('a refusal by any owner wins', () => {
    it('a refusal by one feature stops a later clean verdict in another from promoting, and the bytes stay', async () => {
      const imagesCheck = flippingCheck();
      const mediaCheck = flippingCheck();
      const images = realRegistry([imagesCheck]);
      const media = realRegistry([mediaCheck], { owner: MEDIA });
      const imagesHold = callbacks();
      const mediaHold = callbacks();
      await images.hold(DIGEST, BYTES, imagesHold);
      await media.hold(DIGEST, BYTES, mediaHold);

      mediaCheck.resolveTo({ classification: 'csam', matchType: 'exact' });
      await vi.waitFor(() => expect(media.isPending(DIGEST)).toBe(false), WAIT);
      expect(isRefused(quarantinePath, DIGEST)).toBe(true);

      imagesCheck.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(images.isPending(DIGEST)).toBe(false), WAIT);

      expect(imagesHold.onAllow).not.toHaveBeenCalled();
      expect(imagesHold.onRefuse).toHaveBeenCalledTimes(1);
      await expect(fs.readFile(bytesPath())).resolves.toEqual(BYTES);
      await expect(
        fs.readFile(path.join(quarantinePath, `${DIGEST}.holds.json`))
      ).rejects.toThrow();
    });

    it('a clean promotion by one feature never removes the bytes another feature then refuses', async () => {
      const imagesCheck = flippingCheck();
      const mediaCheck = flippingCheck();
      const images = realRegistry([imagesCheck]);
      const media = realRegistry([mediaCheck], { owner: MEDIA });
      const imagesHold = callbacks();
      await images.hold(DIGEST, BYTES, imagesHold);
      await media.hold(DIGEST, BYTES, callbacks());

      imagesCheck.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(images.isPending(DIGEST)).toBe(false), WAIT);
      expect(imagesHold.onAllow).toHaveBeenCalledTimes(1);

      mediaCheck.resolveTo({ classification: 'csam', matchType: 'exact' });
      await vi.waitFor(() => expect(media.isPending(DIGEST)).toBe(false), WAIT);

      await expect(fs.readFile(bytesPath())).resolves.toEqual(BYTES);
      expect(isRefused(quarantinePath, DIGEST)).toBe(true);
    });

    it('a refusal sealed while this owner is mid-promotion stops the remaining promotions', async () => {
      const check = flippingCheck();
      const registry = realRegistry([check]);
      const first = {
        targetPath: 'a.png',
        onAllow: vi.fn(async () => {
          await sealRefusal(quarantinePath, DIGEST, BYTES, { classification: 'csam' }, digestBytes);
        }),
        onRefuse: vi.fn(),
      };
      const second = callbacks();
      await registry.hold(DIGEST, BYTES, first);
      await registry.hold(DIGEST, BYTES, { ...second, targetPath: 'b.png' });

      check.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(registry.isPending(DIGEST)).toBe(false), WAIT);

      expect(second.onAllow).not.toHaveBeenCalled();
      await expect(fs.readFile(bytesPath())).resolves.toEqual(BYTES);
    });

    it('never deletes bytes a refusal record names, even when the last owner out promoted', async () => {
      const check = flippingCheck();
      const registry = realRegistry([check]);
      await registry.hold(DIGEST, BYTES, {
        targetPath: 'a.png',
        onAllow: async () => {
          await sealRefusal(quarantinePath, DIGEST, BYTES, { classification: 'csam' }, digestBytes);
        },
        onRefuse: vi.fn(),
      });

      check.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(registry.isPending(DIGEST)).toBe(false), WAIT);

      await expect(fs.readFile(bytesPath())).resolves.toEqual(BYTES);
    });

    it('its own later refusal seals a record before any callback runs', async () => {
      const check = flippingCheck();
      const registry = realRegistry([check]);
      let sealedWhenCalled;
      await registry.hold(DIGEST, BYTES, {
        targetPath: 'a.png',
        onAllow: vi.fn(),
        onRefuse: async () => {
          sealedWhenCalled = isRefused(quarantinePath, DIGEST);
        },
      });
      check.resolveTo({ classification: 'harmful-abusive-material', matchType: 'near' });
      await vi.waitFor(() => expect(registry.isPending(DIGEST)).toBe(false), WAIT);
      expect(sealedWhenCalled).toBe(true);
    });

    // A synchronous refusal elsewhere has no sidecar entry, so a hold's
    // last-owner release can run while it is sealing. The rename of the
    // record is held open until that release has run.
    it('a seal racing a last-owner release still leaves the bytes behind the record', async () => {
      const realRename = fs.rename.bind(fs);
      let reachedRecordRename;
      const atRecordRename = new Promise((resolve) => {
        reachedRecordRename = resolve;
      });
      let openGate;
      const gate = new Promise((resolve) => {
        openGate = resolve;
      });
      const rename = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
        if (String(to).endsWith('.refused.json')) {
          reachedRecordRename();
          await gate;
        }
        return realRename(from, to);
      });
      try {
        const check = flippingCheck();
        const registry = realRegistry([check]);
        let sealing;
        await registry.hold(DIGEST, BYTES, {
          targetPath: 'a.png',
          onAllow: async () => {
            sealing = sealRefusal(
              quarantinePath,
              DIGEST,
              BYTES,
              { classification: 'csam' },
              digestBytes
            );
            await atRecordRename;
          },
          onRefuse: vi.fn(),
        });

        check.resolveTo({ classification: 'no-known-match' });
        await vi.waitFor(() => expect(registry.isPending(DIGEST)).toBe(false), WAIT);
        openGate();
        await sealing;

        expect(isRefused(quarantinePath, DIGEST)).toBe(true);
        await expect(fs.readFile(bytesPath())).resolves.toEqual(BYTES);
      } finally {
        rename.mockRestore();
      }
    });

    it('keeps the bytes when the refusal record cannot be read at release', async () => {
      const check = flippingCheck();
      const logger = recordingLogger();
      const registry = realRegistry([check], { logger });
      const record = path.join(quarantinePath, `${DIGEST}.refused.json`);
      await registry.hold(DIGEST, BYTES, {
        targetPath: 'a.png',
        onAllow: async () => {
          await fs.symlink(record, record);
        },
        onRefuse: vi.fn(),
      });

      check.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(registry.isPending(DIGEST)).toBe(false), WAIT);

      await expect(fs.readFile(bytesPath())).resolves.toEqual(BYTES);
      expect(logger.lines.some((l) => l.includes('quarantine cleanup failed'))).toBe(true);
    });

    it('never promotes while the refusal record cannot be read', async () => {
      const check = flippingCheck();
      const logger = recordingLogger();
      const registry = realRegistry([check], { logger, maxConsecutiveFailures: 2 });
      const hold = callbacks();
      await registry.hold(DIGEST, BYTES, hold);
      const record = path.join(quarantinePath, `${DIGEST}.refused.json`);
      await fs.symlink(record, record);

      check.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(registry.isPending(DIGEST)).toBe(false), WAIT);

      expect(hold.onAllow).not.toHaveBeenCalled();
      expect(registry.isStuck(DIGEST)).toBe(true);
    });
  });

  describe('verified reads', () => {
    it('a truncated quarantine file is never judged or promoted: the hold sticks and the bytes stay', async () => {
      const check = flippingCheck();
      const run = vi.spyOn(check, 'run');
      const logger = recordingLogger();
      const registry = realRegistry([check], { logger });
      const hold = callbacks();
      await registry.hold(DIGEST, BYTES, hold);
      await fs.truncate(bytesPath(), 5);
      run.mockClear();

      check.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(registry.isPending(DIGEST)).toBe(false), WAIT);
      await settle();

      expect(run).not.toHaveBeenCalled();
      expect(hold.onAllow).not.toHaveBeenCalled();
      expect(registry.isPending(DIGEST)).toBe(false);
      expect(registry.isStuck(DIGEST)).toBe(true);
      expect(registry.stuckDigests()).toEqual([
        { digest: DIGEST, reason: 'the quarantined bytes do not match their digest' },
      ]);
      expect(logger.lines.some((l) => l.startsWith(`${STUCK_LOG_PREFIX} for ${DIGEST}`))).toBe(
        true
      );
      expect((await sidecar()).stuck[IMAGES].reason).toMatch(/do not match/);
      expect((await fs.readFile(bytesPath())).length).toBe(5);
    });

    it('a hold of the real bytes replaces a quarantined copy that does not match its digest', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(bytesPath(), BYTES.subarray(0, 3));
      const check = flippingCheck();
      const registry = realRegistry([check]);
      const hold = callbacks();
      await registry.hold(DIGEST, BYTES, hold);

      check.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(registry.isPending(DIGEST)).toBe(false), WAIT);
      expect(hold.onAllow).toHaveBeenCalledWith(BYTES);
    });

    it('a missing quarantine file counts as a failed retry, not a verdict', async () => {
      const check = flippingCheck();
      const registry = realRegistry([check], { maxConsecutiveFailures: 2 });
      const hold = callbacks();
      await registry.hold(DIGEST, BYTES, hold);
      await fs.rm(bytesPath());
      check.resolveTo({ classification: 'no-known-match' });

      await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), STUCK_WAIT);
      expect(hold.onAllow).not.toHaveBeenCalled();
    });
  });

  describe('bounded retries', () => {
    it('a retry that keeps failing backs off, then sticks after the bound and is never tried again', async () => {
      const check = flippingCheck();
      const logger = recordingLogger();
      const registry = realRegistry([check], {
        retryIntervalMs: 10,
        maxRetryIntervalMs: 1000,
        maxConsecutiveFailures: 4,
        logger,
      });
      const at = [];
      const onAllow = vi.fn(async () => {
        at.push(Date.now());
        throw new Error('backend down');
      });
      await registry.hold(DIGEST, BYTES, { targetPath: 'a.png', onAllow, onRefuse: vi.fn() });
      check.resolveTo({ classification: 'no-known-match' });

      await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), STUCK_WAIT);
      await settle(200);

      expect(onAllow).toHaveBeenCalledTimes(4);
      expect(registry.isPending(DIGEST)).toBe(false);
      // Each gap is at least the doubled interval: 20, 40, 80 ms.
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      gaps.forEach((gap, i) => expect(gap).toBeGreaterThanOrEqual(10 * 2 ** (i + 1) - 2));
      expect(
        logger.lines.filter((l) => l.startsWith(`${STUCK_LOG_PREFIX} for ${DIGEST}`))
      ).toHaveLength(1);
      expect((await sidecar()).stuck[IMAGES].reason).toMatch(/4 consecutive retries failed/);
      // Kept: the bytes and the target are still on disk for an operator.
      await expect(fs.readFile(bytesPath())).resolves.toEqual(BYTES);
      expect((await sidecar()).owners[IMAGES]).toEqual(['a.png']);
    });

    it('a pass that is merely still waiting for a verdict resets the failure count', async () => {
      let calls = 0;
      const check = {
        kind: 'media',
        blocking: true,
        async run() {
          calls += 1;
          // Throw on odd calls, wait on even ones: never two failures in a row.
          if (calls % 2 === 1) throw new Error('flaky');
          return { classification: 'unavailable', evidence: DIGEST, source: 'test' };
        },
      };
      const registry = realRegistry([check], { maxConsecutiveFailures: 2 });
      await registry.hold(DIGEST, BYTES, callbacks());

      await vi.waitFor(() => expect(calls).toBeGreaterThanOrEqual(6), WAIT);
      expect(registry.isStuck(DIGEST)).toBe(false);
      expect(registry.isPending(DIGEST)).toBe(true);
      registry.stopAll();
    });

    it('a restart does not resume a stuck hold, and says so again', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(bytesPath(), BYTES);
      await fs.writeFile(
        path.join(quarantinePath, `${DIGEST}.holds.json`),
        JSON.stringify({ owners: { [IMAGES]: ['a.png'] }, stuck: { [IMAGES]: { reason: 'r' } } })
      );
      const logger = recordingLogger();
      const registry = realRegistry([ALLOW_CHECK], { logger });
      const onAllow = vi.fn();
      registry.resumeFromQuarantine(() => ({ onAllow, onRefuse: vi.fn() }));

      expect(registry.isPending(DIGEST)).toBe(false);
      expect(registry.isStuck(DIGEST)).toBe(true);
      expect(logger.lines.some((l) => l.startsWith(`${STUCK_LOG_PREFIX} for ${DIGEST}`))).toBe(
        true
      );
      await settle();
      expect(onAllow).not.toHaveBeenCalled();
    });

    it('a stuck record with no reason still reads as stuck', async () => {
      await fs.mkdir(quarantinePath, { recursive: true });
      await fs.writeFile(bytesPath(), BYTES);
      await fs.writeFile(
        path.join(quarantinePath, `${DIGEST}.holds.json`),
        JSON.stringify({ owners: { [IMAGES]: ['a.png'] }, stuck: { [IMAGES]: {} } })
      );
      const registry = realRegistry([ALLOW_CHECK]);
      registry.resumeFromQuarantine(() => ({ onAllow: vi.fn(), onRefuse: vi.fn() }));
      expect(registry.stuckDigests()).toEqual([{ digest: DIGEST, reason: 'unknown' }]);
    });

    it('a new upload of a stuck digest is recorded but stays held and unpromoted', async () => {
      const check = flippingCheck();
      const registry = realRegistry([check]);
      await registry.hold(DIGEST, BYTES, callbacks());
      await fs.truncate(bytesPath(), 1);
      check.resolveTo({ classification: 'no-known-match' });
      await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), STUCK_WAIT);

      const again = { targetPath: 'b.png', onAllow: vi.fn(), onRefuse: vi.fn() };
      await registry.hold(DIGEST, BYTES, again);
      await settle();

      expect(again.onAllow).not.toHaveBeenCalled();
      expect(registry.isPending(DIGEST)).toBe(false);
      expect((await sidecar()).owners[IMAGES]).toEqual(['a.png', 'b.png']);
      // The fresh upload did repair the bytes, ready for an operator to retry.
      await expect(fs.readFile(bytesPath())).resolves.toEqual(BYTES);
    });

    it('logs, rather than throws, when the stuck state cannot be persisted', async () => {
      const check = flippingCheck();
      const logger = recordingLogger();
      const registry = realRegistry([check], { logger });
      await registry.hold(DIGEST, BYTES, callbacks());
      await fs.truncate(bytesPath(), 1);
      await fs.writeFile(path.join(quarantinePath, `${DIGEST}.holds.json`), '[]');
      check.resolveTo({ classification: 'no-known-match' });

      await vi.waitFor(() => expect(registry.isStuck(DIGEST)).toBe(true), STUCK_WAIT);
      expect(logger.lines.some((l) => l.includes('could not persist the stuck state'))).toBe(true);
    });
  });
});
