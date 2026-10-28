import { afterEach, describe, expect, it } from 'vitest';
import {
  FALLBACK_REFUSED,
  acceptedRows,
  backslashNameRows,
  fallbackAcceptedRows,
  refusedRows,
} from './helpers/boundSenderRows.js';
import { authPlain, rawSmtpCommands, startHarness, type Harness } from './helpers/smtpHarness.js';

// Its own file, so its own test isolate: every case starts a real front
// door, and the memory-bound streaming test in smtpFrontDoor.test.ts reads
// process-wide memory, which these cases would otherwise add to.

const DOMAIN = 'tenant-a.example.com';

describe('the SMTP front door queues the bound sender', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  function claim() {
    return harness.store.claimForDrain(Date.now() / 1000 + 1, 30, 10);
  }

  async function start(): Promise<void> {
    harness = await startHarness([
      [DOMAIN, 'key-a'],
      [FALLBACK_REFUSED.domain, 'key-l'],
    ]);
  }

  async function sendHeaderFrom(from: string): Promise<string[]> {
    await start();
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
    await start();
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
