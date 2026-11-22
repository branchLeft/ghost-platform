/**
 * Sabotage for the arrival link's auth controls. Each test imports a copy of
 * the real source with one control removed and runs the control's own scenario
 * against a real gate over a real server: RED, the removed control is felt as
 * the wrong answer (a replay admitted, an expired link admitted, a demo shown
 * as ready with no mail proof), then the same scenario against the real
 * source: GREEN, the right answer. A control that no scenario could tell was
 * removed is not a control.
 */
import { afterAll, describe, expect, it } from 'vitest';
import type { createGateHandler } from '../../src/app.js';
import type { createFileLedger } from '../../src/usedTokens.js';
import { generateKeyPair, mintInvitation } from '../helpers/invitations.js';
import {
  HOST,
  LEASE_1,
  LEASE_2,
  NOW_S,
  OTHER_HOST,
  SLOT,
  startArrivalHarness,
  type Modules,
} from '../helpers/arrivalHarness.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from '../helpers/sourceSabotage.js';

afterAll(() => {
  cleanupSabotageTmp();
});

const must =
  (from: string, to: string): Mutation =>
  (source) => {
    if (!source.includes(from)) throw new Error(`sabotage target not found: ${from}`);
    return source.replace(from, to);
  };

const gateWith = async (mutations: Record<string, Mutation>): Promise<Modules> => {
  const { createGateHandler: handler } = await importSabotaged<{
    createGateHandler: typeof createGateHandler;
  }>('app.ts', mutations);
  return { createGateHandler: handler };
};

const ledgerWith = async (mutation: Mutation): Promise<Modules> => {
  const { createFileLedger: ledger } = await importSabotaged<{
    createFileLedger: typeof createFileLedger;
  }>('usedTokens.ts', { 'usedTokens.ts': mutation });
  return { createFileLedger: ledger };
};

async function run<T>(
  mods: Modules,
  scenario: (h: Awaited<ReturnType<typeof startArrivalHarness>>) => Promise<T>
) {
  const h = await startArrivalHarness(mods);
  try {
    h.proveMail();
    return await scenario(h);
  } finally {
    await h.stop();
  }
}

describe('single use', () => {
  const replay = (mods: Modules) =>
    run(mods, async (h) => {
      const token = h.mint();
      const first = await h.exchange(token);
      const second = await h.exchange(token);
      return [first.status, second.status];
    });

  const ledgerForgets = must(
    '        await stat(join(dir, recordName(jti)));\n        return true;',
    '        await stat(join(dir, recordName(jti)));\n        return false;'
  );
  const consumeNeverRefuses = must(
    "if (isCode(err, 'EEXIST')) return false;",
    "if (isCode(err, 'EEXIST')) return true;"
  );
  const bothForget: Mutation = (source) => consumeNeverRefuses(ledgerForgets(source));

  it('a ledger that forgets lets the same link in twice; the real ledger refuses the second', async () => {
    // RED
    expect(await replay(await ledgerWith(bothForget))).toEqual([303, 303]);
    // GREEN
    expect(await replay({})).toEqual([303, 410]);
  });

  it('without the exclusive create, simultaneous exchanges of one link all get in; the real ledger admits one', async () => {
    const race = (mods: Modules) =>
      run(mods, async (h) => {
        const token = h.mint();
        const replies = await Promise.all(Array.from({ length: 8 }, () => h.exchange(token)));
        return replies.filter((reply) => reply.status === 303).length;
      });
    // RED
    expect(await race(await ledgerWith(consumeNeverRefuses))).toBeGreaterThan(1);
    // GREEN
    expect(await race({})).toBe(1);
  });

  it('if the gate did not read the ledger result, a used link is admitted again; the real gate refuses it', async () => {
    const mods = await gateWith({
      'app.ts': must(
        'if (!(await arrival.ledger.consume(verdict.claims.jti, verdict.claims.exp, nowSeconds))) {',
        'await arrival.ledger.consume(verdict.claims.jti, verdict.claims.exp, nowSeconds);\n  if (false as boolean) {'
      ),
    });
    const alsoNoRead = await gateWith({
      'app.ts': (source) =>
        must(
          'if (await arrival.ledger.isUsed(verdict.claims.jti)) {',
          'if (false as boolean) {'
        )(
          must(
            'if (!(await arrival.ledger.consume(verdict.claims.jti, verdict.claims.exp, nowSeconds))) {',
            'await arrival.ledger.consume(verdict.claims.jti, verdict.claims.exp, nowSeconds);\n  if (false as boolean) {'
          )(source)
        ),
    });
    // The page-time read still catches a replay on its own, so this one mutation alone is not enough to hide it.
    expect(await replay(mods)).toEqual([303, 410]);
    // RED: with both reads gone, the link works again.
    expect(await replay(alsoNoRead)).toEqual([303, 303]);
    // GREEN
    expect(await replay({})).toEqual([303, 410]);
  });
});

