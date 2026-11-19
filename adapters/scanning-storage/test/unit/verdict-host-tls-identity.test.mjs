import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { hasOpenssl, opensslPin, runOpenssl } from '../helpers/openssl.mjs';

const require = createRequire(import.meta.url);
const {
  ensureTlsIdentity,
  computeSubjectPublicKeyPin,
} = require('../../verdict-host/tls-identity');
const { TlsIdentityError } = require('../../verdict-host/tls-identity-error');

const fixturePem = fs.readFileSync(
  path.resolve(import.meta.dirname, '../fixtures/pin-fixture.pem'),
  'utf8'
);
// Worked out with openssl, not with the code under test:
//   openssl x509 -in pin-fixture.pem -pubkey -noout | openssl pkey -pubin -outform der | openssl dgst -sha256
const FIXTURE_PIN = 'd66a10e8b2325eb1ee9d2157c8c74fc3ab81dd67e8477b72fe105891d5e0ceb4';

let directory;
let certFile;
let keyFile;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tls-'));
  certFile = path.join(directory, 'tls.crt');
  keyFile = path.join(directory, 'tls.key');
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

const ensure = (overrides = {}) => ensureTlsIdentity({ certFile, keyFile, ...overrides });

function refusalOf(run) {
  try {
    run();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('the pin', () => {
  it('is the SHA-256 of the SubjectPublicKeyInfo, as openssl works it out', () => {
    expect(computeSubjectPublicKeyPin(fixturePem)).toBe(FIXTURE_PIN);
  });

  it('is 64 lowercase hex characters', () => {
    expect(computeSubjectPublicKeyPin(fixturePem)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is not the hash of the whole certificate', () => {
    const wholeCertificate = crypto
      .createHash('sha256')
      .update(new crypto.X509Certificate(fixturePem).raw)
      .digest('hex');
    expect(computeSubjectPublicKeyPin(fixturePem)).not.toBe(wholeCertificate);
  });

  it('refuses text that is not a certificate, with the named error', () => {
    const err = refusalOf(() => computeSubjectPublicKeyPin('not a certificate'));
    expect(err).toBeInstanceOf(TlsIdentityError);
    expect(err.reason).toBe('certificate-unreadable');
  });
});

describe('a first start', () => {
  it('makes the key at exactly 0600 even under a permissive umask, and the certificate public', () => {
    const before = process.umask(0);
    try {
      ensure();
    } finally {
      process.umask(before);
    }
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(fs.statSync(certFile).mode & 0o777).toBe(0o644);
  });

  it('makes the key exactly 0600 under a umask that would have made it 0400', () => {
    const before = process.umask(0o277);
    try {
      ensure();
    } finally {
      process.umask(before);
    }
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });

  it('makes a self-signed certificate that parses and verifies, for the key it made', () => {
    const { certificatePem, privateKeyPem, pin } = ensure();
    const certificate = new crypto.X509Certificate(certificatePem);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.subject).toBe('CN=verdict-host');
    expect(certificate.issuer).toBe('CN=verdict-host');
    expect(certificate.ca).toBe(false);
    expect(certificate.checkPrivateKey(crypto.createPrivateKey(privateKeyPem))).toBe(true);
    expect(pin).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(certFile, 'utf8')).toBe(certificatePem);
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(privateKeyPem);
  });

  it('is valid from a day before the start for ten years, with a random positive serial', () => {
    const now = Date.UTC(2030, 5, 15, 12, 0, 0);
    const first = new crypto.X509Certificate(ensure({ now: () => now }).certificatePem);
    expect(Date.parse(first.validFrom)).toBe(now - 24 * 60 * 60 * 1000);
    expect(Date.parse(first.validTo)).toBe(Date.UTC(2040, 5, 15, 12, 0, 0));
    fs.rmSync(certFile);
    fs.rmSync(keyFile);
    const second = new crypto.X509Certificate(ensure({ now: () => now }).certificatePem);
    expect(first.serialNumber).not.toBe(second.serialNumber);
    expect(first.serialNumber).toMatch(/^[0-7][0-9A-F]{31}$/);
  });

  it.skipIf(!hasOpenssl)('works out the same pin as openssl does', () => {
    const { certificatePem, pin } = ensure();
    expect(opensslPin(certificatePem)).toBe(pin);
  });

  it.skipIf(!hasOpenssl)('makes a certificate openssl reads, with the fields set', () => {
    const text = runOpenssl(['x509', '-text', '-noout'], ensure().certificatePem);
    expect(text).toContain('Signature Algorithm: ecdsa-with-SHA256');
    expect(text).toMatch(/Subject: CN ?= ?verdict-host/);
    expect(text).toContain('CA:FALSE');
    expect(text).toContain('Digital Signature');
    expect(text).toContain('Version: 3 (0x2)');
  });

  it.skipIf(!hasOpenssl)('uses a four-digit year for a date past 2049, which openssl reads', () => {
    const now = Date.UTC(2045, 0, 1);
    const { certificatePem } = ensure({ now: () => now });
    const text = runOpenssl(['x509', '-text', '-noout'], certificatePem);
    expect(text).toMatch(/Not After : .* 2055 GMT/);
  });

  it.skipIf(!hasOpenssl)('makes a certificate openssl verifies as self-signed', () => {
    const { certificatePem } = ensure();
    fs.writeFileSync(path.join(directory, 'ca.pem'), certificatePem);
    const verdict = spawnSync('openssl', [
      'verify',
      '-CAfile',
      path.join(directory, 'ca.pem'),
      path.join(directory, 'ca.pem'),
    ]);
    expect(verdict.stdout.toString()).toContain('OK');
  });
});

describe('a later start', () => {
  it('reuses both files untouched and reports the same pin', () => {
    const first = ensure();
    const stat = (file) => fs.statSync(file, { bigint: true });
    const before = [stat(certFile), stat(keyFile)];
    const second = ensure();
    expect(second.pin).toBe(first.pin);
    expect(second.privateKeyPem).toBe(first.privateKeyPem);
    const after = [stat(certFile), stat(keyFile)];
    expect(after.map((s) => [s.ino, s.mtimeNs])).toEqual(before.map((s) => [s.ino, s.mtimeNs]));
  });

  it('rebuilds a certificate lost between the two writes, from the key, with the same pin', () => {
    const first = ensure();
    fs.rmSync(certFile);
    const second = ensure();
    expect(second.pin).toBe(first.pin);
    const rebuilt = new crypto.X509Certificate(fs.readFileSync(certFile));
    expect(rebuilt.verify(rebuilt.publicKey)).toBe(true);
  });

  it('leaves the key and no certificate when putting the certificate in place fails', () => {
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
    });
    const err = refusalOf(() => ensure());
    vi.restoreAllMocks();
    expect(err).toBeInstanceOf(TlsIdentityError);
    expect(err.reason).toBe('write-failed');
    expect(fs.readdirSync(directory)).toEqual(['tls.key']);
    expect(() => ensure()).not.toThrow();
  });

  it('removes a key file it could not finish writing, so the next start is a clean one', () => {
    vi.spyOn(fs, 'writeSync').mockImplementation(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });
    const err = refusalOf(() => ensure());
    vi.restoreAllMocks();
    expect(err.reason).toBe('write-failed');
    expect(fs.readdirSync(directory)).toEqual([]);
  });
});

