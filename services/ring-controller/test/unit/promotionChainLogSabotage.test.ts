/**
 * Sabotage pairs for the promotion chain log. Each breaks one real line of
 * `src/promotionChainLog.ts` in a throwaway copy, asserts the property FAILS
 * on that copy, then asserts it HOLDS on the real module.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { makeTempDir } from '../../src/atomicFile.js';
import * as real from '../../src/promotionChainLog.js';
import {
  DIGEST_A,
  FIXED_NOW,
  GENESIS,
  forgeLine,
  makeKeys,
  removeAll,
  sha256Hex,
} from './helpers/chainFixtures.js';
import type { TestKeys } from './helpers/chainFixtures.js';
import { cleanupSabotageTmp, importSabotaged, type Mutation } from './helpers/sourceSabotage.js';

type Module = Pick<typeof real, 'createPromotionChainLog' | 'verifyChain'>;

const dirs: string[] = [];
afterEach(async () => {
  await removeAll(dirs);
});
afterAll(() => {
  cleanupSabotageTmp();
});

const sabotaged = (...mutations: Mutation[]) =>
  importSabotaged<Module>('promotionChainLog.ts', mutations);

async function expectPair(
  mutations: Mutation[],
  scenario: (mod: Module) => Promise<boolean>
): Promise<void> {
  expect(await scenario(await sabotaged(...mutations))).toBe(false);
  expect(await scenario(real)).toBe(true);
}

function mutation(find: string, replace: string): Mutation {
  return { file: 'promotionChainLog.ts', find, replace };
}

async function newLog(mod: Module, keys: TestKeys, signWith: TestKeys = keys) {
  const dir = await makeTempDir('ring-controller-chain-sabotage-');
  dirs.push(dir);
  const path = join(dir, 'promotions.log');
  const log = mod.createPromotionChainLog({
    path,
    privateKey: signWith.privateKey,
    publicKey: keys.publicKey,
    now: () => FIXED_NOW,
  });
  return { path, log };
}

const rec = (slot: string) => ({ promotion: 'promo-1', slot, digest: DIGEST_A });

/** Writes three honest entries through `mod`, returns the file's lines. */
async function threeEntries(mod: Module, keys: TestKeys) {
  const made = await newLog(mod, keys);
  for (const slot of ['slot-0', 'slot-1', 'slot-2']) await made.log.append(rec(slot));
  const lines = (await readFile(made.path, 'utf8')).split('\n').slice(0, -1);
  return { ...made, lines };
}

const skipSignatureCheck = mutation(
  'if (!verify(null, signedMessage(entry), publicKey, signature)) {',
  'if (false as boolean) {'
);
const skipChainCheck = mutation(
  "if (entry.prev !== prev) return { ok: false, code: 'chain-break', index };",
  ''
);
const skipSequenceCheck = mutation(
  "if (entry.seq !== index) return { ok: false, code: 'sequence-break', index };",
  ''
);
const skipCanonicalCheck = mutation(
  "if (serialise(entry) !== line) return { ok: false, code: 'non-canonical-entry', index };",
  ''
);
const skipTornLineCheck = mutation(
  "if (last !== '') return { ok: false, code: 'torn-final-line', index: lines.length };",
  ''
);
const skipDuplicateCheckInVerify = mutation(
  "if (seen.has(pair)) return { ok: false, code: 'duplicate-slot-promotion', index };",
  ''
);
const skipHeadCheck = mutation(
  'expected !== undefined &&\n    (head === null',
  'false as boolean &&\n    (head === null'
);
const skipDuplicateRefusal = mutation(
  'scan.entries.some((e) => e.promotion === record.promotion && e.slot === record.slot)',
  'false'
);
const skipSignerCheck = mutation(
  'if (!verify(null, message, publicKey, signature)) {',
  'if (false as boolean) {'
);
const appendWithoutVerifying = mutation(
  `const scan = scanChain(text, publicKey);
    if (!scan.ok) throw new ChainRefusedError(scan.code, scan.index);`,
  `const scan = {
      ok: true as const,
      entries: [] as real.ChainEntry[],
      lines: text === '' ? [] : text.split('\\n').slice(0, -1),
      head: null,
    };`
);

