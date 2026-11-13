import { chmod, mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import { assertModelFreeEnvironment } from '../../src/modelFreeEnvironment.js';
import {
  ChainRefusedError,
  createPromotionChainLog,
  verifyChain,
} from '../../src/promotionChainLog.js';
import type { PromotionRecord } from '../../src/promotionChainLog.js';
import {
  ENV_HEAD_FILE,
  ENV_LOG_FILE,
  ENV_PUBLIC_KEY_FILE,
  ENV_SIGNING_KEY_FILE,
  PromotionRecorderError,
  RecorderConfigError,
  createPromotionRecorder,
  createPromotionRecorderFromEnv,
} from '../../src/promotionRecorder.js';
import { KeyFileError } from '../../src/signingKeyFile.js';
import { DIGEST_A, FIXED_NOW, makeKeys, removeAll } from './helpers/chainFixtures.js';
import type { TestKeys } from './helpers/chainFixtures.js';
import { keyBody, makeKeyFiles } from './helpers/keyFiles.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await removeAll(dirs);
});

const rec = (slot: string, promotion = 'promo-1'): PromotionRecord => ({
  promotion,
  slot,
  digest: DIGEST_A,
});

async function setup(keys: TestKeys = makeKeys()) {
  const dir = await makeTempDir('ring-controller-recorder-');
  dirs.push(dir);
  const logPath = join(dir, 'promotions.log');
  const headPath = join(dir, 'promotion-head.json');
  /** A fresh recorder over the same files: what a restarted process builds. */
  const open = () => createPromotionRecorder({ logPath, headPath, ...keys, now: () => FIXED_NOW });
  return { dir, keys, logPath, headPath, open, recorder: open() };
}

async function logLines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').slice(0, -1);
}

async function head(path: string): Promise<{ seq: number; hash: string }> {
  return JSON.parse(await readFile(path, 'utf8')) as { seq: number; hash: string };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(Error);
  return error as Error;
}

