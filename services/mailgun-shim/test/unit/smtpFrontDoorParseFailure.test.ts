import { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

// mailparser's simpleParser is lenient in practice — it does not reject on
// malformed MIME in any input this suite could construct (verified: empty
// body, broken multipart boundaries and invalid encoded-words all parse
// without throwing). The onData catch path this front door defends with
// (log + a 5xx rather than an unhandled rejection) is real production
// behaviour for whatever future input mailparser itself does reject on, so
// it is exercised here by mocking the one call that can fail, in a file of
// its own so the mock never shadows the real parser for every other test.
const simpleParserMock = vi.fn(() => Promise.reject(new Error('mailparser blew up')));

vi.mock('mailparser', () => ({
  simpleParser: () => simpleParserMock(),
}));

import { createSmtpFrontDoor, type SmtpFrontDoor } from '../../src/smtpFrontDoor.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';
import type { WorkerHandle } from '../../src/worker.js';
import { createTestLogger } from '../helpers/testLogger.js';

function rawSmtpCommands(port: number, host: string, lines: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    const responses: string[] = [];
    let buffer = '';
    let step = 0;

    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split('\r\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        if (line === '') continue;
        if (/^\d{3}-/.test(line)) continue;
        responses.push(line);
        if (step < lines.length) {
          socket.write(lines[step] + '\r\n');
          step += 1;
        } else {
          socket.end();
        }
      }
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(responses));
    socket.connect(port, host);
  });
}

interface Harness {
  store: ShimStore;
  worker: WorkerHandle;
  frontDoor: SmtpFrontDoor;
  port: number;
  logs: ReturnType<typeof createTestLogger>['lines'];
}

async function startHarness(): Promise<Harness> {
  const store = createSqliteStore(':memory:');
  store.registerTenant('tenant-a.example.com', 'key-a');
  const worker: WorkerHandle = {
    kick: vi.fn(),
    whenIdle: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    status: () => ({ lastTickAt: null, stopped: false }),
  };
  const { logger, lines } = createTestLogger();

  const frontDoor = createSmtpFrontDoor({
    store,
    worker,
    log: logger,
    maxMessageBytes: 1024 * 1024,
    maxUnauthenticatedConnectionsPerSource: 20,
    maxUnauthenticatedConnections: 20,
    authDeadlineMs: 5000,
    maxConcurrentDataPhases: 20,
    maxConcurrentDataPhasesPerSubmitter: 5,
    submitterMessagesPerMinute: 120,
  });
  const port = 25000 + Math.floor(Math.random() * 10000);
  await frontDoor.listen(port, '127.0.0.1');

  return { store, worker, frontDoor, port, logs: lines };
}

async function submitOneMessage(port: number): Promise<string[]> {
  const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');
  return rawSmtpCommands(port, '127.0.0.1', [
    'EHLO test',
    `AUTH PLAIN ${authPlain}`,
    'MAIL FROM:<noreply@tenant-a.example.com>',
    'RCPT TO:<member@example.com>',
    'DATA',
    'Subject: hi\r\n\r\nbody\r\n.',
  ]);
}

describe('SMTP front door — a parser failure is logged and refused, not swallowed', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.frontDoor.close();
    harness?.store.close();
    simpleParserMock.mockReset();
    simpleParserMock.mockImplementation(() => Promise.reject(new Error('mailparser blew up')));
  });

  it('logs smtp_message_processing_failed and refuses the message when simpleParser rejects with an Error', async () => {
    harness = await startHarness();

    const responses = await submitOneMessage(harness.port);

    expect(responses.some((line) => /^[45]\d\d /.test(line))).toBe(true);
    expect(harness.logs.some((line) => line.event === 'smtp_message_processing_failed')).toBe(true);
    expect(harness.store.countPendingRecipients()).toBe(0);
    expect(harness.worker.kick).not.toHaveBeenCalled();
  });

  it('still logs and refuses cleanly when simpleParser rejects with a non-Error value', async () => {
    // mailparser's contract only promises the promise rejects — not that it
    // rejects with an Error instance. `err instanceof Error ? err : new
    // Error(...)` exists for exactly this case: a bare string or other
    // thrown value must still become a proper Error before nodemailer's
    // SMTP response writer sees it, not be passed through as-is.
    simpleParserMock.mockImplementation(() => Promise.reject('not an Error instance'));
    harness = await startHarness();

    const responses = await submitOneMessage(harness.port);

    expect(responses.some((line) => /^[45]\d\d /.test(line))).toBe(true);
    const failLine = harness.logs.find((line) => line.event === 'smtp_message_processing_failed');
    expect(failLine).toBeDefined();
    expect(failLine!.fields.error).toBe('not an Error instance');
    expect(harness.store.countPendingRecipients()).toBe(0);
  });
});
