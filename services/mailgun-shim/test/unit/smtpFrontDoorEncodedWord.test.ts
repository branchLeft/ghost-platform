import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  acceptedEncodedWordRows,
  literalDomainRows,
  refusedEncodedWordRows,
} from './helpers/encodedWordRows.js';
import { authPlain, rawSmtpCommands, startHarness, type Harness } from './helpers/smtpHarness.js';

// Its own file, so its own test isolate: every case starts a real front
// door, and the memory-bound streaming test in smtpFrontDoor.test.ts reads
// process-wide memory, which these cases would otherwise add to.

const DOMAIN = 'tenant-a.example.com';

/** A real conversation: the envelope sender and the header From are given separately. */
function submit(harness: Harness, mailFrom: string, headerFrom?: string): Promise<string[]> {
  const from = headerFrom === undefined ? '' : `From: ${headerFrom}\r\n`;
  return rawSmtpCommands(harness.port, [
    'EHLO test',
    `AUTH PLAIN ${authPlain(DOMAIN, 'key-a')}`,
    `MAIL FROM:<${mailFrom}>`,
    'RCPT TO:<member@example.com>',
    'DATA',
    `${from}To: member@example.com\r\nSubject: hi\r\n\r\nBody\r\n.`,
    'QUIT',
  ]);
}

describe('the SMTP front door refuses encoded-word text in the sender', () => {
  // A refusal queues nothing, so one front door serves every row; a header
  // refusal comes after MAIL FROM, which counts against the rate, hence the high limit.
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness([[DOMAIN, 'key-a']], { submitterMessagesPerMinute: 100_000 });
  });

  afterAll(async () => {
    await harness.close();
  });

  it.each(
    [...refusedEncodedWordRows(DOMAIN), ...literalDomainRows(DOMAIN)].map(
      (row) => [row.id, row] as const
    )
  )('refuses %s as the header From with 550, and queues nothing', async (_id, row) => {
    const queuedBefore = harness.store.countUndrainedRecipients();
    const responses = await submit(harness, `noreply@${DOMAIN}`, row.submitted);
    expect(responses.some((line) => /^550 /.test(line))).toBe(true);
    expect(responses.some((line) => /^250 .*Queued/.test(line))).toBe(false);
    expect(harness.store.countUndrainedRecipients()).toBe(queuedBefore);
  });

  it.each(
    refusedEncodedWordRows(DOMAIN)
      .filter((row) => row.envelope)
      .map((row) => [row.id, row] as const)
  )(
    'refuses %s as the envelope sender at MAIL FROM with 553, and queues nothing',
    async (_id, row) => {
      const queuedBefore = harness.store.countUndrainedRecipients();
      const responses = await submit(harness, row.submitted);
      // Greeting, EHLO and AUTH precede the MAIL FROM reply.
      expect(responses[3]).toMatch(/^553 /);
      expect(responses.some((line) => /^354 /.test(line))).toBe(false);
      expect(harness.store.countUndrainedRecipients()).toBe(queuedBefore);
    }
  );
});

describe('the SMTP front door still queues a legitimate sender', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  it.each(acceptedEncodedWordRows(DOMAIN).map((row) => [row.id, row] as const))(
    'queues the normal form for %s as the header From',
    async (_id, row) => {
      harness = await startHarness([[DOMAIN, 'key-a']]);
      const responses = await submit(harness, `noreply@${DOMAIN}`, row.submitted);
      expect(responses.some((line) => /^250 .*Queued/.test(line))).toBe(true);
      const due = harness.store.claimForDrain(Date.now() / 1000 + 1, 30, 10);
      expect(due).toHaveLength(1);
      expect(due[0]!.payload.from).toBe(row.queuedSmtp);
    }
  );
});
