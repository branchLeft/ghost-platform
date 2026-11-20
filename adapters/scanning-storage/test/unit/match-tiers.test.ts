// What a match does once it is made: tier one freezes, tier two seals, and
// either reaches every copy of the upload (the processed image, its `_o`
// original, a responsive derivative) while the rest of the site keeps serving.
// Driven through the real decorator with injected verdicts; policy.md names
// each rule, and each test is paired with the case that fails if the rule is
// dropped.
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeStorageBase } from '../helpers/fake-storage-base.mjs';
import {
  FakeWrappedAdapter,
  makeLoadWrappedAdapterClass,
} from '../helpers/fake-wrapped-adapter.mjs';

const require = createRequire(import.meta.url);
const { defineScanningStorageAdapter } = require('../../src/scanning-storage.js');
const { FakeVerdictClient } = require('../../src/verdict-client.js');
const { SafetyPolicy, tierOf } = require('../../src/policy.js');
const { createPdqKnownMaterialCheck } = require('../../src/checks.js');
const { ScannerMetrics } = require('../../src/metrics.js');
const { digestBytes } = require('../../src/pdq.js');
const { readRefusal, sealRefusal, liftFreeze, isRefused } = require('../../src/quarantine.js');
const GhostErrors = require('@tryghost/errors');

interface Verdict {
  classification: string;
  matchType?: string;
}

interface Summary {
  families: number;
  copies: number;
  withheld: number;
  incomplete: number;
}

interface Wrapped {
  files: Map<string, Buffer>;
  read(options: { path: string }): Promise<Buffer>;
  urlToPath(url: string): string;
  serve: () => unknown;
  deleted: { fileName: string; targetDir?: string }[];
}

interface Adapter {
  saveRaw(buffer: Buffer, targetPath: string): Promise<string>;
  exists(fileName: string, targetDir?: string): Promise<boolean>;
  read(options: { path: string }): Promise<Buffer>;
  serve(): (req: { path: string }, res: FakeResponse, next: () => void) => void;
  applyVerdict(digest: string, verdict: Verdict): Promise<Summary | null>;
  liftFreeze(digest: string): Promise<string>;
  wrapped: Wrapped;
  save(file: { name: string; path: string; type: string }, dir?: string): Promise<string>;
}

interface FakeResponse {
  statusCode: number;
  served?: boolean;
  end(): void;
}

interface Control {
  deliverVerdict(digest: string, verdict: Verdict): void;
}

const DAY = '2026/11';
// Three objects of one upload, each with different bytes and so a different
// digest: the processed image, the untouched original, a generated size.
const PROCESSED = { key: `${DAY}/photo.png`, bytes: Buffer.from('processed-bytes') };
const ORIGINAL = { key: `${DAY}/photo_o.png`, bytes: Buffer.from('original-bytes') };
const VARIANT = { key: `size/w600/${DAY}/photo.png`, bytes: Buffer.from('variant-bytes') };
const OTHER = { key: `${DAY}/unrelated.png`, bytes: Buffer.from('some-other-image') };

const EXACT_CSAM: Verdict = { classification: 'csam', matchType: 'exact' };
const NEAR_CSAM: Verdict = { classification: 'csam', matchType: 'near' };

let tmpDir: string;
let quarantinePath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'match-tiers-test-'));
  quarantinePath = path.join(tmpDir, 'quarantine');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

interface Built {
  adapter: Adapter;
  verdicts: Control;
  metrics: InstanceType<typeof ScannerMetrics>;
  logged: string[];
}

