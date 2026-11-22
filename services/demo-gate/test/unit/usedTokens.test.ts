import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileLedger } from '../../src/usedTokens.js';

const NOW = 1_900_000_000;
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the invitation ledger', () => {
  it('records a token once: the first consume wins and every later one is refused', async () => {
    const ledger = createFileLedger(dir);
    expect(await ledger.isUsed('j-1')).toBe(false);
    expect(await ledger.consume('j-1', NOW + 300, NOW)).toBe(true);
    expect(await ledger.isUsed('j-1')).toBe(true);
    expect(await ledger.consume('j-1', NOW + 300, NOW)).toBe(false);
    expect(await ledger.consume('j-2', NOW + 300, NOW)).toBe(true);
  });

  it('lets exactly one of many simultaneous consumes of one token through', async () => {
    const ledger = createFileLedger(dir);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => ledger.consume('j-race', NOW + 300, NOW))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('remembers across a restart: a second ledger over the same directory sees the record', async () => {
    expect(await createFileLedger(dir).consume('j-1', NOW + 300, NOW)).toBe(true);
    expect(await createFileLedger(dir).consume('j-1', NOW + 300, NOW)).toBe(false);
  });

  it('stores a hash of the token, never the token', async () => {
    await createFileLedger(dir).consume('secret-jti-value', NOW + 300, NOW);
    const [name] = readdirSync(dir);
    expect(name).toMatch(/^[0-9a-f]{64}$/);
    expect(readdirSync(dir).join()).not.toContain('secret');
  });

  it('drops a record only after its token has expired, and never before', async () => {
    const ledger = createFileLedger(dir);
    await ledger.consume('j-1', NOW + 300, NOW);
    await ledger.consume('j-other', NOW + 300, NOW + 100);
    expect(readdirSync(dir)).toHaveLength(2);
    // Past the sweep interval but before the expiry: kept.
    await ledger.consume('j-3', NOW + 600, NOW + 200);
    expect(await ledger.isUsed('j-1')).toBe(true);
    // Past the expiry: swept.
    await ledger.consume('j-4', NOW + 900, NOW + 301);
    expect(await ledger.isUsed('j-1')).toBe(false);
    expect(await ledger.isUsed('j-4')).toBe(true);
  });

  it('keeps a record it cannot read until it is older than any token could be', async () => {
    const ledger = createFileLedger(dir);
    writeFileSync(join(dir, 'a'.repeat(64)), 'not a number');
    await ledger.consume('j-1', NOW + 300, Math.floor(Date.now() / 1000));
    expect(readdirSync(dir)).toContain('a'.repeat(64));
    await ledger.consume('j-2', NOW + 900, Math.floor(Date.now() / 1000) + 3 * 900);
    expect(readdirSync(dir)).not.toContain('a'.repeat(64));
  });

  it('refuses when full, rather than evicting a record and re-opening a replay', async () => {
    const ledger = createFileLedger(dir, 2);
    expect(await ledger.consume('j-1', NOW + 300, NOW)).toBe(true);
    expect(await ledger.consume('j-2', NOW + 300, NOW)).toBe(true);
    expect(await ledger.consume('j-3', NOW + 300, NOW)).toBe(false);
    expect(await ledger.isUsed('j-1')).toBe(true);
    // The same count taken without a sweep, as on the next request inside the interval.
    expect(await ledger.consume('j-4', NOW + 300, NOW + 1)).toBe(false);
  });

  it('ignores files that are not records', async () => {
    writeFileSync(join(dir, 'README'), 'x');
    const ledger = createFileLedger(dir, 1);
    expect(await ledger.consume('j-1', NOW + 300, NOW)).toBe(true);
  });

  it('surfaces a real I/O failure instead of reading it as used or unused', async () => {
    const ledger = createFileLedger(join(dir, 'missing'));
    await expect(ledger.consume('j-1', NOW + 300, NOW)).rejects.toThrow();
    await expect(createFileLedger(join(dir, 'missing', 'x')).isUsed('j-1')).resolves.toBe(false);
    writeFileSync(join(dir, 'file'), 'x');
    await expect(createFileLedger(join(dir, 'file')).isUsed('j-1')).rejects.toThrow();
  });
});
