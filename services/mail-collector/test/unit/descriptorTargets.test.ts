import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DescriptorTargetStore } from '../../src/descriptorTargets.js';
import { createLogger } from '../../src/log.js';

function silentLogger() {
  return createLogger(() => {});
}

function descriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: 'tenant',
    slug: 'tenant-a',
    appHostIp: '127.0.0.1',
    expiresAt: null,
    ...overrides,
  };
}

describe('DescriptorTargetStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'collector-descriptors-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function store(
    overrides: Partial<{ shimPort: number; maxStalenessMs: number; now: () => number }> = {}
  ) {
    return new DescriptorTargetStore({
      descriptorDir: dir,
      shimPort: overrides.shimPort ?? 8080,
      maxStalenessMs: overrides.maxStalenessMs ?? 60_000,
      log: silentLogger(),
      now: overrides.now,
    });
  }

  it('targets is empty before any refresh has ever run', () => {
    const s = store();
    expect(s.targets).toEqual([]);
    expect(s.isStale).toBe(true);
  });

  it('derives one target per valid descriptor, addressed by appHostIp and the configured shim port', async () => {
    writeFileSync(
      join(dir, 'a.json'),
      JSON.stringify(descriptor({ slug: 'a', appHostIp: '10.0.0.11' }))
    );
    writeFileSync(
      join(dir, 'b.json'),
      JSON.stringify(descriptor({ slug: 'b', appHostIp: '10.0.0.12' }))
    );
    const s = store({ shimPort: 9090 });
    await s.refresh();
    expect(s.targets).toEqual(
      expect.arrayContaining([
        { id: 'a', baseUrl: 'http://10.0.0.11:9090' },
        { id: 'b', baseUrl: 'http://10.0.0.12:9090' },
      ])
    );
    expect(s.targets).toHaveLength(2);
  });

  it('the control case: a host with no descriptor file contributes no target, however reachable', async () => {
    writeFileSync(
      join(dir, 'a.json'),
      JSON.stringify(descriptor({ slug: 'a', appHostIp: '10.0.0.11' }))
    );
    const s = store();
    await s.refresh();
    expect(s.targets.map((t) => t.id)).toEqual(['a']);
    expect(s.targets.some((t) => t.id === 'not-described')).toBe(false);
  });

  it('excludes a descriptor with a malformed shape rather than throwing', async () => {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ kind: 'tenant' }));
    writeFileSync(join(dir, 'good.json'), JSON.stringify(descriptor({ slug: 'good' })));
    const s = store();
    await s.refresh();
    expect(s.targets.map((t) => t.id)).toEqual(['good']);
  });

  it.each([
    ['a bare string, not an object', JSON.stringify('not-an-object')],
    ['null', JSON.stringify(null)],
    ['an unrecognised kind', JSON.stringify(descriptor({ kind: 'unknown' }))],
    ['an empty appHostIp', JSON.stringify(descriptor({ appHostIp: '' }))],
    ['a non-string appHostIp', JSON.stringify(descriptor({ appHostIp: 12345 }))],
    ['a non-string, non-null expiresAt', JSON.stringify(descriptor({ expiresAt: 12345 }))],
  ])('excludes a descriptor that is %s', async (_label, raw) => {
    writeFileSync(join(dir, 'bad.json'), raw);
    writeFileSync(join(dir, 'good.json'), JSON.stringify(descriptor({ slug: 'good' })));
    const s = store();
    await s.refresh();
    expect(s.targets.map((t) => t.id)).toEqual(['good']);
  });

  it('excludes a descriptor that is not valid JSON rather than throwing', async () => {
    writeFileSync(join(dir, 'broken.json'), '{not json');
    writeFileSync(join(dir, 'good.json'), JSON.stringify(descriptor({ slug: 'good' })));
    const s = store();
    await s.refresh();
    expect(s.targets.map((t) => t.id)).toEqual(['good']);
  });

  it('excludes an expired descriptor', async () => {
    writeFileSync(
      join(dir, 'expired.json'),
      JSON.stringify(descriptor({ slug: 'expired', expiresAt: '2000-01-01T00:00:00.000Z' }))
    );
    writeFileSync(
      join(dir, 'live.json'),
      JSON.stringify(descriptor({ slug: 'live', expiresAt: null }))
    );
    const s = store();
    await s.refresh();
    expect(s.targets.map((t) => t.id)).toEqual(['live']);
  });

  it('keeps the last good target list when a refresh cannot read the directory', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(descriptor({ slug: 'a' })));
    const s = store();
    await s.refresh();
    expect(s.targets).toHaveLength(1);

    rmSync(dir, { recursive: true, force: true }); // directory now unreadable
    await s.refresh();
    expect(s.targets).toHaveLength(1); // still answers from the last good read
  });

  it('fails closed once the last good refresh is older than maxStalenessMs', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(descriptor({ slug: 'a' })));
    let now = 0;
    const s = store({ maxStalenessMs: 1000, now: () => now });
    await s.refresh();
    expect(s.targets).toHaveLength(1);
    now = 2000;
    expect(s.isStale).toBe(true);
    expect(s.targets).toEqual([]);
  });

  it('a host removed from the descriptor directory drops out of targets on the next refresh', async () => {
    const filePath = join(dir, 'a.json');
    writeFileSync(filePath, JSON.stringify(descriptor({ slug: 'a' })));
    const s = store();
    await s.refresh();
    expect(s.targets.map((t) => t.id)).toEqual(['a']);
    unlinkSync(filePath);
    await s.refresh();
    expect(s.targets).toEqual([]);
  });

  it('a second concurrent refresh() joins the first rather than racing it', async () => {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(descriptor({ slug: 'a' })));
    const s = store();
    const [first, second] = [s.refresh(), s.refresh()];
    await Promise.all([first, second]);
    expect(s.targets).toHaveLength(1);
  });
});
