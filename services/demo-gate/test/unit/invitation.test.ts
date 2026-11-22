import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  MAX_INVITATION_LENGTH,
  parseInvitationPublicKey,
  verifyInvitation,
} from '../../src/invitation.js';
import { generateKeyPair, mintInvitation, mintRaw } from '../helpers/invitations.js';

const HOST = 'a1b2.demo.example';
const NOW = 1_900_000_000;
const keys = generateKeyPair();
const publicKey = parseInvitationPublicKey(keys.publicKeyBase64);

function verify(token: string, host = HOST, now = NOW) {
  return verifyInvitation(publicKey, token, host, now);
}

describe('parseInvitationPublicKey', () => {
  it('reads the base64 SPKI form the adapter is configured with, with a trailing newline', () => {
    expect(() => parseInvitationPublicKey(`${keys.publicKeyBase64}\n`)).not.toThrow();
  });

  it.each([
    ['not base64', 'not base64!'],
    ['not an SPKI key', Buffer.from('hello').toString('base64')],
  ])('refuses %s', (_name, text) => {
    expect(() => parseInvitationPublicKey(text)).toThrow();
  });

  it('refuses a key that is not Ed25519', () => {
    const { publicKey: rsa } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const text = rsa.export({ format: 'der', type: 'spki' }).toString('base64');
    expect(() => parseInvitationPublicKey(text)).toThrow(/Ed25519/);
  });
});

describe('verifyInvitation', () => {
  it('admits a genuine, unexpired token for this host and returns its claims', () => {
    const token = mintInvitation(keys.privateKey, { host: HOST, jti: 'j-1' }, NOW);
    const verdict = verify(token);
    expect(verdict).toMatchObject({ ok: true, claims: { jti: 'j-1', host: HOST, exp: NOW + 300 } });
  });

  it('refuses a token whose expiry has passed, exactly at the expiry second', () => {
    const token = mintInvitation(keys.privateKey, { host: HOST }, NOW);
    expect(verify(token, HOST, NOW + 299)).toMatchObject({ ok: true });
    expect(verify(token, HOST, NOW + 300)).toEqual({ ok: false, reason: 'expired' });
    expect(verify(token, HOST, NOW + 3600)).toEqual({ ok: false, reason: 'expired' });
  });

  it('refuses a token minted for another host', () => {
    const token = mintInvitation(keys.privateKey, { host: 'c3d4.demo.example' }, NOW);
    expect(verify(token)).toEqual({ ok: false, reason: 'host' });
  });

  it('compares the host claim without regard to case', () => {
    const token = mintInvitation(keys.privateKey, { host: 'A1B2.Demo.Example' }, NOW);
    expect(verify(token)).toMatchObject({ ok: true });
  });

  it('refuses a token signed by another key, and one whose body was altered', () => {
    const other = generateKeyPair();
    expect(verify(mintInvitation(other.privateKey, { host: HOST }, NOW))).toEqual({
      ok: false,
      reason: 'signature',
    });
    const good = mintInvitation(keys.privateKey, { host: HOST }, NOW);
    const [body, signature] = good.split('.') as [string, string];
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as object;
    const altered = Buffer.from(JSON.stringify({ ...claims, exp: NOW + 600 })).toString(
      'base64url'
    );
    expect(verify(`${altered}.${signature}`)).toEqual({ ok: false, reason: 'signature' });
  });

  it.each([
    ['empty', ''],
    ['one segment', 'abc'],
    ['three segments', 'a.b.c'],
    ['not base64url', 'a!b.c!d'],
    ['a short signature', 'e30.AAAA'],
    ['oversized', 'a'.repeat(MAX_INVITATION_LENGTH + 1)],
  ])('refuses a malformed token: %s', (_name, token) => {
    expect(verify(token)).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['not JSON', 'not json'],
    ['an array', '[]'],
    ['null', 'null'],
    ['a missing jti', JSON.stringify({ sub: 'a', aud: 'b', host: HOST, iat: NOW, exp: NOW + 60 })],
    [
      'a non-integer exp',
      JSON.stringify({ sub: 'a', aud: 'b', host: HOST, jti: 'j', iat: NOW, exp: 1.5 }),
    ],
    [
      'an empty sub',
      JSON.stringify({ sub: '', aud: 'b', host: HOST, jti: 'j', iat: NOW, exp: NOW + 60 }),
    ],
    [
      'an iat not before exp',
      JSON.stringify({ sub: 'a', aud: 'b', host: HOST, jti: 'j', iat: NOW + 60, exp: NOW + 60 }),
    ],
  ])('refuses claims that are %s, even when signed', (_name, body) => {
    expect(verify(mintRaw(keys.privateKey, body))).toEqual({ ok: false, reason: 'claims' });
  });

  it('refuses a lifetime longer than 900 seconds, by its own span and by the time left', () => {
    const long = mintInvitation(keys.privateKey, { host: HOST, exp: NOW + 901 }, NOW);
    expect(verify(long)).toEqual({ ok: false, reason: 'lifetime' });
    const atCap = mintInvitation(keys.privateKey, { host: HOST, exp: NOW + 900 }, NOW);
    expect(verify(atCap)).toMatchObject({ ok: true });
    const early = mintInvitation(keys.privateKey, { host: HOST, iat: NOW - 600, exp: NOW + 600 });
    expect(verify(early, HOST, NOW)).toEqual({ ok: false, reason: 'lifetime' });
  });

  it('refuses a token issued more than 60 seconds in the gate’s future', () => {
    const skewed = mintInvitation(keys.privateKey, { host: HOST, iat: NOW + 61, exp: NOW + 300 });
    expect(verify(skewed)).toEqual({ ok: false, reason: 'issued-in-the-future' });
    const within = mintInvitation(keys.privateKey, { host: HOST, iat: NOW + 60, exp: NOW + 300 });
    expect(verify(within)).toMatchObject({ ok: true });
  });
});
