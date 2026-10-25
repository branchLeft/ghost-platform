import { describe, expect, it } from 'vitest';
import { verifyRequest, type AuthDeps } from '../../src/auth.js';
import { createInMemoryNonceStore } from '../../src/nonceStore.js';
import { generateTestKeyPair, signHeaders } from '../helpers/signer.js';

function deps(
  nowMs: number,
  keyPair = generateTestKeyPair(),
  windowSeconds = 60,
  processStartSeconds = Math.floor(nowMs / 1000) - 1_000_000
) {
  return {
    keyPair,
    deps: {
      verifyKey: keyPair.publicKeyRaw,
      replayWindowSeconds: windowSeconds,
      nonces: createInMemoryNonceStore(windowSeconds * 1000),
      processStartSeconds,
      nowMs: () => nowMs,
    },
  };
}

function headersFor(
  keyPair: ReturnType<typeof generateTestKeyPair>,
  method: string,
  path: string,
  body: Buffer,
  seconds: number,
  nonce?: string
): { timestamp: string; nonce: string; signature: string } {
  const h = signHeaders(keyPair, method, path, body, seconds, nonce);
  return {
    timestamp: h['X-Broker-Timestamp'],
    nonce: h['X-Broker-Nonce'],
    signature: h['X-Broker-Signature'],
  };
}

