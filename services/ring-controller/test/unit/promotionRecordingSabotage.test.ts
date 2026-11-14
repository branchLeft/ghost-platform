/**
 * Sabotage pairs for the key loader, the recorder and the call from
 * `runRelease`. Each breaks real lines of `src/` in a throwaway copy, asserts
 * the property FAILS on that copy, then asserts it HOLDS on the real module.
 * A property that held on both would prove nothing about the lines.
 */
import { chmod, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import { createPromotionChainLog } from '../../src/promotionChainLog.js';
import * as realRecorder from '../../src/promotionRecorder.js';
import * as realController from '../../src/ringController.js';
import * as realKeys from '../../src/signingKeyFile.js';
import { DIGEST_A, FIXED_NOW, makeKeys, removeAll } from './helpers/chainFixtures.js';
import { CLEAN_ENV, RELEASE, bakeConfig, makeFleet } from './helpers/fakeFleet.js';
import { makeKeyFiles } from './helpers/keyFiles.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type KeysModule = Pick<typeof realKeys, 'loadSigningKeyFile' | 'loadPublicKeyFile'>;
type RecorderModule = Pick<typeof realRecorder, 'createPromotionRecorder'>;
type ControllerModule = Pick<typeof realController, 'runRelease'>;

const dirs: string[] = [];
afterEach(async () => {
  await removeAll(dirs);
});
afterAll(() => {
  cleanupSabotageTmp();
});

async function tempDir(): Promise<string> {
  const dir = await makeTempDir('ring-controller-recording-sabotage-');
  dirs.push(dir);
  return dir;
}

async function expectPair<T>(
  entry: string,
  real: T,
  mutations: Mutation[],
  scenario: (mod: T) => Promise<boolean>
): Promise<void> {
  expect(await scenario(await importSabotaged<T>(entry, mutations))).toBe(false);
  expect(await scenario(real)).toBe(true);
}

const mutation = (file: string, find: string, replace: string): Mutation => ({
  file,
  find,
  replace,
});

const refuses = (promise: Promise<unknown>): Promise<boolean> =>
  promise.then(
    () => false,
    () => true
  );

describe('the key loader: each refusal is the line that makes it', () => {
  const keyFile = (find: string, replace: string) => mutation('signingKeyFile.ts', find, replace);

  it('refuses a group- or world-readable key file', async () => {
    await expectPair<KeysModule>(
      'signingKeyFile.ts',
      realKeys,
      [
        keyFile(
          "if ((stat.mode & 0o077) !== 0) throw new KeyFileError('loose-permissions', path);",
          ''
        ),
      ],
      async (mod) => {
        const made = await makeKeyFiles(await tempDir(), 0o400);
        await chmod(made.privatePath, 0o644);
        return refuses(mod.loadSigningKeyFile(made.privatePath));
      }
    );
  });

  it('refuses a key file the expected owner does not own', async () => {
    await expectPair<KeysModule>(
      'signingKeyFile.ts',
      realKeys,
      [keyFile("if (stat.uid !== ownerUid) throw new KeyFileError('wrong-owner', path);", '')],
      async (mod) => {
        const made = await makeKeyFiles(await tempDir());
        const uid = process.geteuid?.() as number;
        return refuses(mod.loadSigningKeyFile(made.privatePath, { ownerUid: uid + 1 }));
      }
    );
  });

  it('refuses a symlink to a well-formed key', async () => {
    await expectPair<KeysModule>(
      'signingKeyFile.ts',
      realKeys,
      [
        keyFile(
          'constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK',
          'constants.O_RDONLY | constants.O_NONBLOCK'
        ),
      ],
      async (mod) => {
        const made = await makeKeyFiles(await tempDir());
        const link = join(made.dir, 'link.pem');
        await symlink(made.privatePath, link);
        return refuses(mod.loadSigningKeyFile(link));
      }
    );
  });

  it('never puts the file content in the error it throws', async () => {
    const sentinel = 'SENTINEL-FAKE-KEY-c01d5eed';
    await expectPair<KeysModule>(
      'signingKeyFile.ts',
      realKeys,
      [
        keyFile(
          "throw new KeyFileError('not-a-private-key', path);",
          'throw new Error(`bad key ${content.toString()}`);'
        ),
      ],
      async (mod) => {
        const path = join(await tempDir(), 'sentinel.pem');
        await writeFile(path, sentinel, { mode: 0o400 });
        const error = await mod.loadSigningKeyFile(path).then(
          () => undefined,
          (thrown: unknown) => thrown as Error
        );
        return error !== undefined && !`${error.message}\n${error.stack}`.includes(sentinel);
      }
    );
  });

  it('refuses a private key where the public half is expected', async () => {
    await expectPair<KeysModule>(
      'signingKeyFile.ts',
      realKeys,
      [
        keyFile(
          "content.length > MAX_KEY_BYTES || content.includes('PRIVATE KEY')",
          'content.length > MAX_KEY_BYTES'
        ),
      ],
      async (mod) => {
        const made = await makeKeyFiles(await tempDir());
        return refuses(mod.loadPublicKeyFile(made.privatePath));
      }
    );
  });
});

describe('the recorder: each agreement check between the log and the head', () => {
  const recorderLine = (find: string, replace: string) =>
    mutation('promotionRecorder.ts', find, replace);
  const rec = (slot: string) => ({ promotion: 'promo-1', slot, digest: DIGEST_A });

  async function seeded(mod: RecorderModule, count = 3) {
    const dir = await tempDir();
    const keys = makeKeys();
    const logPath = join(dir, 'promotions.log');
    const headPath = join(dir, 'promotion-head.json');
    const open = () =>
      mod.createPromotionRecorder({ logPath, headPath, ...keys, now: () => FIXED_NOW });
    for (let i = 0; i < count; i++) await open().record(rec(`slot-${i}`));
    return { dir, keys, logPath, headPath, open };
  }

  const behindCheck = recorderLine(
    "if (whole.length < recordedLength) throw new PromotionRecorderError('log-behind-head');",
    ''
  );
  const prefixCheck = recorderLine(
    "if (!verifyChain(prefix, publicKey, { head: recorded }).ok) {\n        throw new PromotionRecorderError('log-behind-head');\n      }",
    ''
  );
  const aheadCheck = recorderLine('if (whole.length - recordedLength > 1) {', 'if (false) {');

  it('refuses a log with its last entry cut off (both the length check and the prefix check)', async () => {
    await expectPair<RecorderModule>(
      'promotionRecorder.ts',
      realRecorder,
      [behindCheck, prefixCheck],
      async (mod) => {
        const made = await seeded(mod);
        const lines = (await readFile(made.logPath, 'utf8')).split('\n').slice(0, 2);
        await writeFile(made.logPath, lines.join('\n') + '\n');
        return refuses(made.open().record(rec('slot-3')));
      }
    );
  });

  it('refuses a log emptied entirely (the length check alone)', async () => {
    await expectPair<RecorderModule>(
      'promotionRecorder.ts',
      realRecorder,
      [behindCheck, prefixCheck],
      async (mod) => {
        const made = await seeded(mod);
        await truncate(made.logPath, 0);
        return refuses(made.open().record(rec('slot-3')));
      }
    );
  });

  it('refuses a rewritten history of the same length (the prefix check)', async () => {
    await expectPair<RecorderModule>(
      'promotionRecorder.ts',
      realRecorder,
      [prefixCheck],
      async (mod) => {
        const made = await seeded(mod);
        const other = createPromotionChainLog({
          path: join(made.dir, 'rewritten.log'),
          ...made.keys,
          now: () => new Date('2026-11-13T00:00:00.000Z'),
        });
        for (const slot of ['slot-0', 'slot-1', 'slot-2']) await other.append(rec(slot));
        await writeFile(made.logPath, await readFile(join(made.dir, 'rewritten.log')));
        return refuses(made.open().record(rec('slot-3')));
      }
    );
  });

  it('refuses a log two entries ahead of its head', async () => {
    await expectPair<RecorderModule>(
      'promotionRecorder.ts',
      realRecorder,
      [aheadCheck],
      async (mod) => {
        const made = await seeded(mod);
        const log = createPromotionChainLog({
          path: made.logPath,
          ...made.keys,
          now: () => FIXED_NOW,
        });
        await log.append(rec('slot-3'));
        await log.append(rec('slot-4'));
        return refuses(made.open().record(rec('slot-5')));
      }
    );
  });

  it('refuses a deleted head beside a log of several entries', async () => {
    await expectPair<RecorderModule>(
      'promotionRecorder.ts',
      realRecorder,
      [aheadCheck],
      async (mod) => {
        const made = await seeded(mod);
        await rm(made.headPath);
        return refuses(made.open().record(rec('slot-3')));
      }
    );
  });

  it('records the head after each append so the next process recovers it', async () => {
    await expectPair<RecorderModule>(
      'promotionRecorder.ts',
      realRecorder,
      [recorderLine('await writeHead(after.head as ChainHead);', '')],
      async (mod) => {
        const made = await seeded(mod);
        const lastSeq = (await readFile(made.logPath, 'utf8')).split('\n').length - 2;
        const head = JSON.parse(await readFile(made.headPath, 'utf8')) as { seq: number };
        return head.seq === lastSeq;
      }
    );
  });

  it('refuses a relative key or log path in the environment', async () => {
    type EnvModule = Pick<typeof realRecorder, 'createPromotionRecorderFromEnv'>;
    await expectPair<EnvModule>(
      'promotionRecorder.ts',
      realRecorder,
      [recorderLine('value === undefined || !isAbsolute(value)', 'value === undefined')],
      async (mod) => {
        const dir = await tempDir();
        const made = await makeKeyFiles(dir);
        return refuses(
          mod.createPromotionRecorderFromEnv(
            {
              [realRecorder.ENV_LOG_FILE]: 'promotions.log',
              [realRecorder.ENV_HEAD_FILE]: join(dir, 'head.json'),
              [realRecorder.ENV_SIGNING_KEY_FILE]: made.privatePath,
              [realRecorder.ENV_PUBLIC_KEY_FILE]: made.publicPath,
            },
            () => FIXED_NOW
          )
        );
      }
    );
  });
});

describe('runRelease: the record is written before the old colour stops, and its failure stops the release', () => {
  const controllerLine = (find: string, replace: string) =>
    mutation('ringController.ts', find, replace);

  async function drive(
    mod: ControllerModule,
    recordPromotion?: (record: unknown) => Promise<void>
  ) {
    const fleet = makeFleet(recordPromotion ? { recordPromotion } : {});
    const outcome = await mod.runRelease(RELEASE, fleet.deps, bakeConfig(), CLEAN_ENV);
    return { fleet, outcome };
  }

  it('holds the release when a record cannot be written', async () => {
    await expectPair<ControllerModule>(
      'ringController.ts',
      realController,
      [
        controllerLine(
          "    } catch (err) {\n      return heldAt(ring, release, 'promotion-record-failed', {",
          "    } catch (err) {\n      void heldAt(ring, release, 'promotion-record-failed', {"
        ),
      ],
      async (mod) => {
        const { fleet, outcome } = await drive(mod, async () => {
          throw new Error('disk full');
        });
        return (
          outcome.status === 'held' &&
          outcome.reason === 'promotion-record-failed' &&
          fleet.stoppedOld().length === 0
        );
      }
    );
  });

  it('records every member that took the release', async () => {
    await expectPair<ControllerModule>(
      'ringController.ts',
      realController,
      [controllerLine('await deps.recordPromotion({', 'void ({')],
      async (mod) => {
        const { fleet, outcome } = await drive(mod);
        return outcome.status === 'completed' && fleet.records.length === fleet.bumpOrder().length;
      }
    );
  });

  it('writes a member’s record before it stops that member’s old colour', async () => {
    await expectPair<ControllerModule>(
      'ringController.ts',
      realController,
      [
        controllerLine(
          'await deps.recordPromotion({',
          'await machine.closeBakeWindow();\n      await deps.recordPromotion({'
        ),
      ],
      async (mod) => {
        const { fleet } = await drive(mod);
        const recorded = fleet.events.indexOf('record:canary-mysql');
        const stopped = fleet.events.indexOf('stop-old:canary-mysql');
        return recorded >= 0 && stopped > recorded;
      }
    );
  });
});
