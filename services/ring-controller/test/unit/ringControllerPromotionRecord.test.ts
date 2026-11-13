import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import { createPromotionRecorder } from '../../src/promotionRecorder.js';
import { runRelease, type Release } from '../../src/ringController.js';
import { CLEAN_ENV, RELEASE, bakeConfig, makeFleet } from './helpers/fakeFleet.js';
import { FIXED_NOW, makeKeys, removeAll } from './helpers/chainFixtures.js';

const dirs: string[] = [];
afterEach(async () => {
  await removeAll(dirs);
});

const run = (fleet: ReturnType<typeof makeFleet>, release: Release = RELEASE) =>
  runRelease(release, fleet.deps, bakeConfig(), CLEAN_ENV);

describe('a promotion is recorded for every member that took the release', () => {
  it('records one entry per member, in bump order, naming the promotion, the slot and the digest', async () => {
    const fleet = makeFleet();
    expect(await run(fleet)).toEqual({ status: 'completed' });

    expect(fleet.records.map((r) => r.slot)).toEqual(fleet.bumpOrder());
    expect(fleet.records.length).toBe(6);
    for (const record of fleet.records) {
      expect(record).toEqual({
        promotion: RELEASE.digest,
        slot: record.slot,
        digest: RELEASE.digest,
      });
    }
  });

  it('writes each record before it stops that member’s old colour', async () => {
    const fleet = makeFleet();
    await run(fleet);

    for (const { tenantId } of Object.values(fleet.members).flat()) {
      const recorded = fleet.events.indexOf(`record:${tenantId}`);
      const stopped = fleet.events.indexOf(`stop-old:${tenantId}`);
      expect(recorded).toBeGreaterThanOrEqual(0);
      expect(stopped).toBeGreaterThan(recorded);
    }
  });

  it('records nothing for a release that is held before any tenant is bumped', async () => {
    const consent = makeFleet();
    await run(consent, { ...RELEASE, route: 'consent' });
    const redGate = makeFleet({ runGatesThrows: true });
    await run(redGate);

    expect(consent.records).toEqual([]);
    expect(redGate.records).toEqual([]);
  });

  it('records nothing for a member whose bump did not reach done', async () => {
    const fleet = makeFleet({ tenants: { 'canary-mysql': { applyOk: false } } });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', reason: 'bump-not-done' });
    expect(fleet.records).toEqual([]);
  });

  it('records nothing for a ring that regressed during its bake', async () => {
    const fleet = makeFleet({ health: async () => ({ healthy: false }) });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', reason: 'unhealthy' });
    expect(fleet.records).toEqual([]);
  });
});

describe('a promotion whose record cannot be written stops the release (fail closed)', () => {
  it('holds as promotion-record-failed at that ring, naming the tenant and the cause', async () => {
    const fleet = makeFleet({
      recordPromotion: async () => {
        throw new Error('disk full');
      },
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'slot-0',
      reason: 'promotion-record-failed',
      tenantId: 'canary-mysql',
      digest: RELEASE.digest,
    });
    expect(outcome.status === 'held' && outcome.detail).toContain('disk full');
    expect(fleet.holds).toHaveLength(1);
  });

  it('never stops the old colour of the member it could not record, and enters no later ring', async () => {
    const fleet = makeFleet({
      recordPromotion: async () => {
        throw new Error('disk full');
      },
    });
    await run(fleet);

    expect(fleet.stoppedOld()).toEqual([]);
    expect(fleet.ringsInBumpOrder()).toEqual(['slot-0']);
    expect(fleet.pages).toEqual([]);
  });

  it('stops at the first member it cannot record: earlier members stay recorded and closed, later ones are untouched', async () => {
    const fleet = makeFleet({
      recordPromotion: async (record) => {
        if (record.slot === 'entry-2') throw new Error('disk full');
      },
    });
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'entry',
      reason: 'promotion-record-failed',
      tenantId: 'entry-2',
    });
    expect(fleet.stoppedOld()).toEqual(['canary-mysql', 'demo-1', 'entry-1']);
    expect(fleet.bumpOrder()).not.toContain('pro-1');
  });

  it('holds, rather than completing, when the recorder is not wired at all', async () => {
    const fleet = makeFleet();
    delete (fleet.deps as Partial<typeof fleet.deps>).recordPromotion;
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', reason: 'promotion-record-failed' });
    expect(fleet.stoppedOld()).toEqual([]);
  });

  it('holds when the record itself is refused as malformed', async () => {
    const dir = await makeTempDir('ring-controller-wire-');
    dirs.push(dir);
    const keys = makeKeys();
    const recorder = createPromotionRecorder({
      logPath: join(dir, 'promotions.log'),
      headPath: join(dir, 'promotion-head.json'),
      ...keys,
      now: () => FIXED_NOW,
    });
    // The fake fleet's digest is not sha256 plus 64 hex digits, so the log refuses it.
    const fleet = makeFleet();
    fleet.deps.recordPromotion = (record) => recorder.record(record);
    const outcome = await run(fleet);

    expect(outcome).toMatchObject({ status: 'held', reason: 'promotion-record-failed' });
    expect(outcome.status === 'held' && outcome.detail).toContain('bad-record');
    await expect(readFile(join(dir, 'promotions.log'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});

describe('with the real recorder', () => {
  const HEX = `sha256:${'c'.repeat(64)}`;
  const release: Release = { digest: HEX, version: '5.96.1', route: 'fast-path' };
  const healthy = async () => ({ healthy: true, reportedDigest: HEX });

  async function wired(logDir?: string) {
    const dir = await makeTempDir('ring-controller-wire-');
    dirs.push(dir);
    const keys = makeKeys();
    const logPath = join(logDir ?? dir, 'promotions.log');
    const recorder = createPromotionRecorder({
      logPath,
      headPath: join(dir, 'promotion-head.json'),
      ...keys,
      now: () => FIXED_NOW,
    });
    const fleet = makeFleet({ health: healthy });
    fleet.deps.recordPromotion = (record) => recorder.record(record);
    return { dir, logPath, fleet };
  }

  it('leaves one signed entry per member in the log and a head that matches it', async () => {
    const { dir, logPath, fleet } = await wired();
    expect(await run(fleet, release)).toEqual({ status: 'completed' });

    const lines = (await readFile(logPath, 'utf8')).split('\n').slice(0, -1);
    expect(lines.map((line) => (JSON.parse(line) as { slot: string }).slot)).toEqual(
      fleet.bumpOrder()
    );
    const head = JSON.parse(await readFile(join(dir, 'promotion-head.json'), 'utf8')) as {
      seq: number;
    };
    expect(head.seq).toBe(lines.length - 1);
  });

  it('holds, with no member closed, when the log cannot be written', async () => {
    const gone = await makeTempDir('ring-controller-gone-');
    dirs.push(gone);
    const { fleet } = await wired(join(gone, 'absent'));
    const outcome = await run(fleet, release);

    expect(outcome).toMatchObject({
      status: 'held',
      at: 'slot-0',
      reason: 'promotion-record-failed',
      tenantId: 'canary-mysql',
    });
    expect(fleet.stoppedOld()).toEqual([]);
  });

  it('holds on the second run of the same release: one entry per slot per promotion', async () => {
    const { fleet } = await wired();
    expect(await run(fleet, release)).toEqual({ status: 'completed' });
    const again = await run(fleet, release);

    expect(again).toMatchObject({ status: 'held', reason: 'promotion-record-failed' });
    expect(again.status === 'held' && again.detail).toContain('duplicate-slot-promotion');
  });
});
