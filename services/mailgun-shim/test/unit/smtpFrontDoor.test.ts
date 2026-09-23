import { Socket } from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildSourceAllowList,
  createSmtpFrontDoor,
  createSubmitterLimiter,
  isAllowedSource,
  type SmtpFrontDoor,
} from '../../src/smtpFrontDoor.js';
import { createSqliteStore, type ShimStore } from '../../src/store.js';
import type { WorkerHandle } from '../../src/worker.js';
import { createTestLogger } from '../helpers/testLogger.js';

const DEFAULT_CIDRS = [
  '127.0.0.1/32',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
];

describe('buildSourceAllowList', () => {
  it('treats a bare address with no "/" prefix as a single host, not a range', () => {
    const allowList = buildSourceAllowList(['203.0.113.7']);
    expect(isAllowedSource('203.0.113.7', allowList)).toBe(true);
    expect(isAllowedSource('203.0.113.8', allowList)).toBe(false);
  });

  it('treats a bare IPv6 address with no "/" prefix as a single host, not a range', () => {
    const allowList = buildSourceAllowList(['2001:db8::1']);
    expect(isAllowedSource('2001:db8::1', allowList)).toBe(true);
    expect(isAllowedSource('2001:db8::2', allowList)).toBe(false);
  });
});

describe('buildSourceAllowList / isAllowedSource', () => {
  const allowList = buildSourceAllowList(DEFAULT_CIDRS);

  it.each<[string, string]>([
    ['127.0.0.1', 'IPv4 loopback'],
    ['::1', 'IPv6 loopback'],
    ['10.1.2.3', 'RFC1918 10/8'],
    ['172.20.0.5', 'RFC1918 172.16/12 (Docker bridge range)'],
    ['192.168.1.1', 'RFC1918 192.168/16'],
    ['fc00::1', 'ULA fc00::/7 (fc)'],
    ['fd12:3456::1', 'ULA fc00::/7 (fd)'],
    ['::ffff:10.0.0.5', 'IPv4-mapped IPv6 of a private address'],
  ])('allows %s (%s)', (address) => {
    expect(isAllowedSource(address, allowList)).toBe(true);
  });

  it.each<[string | undefined, string]>([
    ['8.8.8.8', 'public IPv4'],
    ['2001:db8::1', 'public/documentation IPv6'],
    ['::ffff:8.8.8.8', 'IPv4-mapped IPv6 of a public address'],
    [undefined, 'no remote address at all'],
    ['not-an-ip', 'garbage'],
  ])('refuses %s (%s)', (address) => {
    expect(isAllowedSource(address, allowList)).toBe(false);
  });
});

describe('createSubmitterLimiter', () => {
  it('allows up to the limit within a window, then blocks', () => {
    const limiter = createSubmitterLimiter(2, 1000, () => 0);
    expect(limiter.tryTake('tenant-a')).toBe(true);
    expect(limiter.tryTake('tenant-a')).toBe(true);
    expect(limiter.tryTake('tenant-a')).toBe(false);
  });

  it('resets once the window has elapsed', () => {
    let now = 0;
    const limiter = createSubmitterLimiter(1, 1000, () => now);
    expect(limiter.tryTake('tenant-a')).toBe(true);
    expect(limiter.tryTake('tenant-a')).toBe(false);
    now = 1000;
    expect(limiter.tryTake('tenant-a')).toBe(true);
  });

  it('keys per submitter identity — one tenant exhausting its bucket never touches another', () => {
    const limiter = createSubmitterLimiter(1, 1000, () => 0);
    expect(limiter.tryTake('tenant-a')).toBe(true);
    expect(limiter.tryTake('tenant-a')).toBe(false);
    expect(limiter.tryTake('tenant-b')).toBe(true);
  });
});

interface Harness {
  store: ShimStore;
  worker: WorkerHandle;
  frontDoor: SmtpFrontDoor;
  port: number;
  logs: ReturnType<typeof createTestLogger>['lines'];
  close(): Promise<void>;
}