describe('expiry', () => {
  const stale = (mods: Modules) =>
    run(mods, async (h) => {
      const token = h.mint({ host: HOST, iat: NOW_S - 400, exp: NOW_S - 100 });
      return (await h.exchange(token)).status;
    });

  const expiresBetweenPageAndExchange = (mods: Modules) =>
    run(mods, async (h) => {
      const token = h.mint({ host: HOST, exp: NOW_S + 120 });
      const page = await h.follow(token);
      h.now.ms += 121_000;
      h.proveMail(SLOT, LEASE_1, NOW_S + 121);
      return [page.status, (await h.exchange(token)).status];
    });

  const neverExpires = must(
    "if (expiresAt <= nowSeconds) return { ok: false, reason: 'expired' };",
    "if (false as boolean) return { ok: false, reason: 'expired' };"
  );

  it('without the expiry check an expired link is admitted; the real gate refuses it', async () => {
    const mods = await gateWith({ 'invitation.ts': neverExpires });
    // RED
    expect(await stale(mods)).toBe(303);
    // GREEN
    expect(await stale({})).toBe(401);
  });

  it('without the expiry check a link that lapses before it is used is still admitted; the real gate refuses it', async () => {
    const mods = await gateWith({ 'invitation.ts': neverExpires });
    // RED: the page was fine, and so is the lapsed exchange.
    expect(await expiresBetweenPageAndExchange(mods)).toEqual([200, 303]);
    // GREEN
    expect(await expiresBetweenPageAndExchange({})).toEqual([200, 401]);
  });

  it('without the lifetime cap a link good for a year is admitted; the real gate refuses it', async () => {
    const year = (mods: Modules) =>
      run(
        mods,
        async (h) => (await h.exchange(h.mint({ host: HOST, exp: NOW_S + 365 * 24 * 3600 }))).status
      );
    const mods = await gateWith({
      'invitation.ts': (source) =>
        must(
          "if (expiresAt - issuedAt > MAX_INVITATION_TTL_SECONDS) return { ok: false, reason: 'lifetime' };",
          ''
        )(
          must(
            "if (expiresAt - nowSeconds > MAX_INVITATION_TTL_SECONDS) return { ok: false, reason: 'lifetime' };",
            ''
          )(source)
        ),
    });
    // RED
    expect(await year(mods)).toBe(303);
    // GREEN
    expect(await year({})).toBe(401);
  });
});

describe('who the link is for', () => {
  it('without the host binding a link for one demo opens another; the real gate refuses it', async () => {
    const crossed = (mods: Modules) =>
      run(mods, async (h) => (await h.exchange(h.mint({ host: OTHER_HOST }), HOST)).status);
    const mods = await gateWith({
      'invitation.ts': must(
        "if (claimedHost.toLowerCase() !== host) return { ok: false, reason: 'host' };",
        ''
      ),
    });
    // RED
    expect(await crossed(mods)).toBe(303);
    // GREEN
    expect(await crossed({})).toBe(401);
  });

  it('without the signature check a forged link is admitted; the real gate refuses it', async () => {
    const forged = (mods: Modules) =>
      run(mods, async (h) => {
        const other = generateKeyPair();
        return (await h.exchange(mintInvitation(other.privateKey, { host: HOST }, NOW_S))).status;
      });
    const mods = await gateWith({
      'invitation.ts': must(
        "if (!verify(null, Buffer.from(body, 'ascii'), publicKey, signatureBytes)) {",
        'if (false as boolean) {'
      ),
    });
    // RED
    expect(await forged(mods)).toBe(303);
    // GREEN
    expect(await forged({})).toBe(401);
  });
});

describe('ready only when the mail path is proved', () => {
  const noProof = (mods: Modules) =>
    run(mods, async (h) => {
      const { rmSync } = await import('node:fs');
      const { join } = await import('node:path');
      rmSync(join(h.proofDir, `${SLOT}.mail.json`));
      const page = await h.follow(h.mint());
      return [page.status, page.body.includes('DEMO_ARRIVAL_READY')];
    });

  it('if the proof were not required the page says ready with a broken mail path; the real gate does not', async () => {
    const mods = await gateWith({
      'mailProof.ts': must(
        'if (proof === null || proof.lease !== current) return false;',
        'return true;'
      ),
    });
    // RED
    expect(await noProof(mods)).toEqual([200, true]);
    // GREEN
    expect(await noProof({})).toEqual([503, false]);
  });

  it('if the proof were not tied to the lease, the last tenant’s proof makes a recycled slot ready', async () => {
    const recycled = (mods: Modules) =>
      run(mods, async (h) => {
        const current = h.leases.get(SLOT);
        if (current === undefined) throw new Error('no lease');
        h.leases.set(SLOT, { lease: LEASE_2, hashId: current.hashId });
        return (await h.follow(h.mint())).status;
      });
    const mods = await gateWith({
      'mailProof.ts': must('proof.lease !== current', 'false as boolean'),
    });
    // RED
    expect(await recycled(mods)).toBe(200);
    // GREEN
    expect(await recycled({})).toBe(503);
  });

  it('if the proof never went stale, a path that broke an hour ago still counts; the real gate refuses it', async () => {
    const aged = (mods: Modules) =>
      run(mods, async (h) => {
        h.proveMail(SLOT, LEASE_1, NOW_S - 7200);
        return (await h.follow(h.mint())).status;
      });
    const mods = await gateWith({
      'mailProof.ts': must('return nowSeconds - proof.provedAt <= maxAgeSeconds;', 'return true;'),
    });
    // RED
    expect(await aged(mods)).toBe(200);
    // GREEN
    expect(await aged({})).toBe(503);
  });
});
