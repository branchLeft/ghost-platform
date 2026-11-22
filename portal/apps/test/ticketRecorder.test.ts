import { describe, expect, it } from 'vitest';
import { TENANT_B } from '../../data/test/helpers.js';
import {
  createTicketRecorder,
  NO_RECORDER,
  recordTicket,
  TicketRecordError,
  type TicketRecordRefusal,
} from '../src/tenant/ticketRecorder.js';
import { deadBaseUrl, settingsFor, startStub } from './promotionRig.js';

const TICKET = {
  ticket_id: '00000000-0000-4000-9000-000000000001',
  tenant_id: TENANT_B,
  kind: 'support',
  state: 'new',
  contact: 'a@example.test',
  message: 'TEST_MESSAGE',
  request_id: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  history: [{ state: 'new', at: '2026-01-01T00:00:00.000Z' }],
};

const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
const TEXT = { contact: 'a@example.test', message: 'TEST_MESSAGE' };

async function answerOf(status: number, body: unknown): Promise<'RECORDED' | TicketRecordRefusal> {
  const stub = await startStub(status, body);
  try {
    await recordTicket(settingsFor(stub.baseUrl), TENANT_B, 'support', TEXT);
    return 'RECORDED';
  } catch (error) {
    if (error instanceof TicketRecordError) return error.reason;
    throw error;
  } finally {
    await stub.close();
  }
}

describe('what the portal makes of each answer the contract (and a service that breaks it) can give', () => {
  it.each([
    ['the ticket, new, for this tenant and kind', 201, TICKET, 'RECORDED'],
    [
      'a ticket for another tenant',
      201,
      { ...TICKET, tenant_id: OTHER_TENANT },
      'UNEXPECTED_ANSWER',
    ],
    [
      'a ticket of the other kind',
      201,
      { ...TICKET, kind: 'professional-enquiry' },
      'UNEXPECTED_ANSWER',
    ],
    ['a ticket that is not new', 201, { ...TICKET, state: 'open' }, 'UNEXPECTED_ANSWER'],
    ['the ticket limit', 409, { code: 'ticket-limit' }, 'LIMIT'],
    ['a conflict it does not know', 409, { code: 'forbidden' }, 'UNEXPECTED_ANSWER'],
    ['a rejected request', 400, { status: 400, title: 'T' }, 'REFUSED'],
    ['no credential', 401, { code: 'unauthenticated' }, 'REFUSED'],
    ['a credential for another tenant', 403, { code: 'forbidden' }, 'REFUSED'],
    ['a server error', 500, { status: 500 }, 'UNREACHABLE'],
    ['a status the contract does not give', 418, {}, 'UNEXPECTED_ANSWER'],
  ] as const)('%s (%i) is %s', async (_name, status, body, expected) => {
    expect(await answerOf(status, body)).toBe(expected);
  });

  it('is unreachable when nothing listens', async () => {
    await expect(
      recordTicket(settingsFor(await deadBaseUrl()), TENANT_B, 'support', TEXT)
    ).rejects.toMatchObject({ name: 'TicketRecordError', reason: 'UNREACHABLE' });
  });

  it('is refused, and asks nothing, when no credential was issued for the tenant', async () => {
    const stub = await startStub(201, TICKET);
    try {
      await expect(
        recordTicket(settingsFor(stub.baseUrl), OTHER_TENANT, 'support', TEXT)
      ).rejects.toMatchObject({ reason: 'NO_CREDENTIAL' });
      expect(stub.seen).toEqual([]);
    } finally {
      await stub.close();
    }
  });

  it('asks for exactly the tenant, the kind and the text it was given', async () => {
    const stub = await startStub(201, TICKET);
    try {
      await recordTicket(settingsFor(stub.baseUrl), TENANT_B, 'support', TEXT);
      expect(stub.seen).toEqual([`POST /tenants/${TENANT_B}/tickets`]);
    } finally {
      await stub.close();
    }
  });
});

describe('the recorder the portal uses', () => {
  it('holds nothing, and says nothing, when there is no provisioning API', async () => {
    const lines: string[] = [];
    const recorder = createTicketRecorder(undefined, (line) => lines.push(line));
    expect(recorder).toBe(NO_RECORDER);
    await recorder.record(TENANT_B, 'support', TEXT);
    expect(lines).toEqual([]);
  });

  it('never throws: a failure is one log line with the step and the error name only', async () => {
    const lines: string[] = [];
    const recorder = createTicketRecorder(settingsFor(await deadBaseUrl()), (line) =>
      lines.push(line)
    );
    await expect(recorder.record(TENANT_B, 'support', TEXT)).resolves.toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      event: 'portal.error',
      step: 'handler',
      error: 'TicketRecordError',
    });
    expect(lines[0]).not.toContain(TEXT.message);
    expect(lines[0]).not.toContain(TEXT.contact);
  });

  it('never throws with nobody listening for the line', async () => {
    const recorder = createTicketRecorder(settingsFor(await deadBaseUrl()));
    await expect(recorder.record(TENANT_B, 'support', TEXT)).resolves.toBeUndefined();
  });
});
