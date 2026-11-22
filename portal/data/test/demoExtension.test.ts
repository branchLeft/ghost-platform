import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bind } from '../src/db.js';
import { ExtensionRefusedError } from '../src/demoLifecycle.js';
import {
  DemoExtensionExistsError,
  InvalidDemoExtensionError,
  NoDemoToExtendError,
  parseDemoExtension,
  type DemoExtensionInput,
} from '../src/demoExtension.js';
import { ProspectDb } from '../src/prospect/index.js';
import { ProvisionerDb } from '../src/provisioner/index.js';
import { demoExtensionRequest } from '../src/schema.js';
import { databaseClock, endShiftSeconds, refusal } from './demoHelpers.js';
import { createFixture, type Fixture } from './helpers.js';

// The extension request: the answers, the consent with its wording and the
// database's time, and the grant that moves the term by 14 days. The control
// case: a request without consent is refused and moves nothing.

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

const WORDING = 'EXTENSION_CONSENT_WORDING';
const PERMISSION_DENIED = '42501';
const CHECK_VIOLATION = '23514';

function answers(overrides: Partial<DemoExtensionInput> = {}): DemoExtensionInput {
  return {
    stillEvaluating: 'EVALUATING_ANSWER',
    whatIsMissing: 'MISSING_ANSWER',
    audienceSize: 'audience-small',
    chargesReaders: true,
    moveWhen: 'move-soon',
    consent: true,
    consentWording: WORDING,
    ...overrides,
  };
}

/** A prospect with a recorded request whose demo is LIVE; returns its address and demo id. */
async function liveDemo(): Promise<{ address: string; demoId: string }> {
  const address = `prospect-${randomUUID()}@example.invalid`;
  const { demoId } = await prospect.submit({
    verifiedSubject: `subject-of-${address}`,
    verifiedAddress: address,
    publicationName: 'PUBLICATION_NAME',
    newToGhost: true,
    outletType: 'outlet-type',
    consentWording: 'CONSENT_CONTACT_WORDING',
    explainerWording: 'SIGN_IN_LIMITATION_EXPLAINER',
  });
  await provisioner.beginDemo(demoId);
  await provisioner.transition(demoId, 'CLAIMED');
  await provisioner.allocateHostname(demoId);
  await provisioner.transition(demoId, 'PROVISIONING');
  await provisioner.transition(demoId, 'LIVE');
  return { address, demoId };
}

async function storedExtensions(demoId: string): Promise<unknown[]> {
  return fx.adminDb
    .select()
    .from(demoExtensionRequest)
    .where(sql`demo_id = ${demoId}`);
}

describe('parseDemoExtension', () => {
  it('takes a full answer and resolves an absent optional field to null', () => {
    expect(parseDemoExtension(answers({ whatIsMissing: undefined }))).toEqual({
      stillEvaluating: 'EVALUATING_ANSWER',
      whatIsMissing: null,
      audienceSize: 'audience-small',
      chargesReaders: true,
      moveWhen: 'move-soon',
      consentWording: WORDING,
    });
  });

  it.each([
    ['no consent', { consent: false }, 'consent'],
    ['consent that is not the boolean true', { consent: 'yes' as unknown as boolean }, 'consent'],
    ['no wording', { consentWording: '' }, 'consentWording'],
    ['nothing being evaluated', { stillEvaluating: '' }, 'stillEvaluating'],
    ['an audience size off the list', { audienceSize: 'audience-huge' }, 'audienceSize'],
    ['a move horizon off the list', { moveWhen: 'never' }, 'moveWhen'],
    ['a charges answer that is not a boolean', { chargesReaders: 'y' as never }, 'chargesReaders'],
    ['a control character', { whatIsMissing: 'a\u0000b' }, 'whatIsMissing'],
  ])('refuses %s naming the field and not the value', (_name, change, field) => {
    const error = (() => {
      try {
        parseDemoExtension(answers(change));
      } catch (caught) {
        return caught;
      }
      return undefined;
    })();
    expect(error).toBeInstanceOf(InvalidDemoExtensionError);
    expect((error as InvalidDemoExtensionError).field).toBe(field);
  });

  it('checks consent first: a request with no consent is refused whatever else is wrong', () => {
    expect(() => parseDemoExtension(answers({ consent: false, audienceSize: 'x' }))).toThrow(
      expect.objectContaining({ field: 'consent' })
    );
  });
});

describe('a request with consent', () => {
  it('is recorded with its answers, the wording shown and the database time', async () => {
    const { address, demoId } = await liveDemo();
    const before = await databaseClock(fx.adminDb);
    const result = await prospect.requestExtension(address, answers());
    const after = await databaseClock(fx.adminDb);
    expect(result).toEqual({ demoId });
    const read = await provisioner.extensionRequest(demoId);
    expect(read).toMatchObject({
      demoId,
      stillEvaluating: 'EVALUATING_ANSWER',
      whatIsMissing: 'MISSING_ANSWER',
      audienceSize: 'audience-small',
      chargesReaders: true,
      moveWhen: 'move-soon',
      consentWording: WORDING,
    });
    const stamped = read!.consentedAt.getTime();
    expect(stamped).toBeGreaterThanOrEqual(before - 1000);
    expect(stamped).toBeLessThanOrEqual(after + 1000);
  });

  it('is granted: the end of the term moves by 14 days and the demo is EXTENDED', async () => {
    const { address, demoId } = await liveDemo();
    await prospect.requestExtension(address, answers());
    const rowsBefore = (await provisioner.history(demoId)).length;
    const event = await provisioner.grantExtension(demoId);
    expect(event).toMatchObject({ fromState: 'LIVE', toState: 'EXTENDED', extensionDays: 14 });
    const rows = await provisioner.history(demoId);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(await endShiftSeconds(fx.adminDb, demoId, rowsBefore, rowsBefore + 1)).toBe(
      14 * 24 * 3600
    );
  });

  it('is one per demo: a second request for the same demo is refused', async () => {
    const { address, demoId } = await liveDemo();
    await prospect.requestExtension(address, answers());
    await expect(prospect.requestExtension(address, answers())).rejects.toThrow(
      DemoExtensionExistsError
    );
    expect(await storedExtensions(demoId)).toHaveLength(1);
  });

  it('is refused for an address with no demo request', async () => {
    await expect(
      prospect.requestExtension(`nobody-${randomUUID()}@example.invalid`, answers())
    ).rejects.toThrow(NoDemoToExtendError);
  });
});

