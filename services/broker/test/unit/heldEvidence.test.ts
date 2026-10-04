import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlotName } from '@branchleft/ghost-platform-render-core';
import type { EmailAddress } from '@branchleft/ghost-platform-render-core';
import { makeTempDir } from '../../src/atomicFile.js';
import {
  errorStateOf,
  readSlotState,
  recoverCrashedSlots,
  resetRefusal,
  writeSlotState,
  type SlotState,
} from '../../src/stateStore.js';
import { demoDescriptor } from '../helpers/fixtures.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

const SLOT = '0' as SlotName;

async function wrapperInvocations(broker: TestBroker): Promise<string[][]> {
  let text: string;
  try {
    text = await readFile(broker.wrapperLogPath, 'utf8');
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
}

describe('resetRefusal', () => {
  it('refuses a detaching slot', () => {
    expect(resetRefusal({ phase: 'detaching' }, SLOT)).toContain('detaching');
  });

  it('refuses a detaching slot even when its evidence is already marked detached', () => {
    expect(resetRefusal({ phase: 'detaching', evidence: 'detached' }, SLOT)).toContain('detaching');
  });

  it.each(['free', 'running', 'error', 'preparing', 'stopping'] as const)(
    'refuses a "%s" slot whose freeze is not yet confirmed detached',
    (phase) => {
      const refusal = resetRefusal({ phase, evidence: 'frozen' }, SLOT);
      expect(refusal).toContain('frozen evidence');
      expect(refusal).toContain(`"${phase}"`);
    }
  );

  it.each(['FROZEN', 'true', 'maybe', ''])('refuses an unrecognised marker value %j', (value) => {
    const state = { phase: 'error', evidence: value } as unknown as SlotState;
    expect(resetRefusal(state, SLOT)).toContain('frozen evidence');
  });

  it('refuses a non-string marker value', () => {
    const state = { phase: 'error', evidence: true } as unknown as SlotState;
    expect(resetRefusal(state, SLOT)).toContain('frozen evidence');
  });

  it.each(['free', 'running', 'error'] as const)(
    'allows a "%s" slot with no evidence marker or a confirmed detach',
    (phase) => {
      expect(resetRefusal({ phase }, SLOT)).toBeUndefined();
      expect(resetRefusal({ phase, evidence: 'detached' }, SLOT)).toBeUndefined();
    }
  );
});

describe('errorStateOf', () => {
  it('carries lastHashId without inventing an evidence marker', () => {
    const state = errorStateOf({ phase: 'preparing', lastHashId: 'h' as never });
    expect(state).toEqual({ phase: 'error', lastHashId: 'h' });
    expect('evidence' in state).toBe(false);
  });

  it.each(['frozen', 'detached'] as const)(
    'carries an evidence marker of "%s" forward',
    (evidence) => {
      expect(errorStateOf({ phase: 'swapping', lastHashId: 'h' as never, evidence })).toEqual({
        phase: 'error',
        lastHashId: 'h',
        evidence,
      });
    }
  );
});

describe('/reset and held evidence', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  async function seeded(state: SlotState): Promise<TestBroker> {
    const b = await startTestBroker();
    broker = b;
    const reconcile = await b.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: demoDescriptor(),
    });
    expect(reconcile.status).toBe(200);
    await writeSlotState(b.stateDir, SLOT, state);
    return b;
  }

  async function snapshot(b: TestBroker): Promise<{ state: string; slots: string; calls: number }> {
    return {
      state: await readFile(join(b.stateDir, '0.json'), 'utf8'),
      slots: await readFile(b.slotsPath, 'utf8'),
      calls: (await wrapperInvocations(b)).length,
    };
  }

  it('refuses a slot that is detaching and leaves it completely untouched', async () => {
    // No evidence marker: the phase alone must be enough to refuse.
    const b = await seeded({ phase: 'detaching', colour: 'a' });
    const before = await snapshot(b);

    const res = await b.signedFetch('POST', '/reset', { slot: '0' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('detaching');
    expect(await snapshot(b)).toEqual(before);
    expect((await wrapperInvocations(b)).some((inv) => inv.includes('reset'))).toBe(false);
  });

  it('refuses a detaching slot on every retry, never wearing the refusal down', async () => {
    const b = await seeded({ phase: 'detaching', colour: 'a', evidence: 'frozen' });
    const before = await snapshot(b);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const res = await b.signedFetch('POST', '/reset', { slot: '0' });
      expect(res.status).toBe(409);
    }

    expect(await snapshot(b)).toEqual(before);
  });

  it('refuses a slot a crashed detach left in "error" with its held copy unconfirmed', async () => {
    const b = await seeded({ phase: 'error', evidence: 'frozen' });
    const before = await snapshot(b);

    const res = await b.signedFetch('POST', '/reset', { slot: '0' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('frozen evidence');
    expect(await snapshot(b)).toEqual(before);
  });

  it('refuses a "free" slot that still carries an unconfirmed freeze', async () => {
    const b = await seeded({ phase: 'free', evidence: 'frozen' });
    const before = await snapshot(b);

    const res = await b.signedFetch('POST', '/reset', { slot: '0' });

    expect(res.status).toBe(409);
    expect(await snapshot(b)).toEqual(before);
  });

  it('refuses /reconcile on a free slot with an unconfirmed freeze, so its retry-reset path cannot run', async () => {
    const b = await seeded({ phase: 'free', evidence: 'frozen' });
    const before = await snapshot(b);

    const res = await b.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: demoDescriptor(),
    });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toContain('frozen evidence');
    expect(await snapshot(b)).toEqual(before);
  });

  it('succeeds once the detach is confirmed', async () => {
    const b = await seeded({ phase: 'error', evidence: 'detached' });

    const res = await b.signedFetch('POST', '/reset', { slot: '0' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slot: '0', phase: 'free' });
    expect((await readSlotState(b.stateDir, SLOT)).phase).toBe('free');
    expect((await wrapperInvocations(b)).some((inv) => inv.includes('reset'))).toBe(true);
  });

  it('still resets an ordinary slot that never held evidence', async () => {
    const b = await seeded({ phase: 'error' });

    const res = await b.signedFetch('POST', '/reset', { slot: '0' });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slot: '0', phase: 'free' });
  });

  it('keeps the marker through a /reconcile colour swap, so the next /reset still refuses', async () => {
    const b = await startTestBroker();
    broker = b;
    const first = demoDescriptor({ ownerEmail: 'first@example.com' as EmailAddress });
    const second = demoDescriptor({ ownerEmail: 'second@example.com' as EmailAddress });
    expect(
      (await b.signedFetch('POST', '/reconcile', { slot: '0', descriptor: first })).status
    ).toBe(200);
    const running = await readSlotState(b.stateDir, SLOT);
    expect(running.phase).toBe('running');
    await writeSlotState(b.stateDir, SLOT, { ...running, evidence: 'frozen' });

    const swap = await b.signedFetch('POST', '/reconcile', { slot: '0', descriptor: second });
    expect(swap.status).toBeLessThan(500);
    expect((await readSlotState(b.stateDir, SLOT)).evidence).toBe('frozen');

    const res = await b.signedFetch('POST', '/reset', { slot: '0' });
    expect(res.status).toBe(409);
    expect((await readSlotState(b.stateDir, SLOT)).evidence).toBe('frozen');
  });

  it('refuses /reset on a slot whose marker is an unrecognised value', async () => {
    const b = await seeded({ phase: 'error', evidence: 'FROZEN' as unknown as 'frozen' });
    const before = await snapshot(b);

    const res = await b.signedFetch('POST', '/reset', { slot: '0' });

    expect(res.status).toBe(409);
    expect(await snapshot(b)).toEqual(before);
  });

  it('fails closed when the state file cannot be read', async () => {
    const b = await seeded({ phase: 'error' });
    const path = join(b.stateDir, '0.json');
    await rm(path);
    await mkdir(path);

    const res = await b.signedFetch('POST', '/reset', { slot: '0' });

    expect(res.status).not.toBe(200);
    expect(await wrapperInvocations(b).then((i) => i.some((inv) => inv.includes('reset')))).toBe(
      false
    );
    await rm(path, { recursive: true });
  });

  it('refuses one slot without blocking another', async () => {
    const b = await seeded({ phase: 'detaching', evidence: 'frozen' });

    const res = await b.signedFetch('POST', '/reset', { slot: '1' });

    expect(res.status).toBe(200);
  });
});

