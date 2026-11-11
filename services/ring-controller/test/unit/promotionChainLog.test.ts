import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import {
  ChainRefusedError,
  GENESIS_HASH,
  createPromotionChainLog,
  verifyChain,
} from '../../src/promotionChainLog.js';
import type { PromotionChainLog, PromotionRecord } from '../../src/promotionChainLog.js';
import {
  DIGEST_A,
  DIGEST_B,
  FIXED_NOW,
  forgeLine,
  makeKeys,
  removeAll,
  sha256Hex,
} from './helpers/chainFixtures.js';
import type { TestKeys } from './helpers/chainFixtures.js';

const dirs: string[] = [];
afterEach(async () => {
  await removeAll(dirs);
});

async function setup(keys: TestKeys = makeKeys()) {
  const dir = await makeTempDir('ring-controller-chain-');
  dirs.push(dir);
  const path = join(dir, 'promotions.log');
  const log = createPromotionChainLog({ path, ...keys, now: () => FIXED_NOW });
  return { dir, path, keys, log };
}

const record = (slot: string, promotion = 'promo-1', digest = DIGEST_A): PromotionRecord => ({
  promotion,
  slot,
  digest,
});

async function fill(log: PromotionChainLog): Promise<void> {
  await log.append(record('slot-0'));
  await log.append(record('slot-1'));
  await log.append(record('slot-2'));
}

async function lines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n').slice(0, -1);
}

async function refusal(promise: Promise<unknown>): Promise<ChainRefusedError> {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown
  );
  expect(error).toBeInstanceOf(ChainRefusedError);
  return error as ChainRefusedError;
}

