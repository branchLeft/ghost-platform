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
  FOREIGN_SUFFIX,
  URL_DELIMITERS,
  hostnameControlRows,
  mixedCase,
  nonHostnameRows,
} from './helpers/senderDomainRows.js';

// Its own file, so its own test isolate: every case here starts a real front
// door, and the memory-bound streaming test in smtpFrontDoor.test.ts reads
// process-wide heap, which these cases would otherwise add to.

interface Harness {
  store: ShimStore;
  frontDoor: SmtpFrontDoor;
  port: number;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const store = createSqliteStore(':memory:');
  store.registerTenant('tenant-a.example.com', 'key-a', 'tenant-a.example.com');
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

/**
 * A raw protocol script: each line is sent after the previous reply arrives,
 * so the crafted string reaches the server's own handlers un-normalised by a
 * client library. Returns every final reply line.
 */
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
        // Multi-line replies use "250-"; act only on the final line.
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

describe('SMTP front door — the sender is bound to the authenticated tenant', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  describe('the sender domain is compared as a hostname', () => {
    const TENANT = 'tenant-a.example.com';

    /**
     * A real conversation over the wire: the envelope sender and the
     * header From are given separately, so a row can be put in one place
     * while the other is legitimate. Returns every server reply.
     */
    function submit(
      user: string,
      pass: string,
      mailFrom: string,
      headerFrom: string
    ): Promise<string[]> {
      const authPlain = Buffer.from(`\u0000${user}\u0000${pass}`).toString('base64');
      return rawSmtpCommands(harness.port, '127.0.0.1', [
        'EHLO test',
        `AUTH PLAIN ${authPlain}`,
        `MAIL FROM:<${mailFrom}>`,
        'RCPT TO:<member@example.com>',
        'DATA',
        `From: ${headerFrom}\r\nTo: member@example.com\r\nSubject: Hi\r\n\r\nhi\r\n.`,
      ]);
    }

    const bareRows = (domain: string) =>
      nonHostnameRows(domain).filter((row) => row.label.endsWith('(bare)'));

    it.each(nonHostnameRows(TENANT))(
      'refuses $label as the header From with 550 and queues nothing',
      async ({ from }) => {
        harness = await startHarness();

        const responses = await submit(TENANT, 'key-a', `noreply@${TENANT}`, from);

        expect(responses.at(-1)).toMatch(/^550 /);
        expect(harness.store.countUndrainedRecipients()).toBe(0);
      }
    );

    it.each(bareRows(TENANT))(
      'refuses $label as the envelope sender (MAIL FROM) and queues nothing',
      async ({ from }) => {
        harness = await startHarness();

        const responses = await submit(TENANT, 'key-a', from, `noreply@${TENANT}`);

        // Greeting, EHLO and AUTH precede the MAIL FROM reply, which is a refusal.
        expect(responses[3]).toMatch(/^5\d\d /);
        // The message never reaches DATA: no 354 go-ahead was given.
        expect(responses.some((line) => /^354 /.test(line))).toBe(false);
        expect(harness.store.countUndrainedRecipients()).toBe(0);
      }
    );

    it.each(hostnameControlRows(TENANT))(
      'CONTROL: accepts $label as the header From and queues it',
      async ({ from }) => {
        harness = await startHarness();

        const responses = await submit(TENANT, 'key-a', `noreply@${TENANT}`, from);

        expect(responses.at(-1)).toMatch(/^250 /);
        expect(harness.store.countUndrainedRecipients()).toBe(1);
      }
    );

    // smtp-server's own grammar refuses a trailing root dot in MAIL FROM
    // before this front door sees it; the header From carries that row.
    it.each(
      hostnameControlRows(TENANT).filter(
        (row) => row.from.startsWith('alice@') && !row.label.includes('trailing root dot')
      )
    )(
      'CONTROL: accepts $label as the envelope sender (MAIL FROM) and queues it',
      async ({ from }) => {
        harness = await startHarness();

        const responses = await submit(TENANT, 'key-a', from, `noreply@${TENANT}`);

        expect(responses.at(-1)).toMatch(/^250 /);
        expect(harness.store.countUndrainedRecipients()).toBe(1);
      }
    );

    it('refuses a delimiter after the domain of a tenant registered at a subdomain', async () => {
      harness = await startHarness();
      const host = 'news.tenant-c.example.com';
      harness.store.registerTenant(host, 'key-c', host);

      for (const delimiter of URL_DELIMITERS) {
        const refused = await submit(
          host,
          'key-c',
          `noreply@${host}`,
          `alice@${host}${delimiter}${FOREIGN_SUFFIX}`
        );
        expect(refused.at(-1)).toMatch(/^550 /);
      }
      expect(harness.store.countUndrainedRecipients()).toBe(0);
    });

    it('CONTROL: a tenant registered at a subdomain is accepted in mixed case', async () => {
      harness = await startHarness();
      const host = 'news.tenant-c.example.com';
      harness.store.registerTenant(host, 'key-c', host);

      const accepted = await submit(host, 'key-c', `noreply@${host}`, `alice@${mixedCase(host)}`);

      expect(accepted.at(-1)).toMatch(/^250 /);
      expect(harness.store.countUndrainedRecipients()).toBe(1);
    });

    it('CONTROL: an internationalised sender domain written in its Unicode form is accepted as the header From', async () => {
      harness = await startHarness();
      const host = 'xn--strae-oqa.example';
      harness.store.registerTenant(host, 'key-idn', host);

      const responses = await submit(host, 'key-idn', `noreply@${host}`, 'alice@Straße.Example');

      expect(responses.at(-1)).toMatch(/^250 /);
      expect(harness.store.countUndrainedRecipients()).toBe(1);
    });
  });
});
