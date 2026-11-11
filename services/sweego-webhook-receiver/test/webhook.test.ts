import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openReplayStore } from '../src/replay.js';
import {
  complaintBody,
  NOW_S,
  postSigned,
  send,
  SECRET_A,
  SECRET_B,
  sign,
  signedHeaders,
  startHarness,
  type Harness,
  type HarnessOptions,
} from './helpers/harness.js';

let h: Harness;

async function start(options: HarnessOptions = {}): Promise<Harness> {
  h = await startHarness(options);
  return h;
}

afterEach(async () => {
  await h.close();
});

describe('signature check', () => {
  it('queues a correctly signed complaint with the minimal record only', async () => {
    await start();
    const reply = await postSigned(h, complaintBody());
    expect(reply.status).toBe(200);
    expect(h.queue.read(0, 10)).toEqual([
      { seq: 1, outcomeId: 'SWG_UID_PLACEHOLDER_1', class: 'abuse', at: NOW_S },
    ]);
    const stored = readFileSync(join(h.dir, 'queue.ndjson'), 'utf8');
    expect(stored).not.toContain('RECIPIENT_PLACEHOLDER');
    expect(stored).not.toContain('example.invalid');
  });

  it('refuses an unsigned request and stores nothing', async () => {
    await start();
    const reply = await postSigned(h, complaintBody(), { signatureHeader: null });
    expect(reply.status).toBe(401);
    expect(h.queue.stats().records).toBe(0);
  });

  it('refuses a body altered after signing', async () => {
    await start();
    const original = complaintBody();
    const headers = signedHeaders(original);
    const reply = await send(
      h.port,
      'POST',
      '/webhook',
      complaintBody({ swg_uid: 'TAMPERED' }),
      headers
    );
    expect(reply.status).toBe(401);
    expect(h.queue.stats().records).toBe(0);
  });

  it('refuses a signature made with another secret', async () => {
    await start();
    const reply = await postSigned(h, complaintBody(), { secret: SECRET_B });
    expect(reply.status).toBe(401);
    expect(h.queue.stats().records).toBe(0);
  });

  it('verifies the raw bytes, not a re-serialisation of the parsed JSON', async () => {
    await start();
    const compact = complaintBody();
    const spaced = JSON.stringify(JSON.parse(compact), null, 2);
    const headers = signedHeaders(compact);
    const reply = await send(h.port, 'POST', '/webhook', spaced, headers);
    expect(reply.status).toBe(401);
    expect(h.queue.stats().records).toBe(0);
  });

  it.each([
    ['empty', ''],
    ['not base64', '!!!not-base64!!!'],
    ['too short', 'AAAA'],
    ['too long', 'A'.repeat(2000)],
    ['unknown version only', 'v2,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='],
  ])('refuses a malformed signature header (%s)', async (_name, signatureHeader) => {
    await start();
    const reply = await postSigned(h, complaintBody(), { signatureHeader });
    expect(reply.status).toBe(401);
    expect(h.queue.stats().records).toBe(0);
  });

  it('refuses a missing id or timestamp header', async () => {
    await start();
    const body = complaintBody();
    const noId = signedHeaders(body);
    delete noId['webhook-id'];
    expect((await send(h.port, 'POST', '/webhook', body, noId)).status).toBe(401);
    const noTs = signedHeaders(body);
    delete noTs['webhook-timestamp'];
    expect((await send(h.port, 'POST', '/webhook', body, noTs)).status).toBe(401);
    expect(h.queue.stats().records).toBe(0);
  });

  it('accepts a bare base64 signature, and a good one among several', async () => {
    await start();
    const body = complaintBody();
    const good = sign(SECRET_A, 'WEBHOOK_ID_PLACEHOLDER_1', String(NOW_S), body);
    expect((await postSigned(h, body, { signatureHeader: good })).status).toBe(200);
    const body2 = complaintBody({ event_id: 'EVENT_ID_PLACEHOLDER_2' });
    const good2 = sign(SECRET_A, 'WEBHOOK_ID_PLACEHOLDER_2', String(NOW_S), body2);
    const bad = sign(SECRET_B, 'WEBHOOK_ID_PLACEHOLDER_2', String(NOW_S), body2);
    const multiple = `v1,${bad} v1,${good2}`;
    expect(
      (await postSigned(h, body2, { id: 'WEBHOOK_ID_PLACEHOLDER_2', signatureHeader: multiple }))
        .status
    ).toBe(200);
  });

  it('accepts either of two secrets during a rotation, and refuses a removed one', async () => {
    await start({ secrets: [SECRET_A, SECRET_B] });
    expect((await postSigned(h, complaintBody(), { secret: SECRET_B })).status).toBe(200);
    expect(
      (
        await postSigned(h, complaintBody({ event_id: 'EVENT_ID_PLACEHOLDER_2' }), {
          id: 'WEBHOOK_ID_PLACEHOLDER_2',
          secret: SECRET_A,
        })
      ).status
    ).toBe(200);
    await h.close();
    await start({ secrets: [SECRET_A] });
    expect((await postSigned(h, complaintBody(), { secret: SECRET_B })).status).toBe(401);
  });
});

