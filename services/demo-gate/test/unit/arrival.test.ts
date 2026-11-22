import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERIFY_PATH } from '../../src/app.js';
import { COOKIE_NAME } from '../../src/cookie.js';
import { mailProofFileName } from '../../src/mailProof.js';
import { createFileLedger } from '../../src/usedTokens.js';
import { generateKeyPair, mintInvitation } from '../helpers/invitations.js';
import {
  cookieOf,
  HOST,
  jtiOf,
  LEASE_1,
  LEASE_2,
  MAX_INVALID_ATTEMPTS,
  NOW_S,
  OTHER_HOST,
  SLOT,
  startArrivalHarness,
  type ArrivalHarness,
} from '../helpers/arrivalHarness.js';

let h: ArrivalHarness;
const { follow, exchange, proveMail, mint, send } = {
  follow: (...a: Parameters<ArrivalHarness['follow']>) => h.follow(...a),
  exchange: (...a: Parameters<ArrivalHarness['exchange']>) => h.exchange(...a),
  proveMail: (...a: Parameters<ArrivalHarness['proveMail']>) => h.proveMail(...a),
  mint: (...a: Parameters<ArrivalHarness['mint']>) => h.mint(...a),
  send: (...a: Parameters<ArrivalHarness['send']>) => h.send(...a),
};

beforeEach(async () => {
  h = await startArrivalHarness();
  proveMail();
});

afterEach(async () => {
  await h.stop();
});

