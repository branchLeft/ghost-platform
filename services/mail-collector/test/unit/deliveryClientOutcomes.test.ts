import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDeliveryClient, type DeliveryClient } from '../../src/deliveryClient.js';
import { decodeOutcomeMessageId } from '../../src/outcomeId.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';

const MESSAGE = {
  id: '4cfbf575-9efc-4508-bc4f-e0f9314e4844',
  domain: 'tenant-a.example',
  emailId: null,
  from: 'noreply@tenant-a.example',
  to: 'reader@example.com',
  subject: 'Hello',
  html: '<p>hi</p>',
  text: 'hi',
  headers: {},
  drainCount: 2,
};

describe('deliveryClient outcomes (opt-in)', () => {
  let sink: SmtpSink;
  const clients: DeliveryClient[] = [];

  function client(outcomes?: { returnPath: string; bulkReturnPath?: string }): DeliveryClient {
    const c = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'sink-secret',
      outcomes,
    });
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    sink = await startSmtpSink('collector', 'sink-secret');
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) {
      c.close();
    }
    await sink.close();
  });

  it('off by default: no minted Message-ID, the envelope sender is the From address', async () => {
    await client().deliver(MESSAGE, 'tenant-a');
    const [received] = await sink.waitForCount(1);
    expect(received!.envelopeFrom).toBe('noreply@tenant-a.example');
    expect(decodeOutcomeMessageId(received!.parsed.messageId ?? '')).toBeNull();
  });

  it('on: names the message, generation and spool in the Message-ID, and returns notifications to the return path', async () => {
    await client({ returnPath: 'outcomes@collector.example' }).deliver(MESSAGE, 'tenant-a');
    const [received] = await sink.waitForCount(1);
    expect(received!.envelopeFrom).toBe('outcomes@collector.example');
    expect(received!.envelopeTo).toEqual(['reader@example.com']);
    expect(decodeOutcomeMessageId(received!.parsed.messageId ?? '')).toEqual({
      targetId: 'tenant-a',
      id: MESSAGE.id,
      drainCount: 2,
    });
    expect(received!.dsnNotify).toEqual(expect.arrayContaining(['SUCCESS', 'FAILURE', 'DELAY']));
  });

  it('on, but no spool named: submits as before rather than minting an unroutable id', async () => {
    await client({ returnPath: 'outcomes@collector.example' }).deliver(MESSAGE);
    const [received] = await sink.waitForCount(1);
    expect(received!.envelopeFrom).toBe('noreply@tenant-a.example');
  });

  describe('return path by mail class', () => {
    const BULK = { ...MESSAGE, emailId: 'email-1' };
    const paths = {
      returnPath: 'login-bounces@collector.example',
      bulkReturnPath: 'bulk-bounces@collector.example',
    };

    it('sends a bulk message from the bulk return path', async () => {
      await client(paths).deliver(BULK, 'tenant-a');
      const [received] = await sink.waitForCount(1);
      expect(received!.envelopeFrom).toBe('bulk-bounces@collector.example');
    });

    it('sends a login message from the login return path even when a bulk one is set', async () => {
      await client(paths).deliver(MESSAGE, 'tenant-a');
      const [received] = await sink.waitForCount(1);
      expect(received!.envelopeFrom).toBe('login-bounces@collector.example');
    });

    it('sends bulk from the single return path when no bulk one is set', async () => {
      await client({ returnPath: paths.returnPath }).deliver(BULK, 'tenant-a');
      const [received] = await sink.waitForCount(1);
      expect(received!.envelopeFrom).toBe('login-bounces@collector.example');
    });

    it('keeps the correlation id and the DSN request on a bulk message', async () => {
      await client(paths).deliver(BULK, 'tenant-a');
      const [received] = await sink.waitForCount(1);
      expect(decodeOutcomeMessageId(received!.parsed.messageId ?? '')).toEqual({
        targetId: 'tenant-a',
        id: MESSAGE.id,
        drainCount: 2,
      });
      expect(received!.dsnNotify).toEqual(expect.arrayContaining(['SUCCESS', 'FAILURE', 'DELAY']));
    });
  });
});
