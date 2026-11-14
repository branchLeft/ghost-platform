import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDeliveryClient,
  type DeliveryClient,
  type DeliveryClientOptions,
} from '../../src/deliveryClient.js';
import { decodeOutcomeMessageId, verifyOutcomeMessageId } from '../../src/outcomeId.js';
import { startSmtpSink, type SmtpSink } from '../helpers/smtpSink.js';

const KEY = randomBytes(32).toString('hex');

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

  function client(
    outcomes?: Omit<NonNullable<DeliveryClientOptions['outcomes']>, 'messageIdKey'>,
    lanes?: { tx: string; nl: string }
  ): DeliveryClient {
    const c = createDeliveryClient({
      host: '127.0.0.1',
      port: sink.port,
      secure: false,
      user: 'collector',
      pass: 'sink-secret',
      outcomes: outcomes ? { ...outcomes, messageIdKey: KEY } : undefined,
      lanes,
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

  it('on: signs the Message-ID for the recipient it goes to, so only that bounce verifies', async () => {
    await client({ returnPath: 'outcomes@collector.example' }).deliver(MESSAGE, 'tenant-a');
    const [received] = await sink.waitForCount(1);
    const id = received!.parsed.messageId ?? '';
    expect(verifyOutcomeMessageId(id, ['reader@example.com'], KEY)).toEqual({
      targetId: 'tenant-a',
      id: MESSAGE.id,
      drainCount: 2,
    });
    expect(verifyOutcomeMessageId(id, ['other@example.com'], KEY)).toBeNull();
    expect(
      verifyOutcomeMessageId(id, ['reader@example.com'], randomBytes(32).toString('hex'))
    ).toBeNull();
  });

  it('on, but no spool named: submits as before rather than minting an unroutable id', async () => {
    await client({ returnPath: 'outcomes@collector.example' }).deliver(MESSAGE);
    const [received] = await sink.waitForCount(1);
    expect(received!.envelopeFrom).toBe('noreply@tenant-a.example');
  });

  describe('lane return paths', () => {
    const BULK = { ...MESSAGE, emailId: 'email-1' };
    const lanes = { tx: 'bounce-tx@tx.example', nl: 'bounce-nl@nl.example' };

    it('sends a bulk message from the newsletter path, outcomes off', async () => {
      await client(undefined, lanes).deliver(BULK, 'tenant-a', { demo: false });
      const [received] = await sink.waitForCount(1);
      expect(received!.envelopeFrom).toBe(lanes.nl);
      expect(received!.dsnNotify).toBeUndefined();
      expect(decodeOutcomeMessageId(received!.parsed.messageId ?? '')).toBeNull();
    });

    it('sends a login message from the transactional path, outcomes off', async () => {
      await client(undefined, lanes).deliver(MESSAGE, 'tenant-a', { demo: false });
      const [received] = await sink.waitForCount(1);
      expect(received!.envelopeFrom).toBe(lanes.tx);
    });

    it('sends a demo login message from the newsletter path', async () => {
      await client(undefined, lanes).deliver(MESSAGE, 'tenant-a', { demo: true });
      const [received] = await sink.waitForCount(1);
      expect(received!.envelopeFrom).toBe(lanes.nl);
    });

    it('takes a login message with no context as not demo, and needs no spool named', async () => {
      await client(undefined, lanes).deliver(MESSAGE);
      const [received] = await sink.waitForCount(1);
      expect(received!.envelopeFrom).toBe(lanes.tx);
    });

    it('keeps the correlation id and the DSN request when outcomes are on', async () => {
      await client({}, lanes).deliver(BULK, 'tenant-a', { demo: false });
      const [received] = await sink.waitForCount(1);
      expect(received!.envelopeFrom).toBe(lanes.nl);
      expect(decodeOutcomeMessageId(received!.parsed.messageId ?? '')).toEqual({
        targetId: 'tenant-a',
        id: MESSAGE.id,
        drainCount: 2,
      });
      expect(received!.dsnNotify).toEqual(expect.arrayContaining(['SUCCESS', 'FAILURE', 'DELAY']));
    });

    it('refuses to be built with the single outcome return path beside the lane paths', () => {
      expect(() => client({ returnPath: 'outcomes@collector.example' }, lanes)).toThrow(/lane/);
    });

    it('refuses outcomes with neither a return path nor lane paths', () => {
      expect(() => client({})).toThrow(/return path/);
    });
  });
});
