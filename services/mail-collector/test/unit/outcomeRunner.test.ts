import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrainClient } from '../../src/drainClient.js';
import type { DrainTarget } from '../../src/descriptorTargets.js';
import type { DsnMailbox, RawDsn } from '../../src/dsnMailbox.js';
import { createLogger } from '../../src/log.js';
import { signOutcomeMessageId } from '../../src/outcomeId.js';
import { createOutcomeRunner } from '../../src/outcomeRunner.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';
import { createFakeTargetStore } from '../helpers/fakeTargetStore.js';

const TOKEN = 'test-drain-token';
const MSG = '4cfbf575-9efc-4508-bc4f-e0f9314e4844';
const RECIPIENT = 'r@example.com';
// Generated per run: no key is committed.
const KEY = randomBytes(32).toString('hex');
// What mx1 stamps on every message it receives, a forger's included.
const MX1_STAMP = 'Authentication-Results: mx1.collector.example 1; spf=pass';

function dsnFor(
  messageId: string,
  action: string,
  status: string,
  diagnostic?: string,
  opts: { recipient?: string; headers?: string[] } = {}
): string {
  return [
    ...(opts.headers ?? []),
    'Content-Type: multipart/report; report-type=delivery-status; boundary="B"',
    '',
    '--B',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; mx1.example.invalid',
    '',
    `Final-Recipient: rfc822; ${opts.recipient ?? RECIPIENT}`,
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

  function runnerFor(
    mailbox: DsnMailbox,
    targets: DrainTarget[] = [{ id: 'tenant-a', baseUrl, route: 'mx1' }]
  ) {
    return createOutcomeRunner({
      mailbox,
      store: createFakeTargetStore(targets),
      drainClient: createDrainClient({ drainToken: TOKEN, drainTimeoutMs: 5000 }),
      log: createLogger(() => {}),
      messageIdKey: KEY,
    });
  }

  const idFor = (drainCount: number, targetId = 'tenant-a', recipient = RECIPIENT) =>
    signOutcomeMessageId({ targetId, id: MSG, drainCount }, recipient, KEY);

  it('reports a delivered and a permanent failure to the spool that handed the message over, then retires both', async () => {
    const { mailbox, processed } = memoryMailbox([
      { ref: '1.eml', receivedAtMs: Date.now(), raw: dsnFor(idFor(1), 'delivered', '2.0.0') },
      {
        ref: '2.eml',
        receivedAtMs: Date.now(),
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

  describe('a forged bounce, which mx1 stamps like any mail it receives', () => {
    const FORGED = ['failed', '5.1.1', 'smtp; 550 5.1.1 no such user'] as const;
    const stamped = { headers: [MX1_STAMP] };
    const unsignedId = `<${MSG}.1@${Buffer.from('tenant-a').toString('hex')}.outcomes.invalid>`;
    const signedId = (n: number) => idFor(n);

    async function ignoredWhenSent(raw: string): Promise<void> {
      const { mailbox, processed } = memoryMailbox([
        { ref: 'forged.eml', receivedAtMs: Date.now(), raw },
      ]);
      expect(await runnerFor(mailbox).runOnce()).toEqual({ reported: 0, retired: 1, left: 0 });
      expect(shim.outcomeRequests).toEqual([]);
      expect(processed).toEqual(['forged.eml']);
    }

    it('is ignored when it quotes a guessed, unsigned Message-ID', async () => {
      await ignoredWhenSent(dsnFor(unsignedId, ...FORGED, stamped));
    });

    it('is ignored when it quotes a guessed MAC', async () => {
      const guessed = `<${MSG}.1.${'0'.repeat(32)}@${Buffer.from('tenant-a').toString('hex')}.outcomes.invalid>`;
      await ignoredWhenSent(dsnFor(guessed, ...FORGED, stamped));
    });

    it('is ignored when it quotes a Message-ID signed for a different recipient', async () => {
      const other = idFor(1, 'tenant-a', 'someone-else@example.com');
      await ignoredWhenSent(dsnFor(other, ...FORGED, stamped));
    });

    it('is ignored when it names no recipient to check the MAC against', async () => {
      await ignoredWhenSent(
        dsnFor(signedId(1), ...FORGED, stamped).replace(/^Final-Recipient:.*\r\n/m, '')
      );
    });

    it('is ignored when the generation or the spool in the signed id was changed', async () => {
      const signed = signedId(1);
      await ignoredWhenSent(dsnFor(signed.replace('.1.', '.2.'), ...FORGED, stamped));
      await ignoredWhenSent(
        dsnFor(
          signed.replace(
            Buffer.from('tenant-a').toString('hex'),
            Buffer.from('tenant-b').toString('hex')
          ),
          ...FORGED,
          stamped
        )
      );
    });

    it.each([
      ['truncated', (id: string) => id.replace(/\.[0-9a-f]{32}@/, (m) => `${m.slice(0, 17)}@`)],
      [
        'one character short',
        (id: string) => id.replace(/\.[0-9a-f]{32}@/, (m) => `${m.slice(0, 32)}@`),
      ],
      ['one character long', (id: string) => id.replace(/\.([0-9a-f]{32})@/, '.$10@')],
      [
        'one nibble flipped',
        (id: string) =>
          id.replace(
            /\.([0-9a-f])([0-9a-f]{31})@/,
            (_m, a: string, b: string) => `.${a === '0' ? '1' : '0'}${b}@`
          ),
      ],
      [
        'upper-cased',
        (id: string) =>
          id.replace(/\.([0-9a-f]{32})@/, (_m, mac: string) => `.${mac.toUpperCase()}@`),
      ],
    ])('is ignored when the MAC is %s', async (_name, tamper) => {
      const tampered = tamper(signedId(1));
      expect(tampered).not.toBe(signedId(1));
      await ignoredWhenSent(dsnFor(tampered, ...FORGED, stamped));
    });

    it('is ignored when the id was signed with another key', async () => {
      const foreign = signOutcomeMessageId(
        { targetId: 'tenant-a', id: MSG, drainCount: 1 },
        RECIPIENT,
        randomBytes(32).toString('hex')
      );
      await ignoredWhenSent(dsnFor(foreign, ...FORGED, stamped));
    });

    it('is honoured when it quotes an id we signed for that recipient, with or without a stamp', async () => {
      const { mailbox, processed } = memoryMailbox([
        { ref: 'a.eml', receivedAtMs: Date.now(), raw: dsnFor(signedId(1), ...FORGED, stamped) },
        { ref: 'b.eml', receivedAtMs: Date.now(), raw: dsnFor(signedId(2), ...FORGED) },
      ]);
      expect(await runnerFor(mailbox).runOnce()).toEqual({ reported: 2, retired: 2, left: 0 });
      expect(shim.outcomeRequests[0]).toMatchObject([
        { id: MSG, drainCount: 1, outcome: 'failed', severity: 'permanent' },
        { id: MSG, drainCount: 2, outcome: 'failed', severity: 'permanent' },
      ]);
      expect(processed).toEqual(['a.eml', 'b.eml']);
    });

    it('is honoured when the report writes the recipient in another case', async () => {
      const raw = dsnFor(signedId(1), ...FORGED, { recipient: RECIPIENT.toUpperCase() });
      const { mailbox } = memoryMailbox([{ ref: 'a.eml', receivedAtMs: Date.now(), raw }]);
      expect(await runnerFor(mailbox).runOnce()).toEqual({ reported: 1, retired: 1, left: 0 });
    });
  });

  it('refuses to be built without a key long enough to be one', () => {
    const { mailbox } = memoryMailbox([]);
    expect(() =>
      createOutcomeRunner({
        mailbox,
        store: createFakeTargetStore([]),
        drainClient: createDrainClient({ drainToken: TOKEN, drainTimeoutMs: 5000 }),
        log: createLogger(() => {}),
        messageIdKey: 'short',
      })
    ).toThrow(/at least 32 characters/);
  });

  it('reports nothing for a relayed notice, mail that is not a DSN, or a DSN for a Message-ID it did not mint, but retires them', async () => {
    const { mailbox, processed } = memoryMailbox([
      { ref: 'relayed.eml', receivedAtMs: Date.now(), raw: dsnFor(idFor(1), 'relayed', '2.0.0') },
      { ref: 'plain.eml', receivedAtMs: Date.now(), raw: 'Subject: hello\r\n\r\nhi' },
      {
        ref: 'foreign.eml',
        receivedAtMs: Date.now(),
        raw: dsnFor('<x@example.com>', 'failed', '5.1.1'),
      },
    ]);
    const result = await runnerFor(mailbox).runOnce();
    expect(result).toEqual({ reported: 0, retired: 3, left: 0 });
    expect(shim.outcomeRequests).toEqual([]);
    expect(processed.sort()).toEqual(['foreign.eml', 'plain.eml', 'relayed.eml']);
  });

  it('leaves a notification in place when the spool has not opted in (404), so a later pass can still report it', async () => {
    shim.outcomesEnabled = false;
    const { mailbox, processed } = memoryMailbox([
      { ref: '1.eml', receivedAtMs: Date.now(), raw: dsnFor(idFor(1), 'delivered', '2.0.0') },
    ]);
    const runner = runnerFor(mailbox);
    expect(await runner.runOnce()).toEqual({ reported: 0, retired: 0, left: 1 });
    expect(processed).toEqual([]);

    shim.outcomesEnabled = true;
    expect(await runner.runOnce()).toEqual({ reported: 1, retired: 1, left: 0 });
  });

  it('leaves a notification for a spool the descriptor no longer names, and never invents an address for it', async () => {
    const { mailbox, processed } = memoryMailbox([
      {
        ref: '1.eml',
        receivedAtMs: Date.now(),
        raw: dsnFor(idFor(1, 'gone-tenant'), 'delivered', '2.0.0'),
      },
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
        return [
          { ref: '1.eml', receivedAtMs: Date.now(), raw: dsnFor(idFor(1), 'delivered', '2.0.0') },
        ];
      },
      async markProcessed() {
        throw new Error('read-only');
      },
    };
    expect(await runnerFor(mailbox).runOnce()).toEqual({ reported: 1, retired: 0, left: 1 });
  });

  it('keeps a notice the spool does not know yet (it beat the ack) and reports it on a later pass', async () => {
    shim.unknownOutcomeIds.add(MSG);
    const { mailbox, processed } = memoryMailbox([
      { ref: '1.eml', receivedAtMs: Date.now(), raw: dsnFor(idFor(1), 'delivered', '2.0.0') },
    ]);
    const runner = runnerFor(mailbox);

    expect(await runner.runOnce()).toEqual({ reported: 0, retired: 0, left: 1 });
    expect(processed).toEqual([]);

    shim.unknownOutcomeIds.clear();
    expect(await runner.runOnce()).toEqual({ reported: 1, retired: 1, left: 0 });
    expect(processed).toEqual(['1.eml']);
  });

  it('retires a notice the spool still calls unknown once it is older than the grace, so a stale generation cannot pile up forever', async () => {
    shim.unknownOutcomeIds.add(MSG);
    const arrived = Date.now();
    let clock = arrived;
    const { mailbox, processed } = memoryMailbox([
      { ref: '1.eml', receivedAtMs: arrived, raw: dsnFor(idFor(1), 'delivered', '2.0.0') },
    ]);
    const runner = createOutcomeRunner({
      mailbox,
      store: createFakeTargetStore([{ id: 'tenant-a', baseUrl, route: 'mx1' }]),
      drainClient: createDrainClient({ drainToken: TOKEN, drainTimeoutMs: 5000 }),
      log: createLogger(() => {}),
      messageIdKey: KEY,
      unknownGraceMs: 1000,
      now: () => clock,
    });

    expect((await runner.runOnce()).left).toBe(1);
    clock = arrived + 1001;
    expect(await runner.runOnce()).toEqual({ reported: 0, retired: 1, left: 0 });
    expect(processed).toEqual(['1.eml']);
  });

  it('batches per spool: two spools get one request each', async () => {
    const other = new FakeShimServer(TOKEN);
    other.outcomesEnabled = true;
    const otherUrl = await other.listen();
    const { mailbox } = memoryMailbox([
      {
        ref: '1.eml',
        receivedAtMs: Date.now(),
        raw: dsnFor(idFor(1, 'tenant-a'), 'delivered', '2.0.0'),
      },
      {
        ref: '2.eml',
        receivedAtMs: Date.now(),
        raw: dsnFor(idFor(1, 'tenant-b'), 'delivered', '2.0.0'),
      },
    ]);
    await runnerFor(mailbox, [
      { id: 'tenant-a', baseUrl, route: 'mx1' },
      { id: 'tenant-b', baseUrl: otherUrl, route: 'mx1' },
    ]).runOnce();
    expect(shim.outcomeRequests).toHaveLength(1);
    expect(other.outcomeRequests).toHaveLength(1);
    await other.close();
  });
});
