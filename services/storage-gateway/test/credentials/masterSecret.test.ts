import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MASTER_SECRET_FILE_ENV,
  MasterSecret,
  MasterSecretError,
  loadMasterSecret,
} from '../../src/credentials/masterSecret.js';

const SECRET = Buffer.alloc(32, 0x5a);
const SECRET_B64 = SECRET.toString('base64');

function fake(contents: string | Buffer, mode = 0o100600) {
  return {
    env: { [MASTER_SECRET_FILE_ENV]: '/run/secrets/master' },
    readFile: () => (typeof contents === 'string' ? Buffer.from(contents) : contents),
    fileMode: () => mode,
  };
}

describe('loadMasterSecret', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('loads a real owner-only file, ignoring a trailing newline', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gw-master-'));
    dirs.push(dir);
    const path = join(dir, 'master');
    writeFileSync(path, `${SECRET_B64}\n`, { mode: 0o600 });
    const master = loadMasterSecret({ env: { [MASTER_SECRET_FILE_ENV]: path } });
    expect(master.keyMaterial()).toEqual(SECRET);
  });

  it('refuses to start when the variable is unset or empty', () => {
    expect(() => loadMasterSecret({ env: {} })).toThrow(MasterSecretError);
    expect(() => loadMasterSecret({ env: {} })).toThrow(/is not set; refusing to start/);
    expect(() => loadMasterSecret({ env: { [MASTER_SECRET_FILE_ENV]: '' } })).toThrow(/is not set/);
  });

  it('refuses a relative path', () => {
    expect(() => loadMasterSecret({ env: { [MASTER_SECRET_FILE_ENV]: 'master' } })).toThrow(
      /absolute path/
    );
  });

  it('refuses to start when the file is missing', () => {
    expect(() =>
      loadMasterSecret({ env: { [MASTER_SECRET_FILE_ENV]: '/nonexistent/gateway/master' } })
    ).toThrow(/cannot be read; refusing to start/);
  });

  it.each([0o100644, 0o100640, 0o100604, 0o100660])('refuses a file with mode %o', (mode) => {
    expect(() => loadMasterSecret(fake(SECRET_B64, mode))).toThrow(/readable by group or others/);
  });

  it('accepts a read-only owner file', () => {
    expect(loadMasterSecret(fake(SECRET_B64, 0o100400)).keyMaterial()).toEqual(SECRET);
  });

  it('refuses a secret shorter than 32 bytes', () => {
    expect(() => loadMasterSecret(fake(Buffer.alloc(31, 1).toString('base64')))).toThrow(
      /31 bytes; at least 32/
    );
  });

  it.each([
    '',
    '   \n',
    'not base64!',
    `${SECRET_B64.slice(1)}`,
    SECRET.toString('base64url') + '-_',
  ])('refuses contents that are not standard base64: %j', (contents) => {
    expect(() => loadMasterSecret(fake(contents))).toThrow(/not standard base64/);
  });

  it('refuses an oversized file', () => {
    expect(() => loadMasterSecret(fake('A'.repeat(1028)))).toThrow(/larger than any secret/);
  });

  it('never names the secret in an error', () => {
    const short = Buffer.alloc(20, 0x41).toString('base64');
    try {
      loadMasterSecret(fake(short));
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(short);
    }
  });
});

describe('MasterSecret', () => {
  const master = MasterSecret.fromBytes(SECRET);

  it('redacts itself in every text form a log line could use', () => {
    for (const text of [String(master), `${master}`, JSON.stringify({ master }), inspect(master)]) {
      expect(text).toContain('[MasterSecret redacted]');
      expect(text).not.toContain(SECRET_B64);
      expect(text).not.toContain(SECRET.toString('hex'));
    }
  });

  it('hands out copies, so a caller cannot change the key material', () => {
    master.keyMaterial().fill(0);
    expect(master.keyMaterial()).toEqual(SECRET);
  });

  it('copies its input, so the loader can wipe its buffer', () => {
    const input = Buffer.from(SECRET);
    const copy = MasterSecret.fromBytes(input);
    input.fill(0);
    expect(copy.keyMaterial()).toEqual(SECRET);
  });
});