describe('writeSlotState and held evidence', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeTempDir('held-evidence-write');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('carries an unconfirmed marker across a write that omits it', async () => {
    await writeSlotState(dir, SLOT, { phase: 'running', colour: 'a', evidence: 'frozen' });
    await writeSlotState(dir, SLOT, { phase: 'running', colour: 'b' });
    expect((await readSlotState(dir, SLOT)).evidence).toBe('frozen');
  });

  it('carries an unrecognised marker too', async () => {
    await writeSlotState(dir, SLOT, { phase: 'error', evidence: 'FROZEN' as unknown as 'frozen' });
    await writeSlotState(dir, SLOT, { phase: 'free' });
    expect((await readSlotState(dir, SLOT)).evidence).toBe('FROZEN');
  });

  it('lets a write that names the marker change it', async () => {
    await writeSlotState(dir, SLOT, { phase: 'detaching', evidence: 'frozen' });
    await writeSlotState(dir, SLOT, { phase: 'error', evidence: 'detached' });
    expect((await readSlotState(dir, SLOT)).evidence).toBe('detached');
  });

  it('does not invent or keep a confirmed marker', async () => {
    await writeSlotState(dir, SLOT, { phase: 'error', evidence: 'detached' });
    await writeSlotState(dir, SLOT, { phase: 'free' });
    expect('evidence' in (await readSlotState(dir, SLOT))).toBe(false);
  });
});

