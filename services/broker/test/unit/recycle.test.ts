import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  hashIdOf,
  parseSlotLeaseRecord,
  type LeaseId,
  type SlotName,
  type Slug,
} from '@branchleft/ghost-platform-render-core';
import type { BrokerDeps } from '../../src/app.js';
import type { RecycleEffects } from '../../src/recycle.js';
import { slotDir } from '../../src/slotPorts.js';
import { readSlotState, recoverCrashedSlots, writeSlotState } from '../../src/stateStore.js';
import { descriptorForSlot } from '../helpers/fixtures.js';
import { startTestBroker, type TestBroker } from '../helpers/testBroker.js';

// The recycle: after `/reset` the previous occupant's slot directory, gate
// cookie, unsent mail and hostname are gone before the slot is `free`, so the
// next lease starts from nothing. Each residue below is a control: its
// assertion goes red when the matching step of `handleReset` is removed.

const ZONE = 'demo-domain.example.test';

function hashOf(tag: string): string {
  return `$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$${Buffer.from(tag).toString('base64url')}`;
}

/** A demo descriptor for `slot` under a given never-reused hostname label and gate hash. */
function lease(slot: SlotName, sub: string, hash: string) {
  return descriptorForSlot(slot, {
    slug: `demo-${sub}` as Slug,
    siteUrl: `https://${sub}.${ZONE}` as never,
    hostname: { kind: 'ours', sub, gated: true },
    gate: { kind: 'passphrase', argon2idHash: hash },
  });
}

/**
 * The spool the recycle purges, standing in for `mailgun-shim`'s store: one
 * message per (lease, id), unsent. `purgeUnsentMail` removes exactly the
 * messages of the lease it is given, as the shim's `purgeLease` does
 * (`storeLeasePurge.test.ts` proves that against SQLite).
 */
class FakeSpool {
  readonly messages: { lease: string; id: string }[] = [];
  readonly purged: string[] = [];
  submit(leaseId: string, id: string): void {
    this.messages.push({ lease: leaseId, id });
  }
  async purge(leaseId: LeaseId): Promise<void> {
    this.purged.push(leaseId);
    for (let i = this.messages.length - 1; i >= 0; i -= 1) {
      if (this.messages[i]!.lease === leaseId) this.messages.splice(i, 1);
    }
  }
}

/** The hostname register's retirements: append-only, so a retired name stays retired. */
class FakeRegister {
  readonly retired: string[] = [];
  async retire(host: string): Promise<void> {
    if (!this.retired.includes(host)) this.retired.push(host);
  }
}

interface Rig {
  readonly broker: TestBroker;
  readonly spool: FakeSpool;
  readonly register: FakeRegister;
  readonly events: string[];
  readonly slotDirBase: string;
  readonly knobs: { failPurge: boolean; failRetire: boolean; failWrapperReset: boolean };
}

async function startRig(options: { wipeSlotDirectory?: boolean } = {}): Promise<Rig> {
  const spool = new FakeSpool();
  const register = new FakeRegister();
  const events: string[] = [];
  const knobs = { failPurge: false, failRetire: false, failWrapperReset: false };
  let slotDirBase = '';
  const broker = await startTestBroker({
    wrapDeps(deps: BrokerDeps): BrokerDeps {
      slotDirBase = deps.slotDirBase;
      const recycle: RecycleEffects = {
        async purgeUnsentMail(leaseId) {
          events.push('purge-mail');
          if (knobs.failPurge) throw new Error('spool unreachable');
          await spool.purge(leaseId);
        },
        async retireHostname(host) {
          events.push('retire-hostname');
          if (knobs.failRetire) throw new Error('register unreachable');
          await register.retire(host);
        },
      };
      return {
        ...deps,
        recycle,
        wrapper: {
          ...deps.wrapper,
          // The real wrapper empties the slot directory (demo-host/provision
          // `branchleft_slot.py`, proved in test_recycle_residue.py); this
          // stand-in does the same so the residue check can see it.
          async reset(slot) {
            events.push('wrapper-reset');
            if (knobs.failWrapperReset) throw new Error('wrapper failed');
            await deps.wrapper.reset(slot);
            if (options.wipeSlotDirectory ?? true) {
              await rm(slotDir(slotDirBase, slot), { recursive: true, force: true });
            }
          },
        },
      };
    },
  });
  return { broker, spool, register, events, slotDirBase, knobs };
}

