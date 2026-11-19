import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AdmissionRefusedError,
  InvalidDemoIdError,
  SLOT_COUNT,
  SLOT_HOLDING_STATES,
  UnknownDemoError,
  type Admission,
  type DemoState,
} from '../src/demoLifecycle.js';
import type { DemoRequestInput } from '../src/demoRequest.js';
import { OwnerDb } from '../src/owner/index.js';
import { ProspectDb } from '../src/prospect/index.js';
import { ProvisionerDb } from '../src/provisioner/index.js';
import { createFixture, type Fixture } from './helpers.js';

// Admission is decided against a count of every demo ever begun in the fixture
// database, and the history is append-only, so each test builds its own house.
let fx: Fixture;
let prospect: ProspectDb;
let provisioner: ProvisionerDb;
let owner: OwnerDb;

beforeEach(async () => {
  fx = await createFixture();
  prospect = new ProspectDb(fx.prospect);
  provisioner = new ProvisionerDb(fx.provisioner);
  owner = new OwnerDb(fx.owner);
}, 60000);

afterEach(async () => {
  await fx.close();
});

let counter = 0;
/** A valid request from a prospect no earlier test has used. */
function request(change: Partial<DemoRequestInput> = {}): DemoRequestInput {
  counter += 1;
  return {
    verifiedSubject: `subject-${counter}`,
    verifiedAddress: `person-${counter}@example.invalid`,
    publicationName: `PUBLICATION_NAME_${counter}`,
    description: 'DESCRIPTION',
    accentColour: '#112233',
    theme: 'theme-one',
    font: 'font-one',
    newToGhost: true,
    importSource: 'IMPORT_SOURCE',
    outletType: 'outlet-type',
    logoHash: 'b'.repeat(64),
    consentWording: 'CONSENT_CONTACT_WORDING',
    explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
    ...change,
  };
}

/** A prospect submits at the front door, and the lifecycle worker begins and admits the demo. */
async function arrive(
  input: DemoRequestInput = request()
): Promise<{ demoId: string; admission: Admission }> {
  const { demoId } = await prospect.submit(input);
  await provisioner.beginDemo(demoId);
  return { demoId, admission: await provisioner.admit(demoId) };
}

/** Moves a claimed demo on along `steps`, the way the lifecycle worker would. */
async function advance(demoId: string, steps: readonly DemoState[]): Promise<void> {
  for (const step of steps) await provisioner.transition(demoId, step);
}

/** Every route from CLAIMED to a state that holds a slot, other than CLAIMED itself. */
const HOLDING_ROUTES: Readonly<Record<string, readonly DemoState[]>> = {
  PROVISIONING: ['PROVISIONING'],
  LIVE: ['PROVISIONING', 'LIVE'],
  EXPIRING: ['PROVISIONING', 'LIVE', 'EXPIRING'],
  REBUILDING: ['PROVISIONING', 'LIVE', 'REBUILDING'],
  PROMOTING: ['PROVISIONING', 'LIVE', 'PROMOTING'],
};

/** Every route from CLAIMED to a state that holds no slot. */
const ENDING_ROUTES: Readonly<Record<string, readonly DemoState[]>> = {
  KILLED: ['KILLED'],
  FROZEN: ['FROZEN'],
  FAILED: ['PROVISIONING', 'FAILED'],
  PURGED: ['PROVISIONING', 'LIVE', 'EXPIRING', 'PURGED'],
  PROMOTED: ['PROVISIONING', 'LIVE', 'PROMOTING', 'PROMOTED'],
};

/** Fills every slot with a fresh request, returning the demo ids in order. */
async function fillHouse(): Promise<string[]> {
  const ids: string[] = [];
  for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
    const { demoId, admission } = await arrive();
    expect(admission.state).toBe('CLAIMED');
    ids.push(demoId);
  }
  return ids;
}

describe('the slots', () => {
  it('offers six', () => {
    expect(SLOT_COUNT).toBe(6);
  });
});

describe('a request when slots are free', () => {
  it('is given a slot, not a place in a queue', async () => {
    const { demoId, admission } = await arrive();
    expect(admission.state).toBe('CLAIMED');
    expect(admission.queuePosition).toBeNull();
    expect(admission.event).toMatchObject({ demoId, fromState: 'VERIFIED', toState: 'CLAIMED' });
    expect(await owner.waitingCount()).toBe(0);
  });

  it('fills six slots and waits no one', async () => {
    await fillHouse();
    expect(await owner.waitingCount()).toBe(0);
  });
});