describe('timestamp window', () => {
  it.each([
    ['4 minutes ahead', 4 * 60, 200],
    ['6 minutes ahead', 6 * 60, 401],
    ['1 hour 59 minutes old', -(119 * 60), 200],
    ['2 hours 1 minute old', -(121 * 60), 401],
  ])('%s', async (_name, offset, status) => {
    await start();
    const reply = await postSigned(h, complaintBody(), { timestamp: String(NOW_S + offset) });
    expect(reply.status).toBe(status);
    expect(h.queue.stats().records).toBe(status === 200 ? 1 : 0);
  });

  it.each(['abc', '-5', '1.5', '', '99999999999999'])('refuses timestamp %j', async (timestamp) => {
    await start();
    const reply = await postSigned(h, complaintBody(), { timestamp });
    expect(reply.status).toBe(401);
    expect(h.queue.stats().records).toBe(0);
  });
});

describe('replay set', () => {
  it('answers 200 and drops a repeated webhook id', async () => {
    await start();
    expect((await postSigned(h, complaintBody())).status).toBe(200);
    expect((await postSigned(h, complaintBody())).status).toBe(200);
    expect(h.queue.stats().records).toBe(1);
    expect(h.stats.snapshot().replayed).toBe(1);
  });

  it('drops a repeated event id under a new webhook id', async () => {
    await start();
    expect((await postSigned(h, complaintBody())).status).toBe(200);
    const again = await postSigned(h, complaintBody(), { id: 'WEBHOOK_ID_PLACEHOLDER_2' });
    expect(again.status).toBe(200);
    expect(h.queue.stats().records).toBe(1);
  });

  it('accepts the same ids again once they are three hours old', async () => {
    await start();
    expect((await postSigned(h, complaintBody())).status).toBe(200);
    h.clock.ms += (3 * 60 * 60 + 1) * 1000;
    const timestamp = String(Math.floor(h.clock.ms / 1000));
    expect((await postSigned(h, complaintBody(), { timestamp })).status).toBe(200);
    expect(h.queue.stats().records).toBe(2);
  });

  it('survives a restart', async () => {
    await start();
    expect((await postSigned(h, complaintBody())).status).toBe(200);
    h.replay.close();
    const reopened = openReplayStore(h.dir, () => h.clock.ms);
    expect(reopened.has('id:WEBHOOK_ID_PLACEHOLDER_1')).toBe(true);
    expect(reopened.has('ev:EVENT_ID_PLACEHOLDER_1')).toBe(true);
    reopened.close();
    // the harness closes h.replay again in afterEach; closing twice must not matter
    h.replay = openReplayStore(h.dir, () => h.clock.ms);
  });

  it('does not mark a rejected request as seen', async () => {
    await start();
    expect((await postSigned(h, complaintBody(), { secret: SECRET_B })).status).toBe(401);
    expect((await postSigned(h, complaintBody())).status).toBe(200);
    expect(h.queue.stats().records).toBe(1);
  });
});

describe('body size cap', () => {
  it('answers 413 for a declared length over 16 KiB, even when validly signed', async () => {
    await start();
    const big = complaintBody({ pad: 'x'.repeat(16 * 1024) });
    const reply = await postSigned(h, big);
    expect(reply.status).toBe(413);
    expect(h.queue.stats().records).toBe(0);
  });

  it('accepts a signed body of exactly 16 KiB', async () => {
    await start();
    const base = complaintBody({ pad: '' });
    const body = complaintBody({ pad: 'x'.repeat(16 * 1024 - Buffer.byteLength(base)) });
    expect(Buffer.byteLength(body)).toBe(16 * 1024);
    expect((await postSigned(h, body)).status).toBe(200);
  });

  it('answers 413 for a chunked body that grows past the cap', async () => {
    await start();
    const big = complaintBody({ pad: 'x'.repeat(20 * 1024) });
    const headers = signedHeaders(big, { headers: { 'transfer-encoding': 'chunked' } });
    const reply = await send(h.port, 'POST', '/webhook', big, headers);
    expect(reply.status).toBe(413);
    expect(h.queue.stats().records).toBe(0);
  });
});

