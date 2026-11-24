import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DemoState } from '../src/demoLifecycle.js';
import { DemoRequestExistsError, type DemoRequestInput } from '../src/demoRequest.js';
import type { DemoExtensionInput } from '../src/demoExtension.js';
import { ProspectDb } from '../src/prospect/index.js';
import { ProvisionerDb } from '../src/provisioner/index.js';
import { demoRequest } from '../src/schema.js';
import { createFixture, rejection, type Fixture } from './helpers.js';

// Once per address, except after FAILED. The table holds the rule through
// a partial unique index on the open claim; the lifecycle worker clears the
// claim in the transaction that records FAILED.

let fx: Fixture;
let prospect: ProspectDb;
let provisioner: ProvisionerDb;

beforeAll(async () => {
  fx = await createFixture();
  prospect = new ProspectDb(fx.prospect);
  provisioner = new ProvisionerDb(fx.provisioner);
}, 60000);

afterAll(async () => {
  await fx.close();
});

type OpenState = 'WAITING' | 'CLAIMED' | 'PROVISIONING' | 'LIVE' | 'KILLED' | 'FROZEN' | 'FAILED';

const PATH: Record<OpenState, readonly DemoState[]> = {
  WAITING: ['WAITING'],
  CLAIMED: ['CLAIMED'],
  PROVISIONING: ['CLAIMED', 'PROVISIONING'],
  LIVE: ['CLAIMED', 'PROVISIONING', 'LIVE'],
  KILLED: ['CLAIMED', 'KILLED'],
  FROZEN: ['CLAIMED', 'FROZEN'],
  FAILED: ['CLAIMED', 'PROVISIONING', 'FAILED'],
};

let counter = 0;
/** A request from an address no earlier test in this file has used. */
function request(address = `claim-${(counter += 1)}@example.invalid`): DemoRequestInput {
  return {
    verifiedSubject: `subject-${counter}`,
    verifiedAddress: address,
    publicationName: 'PUBLICATION_NAME',
    newToGhost: true,
    outletType: 'outlet-type',
    consentWording: 'CONSENT_CONTACT_WORDING',
    explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
  };
}

/** Records a request, then moves its demo along `steps`; returns the demo id. */
async function claim(address: string, steps: readonly DemoState[]): Promise<string> {
  const { demoId } = await prospect.submit(request(address));
  await provisioner.beginDemo(demoId);
  for (const step of steps) await provisioner.transition(demoId, step);
  return demoId;
}

const openClaim = async (demoId: string): Promise<boolean | undefined> =>
  (
    await fx.adminDb
      .select({ claimOpen: demoRequest.claimOpen })
      .from(demoRequest)
      .where(eq(demoRequest.demoId, demoId))
  )[0]?.claimOpen;

describe('a second request for an address while its earlier demo is open is refused', () => {
  it.each(Object.keys(PATH).filter((s) => s !== 'FAILED') as (keyof typeof PATH)[])(
    'refuses it while the earlier demo is %s',
    async (state) => {
      const address = `open-${state.toLowerCase()}-${randomUUID()}@example.invalid`;
      const demoId = await claim(address, PATH[state]);
      expect(await openClaim(demoId)).toBe(true);
      const error = await rejection(prospect.submit(request(address)));
      expect(error).toBeInstanceOf(DemoRequestExistsError);
    }
  );

  it('refuses it when the earlier demo has only been recorded, with no state yet moved', async () => {
    const { demoId } = await prospect.submit(request('recorded-only@example.invalid'));
    expect(await openClaim(demoId)).toBe(true);
    const error = await rejection(prospect.submit(request('recorded-only@example.invalid')));
    expect(error).toBeInstanceOf(DemoRequestExistsError);
  });
});

