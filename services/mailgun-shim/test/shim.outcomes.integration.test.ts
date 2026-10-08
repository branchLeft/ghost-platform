import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Interfaces } from 'mailgun.js';
import { createCollector, type Collector } from './helpers/collector.js';
import { createMailgunClient } from './helpers/mailgunClient.js';
import { startSmtpSink, type SmtpSink } from './helpers/smtpSink.js';
import { startTestShim, type TestShim } from './helpers/testServer.js';

// The outcome path end to end over the shim's real HTTP routes, read back
// through mailgun.js (the client Ghost bundles): a stand-in delivery host
// accepts both messages, then reports a permanent failure for one recipient.
// See shim.outcomes.integration.test.md.

const TENANT_DOMAIN = 'tenant1.example.com';
const TENANT_API_KEY = 'test-tenant-1-api-key';

async function eventsOf(client: Interfaces.IMailgunClient, type: string) {
  const page = await client.events.get(TENANT_DOMAIN, { limit: 50 });
  const items = page.items as unknown as Array<{
    event: string;
    recipient: string;
    severity?: string;
    'delivery-status'?: { code?: number; message?: string };
  }>;
  return items.filter((e) => e.event === type);
}

describe('mailgun-shaped shim — outcomes carried back over the drain connection', () => {
  let sink: SmtpSink;
  let shim: TestShim;
  let collector: Collector;
  let client: Interfaces.IMailgunClient;

  async function sendAndAck(): Promise<Array<{ id: string; to: string; drainCount: number }>> {
    await client.messages.create(TENANT_DOMAIN, {
      to: ['good@example.com', 'gone@example.com'],
      from: 'TENANT_1 <noreply@tenant1.example.com>',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
      'recipient-variables': JSON.stringify({
        'good@example.com': { name: 'Good' },
        'gone@example.com': { name: 'Gone' },
      }),
      'h:Sender': 'noreply@tenant1.example.com',
      'v:email-id': '64f1a2b3c4d5e6f7a8b9c0d1',
    });
    // Peek the generation each id was handed at, from the store's own claim.
    const seen: Array<{ id: string; to: string; drainCount: number }> = [];
    const drainer = createCollector({
      shimBaseUrl: shim.baseUrl,
      drainToken: shim.drainToken,
      smtpPort: sink.port,
      smtpUser: 'u',
      smtpPass: 'p',
      onDelivered: (m) => seen.push({ id: m.id, to: m.to, drainCount: m.drainCount }),
    });
    await drainer.drainOnce();
    drainer.stop();
    return seen;
  }

  function report(outcomes: unknown[]): Promise<Response> {
    return fetch(`${shim.baseUrl}/drain/outcomes`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${shim.drainToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ outcomes }),
    });
  }

  beforeEach(async () => {
    sink = await startSmtpSink('u', 'p');
    shim = await startTestShim({ drainOptions: { outcomesEnabled: true } });
    shim.store.registerTenant(TENANT_DOMAIN, TENANT_API_KEY, TENANT_DOMAIN);
    client = createMailgunClient(shim.baseUrl, TENANT_API_KEY);
    collector = createCollector({
      shimBaseUrl: shim.baseUrl,
      drainToken: shim.drainToken,
      smtpPort: sink.port,
      smtpUser: 'u',
      smtpPass: 'p',
    });
  });

  afterEach(async () => {
    collector.stop();
    await shim.close();
    await sink.close();
  });

  it('accepted by the delivery host is not delivered: no delivered event until an outcome says so', async () => {
    const seen = await sendAndAck();
    expect(seen).toHaveLength(2);
    expect(await eventsOf(client, 'delivered')).toEqual([]);
    expect(await eventsOf(client, 'failed')).toEqual([]);
  });

  it('a delivered outcome and a later permanent failure reach the events endpoint, and the failed address is suppressed', async () => {
    const seen = await sendAndAck();
    const good = seen.find((m) => m.to === 'good@example.com')!;
    const gone = seen.find((m) => m.to === 'gone@example.com')!;

    const res = await report([
      { id: good.id, drainCount: good.drainCount, outcome: 'delivered' },
      {
        id: gone.id,
        drainCount: gone.drainCount,
        outcome: 'failed',
        severity: 'permanent',
        code: 550,
        message: '5.1.1 no such mailbox',
      },
    ]);
    expect(res.status).toBe(200);

    const delivered = await eventsOf(client, 'delivered');
    expect(delivered.map((e) => e.recipient)).toEqual(['good@example.com']);
    const failed = await eventsOf(client, 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ recipient: 'gone@example.com', severity: 'permanent' });
    expect(failed[0]!['delivery-status']).toMatchObject({ code: 550 });
    expect(shim.store.isSuppressed(TENANT_DOMAIN, 'bounces', 'gone@example.com')).toBe(true);
  });
});