describe('refusals', () => {
  const expectRefusal = (run, reason) => {
    const err = refusalOf(run);
    expect(err, `expected ${reason}`).toBeInstanceOf(TlsIdentityError);
    expect(err.reason).toBe(reason);
    return err;
  };

  it('refuses a certificate whose key is missing, and does not make a key', () => {
    ensure();
    fs.rmSync(keyFile);
    const err = expectRefusal(() => ensure(), 'certificate-without-key');
    expect(err.message).toContain(certFile);
    expect(fs.existsSync(keyFile)).toBe(false);
  });

  it('refuses a certificate made for a different key', () => {
    ensure();
    const otherDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vh-tls-other-'));
    try {
      const other = ensureTlsIdentity({
        certFile: path.join(otherDirectory, 'c'),
        keyFile: path.join(otherDirectory, 'k'),
      });
      fs.writeFileSync(certFile, other.certificatePem);
    } finally {
      fs.rmSync(otherDirectory, { recursive: true, force: true });
    }
    expectRefusal(() => ensure(), 'key-mismatch');
  });

  it.each([0o640, 0o604, 0o644, 0o660, 0o666])('refuses a key file of mode %o', (mode) => {
    ensure();
    fs.chmodSync(keyFile, mode);
    const err = expectRefusal(() => ensure(), 'key-permissions');
    expect(err.message).toContain(keyFile);
  });

  it('refuses an existing key that another account owns, and does not use it', () => {
    ensure();
    const before = fs.readFileSync(keyFile, 'utf8');
    const realUid = process.getuid();
    vi.spyOn(process, 'getuid').mockReturnValue(realUid + 1);
    expectRefusal(() => ensure(), 'key-owner');
    vi.restoreAllMocks();
    expect(fs.readFileSync(keyFile, 'utf8')).toBe(before);
  });

  it.each([0o777, 0o770, 0o707, 0o722])(
    'refuses an existing key whose directory is mode %o, group or others writable',
    (mode) => {
      ensure();
      fs.chmodSync(directory, mode);
      try {
        const err = expectRefusal(() => ensure(), 'key-directory-writable');
        expect(err.message).toContain(directory);
      } finally {
        fs.chmodSync(directory, 0o700);
      }
    }
  );

  it('uses an existing key from a directory only its owner can write to', () => {
    ensure();
    fs.chmodSync(directory, 0o700);
    expect(ensure().pin).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a key file that is a symbolic link, even to a good key', () => {
    ensure();
    const real = path.join(directory, 'real.key');
    fs.renameSync(keyFile, real);
    fs.symlinkSync(real, keyFile);
    expectRefusal(() => ensure(), 'not-regular-file');
  });

  it('refuses a key file that is a dangling symbolic link', () => {
    fs.symlinkSync(path.join(directory, 'nowhere'), keyFile);
    expectRefusal(() => ensure(), 'not-regular-file');
    expect(fs.existsSync(path.join(directory, 'nowhere'))).toBe(false);
  });

  it('refuses a certificate file that is a symbolic link', () => {
    ensure();
    const real = path.join(directory, 'real.crt');
    fs.renameSync(certFile, real);
    fs.symlinkSync(real, certFile);
    expectRefusal(() => ensure(), 'not-regular-file');
  });

  it('refuses a key file that is a FIFO, without waiting for a writer', () => {
    const made = spawnSync('mkfifo', [keyFile]);
    if (made.status !== 0) return;
    expectRefusal(() => ensure(), 'not-regular-file');
  });

  it('refuses a key path that is a directory', () => {
    fs.mkdirSync(keyFile, { mode: 0o700 });
    expectRefusal(() => ensure(), 'not-regular-file');
  });

  it('refuses a directory that does not exist, for either file, and makes none', () => {
    const missing = path.join(directory, 'absent');
    expectRefusal(() => ensure({ keyFile: path.join(missing, 'tls.key') }), 'missing-directory');
    expectRefusal(() => ensure({ certFile: path.join(missing, 'tls.crt') }), 'missing-directory');
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('refuses an expired certificate, naming the certificate file and nothing secret', () => {
    const start = Date.UTC(2020, 0, 1);
    const { privateKeyPem } = ensure({ now: () => start });
    const err = expectRefusal(
      () => ensure({ now: () => Date.UTC(2031, 0, 1) }),
      'certificate-expired'
    );
    expect(err.message).toContain(certFile);
    expect(err.message).not.toContain(privateKeyPem.split('\n')[1]);
  });

  it('still reuses a certificate on its last day', () => {
    const start = Date.UTC(2020, 0, 1);
    ensure({ now: () => start });
    expect(() => ensure({ now: () => Date.UTC(2029, 11, 31) })).not.toThrow();
  });

  it('refuses a key file that is not a key, and one that is not P-256, and a bad certificate', () => {
    fs.writeFileSync(keyFile, 'garbage', { mode: 0o600 });
    expectRefusal(() => ensure(), 'key-unreadable');
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    fs.writeFileSync(keyFile, rsa.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    expectRefusal(() => ensure(), 'key-type');
    fs.rmSync(keyFile);
    ensure();
    fs.writeFileSync(certFile, 'garbage');
    expectRefusal(() => ensure(), 'certificate-unreadable');
  });

  it('never overwrites a file it refuses', () => {
    ensure();
    fs.chmodSync(keyFile, 0o644);
    const before = [fs.readFileSync(keyFile, 'utf8'), fs.readFileSync(certFile, 'utf8')];
    expectRefusal(() => ensure(), 'key-permissions');
    expect([fs.readFileSync(keyFile, 'utf8'), fs.readFileSync(certFile, 'utf8')]).toEqual(before);
  });
});