describe('verifyRequest', () => {
  it('admits a correctly signed, fresh request', () => {
    const nowMs = 1_700_000_000_000;
    const { keyPair, deps: d } = deps(nowMs);
    const body = Buffer.from('{"slot":"0"}');
    const headers = headersFor(keyPair, 'POST', '/reconcile', body, Math.floor(nowMs / 1000));
    const result = verifyRequest(d, 'POST', '/reconcile', headers, body);
    expect(result).toEqual({ ok: true });
  });

  it('refuses a request signed too far in the past', () => {
    const nowMs = 1_700_000_000_000;
    const { keyPair, deps: d } = deps(nowMs, undefined, 60);
    const body = Buffer.from('{}');
    const staleSeconds = Math.floor(nowMs / 1000) - 120;
    const headers = headersFor(keyPair, 'POST', '/reconcile', body, staleSeconds);
    const result = verifyRequest(d, 'POST', '/reconcile', headers, body);
    expect(result.ok).toBe(false);
  });

  it('refuses a request signed too far in the future', () => {
    const nowMs = 1_700_000_000_000;
    const { keyPair, deps: d } = deps(nowMs, undefined, 60);
    const body = Buffer.from('{}');
    const futureSeconds = Math.floor(nowMs / 1000) + 30;
    const headers = headersFor(keyPair, 'POST', '/reconcile', body, futureSeconds);
    const result = verifyRequest(d, 'POST', '/reconcile', headers, body);
    expect(result.ok).toBe(false);
  });

  it('refuses a replayed nonce even with an otherwise valid signature', () => {
    const nowMs = 1_700_000_000_000;
    const { keyPair, deps: d } = deps(nowMs);
    const body = Buffer.from('{}');
    const headers = headersFor(keyPair, 'POST', '/reconcile', body, Math.floor(nowMs / 1000));
    const first = verifyRequest(d, 'POST', '/reconcile', headers, body);
    const second = verifyRequest(d, 'POST', '/reconcile', headers, body);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
  });

  it('refuses a request missing the signature header', () => {
    const nowMs = 1_700_000_000_000;
    const { deps: d } = deps(nowMs);
    const result = verifyRequest(
      d,
      'POST',
      '/reconcile',
      { timestamp: '1700000000', nonce: 'n'.repeat(16) },
      Buffer.from('{}')
    );
    expect(result.ok).toBe(false);
  });

  it('refuses a malformed nonce shape before ever claiming it', () => {
    const nowMs = 1_700_000_000_000;
    const { deps: d } = deps(nowMs);
    const body = Buffer.from('{}');
    const result = verifyRequest(
      d,
      'POST',
      '/reconcile',
      { timestamp: String(Math.floor(nowMs / 1000)), nonce: 'short', signature: 'irrelevant' },
      body
    );
    expect(result.ok).toBe(false);
    // The malformed nonce must not have been claimed -- a legitimately
    // signed retry with the same (illegal) nonce would still be refused by
    // shape, but this proves the store was never touched for it.
    expect(d.nonces.claim('short', nowMs)).toBe(true);
  });

  it('refuses a request whose signature does not match, even with a valid timestamp and fresh nonce', () => {
    const nowMs = 1_700_000_000_000;
    const { deps: d } = deps(nowMs);
    const other = generateTestKeyPair();
    const body = Buffer.from('{}');
    const headers = headersFor(other, 'POST', '/reconcile', body, Math.floor(nowMs / 1000));
    const result = verifyRequest(d, 'POST', '/reconcile', headers, body);
    expect(result.ok).toBe(false);
  });

  // --- F3: a request replayed after a broker restart must be refused. ---
  it('refuses a timestamp that predates this process, even though it is inside the ordinary window', () => {
    const nowMs = 1_700_000_000_000;
    const nowSeconds = Math.floor(nowMs / 1000);
    const keyPair = generateTestKeyPair();
    // The process "started" one second after the request's own timestamp --
    // as a restart seconds after a request was captured would -- while the
    // ordinary 60s replay window would otherwise still admit it.
    const { deps: d } = deps(nowMs, keyPair, 60, nowSeconds - 4);
    const body = Buffer.from('{"slot":"3"}');
    const headers = headersFor(keyPair, 'POST', '/reset', body, nowSeconds - 5);
    const result = verifyRequest(d, 'POST', '/reset', headers, body);
    expect(result.ok).toBe(false);
  });

  // --- Item 2: the floor is `<=`, not `<` -- a capture, crash and restart
  // that all land inside one wall-clock second must still be refused. ---
  it('refuses a timestamp equal to process start (same-second capture, crash and restart)', () => {
    const nowMs = 1_700_000_000_000;
    const nowSeconds = Math.floor(nowMs / 1000);
    const keyPair = generateTestKeyPair();
    // The original request was captured at second T; the process crashed
    // and restarted inside that same second, so `processStartSeconds`
    // equals the captured request's own timestamp exactly, not merely
    // "before" it -- the edge `<` alone misses.
    const { deps: d } = deps(nowMs, keyPair, 60, nowSeconds);
    const body = Buffer.from('{"slot":"3"}');
    const headers = headersFor(keyPair, 'POST', '/reset', body, nowSeconds);
    const result = verifyRequest(d, 'POST', '/reset', headers, body);
    expect(result.ok).toBe(false);
  });

  it('admits a timestamp strictly after process start, inside the window', () => {
    const nowMs = 1_700_000_000_000;
    const nowSeconds = Math.floor(nowMs / 1000);
    const keyPair = generateTestKeyPair();
    const { deps: d } = deps(nowMs, keyPair, 60, nowSeconds - 5);
    const body = Buffer.from('{"slot":"3"}');
    const headers = headersFor(keyPair, 'POST', '/reset', body, nowSeconds - 4);
    const result = verifyRequest(d, 'POST', '/reset', headers, body);
    expect(result.ok).toBe(true);
  });

  // --- F4: the nonce is claimed only after the signature verifies. ---
  it('an unsigned (forged-signature) request does not burn the nonce -- the legitimate signer can still use it', () => {
    const nowMs = 1_700_000_000_000;
    const { keyPair, deps: d } = deps(nowMs);
    const body = Buffer.from('{"slot":"0"}');
    const nonce = 'n'.repeat(16);
    const forgedSignature = Buffer.alloc(64).toString('base64');

    const forged = verifyRequest(
      d,
      'POST',
      '/reset',
      { timestamp: String(Math.floor(nowMs / 1000)), nonce, signature: forgedSignature },
      body
    );
    expect(forged.ok).toBe(false);

    // The exact same nonce, now legitimately signed, must still be usable:
    // the forged attempt above must not have claimed it.
    const headers = headersFor(keyPair, 'POST', '/reset', body, Math.floor(nowMs / 1000), nonce);
    const legit = verifyRequest(d, 'POST', '/reset', headers, body);
    expect(legit.ok).toBe(true);
  });

  describe('nonce lifetime against the timestamp window', () => {
    const windowSeconds = 60;
    const forwardSkewSeconds = 5;
    const nowMs = 1_700_000_000_000;
    const body = Buffer.from('{"slot":"0"}');

    function movableClock(): {
      keyPair: ReturnType<typeof generateTestKeyPair>;
      d: AuthDeps;
      setClockMs: (ms: number) => void;
    } {
      let clockMs = nowMs;
      const { keyPair, deps: fixed } = deps(nowMs, undefined, windowSeconds);
      return {
        keyPair,
        d: { ...fixed, nowMs: () => clockMs },
        setClockMs: (ms) => {
          clockMs = ms;
        },
      };
    }

    // The last millisecond at which the timestamp check still admits a
    // request signed at `timestampSeconds`.
    function lastAcceptedMs(timestampSeconds: number): number {
      return (timestampSeconds + windowSeconds + 1) * 1000 - 1;
    }

    it('keeps a nonce claimed at the earliest accepted instant refused until the timestamp window closes', () => {
      const { keyPair, d, setClockMs } = movableClock();
      const timestampSeconds = Math.floor(nowMs / 1000) + forwardSkewSeconds;
      const headers = headersFor(keyPair, 'POST', '/reconcile', body, timestampSeconds);

      expect(verifyRequest(d, 'POST', '/reconcile', headers, body)).toEqual({ ok: true });

      setClockMs(lastAcceptedMs(timestampSeconds));
      expect(verifyRequest(d, 'POST', '/reconcile', headers, body)).toEqual({
        ok: false,
        reason: 'nonce already used',
      });
    });

    it('refuses the replay at every second between the claim and the last accepted instant', () => {
      const { keyPair, d, setClockMs } = movableClock();
      const timestampSeconds = Math.floor(nowMs / 1000) + forwardSkewSeconds;
      const headers = headersFor(keyPair, 'POST', '/reconcile', body, timestampSeconds);
      expect(verifyRequest(d, 'POST', '/reconcile', headers, body)).toEqual({ ok: true });

      const instants: number[] = [];
      for (let instant = nowMs + 1; instant < lastAcceptedMs(timestampSeconds); instant += 1000) {
        instants.push(instant);
      }
      instants.push(lastAcceptedMs(timestampSeconds));

      for (const instant of instants) {
        setClockMs(instant);
        expect(
          verifyRequest(d, 'POST', '/reconcile', headers, body),
          `replay at +${instant - nowMs} ms after the claim`
        ).toEqual({ ok: false, reason: 'nonce already used' });
      }
    });

    it("keeps the nonce refused to the last accepted instant for a request stamped in the clock's own second", () => {
      const { keyPair, d, setClockMs } = movableClock();
      const timestampSeconds = Math.floor(nowMs / 1000);
      const headers = headersFor(keyPair, 'POST', '/reconcile', body, timestampSeconds);

      expect(verifyRequest(d, 'POST', '/reconcile', headers, body)).toEqual({ ok: true });

      setClockMs(lastAcceptedMs(timestampSeconds));
      expect(verifyRequest(d, 'POST', '/reconcile', headers, body)).toEqual({
        ok: false,
        reason: 'nonce already used',
      });
    });

    it.each([
      ["stamped in the clock's own second", 0],
      ['stamped the full forward skew ahead', forwardSkewSeconds],
    ])(
      'hands over to the timestamp check one millisecond later for a request %s',
      (_label, secondsAhead) => {
        const { keyPair, d, setClockMs } = movableClock();
        const timestampSeconds = Math.floor(nowMs / 1000) + secondsAhead;
        const headers = headersFor(keyPair, 'POST', '/reconcile', body, timestampSeconds);
        expect(verifyRequest(d, 'POST', '/reconcile', headers, body)).toEqual({ ok: true });

        setClockMs(lastAcceptedMs(timestampSeconds) + 1);
        expect(verifyRequest(d, 'POST', '/reconcile', headers, body)).toEqual({
          ok: false,
          reason: 'timestamp outside the replay window',
        });
      }
    );
  });
});
