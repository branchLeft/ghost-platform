import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  HoldRegistry,
  DEFAULT_ORPHAN_MIN_AGE_MS,
  DEFAULT_ORPHAN_SWEEP_INTERVAL_MS,
} = require('../../src/hold.js');
const { digestBytes } = require('../../src/pdq.js');
const {
  quarantineBytes,
  sealRefusal,
  sweepOrphans,
  releaseBytes,
  writeFileAtomicSync,
  ORPHAN_LOG_PREFIX,
} = require('../../src/quarantine.js');

const OWNER = 'LocalImagesStorage:/var/lib/ghost/content/images';
const OTHER_OWNER = 'LocalMediaStorage:/var/lib/ghost/content/media';
const BYTES = Buffer.from('crashed-between-the-two-writes');
const DIGEST = digestBytes(BYTES);
const OLD_SECONDS = 60 * 60;
const MIN_AGE_MS = 1000;
const TICK_MS = 15;

let tmpDir;
let quarantinePath;
let registries;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orphan-sweep-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine');
  registries = [];
});

afterEach(async () => {
  for (const registry of registries) registry.stopAll();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function recordingLogger() {
  return {
    lines: [],
    error(...args) {
      this.lines.push(args.map(String).join(' '));
    },
  };
}

function buildRegistry(overrides = {}) {
  const registry = new HoldRegistry({
    checks: [],
    policy: { decide: () => 'hold' },
    quarantinePath,
    owner: OWNER,
    computeDigest: digestBytes,
    retryIntervalMs: 60_000,
    logger: recordingLogger(),
    ...overrides,
  });
  registries.push(registry);
  return registry;
}

function resume(registry) {
  registry.resumeFromQuarantine(() => ({ onAllow: vi.fn(), onRefuse: vi.fn() }));
}

async function ageFile(file, seconds = OLD_SECONDS) {
  const then = new Date(Date.now() - seconds * 1000);
  await fs.utimes(file, then, then);
}

async function writeOrphan(bytes = BYTES) {
  const digest = digestBytes(bytes);
  await quarantineBytes(quarantinePath, digest, bytes);
  await ageFile(path.join(quarantinePath, digest));
  return digest;
}

const sweep = (overrides = {}) =>
  sweepOrphans(quarantinePath, {
    minAgeMs: MIN_AGE_MS,
    logger: recordingLogger(),
    ...overrides,
  });

const listing = async () => (await fs.readdir(quarantinePath)).sort();

describe('orphaned quarantine bytes at start-up', () => {
  it('removes aged bytes that have no sidecar and no refusal record, and logs the digest', async () => {
    const digest = await writeOrphan();

    const logger = recordingLogger();
    resume(buildRegistry({ logger }));

    expect(await listing()).toEqual([]);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain(ORPHAN_LOG_PREFIX);
    expect(logger.lines[0]).toContain(digest);
  });

  it('leaves bytes younger than the minimum age alone and logs nothing', async () => {
    await quarantineBytes(quarantinePath, DIGEST, BYTES);

    const logger = recordingLogger();
    resume(buildRegistry({ logger }));

    expect(await listing()).toEqual([DIGEST]);
    expect(logger.lines).toEqual([]);
  });

  it('keeps bytes exactly at the minimum age, and removes them one millisecond later', async () => {
    await quarantineBytes(quarantinePath, DIGEST, BYTES);
    const writtenAtMs = fsSync.statSync(path.join(quarantinePath, DIGEST)).mtimeMs;

    expect(sweep({ now: () => writtenAtMs + MIN_AGE_MS })).toBe(0);
    expect(await listing()).toEqual([DIGEST]);

    expect(sweep({ now: () => writtenAtMs + MIN_AGE_MS + 1 })).toBe(1);
    expect(await listing()).toEqual([]);
  });

  it('leaves the bytes and the record of a sealed refusal untouched, however old', async () => {
    await sealRefusal(quarantinePath, DIGEST, BYTES, { classification: 'csam' }, digestBytes);
    const record = path.join(quarantinePath, `${DIGEST}.refused.json`);
    await ageFile(path.join(quarantinePath, DIGEST));
    await ageFile(record);
    const recordBefore = await fs.readFile(record);

    const logger = recordingLogger();
    resume(buildRegistry({ logger }));

    expect(await listing()).toEqual([DIGEST, `${DIGEST}.refused.json`].sort());
    await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
    await expect(fs.readFile(record)).resolves.toEqual(recordBefore);
    expect(logger.lines).toEqual([]);
  });

  it("leaves bytes alone while another owner's sidecar names them", async () => {
    await quarantineBytes(quarantinePath, DIGEST, BYTES);
    await ageFile(path.join(quarantinePath, DIGEST));
    await fs.writeFile(
      path.join(quarantinePath, `${DIGEST}.holds.json`),
      JSON.stringify({ owners: { [OTHER_OWNER]: ['a.png'] } })
    );

    const logger = recordingLogger();
    resume(buildRegistry({ logger }));

    expect(await listing()).toEqual([DIGEST, `${DIGEST}.holds.json`].sort());
    expect(logger.lines).toEqual([]);
  });

  it('leaves bytes alone behind a sidecar nobody can parse, and the restart still reports the sidecar', async () => {
    await quarantineBytes(quarantinePath, DIGEST, BYTES);
    await ageFile(path.join(quarantinePath, DIGEST));
    await fs.writeFile(path.join(quarantinePath, `${DIGEST}.holds.json`), 'not json');

    const logger = recordingLogger();
    resume(buildRegistry({ logger }));

    expect(await listing()).toEqual([DIGEST, `${DIGEST}.holds.json`].sort());
    expect(logger.lines.some((line) => line.includes('could not read the hold sidecar'))).toBe(
      true
    );
  });

  it('keeps the bytes and logs when the refusal record cannot be stat-ed', async () => {
    await writeOrphan();
    const record = path.join(quarantinePath, `${DIGEST}.refused.json`);
    await fs.symlink(record, record);

    const logger = recordingLogger();
    resume(buildRegistry({ logger }));

    expect(await listing()).toEqual([DIGEST, `${DIGEST}.refused.json`].sort());
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain('could not sweep orphan candidate');
    expect(logger.lines[0]).toContain('ELOOP');
  });

  it('keeps the bytes and logs when the sidecar cannot be stat-ed', async () => {
    await writeOrphan();
    const sidecar = path.join(quarantinePath, `${DIGEST}.holds.json`);
    await fs.symlink(sidecar, sidecar);

    const logger = recordingLogger();
    expect(sweep({ logger })).toBe(0);

    expect(await listing()).toContain(DIGEST);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain('ELOOP');
  });

  it('logs rather than throws when the quarantine path is not a directory', async () => {
    await fs.writeFile(quarantinePath, 'a file, not a directory');

    const logger = recordingLogger();
    expect(() => resume(buildRegistry({ logger }))).not.toThrow();

    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain('orphan sweep failed');
    expect(logger.lines[0]).toContain('ENOTDIR');
  });
});

describe('sweepOrphans', () => {
  it('does nothing when the quarantine directory does not exist yet', () => {
    expect(sweep()).toBe(0);
  });

  it('skips bytes that vanish between the directory listing and the age check', async () => {
    await writeOrphan();
    const logger = recordingLogger();

    const removed = sweep({
      logger,
      // Called once, after the directory is listed and before any file is examined.
      now: () => {
        fsSync.rmSync(path.join(quarantinePath, DIGEST));
        return Date.now();
      },
    });

    expect(removed).toBe(0);
    expect(logger.lines).toEqual([]);
  });

  it('puts the bytes back when a sidecar lands after they were moved aside', async () => {
    await writeOrphan();
    const logger = recordingLogger();

    const removed = sweep({
      logger,
      onMovedAside: () =>
        writeFileAtomicSync(path.join(quarantinePath, `${DIGEST}.holds.json`), '{"owners":{}}'),
    });

    expect(removed).toBe(0);
    expect(await listing()).toEqual([DIGEST, `${DIGEST}.holds.json`].sort());
    await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
    expect(logger.lines).toEqual([]);
  });

  it('puts the bytes back when a refusal record lands after they were moved aside', async () => {
    await writeOrphan();

    const removed = sweep({
      onMovedAside: () =>
        writeFileAtomicSync(path.join(quarantinePath, `${DIGEST}.refused.json`), '{}'),
    });

    expect(removed).toBe(0);
    expect(await listing()).toEqual([DIGEST, `${DIGEST}.refused.json`].sort());
  });

  it('puts the bytes back and logs when the sidecar cannot be checked after the move aside', async () => {
    await writeOrphan();
    const sidecar = path.join(quarantinePath, `${DIGEST}.holds.json`);
    const logger = recordingLogger();

    const removed = sweep({ logger, onMovedAside: () => fsSync.symlinkSync(sidecar, sidecar) });

    expect(removed).toBe(0);
    await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain('left in place');
  });

  it('never treats anything but plain bytes as an orphan', async () => {
    await fs.mkdir(quarantinePath, { recursive: true });
    const outside = path.join(tmpDir, 'outside');
    await fs.writeFile(outside, 'not quarantine bytes');
    const entries = {
      [`${DIGEST}.releasing.1.abc`]: () =>
        fs.writeFile(path.join(quarantinePath, `${DIGEST}.releasing.1.abc`), BYTES),
      'other.holds.json': (file) => fs.writeFile(file, '{}'),
      'other.refused.json': (file) => fs.writeFile(file, '{}'),
      '.other.1.abc.tmp': (file) => fs.writeFile(file, 'half written'),
      'a-directory': (file) => fs.mkdir(file),
      'a-link': (file) => fs.symlink(outside, file),
      'a-dangling-link': (file) => fs.symlink(path.join(tmpDir, 'missing'), file),
    };
    for (const [name, create] of Object.entries(entries)) {
      const file = path.join(quarantinePath, name);
      await create(file);
      const then = new Date(Date.now() - OLD_SECONDS * 1000);
      await fs.lutimes(file, then, then);
    }
    const before = await listing();
    const logger = recordingLogger();

    expect(sweep({ logger })).toBe(0);

    expect(await listing()).toEqual(before);
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('not quarantine bytes');
    expect(logger.lines).toEqual([]);
  });

  it('classifies by name and type alone, so a digest of any shape or length is handled', async () => {
    await fs.mkdir(quarantinePath, { recursive: true });
    const names = ['0', 'a'.repeat(200), 'shape-that-is-not-hex_v2'];
    for (const name of names) {
      await fs.writeFile(path.join(quarantinePath, name), 'bytes');
      await ageFile(path.join(quarantinePath, name));
    }

    expect(sweep()).toBe(names.length);
    expect(await listing()).toEqual([]);
  });

  it('two sweeps over one directory remove an orphan once and neither fails', async () => {
    await writeOrphan();
    const first = recordingLogger();
    const second = recordingLogger();

    const removedByFirst = sweep({ logger: first });
    const removedBySecond = sweep({ logger: second });

    expect(removedByFirst + removedBySecond).toBe(1);
    expect(first.lines).toHaveLength(1);
    expect(second.lines).toEqual([]);
  });

  it('a second sweep that starts while the first has the bytes moved aside removes nothing and fails nothing', async () => {
    await writeOrphan();
    const first = recordingLogger();
    const second = recordingLogger();
    let removedByNested;

    const removedByFirst = sweep({
      logger: first,
      onMovedAside: () => {
        removedByNested = sweep({ logger: second });
      },
    });

    expect(removedByNested).toBe(0);
    expect(removedByFirst).toBe(1);
    expect(second.lines).toEqual([]);
    expect(await listing()).toEqual([]);
  });

  it('two registries sharing one directory remove an orphan once and neither fails', async () => {
    await writeOrphan();
    const first = recordingLogger();
    const second = recordingLogger();

    resume(buildRegistry({ logger: first }));
    resume(buildRegistry({ logger: second, owner: OTHER_OWNER }));

    expect(await listing()).toEqual([]);
    expect(first.lines).toHaveLength(1);
    expect(second.lines).toEqual([]);
  });
});

describe('releaseBytes without the orphan check', () => {
  it('still removes bytes whose hold sidecar is present, as a finished hold needs', async () => {
    await quarantineBytes(quarantinePath, DIGEST, BYTES);
    await fs.writeFile(path.join(quarantinePath, `${DIGEST}.holds.json`), '{"owners":{}}');

    expect(releaseBytes(quarantinePath, DIGEST)).toBe(true);
    expect(await listing()).toEqual([`${DIGEST}.holds.json`]);
  });
});

describe('the periodic orphan sweep', () => {
  it('removes an orphan that aged past the threshold after start-up', async () => {
    await fs.mkdir(quarantinePath, { recursive: true });
    const logger = recordingLogger();
    resume(buildRegistry({ logger, orphanSweepIntervalMs: TICK_MS }));
    expect(logger.lines).toEqual([]);

    await writeOrphan();

    await vi.waitFor(
      () => expect(fsSync.existsSync(path.join(quarantinePath, DIGEST))).toBe(false),
      {
        timeout: 2000,
        interval: 5,
      }
    );
    expect(logger.lines).toHaveLength(1);
    expect(logger.lines[0]).toContain(ORPHAN_LOG_PREFIX);
  });

  it('runs on an unref-ed timer that stopAll ends', async () => {
    const registry = buildRegistry({ orphanSweepIntervalMs: TICK_MS });
    resume(registry);

    expect(registry.orphanSweepTimer.hasRef()).toBe(false);

    registry.stopAll();
    await writeOrphan();
    await new Promise((resolve) => setTimeout(resolve, TICK_MS * 6));

    expect(await listing()).toEqual([DIGEST]);
    expect(registry.orphanSweepTimer).toBeNull();
  });

  it('starts one timer however often it resumes', () => {
    const registry = buildRegistry();
    resume(registry);
    const first = registry.orphanSweepTimer;

    resume(registry);

    expect(registry.orphanSweepTimer).toBe(first);
  });

  it('logs a failed sweep from the timer and keeps going, without throwing', async () => {
    await fs.mkdir(quarantinePath, { recursive: true });
    const logger = recordingLogger();
    resume(buildRegistry({ logger, orphanSweepIntervalMs: TICK_MS }));
    await fs.rm(quarantinePath, { recursive: true });
    await fs.writeFile(quarantinePath, 'a file, not a directory');

    await vi.waitFor(() => expect(logger.lines.length).toBeGreaterThanOrEqual(2), {
      timeout: 2000,
      interval: 5,
    });
    expect(logger.lines.every((line) => line.includes('orphan sweep failed'))).toBe(true);
  });

  it('uses the injected clock for the age check', async () => {
    await quarantineBytes(quarantinePath, DIGEST, BYTES);
    const farFuture = Date.now() + 2 * DEFAULT_ORPHAN_MIN_AGE_MS;

    resume(buildRegistry({ now: () => farFuture }));

    expect(await listing()).toEqual([]);
  });
});

describe('the orphan sweep settings', () => {
  it('default to ten minutes of age and a five-minute interval', () => {
    const registry = buildRegistry();
    expect(DEFAULT_ORPHAN_MIN_AGE_MS).toBe(10 * 60 * 1000);
    expect(DEFAULT_ORPHAN_SWEEP_INTERVAL_MS).toBe(5 * 60 * 1000);
    expect(registry.orphanMinAgeMs).toBe(DEFAULT_ORPHAN_MIN_AGE_MS);
    expect(registry.orphanSweepIntervalMs).toBe(DEFAULT_ORPHAN_SWEEP_INTERVAL_MS);
  });

  it('take a positive number, and fall back to the default for anything else', () => {
    const configured = buildRegistry({ orphanMinAgeMs: 4000, orphanSweepIntervalMs: 9000 });
    expect(configured.orphanMinAgeMs).toBe(4000);
    expect(configured.orphanSweepIntervalMs).toBe(9000);

    for (const unusable of [0, -5, NaN, Infinity, '5000', undefined, 2 ** 31]) {
      const registry = buildRegistry({
        orphanMinAgeMs: unusable,
        orphanSweepIntervalMs: unusable,
      });
      expect(registry.orphanMinAgeMs).toBe(DEFAULT_ORPHAN_MIN_AGE_MS);
      expect(registry.orphanSweepIntervalMs).toBe(DEFAULT_ORPHAN_SWEEP_INTERVAL_MS);
    }
  });
});

describe('a hold racing the orphan sweep for the same digest', () => {
  it('ends with the bytes and the sidecar both present when the sweep removes the old copy between the check and the sidecar write', async () => {
    await writeOrphan();
    const logger = recordingLogger();
    let removedBySweep = null;
    const registry = buildRegistry({
      logger,
      // hold() hashes the bytes it finds on disk before deciding not to
      // rewrite them; the sweep runs at that moment, after the check has
      // read the old copy and before the sidecar is written.
      computeDigest: (buffer) => {
        if (removedBySweep === null) {
          removedBySweep = sweepOrphans(quarantinePath, { minAgeMs: MIN_AGE_MS, logger });
        }
        return digestBytes(buffer);
      },
    });

    await registry.hold(DIGEST, BYTES, {
      targetPath: 'a.png',
      onAllow: vi.fn(),
      onRefuse: vi.fn(),
    });

    expect(removedBySweep).toBe(1);
    await expect(fs.readFile(path.join(quarantinePath, DIGEST))).resolves.toEqual(BYTES);
    expect(
      JSON.parse(await fs.readFile(path.join(quarantinePath, `${DIGEST}.holds.json`), 'utf8'))
    ).toEqual({
      owners: { [OWNER]: ['a.png'] },
    });
    expect(registry.isPending(DIGEST)).toBe(true);
  });

  it('is not swept again once the sidecar is there, however old the bytes are', async () => {
    await writeOrphan();
    const registry = buildRegistry();
    await registry.hold(DIGEST, BYTES, {
      targetPath: 'a.png',
      onAllow: vi.fn(),
      onRefuse: vi.fn(),
    });

    const removed = sweep({ now: () => Date.now() + 10 * DEFAULT_ORPHAN_MIN_AGE_MS });

    expect(removed).toBe(0);
    expect(await listing()).toEqual([DIGEST, `${DIGEST}.holds.json`].sort());
  });

  it('joins a hold that registered while it was confirming the bytes, instead of replacing its entry', async () => {
    const registry = buildRegistry();
    const first = { targetPath: 'first.png', onAllow: vi.fn(), onRefuse: vi.fn() };
    const second = { targetPath: 'second.png', onAllow: vi.fn(), onRefuse: vi.fn() };

    await Promise.all([registry.hold(DIGEST, BYTES, first), registry.hold(DIGEST, BYTES, second)]);

    expect(
      registry.entries
        .get(DIGEST)
        .holds.map((hold) => hold.targetPath)
        .sort()
    ).toEqual(['first.png', 'second.png']);
    expect(
      JSON.parse(
        await fs.readFile(path.join(quarantinePath, `${DIGEST}.holds.json`), 'utf8')
      ).owners[OWNER].sort()
    ).toEqual(['first.png', 'second.png']);
  });
});