describe('recording and the recorded head', () => {
  it('writes the log and a head that names its last entry', async () => {
    const { recorder, logPath, headPath, keys } = await setup();
    await recorder.record(rec('slot-0'));
    await recorder.record(rec('slot-1'));

    const verified = verifyChain(await readFile(logPath, 'utf8'), keys.publicKey);
    expect(verified).toMatchObject({ ok: true, length: 2 });
    expect(await head(headPath)).toEqual((verified as { head: unknown }).head);
  });

  it('keeps the head file and the log owner-only', async () => {
    const { recorder, logPath, headPath } = await setup();
    await recorder.record(rec('slot-0'));

    expect((await stat(logPath)).mode & 0o077).toBe(0);
    expect((await stat(headPath)).mode & 0o077).toBe(0);
  });

  it('continues the chain across a restart: the head is recovered, the next entry links to it', async () => {
    const first = await setup();
    await first.recorder.record(rec('slot-0'));
    await first.recorder.record(rec('slot-1'));
    const before = await head(first.headPath);

    const restarted = first.open();
    expect(await restarted.check()).toEqual(before);
    await restarted.record(rec('slot-2'));

    const lines = await logLines(first.logPath);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[2] as string)).toMatchObject({ seq: 2, prev: before.hash });
    expect(
      verifyChain(await readFile(first.logPath, 'utf8'), first.keys.publicKey, {
        head: await head(first.headPath),
      })
    ).toMatchObject({ ok: true, length: 3 });
  });

  it('serialises concurrent records: no two entries share a sequence number', async () => {
    const { recorder, logPath } = await setup();
    await Promise.all([
      recorder.record(rec('a')),
      recorder.record(rec('b')),
      recorder.record(rec('c')),
    ]);

    const seqs = (await logLines(logPath)).map((l) => (JSON.parse(l) as { seq: number }).seq);
    expect(seqs).toEqual([0, 1, 2]);
  });

  it('refuses a duplicate slot and promotion and leaves the head where it was', async () => {
    const { recorder, headPath } = await setup();
    await recorder.record(rec('slot-0'));
    const before = await readFile(headPath, 'utf8');

    const error = await refusal(recorder.record(rec('slot-0')));
    expect(error).toBeInstanceOf(ChainRefusedError);
    expect((error as ChainRefusedError).code).toBe('duplicate-slot-promotion');
    expect(await readFile(headPath, 'utf8')).toBe(before);
  });

  it('check() on a fresh install is an empty chain and writes nothing', async () => {
    const { recorder, logPath, headPath } = await setup();

    expect(await recorder.check()).toBeNull();
    await expect(stat(logPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(headPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('the recorder refuses, appending nothing, when the log and the head disagree', () => {
  async function three() {
    const made = await setup();
    for (const slot of ['slot-0', 'slot-1', 'slot-2']) await made.recorder.record(rec(slot));
    return made;
  }

  it('refuses a log whose last entry was cut off (a shorter chain that is still valid)', async () => {
    const made = await three();
    const lines = await logLines(made.logPath);
    await writeFile(made.logPath, lines.slice(0, 2).join('\n') + '\n');
    const before = await readFile(made.logPath, 'utf8');

    const restarted = made.open();
    const error = await refusal(restarted.record(rec('slot-3')));
    expect(error).toBeInstanceOf(PromotionRecorderError);
    expect((error as PromotionRecorderError).code).toBe('log-behind-head');
    expect(await readFile(made.logPath, 'utf8')).toBe(before);
    expect((await refusal(restarted.check())) as PromotionRecorderError).toMatchObject({
      code: 'log-behind-head',
    });
  });

  it('refuses a log emptied entirely', async () => {
    const made = await three();
    await truncate(made.logPath, 0);

    const error = await refusal(made.open().record(rec('slot-3')));
    expect((error as PromotionRecorderError).code).toBe('log-behind-head');
  });

  it('refuses a log whose entry at the recorded sequence is a different, validly signed one', async () => {
    const made = await three();
    // The same key, the same slots, but another timestamp: a rewritten history of equal length.
    const other = createPromotionChainLog({
      path: join(made.dir, 'rewritten.log'),
      ...made.keys,
      now: () => new Date('2026-11-13T00:00:00.000Z'),
    });
    for (const slot of ['slot-0', 'slot-1', 'slot-2']) await other.append(rec(slot));
    await writeFile(made.logPath, await readFile(join(made.dir, 'rewritten.log')));

    const error = await refusal(made.open().record(rec('slot-3')));
    expect((error as PromotionRecorderError).code).toBe('log-behind-head');
  });

  it('refuses a log two or more entries ahead of the head', async () => {
    const made = await three();
    const log = createPromotionChainLog({ path: made.logPath, ...made.keys, now: () => FIXED_NOW });
    await log.append(rec('slot-3'));
    await log.append(rec('slot-4'));

    const error = await refusal(made.open().record(rec('slot-5')));
    expect((error as PromotionRecorderError).code).toBe('log-ahead-of-head');
  });

  it('heals a log exactly one entry ahead (a crash between the append and the head write)', async () => {
    const made = await three();
    const log = createPromotionChainLog({ path: made.logPath, ...made.keys, now: () => FIXED_NOW });
    await log.append(rec('slot-3'));

    await made.open().record(rec('slot-4'));
    const lines = await logLines(made.logPath);
    expect(lines).toHaveLength(5);
    expect((await head(made.headPath)).seq).toBe(4);
  });

  it('refuses a deleted head once the log holds more than one entry', async () => {
    const made = await three();
    await rm(made.headPath);

    const error = await refusal(made.open().record(rec('slot-3')));
    expect((error as PromotionRecorderError).code).toBe('head-missing');
  });

  it('accepts a missing head beside a single entry and records it (a crash before the first head write)', async () => {
    const made = await setup();
    const log = createPromotionChainLog({ path: made.logPath, ...made.keys, now: () => FIXED_NOW });
    await log.append(rec('slot-0'));

    await made.recorder.record(rec('slot-1'));
    expect((await head(made.headPath)).seq).toBe(1);
  });

  it.each([
    ['not json', 'garbage'],
    ['not an object', '[1,2]\n'],
    ['a wrong shape', '{"seq":"1","hash":"x"}\n'],
    ['a non-canonical serialisation', `{ "seq": 0, "hash": "${'a'.repeat(64)}" }\n`],
  ])('refuses a head file that is %s', async (_name, content) => {
    const made = await three();
    await writeFile(made.headPath, content);

    const error = await refusal(made.open().record(rec('slot-3')));
    expect((error as PromotionRecorderError).code).toBe('head-malformed');
  });

  it('refuses a log that does not verify, whatever the head says', async () => {
    const made = await three();
    const lines = await logLines(made.logPath);
    await writeFile(
      made.logPath,
      lines.map((l) => l.replace('slot-1', 'slot-9')).join('\n') + '\n'
    );

    const error = await refusal(made.open().record(rec('slot-3')));
    expect(error).toBeInstanceOf(ChainRefusedError);
  });

  it('refuses a signing key that is not the committed public half’s pair and appends nothing', async () => {
    const made = await setup();
    const stranger = makeKeys();
    const recorder = createPromotionRecorder({
      logPath: made.logPath,
      headPath: made.headPath,
      privateKey: stranger.privateKey,
      publicKey: made.keys.publicKey,
      now: () => FIXED_NOW,
    });

    const error = await refusal(recorder.record(rec('slot-0')));
    expect((error as ChainRefusedError).code).toBe('signer-key-mismatch');
    await expect(stat(made.logPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('the recorder fails when the head cannot be kept', () => {
  it('throws head-write-failed, and the next record heals once the head can be written', async () => {
    const made = await setup();
    const missingDir = join(made.dir, 'later');
    const recorder = createPromotionRecorder({
      logPath: made.logPath,
      headPath: join(missingDir, 'promotion-head.json'),
      ...made.keys,
      now: () => FIXED_NOW,
    });

    const error = await refusal(recorder.record(rec('slot-0')));
    expect((error as PromotionRecorderError).code).toBe('head-write-failed');
    expect(await logLines(made.logPath)).toHaveLength(1);

    // Still failing: nothing more is appended while the head cannot be kept.
    expect(((await refusal(recorder.record(rec('slot-1')))) as PromotionRecorderError).code).toBe(
      'head-write-failed'
    );
    expect(await logLines(made.logPath)).toHaveLength(1);

    await mkdir(missingDir, { mode: 0o700 });
    await recorder.record(rec('slot-1'));
    expect(await logLines(made.logPath)).toHaveLength(2);
    expect((await head(join(missingDir, 'promotion-head.json'))).seq).toBe(1);
  });

  it('throws when the log cannot be written, recording no head', async () => {
    const made = await setup();
    const recorder = createPromotionRecorder({
      logPath: join(made.dir, 'absent', 'promotions.log'),
      headPath: made.headPath,
      ...made.keys,
      now: () => FIXED_NOW,
    });

    await refusal(recorder.record(rec('slot-0')));
    await expect(stat(made.headPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('createPromotionRecorderFromEnv', () => {
  async function envFor(mode = 0o400) {
    const dir = await makeTempDir('ring-controller-env-');
    dirs.push(dir);
    const files = await makeKeyFiles(dir, mode);
    const env = {
      [ENV_LOG_FILE]: join(dir, 'promotions.log'),
      [ENV_HEAD_FILE]: join(dir, 'promotion-head.json'),
      [ENV_SIGNING_KEY_FILE]: files.privatePath,
      [ENV_PUBLIC_KEY_FILE]: files.publicPath,
    };
    return { dir, files, env };
  }

  it('builds a recorder that signs with the key file and verifies with the public file', async () => {
    const { files, env } = await envFor();
    const recorder = await createPromotionRecorderFromEnv(env, () => FIXED_NOW);
    await recorder.record(rec('slot-0'));

    expect(
      verifyChain(await readFile(env[ENV_LOG_FILE], 'utf8'), files.keys.publicKey)
    ).toMatchObject({ ok: true, length: 1 });
  });

  it.each([ENV_LOG_FILE, ENV_HEAD_FILE, ENV_SIGNING_KEY_FILE, ENV_PUBLIC_KEY_FILE])(
    'refuses to start without %s, naming the variable',
    async (name) => {
      const { env } = await envFor();
      const error = await refusal(
        createPromotionRecorderFromEnv({ ...env, [name]: undefined }, () => FIXED_NOW)
      );

      expect(error).toBeInstanceOf(RecorderConfigError);
      expect(error.message).toContain(name);
    }
  );

  it('refuses a relative path', async () => {
    const { env } = await envFor();
    const error = await refusal(
      createPromotionRecorderFromEnv({ ...env, [ENV_HEAD_FILE]: 'head.json' }, () => FIXED_NOW)
    );

    expect(error).toBeInstanceOf(RecorderConfigError);
  });

  it('refuses a loose-permission key file before it can sign anything, and never prints the key', async () => {
    const { files, env } = await envFor(0o640);
    const error = await refusal(createPromotionRecorderFromEnv(env, () => FIXED_NOW));

    expect(error).toBeInstanceOf(KeyFileError);
    expect((error as KeyFileError).code).toBe('loose-permissions');
    expect(error.message).toContain(files.privatePath);
    expect(error.message + (error.stack ?? '')).not.toContain(keyBody(files));
    await expect(stat(env[ENV_LOG_FILE])).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a key file owned by someone else', async () => {
    const { env } = await envFor();
    const uid = process.geteuid?.() as number;
    const error = await refusal(createPromotionRecorderFromEnv(env, () => FIXED_NOW, uid + 1));

    expect((error as KeyFileError).code).toBe('wrong-owner');
  });

  it('uses variable names the model-free environment check does not treat as a model key', async () => {
    const { env } = await envFor();
    expect(() => assertModelFreeEnvironment({ ...env })).not.toThrow();
  });

  it('keeps the key out of every error the recorder raises for a key that does not match', async () => {
    const { files, env } = await envFor();
    const other = await makeKeyFiles(await makeTempDir('ring-controller-env-other-'), 0o400);
    dirs.push(other.dir);
    const recorder = await createPromotionRecorderFromEnv(
      { ...env, [ENV_PUBLIC_KEY_FILE]: other.publicPath },
      () => FIXED_NOW
    );
    const error = await refusal(recorder.record(rec('slot-0')));

    expect((error as ChainRefusedError).code).toBe('signer-key-mismatch');
    const printed = error.message + (error.stack ?? '') + JSON.stringify(error);
    expect(printed).not.toContain(keyBody(files));
    expect(printed).not.toContain(keyBody(other));
  });

  it('writes nothing to the console while recording', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined)
    );
    const { env } = await envFor();
    const recorder = await createPromotionRecorderFromEnv(env, () => FIXED_NOW);
    await recorder.record(rec('slot-0'));
    await chmod(env[ENV_SIGNING_KEY_FILE], 0o644);
    await refusal(createPromotionRecorderFromEnv(env, () => FIXED_NOW));

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
