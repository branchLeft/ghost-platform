import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import { hashOf, signHeaders, startRig, verdictFor } from '../helpers/verdict-host-rig.mjs';

let rig;
afterEach(async () => {
  await rig?.cleanup();
  rig = undefined;
});

describe('the routes', () => {
  it('answers 404 to any other path, a query string or a wrong method, before reading anything', async () => {
    rig = await startRig();
    expect((await rig.call('GET', '/other')).status).toBe(404);
    expect((await rig.call('GET', '/safety/v1/pending?x=1')).status).toBe(404);
    expect((await rig.call('POST', '/safety/v1/pending')).status).toBe(404);
    expect((await rig.call('GET', '/safety/v1/verdicts')).status).toBe(404);
  });

  it('answers 401 with no body to an unsigned request, a forged one and a replay', async () => {
    rig = await startRig();
    const unsigned = await rig.call('GET', '/safety/v1/pending', { headers: {} });
    expect(unsigned.status).toBe(401);
    expect(await unsigned.text()).toBe('');

    const signed = signHeaders(rig.keys.privateKey, 'GET', '/safety/v1/pending', '', {
      now: rig.clock.now(),
    });
    expect((await rig.call('GET', '/safety/v1/pending', { headers: signed })).status).toBe(200);
    expect((await rig.call('GET', '/safety/v1/pending', { headers: signed })).status).toBe(401);

    const forged = await rig.call('GET', '/safety/v1/pending', {
      signAs: { url: '/safety/v1/verdicts' },
    });
    expect(forged.status).toBe(401);
    expect(rig.lines.join('\n')).toContain('VERDICT_HOST_REQUEST_REFUSED reason=replay');
  });

  it('refuses a poll that carries a body', async () => {
    rig = await startRig();
    const headers = signHeaders(rig.keys.privateKey, 'GET', '/safety/v1/pending', 'x', {
      now: rig.clock.now(),
    });
    const response = await new Promise((resolve, reject) => {
      const req = http.request(
        `${rig.base}/safety/v1/pending`,
        { method: 'GET', headers: { ...headers, 'content-length': '1' } },
        resolve
      );
      req.on('error', reject);
      req.end('x');
    });
    expect(response.statusCode).toBe(400);
    response.resume();
  });
});

