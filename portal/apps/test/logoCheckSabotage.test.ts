import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as real from '../src/frontdoor/logoCheck.js';
import { loadAdapter, LOGO, RowStore, type Answer } from './logoCheckRig.js';
import { clearMutants, importSabotaged } from './sourceSabotage.js';

type LogoCheckModule = typeof real;
const { hashLogo } = real;

const SOURCE = 'frontdoor/logoCheck.ts';
const GATE = 'if (verdict === CLEAN) return hash;';
const HASHING = 'const hash = hashLogo(bytes);';
const EVIDENCE = 'return evidence === hash ? CLEAN : UNAVAILABLE;';

const adapter = await loadAdapter();
const LISTED = hashLogo(LOGO);

interface Outcome {
  /** Rows written for a logo whose hash is on the test list. */
  readonly listedRows: number;
  /** Rows written when the service could not be reached. */
  readonly heldRows: number;
  /** Rows written for a clean answer that does not name its hash. */
  readonly unnamedRows: number;
  /** Whether the hash the service was asked about is the hash of the bytes. */
  readonly askedTheLogosHash: boolean;
}

async function rowsFor(
  module: LogoCheckModule,
  answer: (key: string) => unknown
): Promise<[number, string[]]> {
  const { transport, record } = adapter.fakeTransport({
    ask: answer as (key: string) => Answer,
    echoKey: true,
  });
  const rows = new RowStore();
  await module
    .writeWithLogoCheck(LOGO, { verdicts: adapter.client(transport) }, rows.write)
    .catch(() => undefined);
  return [rows.rows.length, record.asked];
}

/** The four control cases, run against a copy of the module. */
async function outcomeOf(module: LogoCheckModule): Promise<Outcome> {
  const [listedRows, asked] = await rowsFor(module, (key) =>
    key === LISTED ? { classification: 'test' } : { classification: 'no-known-match' }
  );
  const [heldRows] = await rowsFor(module, () => ({ classification: 'unavailable' }));
  // A seam that answers clean without naming the hash, as a stand-in for one that mixes answers up.
  const rows = new RowStore();
  await module
    .writeWithLogoCheck(
      LOGO,
      { verdicts: { getVerdict: () => Promise.resolve({ classification: 'no-known-match' }) } },
      rows.write
    )
    .catch(() => undefined);
  return {
    listedRows,
    heldRows,
    unnamedRows: rows.rows.length,
    askedTheLogosHash: asked.length === 1 && asked[0] === LISTED,
  };
}

async function mutant(name: string, target: string, replacement: string): Promise<LogoCheckModule> {
  return importSabotaged<LogoCheckModule>(name, target, replacement, SOURCE);
}

beforeAll(clearMutants);
afterAll(clearMutants);

describe('sabotage: the logo check', () => {
  it('refuses a mutation whose target is not in the module', async () => {
    await expect(mutant('missing', 'no such text', 'x')).rejects.toThrow(/exactly once/);
  });

  it('holds with the real module: every control case is refused and no row is written', async () => {
    expect(await outcomeOf(real)).toEqual({
      listedRows: 0,
      heldRows: 0,
      unnamedRows: 0,
      askedTheLogosHash: true,
    });
  });

  it('with the check removed, a test-listed logo is recorded: the refusal test would be red', async () => {
    const outcome = await outcomeOf(await mutant('no-check', GATE, 'if (true) return hash;'));
    expect(outcome.listedRows).toBe(1);
    expect(outcome.heldRows).toBe(1);
  });

  it('with only the test list refused, an unreachable service is recorded', async () => {
    const outcome = await outcomeOf(
      await mutant('fail-open', GATE, "if (verdict !== 'test') return hash;")
    );
    expect(outcome.listedRows).toBe(0);
    expect(outcome.heldRows).toBe(1);
  });

  it('with the wrong hash asked about, a test-listed logo is recorded', async () => {
    const outcome = await outcomeOf(
      await mutant('wrong-hash', HASHING, "const hash = 'f'.repeat(64);")
    );
    expect(outcome.askedTheLogosHash).toBe(false);
    expect(outcome.listedRows).toBe(1);
  });

  it('with the answer not required to name the hash, an unnamed clean answer is recorded', async () => {
    const outcome = await outcomeOf(await mutant('no-evidence', EVIDENCE, 'return CLEAN;'));
    expect(outcome.unnamedRows).toBe(1);
  });
});
