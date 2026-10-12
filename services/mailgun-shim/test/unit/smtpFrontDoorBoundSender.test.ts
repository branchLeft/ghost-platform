import { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSmtpFrontDoor,
  DEFAULT_ALLOWED_SOURCE_CIDRS,
  type SmtpFrontDoor,
} from '../../src/smtpFrontDoor.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';
import { createDrainWake } from '../../src/drainWake.js';
import { createTestLogger } from '../helpers/testLogger.js';
import {
  FALLBACK_REFUSED,
  acceptedRows,
  backslashNameRows,
  fallbackAcceptedRows,
  refusedRows,
} from './helpers/boundSenderRows.js';

// Its own file, so its own test isolate: every case starts a real front
// door, and the memory-bound streaming test in smtpFrontDoor.test.ts reads
// process-wide memory, which these cases would otherwise add to.

const DOMAIN = 'tenant-a.example.com';

interface Harness {
  store: ShimStore;
  frontDoor: SmtpFrontDoor;
  port: number;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const store = createSqliteStore(':memory:');
  store.registerTenant(DOMAIN, 'key-a', DOMAIN);
  store.registerTenant(FALLBACK_REFUSED.domain, 'key-l', FALLBACK_REFUSED.domain);
  const { logger } = createTestLogger();
  const frontDoor = createSmtpFrontDoor({
    store,
    wake: createDrainWake(),
    log: logger,
    maxMessageBytes: 1024 * 1024,
    maxRecipientsPerMessage: 50,
    maxUnauthenticatedConnectionsPerSource: 20,
    maxUnauthenticatedConnections: 20,
    maxUnauthenticatedPerSourceWaitQueueDepth: 50,
    maxUnauthenticatedPerSourceWaitMs: 2000,
    authDeadlineMs: 5000,
    maxConcurrentDataPhases: 20,
    maxConcurrentDataPhasesPerSubmitter: 5,
    allowedSourceCidrs: DEFAULT_ALLOWED_SOURCE_CIDRS,
    submitterMessagesPerMinute: 120,
  });
  const port = await frontDoor.listen(0, '127.0.0.1');
  return {
    store,
    frontDoor,
    port,
    async close() {
      await frontDoor.close();
      store.close();
    },
  };
}

/** A raw protocol script: each line is sent after the previous reply arrives. Returns every final reply line. */
function rawSmtpCommands(port: number, lines: string[]): Promise<string[]> {
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
    socket.connect(port, '127.0.0.1');
  });
}

function authPlain(user: string, key: string): string {
  return Buffer.from(`\u0000${user}\u0000${key}`).toString('base64');
}

describe('the SMTP front door queues the bound sender', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  function claim() {
    return harness.store.claimForDrain(Date.now() / 1000 + 1, 30, 10);
  }

  async function sendHeaderFrom(from: string): Promise<string[]> {
    harness = await startHarness();
    return rawSmtpCommands(harness.port, [
      'EHLO test',
      `AUTH PLAIN ${authPlain(DOMAIN, 'key-a')}`,
      `MAIL FROM:<noreply@${DOMAIN}>`,
      'RCPT TO:<member@example.com>',
      'DATA',
      `From: ${from}\r\nSubject: hi\r\n\r\nBody\r\n.`,
      'QUIT',
    ]);
  }

  async function sendEnvelopeOnly(user: string, key: string, mailFrom: string): Promise<string[]> {
    harness = await startHarness();
    return rawSmtpCommands(harness.port, [
      'EHLO test',
      `AUTH PLAIN ${authPlain(user, key)}`,
      `MAIL FROM:<${mailFrom}>`,
      'RCPT TO:<member@example.com>',
      'DATA',
      'To: member@example.com\r\nSubject: hi\r\n\r\nBody\r\n.',
      'QUIT',
    ]);
  }

  describe('header From', () => {
    it.each(acceptedRows(DOMAIN).map((row) => [row.id, row] as const))(
      'queues the normal form for %s',
      async (_id, row) => {
        const responses = await sendHeaderFrom(row.submitted);
        expect(responses.some((line) => /^250 .*Queued/.test(line))).toBe(true);
        const due = claim();
        expect(due).toHaveLength(1);
        expect(due[0]!.payload.from).toBe(row.queued);
      }
    );

    it.each(
      backslashNameRows(DOMAIN)
        .filter((row) => row.endsInBackslash)
        .map((row) => [row.id, row] as const)
    )('refuses %s with 550, and queues nothing', async (_id, row) => {
      const responses = await sendHeaderFrom(row.submitted);
      expect(responses.some((line) => /^550 /.test(line))).toBe(true);
      expect(harness.store.countUndrainedRecipients()).toBe(0);
    });

    it.each(refusedRows(DOMAIN).map((row) => [row.id, row] as const))(
      'refuses %s with 550, and queues nothing',
      async (_id, row) => {
        const responses = await sendHeaderFrom(row.submitted);
        expect(responses.some((line) => /^550 /.test(line))).toBe(true);
        expect(harness.store.countUndrainedRecipients()).toBe(0);
      }
    );
  });

  describe('no header From: the envelope sender', () => {
    it.each(fallbackAcceptedRows(DOMAIN).map((row) => [row.id, row] as const))(
      'queues the bound form of %s',
      async (_id, row) => {
        const responses = await sendEnvelopeOnly(DOMAIN, 'key-a', row.submitted);
        expect(responses.some((line) => /^250 .*Queued/.test(line))).toBe(true);
        const due = claim();
        expect(due).toHaveLength(1);
        expect(due[0]!.payload.from).toBe(row.queued);
      }
    );

    it('refuses an envelope value that is not a plain mailbox at MAIL FROM, and queues nothing', async () => {
      const responses = await sendEnvelopeOnly(
        FALLBACK_REFUSED.domain,
        'key-l',
        FALLBACK_REFUSED.submitted
      );
      expect(responses.some((line) => /^553 /.test(line))).toBe(true);
      expect(responses.some((line) => /^250 .*Queued/.test(line))).toBe(false);
      expect(harness.store.countUndrainedRecipients()).toBe(0);
    });
  });
});