describe('the poll', () => {
  it('answers an empty hold after its hold time', async () => {
    rig = await startRig({ config: { holdMs: 120 } });
    const started = Date.now();
    expect(await rig.poll()).toEqual({ v: 1, hashes: [] });
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('hands over a hash that is queued at once, and wakes a held poll when one arrives', async () => {
    rig = await startRig({ config: { holdMs: 5000 } });
    const holding = rig.poll();
    setTimeout(() => rig.host.queue.ask(hashOf(1)), 50);
    const answer = await holding;
    expect(answer.v).toBe(1);
    expect(answer.batch).toMatch(/^[A-Za-z0-9._-]{16,128}$/);
    expect(answer.hashes).toEqual([hashOf(1)]);
  });

  it('does not hand the same hash to two polls', async () => {
    rig = await startRig({ config: { holdMs: 100 } });
    rig.host.queue.ask(hashOf(1));
    const [a, b] = await Promise.all([rig.poll(), rig.poll()]);
    expect([...a.hashes, ...b.hashes]).toEqual([hashOf(1)]);
  });

  it('answers 503 when too many polls are already held', async () => {
    rig = await startRig({ config: { holdMs: 1500 } });
    const held = Array.from({ length: 4 }, () => rig.call('GET', '/safety/v1/pending'));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await rig.call('GET', '/safety/v1/pending')).status).toBe(503);
    await Promise.all(held);
  });

  it('does not lease to a caller that went away', async () => {
    rig = await startRig({ config: { holdMs: 5000 } });
    const headers = signHeaders(rig.keys.privateKey, 'GET', '/safety/v1/pending', '', {
      now: rig.clock.now(),
    });
    await new Promise((resolve) => {
      const req = http.request(`${rig.base}/safety/v1/pending`, { headers });
      req.on('error', () => {});
      req.end();
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 80);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    rig.host.queue.ask(hashOf(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(rig.host.queue.counts()).toEqual({ queued: 1, leased: 0, verdicts: 0 });
  });
});

describe('the verdicts', () => {
  async function leased(...numbers) {
    for (const n of numbers) rig.host.queue.ask(hashOf(n));
    return rig.poll();
  }

  it('takes a body that answers a batch with 204 and settles the hashes', async () => {
    rig = await startRig();
    const { batch, hashes } = await leased(1, 2);
    const response = await rig.post(
      batch,
      hashes.map((h) => verdictFor(h))
    );
    expect(response.status).toBe(204);
    expect(rig.host.queue.counts()).toEqual({ queued: 0, leased: 0, verdicts: 2 });
  });

  it('returns hashes it was not answered for to the queue, and treats an unavailable verdict the same', async () => {
    rig = await startRig({ config: { reofferDelayMs: 1000 } });
    const { batch } = await leased(1, 2, 3);
    const response = await rig.post(batch, [
      verdictFor(hashOf(1)),
      verdictFor(hashOf(2), {
        classification: 'unavailable',
        decision: { action: 'hold', reason: 'unavailable' },
      }),
    ]);
    expect(response.status).toBe(204);
    expect(rig.host.queue.counts()).toEqual({ queued: 2, leased: 0, verdicts: 1 });
    expect(rig.host.queue.lease()).toBeNull();
    rig.clock.advance(1000);
    expect(rig.host.queue.lease().hashes).toEqual([hashOf(2), hashOf(3)]);
  });

  it('answers 409 for a batch it does not hold or no longer holds, and does not settle it', async () => {
    rig = await startRig({ config: { leaseMs: 1000 } });
    expect((await rig.post('unknown-batch-name-1234', [])).status).toBe(409);
    const { batch } = await leased(1);
    rig.clock.advance(1500);
    expect(
      (await rig.post(batch, [verdictFor(hashOf(1), { classification: 'csam' })])).status
    ).toBe(409);
    expect(rig.host.queue.counts().verdicts).toBe(0);
  });

  it('answers 400 to an unreadable body and keeps the lease until it ends', async () => {
    rig = await startRig();
    const { batch } = await leased(1);
    const response = await rig.post(batch, [verdictFor(hashOf(1), { extra: true })]);
    expect(response.status).toBe(400);
    expect(rig.host.queue.counts().leased).toBe(1);
  });

  it('answers 413 to a body over the limit without keeping it', async () => {
    rig = await startRig();
    const big = 'x'.repeat(300_000);
    const headers = signHeaders(rig.keys.privateKey, 'POST', '/safety/v1/verdicts', big, {
      now: rig.clock.now(),
    });
    const status = await new Promise((resolve) => {
      const req = http.request(
        `${rig.base}/safety/v1/verdicts`,
        { method: 'POST', headers: { ...headers, 'content-length': String(big.length) } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        }
      );
      req.on('error', () => resolve('reset'));
      req.end(big);
    });
    expect(['reset', 413]).toContain(status);
  });

  it('counts bytes as they arrive when the declared length is missing', async () => {
    rig = await startRig();
    const big = 'x'.repeat(300_000);
    const headers = signHeaders(rig.keys.privateKey, 'POST', '/safety/v1/verdicts', big, {
      now: rig.clock.now(),
    });
    const status = await new Promise((resolve) => {
      const req = http.request(`${rig.base}/safety/v1/verdicts`, { method: 'POST', headers });
      req.on('response', (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on('error', () => resolve('reset'));
      req.write(big.slice(0, 200_000));
      req.write(big.slice(200_000));
      req.end();
    });
    expect(['reset', 413]).toContain(status);
  });
});