function build(
  options: {
    refuseDelete?: boolean;
    unavailable?: string[];
    storagePath?: string;
    withMetrics?: boolean;
    withoutNotFoundError?: boolean;
  } = {}
): Built {
  const logged: string[] = [];
  const metrics = new ScannerMetrics({ tenant: null });
  const Adapter = defineScanningStorageAdapter(FakeStorageBase, {
    loadWrappedAdapterClass: makeLoadWrappedAdapterClass({ FakeAdapter: FakeWrappedAdapter }),
    GhostErrors: options.withoutNotFoundError
      ? { ...GhostErrors, NotFoundError: undefined }
      : GhostErrors,
  });
  const verdicts = new FakeVerdictClient({ refuse: new Map(), unavailable: options.unavailable });
  const adapter = new Adapter({
    wraps: 'FakeAdapter',
    wrappedConfig: {
      storagePath: options.storagePath ?? 'content/images',
      refuseDelete: options.refuseDelete ?? false,
    },
    quarantinePath,
    checks: [createPdqKnownMaterialCheck(verdicts, { computeDigest: digestBytes })],
    policy: new SafetyPolicy(),
    computeDigest: digestBytes,
    metrics: options.withMetrics === false ? undefined : metrics,
    holdRetryMs: 10,
    holdMaxRetryMs: 20,
    holdLogger: { error: (...args: unknown[]) => logged.push(args.map(String).join(' ')) },
  }) as Adapter;
  return { adapter, verdicts, metrics, logged };
}

async function storeAll(adapter: Adapter, ...objects: { key: string; bytes: Buffer }[]) {
  for (const o of objects) await adapter.saveRaw(o.bytes, o.key);
}

async function present(adapter: Adapter, key: string): Promise<boolean> {
  return adapter.exists(path.posix.basename(key), path.posix.dirname(key));
}

async function quarantined(): Promise<string[]> {
  return (await fs.readdir(quarantinePath)).filter((n) => !n.endsWith('.copies.json')).sort();
}

describe('the tier a verdict falls in', () => {
  it.each([
    [{ classification: 'csam', matchType: 'exact' }, 'two'],
    [{ classification: 'test' }, 'two'],
    [{ classification: 'test', matchType: 'near' }, 'two'],
    [{ classification: 'csam', matchType: 'near' }, 'one'],
    // Every doubt rounds down to the reversible tier.
    [{ classification: 'csam' }, 'one'],
    [{ classification: 'csam', matchType: 'EXACT' }, 'one'],
    [{ classification: 'csam', matchType: ' exact' }, 'one'],
    [{ classification: 'csam', matchType: null }, 'one'],
    [{ classification: 'harmful-abusive-material', matchType: 'exact' }, 'one'],
    [{ classification: 'harmful-abusive-material', matchType: 'near' }, 'one'],
    [{ classification: 'harmful-abusive-material' }, 'one'],
    [{ classification: 'something-new', matchType: 'exact' }, 'one'],
    [{ classification: 'no-known-match' }, null],
    [{ classification: 'unavailable' }, null],
    [undefined, null],
  ])('puts %j in tier %s', (verdict, tier) => {
    expect(tierOf(verdict)).toBe(tier);
    expect(new SafetyPolicy().tier(verdict)).toBe(tier);
  });

  it('is the only thing that decides: near + csam is a freeze, never a seal', async () => {
    await sealRefusal(
      quarantinePath,
      'near-digest',
      Buffer.from('x'),
      NEAR_CSAM,
      () => 'near-digest'
    );
    const record = readRefusal(quarantinePath, 'near-digest');
    expect(record).toMatchObject({ tier: 'one', action: 'freeze' });
    expect(record).not.toHaveProperty('sealedAt');
  });
});

