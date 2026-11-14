import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { leaseRecordFileName, type SlotName } from '@branchleft/ghost-platform-render-core';
import type { BrokerDeps } from '../../src/app.js';
import { createDrainFlagStore } from '../../src/drainFlag.js';
import { readSlotState, writeSlotState, type SlotState } from '../../src/stateStore.js';
import type { DetachReceipt } from '../../src/wrapper.js';
import { demoDescriptor } from '../helpers/fixtures.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

const SLOT = '0' as SlotName;
const RECEIPT: DetachReceipt = { entry: '0-1', sha256: 'a'.repeat(64), bytes: 4096 };

async function wrapperVerbs(broker: TestBroker): Promise<string[]> {
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
    .map((line) => (JSON.parse(line) as string[]).join(' '));
}

/** One failed or interposed `detach`, everything else the real wrapper stand-in. */
type DetachStub = (slot: SlotName) => Promise<DetachReceipt>;

function withDetach(stub: DetachStub): (deps: BrokerDeps) => BrokerDeps {
  return (deps) => ({ ...deps, wrapper: { ...deps.wrapper, detach: stub } });
}

describe('POST /freeze', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  async function running(options?: Parameters<typeof startTestBroker>[0]): Promise<TestBroker> {
    const b = await startTestBroker(options);
    broker = b;
    const reconcile = await b.signedFetch('POST', '/reconcile', {
      slot: '0',
      descriptor: demoDescriptor(),
    });
    expect(reconcile.status).toBe(200);
    return b;
  }

  async function seeded(
    state: SlotState,
    options?: Parameters<typeof startTestBroker>[0]
  ): Promise<TestBroker> {
    const b = await running(options);
    await writeSlotState(b.stateDir, SLOT, state);
    return b;
  }

  async function statusOf(b: TestBroker, slot = '0'): Promise<Record<string, unknown>> {
    const res = await fetch(`${b.baseUrl}/status/${slot}`);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  }

  it('freezes a running slot, detaches it and records the confirmed marker with its receipt', async () => {
    const b = await running();

    const res = await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect(res.status).toBe(200);
    // Nothing from the manifest, no hostname, no reason: the marker and the receipt only.
    expect(await res.json()).toEqual({
      slot: '0',
      phase: 'error',
      evidence: 'detached',
      entry: RECEIPT.entry,
      sha256: RECEIPT.sha256,
      bytes: RECEIPT.bytes,
    });
    const state = await readSlotState(b.stateDir, SLOT);
    expect(state.phase).toBe('error');
    expect(state.evidence).toBe('detached');
    expect(state.heldReceipt).toEqual(RECEIPT);
    expect(await wrapperVerbs(b)).toContain('0 detach');
  });

  it('writes the marker and the detaching phase before any side effect, then revokes before it detaches', async () => {
    const seen: { state?: SlotState; leaseKept?: boolean; flags?: boolean[]; forgotten?: number } =
      {};
    let b!: TestBroker;
    b = await running({
      wrapDeps: withDetach(async () => {
        seen.state = await readSlotState(b.stateDir, SLOT);
        seen.leaseKept = existsSync(join(b.leaseDir, leaseRecordFileName(SLOT)));
        const flags = createDrainFlagStore(b.drainFlagDir);
        seen.flags = [await flags.isSet(SLOT, 'a'), await flags.isSet(SLOT, 'b')];
        seen.forgotten = b.adminApi.forgotten.length;
        return RECEIPT;
      }),
    });

    const res = await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect(res.status).toBe(200);
    expect(seen.state?.phase).toBe('detaching');
    expect(seen.state?.evidence).toBe('frozen');
    expect(seen.leaseKept).toBe(false);
    expect(seen.flags).toEqual([true, true]);
    expect(seen.forgotten).toBe(1);
  });

  it('answers /reset with a machine-readable held-evidence refusal while the detach is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const inDetach = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const b = await running({
      wrapDeps: withDetach(async () => {
        entered();
        await gate;
        return RECEIPT;
      }),
    });

    const freeze = b.signedFetch('POST', '/freeze', { slot: '0' });
    await inDetach;
    // A concurrent caller of either route is told "locked": retry later, not "held".
    const second = await b.signedFetch('POST', '/freeze', { slot: '0' });
    expect(second.status).toBe(409);
    expect(((await second.json()) as { reason?: string }).reason).toBe('locked');
    const reset = await b.signedFetch('POST', '/reset', { slot: '0' });
    expect(reset.status).toBe(409);
    expect(((await reset.json()) as { reason?: string }).reason).toBe('locked');
    expect(await statusOf(b)).toMatchObject({ phase: 'detaching', evidence: 'frozen' });

    release();
    expect((await freeze).status).toBe(200);
  });

  it('leaves the slot detaching and frozen when the wrapper fails, and refuses /reset as held', async () => {
    let attempts = 0;
    const b = await running({
      wrapDeps: withDetach(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('wrapper sabotage failure');
        return RECEIPT;
      }),
    });

    const res = await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ slot: '0', phase: 'detaching', evidence: 'frozen' });
    const stuck = await readSlotState(b.stateDir, SLOT);
    expect(stuck.phase).toBe('detaching');
    expect(stuck.evidence).toBe('frozen');
    expect(stuck.heldReceipt).toBeUndefined();

    const reset = await b.signedFetch('POST', '/reset', { slot: '0' });
    expect(reset.status).toBe(409);
    expect(((await reset.json()) as { reason?: string }).reason).toBe('held-evidence');
    expect((await wrapperVerbs(b)).filter((v) => v.endsWith('reset'))).toEqual([]);
    expect((await readSlotState(b.stateDir, SLOT)).evidence).toBe('frozen');

    // The retry resumes and converges; the reset is then let through.
    const retry = await b.signedFetch('POST', '/freeze', { slot: '0' });
    expect(retry.status).toBe(200);
    expect((await b.signedFetch('POST', '/reset', { slot: '0' })).status).toBe(200);
  });

  it('leaves the slot detaching and frozen when revoking access fails, before any detach', async () => {
    let detaches = 0;
    const b = await running({
      wrapDeps: withDetach(async () => {
        detaches += 1;
        return RECEIPT;
      }),
    });
    b.adminApi.failForget = true;

    const res = await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect(res.status).toBe(503);
    expect(detaches).toBe(0);
    expect(await readSlotState(b.stateDir, SLOT)).toMatchObject({
      phase: 'detaching',
      evidence: 'frozen',
    });
    expect((await b.signedFetch('POST', '/reset', { slot: '0' })).status).toBe(409);

    b.adminApi.failForget = false;
    expect((await b.signedFetch('POST', '/freeze', { slot: '0' })).status).toBe(200);
    expect(detaches).toBe(1);
  });

  it.each([
    ['(detaching, frozen) after a crash mid-detach', { phase: 'detaching', evidence: 'frozen' }],
    ['(error, frozen) as a crashed detach left it', { phase: 'error', evidence: 'frozen' }],
  ] as const)('resumes %s and confirms it', async (_name, state) => {
    const b = await seeded(state);

    const res = await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect(res.status).toBe(200);
    expect((await readSlotState(b.stateDir, SLOT)).evidence).toBe('detached');
  });

  it('keeps lastHashId through the confirmed detach, so the next tenancy still has to rotate its hash', async () => {
    const b = await running();
    const before = await readSlotState(b.stateDir, SLOT);
    expect(before.lastHashId).toBeDefined();

    await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect((await readSlotState(b.stateDir, SLOT)).lastHashId).toBe(before.lastHashId);
  });

  it('answers a replay from the stored receipt without touching the wrapper again', async () => {
    const b = await running();
    const first = await b.signedFetch('POST', '/freeze', { slot: '0' });
    const detaches = (await wrapperVerbs(b)).filter((v) => v.endsWith('detach')).length;
    expect(detaches).toBe(1);

    const replay = await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(await first.json());
    expect((await wrapperVerbs(b)).filter((v) => v.endsWith('detach')).length).toBe(1);
  });

  it('lets /reset through once the detach is confirmed, and the reset forgets the marker and receipt', async () => {
    const b = await running();
    await b.signedFetch('POST', '/freeze', { slot: '0' });

    const res = await b.signedFetch('POST', '/reset', { slot: '0' });

    expect(res.status).toBe(200);
    const after = await readSlotState(b.stateDir, SLOT);
    expect(after.phase).toBe('free');
    expect(after.evidence).toBeUndefined();
    expect(after.heldReceipt).toBeUndefined();
  });

  it('refuses a free slot with nothing to freeze, writing nothing and calling nothing', async () => {
    const b = await startTestBroker();
    broker = b;

    const res = await b.signedFetch('POST', '/freeze', { slot: '3' });

    expect(res.status).toBe(409);
    expect(((await res.json()) as { reason?: string }).reason).toBe('nothing-to-freeze');
    expect(existsSync(join(b.stateDir, '3.json'))).toBe(false);
    expect(await wrapperVerbs(b)).toEqual([]);
  });

  it.each(['preparing', 'swapping', 'stopping', 'resetting'] as const)(
    'refuses a slot stuck in "%s" as occupied and leaves it untouched',
    async (phase) => {
      const b = await seeded({ phase });
      const before = await readFile(join(b.stateDir, '0.json'), 'utf8');

      const res = await b.signedFetch('POST', '/freeze', { slot: '0' });

      expect(res.status).toBe(409);
      expect(((await res.json()) as { reason?: string }).reason).toBe('occupied');
      expect(await readFile(join(b.stateDir, '0.json'), 'utf8')).toBe(before);
      expect((await wrapperVerbs(b)).some((v) => v.endsWith('detach'))).toBe(false);
    }
  );

  it('refuses to answer a confirmed marker that has no stored receipt, and changes nothing', async () => {
    const b = await running();
    const { releaseHeldEvidence } = await import('../../src/stateStore.js');
    await releaseHeldEvidence(b.stateDir, SLOT, { phase: 'error' });
    const before = await readFile(join(b.stateDir, '0.json'), 'utf8');

    const res = await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect(res.status).toBe(409);
    expect(await readFile(join(b.stateDir, '0.json'), 'utf8')).toBe(before);
    expect((await wrapperVerbs(b)).some((v) => v.endsWith('detach'))).toBe(false);
  });

  it.each([
    ['a receipt for another slot', { ...RECEIPT, entry: '1-1' }],
    ['an entry still named partial', { ...RECEIPT, entry: '0-1.partial' }],
    ['a short digest', { ...RECEIPT, sha256: 'abc' }],
    ['a negative byte count', { ...RECEIPT, bytes: -1 }],
    ['a fractional byte count', { ...RECEIPT, bytes: 1.5 }],
  ])('does not release the slot on %s', async (_name, receipt) => {
    const b = await running({ wrapDeps: withDetach(async () => receipt as DetachReceipt) });

    const res = await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect(res.status).toBe(503);
    const state = await readSlotState(b.stateDir, SLOT);
    expect(state.phase).toBe('detaching');
    expect(state.evidence).toBe('frozen');
    expect(state.heldReceipt).toBeUndefined();
    expect((await b.signedFetch('POST', '/reset', { slot: '0' })).status).toBe(409);
  });

  it('refuses an unsigned request and an unenumerated slot before any side effect', async () => {
    const b = await running();
    const before = await readFile(join(b.stateDir, '0.json'), 'utf8');

    const unsigned = await fetch(`${b.baseUrl}/freeze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slot: '0' }),
    });
    expect(unsigned.status).toBe(401);
    const unknown = await b.signedFetch('POST', '/freeze', { slot: 'nine' });
    expect(unknown.status).toBe(422);

    expect(await readFile(join(b.stateDir, '0.json'), 'utf8')).toBe(before);
    expect((await wrapperVerbs(b)).some((v) => v.endsWith('detach'))).toBe(false);
  });

  it('freezes one slot without touching another', async () => {
    const b = await running();
    await b.signedFetch('POST', '/freeze', { slot: '0' });

    expect((await b.signedFetch('POST', '/reset', { slot: '1' })).status).toBe(200);
  });
});

describe('GET /status and the held-evidence marker', () => {
  let broker: TestBroker | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  async function evidenceOf(b: TestBroker): Promise<unknown> {
    const res = await fetch(`${b.baseUrl}/status/0`);
    return ((await res.json()) as { evidence?: unknown }).evidence;
  }

  it('reports absent for a slot that never held evidence', async () => {
    broker = await startTestBroker();
    expect(await evidenceOf(broker)).toBe('absent');
  });

  it('reports frozen while a freeze is unconfirmed and detached once it is confirmed', async () => {
    const b = await startTestBroker();
    broker = b;
    await writeSlotState(b.stateDir, SLOT, { phase: 'detaching', evidence: 'frozen' });
    expect(await evidenceOf(b)).toBe('frozen');

    const { releaseHeldEvidence } = await import('../../src/stateStore.js');
    await releaseHeldEvidence(b.stateDir, SLOT, { phase: 'error' });
    expect(await evidenceOf(b)).toBe('detached');
  });

  it('reports an unrecognised marker as frozen, as the reset guard counts it as held', async () => {
    const b = await startTestBroker();
    broker = b;
    await writeSlotState(b.stateDir, SLOT, {
      phase: 'error',
      evidence: 'FROZEN' as unknown as 'frozen',
    });
    expect(await evidenceOf(b)).toBe('frozen');
  });

  it('exposes nothing else of the held entry on the unauthenticated route', async () => {
    const b = await startTestBroker();
    broker = b;
    await b.signedFetch('POST', '/reconcile', { slot: '0', descriptor: demoDescriptor() });
    await b.signedFetch('POST', '/freeze', { slot: '0' });

    const text = await (await fetch(`${b.baseUrl}/status/0`)).text();

    expect(text).not.toContain(RECEIPT.entry);
    expect(text).not.toContain(RECEIPT.sha256);
    expect(Object.keys(JSON.parse(text) as object).sort()).toEqual([
      'evidence',
      'healthy',
      'interim',
      'notReal',
      'phase',
      'slot',
    ]);
  });
});

describe('who may release held evidence', () => {
  it('has exactly one caller of releaseHeldEvidence outside its own definition: the freeze handler', async () => {
    const { readdir } = await import('node:fs/promises');
    const srcDir = new URL('../../src/', import.meta.url);
    const callers: string[] = [];
    const walk = async (dir: URL): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.name === 'generated') continue;
        if (entry.isDirectory()) {
          await walk(new URL(`${entry.name}/`, dir));
        } else if (entry.name.endsWith('.ts') && entry.name !== 'stateStore.ts') {
          const text = await readFile(new URL(entry.name, dir), 'utf8');
          if (/releaseHeldEvidence\s*\(/.test(text)) callers.push(entry.name);
        }
      }
    };
    await walk(srcDir);

    expect(callers).toEqual(['app.ts']);
    const app = await readFile(new URL('app.ts', srcDir), 'utf8');
    expect(app.match(/releaseHeldEvidence\s*\(/g)).toHaveLength(1);
  });
});
