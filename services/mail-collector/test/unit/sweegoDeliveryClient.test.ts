import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WireMessage } from '../../src/drainClient.js';
import { SweegoSubmissionError, type SweegoFailureReason } from '../../src/sweegoFailure.js';
import { createSweegoDeliveryClient } from '../../src/sweegoDeliveryClient.js';
import type { SubmissionFailureKind } from '../../src/sendingTarget.js';
import {
  closedLoopbackPort,
  startFakeSweegoRelay,
  type FakeRelay,
  type RelayBehaviour,
} from '../helpers/fakeSweegoRelay.js';

const RELAY_USER = 'RELAY_USER_PLACEHOLDER';
const RELAY_PASS = 'relay-pass-7c1e9d-placeholder';

const MESSAGE: WireMessage = {
  id: 'msg-1',
  domain: 'tenant.example',
  emailId: null,
  from: 'noreply@tenant.example',
  to: 'reader@example.com',
  subject: 'A subject',
  html: '<p>body</p>',
  text: 'body',
  headers: { 'X-Test': 'yes' },
  drainCount: 1,
};

describe('Sweego delivery client against a fake relay', () => {
  let dir: string;
  let passFile: string;
  let relay: FakeRelay;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-sweego-'));
    passFile = join(dir, 'relay-credential');
    writeFileSync(passFile, `${RELAY_PASS}\n`, { mode: 0o600 });
    relay = await startFakeSweegoRelay(RELAY_USER, RELAY_PASS);
  });

  afterEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    await relay.close();
  });

  function client(overrides: { port?: number; passFile?: string; timeoutMs?: number } = {}) {
    return createSweegoDeliveryClient({
      host: '127.0.0.1',
      port: overrides.port ?? relay.port,
      secure: false,
      user: RELAY_USER,
      passFile: overrides.passFile ?? passFile,
      timeoutMs: overrides.timeoutMs ?? 5000,
      requireTls: false,
    });
  }

  async function failureOf(run: () => Promise<void>): Promise<SweegoSubmissionError> {
    try {
      await run();
    } catch (error) {
      expect(error).toBeInstanceOf(SweegoSubmissionError);
      return error as SweegoSubmissionError;
    }
    throw new Error('expected the submission to fail');
  }

  it('submits a drained message with the credential read from the file, trailing newline removed', async () => {
    await client().deliver(MESSAGE);
    expect(relay.logins).toEqual([{ user: RELAY_USER, pass: RELAY_PASS }]);
    expect(relay.accepted).toHaveLength(1);
    const accepted = relay.accepted[0]!;
    expect(accepted.subject).toBe(MESSAGE.subject);
    expect(accepted.headers.get('x-test')).toBe('yes');
  });

  it('reads the credential file for each message, so a rotated credential takes effect at once', async () => {
    const sender = client();
    await sender.deliver(MESSAGE);
    writeFileSync(passFile, 'a-rotated-credential\n');
    const error = await failureOf(() => sender.deliver(MESSAGE));
    expect(error.reason).toBe('auth');
    expect(relay.logins.at(-1)?.pass).toBe('a-rotated-credential');
  });

  it('refuses to send the credential over a connection it will not encrypt', async () => {
    // The relay offers no TLS, so a client that requires it never authenticates.
    const strict = createSweegoDeliveryClient({
      host: '127.0.0.1',
      port: relay.port,
      secure: false,
      user: RELAY_USER,
      passFile,
      timeoutMs: 5000,
    });
    await expect(strict.deliver(MESSAGE)).rejects.toBeInstanceOf(SweegoSubmissionError);
    expect(relay.logins).toEqual([]);
  });

  // Each row: how the relay (or the host) misbehaves, the reason the failure is
  // counted under, and what the resolver is told. `not-accepted` is what lets
  // login mail fall back to mx1; nothing else may.
  const CASES: Array<
    [string, RelayBehaviour, SweegoFailureReason, SubmissionFailureKind, number?]
  > = [
    ['login refused', { authReply: 535 }, 'auth', 'not-accepted', 535],
    ['a 4xx at MAIL', { mailFromReply: 451 }, 'deferred', 'not-accepted', 451],
    ['a 4xx at RCPT', { rcptReply: 450 }, 'deferred', 'not-accepted', 450],
    ['a 5xx at MAIL', { mailFromReply: 550 }, 'refused', 'not-accepted', 550],
    ['a 5xx at RCPT', { rcptReply: 550 }, 'recipient-rejected', 'recipient-rejected', 550],
    ['a 4xx at the DATA command', { dataCommandReply: 451 }, 'deferred', 'not-accepted', 451],
    ['a 5xx at the DATA command', { dataCommandReply: 554 }, 'refused', 'not-accepted', 554],
    ['a 4xx at the end of DATA', { dataReply: 451 }, 'ambiguous', 'ambiguous', 451],
    ['a 5xx at the end of DATA', { dataReply: 554 }, 'ambiguous', 'ambiguous', 554],
  ];

  it.each(CASES)('classes %s', async (_label, behaviour, reason, kind, smtpCode) => {
    relay.behaviour = behaviour;
    const error = await failureOf(() => client().deliver(MESSAGE));
    expect(error.reason).toBe(reason);
    expect(error.kind).toBe(kind);
    expect(error.smtpCode).toBe(smtpCode);
    expect(relay.accepted).toEqual([]);
  });

  it('classes a timeout once the message body is sent as a timeout: ambiguous, never a fallback', async () => {
    relay.behaviour = { hangAfterData: true };
    const error = await failureOf(() => client({ timeoutMs: 400 }).deliver(MESSAGE));
    expect(error.reason).toBe('timeout');
    expect(error.kind).toBe('ambiguous');
  });

  it('classes an unreadable or empty credential file as a non-acceptance, before any connection', async () => {
    const missing = await failureOf(() =>
      client({ passFile: join(dir, 'absent') }).deliver(MESSAGE)
    );
    expect(missing.reason).toBe('credential');
    expect(missing.kind).toBe('not-accepted');
    const emptyFile = join(dir, 'empty');
    writeFileSync(emptyFile, '\n');
    const empty = await failureOf(() => client({ passFile: emptyFile }).deliver(MESSAGE));
    expect(empty.reason).toBe('credential');
    expect(relay.logins).toEqual([]);
  });

  it('names no address, subject or credential in a failure, even when the relay echoes them', async () => {
    relay.behaviour = { rcptReply: 550 };
    const error = await failureOf(() => client().deliver(MESSAGE));
    const text = `${error.message}\n${error.stack ?? ''}\n${JSON.stringify(error)}`;
    for (const secret of [RELAY_PASS, RELAY_USER, MESSAGE.to, MESSAGE.subject, MESSAGE.from]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe('Sweego delivery client with nothing listening', () => {
  it('classes a refused connection as unreachable, a definite non-acceptance', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'collector-sweego-'));
    try {
      const passFile = join(dir, 'relay-credential');
      writeFileSync(passFile, RELAY_PASS);
      const sender = createSweegoDeliveryClient({
        host: '127.0.0.1',
        port: await closedLoopbackPort(),
        secure: false,
        user: RELAY_USER,
        passFile,
        timeoutMs: 2000,
        requireTls: false,
      });
      const error = await sender.deliver(MESSAGE).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(error).toBeInstanceOf(SweegoSubmissionError);
      expect((error as SweegoSubmissionError).reason).toBe('unreachable');
      expect((error as SweegoSubmissionError).kind).toBe('not-accepted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
