import { describe, expect, it } from 'vitest';
import { validateLeaseId, validateSlotName } from '@branchleft/ghost-platform-render-core';
import {
  COOKIE_NAME,
  readGateCookies,
  setCookieHeader,
  signCookie,
  verifyCookie,
} from '../../src/cookie.js';

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
const claim = {
  slot: validateSlotName('demo-07'),
  lease: validateLeaseId('01J9F4Q7ZC3M8V2K6X0R5T1B9D'),
  exp: 2_000_000_000,
};
const NOW = 1_900_000_000;

describe('signCookie / verifyCookie', () => {
  it('round-trips a claim', () => {
    expect(verifyCookie(KEY, signCookie(KEY, claim), NOW)).toEqual({ ok: true, claim });
  });

  it('refuses a cookie signed with another key', () => {
    expect(verifyCookie(KEY, signCookie(OTHER_KEY, claim), NOW)).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it.each([
    ['slot', (v: string) => v.replace('demo-07', 'demo-08')],
    ['lease', (v: string) => v.replace('01J9F4Q7ZC3M8V2K6X0R5T1B9D', '01J9F4Q7ZC3M8V2K6X0R5T1B9E')],
    ['expiry', (v: string) => v.replace('2000000000', '2000000001')],
    ['signature', (v: string) => `${v.slice(0, -1)}${v.endsWith('A') ? 'B' : 'A'}`],
  ])('refuses a cookie whose %s was altered', (_label, tamper) => {
    expect(verifyCookie(KEY, tamper(signCookie(KEY, claim)), NOW).ok).toBe(false);
  });

  it('refuses an expired cookie, and one expiring this very second', () => {
    const value = signCookie(KEY, claim);
    expect(verifyCookie(KEY, value, claim.exp)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyCookie(KEY, value, claim.exp + 1)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyCookie(KEY, value, claim.exp - 1).ok).toBe(true);
  });

  it('refuses a correctly signed claim whose fields fail validation', () => {
    const bad = { ...claim, slot: 'Demo' as typeof claim.slot };
    expect(verifyCookie(KEY, signCookie(KEY, bad), NOW).ok).toBe(false);
    const badLease = { ...claim, lease: '81J9F4Q7ZC3M8V2K6X0R5T1B9D' as typeof claim.lease };
    expect(verifyCookie(KEY, signCookie(KEY, badLease), NOW)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it.each(['', 'v1', 'v2.demo-07.01J9F4Q7ZC3M8V2K6X0R5T1B9D.2000000000.x', 'garbage'])(
    'refuses malformed value %j',
    (value) => {
      expect(verifyCookie(KEY, value, NOW)).toEqual({ ok: false, reason: 'malformed' });
    }
  );
});

describe('readGateCookies', () => {
  it('returns every value under the gate name and ignores the rest', () => {
    expect(readGateCookies(`a=1; ${COOKIE_NAME}=x; junk; ${COOKIE_NAME}=y ; b=2`)).toEqual([
      'x',
      'y',
    ]);
  });

  it('returns nothing without a header', () => {
    expect(readGateCookies(undefined)).toEqual([]);
  });
});

describe('setCookieHeader', () => {
  it('sets every attribute the cookie depends on', () => {
    const header = setCookieHeader('v', 60);
    expect(header).toBe(`${COOKIE_NAME}=v; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`);
    expect(header).not.toMatch(/Domain=/i);
    expect(COOKIE_NAME.startsWith('__Host-')).toBe(true);
  });
});
