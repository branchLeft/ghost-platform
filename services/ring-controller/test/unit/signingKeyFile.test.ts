import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import { KeyFileError, loadPublicKeyFile, loadSigningKeyFile } from '../../src/signingKeyFile.js';
import { removeAll } from './helpers/chainFixtures.js';
import { keyBody, makeKeyFiles, type KeyFiles } from './helpers/keyFiles.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await removeAll(dirs);
});

async function keyDir(): Promise<string> {
  const dir = await makeTempDir('ring-controller-keyfile-');
  dirs.push(dir);
  return dir;
}

async function files(mode = 0o400): Promise<KeyFiles> {
  return makeKeyFiles(await keyDir(), mode);
}

async function refusal(promise: Promise<unknown>): Promise<KeyFileError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(KeyFileError);
  return error as KeyFileError;
}

/** Everything a caller could print of an error. */
function everythingPrintable(error: Error): string {
  return [error.message, error.stack ?? '', String(error), JSON.stringify(error)].join('\n');
}

describe('loadSigningKeyFile accepts a key only the service account can read', () => {
  it.each([
    ['0400', 0o400],
    ['0600', 0o600],
  ])('loads a file owned by the process with mode %s', async (_label, mode) => {
    const made = await files(mode);
    const key = await loadSigningKeyFile(made.privatePath);

    const signature = sign(null, Buffer.from('payload'), key);
    expect(verify(null, Buffer.from('payload'), made.keys.publicKey, signature)).toBe(true);
  });

  it('accepts the owner the caller names, so a different expected uid is a real check', async () => {
    const made = await files();
    const uid = process.geteuid?.() as number;
    await expect(loadSigningKeyFile(made.privatePath, { ownerUid: uid })).resolves.toBeDefined();
  });
});

describe('loadSigningKeyFile refuses, naming the path and never the content', () => {
  it.each([
    ['0440', 0o440],
    ['0404', 0o404],
    ['0640', 0o640],
    ['0604', 0o604],
    ['0644', 0o644],
    ['0660', 0o660],
    ['0666', 0o666],
    ['0470', 0o470],
  ])(
    'refuses a key file with mode %s (group or world can read or write it)',
    async (_label, mode) => {
      const made = await files();
      await chmod(made.privatePath, mode);
      const error = await refusal(loadSigningKeyFile(made.privatePath));

      expect(error.code).toBe('loose-permissions');
      expect(error.message).toContain(made.privatePath);
    }
  );

  it('refuses a file the expected owner does not own', async () => {
    const made = await files();
    const uid = process.geteuid?.() as number;
    const error = await refusal(loadSigningKeyFile(made.privatePath, { ownerUid: uid + 1 }));

    expect(error.code).toBe('wrong-owner');
    expect(error.message).toContain(made.privatePath);
  });

  it('refuses a symlink, even to a well-formed key', async () => {
    const made = await files();
    const link = join(made.dir, 'link.pem');
    await symlink(made.privatePath, link);
    const error = await refusal(loadSigningKeyFile(link));

    expect(error.code).toBe('symlink');
  });

  it('refuses a directory', async () => {
    const dir = await keyDir();
    const nested = join(dir, 'key.pem');
    await mkdir(nested, { mode: 0o700 });
    const error = await refusal(loadSigningKeyFile(nested));

    expect(error.code).toBe('not-a-regular-file');
  });

  it('refuses a missing file, naming it', async () => {
    const dir = await keyDir();
    const error = await refusal(loadSigningKeyFile(join(dir, 'absent.pem')));

    expect(error.code).toBe('missing');
    expect(error.message).toContain('absent.pem');
  });

  it.skipIf(process.getuid?.() === 0)(
    'refuses a file the process cannot open at all (the root-only case)',
    async () => {
      const made = await files();
      await chmod(made.privatePath, 0o000);
      const error = await refusal(loadSigningKeyFile(made.privatePath));

      expect(error.code).toBe('not-permitted');
    }
  );

  it('refuses a file that is not a private key', async () => {
    const dir = await keyDir();
    const path = join(dir, 'junk.pem');
    await writeFile(path, 'not a key at all', { mode: 0o400 });
    const error = await refusal(loadSigningKeyFile(path));

    expect(error.code).toBe('not-a-private-key');
  });

  it('refuses a public key where a private key is expected', async () => {
    const made = await files();
    await chmod(made.publicPath, 0o400);
    expect((await refusal(loadSigningKeyFile(made.publicPath))).code).toBe('not-a-private-key');
  });

  it('refuses a private key of another algorithm', async () => {
    const dir = await keyDir();
    const path = join(dir, 'ec.pem');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeFile(path, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o400 });
    const error = await refusal(loadSigningKeyFile(path));

    expect(error.code).toBe('not-an-ed25519-key');
  });

  it('refuses a file far larger than any key', async () => {
    const dir = await keyDir();
    const path = join(dir, 'big.pem');
    await writeFile(path, 'x'.repeat(10_000), { mode: 0o400 });
    const error = await refusal(loadSigningKeyFile(path));

    expect(error.code).toBe('too-large');
  });
});