describe('boot recovery and held evidence', () => {
  let dir: string;
  let leaseDir: string;
  let leaseStoreConfig: { slotsPath: string; leaseDir: string };
  const never = {
    drainFlags: { isSet: async () => true, set: async () => undefined },
    ghostReadiness: { isReady: async () => false },
    appPortBase: 9300,
    readyPollTimeoutMs: 50,
  };

  beforeEach(async () => {
    dir = await makeTempDir('broker-held-evidence-');
    leaseDir = await makeTempDir('broker-held-evidence-lease-');
    leaseStoreConfig = { slotsPath: join(leaseDir, 'slots.json'), leaseDir };
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
    await rm(leaseDir, { recursive: true, force: true });
  });

  it('leaves a detaching slot exactly as it found it', async () => {
    await writeSlotState(dir, SLOT, { phase: 'detaching', colour: 'a', evidence: 'frozen' });
    const before = await readFile(join(dir, '0.json'), 'utf8');

    await recoverCrashedSlots(dir, ['0'], leaseStoreConfig, () => undefined, never);

    expect(await readFile(join(dir, '0.json'), 'utf8')).toBe(before);
  });

  it.each([
    ['preparing', { phase: 'preparing' }],
    ['resetting', { phase: 'resetting' }],
    ['stopping with no colour', { phase: 'stopping' }],
    ['swapping with no colours', { phase: 'swapping' }],
  ] as const)(
    'a %s slot recovered to "error" keeps its unconfirmed freeze',
    async (_name, base) => {
      await writeSlotState(dir, SLOT, {
        ...base,
        lastHashId: 'h' as never,
        evidence: 'frozen',
      } as SlotState);

      await recoverCrashedSlots(dir, ['0'], leaseStoreConfig, () => undefined, never);

      const after = await readSlotState(dir, SLOT);
      expect(after).toEqual({ phase: 'error', lastHashId: 'h', evidence: 'frozen' });
      expect(resetRefusal(after, SLOT)).toBeDefined();
    }
  );

  it('a stopping slot with no recovery wrapper keeps its unconfirmed freeze', async () => {
    await writeSlotState(dir, SLOT, { phase: 'stopping', colour: 'a', evidence: 'frozen' });

    await recoverCrashedSlots(dir, ['0'], leaseStoreConfig, () => undefined, never);

    expect((await readSlotState(dir, SLOT)).evidence).toBe('frozen');
  });

  it('a stopping slot whose survivor is not live keeps its unconfirmed freeze', async () => {
    await writeSlotState(dir, SLOT, { phase: 'stopping', colour: 'a', evidence: 'frozen' });

    await recoverCrashedSlots(dir, ['0'], leaseStoreConfig, () => undefined, never, {
      wrapper: { stop: async () => undefined },
    });

    expect((await readSlotState(dir, SLOT)).evidence).toBe('frozen');
  });

  it('a swap that reaches neither colour keeps its unconfirmed freeze', async () => {
    await writeSlotState(dir, SLOT, {
      phase: 'swapping',
      colour: 'a',
      swapTarget: 'b',
      evidence: 'frozen',
    });

    await recoverCrashedSlots(dir, ['0'], leaseStoreConfig, () => undefined, never);

    expect(await readSlotState(dir, SLOT)).toEqual({ phase: 'error', evidence: 'frozen' });
  });
});