describe('the refusal record', () => {
  const bytes = Buffer.from('refused');
  const digest = digestBytes(bytes);
  const clock = (iso: string) => ({ now: () => iso });

  it('a tier-two match is a seal and starts the clock; a tier-one match is a freeze and does not', async () => {
    await sealRefusal(quarantinePath, digest, bytes, EXACT_CSAM, digestBytes, clock('T1'));
    expect(readRefusal(quarantinePath, digest)).toMatchObject({
      tier: 'two',
      action: 'seal',
      sealedAt: 'T1',
    });
    const other = digestBytes(Buffer.from('near'));
    await sealRefusal(
      quarantinePath,
      other,
      Buffer.from('near'),
      NEAR_CSAM,
      digestBytes,
      clock('T2')
    );
    expect(readRefusal(quarantinePath, other)).toMatchObject({
      tier: 'one',
      action: 'freeze',
      frozenAt: 'T2',
    });
  });

  it('a later exact verdict escalates a freeze to a seal, once, and starts the clock then', async () => {
    await sealRefusal(quarantinePath, digest, bytes, NEAR_CSAM, digestBytes, clock('T1'));
    await sealRefusal(quarantinePath, digest, bytes, EXACT_CSAM, digestBytes, clock('T2'));
    await sealRefusal(quarantinePath, digest, bytes, EXACT_CSAM, digestBytes, clock('T3'));
    expect(readRefusal(quarantinePath, digest)).toMatchObject({
      tier: 'two',
      sealedAt: 'T2',
      frozenAt: 'T1',
    });
  });

  it('a seal is never downgraded by a later near verdict', async () => {
    await sealRefusal(quarantinePath, digest, bytes, EXACT_CSAM, digestBytes, clock('T1'));
    await sealRefusal(quarantinePath, digest, bytes, NEAR_CSAM, digestBytes, clock('T2'));
    expect(readRefusal(quarantinePath, digest)).toMatchObject({ tier: 'two', matchType: 'exact' });
  });

  it('a record an older release wrote reads as the tier its verdict falls in', async () => {
    await fs.mkdir(quarantinePath, { recursive: true });
    const legacy = (v: Verdict) =>
      fs.writeFile(path.join(quarantinePath, `${digest}.refused.json`), JSON.stringify(v));
    await legacy(EXACT_CSAM);
    expect(readRefusal(quarantinePath, digest)?.tier).toBe('two');
    await legacy(NEAR_CSAM);
    expect(readRefusal(quarantinePath, digest)?.tier).toBe('one');
  });

  it('lifts a freeze and nothing else: a seal, an unreadable record and a missing one stay as they are', async () => {
    await sealRefusal(quarantinePath, digest, bytes, NEAR_CSAM, digestBytes);
    expect(liftFreeze(quarantinePath, digest)).toBe('lifted');
    expect(isRefused(quarantinePath, digest)).toBe(false);
    expect(liftFreeze(quarantinePath, digest)).toBe('not-refused');

    await sealRefusal(quarantinePath, digest, bytes, EXACT_CSAM, digestBytes);
    expect(liftFreeze(quarantinePath, digest)).toBe('sealed');
    expect(isRefused(quarantinePath, digest)).toBe(true);

    await fs.writeFile(path.join(quarantinePath, `${digest}.refused.json`), '{not json');
    expect(liftFreeze(quarantinePath, digest)).toBe('sealed');
  });
});