describe('the key never appears in an error, a log line or a return value', () => {
  it('leaves the key body out of the refusal for a loose file, whatever is printed', async () => {
    const made = await files(0o644);
    const body = keyBody(made);
    const error = await refusal(loadSigningKeyFile(made.privatePath));

    expect(everythingPrintable(error)).not.toContain(body);
    expect(everythingPrintable(error)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('leaves a sentinel out of the refusal for a file that parses as nothing', async () => {
    const dir = await keyDir();
    const path = join(dir, 'sentinel.pem');
    const sentinel = 'SENTINEL-FAKE-KEY-4f9a1c';
    await writeFile(path, `-----BEGIN PRIVATE KEY-----\n${sentinel}\n-----END PRIVATE KEY-----\n`, {
      mode: 0o400,
    });
    const error = await refusal(loadSigningKeyFile(path));

    expect(everythingPrintable(error)).not.toContain(sentinel);
  });

  it('leaves a sentinel out of every refusal reason that opens the file', async () => {
    const sentinel = 'SENTINEL-FAKE-KEY-77d2e0';
    const dir = await keyDir();
    const path = join(dir, 'k.pem');
    await writeFile(path, sentinel, { mode: 0o400 });
    const uid = process.geteuid?.() as number;
    const refusals = [
      await refusal(loadSigningKeyFile(path, { ownerUid: uid + 1 })),
      await refusal(loadSigningKeyFile(path)),
    ];
    await chmod(path, 0o644);
    refusals.push(await refusal(loadSigningKeyFile(path)));

    expect(refusals.map((error) => error.code)).toEqual([
      'wrong-owner',
      'not-a-private-key',
      'loose-permissions',
    ]);
    for (const error of refusals) expect(everythingPrintable(error)).not.toContain(sentinel);
  });

  it('writes nothing to the console while loading or refusing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined)
    );
    const good = await files();
    const bad = await files(0o644);
    await loadSigningKeyFile(good.privatePath);
    await refusal(loadSigningKeyFile(bad.privatePath));
    await loadPublicKeyFile(good.publicPath);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('returns a key object that does not export itself to a string by accident', async () => {
    const made = await files();
    const key = await loadSigningKeyFile(made.privatePath);

    expect(JSON.stringify(key)).not.toContain(keyBody(made));
    expect(String(key)).not.toContain(keyBody(made));
  });
});

describe('loadPublicKeyFile', () => {
  it('loads the committed public half', async () => {
    const made = await files();
    const key = await loadPublicKeyFile(made.publicPath);

    expect(key.type).toBe('public');
    expect(key.asymmetricKeyType).toBe('ed25519');
  });

  it('refuses a private key file, which createPublicKey would otherwise derive from', async () => {
    const made = await files();
    const error = await refusal(loadPublicKeyFile(made.privatePath));

    expect(error.code).toBe('not-a-public-key');
    expect(everythingPrintable(error)).not.toContain(keyBody(made));
  });

  it('refuses a missing file, junk and another algorithm', async () => {
    const dir = await keyDir();
    expect((await refusal(loadPublicKeyFile(join(dir, 'absent.pub')))).code).toBe('missing');
    const junk = join(dir, 'junk.pub');
    await writeFile(junk, 'nope');
    expect((await refusal(loadPublicKeyFile(junk))).code).toBe('not-a-public-key');
    const ec = join(dir, 'ec.pub');
    const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeFile(ec, publicKey.export({ type: 'spki', format: 'pem' }));
    expect((await refusal(loadPublicKeyFile(ec))).code).toBe('not-an-ed25519-key');
  });
});