describe('sabotage: verification', () => {
  it('without the signature check an altered entry verifies; the real one rejects it', async () => {
    await expectPair([skipSignatureCheck], async (mod) => {
      const keys = makeKeys();
      const { lines } = await threeEntries(real, keys);
      lines[2] = (lines[2] ?? '').replace('slot-2', 'slot-9');
      return !mod.verifyChain(lines.join('\n') + '\n', keys.publicKey).ok;
    });
  });

  it('without the chain check a spliced-in entry verifies; the real one rejects it', async () => {
    await expectPair([skipChainCheck], async (mod) => {
      const keys = makeKeys();
      const first = forgeLine(keys, { seq: 0, prev: GENESIS });
      const stray = forgeLine(keys, { seq: 1, prev: GENESIS, slot: 'slot-1' });
      return !mod.verifyChain(`${first}\n${stray}\n`, keys.publicKey).ok;
    });
  });

  it('without the sequence check a gapped log verifies; the real one rejects it', async () => {
    await expectPair([skipSequenceCheck], async (mod) => {
      const keys = makeKeys();
      const first = forgeLine(keys, { seq: 0, prev: GENESIS });
      const gapped = forgeLine(keys, { seq: 5, prev: sha256Hex(first), slot: 'slot-1' });
      return !mod.verifyChain(`${first}\n${gapped}\n`, keys.publicKey).ok;
    });
  });

  it('without the canonical-form check a respaced entry verifies; the real one rejects it', async () => {
    await expectPair([skipCanonicalCheck], async (mod) => {
      const keys = makeKeys();
      const spaced = forgeLine(keys, { seq: 0, prev: GENESIS }).replace(/^\{/, '{ ');
      return !mod.verifyChain(`${spaced}\n`, keys.publicKey).ok;
    });
  });

  it('without the torn-line check a half-written last line is ignored; the real one rejects it', async () => {
    await expectPair([skipTornLineCheck], async (mod) => {
      const keys = makeKeys();
      const first = forgeLine(keys, { seq: 0, prev: GENESIS });
      return !mod.verifyChain(`${first}\n{"version":1,"seq`, keys.publicKey).ok;
    });
  });

  it('without the duplicate check one slot can be promoted twice; the real one rejects it', async () => {
    await expectPair([skipDuplicateCheckInVerify], async (mod) => {
      const keys = makeKeys();
      const first = forgeLine(keys, { seq: 0, prev: GENESIS });
      const again = forgeLine(keys, { seq: 1, prev: sha256Hex(first) });
      return !mod.verifyChain(`${first}\n${again}\n`, keys.publicKey).ok;
    });
  });

  it('without the head check a removed last entry passes the anchor; the real one fails it', async () => {
    await expectPair([skipHeadCheck], async (mod) => {
      const keys = makeKeys();
      const { lines } = await threeEntries(real, keys);
      const full = mod.verifyChain(lines.join('\n') + '\n', keys.publicKey);
      if (!full.ok || full.head === null) throw new Error('fixture chain must verify');
      const cut = lines.slice(0, 2).join('\n') + '\n';
      return !mod.verifyChain(cut, keys.publicKey, { head: full.head }).ok;
    });
  });
});

describe('sabotage: refusal to append', () => {
  it('without the verify-first guard a tampered log is appended to; the real one refuses', async () => {
    await expectPair([appendWithoutVerifying], async (mod) => {
      const keys = makeKeys();
      const { path, log, lines } = await threeEntries(mod, keys);
      lines[0] = (lines[0] ?? '').replace('slot-0', 'slot-7');
      await writeFile(path, lines.join('\n') + '\n');
      const before = await readFile(path, 'utf8');
      await log.append(rec('slot-3')).catch(() => undefined);
      return (await readFile(path, 'utf8')) === before;
    });
  });

  it('without the duplicate refusal one slot is appended twice; the real one refuses', async () => {
    await expectPair([skipDuplicateRefusal], async (mod) => {
      const keys = makeKeys();
      const { path, log } = await newLog(mod, keys);
      await log.append(rec('slot-0'));
      await log.append(rec('slot-0')).catch(() => undefined);
      return (await readFile(path, 'utf8')).split('\n').length === 2;
    });
  });

  it('without the signer check a mismatched key is written; the real one refuses', async () => {
    await expectPair([skipSignerCheck], async (mod) => {
      const { path, log } = await newLog(mod, makeKeys(), makeKeys());
      await log.append(rec('slot-0')).catch(() => undefined);
      return await readFile(path, 'utf8').then(
        () => false,
        () => true
      );
    });
  });
});