describe('a tier-two match on a tenant', () => {
  it('leaves the site serving while the object, its original and a size variant all return nothing', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED, ORIGINAL, VARIANT, OTHER);

    const summary = await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM);

    expect(summary).toEqual({ families: 1, copies: 3, withheld: 3, incomplete: 0 });
    for (const o of [PROCESSED, ORIGINAL, VARIANT]) {
      expect(await present(adapter, o.key), o.key).toBe(false);
      await expect(adapter.read({ path: o.key })).rejects.toThrow();
      expect(adapter.wrapped.files.has(o.key), o.key).toBe(false);
    }
    // The rest of the site is untouched.
    expect(await present(adapter, OTHER.key)).toBe(true);
    expect(await adapter.read({ path: OTHER.key })).toEqual(OTHER.bytes);
  });

  it('keeps every copy sealed under its own digest, where nothing else removes it', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED, ORIGINAL, VARIANT, OTHER);
    await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM);

    const digests = [PROCESSED, ORIGINAL, VARIANT].map((o) => digestBytes(o.bytes)).sort();
    const names = await quarantined();
    for (const d of digests) {
      expect(names).toContain(d);
      expect(await fs.readFile(path.join(quarantinePath, d))).toBeDefined();
      expect(readRefusal(quarantinePath, d)).toMatchObject({ tier: 'two', action: 'seal' });
    }
    // The unrelated object is not caught up in it.
    expect(isRefused(quarantinePath, digestBytes(OTHER.bytes))).toBe(false);
  });

  it('answers 404 for a frozen path through serve() and passes every other path on', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED, OTHER);
    await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM);
    const middleware = adapter.serve();

    const frozen: FakeResponse = { statusCode: 200, end() {} };
    middleware({ path: PROCESSED.key }, frozen, () => {
      throw new Error('a frozen path must not fall through');
    });
    expect(frozen.statusCode).toBe(404);
    expect(frozen.served).toBeUndefined();

    const clean: FakeResponse = { statusCode: 200, end() {} };
    middleware({ path: OTHER.key }, clean, () => {});
    expect(clean.served).toBe(true);
  });

  it('makes no further copy of a frozen upload: a derivative generated now is refused', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED, ORIGINAL);
    await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM);

    await expect(
      adapter.saveRaw(Buffer.from('a-new-size'), `size/w1000/${DAY}/photo.png`)
    ).rejects.toThrow(/Unsupported media error/);
    expect(adapter.wrapped.files.has(`size/w1000/${DAY}/photo.png`)).toBe(false);
    // Another upload is not caught by it.
    await expect(adapter.saveRaw(OTHER.bytes, OTHER.key)).resolves.toBeDefined();
  });

  it('counts the match by tier and says so in the log, without naming any bytes', async () => {
    const { adapter, metrics, logged } = build();
    await storeAll(adapter, PROCESSED);
    await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM);

    expect(metrics.render()).toMatch(/scanning_storage_matches_total\{tier="two"\} 1/);
    expect(metrics.render()).toMatch(/scanning_storage_matches_total\{tier="one"\} 0/);
    expect(logged.some((l) => /MATCH tier=two action=seal/.test(l))).toBe(true);
  });

  it('refuses a fresh upload of the same bytes as a match, a sealed refusal, and freezes its stored siblings', async () => {
    const { adapter, verdicts } = build();
    await storeAll(adapter, PROCESSED);
    // The original arrives later and is the one the supplier knows.
    verdicts.deliverVerdict(digestBytes(ORIGINAL.bytes), EXACT_CSAM);

    await expect(adapter.saveRaw(ORIGINAL.bytes, ORIGINAL.key)).rejects.toThrow(
      /Unsupported media error/
    );

    // Never stored, and the processed copy stored a moment earlier is withheld.
    expect(adapter.wrapped.files.has(ORIGINAL.key)).toBe(false);
    expect(await present(adapter, PROCESSED.key)).toBe(false);
    expect(adapter.wrapped.files.has(PROCESSED.key)).toBe(false);
    expect(readRefusal(quarantinePath, digestBytes(PROCESSED.bytes))).toMatchObject({
      tier: 'two',
    });
  });

  it('does the same when the upload was held and the verdict arrives later', async () => {
    const heldDigest = digestBytes(ORIGINAL.bytes);
    const { adapter, verdicts } = build({ unavailable: [heldDigest] });
    await storeAll(adapter, PROCESSED);

    await adapter.saveRaw(ORIGINAL.bytes, ORIGINAL.key);
    expect(await present(adapter, PROCESSED.key)).toBe(true);
    verdicts.deliverVerdict(heldDigest, EXACT_CSAM);

    await vitestWaitFor(async () => !(await present(adapter, PROCESSED.key)));
    expect(adapter.wrapped.files.has(ORIGINAL.key)).toBe(false);
    expect(readRefusal(quarantinePath, heldDigest)).toMatchObject({ tier: 'two' });
  });
});