describe('the control case: a request without consent is refused and moves nothing', () => {
  it('writes no row and leaves the term alone when the consent is not given', async () => {
    const { address, demoId } = await liveDemo();
    const history = await provisioner.history(demoId);
    await expect(prospect.requestExtension(address, answers({ consent: false }))).rejects.toThrow(
      InvalidDemoExtensionError
    );
    expect(await storedExtensions(demoId)).toEqual([]);
    expect(await provisioner.history(demoId)).toEqual(history);
  });

  it('refuses the grant for a demo with no request, and moves nothing', async () => {
    const { demoId } = await liveDemo();
    const history = await provisioner.history(demoId);
    const refused = await provisioner.grantExtension(demoId).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(ExtensionRefusedError);
    expect((refused as ExtensionRefusedError).reason).toBe('consent');
    expect(await provisioner.history(demoId)).toEqual(history);
  });

  it('refuses a row the database is handed with no wording, whoever sends it', async () => {
    const { address, demoId } = await liveDemo();
    const empty = await refusal(
      prospect.run(async (tx) => {
        await bind(tx, 'portal.prospect_address', address);
        await tx.insert(demoExtensionRequest).values({
          demoId,
          stillEvaluating: 'x',
          audienceSize: 'audience-small',
          chargesReaders: false,
          moveWhen: 'move-soon',
          consentWording: '',
        });
      })
    );
    expect(empty?.code).toBe(CHECK_VIOLATION);
    expect(await storedExtensions(demoId)).toEqual([]);
  });
});

describe('the grant keeps the lifecycle rules', () => {
  it('refuses a second grant: the one self-service extension is spent', async () => {
    const { address, demoId } = await liveDemo();
    await prospect.requestExtension(address, answers());
    await provisioner.grantExtension(demoId);
    await provisioner.transition(demoId, 'EXPIRING');
    const refused = await provisioner.grantExtension(demoId).catch((error: unknown) => error);
    expect((refused as ExtensionRefusedError).reason).toBe('spent');
  });

  it('refuses a grant outside LIVE or EXPIRING even with consent', async () => {
    const { address, demoId } = await liveDemo();
    await prospect.requestExtension(address, answers());
    await provisioner.transition(demoId, 'FROZEN');
    const refused = await provisioner.grantExtension(demoId).catch((error: unknown) => error);
    expect((refused as ExtensionRefusedError).reason).toBe('state');
  });
});

describe('what the roles may do with the table', () => {
  it('lets the front door file a request only for the demo of the address its transaction bound', async () => {
    const mine = await liveDemo();
    const theirs = await liveDemo();
    const denied = await refusal(
      prospect.run(async (tx) => {
        await bind(tx, 'portal.prospect_address', mine.address);
        await tx.insert(demoExtensionRequest).values({
          demoId: theirs.demoId,
          stillEvaluating: 'x',
          audienceSize: 'audience-small',
          chargesReaders: false,
          moveWhen: 'move-soon',
          consentWording: WORDING,
        });
      })
    );
    expect(denied?.code).toBe('42501');
    expect(await storedExtensions(theirs.demoId)).toEqual([]);
  });

  it('refuses a front-door insert with nothing bound', async () => {
    const { demoId } = await liveDemo();
    const denied = await refusal(
      prospect.run((tx) =>
        tx.insert(demoExtensionRequest).values({
          demoId,
          stillEvaluating: 'x',
          audienceSize: 'audience-small',
          chargesReaders: false,
          moveWhen: 'move-soon',
          consentWording: WORDING,
        })
      )
    );
    expect(denied?.code).toBe(PERMISSION_DENIED);
  });

  it('gives the front door no read, update or delete, and the lifecycle worker no write', async () => {
    const { address, demoId } = await liveDemo();
    await prospect.requestExtension(address, answers());
    const attempts = {
      frontDoorRead: () => prospect.run((tx) => tx.select().from(demoExtensionRequest)),
      frontDoorUpdate: () =>
        prospect.run((tx) => tx.update(demoExtensionRequest).set({ chargesReaders: false })),
      frontDoorDelete: () => prospect.run((tx) => tx.delete(demoExtensionRequest)),
      workerUpdate: () =>
        provisioner.run((tx) => tx.update(demoExtensionRequest).set({ consentWording: 'CHANGED' })),
      workerDelete: () => provisioner.run((tx) => tx.delete(demoExtensionRequest)),
    };
    for (const [name, attempt] of Object.entries(attempts)) {
      expect([name, (await refusal(attempt()))?.code]).toEqual([name, PERMISSION_DENIED]);
    }
    expect(await storedExtensions(demoId)).toHaveLength(1);
  });
});
