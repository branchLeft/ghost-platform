import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeClock, makeKeys, newTempDir, signHeaders } from '../helpers/verdict-host-rig.mjs';

const require = createRequire(import.meta.url);
const {
  createAuthenticator,
  createNonceStore,
  loadVerifyKey,
  publicKeyFromRaw,
} = require('../../verdict-host/auth.js');

const PATH = '/safety/v1/pending';
let directory;

afterEach(() => {
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
  directory = undefined;
});

function setup(options = {}) {
  directory = newTempDir();
  const keys = makeKeys(directory);
  const clock = makeClock();
  const verify = createAuthenticator({
    publicKey: loadVerifyKey(keys.keyFile),
    now: clock.now,
    ...options,
  });
  clock.advance(2000);
  const send = (overrides = {}, { method = 'GET', url = PATH, body = '' } = {}) => {
    const headers = {
      ...signHeaders(keys.privateKey, method, url, body, { now: clock.now() }),
      ...overrides,
    };
    return verify(method, url, headers, Buffer.from(body));
  };
  return { keys, clock, verify, send };
}

describe('a signed request', () => {
  it('is accepted once and refused as a replay the second time', () => {
    const { keys, clock, verify } = setup();
    const headers = signHeaders(keys.privateKey, 'GET', PATH, '', { now: clock.now() });
    expect(verify('GET', PATH, headers, Buffer.alloc(0))).toEqual({ ok: true });
    expect(verify('GET', PATH, headers, Buffer.alloc(0))).toEqual({ ok: false, reason: 'replay' });
  });

  it('is bound to its method, path and body', () => {
    const { keys, clock, verify } = setup();
    const signed = signHeaders(keys.privateKey, 'GET', PATH, '', { now: clock.now() });
    expect(verify('POST', PATH, signed, Buffer.alloc(0))).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(verify('GET', '/safety/v1/verdicts', signed, Buffer.alloc(0))).toEqual({
      ok: false,
      reason: 'signature',
    });
    expect(verify('GET', PATH, signed, Buffer.from('x'))).toEqual({
      ok: false,
      reason: 'signature',
    });
  });

  it('is refused when signed by another key', () => {
    const { clock, verify } = setup();
    const other = crypto.generateKeyPairSync('ed25519');
    const signed = signHeaders(other.privateKey, 'GET', PATH, '', { now: clock.now() });
    expect(verify('GET', PATH, signed, Buffer.alloc(0)).reason).toBe('signature');
  });

  it.each([
    ['no timestamp', { 'x-broker-timestamp': undefined }, 'timestamp'],
    ['a timestamp that is not digits', { 'x-broker-timestamp': '12.5' }, 'timestamp'],
    ['no nonce', { 'x-broker-nonce': undefined }, 'nonce'],
    ['a short nonce', { 'x-broker-nonce': 'short' }, 'nonce'],
    ['a nonce with a forbidden character', { 'x-broker-nonce': `${'a'.repeat(20)}!` }, 'nonce'],
    ['no signature', { 'x-broker-signature': undefined }, 'signature-missing'],
    ['an empty signature', { 'x-broker-signature': '' }, 'signature-missing'],
    ['a short signature', { 'x-broker-signature': 'AAAA' }, 'signature'],
  ])('is refused with %s', (_name, overrides, reason) => {
    const { send } = setup();
    expect(send(overrides)).toEqual({ ok: false, reason });
  });

  it('is refused outside the replay window and beyond the forward skew', () => {
    const { send, clock } = setup({ replayWindowSeconds: 30 });
    const now = Math.floor(clock.now() / 1000);
    expect(send({ 'x-broker-timestamp': String(now - 31) }).reason).toBe('window');
    expect(send({ 'x-broker-timestamp': String(now + 6) }).reason).toBe('window');
  });

  it('is refused when it predates the process, whatever the window says', () => {
    const { send, clock } = setup({ replayWindowSeconds: 3600 });
    const start = Math.floor(clock.now() / 1000) - 2;
    expect(send({ 'x-broker-timestamp': String(start) }).reason).toBe('before-start');
    expect(send({ 'x-broker-timestamp': String(start - 1) }).reason).toBe('before-start');
  });

  it('does not spend a nonce on a request whose signature fails', () => {
    // The nonce is claimed only after the signature verifies, so an unsigned
    // request cannot burn the legitimate signer's nonce.
    const { keys, clock, verify } = setup();
    const nonce = 'z'.repeat(24);
    const forged = signHeaders(keys.privateKey, 'GET', PATH, '', { now: clock.now(), nonce });
    forged['x-broker-signature'] = Buffer.alloc(64).toString('base64');
    expect(verify('GET', PATH, forged, Buffer.alloc(0)).reason).toBe('signature');
    const genuine = signHeaders(keys.privateKey, 'GET', PATH, '', { now: clock.now(), nonce });
    expect(verify('GET', PATH, genuine, Buffer.alloc(0))).toEqual({ ok: true });
  });

  it('is refused once the nonce store is full, rather than evicting a live nonce', () => {
    const { send } = setup({ nonces: createNonceStore(60_000, 1) });
    expect(send().ok).toBe(true);
    expect(send().reason).toBe('replay');
  });
});

describe('the nonce store', () => {
  it('forgets a nonce when its lifetime ends', () => {
    const store = createNonceStore(1000);
    expect(store.claim('a', 0)).toBe(true);
    expect(store.claim('a', 999)).toBe(false);
    expect(store.claim('a', 1000)).toBe(true);
  });
});

describe('loading the verify key', () => {
  function write(content, mode = 0o600) {
    directory = newTempDir();
    const file = path.join(directory, 'k.pub');
    fs.writeFileSync(file, content, { mode });
    return file;
  }
  const good = Buffer.alloc(32, 9).toString('base64');

  it('reads the canonical base64 of 32 bytes, with or without a final newline', () => {
    expect(loadVerifyKey(write(good))).toBeDefined();
    expect(loadVerifyKey(write(`${good}\n`))).toBeDefined();
  });

  it.each([
    ['not base64', '!!!!'],
    ['the wrong length', Buffer.alloc(31, 9).toString('base64')],
    ['padded with spaces', ` ${good}`],
    ['empty', ''],
  ])('refuses a file that is %s', (_name, content) => {
    expect(() => loadVerifyKey(write(content))).toThrow(/canonical base64/);
  });

  it('refuses a large file and a link', () => {
    expect(() => loadVerifyKey(write('a'.repeat(500)))).toThrow(/small regular file/);
    const file = write(good);
    const link = path.join(directory, 'link.pub');
    fs.symlinkSync(file, link);
    expect(() => loadVerifyKey(link)).toThrow();
  });

  it('refuses a public key of the wrong length', () => {
    expect(() => publicKeyFromRaw(Buffer.alloc(31))).toThrow('32 raw bytes');
  });
});
