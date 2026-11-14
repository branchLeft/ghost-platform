import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkRequest, verifyRequest, type AuthDeps, type AuthRefusal } from '../../src/auth.js';
import { createInMemoryNonceStore } from '../../src/nonceStore.js';
import * as scheme from '../../src/signedRequestScheme.js';
import { generateTestKeyPair, signHeaders } from '../helpers/signer.js';

const NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const BODY = Buffer.from('{}');

function setup(overrides: Partial<AuthDeps> = {}) {
  const keyPair = generateTestKeyPair();
  const deps: AuthDeps = {
    verifyKey: keyPair.publicKeyRaw,
    replayWindowSeconds: 60,
    nonces: createInMemoryNonceStore(66_000),
    processStartSeconds: NOW_S - 1_000_000,
    nowMs: () => NOW_MS,
    ...overrides,
  };
  const send = (
    seconds = NOW_S,
    nonce?: string,
    mutate: (h: { timestamp?: string; nonce?: string; signature?: string }) => void = () => {}
  ) => {
    const raw = signHeaders(keyPair, 'POST', '/reconcile', BODY, seconds, nonce);
    const headers: { timestamp?: string; nonce?: string; signature?: string } = {
      timestamp: raw['X-Broker-Timestamp'],
      nonce: raw['X-Broker-Nonce'],
      signature: raw['X-Broker-Signature'],
    };
    mutate(headers);
    return { headers, check: () => checkRequest(deps, 'POST', '/reconcile', headers, BODY) };
  };
  return { deps, send };
}

describe('checkRequest names the refusal by a fixed code', () => {
  it('admits a correctly signed, fresh request', () => {
    expect(setup().send().check()).toEqual({ ok: true });
  });

  it.each<
    [string, (h: { timestamp?: string; nonce?: string; signature?: string }) => void, AuthRefusal]
  >([
    ['a missing timestamp', (h) => delete h.timestamp, 'timestamp'],
    ['a malformed timestamp', (h) => (h.timestamp = '12.5'), 'timestamp'],
    ['a missing nonce', (h) => delete h.nonce, 'nonce'],
    ['a malformed nonce', (h) => (h.nonce = 'short'), 'nonce'],
    ['a missing signature', (h) => delete h.signature, 'signature-missing'],
    ['an empty signature', (h) => (h.signature = ''), 'signature-missing'],
    ['a short signature', (h) => (h.signature = 'AAAA'), 'signature'],
  ])('refuses %s', (_name, mutate, code) => {
    expect(setup().send(NOW_S, undefined, mutate).check()).toEqual({ ok: false, code });
  });

  it('refuses a stale, a too-early and a pre-start timestamp, each by its own code', () => {
    const { send } = setup({ replayWindowSeconds: 30, processStartSeconds: NOW_S - 10 });
    expect(send(NOW_S - 31).check()).toEqual({ ok: false, code: 'window' });
    expect(send(NOW_S + 6).check()).toEqual({ ok: false, code: 'window' });
    expect(send(NOW_S - 10).check()).toEqual({ ok: false, code: 'before-start' });
  });

  it('refuses a replay, and only after the signature has verified', () => {
    const { send } = setup();
    const first = send();
    expect(first.check()).toEqual({ ok: true });
    expect(first.check()).toEqual({ ok: false, code: 'replay' });
  });

  it('is what verifyRequest reports, one description per code', () => {
    const { deps, send } = setup();
    const codes = new Map<AuthRefusal, string>();
    const cases: Array<[AuthRefusal, ReturnType<typeof send>]> = [
      ['timestamp', send(NOW_S, undefined, (h) => delete h.timestamp)],
      ['nonce', send(NOW_S, undefined, (h) => delete h.nonce)],
      ['signature-missing', send(NOW_S, undefined, (h) => delete h.signature)],
      ['window', send(NOW_S - 120)],
      ['signature', send(NOW_S, undefined, (h) => (h.signature = 'AAAA'))],
    ];
    for (const [code, request] of cases) {
      const result = verifyRequest(deps, 'POST', '/reconcile', request.headers, BODY);
      expect(result.ok).toBe(false);
      if (!result.ok) codes.set(code, result.reason);
    }
    expect(new Set(codes.values()).size).toBe(codes.size);
  });
});

describe('the surface other processes take from the scheme', () => {
  it('is the check, its nonce store and the public-key side, and no private key', () => {
    expect(Object.keys(scheme).sort()).toEqual([
      'checkRequest',
      'createInMemoryNonceStore',
      'nonceLifetimeMs',
      'publicKeyFromRaw',
    ]);
  });
});

// The never-copy rule for the signed-request scheme. The scheme lives in
// this service's `auth.ts` and `signing.ts`. A process that is not the broker
// builds what it needs from them (`signedRequestScheme.ts`); it does not
// restate them. A restatement is recognised by the two things only the
// scheme owns: the Ed25519 key wrapper prefix and the forward-skew constant.
describe('the scheme has one home', () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
  const SCHEME_LITERALS = [/302a300506032b6570032100/, /FORWARD_SKEW_SECONDS/];
  const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'coverage', 'generated', 'test']);
  const SOURCE = /\.(?:js|cjs|mjs|ts)$/;

  function sources(directory: string): string[] {
    return readdirSync(directory).flatMap((name) => {
      const path = join(directory, name);
      if (statSync(path).isDirectory()) return SKIPPED_DIRECTORIES.has(name) ? [] : sources(path);
      return SOURCE.test(name) && !/\.test\./.test(name) ? [path] : [];
    });
  }

  it('is restated by no source under adapters/', () => {
    const offenders = sources(join(repoRoot, 'adapters'))
      .filter((path) => {
        const text = readFileSync(path, 'utf8');
        return SCHEME_LITERALS.some((literal) => literal.test(text));
      })
      .map((path) => relative(repoRoot, path).split(sep).join('/'));
    expect(offenders).toEqual([]);
  });
});
