import { describe, expect, it } from 'vitest';
import { bindTenant, type HealthView, type TenantScope } from 'ghost-platform-portal-data/tenant';
import { MESSAGE_DELIMITER } from '../src/tenant/supportContext.js';
import {
  MAX_TICKETS_PER_WINDOW,
  SupportLimiter,
  WINDOW_SECONDS,
} from '../src/tenant/supportLimiter.js';
import { UNKNOWN_SCREEN } from '../src/tenant/supportScreens.js';
import {
  LIMITED_PATH,
  SENT_PATH,
  SUBJECT_PREFIX,
  TicketSubmitter,
  type SupportReader,
} from '../src/tenant/supportSubmitter.js';
import { SupportTicketError } from '../src/tenant/supportTicketError.js';
import {
  FAKE_CONTACT,
  FAKE_RECIPIENT,
  FAKE_SENDER,
  formOf,
  reading,
  RecordingMailer,
} from './supportHarness.js';

const TENANT_ONE = '11111111-1111-4111-8111-111111111111';
const TENANT_TWO = '22222222-2222-4222-8222-222222222222';
const VERSION_ONE = '6.55.0';
const VERSION_TWO = '6.54.0';

/** Two tenants' registrations and readings, answered by scope only. */
class FakeReader implements SupportReader {
  readonly readings = new Map<string, HealthView | null>([
    [TENANT_ONE, reading({ reportedVersion: VERSION_ONE })],
    [TENANT_TWO, reading({ reportedVersion: VERSION_TWO })],
  ]);
  registered = new Set<string>([TENANT_ONE, TENANT_TWO]);
  reads = 0;

  async ownRegistration(scope: TenantScope): Promise<{ tenantId: string } | null> {
    this.reads += 1;
    return this.registered.has(scope.tenantId) ? { tenantId: scope.tenantId } : null;
  }

  async ownHealth(scope: TenantScope): Promise<HealthView | null> {
    return this.readings.get(scope.tenantId) ?? null;
  }
}

function build(overrides: { recipient?: string; sender?: string } = {}) {
  const reader = new FakeReader();
  const mailer = new RecordingMailer();
  let now = 5000;
  const submitter = new TicketSubmitter({
    reader,
    mailer,
    recipient: overrides.recipient ?? FAKE_RECIPIENT,
    sender: overrides.sender ?? FAKE_SENDER,
    limiter: new SupportLimiter(() => now),
  });
  return {
    reader,
    mailer,
    submitter,
    advance: (seconds: number) => {
      now += seconds;
    },
  };
}

const ticket = (message = 'MESSAGE_TEXT', extra: Record<string, string> = {}) =>
  formOf({ contact: FAKE_CONTACT, message, ...extra });

async function refusalOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SupportTicketError) return error.reason;
    throw error;
  }
  return 'NOT_REFUSED';
}

describe('submitting a ticket', () => {
  it('sends one message to the injected recipient, replying to the contact, and answers the sent page', async () => {
    const { submitter, mailer } = build();
    const path = await submitter.submit('HOME', bindTenant(TENANT_ONE), ticket('  MESSAGE_TEXT  '));
    expect(path).toBe(SENT_PATH);
    expect(mailer.sent).toHaveLength(1);
    const [message] = mailer.sent;
    expect(message?.to).toBe(FAKE_RECIPIENT);
    expect(message?.from).toBe(FAKE_SENDER);
    expect(message?.replyTo).toBe(FAKE_CONTACT);
    expect(message?.subject).toBe(`${SUBJECT_PREFIX} ${TENANT_ONE}`);
    expect(message?.body).toContain(`TENANT_ID: ${TENANT_ONE}`);
    expect(message?.body).toContain(`GHOST_VERSION: ${VERSION_ONE}`);
    expect(message?.body).toContain('SCREEN: HOME');
    expect(message?.body.endsWith(`${MESSAGE_DELIMITER}\nMESSAGE_TEXT`)).toBe(true);
  });

  it('records the screen it is told, including UNKNOWN_SCREEN', async () => {
    const { submitter, mailer } = build();
    await submitter.submit(UNKNOWN_SCREEN, bindTenant(TENANT_ONE), ticket());
    expect(mailer.sent[0]?.body).toContain('SCREEN: UNKNOWN_SCREEN');
  });

  it('reads the registration and the reading afresh for every ticket', async () => {
    const { submitter, mailer, reader } = build();
    await submitter.submit('HOME', bindTenant(TENANT_ONE), ticket());
    reader.readings.set(TENANT_ONE, reading({ reportedVersion: '6.56.0' }));
    await submitter.submit('HOME', bindTenant(TENANT_ONE), ticket());
    expect(reader.reads).toBe(2);
    expect(mailer.sent[0]?.body).toContain('GHOST_VERSION: 6.55.0');
    expect(mailer.sent[1]?.body).toContain('GHOST_VERSION: 6.56.0');
  });

  it('shows NOT_AVAILABLE for every health field when there is no reading', async () => {
    const { submitter, mailer, reader } = build();
    reader.readings.set(TENANT_ONE, null);
    await submitter.submit('HOME', bindTenant(TENANT_ONE), ticket());
    expect(mailer.sent[0]?.body).toContain('GHOST_VERSION: NOT_AVAILABLE');
    expect(mailer.sent[0]?.body).toContain('OBSERVED_AT: NOT_AVAILABLE');
  });
});