async function startHarness(
  overrides: Partial<{
    allowedSourceCidrs: string[];
    submitterMessagesPerMinute: number;
    maxMessageBytes: number;
    host: string;
  }> = {}
): Promise<Harness> {
  const store = createSqliteStore(':memory:');
  store.registerTenant('tenant-a.example.com', 'key-a');
  store.registerTenant('tenant-b.example.com', 'key-b');

  const kick = vi.fn();
  const worker: WorkerHandle = {
    kick,
    whenIdle: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    status: () => ({ lastTickAt: null, stopped: false }),
  };

  const { logger, lines } = createTestLogger();

  const frontDoor = createSmtpFrontDoor({
    store,
    worker,
    log: logger,
    maxMessageBytes: overrides.maxMessageBytes ?? 1024 * 1024,
    allowedSourceCidrs: overrides.allowedSourceCidrs ?? DEFAULT_CIDRS,
    submitterMessagesPerMinute: overrides.submitterMessagesPerMinute ?? 120,
  });

  const port = 20000 + Math.floor(Math.random() * 20000);
  await frontDoor.listen(port, overrides.host ?? '127.0.0.1');

  return {
    store,
    worker,
    frontDoor,
    port,
    logs: lines,
    async close() {
      await frontDoor.close();
      store.close();
    },
  };
}

