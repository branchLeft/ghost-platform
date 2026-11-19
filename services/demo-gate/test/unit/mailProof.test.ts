import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateLeaseId, validateSlotName } from '@branchleft/ghost-platform-render-core';
import {
  createMailProofReader,
  mailPathProved,
  mailProofFileName,
  parseMailProof,
} from '../../src/mailProof.js';

const SLOT = validateSlotName('0');
const LEASE = validateLeaseId('01J9F4Q7ZC3M8V2K6X0R5T1B9D');
const OTHER = validateLeaseId('01J9F4Q7ZC3M8V2K6X0R5T1B9E');
const NOW = 1_900_000_000;
const record = (over: object = {}) =>
  JSON.stringify({ slot: '0', lease: LEASE, provedAt: NOW, ...over });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proof-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('parseMailProof', () => {
  it('reads exactly slot, lease and provedAt', () => {
    expect(parseMailProof(record(), SLOT)).toEqual({ slot: SLOT, lease: LEASE, provedAt: NOW });
  });

  it.each([
    ['not JSON', 'nope'],
    ['an array', '[]'],
    ['an extra key', record({ extra: 1 })],
    ['another slot', record({ slot: '1' })],
    ['a bad lease', record({ lease: 'x' })],
    ['a zero time', record({ provedAt: 0 })],
    ['a fractional time', record({ provedAt: 1.5 })],
  ])('refuses %s', (_name, text) => {
    expect(() => parseMailProof(text, SLOT)).toThrow();
  });
});

describe('createMailProofReader', () => {
  it('reads the slot’s record', async () => {
    writeFileSync(join(dir, mailProofFileName(SLOT)), record());
    await expect(createMailProofReader(dir)(SLOT)).resolves.toMatchObject({ lease: LEASE });
  });

  it('refuses a missing record, an oversized one and a symlink', async () => {
    const read = createMailProofReader(dir);
    await expect(read(SLOT)).rejects.toThrow();
    writeFileSync(join(dir, mailProofFileName(SLOT)), record({ pad: 'x'.repeat(600) }));
    await expect(read(SLOT)).rejects.toThrow(/too large/);
    rmSync(join(dir, mailProofFileName(SLOT)));
    writeFileSync(join(dir, 'real.json'), record());
    symlinkSync(join(dir, 'real.json'), join(dir, mailProofFileName(SLOT)));
    await expect(read(SLOT)).rejects.toThrow();
  });
});

describe('mailPathProved', () => {
  const proof = { slot: SLOT, lease: LEASE, provedAt: NOW };

  it('is true for the current lease, inside the age limit', () => {
    expect(mailPathProved(proof, LEASE, NOW + 3600, 3600)).toBe(true);
  });

  it.each([
    ['no proof', null, LEASE, NOW],
    ['a proof for another lease', proof, OTHER, NOW],
    ['a proof older than the limit', proof, LEASE, NOW + 3601],
    ['a proof dated in the future', { ...proof, provedAt: NOW + 61 }, LEASE, NOW],
  ])('is false for %s', (_name, given, lease, now) => {
    expect(mailPathProved(given, lease, now, 3600)).toBe(false);
  });
});
