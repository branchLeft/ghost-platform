import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDrainClient } from '../../src/drainClient.js';
import { FakeShimServer } from '../helpers/fakeShimServer.js';

describe('drainClient', () => {
  let shim: FakeShimServer;
  let baseUrl: string;
  const token = 'test-drain-token';

  beforeEach(async () => {
    shim = new FakeShimServer(token);
    baseUrl = await shim.listen();
  });

  afterEach(async () => {
    await shim.close();
  });

  it('drain() returns queued messages over a real HTTP call', async () => {
    shim.enqueue({
      id: 'm1',
      domain: 'tenant-a.example',
      emailId: null,
      from: 'noreply@tenant-a.example',
      to: 'reader@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
    });
    const client = createDrainClient({ drainToken: token, drainTimeoutMs: 5000 });
    const messages = await client.drain({ id: 'tenant-a', baseUrl });
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ id: 'm1', drainCount: 1 });
  });

  it('drain() returns an empty array when nothing is queued', async () => {
    const client = createDrainClient({ drainToken: token, drainTimeoutMs: 5000 });
    const messages = await client.drain({ id: 'tenant-a', baseUrl });
    expect(messages).toEqual([]);
  });

  it('drain() throws on a 401 from the wrong token', async () => {
    const client = createDrainClient({ drainToken: 'wrong-token', drainTimeoutMs: 5000 });
    await expect(client.drain({ id: 'tenant-a', baseUrl })).rejects.toThrow('401');
  });

  it('ack() reports acked ids and clears them from the shim', async () => {
    shim.enqueue({
      id: 'm1',
      domain: 'tenant-a.example',
      emailId: null,
      from: 'noreply@tenant-a.example',
      to: 'reader@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
    });
    const client = createDrainClient({ drainToken: token, drainTimeoutMs: 5000 });
    const [message] = await client.drain({ id: 'tenant-a', baseUrl });
    const result = await client.ack({ id: 'tenant-a', baseUrl }, [
      { id: message!.id, drainCount: message!.drainCount },
    ]);
    expect(result.acked).toEqual(['m1']);

    const secondDrain = await client.drain({ id: 'tenant-a', baseUrl });
    expect(secondDrain).toEqual([]);
  });

  it('a lost-ack re-offer surfaces under a new drainCount', async () => {
    shim.enqueue({
      id: 'm1',
      domain: 'tenant-a.example',
      emailId: null,
      from: 'noreply@tenant-a.example',
      to: 'reader@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
    });
    const client = createDrainClient({ drainToken: token, drainTimeoutMs: 5000 });
    const [first] = await client.drain({ id: 'tenant-a', baseUrl });
    shim.simulateLostAck();
    const [second] = await client.drain({ id: 'tenant-a', baseUrl });
    expect(second!.id).toBe(first!.id);
    expect(second!.drainCount).toBeGreaterThan(first!.drainCount);
  });

  it('drain() accepts an external signal alongside its own timeout', async () => {
    const client = createDrainClient({ drainToken: token, drainTimeoutMs: 5000 });
    const controller = new AbortController();
    const messages = await client.drain({ id: 'tenant-a', baseUrl }, controller.signal);
    expect(messages).toEqual([]);
  });

  it('drain() aborts when the external signal fires first', async () => {
    const client = createDrainClient({ drainToken: token, drainTimeoutMs: 5000 });
    const controller = new AbortController();
    controller.abort(new Error('caller cancelled'));
    await expect(client.drain({ id: 'tenant-a', baseUrl }, controller.signal)).rejects.toThrow();
  });

  it('ack() throws on a non-2xx response', async () => {
    const client = createDrainClient({ drainToken: 'wrong-token', drainTimeoutMs: 5000 });
    await expect(
      client.ack({ id: 'tenant-a', baseUrl }, [{ id: 'm1', drainCount: 1 }])
    ).rejects.toThrow('401');
  });

  it('ack() with a stale drainCount is reported unknown, not accepted', async () => {
    shim.enqueue({
      id: 'm1',
      domain: 'tenant-a.example',
      emailId: null,
      from: 'noreply@tenant-a.example',
      to: 'reader@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
      headers: {},
    });
    const client = createDrainClient({ drainToken: token, drainTimeoutMs: 5000 });
    const [first] = await client.drain({ id: 'tenant-a', baseUrl });
    shim.simulateLostAck();
    await client.drain({ id: 'tenant-a', baseUrl });
    const result = await client.ack({ id: 'tenant-a', baseUrl }, [
      { id: first!.id, drainCount: first!.drainCount },
    ]);
    expect(result.unknown).toEqual(['m1']);
    expect(result.acked).toEqual([]);
  });
});