/**
 * A raw protocol script, bypassing nodemailer's own client-side address
 * normalisation — nodemailer's client resolves a group/list-syntax `to`
 * string to a plain address BEFORE it ever reaches the wire (the same
 * behaviour smtp.ts's own doc comment describes on the send side), so a
 * client-library-based test can never actually put the crafted string in
 * front of the server's RCPT TO handler. A raw socket can.
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
        // Multi-line responses use "250-"; only act once the final line
        // ("250 ") of a batch arrives.
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

function client(port: number, user: string, pass: string, host = '127.0.0.1') {
  return nodemailer.createTransport({
    host,
    port,
    secure: false,
    ignoreTLS: true,
    auth: { user, pass },
  });
}

describe('SMTP front door — acceptance into the durable queue', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  it('accepts an authenticated submission, enqueues it durably and kicks the worker', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    const info = await transport.sendMail({
      from: 'Tenant A <noreply@tenant-a.example.com>',
      to: 'member@example.com',
      subject: 'Your sign-in link',
      html: '<p>Click <a href="https://example.com">here</a></p>',
      text: 'Click here: https://example.com',
    });

    expect(info.accepted).toEqual(['member@example.com']);
    expect(harness.worker.kick).toHaveBeenCalledTimes(1);
    expect(harness.store.countPendingRecipients()).toBe(1);
  });

  it('the enqueued row carries the authenticated tenant as its domain, not anything from the message body', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await transport.sendMail({
      from: 'Someone Else <noreply@not-tenant-a.example>',
      to: 'member@example.com',
      subject: 'Hi',
      text: 'hi',
    });

    const due = harness.store.claimDueRecipients(Date.now() / 1000 + 1, 10);
    expect(due).toHaveLength(1);
    expect(due[0]!.domain).toBe('tenant-a.example.com');
  });

  it('carries subject/html/text through to the queued payload', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await transport.sendMail({
      from: 'Tenant A <noreply@tenant-a.example.com>',
      to: 'member@example.com',
      subject: 'Your sign-in link',
      html: '<p>hi</p>',
      text: 'hi',
    });

    const due = harness.store.claimDueRecipients(Date.now() / 1000 + 1, 10);
    expect(due[0]!.payload.subject).toBe('Your sign-in link');
    expect(due[0]!.payload.html).toContain('<p>hi</p>');
    expect(due[0]!.payload.text).toContain('hi');
  });

  it('carries a Reply-To header through to the queued payload when the message sets one', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await transport.sendMail({
      from: 'Tenant A <noreply@tenant-a.example.com>',
      replyTo: 'support@tenant-a.example.com',
      to: 'member@example.com',
      subject: 'Hi',
      text: 'hi',
    });

    const due = harness.store.claimDueRecipients(Date.now() / 1000 + 1, 10);
    expect(due[0]!.payload.headers['Reply-To']).toContain('support@tenant-a.example.com');
  });

  it('falls back to the envelope sender and empty subject/text when a message carries no From/Subject/body', async () => {
    // A minimal, protocol-legal message: mailparser leaves `from`, `subject`
    // and `text` all undefined when the message has none of those, which is
    // exactly the case the `?? ''` fallbacks and the envelope-mailFrom
    // fallback below exist for — a message this bare still has to enqueue
    // something rather than crash on an unguarded property read.
    harness = await startHarness();
    const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');

    const responses = await rawSmtpCommands(harness.port, '127.0.0.1', [
      'EHLO test',
      `AUTH PLAIN ${authPlain}`,
      'MAIL FROM:<envelope-sender@tenant-a.example.com>',
      'RCPT TO:<member@example.com>',
      'DATA',
      'To: member@example.com\r\n\r\n.',
    ]);

    expect(responses.some((line) => /^250 /.test(line))).toBe(true);
    const due = harness.store.claimDueRecipients(Date.now() / 1000 + 1, 10);
    expect(due).toHaveLength(1);
    expect(due[0]!.payload.from).toBe('envelope-sender@tenant-a.example.com');
    expect(due[0]!.payload.subject).toBe('');
    expect(due[0]!.payload.text).toBe('');
  });

  it('rejects an unknown credential and never enqueues', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'wrong-key');

    await expect(
      transport.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(0);
    expect(harness.worker.kick).not.toHaveBeenCalled();
  });

  it('rejects a domain with no registered tenant and never enqueues', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'unregistered.example.com', 'anything');

    await expect(
      transport.sendMail({
        from: 'noreply@unregistered.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  it("rejects group/list-syntax recipient syntax (smtp-server's own grammar refuses it before this front door sees it)", async () => {
    harness = await startHarness();
    const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');

    const responses = await rawSmtpCommands(harness.port, '127.0.0.1', [
      'EHLO test',
      `AUTH PLAIN ${authPlain}`,
      'MAIL FROM:<noreply@tenant-a.example.com>',
      'RCPT TO:<grp:attacker@evil.com;>',
      'QUIT',
    ]);

    const rcptResponse = responses.find((line) => /^5\d\d /.test(line));
    expect(rcptResponse).toBeDefined();
    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  it("rejects a recipient address isSafeRecipientAddress itself refuses, via this front door's own onRcptTo check", async () => {
    // Unlike the group/list-syntax case above, `a"b@example.com` is
    // syntactically valid RFC 5321 (a quoted-string local part) — smtp-server's
    // own parser hands it straight to onRcptTo (verified: it does not 501
    // it first). It reaches isSafeRecipientAddress, which refuses the `"`,
    // and it is this front door's own 501 that comes back, not smtp-server's.
    harness = await startHarness();
    const authPlain = Buffer.from('\u0000tenant-a.example.com\u0000key-a').toString('base64');

    const responses = await rawSmtpCommands(harness.port, '127.0.0.1', [
      'EHLO test',
      `AUTH PLAIN ${authPlain}`,
      'MAIL FROM:<noreply@tenant-a.example.com>',
      'RCPT TO:<a"b@example.com>',
      'QUIT',
    ]);

    const rcptResponse = responses.find((line) => /^501 /.test(line));
    expect(rcptResponse).toBeDefined();
    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  it('rejects a message over the configured size cap and never enqueues it', async () => {
    harness = await startHarness({ maxMessageBytes: 1024 });
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await expect(
      transport.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'x'.repeat(1024 * 50),
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  it('refuses a connection from outside the configured source allow-list', async () => {
    // Only a range 127.0.0.1 doesn't belong to — proves the listener really
    // does turn away a source it isn't configured to trust, not just that
    // it never gets exercised because tests always run from loopback.
    harness = await startHarness({ allowedSourceCidrs: ['10.0.0.0/8'] });
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await expect(
      transport.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Hi',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(0);
  });

  it('rate-limits a submitter that exceeds its per-minute ceiling, keyed on identity not address', async () => {
    harness = await startHarness({ submitterMessagesPerMinute: 1 });
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    await transport.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'member@example.com',
      subject: 'First',
      text: 'hi',
    });

    await expect(
      transport.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Second, over the ceiling',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(1);
  });

  it('a different tenant is never limited by another tenant exhausting its ceiling', async () => {
    harness = await startHarness({ submitterMessagesPerMinute: 1 });
    const a = client(harness.port, 'tenant-a.example.com', 'key-a');
    const b = client(harness.port, 'tenant-b.example.com', 'key-b');

    await a.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'm@example.com',
      subject: 'A',
      text: 'hi',
    });
    await expect(
      a.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'm@example.com',
        subject: 'A2',
        text: 'hi',
      })
    ).rejects.toThrow();

    // tenant-b's own ceiling is untouched by tenant-a's connections above.
    await expect(
      b.sendMail({
        from: 'noreply@tenant-b.example.com',
        to: 'm@example.com',
        subject: 'B',
        text: 'hi',
      })
    ).resolves.toBeDefined();

    expect(harness.store.countPendingRecipients()).toBe(2);
  });

  it('the same tenant sharing one ceiling across an IPv4 and an IPv6 connection — the #1148 shape, keyed correctly here', async () => {
    harness = await startHarness({ submitterMessagesPerMinute: 1, host: '::' });
    const overV4 = client(harness.port, 'tenant-a.example.com', 'key-a', '127.0.0.1');
    const overV6 = client(harness.port, 'tenant-a.example.com', 'key-a', '::1');

    await overV4.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'member@example.com',
      subject: 'Over IPv4',
      text: 'hi',
    });

    // Same submitter identity, different address family — must share the
    // bucket the first send already spent, not get a fresh one because the
    // connection happened to arrive over IPv6.
    await expect(
      overV6.sendMail({
        from: 'noreply@tenant-a.example.com',
        to: 'member@example.com',
        subject: 'Over IPv6, should be limited',
        text: 'hi',
      })
    ).rejects.toThrow();

    expect(harness.store.countPendingRecipients()).toBe(1);
  });

  it('two different tenants connecting over the same IPv6 address get independent ceilings', async () => {
    harness = await startHarness({ submitterMessagesPerMinute: 1, host: '::' });
    const a = client(harness.port, 'tenant-a.example.com', 'key-a', '::1');
    const b = client(harness.port, 'tenant-b.example.com', 'key-b', '::1');

    await a.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'm@example.com',
      subject: 'A',
      text: 'hi',
    });
    await expect(
      b.sendMail({
        from: 'noreply@tenant-b.example.com',
        to: 'm@example.com',
        subject: 'B',
        text: 'hi',
      })
    ).resolves.toBeDefined();

    expect(harness.store.countPendingRecipients()).toBe(2);
  });
});

describe('SMTP front door — answered at once, sabotage-provable', () => {
  let harness: Harness;

  afterEach(async () => {
    await harness?.close();
  });

  it('acknowledges well under a second with nothing draining the queue', async () => {
    harness = await startHarness();
    const transport = client(harness.port, 'tenant-a.example.com', 'key-a');

    const start = Date.now();
    await transport.sendMail({
      from: 'noreply@tenant-a.example.com',
      to: 'member@example.com',
      subject: 'Timed',
      text: 'hi',
    });
    const elapsedMs = Date.now() - start;

    expect(elapsedMs).toBeLessThan(1000);
    // The worker was told to kick, but this test never gave it anywhere
    // reachable to send to — the ack above did not wait on that call
    // resolving anything, only on the durable write.
    expect(harness.store.countPendingRecipients()).toBe(1);
  });
});

describe('SMTP front door — runtime server errors are logged, not swallowed', () => {
  let harness: Harness;
  let second: SmtpFrontDoor | undefined;

  afterEach(async () => {
    await second?.close();
    await harness?.close();
  });

  it('logs smtp_server_error when the underlying net.Server reports one (e.g. a second listener on the same port)', async () => {
    harness = await startHarness();

    const store2 = createSqliteStore(':memory:');
    const { logger: logger2, lines: logs2 } = createTestLogger();
    second = createSmtpFrontDoor({
      store: store2,
      worker: {
        kick: vi.fn(),
        whenIdle: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        status: () => ({ lastTickAt: null, stopped: false }),
      },
      log: logger2,
      maxMessageBytes: 1024 * 1024,
      submitterMessagesPerMinute: 120,
    });

    // Binding a second listener to a port already in use makes the
    // underlying net.Server emit 'error' (EADDRINUSE) — the same event
    // this module's persistent `server.on('error', ...)` handler logs,
    // exercising it independently of the once-listener listen() itself
    // uses to reject its own promise.
    await expect(second.listen(harness.port, '127.0.0.1')).rejects.toThrow();

    expect(logs2.some((line) => line.event === 'smtp_server_error')).toBe(true);
    store2.close();
  });
});
