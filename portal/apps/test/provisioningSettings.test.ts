import { describe, expect, it } from 'vitest';
import { TENANT_B } from '../../data/test/helpers.js';
import { PromotionError, type PromotionRefusal } from '../src/tenant/promotionError.js';
import { requestPromotion, type PromotionOutcome } from '../src/tenant/provisioningSettings.js';
import { deadBaseUrl, settingsFor, startStub } from './promotionRig.js';

const OPEN_REQUEST = {
  request_id: '00000000-0000-4000-8000-000000000001',
  tenant_id: TENANT_B,
  demo_id: '00000000-0000-4000-8000-000000000002',
  tier: 'essentials',
  state: 'pending',
  requested_at: '2026-01-01T00:00:00.000Z',
  approval: null,
};

const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';

async function answerOf(
  status: number,
  body: unknown
): Promise<PromotionOutcome | PromotionRefusal> {
  const stub = await startStub(status, body);
  try {
    return await requestPromotion(settingsFor(stub.baseUrl), TENANT_B, 'essentials');
  } catch (error) {
    if (error instanceof PromotionError) return error.reason;
    throw error;
  } finally {
    await stub.close();
  }
}

describe('what the portal makes of each answer the contract (and a service that breaks it) can give', () => {
  it.each([
    ['the request, pending, for this tenant and tier', 201, OPEN_REQUEST, 'REQUESTED'],
    [
      'a request for another tenant',
      201,
      { ...OPEN_REQUEST, tenant_id: OTHER_TENANT },
      'UNEXPECTED_ANSWER',
    ],
    [
      'a request for the other tier',
      201,
      { ...OPEN_REQUEST, tier: 'professional-enquiry' },
      'UNEXPECTED_ANSWER',
    ],
    [
      'a request that is not pending',
      201,
      { ...OPEN_REQUEST, state: 'approved' },
      'UNEXPECTED_ANSWER',
    ],
    ['no demo', 404, { code: 'demo-not-found' }, 'NOT_PROMOTABLE'],
    ['a demo that cannot be promoted', 409, { code: 'demo-not-promotable' }, 'NOT_PROMOTABLE'],
    ['another request open', 409, { code: 'request-already-open' }, 'OTHER_REQUEST_OPEN'],
    ['a conflict it does not know', 409, { code: 'forbidden' }, 'UNEXPECTED_ANSWER'],
    ['a conflict with no code', 409, {}, 'UNEXPECTED_ANSWER'],
    ['a rejected request', 400, { status: 400, title: 'T' }, 'PROVISIONING_REFUSED'],
    ['no credential', 401, { code: 'unauthenticated' }, 'PROVISIONING_REFUSED'],
    ['a credential for another tenant', 403, { code: 'forbidden' }, 'PROVISIONING_REFUSED'],
    ['a server error', 500, { status: 500 }, 'PROVISIONING_UNREACHABLE'],
    ['a status the contract does not give', 418, {}, 'UNEXPECTED_ANSWER'],
  ] as const)('%s (%i) is %s', async (_name, status, body, expected) => {
    expect(await answerOf(status, body)).toBe(expected);
  });

  it('is unreachable when nothing listens', async () => {
    await expect(
      requestPromotion(settingsFor(await deadBaseUrl()), TENANT_B, 'essentials')
    ).rejects.toMatchObject({ name: 'PromotionError', reason: 'PROVISIONING_UNREACHABLE' });
  });

  it('asks for exactly the tenant, the tier and the credential it was given', async () => {
    const stub = await startStub(201, OPEN_REQUEST);
    try {
      await requestPromotion(settingsFor(stub.baseUrl), TENANT_B, 'essentials');
      expect(stub.seen).toEqual([`POST /tenants/${TENANT_B}/promotion-requests`]);
    } finally {
      await stub.close();
    }
  });
});
