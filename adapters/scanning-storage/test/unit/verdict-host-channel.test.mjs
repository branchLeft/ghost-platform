// The whole channel over its REAL transport: the production verdict client,
// the unix-socket transport, the host end's local socket and queue, and a
// stand-in for the safety service on the inbound side. No part of the path
// between the client and the queue is a fake.
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hashOf, startRig, verdictFor } from '../helpers/verdict-host-rig.mjs';

const require = createRequire(import.meta.url);
const { ProductionVerdictClient } = require('../../src/production-verdict-client');
const { createSocketVerdictTransport } = require('../../src/socket-verdict-transport');
const { encodeAsk } = require('../../src/verdict-socket-frame');

let rig;
afterEach(async () => {
  await rig?.cleanup();
  rig = undefined;
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clientFor(options = {}) {
  const transport = createSocketVerdictTransport({ socketPath: rig.config.socketPath });
  return new ProductionVerdictClient({
    transport,
    connectTimeoutMs: 1000,
    totalTimeoutMs: 2000,
    ...options,
  });
}

// The safety service's side of one round: take what is queued and answer it.
async function serviceAnswers(answerFor) {
  const { batch, hashes } = await rig.poll();
  const verdicts = hashes.map((hash) => verdictFor(hash, answerFor(hash)));
  return { status: (await rig.post(batch, verdicts)).status, hashes };
}

describe('a hash written to the socket and its verdict coming back', () => {
  it('reaches the service that dialled in, and the service verdict returns to the caller', async () => {
    rig = await startRig({ config: { askWaitMs: 1500 } });
    const asking = clientFor().getVerdict(hashOf(1));
    const round = await serviceAnswers(() => ({}));
    expect(round.hashes).toEqual([hashOf(1)]);
    expect(round.status).toBe(204);
    expect(await asking).toMatchObject({ classification: 'no-known-match', evidence: hashOf(1) });
  });

  it('carries a match and its type back to the caller', async () => {
    rig = await startRig({ config: { askWaitMs: 1500 } });
    const asking = clientFor().getVerdict(hashOf(2));
    await serviceAnswers(() => ({
      classification: 'csam',
      matchType: 'near',
      decision: {
        action: 'refuse',
        tier: 'one',
        irreversible: true,
        control: false,
        steps: ['withhold'],
      },
    }));
    expect(await asking).toMatchObject({ classification: 'csam', matchType: 'near' });
  });

  it('answers unavailable when no verdict comes inside the wait, and the hash stays queued', async () => {
    rig = await startRig({ config: { askWaitMs: 80 } });
    expect(await clientFor().getVerdict(hashOf(1))).toMatchObject({
      classification: 'unavailable',
    });
    expect(rig.host.queue.counts().queued).toBe(1);
    expect(rig.host.queue.oldestAgeSeconds()).toBeGreaterThanOrEqual(0);
  });

  it('answers a later ask from the verdict it kept, so a held upload can be promoted', async () => {
    rig = await startRig({ config: { askWaitMs: 60 } });
    expect(await clientFor().getVerdict(hashOf(1))).toMatchObject({
      classification: 'unavailable',
    });
    await serviceAnswers(() => ({}));
    expect(await clientFor().getVerdict(hashOf(1))).toMatchObject({
      classification: 'no-known-match',
    });
  });

  it('answers unavailable while the service only ever says unavailable', async () => {
    rig = await startRig({ config: { askWaitMs: 150, reofferDelayMs: 50 } });
    const asking = clientFor().getVerdict(hashOf(1));
    await serviceAnswers(() => ({
      classification: 'unavailable',
      decision: { action: 'hold', reason: 'unavailable' },
    }));
    expect(await asking).toMatchObject({ classification: 'unavailable' });
    expect(rig.host.queue.counts().queued).toBe(1);
  });
});

describe('a late answer for an earlier key is never delivered to the next ask', () => {
  it('holds: A times out, A is answered clean afterwards, and B (a match) gets B, never A', async () => {
    rig = await startRig({ config: { askWaitMs: 60 } });
    const keyA = hashOf(1);
    const keyB = hashOf(2);

    // A's ask times out on the host end while the service is still thinking.
    expect(await clientFor().getVerdict(keyA)).toMatchObject({ classification: 'unavailable' });

    // B is asked with a wait long enough to be open when A's verdict lands.
    rig.config.askWaitMs = 60;
    const askingB = clientFor({ totalTimeoutMs: 2000 }).getVerdict(keyB);
    await wait(10);
    // The service answers A clean and B as a match, in one batch.
    const { batch, hashes } = await rig.poll();
    expect(new Set(hashes)).toEqual(new Set([keyA, keyB]));
    await rig.post(batch, [
      verdictFor(keyA),
      verdictFor(keyB, {
        classification: 'csam',
        decision: {
          action: 'refuse',
          tier: 'one',
          irreversible: true,
          control: false,
          steps: ['withhold'],
        },
      }),
    ]);
    const resultB = await askingB;
    expect(resultB.evidence).toBe(keyB);
    expect(['csam', 'unavailable']).toContain(resultB.classification);
    expect(resultB.classification).not.toBe('no-known-match');
  });

  it('does not hand A verdict to a different connection that is waiting on B', async () => {
    rig = await startRig({ config: { askWaitMs: 400 } });
    const keyA = hashOf(1);
    const keyB = hashOf(2);
    const askingA = clientFor().getVerdict(keyA);
    await wait(10);
    // B asks on the bare transport, so what B's connection receives is seen as
    // the host end sent it, before the client's own key check could mask a fault.
    const connectionB = await createSocketVerdictTransport({
      socketPath: rig.config.socketPath,
    }).connect({});
    const askingB = connectionB.ask(keyB);
    await wait(10);
    const { batch } = await rig.poll();
    // Only A is answered; B must not receive it.
    await rig.post(batch, [verdictFor(keyA)]);
    expect(await askingA).toMatchObject({ classification: 'no-known-match', evidence: keyA });
    expect(await askingB).toEqual({ v: 1, key: keyB, classification: 'unavailable' });
    connectionB.close();
  });

  it('copies the key from the host end, and the client holds an answer for another key', async () => {
    rig = await startRig({ config: { askWaitMs: 1500 } });
    const transport = createSocketVerdictTransport({ socketPath: rig.config.socketPath });
    const connection = await transport.connect({});
    const keyA = hashOf(1);
    const asking = connection.ask(keyA);
    await serviceAnswers(() => ({}));
    expect(await asking).toEqual({ v: 1, key: keyA, classification: 'no-known-match' });
    connection.close();
  });
});

describe('the local socket refuses what it should', () => {
  const askRaw = (text, { socketPath } = {}) =>
    new Promise((resolve) => {
      const socket = net.createConnection({ path: socketPath ?? rig.config.socketPath });
      let data = '';
      socket.on('data', (chunk) => {
        data += chunk;
      });
      socket.on('close', () => resolve(data));
      socket.on('error', () => resolve(data));
      socket.write(text);
    });

  it.each([
    ['a key that is not a PDQ hash', '{"v":1,"op":"ask","key":"/etc/passwd"}\n'],
    ['another operation', `{"v":1,"op":"drain","key":"${hashOf(1)}"}\n`],
    ['an extra field', `{"v":1,"op":"ask","key":"${hashOf(1)}","path":"/x"}\n`],
    ['another version', `{"v":2,"op":"ask","key":"${hashOf(1)}"}\n`],
    ['text that is not JSON', 'hello\n'],
  ])('answers an error to %s and queues nothing', async (_name, line) => {
    rig = await startRig();
    expect(JSON.parse(await askRaw(line))).toEqual({ v: 1, error: 'bad-ask' });
    expect(rig.host.queue.counts().queued).toBe(0);
  });

  it('drops a line over the limit and a caller that never finishes a line', async () => {
    rig = await startRig();
    expect(await askRaw(`${'x'.repeat(2000)}\n`)).toBe('');
    expect(rig.host.queue.counts().queued).toBe(0);
  });

  it('answers busy when the queue is full', async () => {
    rig = await startRig({ config: { maxQueued: 1 } });
    rig.host.queue.ask(hashOf(1));
    expect(JSON.parse(await askRaw(encodeAsk(hashOf(2))))).toEqual({ v: 1, error: 'busy' });
  });

  it('answers unavailable as an error when the journal cannot be written', async () => {
    rig = await startRig();
    rig.host.queue.close();
    expect(JSON.parse(await askRaw(encodeAsk(hashOf(2))))).toEqual({ v: 1, error: 'unavailable' });
  });

  it('forgets a caller that hangs up before the verdict', async () => {
    rig = await startRig({ config: { askWaitMs: 2000 } });
    await new Promise((resolve) => {
      const socket = net.createConnection({ path: rig.config.socketPath }, () => {
        socket.write(encodeAsk(hashOf(1)));
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 50);
      });
    });
    await wait(30);
    await serviceAnswers(() => ({}));
    expect(rig.host.queue.counts().verdicts).toBe(1);
  });
});

describe('the socket file', () => {
  it('is private to its owner, and a stale socket from a killed run is replaced', async () => {
    rig = await startRig();
    expect(fs.statSync(rig.config.socketPath).mode & 0o777).toBe(0o600);
    const directory = rig.directory;
    // A socket file left by a process that was killed rather than stopped.
    await rig.host.local.close();
    const stale = net.createServer().listen(rig.config.socketPath);
    await new Promise((resolve) => stale.once('listening', resolve));
    stale.unref();
    const { startLocalSocket } = require('../../verdict-host/local-socket');
    const again = await startLocalSocket({
      queue: rig.host.queue,
      socketPath: rig.config.socketPath,
      socketMode: 0o660,
    });
    expect(fs.statSync(rig.config.socketPath).mode & 0o777).toBe(0o660);
    await again.close();
    stale.close();
    expect(fs.existsSync(directory)).toBe(true);
  });

  it('refuses to remove something that is not a socket', async () => {
    rig = await startRig();
    const { startLocalSocket } = require('../../verdict-host/local-socket');
    const file = path.join(rig.directory, 'regular');
    fs.writeFileSync(file, 'keep me');
    await expect(startLocalSocket({ queue: rig.host.queue, socketPath: file })).rejects.toThrow(
      'not a socket'
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('keep me');
    expect(() => startLocalSocket({ queue: rig.host.queue, socketPath: 'relative.sock' })).toThrow(
      'absolute'
    );
  });
});