describe('what is let through', () => {
  it('answers 200 and drops an event type other than complaint', async () => {
    await start();
    const reply = await postSigned(h, complaintBody({ event_type: 'delivered' }));
    expect(reply.status).toBe(200);
    expect(h.queue.stats().records).toBe(0);
    expect(h.stats.snapshot().ignored_event_type).toBe(1);
  });

  it('answers 200 and drops a verified body that is not JSON', async () => {
    await start();
    expect((await postSigned(h, 'not json at all')).status).toBe(200);
    expect(h.queue.stats().records).toBe(0);
  });

  it('answers 200 and drops a verified complaint carrying no usable outcome id', async () => {
    await start();
    const reply = await postSigned(h, complaintBody({ swg_uid: 'has spaces and <markup>' }));
    expect(reply.status).toBe(200);
    expect(h.queue.stats().records).toBe(0);
    expect(h.stats.snapshot().ignored_no_outcome_id).toBe(1);
  });

  it('prefers the outcome id in our custom header over swg_uid', async () => {
    await start({ outcomeHeader: 'x-outcome-id' });
    const reply = await postSigned(
      h,
      complaintBody({ headers: { 'X-Outcome-Id': 'OUTCOME_ID_PLACEHOLDER_1' } })
    );
    expect(reply.status).toBe(200);
    expect(h.queue.read(0, 10)[0]?.outcomeId).toBe('OUTCOME_ID_PLACEHOLDER_1');
  });

  it('falls back to swg_uid when the custom header is absent', async () => {
    await start({ outcomeHeader: 'x-outcome-id' });
    expect((await postSigned(h, complaintBody({ headers: {} }))).status).toBe(200);
    expect(h.queue.read(0, 10)[0]?.outcomeId).toBe('SWG_UID_PLACEHOLDER_1');
  });

  it('stores class unknown rather than free text from the payload', async () => {
    await start();
    const reply = await postSigned(
      h,
      complaintBody({ reason: 'free text naming RECIPIENT_PLACEHOLDER' })
    );
    expect(reply.status).toBe(200);
    expect(h.queue.read(0, 10)[0]?.class).toBe('unknown');
  });

  it('answers 405 to a method other than POST and 404 to another path', async () => {
    await start();
    expect((await send(h.port, 'GET', '/webhook', undefined, {})).status).toBe(405);
    expect((await send(h.port, 'POST', '/elsewhere', '{}', {})).status).toBe(404);
  });
});

describe('capped queue', () => {
  it('answers 503 once full, keeps every earlier record, and accepts again after an ack', async () => {
    await start({ queueMaxBytes: 300 });
    let accepted = 0;
    let refused = 0;
    for (let i = 1; i <= 6; i += 1) {
      const body = complaintBody({
        event_id: `EVENT_ID_PLACEHOLDER_${i}`,
        swg_uid: `SWG_UID_PLACEHOLDER_${i}`,
      });
      const reply = await postSigned(h, body, { id: `WEBHOOK_ID_PLACEHOLDER_${i}` });
      if (reply.status === 200) {
        accepted += 1;
      } else {
        expect(reply.status).toBe(503);
        refused += 1;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
    const held = h.queue.read(0, 100);
    expect(held).toHaveLength(accepted);
    expect(held[0]?.outcomeId).toBe('SWG_UID_PLACEHOLDER_1');
    expect(h.queue.stats().bytes).toBeLessThanOrEqual(300);

    // a refused delivery was not marked seen, so Sweego's retry is accepted once room exists
    h.queue.ack(held[held.length - 1]!.seq);
    const retry = await postSigned(
      h,
      complaintBody({
        event_id: `EVENT_ID_PLACEHOLDER_${accepted + 1}`,
        swg_uid: `SWG_UID_PLACEHOLDER_${accepted + 1}`,
      }),
      { id: `WEBHOOK_ID_PLACEHOLDER_${accepted + 1}` }
    );
    expect(retry.status).toBe(200);
  });

  it('answers 503 and stores nothing when the queue cannot be written', async () => {
    await start();
    h.queue.close();
    const reply = await postSigned(h, complaintBody());
    expect(reply.status).toBe(503);
    expect(h.replay.has('id:WEBHOOK_ID_PLACEHOLDER_1')).toBe(false);
    h.queue = (await import('../src/queue.js')).openQueue(h.dir);
  });

  it('never accepts an unverified request into a full queue', async () => {
    await start({ queueMaxBytes: 1 });
    expect((await postSigned(h, complaintBody(), { secret: SECRET_B })).status).toBe(401);
    expect((await postSigned(h, complaintBody())).status).toBe(503);
  });
});
