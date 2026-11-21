/**
 * Holds `contract/tenant-entry.json` equal to what render-core itself produces. The file is the
 * one copy other repos vendor (shared-infra's `tenant_entry` stack verb), so a change on either
 * side that is not mirrored in the file fails here, and a change to the file that render-core
 * does not produce fails here too.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { environmentNamesAcrossMatrix, fixtureResourceCaps } from './helpers/environmentMatrix.js';

interface Caps {
  readonly cpus: string;
  readonly cpuShares: number;
  readonly pidsLimit: number;
  readonly nofile: number;
}

interface Contract {
  readonly description: string;
  readonly environmentNames: readonly string[];
  readonly resourceCaps: Readonly<Record<string, Caps>>;
}

const contract: Contract = JSON.parse(
  readFileSync(new URL('../contract/tenant-entry.json', import.meta.url), 'utf8')
) as Contract;

/** Key order is not significant: a cap set is compared by its four values. */
function capsKey(caps: Caps): string {
  return [caps.cpus, caps.cpuShares, caps.pidsLimit, caps.nofile].join('|');
}

function difference(a: readonly string[], b: readonly string[]): string[] {
  const inB = new Set(b);
  return a.filter((item) => !inB.has(item));
}

describe('contract/tenant-entry.json: environment names', () => {
  const produced = environmentNamesAcrossMatrix();

  it('lists exactly the names tenantEnvironment() produces across the matrix', () => {
    const missingFromFile = difference(produced, contract.environmentNames);
    const notProduced = difference(contract.environmentNames, produced);
    expect(
      { missingFromFile, notProduced },
      'add missingFromFile to environmentNames, remove notProduced'
    ).toEqual({ missingFromFile: [], notProduced: [] });
  });

  it('is sorted and has no duplicates', () => {
    const sorted = [...contract.environmentNames].sort();
    expect(contract.environmentNames).toEqual(sorted);
    expect(new Set(contract.environmentNames).size).toBe(contract.environmentNames.length);
  });
});

describe('contract/tenant-entry.json: resource caps', () => {
  const tiers = Object.values(contract.resourceCaps).map(capsKey);
  const fixtures = Object.entries(fixtureResourceCaps());

  it('gives every fixture caps set that is one of the three tiers', () => {
    for (const [fixture, caps] of fixtures) {
      expect(tiers, `fixture "${fixture}" caps are not a tier in the contract`).toContain(
        capsKey(caps)
      );
    }
  });

  it('has every tier used by some render-core fixture', () => {
    const used = new Set(fixtures.map(([, caps]) => capsKey(caps)));
    for (const [tier, caps] of Object.entries(contract.resourceCaps)) {
      expect(used.has(capsKey(caps)), `tier "${tier}" is used by no fixture`).toBe(true);
    }
  });
});
