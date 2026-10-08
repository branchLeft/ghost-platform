import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  breakGlassUrl,
  keyFingerprint,
  keygen,
  KEY_FILE,
  loadSigningKey,
  main,
  mint,
  MINT_MAX_TTL_SECONDS,
  MintRefusedError,
  mintToken,
  parseMintArgs,
  publicKeyBase64,
  siteOrigin,
} from '../../scripts/break-glass-mint.mjs';
import { createRequire } from 'node:module';

const { defineBreakGlassSSO } = createRequire(import.meta.url)('../../src/break-glass.js');

class FakeSSOBase {
  async getUserByEmail() {
    return { id: 'u1' };
  }
}

let dir;
let keyFile;
let auditLog;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-mint-'));
  keyFile = path.join(dir, 'signing-key.pem');
  auditLog = path.join(dir, 'mint.jsonl');
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const request = (overrides = {}) => ({
  tenant: 'tenant-zero',
  identity: 'support@platform.example',
  reason: 'export for the departing tenant',
  ttlSeconds: 300,
  site: null,
  ...overrides,
});

describe('the key directory', () => {
  it('is exactly /etc/branchleft/break-glass/', () => {
    expect(KEY_FILE).toBe('/etc/branchleft/break-glass/signing-key.pem');
  });
});

describe('parseMintArgs', () => {
  const base = [
    'mint',
    '--tenant',
    'tenant-zero',
    '--identity',
    'support@platform.example',
    '--reason',
    'r',
  ];

  it('defaults the lifetime to 300 seconds', () => {
    expect(parseMintArgs(base)).toMatchObject({ command: 'mint', ttlSeconds: 300, site: null });
  });

  it('accepts a lifetime of exactly 600 seconds', () => {
    expect(parseMintArgs([...base, '--ttl', '600']).ttlSeconds).toBe(600);
  });

  it.each(['601', '900', '0', '-1', '1.5', 'ten'])('refuses a lifetime of %s', (ttl) => {
    expect(() => parseMintArgs([...base, '--ttl', ttl])).toThrow(
      /--ttl must be a whole number of seconds from 1 to 600/
    );
  });

  it('refuses an unknown flag', () => {
    expect(() => parseMintArgs([...base, '--key', '/tmp/k'])).toThrow(MintRefusedError);
  });

  it('refuses a missing reason', () => {
    expect(() => parseMintArgs(base.slice(0, 5))).toThrow(/--reason/);
  });

  it('refuses a tenant that is not a slug', () => {
    expect(() => parseMintArgs(['mint', '--tenant', 'Tenant Zero', ...base.slice(3)])).toThrow(
      /--tenant/
    );
  });

  it('refuses a multi-line reason', () => {
    expect(() => parseMintArgs([...base.slice(0, 6), 'a\nb'])).toThrow(/--reason/);
  });

  it('takes no arguments for keygen and public-key', () => {
    expect(parseMintArgs(['keygen'])).toEqual({ command: 'keygen' });
    expect(parseMintArgs(['public-key'])).toEqual({ command: 'public-key' });
    expect(() => parseMintArgs(['keygen', '--tenant', 'x'])).toThrow(/takes no arguments/);
  });

  it('refuses any other command', () => {
    expect(() => parseMintArgs(['revoke'])).toThrow(/mint, keygen or public-key/);
  });
});

describe('URLs (requirement 3: only ever /ghost/)', () => {
  it('builds a /ghost/ URL from a bare origin', () => {
    expect(breakGlassUrl(siteOrigin('https://example.com'), 'a.b')).toBe(
      'https://example.com/ghost/?bl_break_glass=a.b'
    );
  });

  it('accepts a trailing slash on the origin', () => {
    expect(siteOrigin('https://example.com/')).toBe('https://example.com');
  });

  it.each([
    'http://example.com',
    'https://example.com/ghost/',
    'https://example.com/blog',
    'https://example.com/?x=1',
    'https://example.com/#x',
    'https://user:pw@example.com',
    'example.com',
  ])('refuses %s as a site', (site) => {
    expect(() => siteOrigin(site)).toThrow(MintRefusedError);
  });

  it('prints the /ghost/ URL, never the site root, when --site is given', () => {
    keygen({ keyFile });
    const { output } = mint(request({ site: 'https://example.com' }), { keyFile, auditLog });
    expect(output).toMatch(
      /^https:\/\/example\.com\/ghost\/\?bl_break_glass=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/
    );
  });
});