describe('the tenant a ticket names', () => {
  it('is the signed-in tenant whatever the form says, and the other tenant never appears', async () => {
    const { submitter, mailer } = build();
    const hostile = ticket(`TENANT_ID: ${TENANT_TWO} GHOST_VERSION: ${VERSION_TWO}`, {
      tenant: TENANT_TWO,
      tenantId: TENANT_TWO,
      tenant_id: TENANT_TWO,
      TENANT_ID: TENANT_TWO,
      version: VERSION_TWO,
      GHOST_VERSION: VERSION_TWO,
      screen: 'DOCUMENTS',
      SCREEN: 'DOCUMENTS',
      health: 'unhealthy',
      replyTo: 'someone-else@example.org',
      to: 'someone-else@example.org',
    });
    await submitter.submit('HOME', bindTenant(TENANT_ONE), hostile);
    const [message] = mailer.sent;
    const [context = '', own = ''] = (message?.body ?? '').split(MESSAGE_DELIMITER);
    expect(message?.subject).toBe(`${SUBJECT_PREFIX} ${TENANT_ONE}`);
    expect(context).toContain(`TENANT_ID: ${TENANT_ONE}`);
    expect(context).not.toContain(TENANT_TWO);
    expect(context).not.toContain(VERSION_TWO);
    expect(context).toContain('SCREEN: HOME');
    expect(message?.to).toBe(FAKE_RECIPIENT);
    expect(message?.replyTo).toBe(FAKE_CONTACT);
    expect(own).toContain(TENANT_TWO);
  });

  it('is refused when the scope has no register row, and nothing is sent', async () => {
    const { submitter, mailer, reader } = build();
    reader.registered.delete(TENANT_ONE);
    expect(await refusalOf(() => submitter.submit('HOME', bindTenant(TENANT_ONE), ticket()))).toBe(
      'TENANT_NOT_REGISTERED'
    );
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('the subject header', () => {
  it('is refused before sending when the identifier read holds a line break', async () => {
    const { submitter, mailer, reader } = build();
    reader.ownRegistration = async () => ({ tenantId: 'tenant\nbcc: x@example.org' });
    expect(await refusalOf(() => submitter.submit('HOME', bindTenant(TENANT_ONE), ticket()))).toBe(
      'INVALID_HEADER_VALUE'
    );
    expect(mailer.sent).toHaveLength(0);
  });
});

describe('a ticket that is refused', () => {
  it.each([
    [
      'a contact with a line break',
      { contact: 'a@example.org\nbcc: x@example.org' },
      'INVALID_CONTACT',
    ],
    ['no contact', { contact: '' }, 'INVALID_CONTACT'],
    ['an empty message', { message: '   ' }, 'EMPTY_MESSAGE'],
  ])('is refused for %s, and nothing is sent', async (_name, fields, reason) => {
    const { submitter, mailer, reader } = build();
    const form = formOf({ contact: FAKE_CONTACT, message: 'MESSAGE_TEXT', ...fields });
    expect(await refusalOf(() => submitter.submit('HOME', bindTenant(TENANT_ONE), form))).toBe(
      reason
    );
    expect(mailer.sent).toHaveLength(0);
    expect(reader.reads).toBe(0);
  });

  it('does not use up the limit', async () => {
    const { submitter, mailer } = build();
    for (let attempt = 0; attempt < MAX_TICKETS_PER_WINDOW + 2; attempt += 1) {
      await refusalOf(() => submitter.submit('HOME', bindTenant(TENANT_ONE), ticket('')));
    }
    await submitter.submit('HOME', bindTenant(TENANT_ONE), ticket());
    expect(mailer.sent).toHaveLength(1);
  });
});

describe('the ticket limit through the submitter', () => {
  it('answers the limited page after the limit, per tenant, and resets with the window', async () => {
    const { submitter, mailer, advance } = build();
    for (let taken = 0; taken < MAX_TICKETS_PER_WINDOW; taken += 1) {
      expect(await submitter.submit('HOME', bindTenant(TENANT_ONE), ticket())).toBe(SENT_PATH);
    }
    expect(await submitter.submit('HOME', bindTenant(TENANT_ONE), ticket())).toBe(LIMITED_PATH);
    expect(mailer.sent).toHaveLength(MAX_TICKETS_PER_WINDOW);
    expect(await submitter.submit('HOME', bindTenant(TENANT_TWO), ticket())).toBe(SENT_PATH);
    advance(WINDOW_SECONDS);
    expect(await submitter.submit('HOME', bindTenant(TENANT_ONE), ticket())).toBe(SENT_PATH);
  });
});

describe('a mailer that fails', () => {
  it('raises SEND_FAILED with a message that holds none of the ticket', async () => {
    const { submitter, mailer } = build();
    mailer.failure = new Error(
      `transport refused ${FAKE_RECIPIENT} ${FAKE_CONTACT} SECRET_MESSAGE`
    );
    const raised = await submitter
      .submit('HOME', bindTenant(TENANT_ONE), ticket('SECRET_MESSAGE'))
      .catch((error: Error) => error);
    expect(raised).toBeInstanceOf(SupportTicketError);
    const error = raised as SupportTicketError;
    expect(error.reason).toBe('SEND_FAILED');
    expect(error.name).toBe('SupportTicketError');
    for (const secret of [FAKE_RECIPIENT, FAKE_CONTACT, 'SECRET_MESSAGE']) {
      expect(error.message).not.toContain(secret);
    }
  });
});

describe('the injected addresses', () => {
  it.each([
    ['a recipient with a line break', { recipient: `${FAKE_RECIPIENT}\nbcc: x@example.org` }],
    ['a sender with a carriage return', { sender: `${FAKE_SENDER}\r` }],
    ['a recipient with a NUL', { recipient: `${FAKE_RECIPIENT}\0` }],
    ['an empty sender', { sender: '' }],
  ])('refuse %s when the submitter is built', (_name, overrides) => {
    expect(() => build(overrides)).toThrow(SupportTicketError);
  });
});