describe('a tier-one match, on either estate', () => {
  it('freezes the same set of copies, as a freeze and not a seal', async () => {
    const { adapter, metrics } = build();
    await storeAll(adapter, PROCESSED, ORIGINAL, VARIANT, OTHER);

    const summary = await adapter.applyVerdict(digestBytes(ORIGINAL.bytes), NEAR_CSAM);

    expect(summary).toEqual({ families: 1, copies: 3, withheld: 3, incomplete: 0 });
    for (const o of [PROCESSED, ORIGINAL, VARIANT]) {
      expect(await present(adapter, o.key), o.key).toBe(false);
      expect(readRefusal(quarantinePath, digestBytes(o.bytes))).toMatchObject({
        tier: 'one',
        action: 'freeze',
      });
    }
    expect(metrics.render()).toMatch(/matches_total\{tier="one"\} 1/);
    expect(metrics.render()).toMatch(/matches_total\{tier="two"\} 0/);
    expect(await present(adapter, OTHER.key)).toBe(true);
  });

  it('is the same for any harmful-abusive-material, however it was matched', async () => {
    for (const matchType of ['exact', 'near', undefined]) {
      const { adapter } = build();
      await storeAll(adapter, PROCESSED, VARIANT);
      await adapter.applyVerdict(digestBytes(PROCESSED.bytes), {
        classification: 'harmful-abusive-material',
        matchType,
      });
      expect(readRefusal(quarantinePath, digestBytes(PROCESSED.bytes))?.tier, `${matchType}`).toBe(
        'one'
      );
      await fs.rm(quarantinePath, { recursive: true, force: true });
    }
  });

  it('can be undone from the digest alone: every copy comes back and nothing stays refused', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED, ORIGINAL, VARIANT);
    await adapter.applyVerdict(digestBytes(PROCESSED.bytes), NEAR_CSAM);

    expect(await adapter.liftFreeze(digestBytes(PROCESSED.bytes))).toBe('lifted');

    for (const o of [PROCESSED, ORIGINAL, VARIANT]) {
      expect(await present(adapter, o.key), o.key).toBe(true);
      expect(await adapter.read({ path: o.key })).toEqual(o.bytes);
      expect(isRefused(quarantinePath, digestBytes(o.bytes))).toBe(false);
    }
    await expect(
      adapter.saveRaw(Buffer.from('a-new-size'), `size/w1000/${DAY}/photo.png`)
    ).resolves.toBeDefined();
  });

  it('cannot be undone once a seal is anywhere in the family', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED, ORIGINAL);
    await adapter.applyVerdict(digestBytes(PROCESSED.bytes), NEAR_CSAM);
    await adapter.applyVerdict(digestBytes(ORIGINAL.bytes), EXACT_CSAM);

    expect(await adapter.liftFreeze(digestBytes(PROCESSED.bytes))).toBe('sealed');
    expect(await adapter.liftFreeze(digestBytes(ORIGINAL.bytes))).toBe('sealed');
    expect(await present(adapter, PROCESSED.key)).toBe(false);
  });
});

describe('a copy the backend will not let the adapter remove', () => {
  it('is still answered absent, kept under its digest, and counted aloud as incomplete', async () => {
    const { adapter, metrics, logged } = build({ refuseDelete: true });
    await storeAll(adapter, PROCESSED, ORIGINAL);

    const summary = await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM);

    expect(summary).toEqual({ families: 1, copies: 2, withheld: 0, incomplete: 2 });
    expect(await present(adapter, PROCESSED.key)).toBe(false);
    expect(await quarantined()).toContain(digestBytes(PROCESSED.bytes));
    expect(metrics.render()).toMatch(/scanning_storage_freeze_incomplete_total 2/);
    expect(logged.some((l) => /FREEZE_INCOMPLETE path=.* step=remove/.test(l))).toBe(true);
  });
});

describe('a verdict that is not a match', () => {
  it('does nothing: a clean verdict, an unavailable one, and a digest nothing stored has', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED);
    expect(
      await adapter.applyVerdict(digestBytes(PROCESSED.bytes), { classification: 'no-known-match' })
    ).toBeNull();
    expect(
      await adapter.applyVerdict(digestBytes(PROCESSED.bytes), { classification: 'unavailable' })
    ).toBeNull();
    expect(await adapter.applyVerdict('0'.repeat(64), EXACT_CSAM)).toBeNull();
    expect(await present(adapter, PROCESSED.key)).toBe(true);
  });
});

