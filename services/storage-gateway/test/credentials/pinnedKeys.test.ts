import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPinnedCallerKeys } from '../../src/credentials/adminAuth.js';

const raw = () =>
  generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
const ME = process.getuid?.() ?? 0;

describe('loadPinnedCallerKeys', () => {
  let dir: string;
  let path: string;
  let body: string;
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  const options = { trustedUid: ME };

  function install(text: string, digest = sha(text), mode = 0o600): void {
    writeFileSync(path, text, { mode });
    writeFileSync(`${path}.sha256`, `${digest}\n`, { mode });
    chmodSync(path, mode);
    chmodSync(`${path}.sha256`, mode);
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-pin-'));
    path = join(dir, 'admin-keys.json');
    body = JSON.stringify({
      'provisioning-controller': raw().toString('base64'),
      'erasure-job': raw().toString('base64'),
    });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('loads both keys when the file matches its pinned digest', () => {
    install(body);
    const keys = loadPinnedCallerKeys(path, options);
    expect(Object.keys(keys).sort()).toEqual(['erasure-job', 'provisioning-controller']);
  });

  it('refuses a keys file edited after it was pinned', () => {
    install(body, sha('something else'));
    expect(() => loadPinnedCallerKeys(path, options)).toThrow(/does not match its pinned digest/);
  });

  it('refuses a pinned digest that is not a SHA-256 hex', () => {
    install(body, 'nothex');
    expect(() => loadPinnedCallerKeys(path, options)).toThrow(/not a SHA-256 hex/);
  });

  it('refuses a file owned by anyone but the trusted user', () => {
    install(body);
    expect(() => loadPinnedCallerKeys(path, { trustedUid: ME + 1 })).toThrow(/not owned/);
  });

  it('refuses a file its group or others can write, keys or digest', () => {
    install(body, undefined, 0o666);
    expect(() => loadPinnedCallerKeys(path, options)).toThrow(/writable/);
    install(body);
    chmodSync(`${path}.sha256`, 0o620);
    expect(() => loadPinnedCallerKeys(path, options)).toThrow(/writable/);
  });

  it('refuses a missing digest file, a directory and a symlink to a directory', () => {
    writeFileSync(path, body, { mode: 0o600 });
    expect(() => loadPinnedCallerKeys(path, options)).toThrow();
    mkdirSync(join(dir, 'd'));
    expect(() => loadPinnedCallerKeys(join(dir, 'd'), options)).toThrow();
    symlinkSync(join(dir, 'd'), join(dir, 'link'));
    expect(() => loadPinnedCallerKeys(join(dir, 'link'), options)).toThrow();
  });

  it('refuses a pinned file that is not a JSON object', () => {
    install('not json');
    expect(() => loadPinnedCallerKeys(path, options)).toThrow(/not valid JSON/);
    install('[]');
    expect(() => loadPinnedCallerKeys(path, options)).toThrow(/JSON object/);
    install('null');
    expect(() => loadPinnedCallerKeys(path, options)).toThrow(/JSON object/);
  });

  it('applies the same key checks as the environment loader', () => {
    install(JSON.stringify({ 'provisioning-controller': raw().toString('base64') }));
    expect(() => loadPinnedCallerKeys(path, options)).toThrow(/is not set/);
    const same = raw().toString('base64');
    install(JSON.stringify({ 'provisioning-controller': same, 'erasure-job': same }));
    expect(() => loadPinnedCallerKeys(path, options)).toThrow(/different keys/);
  });

  it('defaults to root as the trusted owner', () => {
    install(body);
    if (ME === 0) expect(loadPinnedCallerKeys(path)).toBeDefined();
    else expect(() => loadPinnedCallerKeys(path)).toThrow(/not owned/);
  });
});
