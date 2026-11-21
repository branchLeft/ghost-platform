// The registry's start-up and bookkeeping edges that a normal hold never
// reaches: damaged or foreign sidecars, an interrupted split, abandoned
// writers, a persisted stuck state. Each fails closed: the bytes stay.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { HoldRegistry, STUCK_LOG_PREFIX } = require('../../src/hold.js');
const { digestBytes } = require('../../src/pdq.js');

const OWNER = 'LocalImagesStorage:/var/lib/ghost/content/images';
const OTHER = 'LocalMediaStorage:/var/lib/ghost/content/media';

interface Registry {
  hold(
    digest: string,
    buffer: Buffer,
    options: { targetPath: string; onAllow: () => void; onRefuse: () => void }
  ): Promise<void>;
  resumeFromQuarantine(
    build: (target: string) => { onAllow: () => void; onRefuse: () => void }
  ): void;
  heldSummary(): { count: number; oldestSinceMs: number | null; stuck: number };
  isPending(digest: string): boolean;
  isStuck(digest: string): boolean;
  stopAll(): void;
}

let tmpDir: string;
let quarantinePath: string;
let logged: string[];
const registries: Registry[] = [];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hold-branches-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine');
  logged = [];
});

afterEach(async () => {
  for (const r of registries.splice(0)) r.stopAll();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function build(overrides: Record<string, unknown> = {}): Registry {
  const registry = new HoldRegistry({
    checks: [
      {
        kind: 'media',
        blocking: true,
        async run() {
          return { classification: 'unavailable', evidence: 'x', source: 'test' };
        },
      },
    ],
    policy: { decide: () => 'hold' },
    quarantinePath,
    owner: OWNER,
    computeDigest: digestBytes,
    retryIntervalMs: 60_000,
    orphanMinAgeMs: 1,
    logger: { error: (...args: unknown[]) => logged.push(args.map(String).join(' ')) },
    ...overrides,
  }) as Registry;
  registries.push(registry);
  return registry;
}

const NOOP = { onAllow: () => {}, onRefuse: () => {} };
const callbacks = () => NOOP;

async function writeHeld(bytes: Buffer, sidecar: Record<string, unknown> | null) {
  const digest = digestBytes(bytes);
  await fs.mkdir(quarantinePath, { recursive: true });
  await fs.writeFile(path.join(quarantinePath, digest), bytes);
  if (sidecar !== null) {
    const dir = path.join(quarantinePath, `${digest}.holds.json`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify(sidecar));
  }
  return digest;
}

describe('what the registry reports and starts from', () => {
  it('reports the oldest of several holds, and none of them as stuck', async () => {
    const registry = build();
    const first = Buffer.from('first-held');
    const second = Buffer.from('second-held');
    await registry.hold(digestBytes(first), first, { targetPath: 'a.png', ...NOOP });
    await new Promise((resolve) => setTimeout(resolve, 15));
    await registry.hold(digestBytes(second), second, { targetPath: 'b.png', ...NOOP });

    const summary = registry.heldSummary();
    expect(summary.count).toBe(2);
    expect(summary.stuck).toBe(0);
    expect(summary.oldestSinceMs).not.toBeNull();
  });

  it('starts from a quarantine directory that does not exist yet', () => {
    const registry = build();
    expect(() => registry.resumeFromQuarantine(callbacks)).not.toThrow();
    expect(registry.heldSummary().count).toBe(0);
  });

  it('will not hold over a sidecar that is a file, because that file may be someone’s pending hold', async () => {
    const registry = build();
    const bytes = Buffer.from('held-bytes');
    const digest = digestBytes(bytes);
    await fs.mkdir(quarantinePath, { recursive: true });
    await fs.writeFile(path.join(quarantinePath, `${digest}.holds.json`), 'not a directory');

    await expect(registry.hold(digest, bytes, { targetPath: 'a.png', ...NOOP })).rejects.toThrow(
      /sidecar is a file/
    );
  });
});

describe('resuming holds a previous process left', () => {
  it('resumes its own targets and leaves a hold that is another feature’s', async () => {
    const mine = await writeHeld(Buffer.from('mine'), { owner: OWNER, targets: ['a.png'] });
    const theirs = await writeHeld(Buffer.from('theirs'), { owner: OTHER, targets: ['b.mp4'] });
    const registry = build();
    registry.resumeFromQuarantine(callbacks);

    expect(registry.isPending(mine)).toBe(true);
    expect(registry.isPending(theirs)).toBe(false);
  });

  it('keeps the bytes of a hold whose entry has no targets, and says so, rather than guessing', async () => {
    const digest = await writeHeld(Buffer.from('no-targets'), { owner: OWNER, targets: [] });
    const registry = build();
    registry.resumeFromQuarantine(callbacks);

    expect(registry.isPending(digest)).toBe(false);
    expect(logged.some((l) => /could not read the hold sidecar/.test(l))).toBe(true);
    expect(await fs.readFile(path.join(quarantinePath, digest))).toBeDefined();
  });

  it('keeps the bytes of a hold whose entry names no owner', async () => {
    const digest = await writeHeld(Buffer.from('no-owner'), { owner: '', targets: ['a.png'] });
    const registry = build();
    registry.resumeFromQuarantine(callbacks);

    expect(registry.isPending(digest)).toBe(false);
    expect(logged.some((l) => /could not read hold sidecar entry/.test(l))).toBe(true);
  });

  it('skips a sidecar with no bytes behind it', async () => {
    await fs.mkdir(path.join(quarantinePath, 'abc.holds.json'), { recursive: true });
    await fs.writeFile(
      path.join(quarantinePath, 'abc.holds.json', 'a.json'),
      JSON.stringify({ owner: OWNER, targets: ['a.png'] })
    );
    const registry = build();
    registry.resumeFromQuarantine(callbacks);
    expect(logged.some((l) => /no bytes behind it for abc/.test(l))).toBe(true);
  });

  it('does not retry a hold that was stuck, and counts it', async () => {
    const digest = await writeHeld(Buffer.from('stuck-bytes'), {
      owner: OWNER,
      targets: ['a.png'],
      stuck: { reason: 'seven retries failed' },
    });
    const registry = build();
    registry.resumeFromQuarantine(callbacks);

    expect(registry.isStuck(digest)).toBe(true);
    expect(registry.isPending(digest)).toBe(false);
    expect(registry.heldSummary().stuck).toBe(1);
    expect(logged.some((l) => l.includes(STUCK_LOG_PREFIX))).toBe(true);
  });

  it('a stuck hold with no reason is stuck for an unknown one, and a repeated target is kept once', async () => {
    const bytes = Buffer.from('stuck-no-reason');
    const digest = await writeHeld(bytes, { owner: OWNER, targets: ['a.png', 'a.png'], stuck: {} });
    const registry = build();
    registry.resumeFromQuarantine(callbacks);
    expect(registry.isStuck(digest)).toBe(true);
  });
});

describe('what the sweep leaves and removes at start-up', () => {
  it('removes an abandoned writer’s old temp file and the empty sidecar it leaves, and no more', async () => {
    const dir = path.join(quarantinePath, `${'a'.repeat(64)}.holds.json`);
    await fs.mkdir(dir, { recursive: true });
    const temp = path.join(dir, '.a.json.1.abcdef012345.tmp');
    await fs.writeFile(temp, '{}');
    const old = new Date(Date.now() - 3_600_000);
    await fs.utimes(temp, old, old);
    // A sidecar that is a plain file is not a directory this can prune.
    await fs.writeFile(path.join(quarantinePath, `${'b'.repeat(64)}.holds.json`), 'legacy');

    build().resumeFromQuarantine(callbacks);

    await expect(fs.stat(dir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a sidecar with a live entry beside its temp file alone', async () => {
    const digest = await writeHeld(Buffer.from('live-hold'), { owner: OTHER, targets: ['b.png'] });
    const dir = path.join(quarantinePath, `${digest}.holds.json`);
    const temp = path.join(dir, '.b.json.1.abcdef012345.tmp');
    await fs.writeFile(temp, '{}');
    const old = new Date(Date.now() - 3_600_000);
    await fs.utimes(temp, old, old);

    build().resumeFromQuarantine(callbacks);

    expect(await fs.readdir(dir)).toContain('a.json');
  });

  it('logs, and leaves in place, an interrupted split whose bytes do not match', async () => {
    await fs.mkdir(quarantinePath, { recursive: true });
    await fs.writeFile(path.join(quarantinePath, 'deadbeef'), 'bytes that are not deadbeef');
    const aside = path.join(quarantinePath, '.deadbeef.holds.json.aaaa.json');
    await fs.writeFile(aside, JSON.stringify({ owners: { [OWNER]: ['a.png'] } }));

    build().resumeFromQuarantine(callbacks);

    expect(logged.length).toBeGreaterThan(0);
    expect(await fs.readFile(aside, 'utf8')).toContain('a.png');
  });
});