describe('the arrival link', () => {
  it('opens a confirmation page that spends nothing, however often it is followed', async () => {
    const token = mint();
    for (const method of ['GET', 'GET', 'HEAD']) {
      expect((await follow(token, HOST, method)).status).toBe(200);
    }
    const page = await follow(token);
    expect(page.body).toContain('DEMO_ARRIVAL_READY');
    expect(page.body).toContain('action="/__gate/enter"');
    expect(await createFileLedger(h.ledgerDir).isUsed(jtiOf(token))).toBe(false);
    // Still good: nothing was spent by looking.
    expect((await exchange(token)).status).toBe(303);
  });

  it('exchanges the token for a gate session and sends the owner on to Ghost admin', async () => {
    const token = mint();
    const reply = await exchange(token);
    expect(reply.status).toBe(303);
    expect(reply.headers.location).toBe(`/ghost/?bl_break_glass=${encodeURIComponent(token)}`);
    const cookie = cookieOf(reply);
    expect(cookie.startsWith(`${COOKIE_NAME}=`)).toBe(true);
    const verify = await send('GET', VERIFY_PATH, { host: HOST, cookie });
    expect(verify.status).toBe(200);
  });

  it('refuses a replayed token: the second exchange is a 410 with no session', async () => {
    const token = mint();
    expect((await exchange(token)).status).toBe(303);
    const replay = await exchange(token);
    expect(replay.status).toBe(410);
    expect(replay.headers['set-cookie']).toBeUndefined();
    expect(replay.body).toContain('DEMO_ARRIVAL_LINK_USED');
    // The confirmation page says so as well, instead of offering a form that cannot work.
    expect((await follow(token)).status).toBe(410);
  });

  it('lets exactly one of simultaneous exchanges of one token through', async () => {
    const token = mint();
    const replies = await Promise.all(Array.from({ length: 12 }, () => exchange(token)));
    expect(replies.filter((reply) => reply.status === 303)).toHaveLength(1);
    expect(replies.filter((reply) => reply.status === 410)).toHaveLength(11);
  });

  it('keeps a used token used for a ledger opened afresh over the same directory', async () => {
    const token = mint();
    expect((await exchange(token)).status).toBe(303);
    expect(await createFileLedger(h.ledgerDir).isUsed(jtiOf(token))).toBe(true);
  });

  it('refuses an expired token, and one that expires between the page and the exchange', async () => {
    const stale = mint({ host: HOST, iat: NOW_S - 400, exp: NOW_S - 100 });
    const reply = await exchange(stale);
    expect(reply.status).toBe(401);
    expect(reply.body).toContain('DEMO_ARRIVAL_LINK_EXPIRED');

    const token = mint({ host: HOST, exp: NOW_S + 120 });
    expect((await follow(token)).status).toBe(200);
    h.now.ms += 121_000;
    proveMail(SLOT, LEASE_1, NOW_S + 121);
    const late = await exchange(token);
    expect(late.status).toBe(401);
    expect(late.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a token minted for another host, a forged one and a tampered one', async () => {
    const forged = generateKeyPair();
    const tokens = [
      mint({ host: OTHER_HOST }),
      mintInvitation(forged.privateKey, { host: HOST }, NOW_S),
      `${mint().slice(0, -3)}AAA`,
    ];
    for (const [index, token] of tokens.entries()) {
      const reply = await exchange(token, HOST, { 'x-forwarded-for': `203.0.113.${20 + index}` });
      expect(reply.status).toBe(401);
      expect(reply.body).toContain('DEMO_ARRIVAL_LINK_INVALID');
      expect(reply.headers['set-cookie']).toBeUndefined();
    }
  });

  it('refuses an unknown host', async () => {
    expect((await exchange(mint(), 'nobody.demo.example')).status).toBe(401);
  });

  it('does not say ready, and does not spend the link, until the mail path is proved', async () => {
    rmSync(join(h.proofDir, mailProofFileName(SLOT)));
    const token = mint();
    const page = await follow(token);
    expect(page.status).toBe(503);
    expect(page.body).toContain('DEMO_ARRIVAL_NOT_READY');
    expect(page.body).not.toContain('DEMO_ARRIVAL_READY');
    expect(page.headers['retry-after']).toBe('30');
    const refused = await exchange(token);
    expect(refused.status).toBe(503);
    expect(refused.headers['set-cookie']).toBeUndefined();
    // Proved: the same link still works.
    proveMail();
    expect((await exchange(token)).status).toBe(303);
  });

  it.each([
    ['a proof from a previous lease', () => proveMail(SLOT, LEASE_2)],
    ['a proof that has gone stale', () => proveMail(SLOT, LEASE_1, NOW_S - 601)],
    ['a malformed proof', () => writeFileSync(join(h.proofDir, mailProofFileName(SLOT)), '{')],
  ])('is not ready on %s', async (_name, arrange) => {
    arrange();
    expect((await follow(mint())).status).toBe(503);
  });

  it('is not ready for a slot whose lease cannot be read', async () => {
    h.leases.delete(SLOT);
    expect((await follow(mint())).status).toBe(503);
  });

  it('starts a recycled slot unproved: the old proof does not carry to the new lease', async () => {
    expect((await follow(mint())).status).toBe(200);
    const current = h.leases.get(SLOT);
    if (current === undefined) throw new Error('no lease to recycle');
    h.leases.set(SLOT, { lease: LEASE_2, hashId: current.hashId });
    expect((await follow(mint())).status).toBe(503);
  });

  it('answers a malformed exchange with 400', async () => {
    const wrongType = await send(
      'POST',
      '/__gate/enter',
      { host: HOST, 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
      '{}'
    );
    expect(wrongType.status).toBe(400);
  });

  it('bounds invalid attempts per source with 429, and leaves other sources alone', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= MAX_INVALID_ATTEMPTS; i += 1) {
      statuses.push((await exchange('garbage')).status);
    }
    expect(statuses.slice(0, MAX_INVALID_ATTEMPTS)).toEqual(Array(MAX_INVALID_ATTEMPTS).fill(401));
    const bounded = await exchange('garbage');
    expect(bounded.status).toBe(429);
    expect(bounded.headers['retry-after']).toBeDefined();
    // A genuine link from the same source is not charged, so it is not refused by the bound.
    expect((await follow(mint())).status).toBe(200);
    // Another source is untouched.
    const elsewhere = await exchange(mint(), HOST, { 'x-forwarded-for': '203.0.113.99' });
    expect(elsewhere.status).toBe(303);
  });

  it('refuses a request whose source cannot be established', async () => {
    const reply = await send('GET', '/__gate/enter?t=x', { host: HOST, 'x-forwarded-for': 'junk' });
    expect(reply.status).toBe(403);
  });

  it('never writes a token into the log', async () => {
    const token = mint();
    await exchange(token);
    await exchange(token);
    await exchange(`${token}x`);
    expect(h.logs.length).toBeGreaterThan(0);
    for (const line of h.logs) expect(line).not.toContain(token.slice(0, 20));
  });

  it('has no arrival route when it is not configured', async () => {
    await h.stop();
    h = await startArrivalHarness({}, false);
    expect((await follow(mint())).status).toBe(404);
    expect((await exchange(mint())).status).toBe(404);
  });
});
