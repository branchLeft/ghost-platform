import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MASTER_SECRET_FILE_ENV,
  MasterSecret,
  MasterSecretError,
  loadMasterSecret,
} from '../../src/credentials/masterSecret.js';

const SECRET = Buffer.alloc(32, 0x5a);
const SECRET_B64 = SECRET.toString('base64');

describe('loadMasterSecret', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'gw-master-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function file(contents: string | Buffer, mode = 0o600): string {
    const path = join(dir, 'master');
    writeFileSync(path, contents, { mode });
    chmodSync(path, mode);
    return path;
  }
  const load = (path: string, expectedUid?: number) =>
    loadMasterSecret({
      env: { [MASTER_SECRET_FILE_ENV]: path },
      ...(expectedUid === undefined ? {} : { expectedUid }),
    });

  it('loads an owner-only file, ignoring a trailing newline', () => {
    expect(load(file(`${SECRET_B64}\n`)).keyMaterial()).toEqual(SECRET);
  });

  it('accepts a read-only owner file', () => {
    expect(load(file(SECRET_B64, 0o400)).keyMaterial()).toEqual(SECRET);
  });

  it('refuses to start when the variable is unset or empty', () => {
    expect(() => loadMasterSecret({ env: {} })).toThrow(MasterSecretError);
    expect(() => loadMasterSecret({ env: {} })).toThrow(/is not set; refusing to start/);
    expect(() => loadMasterSecret({ env: { [MASTER_SECRET_FILE_ENV]: '' } })).toThrow(/is not set/);
  });

  it('refuses a relative path', () => {
    expect(() => load('master')).toThrow(/absolute path/);
  });

  it('refuses to start when the file is missing', () => {
    expect(() => load(join(dir, 'absent'))).toThrow(/cannot be opened/);
  });

  it('refuses a symlink, even to a good file', () => {
    const target = file(SECRET_B64);
    const link = join(dir, 'link');
    symlinkSync(target, link);
    expect(() => load(link)).toThrow(/cannot be opened \(missing, or a symlink\)/);
  });

  it('refuses a path that is not a regular file', () => {
    expect(() => load(dir)).toThrow(/not a regular file/);
  });

  it('refuses a file owned by another user', () => {
    const path = file(SECRET_B64);
    expect(() => load(path, (process.getuid?.() ?? 0) + 1)).toThrow(
      /not owned by the gateway user/
    );
  });

  it.each([0o644, 0o640, 0o604, 0o660])('refuses a file with mode %o', (mode) => {
    expect(() => load(file(SECRET_B64, mode))).toThrow(/readable by group or others/);
  });

  it('refuses a secret shorter than 32 bytes', () => {
    expect(() => load(file(Buffer.alloc(31, 1).toString('base64')))).toThrow(
      /31 bytes; at least 32/
    );
  });

  it.each(['', '   \n', 'not base64!', SECRET_B64.slice(1), SECRET.toString('base64url') + '-_'])(
    'refuses contents that are not standard base64: %j',
    (contents) => {
      expect(() => load(file(contents))).toThrow(/not standard base64/);
    }
  );

  it('refuses an oversized file', () => {
    expect(() => load(file('A'.repeat(1028)))).toThrow(/larger than any secret/);
  });

  it('never names the secret in an error', () => {
    const short = Buffer.alloc(20, 0x41).toString('base64');
    expect(() => load(file(short))).toThrow(MasterSecretError);
    try {
      load(file(short));
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
