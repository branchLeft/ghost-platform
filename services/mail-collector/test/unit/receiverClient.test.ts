import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createReceiverClient, ReceiverError } from '../../src/complaints/receiverClient.js';
import { FakeComplaintReceiver } from '../helpers/fakeComplaintReceiver.js';

const TOKEN = 'receiver-drain-token-0123456789abcdef-placeholder';

describe('receiver client against a fake receiver', () => {
  let dir: string;
  let tokenFile: string;
  let receiver: FakeComplaintReceiver;
  let baseUrl: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'collector-receiver-client-'));
    tokenFile = join(dir, 'token');
    writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
    receiver = new FakeComplaintReceiver(TOKEN);
    baseUrl = await receiver.listen();
  });

  afterEach(async () => {
    await receiver.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const client = (overrides: { baseUrl?: string; tokenFile?: string } = {}) =>
    createReceiverClient({
      baseUrl: overrides.baseUrl ?? baseUrl,
      tokenFile: overrides.tokenFile ?? tokenFile,
      timeoutMs: 2000,
    });

  it('pulls the queue with the bearer token from its file', async () => {
    receiver.enqueue('msg-1.1', 'spam', 1700000000);
    const records = await client().pull(500);
    expect(records).toEqual([{ seq: 1, outcomeId: 'msg-1.1', class: 'spam', at: 1700000000 }]);
    expect(receiver.authHeaders).toEqual([`Bearer ${TOKEN}`]);
  });

  it('acknowledges through a sequence, which releases the records', async () => {
    receiver.enqueue('a.1');
    receiver.enqueue('b.1');
    await client().ack(1);
    expect(receiver.ackRequests).toEqual([1]);
    expect((await client().pull(500)).map((r) => r.outcomeId)).toEqual(['b.1']);
  });

  it('reads the token file again for each call, so a rotation needs no restart', async () => {
    const c = client();
    await c.pull(1);
    writeFileSync(tokenFile, 'a-different-token\n');
    await expect(c.pull(1)).rejects.toThrow('401');
    writeFileSync(tokenFile, TOKEN);
    await expect(c.pull(1)).resolves.toEqual([]);
  });

  it('fails with a status, and never the token, on a refusal', async () => {
    receiver.failWith = 503;
    const error = await client()
      .pull(1)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceiverError);
    expect((error as Error).message).toBe('GET /drain?limit=1 -> 503');
  });

  it('fails without the token or address in the message when the receiver is not there', async () => {
    const error = await client({ baseUrl: 'http://127.0.0.1:1' })
      .pull(1)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReceiverError);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).not.toContain('127.0.0.1');
  });

  it('fails, naming no path, when the token file is missing or empty', async () => {
    const missing = await client({ tokenFile: join(dir, 'nope') })
      .pull(1)
      .catch((e: unknown) => e);
    expect((missing as Error).message).toBe('receiver token file unreadable');
    expect((missing as Error).message).not.toContain(dir);
    writeFileSync(join(dir, 'empty'), '\n');
    await expect(client({ tokenFile: join(dir, 'empty') }).pull(1)).rejects.toThrow('empty');
    // Nothing was sent to the receiver without a token.
    expect(receiver.authHeaders).toEqual([]);
  });

  it('refuses an answer that is not a list of complaint records', async () => {
    await receiver.close();
    const bad = new FakeComplaintReceiver(TOKEN);
    const url = await bad.listen();
    bad.enqueue('ok.1');
    // A record the receiver should never hold: a string sequence.
    (bad.queued as unknown as unknown[]).push({ seq: '2', outcomeId: 'x', class: 'y', at: 1 });
    await expect(client({ baseUrl: url }).pull(500)).rejects.toThrow('not a record list');
    await bad.close();
  });
});
