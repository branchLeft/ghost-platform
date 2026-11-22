import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProspectDb } from 'ghost-platform-portal-data/prospect';
import { ProvisionerDb } from 'ghost-platform-portal-data/provisioner';
import { createFixture, type Fixture } from '../../data/test/helpers.js';
import { endShiftSeconds } from '../../data/test/demoHelpers.js';
import { FIELDS, type ExtensionChoices } from '../src/frontdoor/extensionPage.js';
import {
  handleExtension,
  type ExtensionDeps,
  type ExtensionRequest,
} from '../src/frontdoor/extensionRoute.js';

// The extension route against the real roles and tables: the front door's own
// role records the request, the lifecycle worker's role grants it, and the
// term is read back from the lifecycle table.
let fixture: Fixture;
let prospect: ProspectDb;
let provisioner: ProvisionerDb;
let deps: ExtensionDeps;

const CHOICES: ExtensionChoices = {
  audienceSizes: [{ slug: 'audience-small', label: 'AUDIENCE_SMALL_LABEL' }],
  moveWhen: [{ slug: 'move-soon', label: 'MOVE_SOON_LABEL' }],
};
const CONTACT = { address: 'hello@example.test', bookingUrl: 'https://book.example.test/call' };

beforeAll(async () => {
  fixture = await createFixture();
  prospect = new ProspectDb(fixture.prospect);
  provisioner = new ProvisionerDb(fixture.provisioner);
  deps = {
    ports: {
      requestExtension: (a, i) => prospect.requestExtension(a, i),
      grantExtension: (d) => provisioner.grantExtension(d),
    },
    contact: CONTACT,
    choices: CHOICES,
  };
}, 60000);

afterAll(async () => {
  await fixture.close();
});

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

const FORM = {
  [FIELDS.stillEvaluating]: 'EVALUATING_ANSWER',
  [FIELDS.whatIsMissing]: 'MISSING_ANSWER',
  [FIELDS.audienceSize]: 'audience-small',
  [FIELDS.chargesReaders]: 'no',
  [FIELDS.moveWhen]: 'move-soon',
  [FIELDS.consent]: 'yes',
};

function post(
  address: string | undefined,
  fields: Record<string, string | undefined> = FORM
): ExtensionRequest {
  return { method: 'POST', verifiedAddress: address, fields };
}

describe('GET /extension', () => {
  it('shows the form with the booking link and address to a signed-in prospect', async () => {
    const { address } = await liveDemo();
    const response = await handleExtension(
      { method: 'GET', verifiedAddress: address, fields: {} },
      deps
    );
    expect(response.status).toBe(200);
    expect(response.body).toContain('href="https://book.example.test/call"');
  });

  it('asks for sign-in with nobody signed in, and refuses other methods', async () => {
    expect(
      (await handleExtension({ method: 'GET', verifiedAddress: undefined, fields: {} }, deps))
        .status
    ).toBe(401);
    expect(
      (
        await handleExtension(
          { method: 'PUT', verifiedAddress: 'a@example.invalid', fields: {} },
          deps
        )
      ).status
    ).toBe(405);
  });
});

describe('POST /extension', () => {
  it('records a consented request with the wording shown and moves the expiry by 14 days', async () => {
    const { address, demoId } = await liveDemo();
    const before = (await provisioner.history(demoId)).length;
    const response = await handleExtension(post(address), deps);
    expect(response.status).toBe(200);
    expect(response.body).toContain('EXTENSION_GRANTED_HEADING');
    expect(response.body).toContain('href="https://book.example.test/call"');
    const stored = await provisioner.extensionRequest(demoId);
    expect(stored?.consentWording).toBe('EXTENSION_CONSENT_WORDING');
    expect(stored?.consentedAt).toBeInstanceOf(Date);
    expect(await endShiftSeconds(fixture.adminDb, demoId, before, before + 1)).toBe(14 * 24 * 3600);
    expect((await provisioner.currentState(demoId))?.toState).toBe('EXTENDED');
  });

  it('refuses a request without consent, records nothing and moves nothing', async () => {
    const { address, demoId } = await liveDemo();
    const history = await provisioner.history(demoId);
    for (const consent of [undefined, '', 'no']) {
      const response = await handleExtension(
        post(address, { ...FORM, [FIELDS.consent]: consent }),
        deps
      );
      expect(response.status).toBe(422);
      expect(response.body).toContain('EXTENSION_CONSENT_REQUIRED_MESSAGE');
    }
    expect(await provisioner.extensionRequest(demoId)).toBeUndefined();
    expect(await provisioner.history(demoId)).toEqual(history);
  });

  it('takes the wording from the server: a wording the browser sends is ignored', async () => {
    const { address, demoId } = await liveDemo();
    await handleExtension(
      post(address, { ...FORM, consent_wording: 'WORDING_FROM_THE_BROWSER' }),
      deps
    );
    expect((await provisioner.extensionRequest(demoId))?.consentWording).toBe(
      'EXTENSION_CONSENT_WORDING'
    );
  });

  it('refuses an answer off the lists with the form and records nothing', async () => {
    const { address, demoId } = await liveDemo();
    const response = await handleExtension(
      post(address, { ...FORM, [FIELDS.moveWhen]: 'never' }),
      deps
    );
    expect(response.status).toBe(422);
    expect(await provisioner.extensionRequest(demoId)).toBeUndefined();
  });

  it('answers a second request 409 with the call to book, and the term moves once', async () => {
    const { address, demoId } = await liveDemo();
    await handleExtension(post(address), deps);
    const again = await handleExtension(post(address), deps);
    expect(again.status).toBe(409);
    expect(again.body).toContain('EXTENSION_ALREADY_HEADING');
    expect(
      (await provisioner.history(demoId)).filter((event) => event.extensionDays > 0)
    ).toHaveLength(1);
  });

  it('records the request but gives no extension when the demo is not running, and says so', async () => {
    const { address, demoId } = await liveDemo();
    await provisioner.transition(demoId, 'FROZEN');
    const response = await handleExtension(post(address), deps);
    expect(response.status).toBe(409);
    expect(response.body).toContain('EXTENSION_NOT_GIVEN_HEADING');
    expect(response.body).toContain('href="https://book.example.test/call"');
    expect((await provisioner.currentState(demoId))?.toState).toBe('FROZEN');
  });

  it('answers 404 for an address with no demo', async () => {
    const response = await handleExtension(post(`nobody-${randomUUID()}@example.invalid`), deps);
    expect(response.status).toBe(404);
  });

  it('asks for sign-in with nobody signed in and calls neither port', async () => {
    const response = await handleExtension(post(undefined), deps);
    expect(response.status).toBe(401);
  });
});
