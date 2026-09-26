import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryClient, type DeliveryClient } from '../../src/deliveryClient.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';

describe('deliveryClient', () => {
  let sink: SmtpSink;
  let client: DeliveryClient;

  beforeEach(async () => {
    sink = await startSmtpSink('collector', 'sink-secret');
    client = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'sink-secret',
    });
  });

  afterEach(async () => {
    client.close();
    await sink.close();
  });

  it('submits a drained message over real authenticated SMTP', async () => {
    await client.deliver({
      id: 'm1',
      domain: 'tenant-a.example',
      emailId: null,
      from: 'noreply@tenant-a.example',
      to: 'reader@example.com',
      subject: 'Hello reader',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
      drainCount: 1,
    });
    const [received] = await sink.waitForCount(1);
    expect(received!.envelopeTo).toEqual(['reader@example.com']);
    expect(received!.parsed.subject).toBe('Hello reader');
  });

  it('rejects when the credentials are wrong', async () => {
    const badClient = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'wrong-secret',
    });
    await expect(
      badClient.deliver({
        id: 'm1',
        domain: 'tenant-a.example',
        emailId: null,
        from: 'noreply@tenant-a.example',
        to: 'reader@example.com',
        subject: 'Hello',
        html: '<p>hi</p>',
        text: 'hi',
        headers: {},
        drainCount: 1,
      })
    ).rejects.toThrow();
    badClient.close();
  });
});