describe('the ways a freeze can be short of what it set out to do', () => {
  it('works with no metrics wired, and says nothing to a counter that is not there', async () => {
    const { adapter } = build({ withMetrics: false });
    await storeAll(adapter, PROCESSED, ORIGINAL);
    expect(await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM)).toMatchObject({
      withheld: 2,
    });
    await expect(
      adapter.saveRaw(Buffer.from('a-new-size'), `size/w1000/${DAY}/photo.png`)
    ).rejects.toThrow();
  });

  it('leaves a copy it cannot read where it is, keeps nothing it did not read, and says so', async () => {
    const { adapter, metrics, logged } = build();
    await storeAll(adapter, PROCESSED, OTHER);
    adapter.wrapped.read = async () => {
      throw new Error('the bucket did not answer');
    };

    const summary = await adapter
      .applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM)
      .catch((e) => e);

    // The verdict's own bytes could not be read, so nothing was sealed or removed.
    expect(summary).toBeInstanceOf(Error);
    expect(adapter.wrapped.files.has(PROCESSED.key)).toBe(true);
    expect(metrics.render()).toMatch(/matches_total\{tier="two"\} 0/);
    expect(logged).toEqual([]);
  });

  it('counts a copy it could not read back as incomplete, and does not remove it', async () => {
    const { adapter, metrics, logged } = build();
    await storeAll(adapter, PROCESSED, ORIGINAL);
    const realRead = adapter.wrapped.read.bind(adapter.wrapped);
    let reads = 0;
    // The first read is applyVerdict's own; the family's copies fail after it.
    adapter.wrapped.read = async (options) => {
      reads += 1;
      if (reads > 1) throw new Error('the bucket did not answer');
      return realRead(options);
    };

    const summary = await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM);

    expect(summary).toEqual({ families: 1, copies: 2, withheld: 0, incomplete: 2 });
    expect(adapter.wrapped.files.has(PROCESSED.key)).toBe(true);
    expect(await present(adapter, PROCESSED.key)).toBe(false);
    expect(metrics.render()).toMatch(/freeze_incomplete_total 2/);
    expect(logged.some((l) => /FREEZE_INCOMPLETE path=.* step=keep/.test(l))).toBe(true);
  });

  it('answers a path frozen when the ledger cannot be read, because that is where a freeze would be', async () => {
    const { adapter, logged } = build();
    await storeAll(adapter, PROCESSED);
    await fs.rm(quarantinePath, { recursive: true, force: true });
    await fs.writeFile(quarantinePath, 'not a directory');

    expect(await present(adapter, PROCESSED.key)).toBe(false);
    expect(logged.some((l) => /COPY_LEDGER_FAILED .*step=read/.test(l))).toBe(true);
  });

  it('answers every path of a family frozen when its ledger exists but cannot be parsed', async () => {
    const { adapter, logged } = build();
    await storeAll(adapter, PROCESSED, ORIGINAL, OTHER);
    const ledgers = (await fs.readdir(quarantinePath)).filter((n) => n.endsWith('.copies.json'));
    expect(ledgers).toHaveLength(2);
    for (const name of ledgers) await fs.writeFile(path.join(quarantinePath, name), '{not json');

    for (const o of [PROCESSED, ORIGINAL, OTHER]) {
      expect(await present(adapter, o.key), o.key).toBe(false);
      await expect(adapter.read({ path: o.key })).rejects.toThrow();
    }
    await expect(
      adapter.saveRaw(Buffer.from('a-new-size'), `size/w1000/${DAY}/photo.png`)
    ).rejects.toThrow();
    expect(logged.some((l) => /COPY_LEDGER_FAILED .*step=read/.test(l))).toBe(true);
  });

  it('a ledger with no list of copies is as unreadable as one that is not JSON', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED);
    const [name] = (await fs.readdir(quarantinePath)).filter((n) => n.endsWith('.copies.json'));
    await fs.writeFile(path.join(quarantinePath, name as string), '{"owner":"x"}');
    expect(await present(adapter, PROCESSED.key)).toBe(false);
  });

  it('keeps one entry for a path written twice, with the digest of what is there now', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED);
    const replacement = Buffer.from('replacement-bytes');
    await adapter.saveRaw(replacement, PROCESSED.key);

    // The old bytes are no longer anything's copy; the new ones are, once.
    expect(await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM)).toBeNull();
    expect(await adapter.applyVerdict(digestBytes(replacement), EXACT_CSAM)).toMatchObject({
      copies: 1,
      withheld: 1,
    });
  });

  it('never lowers a frozen family: a near verdict after an exact one leaves every copy sealed', async () => {
    const { adapter } = build();
    await storeAll(adapter, PROCESSED, ORIGINAL);
    await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM);
    await adapter.applyVerdict(digestBytes(ORIGINAL.bytes), NEAR_CSAM);

    for (const o of [PROCESSED, ORIGINAL]) {
      expect(readRefusal(quarantinePath, digestBytes(o.bytes))).toMatchObject({ tier: 'two' });
    }
    await expect(
      adapter.saveRaw(Buffer.from('a-new-size'), `size/w1000/${DAY}/photo.png`)
    ).rejects.toThrow();
  });

  it('says aloud when a stored object could not be entered in the ledger, and still stores it', async () => {
    const { adapter, logged } = build();
    adapter.wrapped.urlToPath = () => {
      throw new Error('no path for this url');
    };
    const file = path.join(tmpDir, 'upload.png');
    await fs.writeFile(file, PROCESSED.bytes);

    await expect(
      adapter.save({ name: 'upload.png', path: file, type: 'image/png' }, DAY)
    ).resolves.toBeDefined();

    expect(logged.some((l) => /COPY_LEDGER_FAILED wraps=FakeAdapter/.test(l))).toBe(true);
  });

  it('words a frozen read as an error with a code when Ghost supplies no NotFoundError', async () => {
    const { adapter } = build({ withoutNotFoundError: true });
    await storeAll(adapter, PROCESSED);
    await adapter.applyVerdict(digestBytes(PROCESSED.bytes), EXACT_CSAM);

    await expect(adapter.read({ path: PROCESSED.key })).rejects.toMatchObject({ code: 'ENOENT' });
    // A string path is read the same way as an options object.
    await expect(adapter.read(PROCESSED.key as unknown as { path: string })).rejects.toThrow();
  });

  it('serves a request with no path through untouched, and a path with no ledger', () => {
    const { adapter } = build();
    const res: FakeResponse = { statusCode: 200, end() {} };
    adapter.serve()({} as { path: string }, res, () => {});
    expect(res.served).toBe(true);
  });

  it('passes a serve() that is not a function straight through', () => {
    const { adapter } = build();
    adapter.wrapped.serve = () => 'not-a-middleware';
    expect(adapter.serve()).toBe('not-a-middleware');
  });

  it('lifts nothing that was never refused, and stops a lift whose kept bytes are gone', async () => {
    const { adapter } = build();
    expect(await adapter.liftFreeze('0'.repeat(64))).toBe('not-refused');

    await storeAll(adapter, PROCESSED, ORIGINAL);
    await adapter.applyVerdict(digestBytes(PROCESSED.bytes), NEAR_CSAM);
    await fs.rm(path.join(quarantinePath, digestBytes(ORIGINAL.bytes)));

    expect(await adapter.liftFreeze(digestBytes(PROCESSED.bytes))).toBe('incomplete');
    // Nothing was half undone: the family is still frozen.
    expect(await present(adapter, PROCESSED.key)).toBe(false);
    expect(isRefused(quarantinePath, digestBytes(PROCESSED.bytes))).toBe(true);
  });

  it('reads and deletes under an absolute storage root the way the local adapter does', async () => {
    const root = '/var/lib/ghost/content/images';
    const { adapter } = build({ storagePath: root });
    const absolute = { key: `${root}/${DAY}/photo.png`, bytes: Buffer.from('absolute-processed') };
    const variant = { key: `size/w600/${DAY}/photo.png`, bytes: Buffer.from('absolute-variant') };
    await storeAll(adapter, absolute, variant);
    // The local adapter reads a path relative to its root; the fake keys by what was written.
    const files = adapter.wrapped.files;
    adapter.wrapped.read = async ({ path: asked }) => {
      const found = files.get(asked) ?? files.get(`${root}/${asked}`.replace(/^\/+/, ''));
      if (found === undefined) throw new Error('Could not find image.');
      return found;
    };

    const summary = await adapter.applyVerdict(digestBytes(absolute.bytes), EXACT_CSAM);

    // Both are one family, whichever way the path is spelt.
    expect(summary).toMatchObject({ families: 1, copies: 2 });
    expect(adapter.wrapped.deleted).toContainEqual({
      fileName: 'photo.png',
      targetDir: `${root}/size/w600/${DAY}`,
    });
    expect(adapter.wrapped.deleted).toContainEqual({
      fileName: 'photo.png',
      targetDir: `${root}/${DAY}`,
    });
  });
});

async function vitestWaitFor(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the condition did not become true in time');
}
