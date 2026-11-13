import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createArfReader } from '../../src/arf/arfReader.js';
import { createDrainClient } from '../../src/drainClient.js';
import type { DsnMailbox, RawDsn } from '../../src/dsnMailbox.js';
import { createLogger } from '../../src/log.js';
import { encodeOutcomeMessageId } from '../../src/outcomeId.js';
import { createOutcomeRunner } from '../../src/outcomeRunner.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';

const TOKEN = 'test-drain-token';
const MSG = '4cfbf575-9efc-4508-bc4f-e0f9314e4844';
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'arf');
const arf = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

const reader = createArfReader({
  trustedAuthservId: 'mx1.collector.example',
  sources: [{ name: 'example-fbl', dkimDomains: ['feedback-provider.example'] }],
});

function memoryMailbox(items: RawDsn[]) {
  const processed: string[] = [];
  const mailbox: DsnMailbox = {
    async list() {
      return items.filter((i) => !processed.includes(i.ref));
    },
    async markProcessed(ref) {
      processed.push(ref);
    },
  };
  return { mailbox, processed };
}

function dsnFor(messageId: string): string {
  return [
    'Authentication-Results: mx1.collector.example 1; spf=pass',
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx1.example.invalid',
    '',
    'Final-Recipient: rfc822; r@example.com',
    'Action: failed',
    'Status: 5.1.1',
    '',
    '--B',
    'Content-Type: text/rfc822-headers',
    '',
    `Message-ID: ${messageId}`,
    '',
    '--B--',
    '',
  ].join('\r\n');
}

describe('outcomeRunner with a complaint reader', () => {
  let shim: FakeShimServer;
  let baseUrl: string;

  beforeEach(async () => {
    shim = new FakeShimServer(TOKEN);
    shim.outcomesEnabled = true;
    baseUrl = await shim.listen();
  });

  afterEach(async () => {
    await shim.close();
  });

  const runnerFor = (mailbox: DsnMailbox, withReader: boolean) =>
    createOutcomeRunner({
      mailbox,
      store: createFakeTargetStore([{ id: 'tenant-a', baseUrl, route: 'mx1' }]),
      drainClient: createDrainClient({ drainToken: TOKEN, drainTimeoutMs: 5000 }),
      log: createLogger(() => {}),
      trustedAuthservId: 'mx1.collector.example',
      ...(withReader ? { complaintReader: reader } : {}),
    });

  it('reports a trustworthy complaint to the spool it names as a complained outcome, then retires it', async () => {
    const { mailbox, processed } = memoryMailbox([
      {
        ref: 'c.eml',
        receivedAtMs: Date.parse('2026-11-10T09:00:10Z'),
        raw: arf('abuse-full-original.eml'),
      },
    ]);
    const result = await runnerFor(mailbox, true).runOnce();
    expect(result).toEqual({ reported: 1, retired: 1, left: 0 });
    expect(shim.outcomeRequests).toEqual([[{ id: MSG, drainCount: 1, outcome: 'complained' }]]);
    expect(processed).toEqual(['c.eml']);
  });

  it('carries no address, no source and no provider text to the spool: the id and generation decide who is suppressed', async () => {
    const { mailbox } = memoryMailbox([
      {
        ref: 'c.eml',
        receivedAtMs: Date.parse('2026-11-10T09:00:10Z'),
        raw: arf('abuse-full-original.eml'),
      },
    ]);
    await runnerFor(mailbox, true).runOnce();
    expect(JSON.stringify(shim.outcomeRequests)).not.toMatch(
      /reader|example\.com|feedback-provider/
    );
  });

  it('retires without reporting a reversal, a spoof and an unreadable report, and still reads a DSN beside them', async () => {
    const spoof = arf('abuse-full-original.eml').split('\n').slice(1).join('\n');
    const { mailbox, processed } = memoryMailbox([
      { ref: 'notspam.eml', receivedAtMs: Date.now(), raw: arf('not-spam.eml') },
      { ref: 'spoof.eml', receivedAtMs: Date.now(), raw: spoof },
      {
        ref: 'cut.eml',
        receivedAtMs: Date.now(),
        raw: arf('abuse-full-original.eml').slice(0, 900),
      },
      {
        ref: 'dsn.eml',
        receivedAtMs: Date.now(),
        raw: dsnFor(encodeOutcomeMessageId({ targetId: 'tenant-a', id: MSG, drainCount: 2 })),
      },
    ]);
    const result = await runnerFor(mailbox, true).runOnce();
    expect(result).toEqual({ reported: 1, retired: 4, left: 0 });
    expect(shim.outcomeRequests).toEqual([
      [{ id: MSG, drainCount: 2, outcome: 'failed', severity: 'permanent', message: '5.1.1' }],
    ]);
    expect(processed.sort()).toEqual(['cut.eml', 'dsn.eml', 'notspam.eml', 'spoof.eml']);
  });

  it('without a reader behaves exactly as before: the report is retired as not a DSN and nothing is reported', async () => {
    const { mailbox, processed } = memoryMailbox([
      { ref: 'c.eml', receivedAtMs: Date.now(), raw: arf('abuse-full-original.eml') },
    ]);
    const result = await runnerFor(mailbox, false).runOnce();
    expect(result).toEqual({ reported: 0, retired: 1, left: 0 });
    expect(shim.outcomeRequests).toEqual([]);
    expect(processed).toEqual(['c.eml']);
  });

  it('keeps a complaint when the spool has not opted in, so a later pass can still report it', async () => {
    shim.outcomesEnabled = false;
    const { mailbox, processed } = memoryMailbox([
      {
        ref: 'c.eml',
        receivedAtMs: Date.parse('2026-11-10T09:00:10Z'),
        raw: arf('abuse-full-original.eml'),
      },
    ]);
    const runner = runnerFor(mailbox, true);
    expect(await runner.runOnce()).toEqual({ reported: 0, retired: 0, left: 1 });
    expect(processed).toEqual([]);
    shim.outcomesEnabled = true;
    expect(await runner.runOnce()).toEqual({ reported: 1, retired: 1, left: 0 });
  });

  it('never hands a feedback report to the DSN parser, even one that also quotes a delivery-status part', async () => {
    const poisoned = arf('abuse-full-original.eml').replace(
      'Body of the original message that the provider quoted.',
      'Content-Type: message/delivery-status\n\nAction: failed\nStatus: 5.1.1\n\n--x\nMessage-ID: <' +
        `${MSG}.9@74656e616e742d61.outcomes.invalid>`
    );
    const { mailbox } = memoryMailbox([
      { ref: 'p.eml', receivedAtMs: Date.parse('2026-11-10T09:00:10Z'), raw: poisoned },
    ]);
    await runnerFor(mailbox, true).runOnce();
    expect(shim.outcomeRequests).toEqual([[{ id: MSG, drainCount: 1, outcome: 'complained' }]]);
  });
});