describe('a request when all six slots are leased', () => {
  it('lands on the waiting list as an entry, not an error, and the console count rises by one', async () => {
    await fillHouse();
    expect(await owner.waitingCount()).toBe(0);
    const input = request();
    const { demoId, admission } = await arrive(input);
    expect(admission.state).toBe('WAITING');
    expect(admission.queuePosition).toBe(1);
    expect(admission.event).toMatchObject({ demoId, fromState: 'VERIFIED', toState: 'WAITING' });
    expect(await owner.waitingCount()).toBe(1);
    expect((await provisioner.currentState(demoId))?.toState).toBe('WAITING');
  });

  it('keeps the same contact details and consent the front door took', async () => {
    await fillHouse();
    const input = request();
    const { demoId } = await arrive(input);
    const held = await provisioner.request(demoId);
    expect(held).toMatchObject({
      demoId,
      verifiedSubject: input.verifiedSubject,
      verifiedAddress: input.verifiedAddress,
      publicationName: input.publicationName,
      consentWording: input.consentWording,
      explainerWording: input.explainerWording,
    });
    expect(held?.submittedAt).toBeInstanceOf(Date);
    // The owner reads the same row, so the lead can be followed up.
    expect(await owner.demoRequest(demoId)).toEqual(held);
  });

  it('holds no term and no hostname: nothing is spent on someone who is waiting', async () => {
    await fillHouse();
    const { demoId } = await arrive();
    const waiting = await provisioner.currentState(demoId);
    expect(waiting?.leaseIssuedAt).toBeNull();
    expect(waiting?.leaseEndsAt).toBeNull();
    expect(await provisioner.hostname(demoId)).toBeNull();
  });

  it('keeps a first-come order and counts each entry once', async () => {
    await fillHouse();
    const first = await arrive();
    const second = await arrive();
    const third = await arrive();
    expect([first, second, third].map((x) => x.admission.queuePosition)).toEqual([1, 2, 3]);
    expect(await owner.waitingCount()).toBe(3);
  });

  it('refuses a second request from the same address, so a person is counted once', async () => {
    await fillHouse();
    const input = request();
    await arrive(input);
    await expect(prospect.submit({ ...input, verifiedSubject: 'another' })).rejects.toThrow();
    expect(await owner.waitingCount()).toBe(1);
  });

  it.each(Object.entries(HOLDING_ROUTES))(
    'still waits when the sixth slot is held in %s',
    async (_name, route) => {
      const ids = await fillHouse();
      await advance(ids[0]!, route);
      const { admission } = await arrive();
      expect(admission.state).toBe('WAITING');
    }
  );

  it('does not count a demo that is waiting, or has not been admitted, as holding a slot', async () => {
    const ids = await fillHouse();
    // One begun and never admitted: it is VERIFIED, and holds nothing.
    const { demoId } = await prospect.submit(request());
    await provisioner.beginDemo(demoId);
    await advance(ids[0]!, ['KILLED']);
    const { admission } = await arrive();
    expect(admission.state).toBe('CLAIMED');
  });
});

describe('the control case: a slot is freed', () => {
  it('a waiting entry that is served leaves the count', async () => {
    const ids = await fillHouse();
    const waiting = await arrive();
    expect(await owner.waitingCount()).toBe(1);
    await advance(ids[0]!, ['KILLED']);
    // The offer accepted: the entry moves from WAITING to CLAIMED.
    await provisioner.transition(waiting.demoId, 'CLAIMED');
    expect(await owner.waitingCount()).toBe(0);
    // The house is full again, so the next request waits.
    expect((await arrive()).admission.state).toBe('WAITING');
  });

  it('the next request provisions normally once a slot is free and nobody is waiting', async () => {
    const ids = await fillHouse();
    await advance(ids[0]!, ['KILLED']);
    const { demoId, admission } = await arrive();
    expect(admission.state).toBe('CLAIMED');
    expect(admission.queuePosition).toBeNull();
    expect((await provisioner.currentState(demoId))?.toState).toBe('CLAIMED');
    expect(await owner.waitingCount()).toBe(0);
    // And it is full again.
    expect((await arrive()).admission.state).toBe('WAITING');
  });

  it.each(Object.entries(ENDING_ROUTES))(
    'a demo that has %s holds no slot, so a request is claimed',
    async (_name, route) => {
      const ids = await fillHouse();
      await advance(ids[0]!, route);
      expect((await arrive()).admission.state).toBe('CLAIMED');
    }
  );

  it('a demo that FAILED with its hostname not retired still holds its slot: the slot is not offered again, so a request waits', async () => {
    const ids = await fillHouse();
    // The worker's failure path with a slot it could not reset: FAILED, hostname left unretired.
    await provisioner.allocateHostname(ids[0]!);
    await advance(ids[0]!, ['PROVISIONING', 'FAILED']);
    const next = await arrive();
    expect(next.admission.state).toBe('WAITING');
  });

  it('a demo that FAILED and had its hostname retired (the slot freed) holds no slot, so a request is claimed', async () => {
    const ids = await fillHouse();
    const label = await provisioner.allocateHostname(ids[0]!);
    await advance(ids[0]!, ['PROVISIONING', 'FAILED']);
    await provisioner.retireHostname(label);
    expect((await arrive()).admission.state).toBe('CLAIMED');
  });

  it('a request never passes someone already waiting, even when a slot is free', async () => {
    const ids = await fillHouse();
    const first = await arrive();
    expect(first.admission.state).toBe('WAITING');
    await advance(ids[0]!, ['KILLED']);
    const second = await arrive();
    expect(second.admission.state).toBe('WAITING');
    expect(second.admission.queuePosition).toBe(2);
    expect(await owner.waitingCount()).toBe(2);
  });
});

