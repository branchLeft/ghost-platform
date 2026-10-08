import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrainClient } from '../../src/drainClient.js';
import type { DsnMailbox, RawDsn } from '../../src/dsnMailbox.js';
import { createLogger } from '../../src/log.js';
import { encodeOutcomeMessageId } from '../../src/outcomeId.js';
import { createOutcomeRunner } from '../../src/outcomeRunner.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';

const TOKEN = 'test-drain-token';
const MSG = '4cfbf575-9efc-4508-bc4f-e0f9314e4844';

function dsnFor(messageId: string, action: string, status: string, diagnostic?: string): string {
  return [
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx1.example.invalid',
    '',
    'Final-Recipient: rfc822; r@example.com',
    `Action: ${action}`,
    `Status: ${status}`,
    ...(diagnostic ? [`Diagnostic-Code: ${diagnostic}`] : []),
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

describe('outcomeRunner', () => {
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

  function runnerFor(mailbox: DsnMailbox, targets = [{ id: 'tenant-a', baseUrl }]) {
    return createOutcomeRunner({
      mailbox,
      store: createFakeTargetStore(targets),
      drainClient: createDrainClient({ drainToken: TOKEN, drainTimeoutMs: 5000 }),
      log: createLogger(() => {}),
    });
  }

  const idFor = (drainCount: number, targetId = 'tenant-a') =>
    encodeOutcomeMessageId({ targetId, id: MSG, drainCount });

  it('reports a delivered and a permanent failure to the spool that handed the message over, then retires both', async () => {
    const { mailbox, processed } = memoryMailbox([
      { ref: '1.eml', raw: dsnFor(idFor(1), 'delivered', '2.0.0') },
      {
        ref: '2.eml',
        raw: dsnFor(idFor(2), 'failed', '5.1.1', 'smtp; 550 5.1.1 no such user'),
      },
    ]);
    const result = await runnerFor(mailbox).runOnce();

    expect(result).toEqual({ reported: 2, retired: 2, left: 0 });
    expect(shim.outcomeRequests).toEqual([
      [
        { id: MSG, drainCount: 1, outcome: 'delivered' },
        {
          id: MSG,
          drainCount: 2,
          outcome: 'failed',
          severity: 'permanent',
          code: 550,
          message: 'smtp; 550 5.1.1 no such user',
        },
      ],
    ]);
    expect(processed).toEqual(['1.eml', '2.eml']);
  });

  it('reports nothing for a relayed notice, mail that is not a DSN, or a DSN for a Message-ID it did not mint, but retires them', async () => {
    const { mailbox, processed } = memoryMailbox([
      { ref: 'relayed.eml', raw: dsnFor(idFor(1), 'relayed', '2.0.0') },
      { ref: 'plain.eml', raw: 'Subject: hello\r\n\r\nhi' },
      { ref: 'foreign.eml', raw: dsnFor('<x@example.com>', 'failed', '5.1.1') },
    ]);
    const result = await runnerFor(mailbox).runOnce();
    expect(result).toEqual({ reported: 0, retired: 3, left: 0 });
    expect(shim.outcomeRequests).toEqual([]);
    expect(processed.sort()).toEqual(['foreign.eml', 'plain.eml', 'relayed.eml']);
  });

  it('leaves a notification in place when the spool has not opted in (404), so a later pass can still report it', async () => {
    shim.outcomesEnabled = false;
    const { mailbox, processed } = memoryMailbox([
      { ref: '1.eml', raw: dsnFor(idFor(1), 'delivered', '2.0.0') },
    ]);
    const runner = runnerFor(mailbox);
    expect(await runner.runOnce()).toEqual({ reported: 0, retired: 0, left: 1 });
    expect(processed).toEqual([]);

    shim.outcomesEnabled = true;
    expect(await runner.runOnce()).toEqual({ reported: 1, retired: 1, left: 0 });
  });

  it('leaves a notification for a spool the descriptor no longer names, and never invents an address for it', async () => {
    const { mailbox, processed } = memoryMailbox([
      { ref: '1.eml', raw: dsnFor(idFor(1, 'gone-tenant'), 'delivered', '2.0.0') },
    ]);
    expect(await runnerFor(mailbox).runOnce()).toEqual({ reported: 0, retired: 0, left: 1 });
    expect(shim.outcomeRequests).toEqual([]);
    expect(processed).toEqual([]);
  });

  it('survives an unreadable mailbox without throwing', async () => {
    const broken: DsnMailbox = {
      async list() {
        throw new Error('disk gone');
      },
      async markProcessed() {},
    };
    expect(await runnerFor(broken).runOnce()).toEqual({ reported: 0, retired: 0, left: 0 });
  });

  it('counts a notification as left when retiring it fails after the spool took the report', async () => {
    const mailbox: DsnMailbox = {
      async list() {
        return [{ ref: '1.eml', raw: dsnFor(idFor(1), 'delivered', '2.0.0') }];
      },
      async markProcessed() {
        throw new Error('read-only');
      },
    };
    expect(await runnerFor(mailbox).runOnce()).toEqual({ reported: 1, retired: 0, left: 1 });
  });

  it('batches per spool: two spools get one request each', async () => {
    const other = new FakeShimServer(TOKEN);
    other.outcomesEnabled = true;
    const otherUrl = await other.listen();
    const { mailbox } = memoryMailbox([
      { ref: '1.eml', raw: dsnFor(idFor(1, 'tenant-a'), 'delivered', '2.0.0') },
      { ref: '2.eml', raw: dsnFor(idFor(1, 'tenant-b'), 'delivered', '2.0.0') },
    ]);
    await runnerFor(mailbox, [
      { id: 'tenant-a', baseUrl },
      { id: 'tenant-b', baseUrl: otherUrl },
    ]).runOnce();
    expect(shim.outcomeRequests).toHaveLength(1);
    expect(other.outcomeRequests).toHaveLength(1);
    await other.close();
  });
});