describe('mintToken', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const nowMs = Date.UTC(2026, 9, 8, 12, 0, 0);

  it('signs the claim set the adapter verifies, and the adapter accepts it', async () => {
    const { token, claims } = mintToken({ privateKey, ...request(), nowMs });
    expect(claims).toMatchObject({
      sub: 'support@platform.example',
      aud: 'tenant-zero',
      exp: claims.iat + 300,
    });
    expect(claims.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const BreakGlassSSO = defineBreakGlassSSO(FakeSSOBase, { now: () => nowMs - 1000 });
    const adapter = new BreakGlassSSO({
      publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      tenant: 'tenant-zero',
      supportIdentity: 'support@platform.example',
    });
    const lookup = await adapter.getIdentityFromCredentials(token);
    expect(lookup).toMatchObject({ identity: 'support@platform.example', jti: claims.jti });
  });

  it('gives every token its own jti', () => {
    const a = mintToken({ privateKey, ...request(), nowMs });
    const b = mintToken({ privateKey, ...request(), nowMs });
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  it.each([0, -1, -600, 1.5])('refuses a lifetime of %s even when called directly', (ttl) => {
    expect(() => mintToken({ privateKey, ...request({ ttlSeconds: ttl }), nowMs })).toThrow(
      MintRefusedError
    );
  });

  it(`refuses a lifetime above ${MINT_MAX_TTL_SECONDS} seconds even when called directly`, () => {
    expect(() => mintToken({ privateKey, ...request({ ttlSeconds: 601 }), nowMs })).toThrow(
      MintRefusedError
    );
  });
});

describe('loadSigningKey', () => {
  it('refuses a missing key', () => {
    expect(() => loadSigningKey(keyFile)).toThrow(/no signing key/);
  });

  it.each([0o640, 0o604, 0o644, 0o606, 0o660])('refuses a key with mode %o', (mode) => {
    keygen({ keyFile });
    fs.chmodSync(keyFile, mode);
    expect(() => loadSigningKey(keyFile)).toThrow(/0600/);
  });

  it('refuses a symlink to a valid key, even one inside the key directory', () => {
    const real = path.join(dir, 'real.pem');
    keygen({ keyFile: real });
    fs.symlinkSync(real, keyFile);
    expect(() => loadSigningKey(keyFile)).toThrow(/is a symlink/);
  });

  it('refuses a key owned by another user, checked on the opened file', () => {
    keygen({ keyFile });
    const fsImpl = {
      ...fs,
      fstatSync: (fd) => {
        const real = fs.fstatSync(fd);
        return { isFile: () => true, mode: real.mode, uid: real.uid + 1 };
      },
    };
    expect(() => loadSigningKey(keyFile, fsImpl)).toThrow(/owned by this user/);
  });

  it('refuses something that is not a regular file', () => {
    fs.mkdirSync(keyFile, { mode: 0o700 });
    expect(() => loadSigningKey(keyFile)).toThrow(/regular file/);
  });

  it('refuses a key that is not Ed25519', () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    expect(() => loadSigningKey(keyFile)).toThrow(/not an Ed25519 key/);
  });

  it('refuses a file that is not a key', () => {
    fs.writeFileSync(keyFile, 'not a key', { mode: 0o600 });
    expect(() => loadSigningKey(keyFile)).toThrow(/not a readable private key/);
  });
});

describe('mint and its audit record', () => {
  it('writes the audit line before returning, and never the token', () => {
    keygen({ keyFile });
    const { output, claims } = mint(request(), { keyFile, auditLog });
    const lines = fs.readFileSync(auditLog, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]);
    expect(entry).toMatchObject({
      event: 'minted',
      tenant: 'tenant-zero',
      identity: 'support@platform.example',
      reason: 'export for the departing tenant',
      jti: claims.jti,
      exp: claims.exp,
    });
    expect(entry.key).toBe(keyFingerprint(loadSigningKey(keyFile)));
    expect(lines[0]).not.toContain(output.split('.')[1]);
    expect(fs.statSync(auditLog).mode & 0o777).toBe(0o600);
  });

  it('mints nothing when the audit record cannot be written', () => {
    keygen({ keyFile });
    expect(() =>
      mint(request(), { keyFile, auditLog: path.join(dir, 'missing', 'mint.jsonl') })
    ).toThrow(/audit record could not be written/);
  });
});

describe('keygen', () => {
  it('writes an owner-only key and prints its public half', () => {
    const { publicKey, fingerprint } = keygen({ keyFile });
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    const key = loadSigningKey(keyFile);
    expect(publicKey).toBe(publicKeyBase64(key));
    expect(fingerprint).toBe(keyFingerprint(key));
  });

  it('never overwrites an existing key', () => {
    keygen({ keyFile });
    const before = fs.readFileSync(keyFile, 'utf8');
    expect(() => keygen({ keyFile })).toThrow(/never overwrites/);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(before);
  });

  it('reports a directory it cannot write to', () => {
    expect(() => keygen({ keyFile: path.join(dir, 'missing', 'k.pem') })).toThrow(
      /could not be written/
    );
  });
});

describe('main', () => {
  const capture = () => {
    const chunks = [];
    return { write: (s) => chunks.push(s), text: () => chunks.join('') };
  };

  it('keygen and public-key print the same public half', () => {
    const a = capture();
    main(['keygen'], { stdout: a, keyFile });
    const b = capture();
    main(['public-key'], { stdout: b, keyFile });
    expect(a.text()).toBe(b.text());
    expect(a.text()).toMatch(/^public key [A-Za-z0-9+/]+=*\nfingerprint [0-9a-f]{16}\n$/);
  });

  it('mint prints one token line of two dot-joined parts, the second 86 characters', () => {
    keygen({ keyFile });
    const out = capture();
    main(
      [
        'mint',
        '--tenant',
        'tenant-zero',
        '--identity',
        'support@platform.example',
        '--reason',
        'r',
        '--ttl',
        '600',
      ],
      { stdout: out, keyFile, auditLog }
    );
    expect(out.text()).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}\n$/);
  });
});