describe('an address whose earlier demo FAILED may request again', () => {
  it('accepts the second request once the earlier demo has recorded FAILED', async () => {
    const address = `after-failed-${randomUUID()}@example.invalid`;
    const first = await claim(address, PATH.FAILED);
    expect(await openClaim(first)).toBe(false);
    const second = await prospect.submit(request(address));
    expect(second.demoId).not.toBe(first);
    expect(await openClaim(second.demoId)).toBe(true);
  });

  it('clears the claim at FAILED, and not before', async () => {
    const address = `not-yet-failed-${randomUUID()}@example.invalid`;
    const { demoId } = await prospect.submit(request(address));
    await provisioner.beginDemo(demoId);
    await provisioner.transition(demoId, 'CLAIMED');
    await provisioner.transition(demoId, 'PROVISIONING');
    expect(await openClaim(demoId)).toBe(true);
    await provisioner.transition(demoId, 'FAILED');
    expect(await openClaim(demoId)).toBe(false);
  });

  it('refuses a third request while the second, which is open, stands after the first FAILED', async () => {
    const address = `third-${randomUUID()}@example.invalid`;
    await claim(address, PATH.FAILED);
    const second = await prospect.submit(request(address));
    expect(await openClaim(second.demoId)).toBe(true);
    const error = await rejection(prospect.submit(request(address)));
    expect(error).toBeInstanceOf(DemoRequestExistsError);
  });
});

describe('only the lifecycle worker may clear a claim, and only to false', () => {
  it('refuses the provisioner setting claim_open back to true', async () => {
    const address = `reopen-${randomUUID()}@example.invalid`;
    const demoId = await claim(address, PATH.FAILED);
    const error = await rejection(
      fx.provisioner.query('UPDATE portal.demo_request SET claim_open = true WHERE demo_id = $1', [
        demoId,
      ])
    );
    expect((error as { code?: string }).code).toBe('42501');
    expect(await openClaim(demoId)).toBe(false);
  });

  it('refuses the provisioner changing any other column of a request', async () => {
    const { demoId } = await prospect.submit(request());
    const error = await rejection(
      fx.provisioner.query(
        'UPDATE portal.demo_request SET new_to_ghost = false WHERE demo_id = $1',
        [demoId]
      )
    );
    expect((error as { code?: string }).code).toBe('42501');
  });
});

const WORDING = 'EXTENSION_CONSENT_WORDING';

function answers(): DemoExtensionInput {
  return {
    stillEvaluating: 'EVALUATING_ANSWER',
    whatIsMissing: 'MISSING_ANSWER',
    audienceSize: 'audience-small',
    chargesReaders: true,
    moveWhen: 'move-soon',
    consent: true,
    consentWording: WORDING,
  };
}

describe('a prospect whose earlier demo FAILED reads and extends the new request', () => {
  it('reads the second request, not the FAILED one, on the status page', async () => {
    const address = `status-${randomUUID()}@example.invalid`;
    await claim(address, PATH.FAILED);
    const second = await prospect.submit(request(address));
    expect((await prospect.ownRequest(address))?.demoId).toBe(second.demoId);
  });

  it('files the extension against the second demo, not the FAILED one', async () => {
    const address = `extend-${randomUUID()}@example.invalid`;
    await claim(address, PATH.FAILED);
    const second = await prospect.submit(request(address));
    const result = await prospect.requestExtension(address, answers());
    expect(result).toEqual({ demoId: second.demoId });
  });
});

describe('the front door cannot write the open claim', () => {
  it('refuses its insert of a request with claim_open false', async () => {
    const error = await rejection(
      fx.prospect.query(
        `INSERT INTO portal.demo_request (demo_id, verified_subject, verified_address,
           publication_name, new_to_ghost, outlet_type, consent_wording, explainer_wording, claim_open)
         VALUES ($1, 's', $2, 'p', true, 'o', 'c', 'e', false)`,
        [randomUUID(), `forged-${randomUUID()}@example.invalid`]
      )
    );
    expect((error as { code?: string }).code).toBe('42501');
  });

  it('still accepts its own insert with the default claim', async () => {
    await expect(prospect.submit(request())).resolves.toMatchObject({ demoId: expect.any(String) });
  });
});