async function readLease(broker: TestBroker, slot: string) {
  try {
    const text = await readFile(join(broker.leaseDir, `${slot}.json`), 'utf8');
    return parseSlotLeaseRecord(text, slot as SlotName);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return null;
    throw err;
  }
}

async function slotsFileHosts(broker: TestBroker): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(broker.slotsPath, 'utf8')) as {
      slots: { host: string }[];
    };
    return parsed.slots.map((entry) => entry.host);
  } catch (err) {
    if ((err as { code?: unknown }).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * The residue check: everything of the previous occupant that is still
 * reachable. Empty means the slot can be handed to the next lease.
 */
async function residueOf(
  rig: Rig,
  previous: { slot: SlotName; lease: LeaseId; host: string }
): Promise<string[]> {
  const found: string[] = [];
  const { broker, spool, register } = rig;

  // The slot's gate cookie names this lease and the gate admits it only
  // while the slot's lease record still carries it (services/demo-gate).
  const record = await readLease(broker, previous.slot);
  if (record?.lease === previous.lease) found.push('cookie: the old lease record still stands');
  // The slot's directory and what the wrapper empties with it.
  const dir = slotDir(rig.slotDirBase, previous.slot);
  const left = await readdir(dir).catch(() => [] as string[]);
  if (left.length > 0) found.push(`data: slot directory still holds ${left.join(', ')}`);
  // Unsent mail submitted under the old lease.
  const mail = spool.messages.filter((m) => m.lease === previous.lease);
  if (mail.length > 0) found.push(`mail: ${mail.length} unsent message(s) of the old lease`);
  // The hostname: answers nothing at the gate and is retired in the register.
  if ((await slotsFileHosts(broker)).includes(previous.host)) {
    found.push('hostname: the gate still answers for it');
  }
  if (!register.retired.includes(previous.host)) {
    found.push('hostname: not retired in the register');
  }
  return found;
}

describe('the recycle: /reset leaves no residue of the previous occupant', () => {
  let rig: Rig | undefined;

  afterEach(async () => {
    await rig?.broker.close();
    rig = undefined;
  });

  async function occupy(sub: string, hash: string, slot: SlotName = '0' as SlotName) {
    const r = rig!;
    const res = await r.broker.signedFetch('POST', '/reconcile', {
      slot,
      descriptor: lease(slot, sub, hash),
    });
    expect(res.status).toBe(200);
    const record = await readLease(r.broker, slot);
    expect(record).not.toBeNull();
    return { slot, lease: record!.lease, host: `${sub}.${ZONE}` };
  }

  it('sees the residue before the reset, and none after it', async () => {
    rig = await startRig();
    const a = await occupy('aaaa-first', hashOf('one'));
    rig.spool.submit(a.lease, 'half-finished-newsletter');

    expect(await residueOf(rig, a)).toEqual([
      'cookie: the old lease record still stands',
      expect.stringContaining('data: slot directory still holds'),
      'mail: 1 unsent message(s) of the old lease',
      'hostname: the gate still answers for it',
      'hostname: not retired in the register',
    ]);

    const res = await rig.broker.signedFetch('POST', '/reset', { slot: '0' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slot: '0', phase: 'free' });

    expect(await residueOf(rig, a)).toEqual([]);
    expect((await readSlotState(rig.broker.stateDir, '0' as SlotName)).retiring).toBeUndefined();
  });

  it("purges the recycled lease's mail and not another slot's", async () => {
    rig = await startRig();
    const a = await occupy('aaaa-first', hashOf('one'));
    const b = await occupy('bbbb-other', hashOf('two'), '1' as SlotName);
    rig.spool.submit(a.lease, 'a-1');
    rig.spool.submit(b.lease, 'b-1');
    rig.spool.submit(b.lease, 'b-2');

    await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

    expect(rig.spool.messages.map((m) => m.id)).toEqual(['b-1', 'b-2']);
    expect(rig.spool.purged).toEqual([a.lease]);
    expect(rig.register.retired).toEqual([a.host]);
  });

  it('wipes the slot, then purges the mail, then retires the hostname, in that order', async () => {
    rig = await startRig();
    await occupy('aaaa-first', hashOf('one'));
    rig.events.length = 0;

    await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

    expect(rig.events).toEqual(['wrapper-reset', 'purge-mail', 'retire-hostname']);
  });

  it('the next lease starts clean: a new lease id and a gate hash the old cookie cannot match', async () => {
    rig = await startRig();
    const a = await occupy('aaaa-first', hashOf('one'));
    const first = await readLease(rig.broker, '0');
    await rig.broker.signedFetch('POST', '/reset', { slot: '0' });
    expect(await readLease(rig.broker, '0')).toBeNull();

    const next = await occupy('cccc-second', hashOf('three'));

    const second = await readLease(rig.broker, '0');
    expect(second!.lease).not.toBe(a.lease);
    expect(second!.hashId).not.toBe(first!.hashId);
    expect(second!.hashId).toBe(hashIdOf(hashOf('three')));
    expect(next.host).not.toBe(a.host);
    // The slot directory now holds the next lease's own files, so only the
    // residues that name the old lease are looked at.
    expect((await residueOf(rig, a)).filter((line) => !line.startsWith('data:'))).toEqual([]);
  });

  it('a slot that held no lease has nothing to purge or retire and still ends free', async () => {
    rig = await startRig();

    const res = await rig.broker.signedFetch('POST', '/reset', { slot: '3' });

    expect(res.status).toBe(200);
    expect(rig.events).toEqual(['wrapper-reset']);
  });

  describe('a failure part-way never ends free, and the retry finishes the job', () => {
    it('a mail purge that fails: access is already revoked, the slot is error, the retry purges the same lease', async () => {
      rig = await startRig();
      const a = await occupy('aaaa-first', hashOf('one'));
      rig.spool.submit(a.lease, 'half-finished-newsletter');
      rig.knobs.failPurge = true;

      const failed = await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

      expect(failed.status).toBe(503);
      expect(await failed.json()).toEqual({ slot: '0', phase: 'error' });
      expect(await readLease(rig.broker, '0')).toBeNull();
      expect(await slotsFileHosts(rig.broker)).toEqual([]);
      expect(rig.spool.messages).toHaveLength(1);
      expect(rig.register.retired).toEqual([]);
      const state = await readSlotState(rig.broker.stateDir, '0' as SlotName);
      expect(state.phase).toBe('error');
      expect(state.retiring).toEqual({ lease: a.lease, host: a.host });

      rig.knobs.failPurge = false;
      const retried = await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

      expect(retried.status).toBe(200);
      expect(await residueOf(rig, a)).toEqual([]);
      expect((await readSlotState(rig.broker.stateDir, '0' as SlotName)).retiring).toBeUndefined();
    });

    it('a hostname retirement that fails after the purge: the retry purges again (idempotent) and retires', async () => {
      rig = await startRig();
      const a = await occupy('aaaa-first', hashOf('one'));
      rig.knobs.failRetire = true;

      const failed = await rig.broker.signedFetch('POST', '/reset', { slot: '0' });
      expect(failed.status).toBe(503);
      expect(rig.spool.purged).toEqual([a.lease]);

      rig.knobs.failRetire = false;
      const retried = await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

      expect(retried.status).toBe(200);
      expect(rig.spool.purged).toEqual([a.lease, a.lease]);
      expect(rig.register.retired).toEqual([a.host]);
    });

    it('a wrapper that fails runs no purge and no retirement: the slot is not yet empty', async () => {
      rig = await startRig();
      const a = await occupy('aaaa-first', hashOf('one'));
      rig.knobs.failWrapperReset = true;
      rig.events.length = 0;

      const failed = await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

      expect(failed.status).toBe(503);
      expect(rig.events).toEqual(['wrapper-reset']);
      expect((await readSlotState(rig.broker.stateDir, '0' as SlotName)).retiring).toEqual({
        lease: a.lease,
        host: a.host,
      });

      rig.knobs.failWrapperReset = false;
      expect((await rig.broker.signedFetch('POST', '/reset', { slot: '0' })).status).toBe(200);
      expect(await residueOf(rig, a)).toEqual([]);
    });

    it('a broker that died mid-reset comes back with the clean-up still pending, and the next reset finishes it', async () => {
      rig = await startRig();
      const a = await occupy('aaaa-first', hashOf('one'));
      rig.spool.submit(a.lease, 'half-finished-newsletter');
      // The process died after the lease record was read and the state said
      // `resetting`, before the lease, the wipe or the effects ran.
      await writeSlotState(rig.broker.stateDir, '0' as SlotName, {
        phase: 'resetting',
        retiring: { lease: a.lease, host: a.host },
      });

      await recoverCrashedSlots(
        rig.broker.stateDir,
        ['0'],
        { slotsPath: rig.broker.slotsPath, leaseDir: rig.broker.leaseDir },
        () => undefined,
        {
          drainFlags: { isSet: async () => true, set: async () => undefined },
          ghostReadiness: { isReady: async () => true },
          appPortBase: 9300,
          readyPollTimeoutMs: 10,
        }
      );
      expect(await readLease(rig.broker, '0')).toBeNull();
      const recovered = await readSlotState(rig.broker.stateDir, '0' as SlotName);
      expect(recovered.phase).toBe('error');
      expect(recovered.retiring).toEqual({ lease: a.lease, host: a.host });

      expect((await rig.broker.signedFetch('POST', '/reset', { slot: '0' })).status).toBe(200);
      expect(await residueOf(rig, a)).toEqual([]);
    });

    it('a lease record that cannot be read refuses the recycle with access untouched, not a guess', async () => {
      rig = await startRig();
      await occupy('aaaa-first', hashOf('one'));
      await writeFile(join(rig.broker.leaseDir, '0.json'), '{not json');
      rig.events.length = 0;

      const res = await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

      expect(res.status).toBe(503);
      expect(rig.events).toEqual([]);
      await expect(stat(join(rig.broker.leaseDir, '0.json'))).resolves.toBeTruthy();
      expect((await readSlotState(rig.broker.stateDir, '0' as SlotName)).phase).toBe('error');
    });
  });

  describe('a slot that is frozen, detached and then reset is recycled like any other', () => {
    it('purges the old lease and retires its hostname: the freeze keeps what the lease record held', async () => {
      rig = await startRig();
      const a = await occupy('aaaa-first', hashOf('one'));
      rig.spool.submit(a.lease, 'queued-before-the-freeze');

      const frozen = await rig.broker.signedFetch('POST', '/freeze', { slot: '0' });
      expect(frozen.status).toBe(200);
      expect(await readLease(rig.broker, '0')).toBeNull();
      const detached = await readSlotState(rig.broker.stateDir, '0' as SlotName);
      expect(detached.evidence).toBe('detached');
      expect(detached.retiring).toEqual({ lease: a.lease, host: a.host });

      const res = await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ slot: '0', phase: 'free' });
      expect(rig.spool.purged).toEqual([a.lease]);
      expect(await residueOf(rig, a)).toEqual([]);
    });

    it('a frozen slot whose effects fail ends error, not free, and the retry finishes it', async () => {
      rig = await startRig();
      const a = await occupy('aaaa-first', hashOf('one'));
      await rig.broker.signedFetch('POST', '/freeze', { slot: '0' });
      rig.knobs.failPurge = true;

      const failed = await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

      expect(failed.status).toBe(503);
      expect((await readSlotState(rig.broker.stateDir, '0' as SlotName)).retiring).toEqual({
        lease: a.lease,
        host: a.host,
      });

      rig.knobs.failPurge = false;
      expect((await rig.broker.signedFetch('POST', '/reset', { slot: '0' })).status).toBe(200);
      expect(await residueOf(rig, a)).toEqual([]);
    });

    it('a lease record that cannot be read stops the freeze before access is cut, frozen and retryable', async () => {
      rig = await startRig();
      await occupy('aaaa-first', hashOf('one'));
      await writeFile(join(rig.broker.leaseDir, '0.json'), '{not json');

      const res = await rig.broker.signedFetch('POST', '/freeze', { slot: '0' });

      expect(res.status).toBe(503);
      await expect(stat(join(rig.broker.leaseDir, '0.json'))).resolves.toBeTruthy();
      expect(await readSlotState(rig.broker.stateDir, '0' as SlotName)).toMatchObject({
        phase: 'detaching',
        evidence: 'frozen',
      });
      expect((await rig.broker.signedFetch('POST', '/reset', { slot: '0' })).status).toBe(409);
    });
  });

  it('the broker as shipped has no purge or register wired, so a leased slot never ends free through it', async () => {
    const { UNWIRED_RECYCLE_EFFECTS } = await import('../../src/recycle.js');
    await expect(UNWIRED_RECYCLE_EFFECTS.purgeUnsentMail('x' as LeaseId)).rejects.toThrow(
      'no mail purge is wired'
    );
    await expect(UNWIRED_RECYCLE_EFFECTS.retireHostname('x.example.test')).rejects.toThrow(
      'no hostname register is wired'
    );
  });

  it('the residue check itself sees a slot directory the wipe left behind', async () => {
    rig = await startRig({ wipeSlotDirectory: false });
    const a = await occupy('aaaa-first', hashOf('one'));

    await rig.broker.signedFetch('POST', '/reset', { slot: '0' });

    expect(await residueOf(rig, a)).toEqual([
      expect.stringContaining('data: slot directory still holds'),
    ]);
  });
});