describe('append', () => {
  it('writes a signed first entry that points at the genesis hash', async () => {
    const { log, path } = await setup();

    const entry = await log.append(record('slot-0'));

    expect(entry).toMatchObject({ version: 1, seq: 0, prev: GENESIS_HASH, slot: 'slot-0' });
    expect(entry.at).toBe('2026-11-12T03:00:00.000Z');
    expect(await lines(path)).toHaveLength(1);
    expect(await log.verify()).toMatchObject({ ok: true, length: 1 });
  });

  it('chains each entry to the hash of the exact line before it', async () => {
    const { log, path } = await setup();

    await fill(log);

    const written = await lines(path);
    const parsed = written.map((line) => JSON.parse(line) as { seq: number; prev: string });
    expect(parsed.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(parsed[0]?.prev).toBe(GENESIS_HASH);
    expect(parsed[1]?.prev).toBe(sha256Hex(written[0] ?? ''));
    expect(parsed[2]?.prev).toBe(sha256Hex(written[1] ?? ''));
    expect(await log.verify()).toEqual({
      ok: true,
      length: 3,
      head: { seq: 2, hash: sha256Hex(written[2] ?? '') },
    });
  });

  it('keeps one entry per slot per promotion: another promotion may reuse a slot', async () => {
    const { log } = await setup();

    await log.append(record('slot-0', 'promo-1'));
    await log.append(record('slot-0', 'promo-2', DIGEST_B));

    expect(await log.verify()).toMatchObject({ ok: true, length: 2 });
  });

  it('only ever adds bytes: the earlier lines are unchanged by a later append', async () => {
    const { log, path } = await setup();
    await log.append(record('slot-0'));
    const before = await readFile(path, 'utf8');

    await log.append(record('slot-1'));

    expect((await readFile(path, 'utf8')).startsWith(before)).toBe(true);
  });

  it('creates the log readable by its owner only', async () => {
    const { log, path } = await setup();

    await log.append(record('slot-0'));

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('serialises concurrent appends into one unbroken chain', async () => {
    const { log } = await setup();

    await Promise.all([
      log.append(record('slot-0')),
      log.append(record('slot-1')),
      log.append(record('slot-2')),
    ]);

    expect(await log.verify()).toMatchObject({ ok: true, length: 3 });
  });

  it('a verifier that holds only the public half accepts what the controller wrote', async () => {
    const { log, path, keys } = await setup();
    await fill(log);

    expect(verifyChain(await readFile(path, 'utf8'), keys.publicKey)).toMatchObject({
      ok: true,
      length: 3,
    });
  });
});

describe('tamper detection', () => {
  it('an altered field fails verification at that entry', async () => {
    const { log, path } = await setup();
    await fill(log);
    const written = await lines(path);
    written[1] = (written[1] ?? '').replace('slot-1', 'slot-9');
    await writeFile(path, written.join('\n') + '\n');

    expect(await log.verify()).toEqual({ ok: false, code: 'bad-signature', index: 1 });
  });

  it('an altered digest in the last entry fails verification', async () => {
    const { log, path } = await setup();
    await fill(log);
    const written = await lines(path);
    written[2] = (written[2] ?? '').replace(DIGEST_A, DIGEST_B);
    await writeFile(path, written.join('\n') + '\n');

    expect(await log.verify()).toEqual({ ok: false, code: 'bad-signature', index: 2 });
  });

  it('a removed middle entry fails verification', async () => {
    const { log, path } = await setup();
    await fill(log);
    const written = await lines(path);
    await writeFile(path, [written[0], written[2]].join('\n') + '\n');

    const verdict = await log.verify();

    expect(verdict.ok).toBe(false);
    expect(verdict).toMatchObject({ index: 1 });
  });

  it('a removed first entry fails verification', async () => {
    const { log, path } = await setup();
    await fill(log);
    const written = await lines(path);
    await writeFile(path, written.slice(1).join('\n') + '\n');

    expect(await log.verify()).toMatchObject({ ok: false, index: 0 });
  });

  it('swapping two entries fails verification', async () => {
    const { log, path } = await setup();
    await fill(log);
    const written = await lines(path);
    await writeFile(path, [written[0], written[2], written[1]].join('\n') + '\n');

    expect((await log.verify()).ok).toBe(false);
  });

  it('an entry from another log signed with the same key breaks the chain', async () => {
    const keys = makeKeys();
    const one = await setup(keys);
    const two = await setup(keys);
    await fill(one.log);
    await two.log.append(record('slot-0', 'other-promotion'));
    await two.log.append(record('slot-1', 'other-promotion'));
    const spliced = [...(await lines(one.path))];
    spliced[1] = (await lines(two.path))[1] ?? '';
    await writeFile(one.path, spliced.join('\n') + '\n');

    expect(await one.log.verify()).toEqual({ ok: false, code: 'chain-break', index: 1 });
  });

  it('an entry signed by a different key fails verification', async () => {
    const { log, path } = await setup();
    await log.append(record('slot-0'));
    const stranger = makeKeys();
    await writeFile(
      path,
      forgeLine(stranger, { seq: 0, prev: GENESIS_HASH, slot: 'slot-0' }) + '\n'
    );

    expect(await log.verify()).toEqual({ ok: false, code: 'bad-signature', index: 0 });
  });

  it('a right-signed entry with a gap in the sequence fails verification', async () => {
    const { log, path, keys } = await setup();
    const first = forgeLine(keys, { seq: 0, prev: GENESIS_HASH });
    const gapped = forgeLine(keys, { seq: 2, prev: sha256Hex(first), slot: 'slot-1' });
    await writeFile(path, `${first}\n${gapped}\n`);

    expect(await log.verify()).toEqual({ ok: false, code: 'sequence-break', index: 1 });
  });

  it('a right-signed entry that is not in the one canonical form fails verification', async () => {
    const { log, path, keys } = await setup();
    const spaced = forgeLine(keys, { seq: 0, prev: GENESIS_HASH }).replace('{', '{ ');
    await writeFile(path, `${spaced}\n`);

    expect(await log.verify()).toEqual({ ok: false, code: 'non-canonical-entry', index: 0 });
  });

  it('a right-signed entry with an unknown extra field fails verification', async () => {
    const { log, path, keys } = await setup();
    const line = forgeLine(keys, { seq: 0, prev: GENESIS_HASH }).replace('}', ',"extra":1}');
    await writeFile(path, `${line}\n`);

    expect(await log.verify()).toEqual({ ok: false, code: 'malformed-entry', index: 0 });
  });

  it('a second entry for the same slot and promotion fails verification', async () => {
    const { log, path, keys } = await setup();
    const first = forgeLine(keys, { seq: 0, prev: GENESIS_HASH });
    const again = forgeLine(keys, { seq: 1, prev: sha256Hex(first) });
    await writeFile(path, `${first}\n${again}\n`);

    expect(await log.verify()).toEqual({
      ok: false,
      code: 'duplicate-slot-promotion',
      index: 1,
    });
  });

  it('a half-written last line fails verification', async () => {
    const { log, path } = await setup();
    await fill(log);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.slice(0, -10));

    expect(await log.verify()).toMatchObject({ ok: false, code: 'torn-final-line' });
  });

  it('a removed last entry is invisible to the chain alone and caught by a recorded head', async () => {
    const { log, path } = await setup();
    await fill(log);
    const before = await log.verify();
    if (!before.ok || before.head === null) throw new Error('fixture chain must verify');
    const written = await lines(path);
    await writeFile(path, written.slice(0, 2).join('\n') + '\n');

    expect(await log.verify()).toMatchObject({ ok: true, length: 2 });
    expect(await log.verify({ head: before.head })).toMatchObject({
      ok: false,
      code: 'head-mismatch',
    });
  });

  it('a recorded head matches the untouched chain', async () => {
    const { log } = await setup();
    await fill(log);
    const verdict = await log.verify();
    if (!verdict.ok || verdict.head === null) throw new Error('fixture chain must verify');

    expect(await log.verify({ head: verdict.head })).toMatchObject({ ok: true, length: 3 });
  });
});

describe('refusal to append', () => {
  it('refuses on an altered entry and leaves the file exactly as it was', async () => {
    const { log, path } = await setup();
    await fill(log);
    const written = await lines(path);
    written[0] = (written[0] ?? '').replace('slot-0', 'slot-7');
    await writeFile(path, written.join('\n') + '\n');
    const before = await readFile(path, 'utf8');

    const error = await refusal(log.append(record('slot-3')));

    expect(error).toMatchObject({ code: 'bad-signature', index: 0 });
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('refuses on a removed entry and leaves the file exactly as it was', async () => {
    const { log, path } = await setup();
    await fill(log);
    const written = await lines(path);
    await writeFile(path, [written[0], written[2]].join('\n') + '\n');
    const before = await readFile(path, 'utf8');

    const error = await refusal(log.append(record('slot-3')));

    expect(error.code).not.toBe('bad-record');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('refuses after a half-written last line rather than gluing onto it', async () => {
    const { log, path } = await setup();
    await fill(log);
    await writeFile(path, (await readFile(path, 'utf8')).slice(0, -10));
    const before = await readFile(path, 'utf8');

    const error = await refusal(log.append(record('slot-3')));

    expect(error.code).toBe('torn-final-line');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('refuses a second entry for a slot already recorded for the promotion', async () => {
    const { log, path } = await setup();
    await log.append(record('slot-0'));
    const before = await readFile(path, 'utf8');

    const error = await refusal(log.append(record('slot-0')));

    expect(error.code).toBe('duplicate-slot-promotion');
    expect(await readFile(path, 'utf8')).toBe(before);
  });

  it('refuses when the signing key is not the one the public half belongs to', async () => {
    const keys = makeKeys();
    const other = makeKeys();
    const { dir } = await setup();
    const path = join(dir, 'mismatch.log');
    const log = createPromotionChainLog({
      path,
      privateKey: other.privateKey,
      publicKey: keys.publicKey,
      now: () => FIXED_NOW,
    });

    const error = await refusal(log.append(record('slot-0')));

    expect(error.code).toBe('signer-key-mismatch');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it.each([
    ['an empty slot', { promotion: 'promo-1', slot: '', digest: DIGEST_A }],
    ['a slot with a newline', { promotion: 'promo-1', slot: 'a\nb', digest: DIGEST_A }],
    ['a promotion with a quote', { promotion: 'p"1', slot: 'slot-0', digest: DIGEST_A }],
    ['a digest without the algorithm', { promotion: 'p', slot: 's', digest: 'a'.repeat(64) }],
    ['a short digest', { promotion: 'p', slot: 's', digest: 'sha256:abc' }],
  ])('refuses %s and writes nothing', async (_name, bad) => {
    const { log, path } = await setup();

    const error = await refusal(log.append(bad));

    expect(error.code).toBe('bad-record');
    await expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a key that is not an Ed25519 pair', async () => {
    const { dir } = await setup();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const good = makeKeys();
    const path = join(dir, 'rsa.log');

    expect(() => createPromotionChainLog({ path, ...rsa, now: () => FIXED_NOW })).toThrowError(
      expect.objectContaining({ code: 'bad-key' })
    );
    expect(() =>
      createPromotionChainLog({
        path,
        privateKey: good.publicKey,
        publicKey: good.publicKey,
        now: () => FIXED_NOW,
      })
    ).toThrowError(expect.objectContaining({ code: 'bad-key' }));
  });
});
