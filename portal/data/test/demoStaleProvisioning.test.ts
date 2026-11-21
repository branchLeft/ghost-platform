import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { SLOT_COUNT, type DemoState } from '../src/demoLifecycle.js';
import type { DemoRequestInput } from '../src/demoRequest.js';
import { ProspectDb } from '../src/prospect/index.js';
import { ProvisionerDb } from '../src/provisioner/index.js';
import { createFixture, type Fixture } from './helpers.js';

// Each test builds its own cluster state: admission counts every demo in the
// database, and the history is append-only.
let fx: Fixture;
let prospect: ProspectDb;
let provisioner: ProvisionerDb;

beforeEach(async () => {
  fx = await createFixture();
  prospect = new ProspectDb(fx.prospect);
  provisioner = new ProvisionerDb(fx.provisioner);
}, 60000);

afterEach(async () => {
  await fx.close();
});

let counter = 0;
/** A valid request from a prospect no earlier test has used. */
function request(): DemoRequestInput {
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
  };
}

/** A demo begun and moved to PROVISIONING, the way the lifecycle worker would. */
async function provisioning(demoId = randomUUID()): Promise<string> {
  await provisioner.beginDemo(demoId);
  await provisioner.transition(demoId, 'CLAIMED');
  await provisioner.transition(demoId, 'PROVISIONING');
  return demoId;
}

describe('a demo left in PROVISIONING', () => {
  it('past the margin is moved to FAILED, with its term carried on unchanged', async () => {
    const demoId = await provisioning();
    const before = await provisioner.currentState(demoId);

    const swept = await provisioner.sweepStaleProvisioning(0);

    expect(swept).toContain(demoId);
    const after = await provisioner.currentState(demoId);
    expect(after?.toState).toBe('FAILED');
    expect(after?.fromState).toBe('PROVISIONING');
    expect(after?.leaseEndsAt).toEqual(before?.leaseEndsAt);
  });

  it('inside the margin is left alone', async () => {
    const demoId = await provisioning();

    const swept = await provisioner.sweepStaleProvisioning(3600);

    expect(swept).not.toContain(demoId);
    expect((await provisioner.currentState(demoId))?.toState).toBe('PROVISIONING');
  });

  it('that moved on before the sweep is not swept', async () => {
    const demoId = await provisioning();
    await provisioner.transition(demoId, 'LIVE');

    const swept = await provisioner.sweepStaleProvisioning(0);

    expect(swept).not.toContain(demoId);
    expect((await provisioner.currentState(demoId))?.toState).toBe('LIVE');
  });

  it('keeps its slot: the hostname is unretired, so admit still counts it', async () => {
    // Fill every slot with a claimed demo that holds a hostname, then leave one
    // of them in PROVISIONING and let the sweep fail it.
    const holders: string[] = [];
    for (let slot = 0; slot < SLOT_COUNT; slot += 1) {
      const { demoId } = await prospect.submit(request());
      await provisioner.beginDemo(demoId);
      expect((await provisioner.admit(demoId)).state).toBe('CLAIMED');
      await provisioner.allocateHostname(demoId);
      holders.push(demoId);
    }
    const stuck = holders[0]!;
    await provisioner.transition(stuck, 'PROVISIONING');

    const swept = await provisioner.sweepStaleProvisioning(0);

    expect(swept).toEqual([stuck]);
    expect((await provisioner.currentState(stuck))?.toState).toBe('FAILED');
    expect(await provisioner.hostname(stuck)).not.toBeNull();
    // A new request finds all six slots still held: the failed demo counts.
    const { demoId: late } = await prospect.submit(request());
    await provisioner.beginDemo(late);
    expect((await provisioner.admit(late)).state).toBe('WAITING');
  });
});

describe('the sweep', () => {
  it('refuses a margin that is negative or not finite', async () => {
    await expect(provisioner.sweepStaleProvisioning(-1)).rejects.toThrow(RangeError);
    await expect(provisioner.sweepStaleProvisioning(Number.NaN)).rejects.toThrow(RangeError);
    await expect(provisioner.sweepStaleProvisioning(Number.POSITIVE_INFINITY)).rejects.toThrow(
      RangeError
    );
  });

  it('touches no demo that is not in PROVISIONING', async () => {
    const demoId = randomUUID();
    await provisioner.beginDemo(demoId);
    await provisioner.transition(demoId, 'CLAIMED');
    const state: DemoState | undefined = (await provisioner.currentState(demoId))?.toState;

    const swept = await provisioner.sweepStaleProvisioning(0);

    expect(swept).not.toContain(demoId);
    expect((await provisioner.currentState(demoId))?.toState).toBe(state);
  });
});