describe('simultaneous requests', () => {
  it('give away exactly six slots and queue the rest, however many arrive at once', async () => {
    const arrivals = [];
    for (let index = 0; index < 10; index += 1) {
      const { demoId } = await prospect.submit(request());
      await provisioner.beginDemo(demoId);
      arrivals.push(demoId);
    }
    const outcomes = await Promise.all(arrivals.map((demoId) => provisioner.admit(demoId)));
    expect(outcomes.filter((x) => x.state === 'CLAIMED')).toHaveLength(SLOT_COUNT);
    const queue = outcomes.filter((x) => x.state === 'WAITING');
    expect(queue).toHaveLength(4);
    expect(queue.map((x) => x.queuePosition).sort()).toEqual([1, 2, 3, 4]);
    expect(await owner.waitingCount()).toBe(4);
  });

  it('refuse a second admission of the same demo while the first is deciding', async () => {
    const { demoId } = await prospect.submit(request());
    await provisioner.beginDemo(demoId);
    const results = await Promise.allSettled([
      provisioner.admit(demoId),
      provisioner.admit(demoId),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((x) => x.status === 'rejected');
    expect(refused?.status === 'rejected' && refused.reason).toBeInstanceOf(AdmissionRefusedError);
  });
});

describe('what admission refuses', () => {
  it('a demo already admitted, whether it holds a slot or waits', async () => {
    const ids = await fillHouse();
    await expect(provisioner.admit(ids[0]!)).rejects.toMatchObject({
      name: 'AdmissionRefusedError',
      reason: 'state',
    });
    const waiting = await arrive();
    expect(waiting.admission.state).toBe('WAITING');
    await expect(provisioner.admit(waiting.demoId)).rejects.toBeInstanceOf(AdmissionRefusedError);
    expect(await owner.waitingCount()).toBe(1);
  });

  it('a demo with no recorded request, writing nothing', async () => {
    const demoId = randomUUID();
    await provisioner.beginDemo(demoId);
    const error = await provisioner.admit(demoId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AdmissionRefusedError);
    expect((error as AdmissionRefusedError).reason).toBe('request');
    expect(String((error as Error).message)).not.toContain('@');
    expect((await provisioner.history(demoId)).map((x) => x.toState)).toEqual(['VERIFIED']);
  });

  it('a demo that was never begun, and an id that is not one', async () => {
    await expect(provisioner.admit(randomUUID())).rejects.toBeInstanceOf(UnknownDemoError);
    await expect(provisioner.admit('not-a-uuid')).rejects.toBeInstanceOf(InvalidDemoIdError);
  });
});

describe('the states that hold a slot', () => {
  it('are the seven the design names, and no others', () => {
    expect([...SLOT_HOLDING_STATES].sort()).toEqual([
      'CLAIMED',
      'EXPIRING',
      'EXTENDED',
      'LIVE',
      'PROMOTING',
      'PROVISIONING',
      'REBUILDING',
    ]);
  });
});

describe('the owner console count', () => {
  it('is zero for an empty house and counts only demos in WAITING', async () => {
    expect(await owner.waitingCount()).toBe(0);
    await fillHouse();
    expect(await owner.waitingCount()).toBe(0);
    await arrive();
    expect(await owner.waitingCount()).toBe(1);
  });

  it('is a read: the owner role still cannot write the history', async () => {
    await fillHouse();
    const waiting = await arrive();
    await expect(
      fx.owner.query('delete from portal.demo_state_event where demo_id = $1', [waiting.demoId])
    ).rejects.toMatchObject({ code: '42501' });
    expect(await owner.waitingCount()).toBe(1);
  });
});
